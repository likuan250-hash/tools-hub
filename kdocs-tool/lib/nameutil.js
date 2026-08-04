// ── 游戏名清洗 + Steam AppID 抽取（纯函数工具，无外部 IO 依赖）──
// 抽自 steam.js，供 parser（输入解析）与 steam（英文名解析/封面）共享，
// 避免 parser → steam 的耦合与潜在循环依赖。

/** 从任意文本抽 Steam AppID（store.steampowered.com/app/<id> / steamcommunity / steamdb）。纯函数。 */
function parseSteamAppIdFromText(text) {
  if (!text) return "";
  const m = /store\.steampowered\.com\/app\/(\d+)|steamcommunity\.com\/app\/(\d+)|steamdb\.info\/app\/(\d+)/i.exec(String(text));
  return m ? (m[1] || m[2] || m[3] || "") : "";
}

// ── 清洗：剥除游戏名里的版本号 / repack 标签噪音，便于百科精确匹配 ──
// 背景：百度网盘分享页标题常带 "v1.6.10721.0105 官方中文+预购特典+单独升级档" 这类噪音，
// 直接拿去 Wikidata / 百度百科搜会因词条名不匹配而 0 结果。先做轻量清洗再查命中率显著上升。
const NOISE_TAGS = [
  // 复合标签优先剥
  '官方中文+预购特典+单独升级档', '官方简中+预购特典+单独升级档', '官方繁中+预购特典+单独升级档',
  '官方中文+预购特典', '官方简中+预购特典', '官方繁中+预购特典',
  '预购特典+单独升级档', '预购特典',
  '单独升级档',
  // 单标签
  '官方中文', '官方简中', '官方繁中', '官方英文', '官方日文', '官方中文版',
  '整合版', '年度版', '终极版', '完全版', '豪华版', '典藏版', '黄金版', '黄金典藏版',
  '高清版', '中文版', '汉化版', '国行版', '美版', '欧版', '日版',
  'PC版', 'Steam版', '免安装', '免安装版', '绿色版', '破解版', '学习版', '未加密版',
  '离线版', '联机版', '单机版', '多人版',
  'D加密', 'Steam脱机', '数字版', '实体版', '光盘版', '全DLC', 'DLC',
  '赠品版', '体验版', '正式版', '尝鲜版', '抢先版', 'Beta版', 'Demo版',
  '更新版', '修正版', '升级版', '补丁版',
  '简体中文', '官方简体中文',
];

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 清洗游戏名：剥除版本号与尾部 repack 标签噪音，保留副标题（重制版等）。
 * 例：「最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档」 → 「最后的生还者2：重制版」
 * 纯函数，可单测。
 */
function cleanGameName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // 1) 剥版本号 v1.2.3 / V2 / v 1.2（含拖尾的 "."，避免 "v1.6.10721" 被其它规则切碎后留下 "v1.6." 残点）
  s = s.replace(/\s*[vV]\s*\d+(?:\.\d+)*\.?/g, ' ');
  // 2) 反复剥除 +/、/空格/，串接的标签（前/后锚定避免误伤核心名里的同字）
  const SEP = '[+\\s、/,,　]';
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const tag of NOISE_TAGS) {
      const re = new RegExp(`(?:^|${SEP})${escapeRe(tag)}(?=${SEP}|$)`, 'g');
      const before = s;
      s = s.replace(re, ' ');
      if (s !== before) changed = true;
    }
    if (!changed) break;
  }
  // 3) 清理多余分隔符
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[：:+\s、/,,]+/, '').replace(/[：:+\s、/,,]+$/, '');
  s = s.replace(/\s+\+\s+/g, ' ').trim();
  return s;
}

/**
 * 进一步剥掉冒号/破折号后的副标题（"重制版"、"Remastered"、"终极版"等），
 * 仅保留核心名用作百科兜底查询。纯函数。
 */
function stripSubtitle(name) {
  if (!name || typeof name !== 'string') return '';
  const m = /^([^：:\-—–]+?)\s*[：:\-—–]\s*/.exec(name);
  let core = m ? m[1].trim() : name.trim();
  core = core.replace(/[：:+\s、/,,]+$/, '').trim();
  return core;
}

module.exports = { parseSteamAppIdFromText, NOISE_TAGS, escapeRe, cleanGameName, stripSubtitle };
