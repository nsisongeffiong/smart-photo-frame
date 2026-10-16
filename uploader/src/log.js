// Structured JSON-line logger. One object per line, so `docker logs` output can
// be grepped or shipped without a parser. Never pass secrets in `extra`.
export function makeLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? order.info;
  const emit = (lvl, message, extra) => {
    if (order[lvl] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, message, ...extra });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}
