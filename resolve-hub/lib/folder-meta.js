const fs = require("fs");
const path = require("path");

const META_FILE = "B站标题与简介.md";

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

function readMetadata(dir) {
  const file = path.join(path.resolve(String(dir || "")), META_FILE);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return {
    file,
    ...parseBiliMarkdown(fs.readFileSync(file, "utf8")),
  };
}

module.exports = { META_FILE, parseBiliMarkdown, readMetadata };
