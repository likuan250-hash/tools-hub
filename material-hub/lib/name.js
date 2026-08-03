// lib/name.js —— 素材文件夹编号解析与占位
// 规则：`【游戏NNN】游戏名`，编号递增，落 E:\素材\。
// 主理人裁定 ④：输出根目录不存在时自动 mkdir -p。
// 主理人裁定 ⑤：并发采用「算出编号即 mkdir，EEXIST 则 +1 重试」，非严格文件锁。
const fsDefault = require('fs');
const path = require('path');
const { FilenameSanitizer } = require('./filename');

/** 文件夹名编号前缀，如 `【游戏256】战神4`。 */
const FOLDER_RE = /^【游戏(\d+)】/;
/** 编号最小位宽（与规则示例 【游戏255】 对齐）。 */
const INDEX_PAD = 3;
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
   * 扫描输出目录下所有 `【游戏NNN】*` 取最大编号。
   * @param {string} outputDir 素材根目录
   * @returns {number} 最大编号；目录不存在或无匹配返回 0
   */
  scanMaxIndex(outputDir) {
    let entries = [];
    try {
      if (!this.fs.existsSync(outputDir)) return 0;
      entries = this.fs.readdirSync(outputDir);
    } catch (e) {
      return 0;
    }
    let max = 0;
    for (const name of entries) {
      const idx = this.parseIndexFromFolder(name);
      if (idx != null && idx > max) max = idx;
    }
    return max;
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
   * 确保素材根目录存在（裁定 ④：自动 mkdir -p）。
   * @param {string} outputDir 素材根目录
   */
  ensureOutputDir(outputDir) {
    this.fs.mkdirSync(outputDir, { recursive: true });
  }

  /**
   * 占位创建素材文件夹：非递归 mkdir 天然互斥，EEXIST 即编号 +1 重试（裁定 ⑤）。
   * @param {string} outputDir 素材根目录
   * @param {string} gameName 游戏名
   * @param {{startIndex?: number}} [opts] startIndex 省略时内部扫描
   * @returns {{folder: string, index: number, folderName: string}}
   * @throws {Error} 重试耗尽或其它 IO 错误
   */
  reserveFolder(outputDir, gameName, opts = {}) {
    this.ensureOutputDir(outputDir);
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
        return { folder, index, folderName };
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
