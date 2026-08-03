// lib/collect.js —— 素材搜集全流程编排（scan → cover → trailer → done）
// 经 handlers.onEvent(obj) 发射设计 §3.2 定义的 SSE 事件；本文件不碰 HTTP，便于替换传输层。
// 失败语义：单步失败发 error 事件、流程继续；封面两源皆失败则整体 success=false（决策①）。
const { NameResolver } = require('./name');
const { SteamCover } = require('./steam');
const { TrailerDownloader } = require('./trailer');
const { EnvDetector, YT_DLP_GUIDANCE } = require('./env');
const loggerDefault = require('./logger');

/** 步骤名常量（与设计 §3.2 示例逐字对齐）。 */
const STEP_SCAN = '扫描编号并创建文件夹';
const STEP_COVER = '下载封面';
const STEP_TRAILER = '下载官方宣传片';
const STEP_DONE = '素材搜集完成';
const STEP_DONE_PARTIAL = '素材搜集完成（封面已落盘，宣传片缺失）';
const STEP_DONE_FAIL = '素材搜集未完成';
/** 默认落盘根目录（可经 MATERIAL_OUTPUT_DIR 覆盖）。 */
const DEFAULT_OUTPUT_DIR = 'E:\\素材\\';

/** 全流程编排服务。 */
class CollectService {
  /**
   * @param {{name?: NameResolver, cover?: SteamCover, trailer?: TrailerDownloader, env?: EnvDetector, logger?: object}} [deps]
   */
  constructor(deps = {}) {
    this.name = deps.name || new NameResolver();
    this.trailer = deps.trailer || new TrailerDownloader();
    this.cover = deps.cover || new SteamCover({ trailer: this.trailer });
    this.env = deps.env || new EnvDetector();
    this.logger = deps.logger || loggerDefault;
  }

