import crypto from 'node:crypto';
import { HttpError } from './errors.js';

// One shared password, one signed cookie. This is a single-household tool, not
// a user system, so there are no accounts to manage. Sessions are stateless
// (an expiry plus an HMAC), which means a restart does not log anyone out when
// SESSION_SECRET is set, and rotating the secret revokes every session at once.

const sha = (s) => crypto.createHash('sha256').update(s).digest();

export class Auth {
  constructor(cfg, { now = Date.now, maxTracked = 10_000 } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.cookieName = cfg.cookieSecure ? '__Host-upl' : 'upl';
    // Without SESSION_SECRET, derive nothing from the password (a leaked cookie
    // must not help guess it); use random bytes and accept logout-on-restart.
    this.key = cfg.sessionSecret ? sha('spf-uploader:' + cfg.sessionSecret) : crypto.randomBytes(32);
    this.passwordDigest = sha(cfg.password);
    this.fails = new Map(); // ip -> { n, resetAt }
    // Every failure from every address counts here too. Per-address limits alone
    // fall to anyone who can rotate addresses (IPv6 makes that cheap), so this is
    // the real ceiling on password guesses: a few attempts' worth per window.
    this.global = { n: 0, resetAt: 0 };
    this.globalMaxFails = cfg.authMaxFails * 5;
    this.maxTracked = maxTracked;
  }

  checkPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length > 1024) return false;
    // Hash both sides so lengths always match and timingSafeEqual cannot throw.
    return crypto.timingSafeEqual(sha(candidate), this.passwordDigest);
  }

  // ---- brute-force throttle (per client IP) ----

  sweep() {
    const t = this.now();
    for (const [ip, b] of this.fails) if (b.resetAt <= t) this.fails.delete(ip);
    // Hard cap on memory. Every entry lives for the same window, so insertion
    // order is expiry order: drop the entry closest to expiring, never the lot.
    // (The global limit stops this being reachable in practice; it is a backstop.)
    while (this.fails.size >= this.maxTracked) this.fails.delete(this.fails.keys().next().value);
  }

  retryAfterSeconds(ip) {
    const t = this.now();
    let wait = 0;
    const b = this.fails.get(ip);
    if (b && b.resetAt > t && b.n >= this.cfg.authMaxFails) wait = b.resetAt - t;
    if (this.global.resetAt > t && this.global.n >= this.globalMaxFails) wait = Math.max(wait, this.global.resetAt - t);
    return wait ? Math.max(1, Math.ceil(wait / 1000)) : 0;
  }

  recordFailure(ip) {
    this.sweep();
    const t = this.now();
    if (this.global.resetAt <= t) this.global = { n: 1, resetAt: t + this.cfg.authWindowMs };
    else this.global.n += 1;
    const b = this.fails.get(ip);
    if (!b || b.resetAt <= t) this.fails.set(ip, { n: 1, resetAt: t + this.cfg.authWindowMs });
    else b.n += 1;
  }

  clearFailures(ip) {
    this.fails.delete(ip);
  }

  // ---- session cookie ----

  sign(payload) {
    return crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue() {
    const exp = this.now() + this.cfg.sessionHours * 3_600_000;
    const payload = 'v1.' + exp;
    return payload + '.' + this.sign(payload);
  }

  verify(token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d{10,16}$/.test(parts[1])) return false;
    const given = Buffer.from(parts[2], 'base64url');
    const want = Buffer.from(this.sign(parts[0] + '.' + parts[1]), 'base64url');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
    return Number(parts[1]) > this.now();
  }

  cookieFromRequest(req) {
    const header = req.headers.cookie;
    if (!header || header.length > 4096) return null;
    for (const piece of header.split(';')) {
      const i = piece.indexOf('=');
      if (i < 0) continue;
      if (piece.slice(0, i).trim() !== this.cookieName) continue;
      const raw = piece.slice(i + 1).trim();
      try {
        return decodeURIComponent(raw); // malformed %-encoding must mean "no cookie", never a 500
      } catch {
        return null;
      }
    }
    return null;
  }

  isAuthenticated(req) {
    return this.verify(this.cookieFromRequest(req));
  }

  setCookieHeader(token) {
    const maxAge = this.cfg.sessionHours * 3600;
    return `${this.cookieName}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }

  clearCookieHeader() {
    return `${this.cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }

  // Express middleware
  require = (req, _res, next) => {
    if (this.isAuthenticated(req)) return next();
    next(new HttpError(401, 'unauthorized', 'Please sign in.'));
  };
}
