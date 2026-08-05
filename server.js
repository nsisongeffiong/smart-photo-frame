#!/usr/bin/env node
/**
 * smart-photo-frame — server
 *
 * An iPad Air 1 stuck on iOS 12.5.7 (Safari 12) cannot render the Home Assistant
 * frontend and cannot run the companion app, so the iPad never talks to HA.
 * This service polls HA server-side over the private tailnet and serves the frame
 * page itself:
 *
 *   HA (private tailnet) <-- polls -- THIS SERVICE (public VPS) <-- polls -- iPad
 *
 * Consequences of that shape, all deliberate:
 *   - Same origin for page + API + photos: no CORS, so Home Assistant needs no
 *     configuration.yaml changes at all.
 *   - No mixed content: the iPad only ever speaks HTTPS to this origin.
 *   - The long-lived HA token (full API scope — locks, cameras, everything) stays
 *     on the server and is never sent to a browser. It is the crown jewel of this
 *     threat model and outranks photo confidentiality and frame availability.
 *   - A Home Assistant outage must never blank the frame, so the last known good
 *     state is served indefinitely.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------------- *
 * Logging — structured, single line, never contains HA_TOKEN or FRAME_KEY.
 * ------------------------------------------------------------------------- */

/**
 * Emit a structured log line.
 *
 * @param {'info'|'warn'|'error'} level Severity.
 * @param {string} message Short, stable event name.
 * @param {Record<string, unknown>} [extra] Additional structured fields.
 * @returns {void}
 */
function log(level, message, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/* ------------------------------------------------------------------------- *
 * Small shared helpers
 * ------------------------------------------------------------------------- */

/** Configuration is wrong: fail fast at boot, never lazily inside a handler. */
class ConfigError extends Error {}

/**
 * Clamp a number into an inclusive range.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Test whether an absolute path sits inside a root directory.
 *
 * @param {string} root Absolute, realpath-resolved root directory.
 * @param {string} target Absolute candidate path.
 * @returns {boolean} True when target is strictly inside root.
 */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Constant-time string comparison.
 *
 * crypto.timingSafeEqual throws on length mismatch, so the lengths are compared
 * first (S2). Leaking the length of a secret is acceptable; leaking its content
 * one byte at a time via response timing is not.
 *
 * @param {unknown} a First value.
 * @param {unknown} b Second value.
 * @returns {boolean} True when both are strings of equal length and content.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Parse a Cookie header without ever throwing (S4).
 *
 * decodeURIComponent raises URIError on malformed percent-encoding; a hostile or
 * merely broken cookie must degrade to 401, never to a 500 an attacker can
 * trigger at will. The map has a null prototype because cookie names are
 * attacker-controlled keys.
 *
 * @param {unknown} header Raw Cookie header value.
 * @returns {Record<string, string>} Null-prototype map of cookie name to value.
 */
function parseCookies(header) {
  const jar = Object.create(null);
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return jar;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || Object.prototype.hasOwnProperty.call(jar, name)) continue;

    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // Malformed encoding: keep the raw bytes. It will simply fail the compare.
      jar[name] = value;
    }
  }
  return jar;
}

/* ------------------------------------------------------------------------- *
 * Name validation
 *
 * Album names arrive from a Home Assistant dropdown *and* from directory names,
 * and they become object keys and URL path segments (S6). Every album map in
 * this file is built with Object.create(null) and every name must pass this
 * allowlist, so an album literally called "__proto__" or "constructor" is inert.
 * ------------------------------------------------------------------------- */

const ALBUM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const UNAVAILABLE_STATES = new Set(['unknown', 'unavailable', 'none', '']);

/**
 * Validate an album name against a strict allowlist.
 *
 * @param {unknown} name Candidate album name.
 * @returns {boolean} True when the name is safe as an object key and URL segment.
 */
function isValidAlbumName(name) {
  if (typeof name !== 'string') return false;
  if (!ALBUM_NAME_RE.test(name)) return false;
  if (name.includes('..')) return false;
  // Belt and braces: the maps are null-prototype, but downstream JSON consumers
  // (the run-2 client page) may use ordinary objects.
  if (RESERVED_KEYS.has(name)) return false;
  return true;
}

/**
 * Validate a photo file name.
 *
 * @param {unknown} name Candidate file name (a single path segment).
 * @returns {boolean} True when the name is a safe, supported image file name.
 */
function isValidPhotoName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('.')) return false; // skip dotfiles (S8)
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (CONTROL_CHARS_RE.test(name)) return false;
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Reduce a request path to a redirect target that cannot leave this origin (S1).
 *
 * res.redirect() emits the value verbatim, so "//evil.example" or "/\evil.example"
 * would be sent as a protocol-relative Location and the browser would treat it as
 * an absolute URL — an open redirect usable to phish a frame that already holds a
 * valid session cookie. Anything that is not an unambiguous single-slash path is
 * collapsed to "/".
 *
 * @param {unknown} rawPath Value of req.path (still percent-encoded).
 * @returns {string} A safe same-origin path, never empty.
 */
function safeRedirectTarget(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') return '/';
  if (rawPath[0] !== '/') return '/';
  if (rawPath[1] === '/' || rawPath[1] === '\\') return '/';
  if (CONTROL_CHARS_RE.test(rawPath)) return '/'; // header-injection belt and braces
  return rawPath;
}

/* ------------------------------------------------------------------------- *
 * Configuration
 * ------------------------------------------------------------------------- */

