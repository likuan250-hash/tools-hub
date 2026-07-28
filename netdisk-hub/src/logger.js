const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
  }
}

const LOG_RETENTION_DAYS = 14;

// 日志文件流缓存: { 'YYYY-MM-DD': WriteStream }
const streams = {};

function getStream() {
  const d = new Date();
  const key = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  if (streams[key]) return streams[key];

  // 跨天: 关闭旧流
  for (const k of Object.keys(streams)) {
    if (k !== key) {
      try { streams[k].end(); } catch (e) {}
      delete streams[k];
    }
  }

  ensureDir();
  const name = 'app-' + key + '.log';
  const filePath = path.join(LOG_DIR, name);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  stream.on('error', () => {});
  streams[key] = stream;
  return stream;
}

function cleanOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOG_DIR);
    let removed = 0;
    for (const f of files) {
      if (!/^(?:app-\d{4}-\d{2}-\d{2}|node-out-\d{8}-\d{6})\.log$/.test(f)) continue;
      const fp = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(fp);
          removed += 1;
        }
      } catch (e) {}
    }
    if (removed) {
      try { console.log('[cleanup] 已清理 ' + removed + ' 个过期日志文件,保留近 ' + LOG_RETENTION_DAYS + ' 天'); } catch (e) {}
    }
  } catch (e) {}
}

cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000).unref();

function fmtTime() {
  return new Date().toISOString();
}

function serialize(a) {
  return a.map((x) => {
    if (x instanceof Error) return x.stack || x.message;
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }).join(' ');
}

function write(level, args) {
  const line = '[' + fmtTime() + '] [' + level + '] ' + serialize(args);
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  // 非阻塞异步写入流
  try {
    getStream().write(line + '\n');
  } catch (e) {}
}

module.exports = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  debug: (...a) => write('DEBUG', a),
};
