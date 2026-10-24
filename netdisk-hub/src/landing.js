"use strict";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\d+\)(?=\.[^.]+$|$)/, "")
    .toLowerCase();
}

function entryId(entry) {
  return String((entry && (entry.fs_id ?? entry.id)) || "");
}

/**
 * 百度文件夹分享经常不返回 file_list，且落地后的目录名可能与分享页外层名称不同。
 * 优先精确/规范化同名匹配；都未命中时，用转存前后的 fs_id 差集认领真正新增项。
 */
function pickLandedEntries(expectedNames, beforeList, afterList, opts = {}) {
  const expected = (expectedNames || []).map(normalizeName).filter(Boolean);
  const after = Array.isArray(afterList) ? afterList : [];

  // 有前置快照时，优先认领本次真正新增的项。forced retry 可能生成
  // “名称 (1)”等新副本，不能因为目录里还留着旧同名项就误分享旧文件。
  if (Array.isArray(beforeList)) {
    const beforeIds = new Set(beforeList.map(entryId).filter(Boolean));
    const added = after.filter((item) => {
      const id = entryId(item);
      return id && !beforeIds.has(id);
    });
    if (added.length) return { entries: added, reason: "new-entry" };
  }

  const exact = after.filter((item) =>
    (expectedNames || []).includes(item && item.server_filename),
  );
  if (exact.length) return { entries: exact, reason: "exact" };

  const normalizedHits = after.filter((item) =>
    expected.includes(normalizeName(item && item.server_filename)),
  );
  if (normalizedHits.length) return { entries: normalizedHits, reason: "normalized" };

  // 百度文件夹分享可能用中文目录名落地，而分享页外层名是 PCGAME-英文名。
  // 已有同名目录再次转存时没有新增 fs_id，可用分享标题包含关系认领，
  // 但忽略“游戏/合集”这类过短泛词，避免误选。
  const aliases = (opts.aliases || []).map(normalizeName).filter((name) => name.length >= 4);
  const aliasHits = after.filter((item) => {
    const name = normalizeName(item && item.server_filename);
    return name.length >= 4 && aliases.some((alias) => alias.includes(name));
  });
  if (aliasHits.length) return { entries: aliasHits, reason: "title-alias" };

  return { entries: [], reason: "none" };
}

module.exports = { normalizeName, pickLandedEntries };
