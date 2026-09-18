// 极简日志：控制台 + 内存环形缓冲（供前端拉取）。
// 不写文件，避免机械盘反复小写入；要排查时前端直接看。
const MAX = 500;
const buf = [];

function push(level, args) {
  const line = {
    ts: Date.now(),
    level,
    msg: args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch (_) {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" "),
  };
  buf.push(line);
  if (buf.length > MAX) buf.shift();
  const tag = `[xfer:${level}]`;
  if (level === "error") console.error(tag, line.msg);
  else if (level === "warn") console.warn(tag, line.msg);
  else console.log(tag, line.msg);
}

module.exports = {
  info: (...a) => push("info", a),
  warn: (...a) => push("warn", a),
  error: (...a) => push("error", a),
  recent: (n = 100) => buf.slice(-n),
  clear: () => {
    buf.length = 0;
  },
};
