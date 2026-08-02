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
const cookies = require('./cookies');
const auth = require('./auth');
const biliupBin = require('./biliupBin');
const store = require('./store');
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

  // 依赖模块解析：允许单测通过 ctx.deps 完整注入（auth/biliup/cover/season/...），
  // 默认回落真实实现。与下游子模块「deps 仅含 fetchFn/sleep」的约定不冲突——
  // 这里把整个 subDeps 透传给子模块作为 deps，子模块只读取其中自己关心的字段。
  const authM = subDeps.auth || auth;
  const biliupM = subDeps.biliup || biliup;
  const coverM = subDeps.cover || cover;
  const commandM = subDeps.command || command;
  const seasonM = subDeps.season || season;
  const commentM = subDeps.comment || comment;
  const cookiesM = subDeps.cookies || cookies;
  const biliupBinM = subDeps.biliupBin || biliupBin;

  const emit = (ev) => { try { onEvent(ev); } catch (e) {} };
  const log = (stage, message) => emit({ type: 'log', stage, message: message || '' });
  const setStage = (stage, message) => emit({ type: 'status', stage, message: message || '' });

  // biliup.exe 路径按运行环境解析（#6），确保打包/开发都能命中正确位置。
  config.biliupExePath = biliupBinM.resolveBiliupBin();

  const videoPath = req && req.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    emit({ type: 'error', stage: 'pending', message: '视频文件不存在: ' + videoPath });
    return { ok: false, error: '视频文件不存在' };
  }
  if (!cookiesFile || !cookiesM.validate(cookiesFile)) {
    emit({ type: 'error', stage: 'pending', message: 'cookies 无效：缺少 SESSDATA 或 bili_jct' });
    return { ok: false, error: 'cookies 无效' };
  }

  // 生成/刷新 biliup 的 LoginInfo 文件（web cookie + token 换取；本地兜底不依赖网络）。
  // 必须在上传前完成：biliup -u 指向该文件，缺失会直接报 open cookies file 错误。
  // 改用 ensureFreshLoginInfo：复用持久化有效 token，临期主动续期（治本 -400 鉴权失败）。
  try {
    await authM.ensureFreshLoginInfo(cookiesFile, { path: config.loginInfoPath, deps: subDeps });
  } catch (e) {
    logger.error('[task] 确保 biliup 登录态失败:', e.message);
    const msg = (e && e.message) ? e.message : '登录态失效，请重新扫码登录';
    emit({ type: 'error', stage: 'pending', message: msg });
    return { ok: false, error: msg };
  }

  // 标题：请求给定优先；否则 mp4 去扩展名
  let title = (req.title || '').trim();
  if (!title) {
    const base = path.basename(videoPath);
    title = base.replace(/\.[^.]+$/, '');
  }

  // 完整 desc：基础简介（AIGC 合规头已于 #3 移除，不再注入）。
  const fullDesc = config.desc || '';

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
    const ffmpeg = coverM.resolveFfmpeg({ ffmpegPath: config.ffmpegPath, biliupExePath: config.biliupExePath });
    const coverPath = await coverM.extract(videoPath, ffmpeg, {
      onLog: (m) => log('extracting_cover', m),
      deps: subDeps,
    });
    log('extracting_cover', coverPath ? '抽封面帧1 ... ok' : '抽封面失败，继续（biliup 将用默认封面）');

    // 3) uploading —— 含 token 过期自愈：上传失败且为 -400 鉴权错误时，刷新/重换 token 后重试一次。
    setStage('uploading', '上传中');
    const script = commandM.buildPs1(
      { videoPath, title, tags, desc: fullDesc, publishMode, dtime },
      config,
      coverPath
    );

    let ref;
    try {
      ref = await biliupM.runUpload(script, {
        onLog: (line) => log('uploading', line.trim()),
        deps: subDeps,
      });
    } catch (uploadErr) {
      const msg = (uploadErr && uploadErr.message) || '';
      // 仅针对 -400 鉴权失败自愈（其他上传错误不重试，避免掩盖真实故障）。
      if (/code=-400/.test(msg)) {
        const liPath = store.getLoginInfoPath();
        const loginInfo = authM.loadLoginInfo(liPath);
        let refreshed = false;
        if (loginInfo) {
          // 退路①：用 refresh_token 静默刷新 access_token（写盘新 token）。
          const updated = await authM.refreshToken(loginInfo, { path: liPath, deps: subDeps });
          if (updated) {
            refreshed = true;
            log('uploading', 'access_token 已刷新，重试上传');
          }
        }
        if (!refreshed) {
          // 退路②：refresh_token 也失效时，用 web cookie 重新换 TV token（已验证可用逻辑）。
          try {
            await authM.ensureLoginInfo(cookiesFile, { path: liPath, deps: subDeps });
            log('uploading', '已用 web cookie 重新换取登录态，重试上传');
          } catch (e2) {
            logger.warn('[task] 重新生成 biliup LoginInfo 失败:', e2.message);
          }
        }
        // 重试仅 1 次（最多 2 次总上传），避免死循环；仍抛 -400 则向上抛，由外层 catch 判失败。
        ref = await biliupM.runUpload(script, {
          onLog: (line) => log('uploading', line.trim()),
          deps: subDeps,
        });
      } else {
        throw uploadErr;
      }
    }

    if (ref.bvid || ref.aid) {
      log('uploading', '上传完成 bvid=' + (ref.bvid || '?') + ' aid=' + (ref.aid || '?'));
    } else {
      // 无标识：不再打「上传完成」（假成功）。早报真实状态，提示日志已落盘待核对。
      log('uploading', '上传已结束但未解析到稿件标识（完整日志已落盘 .tmp/upload-*.log，待人工/根治核对）');
    }

    // 4) getVideoInfo（重试应对 -404）
    setStage('uploading', '等待稿件索引');
    const videoInfo = await biliupM.getVideoInfo(ref, {
      onLog: (m) => log('uploading', m),
      deps: subDeps,
    });
    log('uploading', '稿件信息 aid=' + videoInfo.aid + ' cid=' + videoInfo.cid);

    // 5) adding_season（坑点2：独立 API 后置；坑点4：-404 重试）
    // H: sectionId 为空串（用户未指定分集）时跳过合集后置，避免向后端传空 sectionId 报错。
    if (config.sectionId) {
      setStage('adding_season', '合集后置中');
      // 合集后置为非关键步骤（类比评论置顶，#③）：失败仅记录警告，不阻断投稿整体流程，
      // 也不影响后续评论置顶与 done。season.add 内部已含 -404 重试/传输重试，此处仅兜底其最终失败。
      try {
        await seasonM.add(config.sectionId, videoInfo.aid, videoInfo.cid, title, csrf, cookieHeader, {
          onLog: (m) => log('adding_season', m),
          deps: subDeps,
        });
        log('adding_season', '合集后置完成');
      } catch (seasonErr) {
        // 尽量带上 B站返回的 code/message（season.add 抛错信息已含 code=... msg=... 或重试耗尽原因）。
        const msg = (seasonErr && seasonErr.message) ? seasonErr.message : '未知错误';
        logger.warn('[task] 合集后置失败（非致命）: ' + msg);
        log('adding_season', '合集后置失败（非致命，已跳过）: ' + msg);
      }
    } else {
      setStage('adding_season', '跳过合集后置（未指定分集）');
      log('adding_season', '未指定分集，跳过合集后置');
    }

    // 6) commenting（发布 + 置顶）—— 非致命：失败不影响投稿整体结果
    setStage('commenting', '评论置顶中');
    let rpid;
    try {
      rpid = await commentM.post(videoInfo.aid, config.comment, csrf, cookieHeader, { deps: subDeps });
      await commentM.pin(videoInfo.aid, rpid, csrf, cookieHeader, { deps: subDeps });
      log('commenting', '评论已发布并置顶 rpid=' + rpid);
    } catch (commentErr) {
      // 评论置顶为非关键步骤：失败仅记录警告，投稿任务仍算成功（继续 to done）。
      logger.warn('[task] 评论发布/置顶失败（非致命，投稿已完成）: ' + commentErr.message);
      log('commenting', '评论发布/置顶失败（非致命，已跳过）: ' + commentErr.message);
    }

    // 7) done —— season 真实反映：仅当 config.sectionId 存在（即实际执行了合集后置）才为 true。
    const seasonAdded = !!config.sectionId;
    setStage('done', '投稿完成');
    emit({
      type: 'done',
      stage: 'done',
      data: { aid: videoInfo.aid, bvid: ref.bvid, cid: videoInfo.cid, season: seasonAdded, rpid },
    });
    return { ok: true, aid: videoInfo.aid, bvid: ref.bvid, cid: videoInfo.cid, season: seasonAdded, rpid };
  } catch (e) {
    const stage = (e && e.stage) || 'error';
    logger.error('[task] 投稿失败 @' + stage + ':', e.message);
    emit({ type: 'error', stage, message: e.message });
    return { ok: false, error: e.message, stage };
  }
}

module.exports = { run, STAGES };