  /**
   * 执行一次素材搜集。
   * @param {{name: string, outDir?: string}} opts 入参
   * @param {{onEvent?: (ev: object) => void}} [handlers] 事件回调（SSE 发送器）
   * @returns {Promise<{folder: string, index: number, cover: object|null, trailer: object|null, success: boolean, coverOk: boolean, trailerOk: boolean}>}
   */
  async run(opts = {}, handlers = {}) {
    const onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : () => {};
    /**
     * 发射一条 SSE 事件。
     * @param {string} type 事件类型
     * @param {string} step 人类可读步骤名
     * @param {string} msg 进展描述
     * @param {boolean|null} [ok] true=成功 / false=失败 / null=进行中
     * @param {object} [detail] 结构化细节
     */
    const emit = (type, step, msg, ok = null, detail) => {
      const ev = { type, step, msg, ok: ok === undefined ? null : ok };
      if (detail !== undefined) ev.detail = detail;
      try { onEvent(ev); } catch (e) { /* 客户端已断开 */ }
    };

    const gameName = String(opts.name == null ? '' : opts.name).trim();
    const outDir = opts.outDir || DEFAULT_OUTPUT_DIR;
    const result = {
      folder: '',
      index: 0,
      cover: null,
      trailer: null,
      success: false,
      coverOk: false,
      trailerOk: false,
    };

    if (!gameName) {
      emit('error', STEP_SCAN, '游戏名不能为空', false, { reason: 'empty-name', group: 'scan' });
      emit('done', STEP_DONE_FAIL, '未执行：游戏名为空', false, { coverOk: false, trailerOk: false });
      return result;
    }

    // 环境检测提前一次即可：封面回退与宣传片下载共用（缺失不阻断，仅影响对应分支）
    const envInfo = this.env.detect();
    if (!envInfo.ytDlp || !envInfo.ffmpeg) {
      emit('log', STEP_SCAN, '[env] 缺少依赖：' + envInfo.missing.join(', '), null, { level: 'info' });
    }

    // ── 1. scan：扫描编号 + 占位创建文件夹 ──
    let reserved = null;
    try {
      const nextIndex = this.name.nextIndex(outDir);
      emit('scan', STEP_SCAN, '解析下一个编号 → ' + nextIndex, null);
      reserved = this.name.reserveFolder(outDir, gameName, { startIndex: nextIndex });
    } catch (e) {
      this.logger.error('[collect] 创建素材文件夹失败:', e.message);
      emit('error', STEP_SCAN, '创建素材文件夹失败：' + e.message, false, {
        reason: 'mkdir-failed',
        group: 'scan',
        outDir,
      });
      emit('done', STEP_DONE_FAIL, '未落盘：无法创建素材文件夹', false, { coverOk: false, trailerOk: false });
      return result;
    }
    result.folder = reserved.folder;
    result.index = reserved.index;
    emit('scan', STEP_SCAN, '已创建 ' + reserved.folder + '\\', true, {
      folder: reserved.folder,
      index: reserved.index,
    });
    this.logger.info('[collect] 素材文件夹 ' + reserved.folder);

    // ── 2. cover：Steam 主路径 → YouTube 缩略图回退 → 两源皆失败报错 ──
    let coverRes = { ok: false, error: '未执行' };
    try {
      coverRes = await this.cover.fetchCover(gameName, reserved.folder, { emit, env: envInfo });
    } catch (e) {
      coverRes = { ok: false, reason: 'cover-exception', error: e.message };
    }
    if (coverRes.ok) {
      result.coverOk = true;
      result.cover = {
        file: coverRes.file,
        path: coverRes.path,
        width: coverRes.width,
        height: coverRes.height,
        source: coverRes.source || 'steam',
      };
    } else {
      this.logger.warn('[collect] 封面获取失败:', coverRes.error);
      emit('error', STEP_COVER, coverRes.error || 'Steam 与 YouTube 缩略图均获取失败', false, {
        reason: coverRes.reason || 'cover-both-failed',
        group: 'cover',
      });
    }

    // ── 3. trailer：yt-dlp 缺失仅此项报错，不崩溃、不影响已落盘的封面 ──
    if (!envInfo.ytDlp) {
      emit('error', STEP_TRAILER, '未检测到 yt-dlp，无法下载宣传片', false, {
        reason: 'yt-dlp-not-found',
        guidance: YT_DLP_GUIDANCE,
        group: 'trailer',
      });
    } else {
      let dl = { ok: false, error: '未执行' };
      try {
        const info = await this.trailer.searchTrailer(gameName, { emit });
        if (!info) {
          dl = { ok: false, reason: 'trailer-not-found', error: '未搜索到官方宣传片' };
        } else {
          dl = await this.trailer.download(gameName, reserved.folder, envInfo, { info, emit });
        }
      } catch (e) {
        dl = { ok: false, reason: 'trailer-exception', error: e.message };
      }
      if (dl.ok) {
        const tr = await this.trailer.transcodeIfNeeded(dl.file, reserved.folder, envInfo, { emit });
        result.trailerOk = true;
        result.trailer = {
          file: tr.file,
          path: reserved.folder + '\\' + tr.file,
          title: dl.title || '',
          converted: !!tr.converted,
        };
        emit('trailer_download', '下载宣传片', tr.file, true, {
          file: tr.file,
          converted: !!tr.converted,
          title: dl.title || '',
        });
      } else {
        this.logger.warn('[collect] 宣传片获取失败:', dl.error);
        emit('error', STEP_TRAILER, dl.error || '宣传片下载失败', false, {
          reason: dl.reason || 'trailer-failed',
          group: 'trailer',
        });
      }
    }

    // ── 4. done：封面是硬指标，缺封面即整体失败（决策①：报错而非静默）──
    result.success = result.coverOk;
    const step = result.success
      ? (result.trailerOk ? STEP_DONE : STEP_DONE_PARTIAL)
      : STEP_DONE_FAIL;
    const msg = result.success
      ? '落盘 ' + reserved.folder + '\\'
      : '封面缺失，仅创建了文件夹 ' + reserved.folder + '\\';
    emit('done', step, msg, result.success, {
      folder: result.folder,
      index: result.index,
      coverOk: result.coverOk,
      trailerOk: result.trailerOk,
      cover: result.cover,
      trailer: result.trailer,
    });
    this.logger.info('[collect] 完成 success=' + result.success + ' cover=' + result.coverOk + ' trailer=' + result.trailerOk);
    return result;
  }
}

module.exports = {
  CollectService,
  DEFAULT_OUTPUT_DIR,
  STEP_SCAN,
  STEP_COVER,
  STEP_TRAILER,
  STEP_DONE,
};