const REQUIRED_VARS = ['HA_BASE_URL', 'HA_TOKEN', 'FRAME_KEY'];
const ENTITY_ID_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const WEAK_KEYS = new Set([
  'changeme', 'change-me', 'changemechangeme', 'password', 'password123',
  'secret', 'frame', 'photoframe', 'smart-photo-frame', 'letmein',
  '0123456789abcdef', 'aaaaaaaaaaaaaaaa'
]);
const COOKIE_NAME = '__Host-spf'; // __Host- prefix: browsers that understand it
                                  // enforce Secure + Path=/ + no Domain, which
                                  // blocks cookie injection from a sibling host.
                                  // Safari 12 ignores the prefix semantics but
                                  // still stores the cookie normally.
const COOKIE_MAX_AGE_S = 34_560_000; // 400 days: the frame is a kiosk, not a session.

/**
 * Read an integer environment variable with bounds checking.
 *
 * @param {NodeJS.ProcessEnv} env Environment.
 * @param {string} name Variable name.
 * @param {number} fallback Default when unset or empty.
 * @param {{ min?: number, max?: number }} [bounds] Inclusive bounds.
 * @returns {number} Parsed value.
 */
function readInt(env, name, fallback, bounds = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || String(value) !== text) {
    throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(text)}`);
  }
  const min = bounds.min ?? 0;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * Read a boolean environment variable.
 *
 * Strict on purpose, like readInt: an unrecognised value is a boot failure, not
 * a silent fall back to the default. These flags select a security posture, and
 * "ture" or "yes" must never quietly pick the opposite of what was intended.
 *
 * @param {NodeJS.ProcessEnv} env Environment.
 * @param {string} name Variable name.
 * @param {boolean} fallback Default when unset or empty.
 * @returns {boolean} Parsed value.
 */
function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  throw new ConfigError(`${name} must be true or false (or 1/0), got ${JSON.stringify(String(raw).trim())}`);
}

/**
 * Validate a Home Assistant base URL before the bearer token is ever sent to it (S9).
 *
 * @param {string} name Variable name, for error messages.
 * @param {string|undefined} raw Raw value.
 * @param {boolean} required Whether the value must be present.
 * @returns {string|null} Normalised base URL without trailing slash, or null.
 */
function readHaBaseUrl(name, raw, required) {
  if (raw === undefined || String(raw).trim() === '') {
    if (required) throw new ConfigError(`${name} is required`);
    return null;
  }
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new ConfigError(`${name} is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // Refuse file:, data:, ftp: and friends — the token must only ever travel
    // over a protocol we understand.
    throw new ConfigError(`${name} must use http: or https:, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${name} must not embed credentials`);
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${basePath}`;
}

/**
 * Reject a FRAME_KEY that is too weak to be the only thing between the internet
 * and the family photographs. Checked at boot so a misconfiguration is a startup
 * failure, not a request-time crash an attacker can trigger.
 *
 * @param {string} key Candidate key.
 * @returns {void}
 */
function assertStrongFrameKey(key) {
  if (key.length < 16) {
    throw new ConfigError('FRAME_KEY must be at least 16 characters (try: openssl rand -hex 24)');
  }
  if (key.length > 512) {
    throw new ConfigError('FRAME_KEY must be at most 512 characters');
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new ConfigError('FRAME_KEY must be printable ASCII with no spaces (it travels in a URL query string)');
  }
  if (WEAK_KEYS.has(key.toLowerCase())) {
    throw new ConfigError('FRAME_KEY is a well-known placeholder value; generate a random one');
  }
  if (new Set(key).size < 8) {
    throw new ConfigError('FRAME_KEY has fewer than 8 distinct characters; generate a random one');
  }
}

/**
 * Parse TRUST_PROXY into a value express understands.
 *
 * Defaults to false, i.e. do not believe X-Forwarded-For (S3). Trusting it by
 * default means a directly exposed instance lets every client name its own
 * address, which defeats per-IP auth throttling entirely; the failure mode of the
 * safe default (all clients collapse onto the proxy address, so throttling gets
 * stricter) costs frame availability, which this threat model ranks lowest.
 * Deployments behind a reverse proxy MUST set TRUST_PROXY explicitly — normally
 * TRUST_PROXY=1 for exactly one proxy hop. The effective value is logged at boot.
 *
 * @param {NodeJS.ProcessEnv} env Environment.
 * @returns {number|boolean|string} Express "trust proxy" setting.
 */
function readTrustProxy(env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || String(raw).trim() === '') return false;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text; // 'loopback', 'uniquelocal', or a comma-separated address list
}

/**
 * Read an entity id override, validating it before it becomes a URL path segment.
 *
 * @param {NodeJS.ProcessEnv} env Environment.
 * @param {string} name Variable name.
 * @param {string} fallback Default entity id.
 * @returns {string} Validated entity id.
 */
function readEntityId(env, name, fallback) {
  const value = String(env[name] ?? '').trim() || fallback;
  if (!ENTITY_ID_RE.test(value)) {
    throw new ConfigError(`${name} must look like "domain.object_id", got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Role of one of the four frame entities. Everything downstream is keyed by role
 * rather than by entity id, so an operator can rename HA entities freely.
 *
 * @typedef {'album'|'display'|'brightness'|'interval'} EntityRole
 */

/**
 * Entity ids for every role.
 *
 * @typedef {Record<EntityRole, string>} EntityMap
 */

/**
 * @typedef {Object} FrameConfig
 * @property {number} port
 * @property {{ name: 'primary'|'fallback', base: string }[]} haRoutes
 * @property {string} haToken
 * @property {string} frameKey
 * @property {string} sessionToken
 * @property {string} photosDir
 * @property {string} publicDir
 * @property {number} haPollMs
 * @property {number} haTimeoutMs
 * @property {number} scanMs
 * @property {number} haReprobeEvery
 * @property {number} maxPhotosPerAlbum
 * @property {number} authMaxFails
 * @property {number} authWindowMs
 * @property {boolean} allowQueryKey
 * @property {number|boolean|string} trustProxy
 * @property {EntityMap} entities
 */

