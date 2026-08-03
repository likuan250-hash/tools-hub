// lib/collect.js —— 素材搜集全流程编排（scan → trailer → cover → 抽帧兜底 → done）
//
// 经 handlers.onEvent(obj) 发射 SSE 事件；本文件不碰 HTTP，便于替换传输层。
//
// ── 相对旧版的两处关键修复 ──
// Bug A（重复建文件夹 【游戏268/269/270】正当防卫4）：
//   旧版调 reserveFolder 时只传 startIndex，等于每次都「最大编号 +1 再 mkdir」。
//   现在改为直接依赖 name.js 的同名复用能力，并把返回的 reused 字段贯通到 SSE，
//   前端因此能显示「复用已有文件夹」而不是「已创建」。
//
// Bug B（点击运行一直不成功）：
//   旧版 `result.success = result.coverOk`，而封面源（Steam 1920×620 / YouTube 1280×720）
//   物理上不可能满足规范的 ≥1920×1080 → 必然判失败。现在：
//     ① 封面走 lib/cover.js 的规范六级来源；
//     ② 先下视频、后取封面，网络源全挂时用 probe.extractFrame 抽帧（必得视频原生分辨率）；
//     ③ success 改为「封面 + 视频都拿到」，抽帧兜底生效后整体必然判成功。
const path = require('path');
const fsDefault = require('fs');
const { NameResolver } = require('./name');
const { CoverFetcher, COVER_FILE } = require('./cover');
const { TrailerDownloader } = require('./trailer');
const { MediaProbe } = require('./probe');
const { EnvDetector, YT_DLP_GUIDANCE } = require('./env');
const { meetsMinSize, MIN_WIDTH, MIN_HEIGHT } = require('./imagesize');
const loggerDefault = require('./logger');

/** 步骤名常量（SSE 事件 step 字段，前端直接展示）。 */
const STEP_SCAN = '扫描编号并准备文件夹';
const STEP_TRAILER = '下载官方宣传片';
const STEP_COVER = '获取封面';
const STEP_DONE = '素材搜集完成';
const STEP_DONE_PARTIAL = '素材搜集部分完成';
const STEP_DONE_FAIL = '素材搜集未完成';
/** 默认落盘根目录（可经 MATERIAL_OUTPUT_DIR 覆盖）。 */
const DEFAULT_OUTPUT_DIR = 'E:\\素材\\';
/** 复用文件夹时识别既有产物用的扩展名。 */
const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov'];
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
/** 规范《目录结构》里的投稿完成标记，不能被当成素材产物。 */
const UPLOADED_MARK = '.uploaded';

