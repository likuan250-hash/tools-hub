// ── 输入文本解析 ──
const { cleanGameName, parseSteamAppIdFromText } = require("./nameutil");

function parseInput(text) {
  const lines = text.trim().split("\n").map(l => l.trim()).filter(l => l);
  if (!lines.length) return null;
  const firstLine = lines[0];
  let baidu = "", quark = "", xunlei = "", appid = "";
  for (const line of lines) {
    // 只提取纯链接，兼容「百度：https://...」「链接：https://...」等带前缀标签的写法
    const m = line.match(/https?:\/\/[^\s）)】]+/);
    if (!m) continue;
    const url = m[0];
    if (url.includes("pan.baidu.com")) baidu = url;
    else if (url.includes("pan.quark.cn")) quark = url;
    else if (url.includes("pan.xunlei.com")) xunlei = url;
    else {
      // H1：从粘贴的 Steam 链接（store/community/steamdb）抽取 AppID，作手动链接兜底，
      // 解决「中文名→英文名→AppID」整条失败（如 Wikidata 无中文标签的西方新作）的死局。
      const aid = parseSteamAppIdFromText(url);
      if (aid) appid = aid;
    }
  }
  let gameName = firstLine, englishName = "";
  // 先提取英文原名（括号内）
  const m = firstLine.match(/[（(]([^）)]+)[）)]/);
  if (m) { englishName = m[1]; }
  if (!englishName) {
    // 无括号时取「中文名后内嵌的英文名」（如「战锤40K：星际战士2 Warhammer 40,000: Space Marine 2 v14.0 …」）。
    // 直接命中 Steam 搜索，避免整条标题走 Bangumi/维基/百度模糊反查而错配 AppID（如 40K 系列拿到 Darktide）。
    const runs = firstLine.match(/[A-Za-z][A-Za-z0-9 .,'&:()\-.]*/g) || [];
    let best = "";
    for (const run of runs) {
      const trimmed = run.trim();
      const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
      if (letters < 2) continue;
      // 过滤 repack 噪音短串（如「DM」「DLC」）：多词标题或足够长的单段才算游戏名
      if (!(trimmed.includes(" ") || trimmed.length >= 6)) continue;
      if (trimmed.length > best.length) best = trimmed;
    }
    if (best) {
      // 剥版本尾巴（v14.0 / v1.2.3），与中文名里的版本号处理保持一致
      englishName = best.replace(/\s*v?\d+(?:\.\d+){1,3}\s*$/i, "").trim();
    }
  }
  // 游戏名：取括号前中文名；若无中文则用英文名；并去掉 Build/版本/补丁/免安装等长尾
  gameName = (m ? firstLine.substring(0, m.index).trim() : firstLine).replace(/\s*[Bb]uild\.\S+|\(?v?\d{4,}\S*\)?|\s*官方中文\+?|\+?升级补丁|\+?联机补丁|\s*免安装硬盘版|\s*免安装|\s*硬盘版/g, "").trim() || englishName;
  // 二次清洗：剥除版本号与 repack 标签噪音（如 v1.6.10721.0105 / 官方中文+预购特典+单独升级档），
  // 得到干净游戏名，既利于中文 Steam 检索、也用于封面文件名与展示（H3）。
  gameName = cleanGameName(gameName);
  const tags = [];
  if (firstLine.includes("全DLC")) tags.push("全DLC");
  if (firstLine.includes("免安装硬盘版") || firstLine.includes("免安装")) tags.push("免安装硬盘版");
  if (firstLine.includes("虚拟机版") || firstLine.includes("虚拟机")) tags.push("虚拟机版");
  if (firstLine.includes("联机") || firstLine.includes("合作")) tags.push("联机合作");
  if (!tags.includes("虚拟机版")) tags.unshift("PC游戏");

  // 显式标签行：识别「标签：动作,角色扮演,单机」或「标签：射击 冒险 RPG」
  for (const line of lines) {
    const tm = line.match(/^标签\s*[:：]\s*(.+)$/);
    if (tm) {
      const parts = tm[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) if (!tags.includes(p)) tags.push(p);
    }
  }

  // 游戏大小：自动识别文本中的容量描述（如 30.7G / 2.3TB / 512MB），或「大小：xxx」显式标注
  let size = "";
  for (const line of lines) {
    const sm = line.match(/(?:大小|容量|体积)\s*[:：]?\s*(\d+(?:\.\d+)?\s*(?:GB|G|TB|T|MB|M|KB|K)\b)/i)
            || line.match(/(\d+(?:\.\d+)?\s*(?:GB|G|TB|T|MB|M|KB|K)\b)/i);
    if (sm) { size = sm[1].trim().replace(/\s+/g, ""); break; }
  }

  // 手动封面链接：独立图片 URL 行，或「封面：https://...」前缀行（非 Steam 游戏兜底出图用）
  let coverUrl = "";
  for (const line of lines) {
    const cm = line.match(/(?:封面|cover)?\s*[:：]?\s*(https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif))(?:\?[^)\s]*)?/i);
    if (cm) { coverUrl = cm[1]; break; }
  }

  return { gameName, englishName, baiduUrl: baidu, quarkUrl: quark, xunleiUrl: xunlei, appid, tags, raw: firstLine, size, coverUrl };
}

module.exports = { parseInput };