/**
 * Load and validate the whole configuration.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to read from.
 * @returns {FrameConfig} Validated configuration.
 * @throws {ConfigError} When any value is missing or invalid.
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((name) => String(env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variable(s): ${missing.join(', ')}`);
  }

  const frameKey = String(env.FRAME_KEY);
  assertStrongFrameKey(frameKey);

  const primary = readHaBaseUrl('HA_BASE_URL', env.HA_BASE_URL, true);
  const fallback = readHaBaseUrl('HA_BASE_URL_FALLBACK', env.HA_BASE_URL_FALLBACK, false);
  const haRoutes = [{ name: /** @type {'primary'} */ ('primary'), base: /** @type {string} */ (primary) }];
  if (fallback && fallback !== primary) {
    haRoutes.push({ name: /** @type {'fallback'} */ ('fallback'), base: fallback });
  }

  const haPollMs = readInt(env, 'HA_POLL_MS', 10_000, { min: 1_000, max: 3_600_000 });

  return {
    port: readInt(env, 'PORT', 3000, { min: 1, max: 65_535 }),
    haRoutes,
    haToken: String(env.HA_TOKEN),
    frameKey,
    // The cookie carries a value derived from FRAME_KEY, not the key itself, so a
    // stolen cookie jar never yields a shareable ?k= link, and the derived value
    // has a fixed length (uniform timingSafeEqual behaviour).
    sessionToken: crypto.createHmac('sha256', frameKey).update('smart-photo-frame:session:v1').digest('hex'),
    photosDir: path.resolve(String(env.PHOTOS_DIR ?? '').trim() || '/photos'),
    publicDir: path.join(HERE, 'public'),
    haPollMs,
    haTimeoutMs: clamp(haPollMs - 1_000, 2_000, 15_000),
    scanMs: readInt(env, 'SCAN_MS', 300_000, { min: 5_000, max: 86_400_000 }),
    haReprobeEvery: readInt(env, 'HA_REPROBE_EVERY', 30, { min: 1, max: 10_000 }),
    maxPhotosPerAlbum: readInt(env, 'MAX_PHOTOS_PER_ALBUM', 5_000, { min: 1, max: 200_000 }),
    authMaxFails: readInt(env, 'AUTH_MAX_FAILS', 10, { min: 1, max: 1_000 }),
    authWindowMs: readInt(env, 'AUTH_WINDOW_MS', 900_000, { min: 1_000, max: 86_400_000 }),
    // Opt-in, default false. Off, a valid ?k= is accepted once and then 303'd to
    // the bare path, so the secret exists in a URL for exactly one request.
    //
    // On, a valid ?k= still sets the cookie but the request is served directly.
    // This exists for an iOS home-screen web app: it keeps a cookie store of its
    // own, separate from Safari's, so a cookie set during a Safari session can
    // never reach it — and after the 303 it would land on a bare path holding no
    // cookie at all. Its icon URL must therefore carry the key on every launch,
    // which means the key must not be stripped.
    //
    // The tradeoff, accepted deliberately when this is enabled: the key is
    // persisted in the icon URL on the device and shows up in the access log of
    // every proxy in front of this service. Referrer-Policy: no-referrer, set on
    // every response, already stops it leaking cross-origin via Referer. Leave
    // this false unless the home-screen web app is actually in use.
    allowQueryKey: readBool(env, 'ALLOW_QUERY_KEY', false),
    trustProxy: readTrustProxy(env),
    entities: {
      album: readEntityId(env, 'ENTITY_ALBUM', 'input_select.photo_frame_album'),
      display: readEntityId(env, 'ENTITY_DISPLAY', 'input_boolean.photo_frame_display'),
      brightness: readEntityId(env, 'ENTITY_BRIGHTNESS', 'input_number.photo_frame_brightness'),
      interval: readEntityId(env, 'ENTITY_INTERVAL', 'input_number.photo_frame_interval')
    }
  };
}

/* ------------------------------------------------------------------------- *
 * Authentication gate
 * ------------------------------------------------------------------------- */

/**
 * Shared-secret gate with per-IP failure throttling.
 *
 * Trust boundary 1 (internet -> this service) is the only publicly reachable
 * surface, so everything except /healthz sits behind this.
 */
export class AuthGate {
  #sessionToken;
  #frameKey;
  #maxFails;
  #windowMs;
  #allowQueryKey;
  #openPaths;
  /** @type {Map<string, { fails: number, expiresAt: number }>} */
  #buckets = new Map();
  #maxBuckets = 10_000;

  /**
   * @param {Object} options Gate options.
   * @param {string} options.sessionToken Value stored in the auth cookie.
   * @param {string} options.frameKey Shared secret accepted as ?k=.
   * @param {number} options.maxFails Failures allowed per window before throttling.
   * @param {number} options.windowMs Failure window in milliseconds.
   * @param {boolean} [options.allowQueryKey] Serve ?k= requests directly instead
   *   of redirecting to the bare path (ALLOW_QUERY_KEY; see loadConfig).
   * @param {string[]} [options.openPaths] Paths served without authentication.
   */
  constructor({ sessionToken, frameKey, maxFails, windowMs, allowQueryKey = false, openPaths = [] }) {
    this.#sessionToken = sessionToken;
    this.#frameKey = frameKey;
    this.#maxFails = maxFails;
    this.#windowMs = windowMs;
    this.#allowQueryKey = allowQueryKey;
    this.#openPaths = new Set(openPaths);
  }

