// 录入历史副标题/片段提取工具（UMD：浏览器挂 window.HistoryMeta，Node require 拿导出）
// 纯函数，无 DOM 依赖，可独立单测。
(function () {
  function extractVersion(text) {
    const s = String(text || "");
    const m = s.match(/\b(?:v|ver\.?|version)?\s?(\d+\.\d+(?:\.\d+){1,})\b/i);
    return m ? m[0].trim() : "";
  }

  const DISK_HOSTS = [
    "pan.baidu.com", "pan.quark.cn", "pan.xunlei.com", "aliyundrive.com",
    "weiyun.com", "123pan.com", "123pan.cn", "123684.com", "ctfile.com", "url.cn",
  ];

  function countDiskLinks(text) {
    const s = String(text || "");
    const seen = new Set();
    for (const h of DISK_HOSTS) {
      const re = new RegExp("https?://[^\\s'\")]*" + h.replace(/\./g, "\\.") + "[^\\s'\")]*", "gi");
      let m;
      while ((m = re.exec(s)) !== null) seen.add(m[0]);
    }
    return seen.size;
  }

  function buildHistorySubtitle(text) {
    const parts = [];
    const v = extractVersion(text);
    if (v) parts.push(v);
    const n = countDiskLinks(text);
    if (n > 0) parts.push(n + "网盘");
    return parts.join(" · ");
  }

  const HistoryMeta = { extractVersion, countDiskLinks, buildHistorySubtitle };

  if (typeof module !== "undefined" && module.exports) module.exports = HistoryMeta;
  if (typeof window !== "undefined") window.HistoryMeta = HistoryMeta;
  else if (typeof global !== "undefined") global.HistoryMeta = HistoryMeta;
})();