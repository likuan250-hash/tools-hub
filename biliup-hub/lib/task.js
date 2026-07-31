// lib/task.js —— 任务状态机 + SSE 事件编排（串联 cover→upload→season→comment）
// 状态机：pending → extracting_cover → uploading → adding_season → commenting → done
//          任一阶段抛错 → error（附 stage + message）
// 事件经 ctx.onEvent(ev) 实时推给前端（server.js 转 SSE）。
const fs = require('fs');
const path = require('path');
const cover = require('./cover');
const command = require('./command');
const biliup = require('./biliup');
const season = require('./season');
const comment = require('./comment');
const aigc = require('./aigc');
const cookies = require('./cookies');
const logger = require('./logger');

const STAGES = ['pending', 'extracting_cover', 'uploading', 'adding_season', 'commenting', 'done', 'error'];

/**
 * 执行一次完整投稿流程。
 * @param {Object} req 上传请求 { videoPath, tags, publishMode, dtime, title, params? }
 * @param {Object} ctx { config, cookiesFile, onEvent?, deps? }
 *   - config: 完整配置对象（store.getConfig()）
 *   - cookiesFile: cookies.load() 的结果（扁平对象）；为空则报错
 *   - onEvent(ev): 事件回调，ev = { type:'status'|'log'|'done'|'error', stage, message?, data? }
 *   - deps: 可选 { sleep, fetchFn } 注入（单测用）；默认真实实现
 * @returns {Promise<Object>} 最终 { ok, aid, bvid, cid, season }
 */
async function run(req, ctx) {
  const config = ctx.config || {};
  const cookiesFile = ctx.cookiesFile;
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
  const subDeps = ctx.deps || {};

  const emit = (ev) => { try { onEvent(ev); } catch (e) {} };
  const log = (stage, message) => emit({ type: 'log', stage, message: message || '' });
  const setStage = (stage, message) => emit({ type: 'status', stage, message: message || '' });

  const videoPath = req && req.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    emit({ type: 'error', stage: 'pending', message: '视频文件不存在: ' + videoPath });
    return { ok: false, error: '视频文件不存在' };
  }
  if (!cookiesFile || !cookies.validate(cookiesFile)) {
    emit({ type: 'error', stage: 'pending', message: 'cookies 无效：缺少 SESSDATA 或 bili_jct' });
    return { ok: false, error: 'cookies 无效' };
  }

  // 标题：请求给定优先；否则 mp4 去扩展名
  let title = (req.title || '').trim();
  if (!title) {
    const base = path.basename(videoPath);
    title = base.replace(/\.[^.]+$/, '');
  }

  // 完整 desc：基础简介 + AIGC 头（注入简介末尾）
  const fullDesc = aigc.appendToDesc(config.desc || '', config.aigc || {});

  const tags = Array.isArray(req.tags) ? req.tags : (config.tags || []);
  const publishMode = req.publishMode === 'dtime' ? 'dtime' : 'now';
  const dtime = req.dtime;

  const csrf = cookies.getCsrf(cookiesFile);
  const cookieHeader = cookies.toHeader(cookiesFile);

  try {
    // 1) pending
    setStage('pending', '开始投稿');

    // 2) extracting_cover
    setStage('extracting_cover', '抽封面帧');
    const ffmpeg = cover.resolveFfmpeg({ ffmpegPath: config.ffmpegPath, biliupExePath: config.biliupExePath });
    const coverPath = await cover.extract(videoPath, ffmpeg, {
      onLog: (m) => log('extracting_cover', m),
      deps: subDeps,
    });
    log('extracting_cover', coverPath ? '抽封面帧1 ... ok' : '抽封面失败，继续（biliup 将用默认封面）');

    // 3) uploading
    setStage('uploading', '上传中');
    const script = command.buildPs1(
      { videoPath, title, tags, desc: fullDesc, publishMode, dtime },
      config,
      coverPath
    );
    const ref = await biliup.runUpload(script, {
      onLog: (line) => log('uploading', line.trim()),
      deps: subDeps,
    });
    log('uploading', '上传完成 bvid=' + (ref.bvid || '?') + ' aid=' + (ref.aid || '?'));

    // 4) getVideoInfo（重试应对 -404）
    setStage('uploading', '等待稿件索引');
    const videoInfo = await biliup.getVideoInfo(ref, {
      onLog: (m) => log('uploading', m),
      deps: subDeps,
    });
    log('uploading', '稿件信息 aid=' + videoInfo.aid + ' cid=' + videoInfo.cid);

    // 5) adding_season（坑点2：独立 API 后置；坑点4：-404 重试）
    setStage('adding_season', '合集后置中');
    await season.add(config.sectionId, videoInfo.aid, videoInfo.cid, title, csrf, cookieHeader, {
      onLog: (m) => log('adding_season', m),
      deps: subDeps,
    });
    log('adding_season', '合集后置完成');

    // 6) commenting（发布 + 置顶）
    setStage('commenting', '评论置顶中');
    const rpid = await comment.post(videoInfo.aid, config.comment, csrf, cookieHeader, { deps: subDeps });
    await comment.pin(videoInfo.aid, rpid, csrf, cookieHeader, { deps: subDeps });
    log('commenting', '评论已发布并置顶 rpid=' + rpid);

    // 7) done
    setStage('done', '投稿完成');
    emit({
      type: 'done',
      stage: 'done',
      data: { aid: videoInfo.aid, bvid: ref.bvid, cid: videoInfo.cid, season: true, rpid },
    });
    return { ok: true, aid: videoInfo.aid, bvid: ref.bvid, cid: videoInfo.cid, season: true, rpid };
  } catch (e) {
    const stage = (e && e.stage) || 'error';
    logger.error('[task] 投稿失败 @' + stage + ':', e.message);
    emit({ type: 'error', stage, message: e.message });
    return { ok: false, error: e.message, stage };
  }
}

module.exports = { run, STAGES };