  /**
   * Express middleware implementing S1-S4.
   *
   * @type {import('express').RequestHandler}
   */
  middleware = (req, res, next) => {
    const open = this.#openPaths.has(req.path);

    // 1. Already authenticated? Never throttled, never rate-limit accounted (S3).
    const cookies = parseCookies(req.headers.cookie);
    if (safeEqual(cookies[COOKIE_NAME], this.#sessionToken)) {
      if (typeof req.query.k === 'string' && !this.#allowQueryKey) {
        // Still strip a secret that ended up in the URL bar. Under
        // ALLOW_QUERY_KEY the key is expected on every request, so stripping it
        // would just add a redirect hop to every navigation.
        return this.#redirectBare(req, res);
      }
      return next();
    }

    // 2. A key in the query string: accept once, then (unless ALLOW_QUERY_KEY is
    //    set) get it out of history, Referer headers and proxy access logs (S1).
    const provided = typeof req.query.k === 'string' ? req.query.k : null;
    const ip = this.#clientIp(req);

    if (provided !== null) {
      if (this.#isThrottled(ip)) return this.#tooManyRequests(res, ip);
      if (safeEqual(provided, this.#frameKey)) {
        this.#buckets.delete(ip);
        this.#issueCookie(res);
        // The cookie is still issued either way: a client that can hold it stops
        // depending on the key. The iOS home-screen web app cannot, so under
        // ALLOW_QUERY_KEY the request is served here rather than redirected —
        // the redirect target would carry no key and no cookie.
        if (this.#allowQueryKey) return next();
        return this.#redirectBare(req, res);
      }
      this.#recordFailure(ip);
      if (!open) return this.#unauthorized(res);
      return next();
    }

    if (open) return next();
    if (this.#isThrottled(ip)) return this.#tooManyRequests(res, ip);
    this.#recordFailure(ip);
    return this.#unauthorized(res);
  };

  /**
   * Drop expired throttle buckets so the map cannot grow without bound (S3).
   *
   * @returns {void}
   */
  sweep() {
    const now = Date.now();
    for (const [ip, bucket] of this.#buckets) {
      if (bucket.expiresAt <= now) this.#buckets.delete(ip);
    }
  }

  /**
   * @param {import('express').Request} req Incoming request.
   * @returns {string} Client address, honouring the configured proxy trust.
   */
  #clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * @param {import('express').Response} res Response to decorate.
   * @returns {void}
   */
  #issueCookie(res) {
    // HttpOnly: unreachable from page scripts. Secure: HTTPS only, which is what
    // the public VPS terminates. SameSite=Lax: survives the top-level navigation
    // from the iPad home-screen bookmark while blocking cross-site requests.
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${this.#sessionToken}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`
    );
  }

  /**
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Response.
   * @returns {void}
   */
  #redirectBare(req, res) {
    // req.path is the still-encoded path with the query string removed, so the
    // secret never reaches the Location header, the browser history or any log.
    // It is still attacker-shaped input, so it is normalised to a same-origin
    // path first: "//evil.example" would otherwise become an open redirect.
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, safeRedirectTarget(req.path));
  }

  /**
   * @param {import('express').Response} res Response.
   * @returns {void}
   */
  #unauthorized(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).type('text/plain').send('Unauthorized\n');
  }

  /**
   * @param {import('express').Response} res Response.
   * @param {string} ip Client address.
   * @returns {void}
   */
  #tooManyRequests(res, ip) {
    const bucket = this.#buckets.get(ip);
    const retryAfter = bucket ? Math.max(1, Math.ceil((bucket.expiresAt - Date.now()) / 1000)) : 60;
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).type('text/plain').send('Too Many Requests\n');
  }

  /**
   * @param {string} ip Client address.
   * @returns {boolean} True when this address has burned its burst allowance.
   */
  #isThrottled(ip) {
    const bucket = this.#buckets.get(ip);
    if (!bucket) return false;
    if (bucket.expiresAt <= Date.now()) {
      this.#buckets.delete(ip);
      return false;
    }
    return bucket.fails >= this.#maxFails;
  }

  /**
   * @param {string} ip Client address.
   * @returns {void}
   */
  #recordFailure(ip) {
    const now = Date.now();
    const existing = this.#buckets.get(ip);
    if (existing && existing.expiresAt > now) {
      existing.fails += 1;
      if (existing.fails === this.#maxFails) {
        log('warn', 'auth throttled', { ip, fails: existing.fails });
      }
      return;
    }
    if (this.#buckets.size >= this.#maxBuckets) {
      this.sweep();
      if (this.#buckets.size >= this.#maxBuckets) {
        // Still full: evict the entry that expires soonest rather than growing.
        let oldestIp = null;
        let oldestAt = Infinity;
        for (const [candidate, bucket] of this.#buckets) {
          if (bucket.expiresAt < oldestAt) {
            oldestAt = bucket.expiresAt;
            oldestIp = candidate;
          }
        }
        if (oldestIp !== null) this.#buckets.delete(oldestIp);
      }
    }
    this.#buckets.set(ip, { fails: 1, expiresAt: now + this.#windowMs });
  }
}

/* ------------------------------------------------------------------------- *
 * Home Assistant client
 * ------------------------------------------------------------------------- */

/** Hard ceiling on a single HA response body, enforced while reading (S9). */
const HA_MAX_BODY_BYTES = 1_048_576;

/** HA answered, but not with a usable 2xx JSON body. The route is still alive. */
class HaResponseError extends Error {
  /** @param {string} message Human-readable detail. */
  constructor(message) {
    super(message);
    this.name = 'HaResponseError';
    /** @type {true} Route reachability marker. */
    this.reachable = true;
  }
}

/**
 * Describe a transport error without leaking anything sensitive.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Short description.
 */
function describeError(error) {
  if (error && typeof error === 'object') {
    const err = /** @type {{ name?: string, code?: string, message?: string }} */ (error);
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
    const detail = err.code || err.message || err.name || 'error';
    return String(detail).slice(0, 200);
  }
  return String(error).slice(0, 200);
}

