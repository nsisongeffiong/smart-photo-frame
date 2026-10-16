import fs from 'node:fs/promises';
import { loadConfig, ConfigError } from './config.js';
import { makeLogger } from './log.js';
import { Auth } from './auth.js';
import { Library } from './library.js';
import { createApp } from './app.js';

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: e.message }) + '\n');
    process.exit(1);
  }
  throw e;
}

const log = makeLogger(cfg.logLevel);

try {
  await fs.access(cfg.photosDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
} catch {
  log.error('photos directory is missing or not writable by this user', {
    dir: cfg.photosDir,
    hint: 'Set UPLOAD_UID/UPLOAD_GID to the owner of the folder: stat -c "%u:%g" /srv/photos',
  });
  process.exit(1);
}

const auth = new Auth(cfg);
const library = new Library(cfg, log);
const app = createApp({ cfg, log, auth, library });

const server = app.listen(cfg.port, () => {
  log.info('uploader listening', { port: cfg.port, photosDir: cfg.photosDir });
});
server.requestTimeout = 5 * 60_000;
server.headersTimeout = 30_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutting down', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
