// Configuration is read once at boot and validated in full. Every violation is
// collected and reported together, so a bad .env is fixed in one pass rather
// than one restart per mistake.
export class ConfigError extends Error {
  constructor(problems) {
    super('Invalid configuration:\n  - ' + problems.join('\n  - '));
    this.problems = problems;
  }
}

const PLACEHOLDERS = new Set([
  'changeme', 'change-me', 'change_me', 'password', 'passw0rd', 'letmein',
  'your-password-here', 'replace-me', 'replaceme', 'example', 'secret',
]);

function int(env, name, def, min, max, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^-?\d+$/.test(raw.trim())) {
    problems.push(`${name} must be a whole number (got "${raw}")`);
    return def;
  }
  const n = Number(raw);
  if (n < min || n > max) {
    problems.push(`${name} must be between ${min} and ${max} (got ${n})`);
    return def;
  }
  return n;
}

function bool(env, name, def, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be true or false (got "${raw}")`);
  return def;
}

export function loadConfig(env = process.env) {
  const problems = [];

  const password = env.UPLOAD_PASSWORD ?? '';
  if (!password) {
    problems.push('UPLOAD_PASSWORD is required');
  } else {
    if (password.length < 12 || password.length > 128) problems.push('UPLOAD_PASSWORD must be 12 to 128 characters');
    if (password !== password.trim()) problems.push('UPLOAD_PASSWORD must not start or end with whitespace (check for stray quotes or a trailing space in the Coolify field)');
    if (PLACEHOLDERS.has(password.trim().toLowerCase())) problems.push('UPLOAD_PASSWORD is a placeholder value; choose a real one');
  }

  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret && sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters when set (leave it empty to use a random one per restart)');

  const trustProxyRaw = (env.TRUST_PROXY ?? '1').trim();
  let trustProxy;
  if (trustProxyRaw === 'false' || trustProxyRaw === '0') trustProxy = false;
  else if (/^\d+$/.test(trustProxyRaw) && Number(trustProxyRaw) >= 1 && Number(trustProxyRaw) <= 5) trustProxy = Number(trustProxyRaw);
  else {
    problems.push('TRUST_PROXY must be false or a hop count from 1 to 5');
    trustProxy = 1;
  }

  const cfg = {
    port: int(env, 'PORT', 3000, 1, 65535, problems),
    photosDir: (env.PHOTOS_DIR || '/photos').trim(),
    password,
    sessionSecret,
    sessionHours: int(env, 'SESSION_HOURS', 168, 1, 8760, problems),
    cookieSecure: bool(env, 'COOKIE_SECURE', true, problems),
    trustProxy,
    authMaxFails: int(env, 'AUTH_MAX_FAILS', 10, 1, 1000, problems),
    authWindowMs: int(env, 'AUTH_WINDOW_MS', 900_000, 1000, 86_400_000, problems),
    maxUploadMb: int(env, 'MAX_UPLOAD_MB', 40, 1, 500, problems),
    maxPixels: int(env, 'MAX_PIXELS', 50_000_000, 1_000_000, 1_000_000_000, problems),
    maxEdge: int(env, 'MAX_EDGE', 2560, 640, 8192, problems),
    jpegQuality: int(env, 'JPEG_QUALITY', 82, 40, 100, problems),
    frameMaxPhotos: int(env, 'FRAME_MAX_PHOTOS_PER_ALBUM', 500, 0, 200_000, problems),
    minFreeMb: int(env, 'MIN_FREE_MB', 500, 0, 1_000_000, problems),
    concurrency: int(env, 'PROCESS_CONCURRENCY', 1, 1, 8, problems),
    logLevel: (env.LOG_LEVEL || 'info').trim(),
  };

  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) problems.push('LOG_LEVEL must be debug, info, warn or error');
  if (!cfg.photosDir.startsWith('/')) problems.push('PHOTOS_DIR must be an absolute path');

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(cfg);
}