/**
 * Discard an unread response body so the underlying socket is released.
 *
 * @param {Response} response Fetch response.
 * @returns {Promise<void>} Always resolves.
 */
async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do: the socket is being torn down either way.
  }
}

/**
 * Read a response body as JSON while enforcing a hard byte ceiling.
 *
 * Content-Length is a hint an endpoint can simply omit (or lie about with chunked
 * transfer encoding), so the limit is enforced on the bytes actually read (S9).
 *
 * @param {Response} response Fetch response with an unread body.
 * @param {number} maxBytes Maximum number of body bytes to accept.
 * @returns {Promise<unknown>} Parsed JSON value.
 * @throws {HaResponseError} When the body is absent, oversized or not JSON.
 */
async function readJsonLimited(response, maxBytes) {
  const stream = response.body;
  if (!stream) throw new HaResponseError('missing response body');

  const reader = stream.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new HaResponseError('response too large');
      chunks.push(Buffer.from(value)); // copy: undici may reuse the view's buffer
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed or cancelled.
    }
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HaResponseError('malformed JSON');
  }
}

/**
 * Parse a Home Assistant numeric state strictly.
 *
 * Number.parseFloat happily accepts "50abc" and "15 seconds", which would let a
 * malformed HA state overwrite a perfectly good last-known-good value.
 *
 * @param {unknown} value Raw state string.
 * @returns {number|null} A finite number, or null when the state is not numeric.
 */
