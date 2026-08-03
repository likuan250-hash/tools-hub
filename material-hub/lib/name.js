// lib/name.js —— 素材文件夹编号解析、同名复用与占位创建
// 规范：`E:\素材\【游戏NNN】游戏名`，编号 = 已有最大编号 + 1。
//
// Bug A 修复（用户实测出现 【游戏268】正当防卫4 / 【游戏269】正当防卫4 / 【游戏270】正当防卫4）：
// 原实现的 reserveFolder 只会「取最大编号 +1 然后 mkdir」，从不检查同名游戏是否已建过文件夹，
// 于是每点一次「运行」就多一个同名游戏的新编号目录。
// 现在严格按规范《完整流程》第 2 步执行：
//   「检测素材文件夹是否已存在：不存在 → 创建；已存在 → 跳过创建，直接进入下一步」
// 即 reserveFolder 先调用 findExistingFolder 查同名，命中则复用（reused=true），不再新建。
const fsDefault = require('fs');
const path = require('path');
const { FilenameSanitizer, INDEX_PAD } = require('./filename');

/** 文件夹名编号前缀，如 `【游戏256】战神4`。 */
const FOLDER_RE = /^【游戏(\d+)】/;
/** mkdir 占位冲突时的最大重试次数（防极端并发死循环）。 */
const MAX_RESERVE_ATTEMPTS = 50;