/** 全流程编排服务。 */
class CollectService {
  /**
   * @param {{
   *   name?: NameResolver, cover?: CoverFetcher, trailer?: TrailerDownloader,
   *   probe?: MediaProbe, env?: EnvDetector, logger?: object, fs?: object
   * }} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.fs = deps.fs || fsDefault;
    this.name = deps.name || new NameResolver({ fs: this.fs });
    this.probe = deps.probe || new MediaProbe({ fs: this.fs });
    this.trailer = deps.trailer || new TrailerDownloader({ fs: this.fs, probe: this.probe });
    this.cover = deps.cover || new CoverFetcher({ fs: this.fs, probe: this.probe });
    this.env = deps.env || new EnvDetector({ fs: this.fs });
    this.logger = deps.logger || loggerDefault;
  }

  /**
   * 列出目录内条目（异常一律返回空数组）。
   * @param {string} dir 目录
   * @returns {string[]}
   */
  listDir(dir) {
    try {
      const entries = this.fs.readdirSync(dir);
      return Array.isArray(entries) ? entries : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 在（复用的）文件夹里找已存在的封面。
   * @param {string} folder 素材文件夹
   * @returns {{file: string, path: string}|null}
   */
  findExistingCover(folder) {
    for (const entry of this.listDir(folder)) {
      const lower = entry.toLowerCase();
      if (!entry.startsWith('封面')) continue;
      if (COVER_EXTS.some((e) => lower.endsWith(e))) {
        return { file: entry, path: path.join(folder, entry) };
      }
    }
    return null;
  }

  /**
   * 在（复用的）文件夹里找已存在的视频。
   * @param {string} folder 素材文件夹
   * @returns {{file: string, path: string}|null}
   */
  findExistingVideo(folder) {
    for (const entry of this.listDir(folder)) {
      if (entry === UPLOADED_MARK) continue;
      const lower = entry.toLowerCase();
      if (VIDEO_EXTS.some((e) => lower.endsWith(e))) {
        return { file: entry, path: path.join(folder, entry) };
      }
    }
    return null;
  }

  /**
   * 执行一次素材搜集。
   * @param {{
   *   name: string, outDir?: string, coverUrl?: string,
   *   englishName?: string, developer?: string, versionDesc?: string,
   *   kind?: string, force?: boolean
   * }} opts 入参；force=true 时忽略复用文件夹里的既有产物强制重下
   * @param {{onEvent?: (ev: object) => void}} [handlers] 事件回调（SSE 发送器）
   * @returns {Promise<{
   *   folder: string, index: number, reused: boolean,
   *   cover: object|null, trailer: object|null,
   *   success: boolean, partial: boolean, coverOk: boolean, trailerOk: boolean
   * }>}
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
    const force = opts.force === true;
    const result = {
      folder: '',
      index: 0,
      reused: false,
      cover: null,
      trailer: null,
      success: false,
      partial: false,
      coverOk: false,
      trailerOk: false,
    };

    if (!gameName) {
      emit('error', STEP_SCAN, '游戏名不能为空', false, { reason: 'empty-name', group: 'scan' });
      emit('done', STEP_DONE_FAIL, '未执行：游戏名为空', false, {
        coverOk: false, trailerOk: false, partial: false,
      });
      return result;
    }

    // ── 0. 环境：一次性解析三件套并注入各组件（工具已内置，正常情况全部命中）──
    const envInfo = this.env.detect();
    this.probe.setBinaries({ ffmpegPath: envInfo.ffmpegPath, ffprobePath: envInfo.ffprobePath });
    if (typeof this.trailer.setBinaries === 'function') {
      this.trailer.setBinaries({ ytDlpPath: envInfo.ytDlpPath, ffmpegPath: envInfo.ffmpegPath });
    }
    if (envInfo.missing.length) {
      emit('log', STEP_SCAN, '[env] 缺少依赖：' + envInfo.missing.join(', '), null, { level: 'warn' });
    } else {
      emit('log', STEP_SCAN, '[env] yt-dlp/' + envInfo.sources.ytDlp
        + ' · ffmpeg/' + envInfo.sources.ffmpeg
        + ' · ffprobe/' + envInfo.sources.ffprobe, null, { level: 'info' });
    }

    // ── 1. scan：同名复用优先，不存在才按「最大编号 +1」新建（Bug A）──
    let reserved = null;
    try {
      emit('scan', STEP_SCAN, '检测「' + gameName + '」是否已有素材文件夹…', null);
      reserved = this.name.reserveFolder(outDir, gameName);
    } catch (e) {
      this.logger.error('[collect] 创建素材文件夹失败:', e.message);
      emit('error', STEP_SCAN, '创建素材文件夹失败：' + e.message, false, {
        reason: 'mkdir-failed', group: 'scan', outDir,
      });
      emit('done', STEP_DONE_FAIL, '未落盘：无法创建素材文件夹', false, {
        coverOk: false, trailerOk: false, partial: false,
      });
      return result;
    }
    result.folder = reserved.folder;
    result.index = reserved.index;
    result.reused = reserved.reused === true;
    emit('scan', STEP_SCAN,
      (result.reused ? '复用已有文件夹 ' : '已创建 ') + reserved.folderName, true, {
        folder: reserved.folder,
        folderName: reserved.folderName,
        index: reserved.index,
        reused: result.reused,
      });
    this.logger.info('[collect] 素材文件夹 ' + reserved.folder + ' reused=' + result.reused);

    // ── 2. trailer：先下视频。放在封面之前有两个刚需 ──
    //      ① 第 6 级封面来源要用宣传片的 videoId 取缩略图；
    //      ② 第 7 级抽帧兜底必须有视频文件才能执行。
    let trailerInfo = null;
    let videoPath = '';

    const existingVideo = !force && result.reused ? this.findExistingVideo(reserved.folder) : null;
    if (existingVideo) {
      result.trailerOk = true;
      result.trailer = { file: existingVideo.file, path: existingVideo.path, title: '', reused: true };
      videoPath = existingVideo.path;
      emit('trailer_download', STEP_TRAILER, '复用已有视频 ' + existingVideo.file, true, {
        file: existingVideo.file, reused: true,
      });
    } else if (!envInfo.ytDlp) {
      emit('error', STEP_TRAILER, '未检测到 yt-dlp，无法下载宣传片', false, {
        reason: 'yt-dlp-not-found', guidance: YT_DLP_GUIDANCE, group: 'trailer',
      });
    } else {
      let dl = { ok: false, error: '未执行' };
      try {
        trailerInfo = await this.trailer.searchTrailer(gameName, {
          emit, developer: opts.developer,
        });
        if (!trailerInfo) {
          dl = { ok: false, reason: 'trailer-not-found', error: '未搜索到符合规范的官方宣传片' };
        } else {
          dl = await this.trailer.download(gameName, reserved.folder, envInfo, {
            info: trailerInfo,
            emit,
            index: reserved.index,
            kind: opts.kind,
            englishName: opts.englishName,
            versionDesc: opts.versionDesc,
          });
        }
      } catch (e) {
        dl = { ok: false, reason: 'trailer-exception', error: e.message };
      }

      if (dl.ok) {
        const tr = await this.trailer.transcodeIfNeeded(dl.file, reserved.folder, envInfo, { emit });
        const finalFile = tr.file;
        const finalPath = path.join(reserved.folder, finalFile);
        videoPath = finalPath;
        result.trailerOk = true;
        result.trailer = {
          file: finalFile,
          path: finalPath,
          title: dl.title || '',
          url: dl.url || '',
          channel: dl.channel || '',
          width: dl.width,
          height: dl.height,
          hd: dl.hd === true,
          converted: tr.converted === true,
          reused: false,
        };
        emit('trailer_download', STEP_TRAILER, finalFile, true, {
          file: finalFile,
          title: dl.title || '',
          width: dl.width,
          height: dl.height,
          hd: dl.hd === true,
          converted: tr.converted === true,
        });
      } else {
        this.logger.warn('[collect] 宣传片获取失败:', dl.error);
        emit('error', STEP_TRAILER, dl.error || '宣传片下载失败', false, {
          reason: dl.reason || 'trailer-failed', group: 'trailer',
        });
      }
    }

    // ── 3. cover：规范六级来源依次降级 ──
    const existingCover = !force && result.reused ? this.findExistingCover(reserved.folder) : null;
    let coverRes = { ok: false, error: '未执行' };

    if (existingCover) {
      coverRes = { ok: true, file: existingCover.file, path: existingCover.path, source: 'reused' };
      emit('cover_download', STEP_COVER, '复用已有封面 ' + existingCover.file, true, {
        file: existingCover.file, source: 'reused', reused: true,
      });
    } else {
      try {
        coverRes = await this.cover.fetchCover(gameName, reserved.folder, {
          emit,
          coverUrl: opts.coverUrl,
          // 缺陷 3：4kwallpapers / alphacoders / wallhaven 都是纯英文站，中文名喂进去必然 0 结果。
          // 调用方给了英文版名就直接用；没给时 CoverFetcher 会自己经 Steam 反查，查不到再退回原名。
          englishTitle: opts.englishName,
          videoId: trailerInfo && trailerInfo.id ? trailerInfo.id : '',
        });
      } catch (e) {
        // cover.js 内部已全程 try/catch，这里只是最后一道保险
        coverRes = { ok: false, reason: 'cover-exception', error: e.message };
      }
    }

    // ── 4. 抽帧兜底（规范第 7 级）——Bug B 的决定性修复 ──
    //      触发条件：封面完全没拿到，或只拿到不达标的降级图（YouTube 720p）。
    //      前提：本轮已有可用视频。抽帧产出的就是视频原生分辨率，1080p 视频必得 1920×1080。
    const needFallback = (!coverRes.ok || coverRes.degraded === true) && !!videoPath;
    if (needFallback) {
      const why = coverRes.ok ? '网络封面仅 720p 降级图' : '规范前 6 级封面来源均失败';
      emit('cover_extract', STEP_COVER, why + '，改用主视频抽帧兜底…', null, {
        reason: coverRes.reason || 'cover-degraded', video: videoPath,
      });
      const framePath = path.join(reserved.folder, COVER_FILE);
      let frame = { ok: false, error: '未执行' };
      try {
        frame = await this.probe.extractFrame(videoPath, framePath, { emit, step: STEP_COVER });
      } catch (e) {
        frame = { ok: false, reason: 'extract-exception', error: e.message };
      }

      if (frame.ok) {
        // 抽出来的帧同样要按规范核实分辨率，不盲信
        let width = 0;
        let height = 0;
        try {
          const sized = await this.probe.probeSize(framePath, { emit, step: STEP_COVER });
          if (sized && sized.ok) { width = sized.width; height = sized.height; }
        } catch (e) { /* 读不到尺寸不影响采纳，仅不展示分辨率 */ }

        const meets = width && height
          ? meetsMinSize({ width, height }, { width: MIN_WIDTH, height: MIN_HEIGHT })
          : true;
        coverRes = {
          ok: true,
          degraded: !meets,
          file: COVER_FILE,
          path: framePath,
          width: width || undefined,
          height: height || undefined,
          source: 'ffmpeg-frame',
          seek: frame.seek,
        };
        emit('cover_download', STEP_COVER,
          COVER_FILE + '（' + (width || '?') + '×' + (height || '?') + ' · 主视频抽帧 @' + (frame.seek || '00:00:05') + '）',
          true, {
            file: COVER_FILE, path: framePath, width, height, source: 'ffmpeg-frame', seek: frame.seek,
          });
      } else if (coverRes.ok) {
        // 抽帧失败但手上还有降级图 → 保留它，「有总比没有强」
        emit('cover_download', STEP_COVER, '抽帧失败，保留降级封面 ' + coverRes.file, true, {
          file: coverRes.file, source: coverRes.source, degraded: true, error: frame.error,
        });
      } else {
        emit('log', STEP_COVER, '[cover] 抽帧兜底失败：' + (frame.error || '未知原因'), null, { level: 'err' });
      }
    }

    if (coverRes.ok) {
      result.coverOk = true;
      result.cover = {
        file: coverRes.file,
        path: coverRes.path,
        width: coverRes.width,
        height: coverRes.height,
        source: coverRes.source || 'unknown',
        degraded: coverRes.degraded === true,
        reused: coverRes.source === 'reused',
      };
    } else {
      this.logger.warn('[collect] 封面获取失败:', coverRes.error);
      emit('error', STEP_COVER, coverRes.error || '所有封面来源均获取失败', false, {
        reason: coverRes.reason || 'cover-all-sources-failed',
        group: 'cover',
        tried: coverRes.tried || [],
      });
    }

    // ── 5. done：按规范《目录结构》，一份完整素材 = 主视频 + 封面 ──
    //      不再是旧版的 `success = coverOk` 单点判定。
    //      抽帧兜底生效后，只要视频下来了封面必然有 → 整体判成功。
    result.success = result.coverOk && result.trailerOk;
    result.partial = !result.success && (result.coverOk || result.trailerOk);

    let step = STEP_DONE_FAIL;
    if (result.success) step = STEP_DONE;
    else if (result.partial) step = STEP_DONE_PARTIAL;

    let msg = '';
    if (result.success) {
      msg = '落盘 ' + reserved.folder + '\\';
    } else if (result.partial) {
      msg = (result.coverOk ? '仅封面落盘' : '仅视频落盘') + '，缺 '
        + (result.coverOk ? '主视频' : '封面') + '：' + reserved.folder + '\\';
    } else {
      msg = '封面与视频均未取到，仅' + (result.reused ? '复用了' : '创建了') + '文件夹 ' + reserved.folder + '\\';
    }

    emit('done', step, msg, result.success, {
      folder: result.folder,
      folderName: reserved.folderName,
      index: result.index,
      reused: result.reused,
      coverOk: result.coverOk,
      trailerOk: result.trailerOk,
      partial: result.partial,
      cover: result.cover,
      trailer: result.trailer,
    });
    this.logger.info('[collect] 完成 success=' + result.success
      + ' cover=' + result.coverOk + ' trailer=' + result.trailerOk + ' reused=' + result.reused);
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
  STEP_DONE_PARTIAL,
  STEP_DONE_FAIL,
  VIDEO_EXTS,
  COVER_EXTS,
  UPLOADED_MARK,
};