function parseFiniteState(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * Polls the four frame entities from Home Assistant, with primary/fallback
 * failover and periodic re-probing of the primary route.
 */
export class HomeAssistantClient {
  #routes;
  #token;
  /** @type {EntityMap} */
  #entities;
  #timeoutMs;
  #reprobeEvery;
  #pollCount = 0;
  #activeIndex = 0;
  #haOk = false;
  /** @type {string|null} */
  #haError = 'not polled yet';
  /** @type {number|null} */
  #lastOkAt = null;
  // Last known good state. Deliberately optimistic defaults: if HA is down at
  // boot the frame still shows something rather than a black screen.
  #values = { album: /** @type {string|null} */ (null), display: true, brightness: 100, interval: 15 };

  /**
   * @param {Object} options Client options.
   * @param {{ name: 'primary'|'fallback', base: string }[]} options.routes Validated HA base URLs.
   * @param {string} options.token Long-lived access token.
   * @param {EntityMap} options.entities Entity ids, keyed by role.
   * @param {number} options.timeoutMs Per-poll timeout.
   * @param {number} options.reprobeEvery Poll cycles between primary re-probes.
   */
  constructor({ routes, token, entities, timeoutMs, reprobeEvery }) {
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new ConfigError('at least one Home Assistant route is required');
    }
    this.#routes = routes;
    this.#token = token;
    this.#entities = entities;
    this.#timeoutMs = timeoutMs;
    this.#reprobeEvery = reprobeEvery;
  }

  /**
   * Current state, safe to serialise to an authenticated client.
   *
   * @returns {{ album: string|null, display: boolean, brightness: number,
   *   interval: number, haOk: boolean, haError: string|null,
   *   haVia: 'primary'|'fallback', haLastOk: string|null }} State snapshot.
   */
  get snapshot() {
    return {
      album: this.#values.album,
      display: this.#values.display,
      brightness: this.#values.brightness,
      interval: this.#values.interval,
      haOk: this.#haOk,
      haError: this.#haError,
      haVia: this.#routes[this.#activeIndex].name,
      haLastOk: this.#lastOkAt === null ? null : new Date(this.#lastOkAt).toISOString()
    };
  }

  /**
   * Poll Home Assistant once, failing over between routes as needed.
   *
   * Never throws and never clears the last known good state: an HA outage must
   * not blank the frame.
   *
   * @returns {Promise<void>} Resolves when the poll cycle is complete.
   */
  async poll() {
    this.#pollCount += 1;
    const wasOk = this.#haOk;
    const failures = [];

    for (const index of this.#routeOrder()) {
      const route = this.#routes[index];
      const outcome = await this.#pollRoute(route);
      if (outcome.reachable) {
        if (index !== this.#activeIndex) {
          log('info', 'ha route changed', { from: this.#routes[this.#activeIndex].name, to: route.name });
          this.#activeIndex = index;
        }

        // Reachability is not health. Four 401s prove HA answered, but yielded no
        // usable state, so haOk and haLastOk must not claim a good poll. The route
        // still counts as reachable so a bad token cannot cause route flapping.
        const usable = Object.keys(outcome.values).length > 0;
        this.#haOk = usable;
        if (outcome.problems.length > 0) {
          this.#haError = outcome.problems.join('; ');
        } else {
          this.#haError = usable ? null : 'no usable entity states';
        }

        if (usable) {
          this.#lastOkAt = Date.now();
          this.#applyValues(outcome.values);
        } else if (wasOk) {
          log('warn', 'ha reachable but returned no usable state', {
            route: route.name,
            detail: this.#haError
          });
        }
        return;
      }
      failures.push(`${route.name}: ${outcome.error}`);
    }

    if (wasOk) log('warn', 'ha unreachable, serving last known good state', { detail: failures.join('; ') });
    this.#haOk = false;
    this.#haError = failures.join('; ') || 'home assistant unreachable';
  }

  /**
   * Route indexes in the order they should be attempted.
   *
   * The active route wins normally (stickiness), but every HA_REPROBE_EVERY
   * cycles the primary is tried first so a brief outage cannot strand the
   * service on the fallback forever.
   *
   * @returns {number[]} Indexes into the route list.
   */
  #routeOrder() {
    const all = this.#routes.map((_, index) => index);
    const dueForReprobe = this.#activeIndex !== 0 && this.#pollCount % this.#reprobeEvery === 0;
    if (dueForReprobe) return all;
    return [this.#activeIndex, ...all.filter((index) => index !== this.#activeIndex)];
  }

  /**
   * Fetch all four entities from one route.
   *
   * @param {{ name: string, base: string }} route Route to try.
   * @returns {Promise<{ reachable: boolean, values: Record<string, string>, problems: string[], error: string }>} Outcome.
   */
  async #pollRoute(route) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const keys = /** @type {EntityRole[]} */ (Object.keys(this.#entities));

    try {
      const settled = await Promise.allSettled(
        keys.map((key) => this.#fetchState(route.base, this.#entities[key], controller.signal))
      );

      const values = Object.create(null);
      /** @type {string[]} */
      const problems = [];
      let reachable = false;
      /** @type {string|null} */
      let transportError = null;

      settled.forEach((result, index) => {
        const key = keys[index];
        if (result.status === 'fulfilled') {
          reachable = true;
          values[key] = result.value;
          return;
        }

        const error = result.reason;
        const detail = describeError(error);
        if (error && typeof error === 'object' && /** @type {{ reachable?: boolean }} */ (error).reachable) {
          // HA answered — a missing or renamed entity is a config problem, not an
          // outage, and must not trigger endless route flapping.
          reachable = true;
        } else {
          transportError = detail;
        }
        // Record every failure, transport or not: a cycle where three of four
        // requests timed out is degraded, and haError must say so.
        problems.push(`${this.#entities[key]}: ${detail}`);
      });

      return { reachable, values, problems, error: transportError ?? 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch a single entity state string.
   *
   * @param {string} base Validated http(s) base URL.
   * @param {string} entityId Validated entity id.
   * @param {AbortSignal} signal Timeout signal.
   * @returns {Promise<string>} The entity state.
   */
  async #fetchState(base, entityId, signal) {
    const response = await fetch(`${base}/api/states/${encodeURIComponent(entityId)}`, {
      method: 'GET',
      signal,
      // Never replay a full-scope bearer token at a redirect target we did not
      // validate at boot (S9). A redirect is a configuration error, not a hop.
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      await discardBody(response);
      throw new HaResponseError(`HTTP ${response.status}`);
    }

    // Cheap early rejection; the real enforcement happens while reading, because
    // a chunked response carries no Content-Length at all.
    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > HA_MAX_BODY_BYTES) {
      await discardBody(response);
      throw new HaResponseError('response too large');
    }

    const payload = /** @type {{ state?: unknown }|null} */ (
      await readJsonLimited(response, HA_MAX_BODY_BYTES)
    );
    if (!payload || typeof payload !== 'object' || typeof payload.state !== 'string') {
      throw new HaResponseError('missing state field');
    }
    return payload.state;
  }

  /**
   * Merge freshly polled entity states into the last known good state.
   *
   * Unparseable, unknown or unavailable values keep the previous value rather
   * than blanking the frame.
   *
   * @param {Record<string, string>} values Raw entity states, keyed by role.
   * @returns {void}
   */
  #applyValues(values) {
    const album = typeof values.album === 'string' ? values.album.trim() : null;
    if (album !== null && !UNAVAILABLE_STATES.has(album.toLowerCase()) && isValidAlbumName(album)) {
      this.#values.album = album;
    }

    if (typeof values.display === 'string') {
      const display = values.display.trim().toLowerCase();
      if (display === 'on') this.#values.display = true;
      else if (display === 'off') this.#values.display = false;
    }

    const brightness = parseFiniteState(values.brightness);
    if (brightness !== null) {
      this.#values.brightness = clamp(Math.round(brightness), 10, 100);
    }

    const interval = parseFiniteState(values.interval);
    if (interval !== null) {
      this.#values.interval = clamp(Math.round(interval), 1, 3600);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Photo library
 * ------------------------------------------------------------------------- */

// Defensive ceiling on how many candidate names one album scan will hold in
// memory. It sits at the maximum MAX_PHOTOS_PER_ALBUM allows, so a correctly
// configured album is always sorted in full before it is capped; a pathological
// directory beyond this is truncated (and logged) rather than exhausting memory.
const HARD_ALBUM_SCAN_LIMIT = 200_000;

/**
 * Scans PHOTOS_DIR (one subdirectory per album) on an interval so new photos
 * appear without a restart.
 */
export class PhotoLibrary {
  #root;
  #maxPerAlbum;
  #maxAlbums = 512;
  /** @type {Record<string, string[]>} */
  #albums = Object.create(null); // null prototype: keys come from the filesystem (S6)
  #albumCount = 0;
  #photoCount = 0;
  /** @type {number|null} */
  #scannedAt = null;
  #ok = false;
  /** @type {string|null} */
  #error = 'not scanned yet';

  /**
   * @param {Object} options Library options.
   * @param {string} options.root Realpath-resolved photo root.
   * @param {number} options.maxPhotosPerAlbum Hard cap on files per album (S8).
   */
  constructor({ root, maxPhotosPerAlbum }) {
    this.#root = root;
    this.#maxPerAlbum = maxPhotosPerAlbum;
  }

  /**
   * Current catalogue.
   *
   * @returns {{ albums: Record<string, string[]>, albumCount: number,
   *   photoCount: number, scannedAt: string|null, ok: boolean, error: string|null }} Snapshot.
   */
  get snapshot() {
    return {
      albums: this.#albums,
      albumCount: this.#albumCount,
      photoCount: this.#photoCount,
      scannedAt: this.#scannedAt === null ? null : new Date(this.#scannedAt).toISOString(),
      ok: this.#ok,
      error: this.#error
    };
  }

  /**
   * Rescan the photo root. Never throws; on failure the previous catalogue is
   * retained so the frame keeps showing photographs.
   *
   * @returns {Promise<void>} Resolves when the scan completes.
   */
  async scan() {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      this.#ok = false;
      this.#error = `cannot read PHOTOS_DIR: ${describeError(error)}`;
      log('error', 'photo scan failed', { root: this.#root, error: this.#error });
      return;
    }

    const albums = Object.create(null);
    let albumCount = 0;
    let photoCount = 0;

    for (const entry of entries) {
      if (albumCount >= this.#maxAlbums) {
        log('warn', 'album cap reached', { max: this.#maxAlbums });
        break;
      }
      if (entry.name.startsWith('.')) continue; // skip dotfiles (S8)
      if (entry.isSymbolicLink()) continue; // never resolve outside PHOTOS_DIR (S8)
      if (!entry.isDirectory()) continue;
      if (!isValidAlbumName(entry.name)) {
        log('warn', 'skipping album with unsupported name', { length: entry.name.length });
        continue;
      }

      try {
        const files = await this.#scanAlbum(entry.name);
        albums[entry.name] = files;
        albumCount += 1;
        photoCount += files.length;
      } catch (error) {
        // Per-album isolation: one unreadable directory must not abort the scan (S8).
        log('warn', 'album scan failed', { album: entry.name, error: describeError(error) });
      }
    }

    this.#albums = albums;
    this.#albumCount = albumCount;
    this.#photoCount = photoCount;
    this.#scannedAt = Date.now();
    this.#ok = true;
    this.#error = null;
  }

  /**
   * List one album's photos as page-relative, URL-encoded paths.
   *
   * @param {string} album Validated album name.
   * @returns {Promise<string[]>} Sorted list of `photos/<album>/<file>` URLs.
   */
  async #scanAlbum(album) {
    const dir = path.join(this.#root, album);
    const entries = await fs.readdir(dir, { withFileTypes: true });

    /** @type {string[]} */
    const names = [];
    let truncated = false;
    for (const entry of entries) {
      if (names.length >= HARD_ALBUM_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (!isValidPhotoName(entry.name)) continue;
      if (!isInside(this.#root, path.join(dir, entry.name))) continue; // defence in depth
      names.push(entry.name);
    }
    if (truncated) log('warn', 'album scan hard limit reached', { album, limit: HARD_ALBUM_SCAN_LIMIT });

    // Sort *before* capping. Capping raw readdir order would make the selected
    // subset depend on filesystem enumeration order, so an over-cap album could
    // show a different set of photographs after every rescan.
    names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));

    if (names.length > this.#maxPerAlbum) {
      log('warn', 'album photo cap reached', { album, max: this.#maxPerAlbum, found: names.length });
      names.length = this.#maxPerAlbum;
    }

    return names.map((name) => `photos/${encodeURIComponent(album)}/${encodeURIComponent(name)}`);
  }
}

/* ------------------------------------------------------------------------- *
 * HTTP layer
 * ------------------------------------------------------------------------- */

// default-src 'none' with explicit allowances. 'unsafe-inline' is granted for
// script and style because the run-2 client page targets Safari 12, where a
// nonce-based build step would be more risk than it removes; everything the page
// can reach is same-origin regardless. frame-ancestors 'none' blocks framing (S5).
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

// Generic, non-revealing bodies for the statuses express itself can raise (a 404
// or 416 from sendFile, for example). Nothing here echoes a path or a stack.
const STATUS_BODIES = new Map([
  [400, 'Bad Request\n'],
  [403, 'Forbidden\n'],
  [404, 'Not Found\n'],
  [405, 'Method Not Allowed\n'],
  [406, 'Not Acceptable\n'],
  [412, 'Precondition Failed\n'],
  [413, 'Payload Too Large\n'],
  [416, 'Range Not Satisfiable\n'],
  [429, 'Too Many Requests\n']
]);

/**
 * Security headers, set in the application rather than only in the proxy (S5).
 *
 * @type {import('express').RequestHandler}
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // no-referrer also stops a ?k= URL leaking to third parties via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY'); // legacy companion to frame-ancestors
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * Build the photo file handler.
 *
 * Files are served by explicit lookup instead of a blanket static mount so that
 * album/file names are revalidated and symlink escapes are caught by realpath.
 *
 * @param {string} root Realpath-resolved photo root.
 * @returns {import('express').RequestHandler} Handler for GET /photos/*.
 */
export function createPhotoHandler(root) {
  return async function servePhoto(req, res, next) {
    const relative = typeof req.params[0] === 'string' ? req.params[0] : '';
    const segments = relative.split('/').filter((segment) => segment.length > 0);
    if (segments.length !== 2) return res.status(404).type('text/plain').send('Not Found\n');

    const [album, file] = segments;
    if (!isValidAlbumName(album) || !isValidPhotoName(file)) {
      return res.status(404).type('text/plain').send('Not Found\n');
    }

    const absolute = path.join(root, album, file);
    if (!isInside(root, absolute)) return res.status(404).type('text/plain').send('Not Found\n');

    let real;
    try {
      real = await fs.realpath(absolute);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return res.status(404).type('text/plain').send('Not Found\n');
    } catch {
      return res.status(404).type('text/plain').send('Not Found\n');
    }
    // realpath containment: a symlink inside PHOTOS_DIR must not export /etc.
    if (!isInside(root, real)) return res.status(404).type('text/plain').send('Not Found\n');

    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(real, { dotfiles: 'deny', acceptRanges: true }, (error) => {
      if (!error) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    });
  };
}

/**
 * Build the express application.
 *
 * @param {Object} deps Application dependencies.
 * @param {FrameConfig} deps.config Validated configuration.
 * @param {HomeAssistantClient} deps.ha Home Assistant poller.
 * @param {PhotoLibrary} deps.library Photo catalogue.
 * @param {AuthGate} deps.gate Authentication gate.
 * @param {string} deps.photosRoot Realpath-resolved photo root.
 * @returns {import('express').Express} Configured application.
 */
export function createApp({ config, ha, library, gate, photosRoot }) {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  // X-Forwarded-For is honoured only when TRUST_PROXY is set explicitly (normally
  // TRUST_PROXY=1 for the single reverse proxy in front). The default of false
  // keeps per-IP throttling keyed on the socket address, so a client-supplied
  // header can never influence it (S3).
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(securityHeaders);

  // Read-only service: nothing else needs to exist.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).type('text/plain').send('Method Not Allowed\n');
  });

  // Unauthenticated: polled by Uptime Kuma. Counts only, no state detail.
  app.get('/healthz', (req, res) => {
    const ha_ = ha.snapshot;
    const lib = library.snapshot;
    res.setHeader('Cache-Control', 'no-store');
    res.status(lib.ok ? 200 : 503).json({
      ok: lib.ok,
      ha: ha_.haOk,
      haVia: ha_.haVia,
      haLastOk: ha_.haLastOk,
      albums: lib.albumCount,
      photos: lib.photoCount
    });
  });

  app.use(gate.middleware);

  app.get('/api/state', (req, res) => {
    const ha_ = ha.snapshot;
    const lib = library.snapshot;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    res.json({
      album: ha_.album,
      display: ha_.display,
      brightness: ha_.brightness,
      interval: ha_.interval,
      haOk: ha_.haOk,
      haError: ha_.haError,
      haVia: ha_.haVia,
      haLastOk: ha_.haLastOk,
      albums: lib.albums,
      scannedAt: lib.scannedAt
    });
  });

  app.get('/photos/*', createPhotoHandler(photosRoot));

  // The client page is produced by a later run; the directory is served as-is
  // and a missing index.html is simply a 404.
  app.use(
    express.static(config.publicDir, {
      index: 'index.html',
      dotfiles: 'ignore',
      redirect: false,
      fallthrough: true,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not Found\n');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) log('error', 'request failed', { path: req.path, error: describeError(error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    // Never return a stack trace or internal path to the internet, but do return a
    // body that matches the status: a 404 must not read "Internal Server Error".
    const body = STATUS_BODIES.get(status) ?? (status < 500 ? 'Request Error\n' : 'Internal Server Error\n');
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).type('text/plain').send(body);
  });

  return app;
}

/* ------------------------------------------------------------------------- *
 * Bootstrap
 * ------------------------------------------------------------------------- */

/**
 * Run an async task immediately and then on a fixed delay, without overlapping runs.
 *
 * @param {() => Promise<void>} task Task to run.
 * @param {number} intervalMs Delay between completions.
 * @param {string} name Task name, for logs.
 * @returns {() => void} Stop function.
 */
function startLoop(task, intervalMs, name) {
  let stopped = false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  const run = async () => {
    try {
      await task();
    } catch (error) {
      log('error', `${name} threw`, { error: describeError(error) });
    }
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
    timer.unref();
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Start the service.
 *
 * @returns {Promise<void>} Resolves once the HTTP server is listening.
 */
async function main() {
  /** @type {FrameConfig} */
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`smart-photo-frame: configuration error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  // Resolve the root once so symlinked mounts (/photos -> /mnt/photos) still
  // pass every containment check.
  const photosRoot = await fs.realpath(config.photosDir).catch(() => config.photosDir);

  const library = new PhotoLibrary({ root: photosRoot, maxPhotosPerAlbum: config.maxPhotosPerAlbum });
  const ha = new HomeAssistantClient({
    routes: config.haRoutes,
    token: config.haToken,
    entities: config.entities,
    timeoutMs: config.haTimeoutMs,
    reprobeEvery: config.haReprobeEvery
  });
  const gate = new AuthGate({
    sessionToken: config.sessionToken,
    frameKey: config.frameKey,
    maxFails: config.authMaxFails,
    windowMs: config.authWindowMs,
    allowQueryKey: config.allowQueryKey,
    openPaths: ['/healthz']
  });

  const app = createApp({ config, ha, library, gate, photosRoot });

  const stopScan = startLoop(() => library.scan(), config.scanMs, 'photo scan');
  const stopPoll = startLoop(() => ha.poll(), config.haPollMs, 'home assistant poll');
  const sweepTimer = setInterval(() => gate.sweep(), clamp(Math.floor(config.authWindowMs / 2), 60_000, 3_600_000));
  sweepTimer.unref();

  const server = app.listen(config.port, () => {
    log('info', 'listening', {
      port: config.port,
      photosDir: photosRoot,
      haRoutes: config.haRoutes.map((route) => route.name),
      haPollMs: config.haPollMs,
      scanMs: config.scanMs,
      // Logged explicitly: if this is false behind a proxy, every client shares
      // one throttle bucket, and if it is truthy without a proxy, throttling can
      // be evaded. Operators need to see the effective value.
      trustProxy: String(config.trustProxy),
      // Also logged explicitly: when true the frame key is expected to live in
      // the URL of every request, and it will be visible in proxy access logs.
      allowQueryKey: config.allowQueryKey
    });
  });

  let shuttingDown = false;

  /**
   * @param {NodeJS.Signals} signal Signal that triggered shutdown.
   * @returns {void}
   */
  const shutdown = (signal) => {
    if (shuttingDown) return; // SIGINT then SIGTERM must not run this twice
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    stopScan();
    stopPoll();
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log('error', 'fatal', { error: describeError(error) });
    process.exit(1);
  });
}