/** 素材文件夹编号解析器。 */
class NameResolver {
  /**
   * @param {{fs?: object, sanitizer?: FilenameSanitizer}} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.fs = deps.fs || fsDefault;
    this.sanitizer = deps.sanitizer || new FilenameSanitizer();
  }

  /**
   * 从文件夹名解析编号。
   * @param {string} folderName 如 '【游戏256】战神4'
   * @returns {number|null} 编号；不匹配返回 null
   */
  parseIndexFromFolder(folderName) {
    const m = FOLDER_RE.exec(String(folderName == null ? '' : folderName));
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 从文件夹名解析游戏名（去掉 `【游戏NNN】` 前缀）。
   * @param {string} folderName 如 '【游戏256】战神4'
   * @returns {string|null} 游戏名；前缀不匹配返回 null
   */
  parseGameNameFromFolder(folderName) {
    const s = String(folderName == null ? '' : folderName);
    const m = FOLDER_RE.exec(s);
    if (!m) return null;
    return s.slice(m[0].length);
  }

  /**
   * 构造文件夹名（游戏名经清洗，保留空格以维持可读性）。
   * @param {number} index 编号
   * @param {string} gameName 游戏名
   * @returns {string} 如 '【游戏256】战神4'
   */
  buildFolderName(index, gameName) {
    const n = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0;
    const num = String(n).padStart(INDEX_PAD, '0');
    const safe = this.sanitizer.sanitize(gameName, { space: 'keep', max: 120 });
    return '【游戏' + num + '】' + safe;
  }

  /**
   * 游戏名归一化：用于「同名已存在」判定。
   * 忽略大小写、忽略所有空白、把常见中英标点视作等价（半角/全角冒号、连字符等），
   * 避免「战神 4」与「战神4」、「黑神话:悟空」与「黑神话：悟空」被判成两个游戏而重复建目录。
   * @param {string} raw 原始游戏名
   * @returns {string} 归一化结果（可能为空串）
   */
  normalizeGameName(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[：:]/g, ':')
      .replace(/[－—–\-_]/g, '-')
      .replace(/[·・]/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  /**
   * 扫描输出目录下所有 `【游戏NNN】*` 取最大编号。
   * @param {string} outputDir 素材根目录
   * @returns {number} 最大编号；目录不存在或无匹配返回 0
   */
  scanMaxIndex(outputDir) {
    let max = 0;
    for (const entry of this.listFolders(outputDir)) {
      const idx = this.parseIndexFromFolder(entry);
      if (idx != null && idx > max) max = idx;
    }
    return max;
  }

  /**
   * 列出输出目录下的条目名（目录不存在 / 读取失败一律返回空数组，不抛错）。
   * @param {string} outputDir 素材根目录
   * @returns {string[]}
   */
  listFolders(outputDir) {
    try {
      if (!this.fs.existsSync(outputDir)) return [];
      const entries = this.fs.readdirSync(outputDir);
      return Array.isArray(entries) ? entries : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 查找同名游戏是否已有素材文件夹（Bug A 的核心修复点）。
   * 判定口径：忽略编号，只比对归一化后的游戏名；命中多个时取编号最小的那个（最早建立的为准）。
   * @param {string} outputDir 素材根目录
   * @param {string} gameName 游戏名
   * @returns {{folder: string, index: number, folderName: string}|null} 未命中返回 null
   */
  findExistingFolder(outputDir, gameName) {
    const target = this.normalizeGameName(gameName);
    if (!target) return null;
    // 也用清洗后的名字比对一次：磁盘上的目录名是被 sanitize 过的（如 `黑神话_悟空`）
    const targetSanitized = this.normalizeGameName(
      this.sanitizer.sanitize(gameName, { space: 'keep', max: 120 }),
    );

    let hit = null;
    for (const entry of this.listFolders(outputDir)) {
      const index = this.parseIndexFromFolder(entry);
      if (index == null) continue;
      const name = this.normalizeGameName(this.parseGameNameFromFolder(entry));
      if (!name) continue;
      if (name !== target && name !== targetSanitized) continue;
      if (hit == null || index < hit.index) {
        hit = { folder: path.join(outputDir, entry), index, folderName: entry };
      }
    }
    return hit;
  }

  /**
   * 下一个可用编号 = 最大编号 + 1。
   * @param {string} outputDir 素材根目录
   * @returns {number}
   */
  nextIndex(outputDir) {
    return this.scanMaxIndex(outputDir) + 1;
  }

  /**
   * 确保素材根目录存在（输出目录不存在时自动 mkdir -p）。
   * @param {string} outputDir 素材根目录
   */
  ensureOutputDir(outputDir) {
    this.fs.mkdirSync(outputDir, { recursive: true });
  }

  /**
   * 取得本次要用的素材文件夹。
   * 规范《完整流程》第 2 步：已存在则跳过创建直接复用；不存在才按「最大编号 +1」新建。
   * 新建时非递归 mkdir 天然互斥，EEXIST 即编号 +1 重试（应对并发）。
   * @param {string} outputDir 素材根目录
   * @param {string} gameName 游戏名
   * @param {{startIndex?: number, reuseExisting?: boolean}} [opts]
   *   startIndex 省略时内部扫描；reuseExisting=false 可强制新建（默认 true）
   * @returns {{folder: string, index: number, folderName: string, reused: boolean}}
   * @throws {Error} 重试耗尽（ERESERVE）或其它 IO 错误
   */
  reserveFolder(outputDir, gameName, opts = {}) {
    this.ensureOutputDir(outputDir);

    // ── Bug A 修复：创建前先查同名，命中直接复用，绝不再建一个新编号的同名目录 ──
    if (opts.reuseExisting !== false) {
      const existing = this.findExistingFolder(outputDir, gameName);
      if (existing) {
        return {
          folder: existing.folder,
          index: existing.index,
          folderName: existing.folderName,
          reused: true,
        };
      }
    }

    let index = Number.isFinite(Number(opts.startIndex))
      ? Math.max(1, Math.floor(Number(opts.startIndex)))
      : this.nextIndex(outputDir);
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
      const folderName = this.buildFolderName(index, gameName);
      const folder = path.join(outputDir, folderName);
      try {
        // 非递归：目录已存在时抛 EEXIST，作为「编号已被占用」的判定信号
        this.fs.mkdirSync(folder);
        return { folder, index, folderName, reused: false };
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          lastError = e;
          index += 1;
          continue;
        }
        throw e;
      }
    }
    const err = new Error('编号占位失败：连续 ' + MAX_RESERVE_ATTEMPTS + ' 次目录已存在');
    err.code = 'ERESERVE';
    err.cause = lastError;
    throw err;
  }
}

module.exports = { NameResolver, FOLDER_RE, INDEX_PAD, MAX_RESERVE_ATTEMPTS };
