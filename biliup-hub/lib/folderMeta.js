const fs = require("fs");
const path = require("path");

const META_FILE = "B站标题与简介.md";
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov"]);

function parseBiliMarkdown(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let title = "";
  let mode = "";
  const descLines = [];
  let tags = [];
  for (const line of lines) {
    let m = line.match(/^\s*(?:#+\s*)?标题\s*[:：]\s*(.+?)\s*$/);
    if (m) {
      title = m[1].trim();
      mode = "";
      continue;
    }
    m = line.match(/^\s*(?:#+\s*)?简介\s*[:：]\s*(.*?)\s*$/);
    if (m) {
      if (m[1]) descLines.push(m[1]);
      mode = "desc";
      continue;
    }
    m = line.match(/^\s*(?:#+\s*)?标签\s*[:：]\s*(.+?)\s*$/);
    if (m) {
      tags = Array.from(
        new Set(
          m[1]
            .split(/[，,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      );
      mode = "";
      continue;
    }
    if (mode === "desc") descLines.push(line);
  }
  return {
    title,
    description: descLines.join("\n").trim(),
    tags,
  };
}

function findVideo(dir, title = "") {
  const videos = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .filter((name) => !/\.(part|ytdl|temp)$/i.test(name));
  const isTrailer = (name) => /发售预告片|预告片|trailer/i.test(name);
  const normalize = (name) =>
    path
      .basename(name, path.extname(name))
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  const expected = normalize(title);
  const ranked = videos
    .filter((name) => !isTrailer(name))
    .map((name) => {
      const base = normalize(name);
      let score = 0;
      if (expected && base === expected) score += 100;
      else if (expected && base.startsWith(expected)) score += 80;
      if (/【游戏\d+】/.test(name)) score += 60;
      if (/【1080P】|【720P】/i.test(name)) score -= 10;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"));
  return {
    video: ranked.length ? ranked[0].name : null,
    trailers: videos.filter(isTrailer),
    errorCode: ranked.length ? null : "FINAL_VIDEO_MISSING",
    error: ranked.length
      ? null
      : "成品视频缺失：素材目录里只有预告片或没有可投稿视频，请先在达芬奇完成导出",
  };
}

function readFolderMeta(dir) {
  const root = path.resolve(String(dir || ""));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("素材目录不存在或不是文件夹");
  }
  const metaPath = path.join(root, META_FILE);
  let metadata = { title: "", description: "", tags: [] };
  if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) {
    metadata = parseBiliMarkdown(fs.readFileSync(metaPath, "utf8"));
  }
  const videoResult = findVideo(root, metadata.title);
  return {
    dir: root,
    metadataFile: fs.existsSync(metaPath) ? metaPath : null,
    metadata,
    video: videoResult.video,
    videoPath: videoResult.video ? path.join(root, videoResult.video) : null,
    videoError: videoResult.error,
    videoErrorCode: videoResult.errorCode,
  };
}

module.exports = { META_FILE, parseBiliMarkdown, findVideo, readFolderMeta };
