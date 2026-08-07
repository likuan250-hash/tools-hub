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
const pendingPin = require('./pendingPin');
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
  const pendingPinM = subDeps.pendingPin || pendingPin;
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
  // B站投稿接口对「每个视频的标题」按 80 字符校验，且单P标题取「文件名（去扩展名）」——
  // 文件名超 80 字必报 code=21104「第(N)个视频的标题过长,已经超过80个字符」，改标题栏无效。
  // 这里在上传前直接拦截（不自动截断），提示用户自行重命名文件，避免白传一次大文件。
  const baseName = path.basename(videoPath).replace(/\.[^.]+$/, '');
  if (baseName.length > 80) {
    const msg = `文件名超 B 站 80 字限制（${baseName.length} 字）：B站单P标题取文件名，请重命名视频文件后重新选择`;
    emit({ type: 'error', stage: 'pending', message: msg });
    return { ok: false, error: msg };
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

  // 加密登录态 → 上传前解密到临时明文文件（biliup.exe -u 只认明文 LoginInfo）；
  // 上传结束（含失败/重试）后在 finally 中删除，避免明文 token 残留磁盘。
  let materialized = null;
  try {
    materialized = authM.materializeLoginInfo(config.loginInfoPath);
    config.loginInfoPath = materialized.path;
  } catch (e) {
    const msg = (e && e.message) ? e.message : '登录态解密失败';
    logger.error('[task] 生成临时登录态失败:', msg);
    emit({ type: 'error', stage: 'pending', message: msg });
    return { ok: false, error: msg };
  }

  // 标题：请求给定优先；否则 mp4 去扩展名
  let title = (req.title || '').trim();
  if (!title) {
    const base = path.basename(videoPath);
    title = base.replace(/\.[^.]+$/, '');
  }
  // 标题（投稿主标题）同样按 80 字符校验；超限直接报错提示修改，不自动截断。
  if (title.length > 80) {
    const msg = `标题超 B 站 80 字限制（${title.length} 字），请修改标题后重试`;
    emit({ type: 'error', stage: 'pending', message: msg });
    return { ok: false, error: msg };
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
    let script = commandM.buildPs1(
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
        let authRenewed = false;
        if (loginInfo) {
          // 退路①：用 refresh_token 静默刷新 access_token（写盘新 token）。
          const updated = await authM.refreshToken(loginInfo, { path: liPath, deps: subDeps });
          if (updated) {
            authRenewed = true;
            log('uploading', 'access_token 已刷新，重试上传');
          }
        }
        if (!authRenewed) {
          // 退路②：refresh_token 也失效时，用 web cookie 重新换 TV token（已验证可用逻辑）。
          try {
            await authM.ensureLoginInfo(cookiesFile, { path: liPath, deps: subDeps });
            authRenewed = true;
            log('uploading', '已用 web cookie 重新换取登录态，重试上传');
          } catch (e2) {
            logger.warn('[task] 重新生成 biliup LoginInfo 失败:', e2.message);
          }
        }
        // 关键：refresh/重换写的是「持久化加密文件」，而原脚本指向刷新前生成的「临时明文文件」，
        // 直接重试会继续用旧 token 再次 -400。必须重新解密生成新临时文件并重建脚本。
        if (authRenewed) {
          if (materialized) { try { materialized.cleanup(); } catch (_) {} }
          try {
            materialized = authM.materializeLoginInfo(liPath);
            config.loginInfoPath = materialized.path;
            script = commandM.buildPs1(
              { videoPath, title, tags, desc: fullDesc, publishMode, dtime },
              config,
              coverPath
            );
          } catch (e) {
            logger.warn('[task] 重新生成临时登录态失败:', e.message);
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

    // 4) 稿件信息：优先走创作中心 archive/view（官方编辑页同源接口，定时待发布也能取真实 cid，
    //    支撑「提交后立即加合集」）；失败再回退公开 getVideoInfo（保留 -404 重试兜底）。
    setStage('uploading', '获取稿件信息');
    let videoInfo;
    try {
      videoInfo = await biliupM.getCreativeArchive(ref, cookieHeader, {
        onLog: (m) => log('uploading', m),
        deps: subDeps,
      });
      log('uploading', '稿件信息（创作中心） aid=' + videoInfo.aid + ' cid=' + videoInfo.cid);
    } catch (archiveErr) {
      logger.warn('[task] archive/view 获取稿件信息失败，回退公开接口: ' + archiveErr.message);
      try {
        videoInfo = await biliupM.getVideoInfo(ref, {
          onLog: (m) => log('uploading', m),
          deps: subDeps,
        });
        log('uploading', '稿件信息 aid=' + videoInfo.aid + ' cid=' + videoInfo.cid);
      } catch (infoErr) {
        // 定时发布待发布：上传已成功，仅因公开接口 62003 取不到 cid —— 不算失败。
        // 跳过合集后置（发布后可点「检测补加」），继续评论与 done。
        if (!(infoErr && infoErr.scheduled)) throw infoErr;
        logger.warn('[task] 定时发布待发布（archive/view 亦失败），暂取不到 cid，合集后置延后: ' + infoErr.message);
        log('uploading', '定时发布待发布：暂取不到 cid，合集后置延后（发布后可点「检测补加」）');
        videoInfo = { aid: ref.aid || 0, cid: 0, title: req.title || '' };
        videoInfo.scheduledFallback = true;
      }
    }

    // 5) adding_season（坑点2：独立 API 后置；坑点4：-404 重试）
    // H: sectionId 为空串（用户未指定分集）时跳过合集后置，避免向后端传空 sectionId 报错。
    // 兜底：存量配置可能只有 seasonId、没有 sectionId（升级前分集下拉拉不到，如「绵绵不绝」），
    // 此时按合集自动解析首个分集（B站真实结构顶层 sections.sections 里的默认「正片」），
    // 解析失败/合集确实无分集 → 维持原跳过语义（非致命）。
    let sectionId = config.sectionId;
    if (config.seasonId && !sectionId) {
      try {
        const resolved = await seasonM.resolveFirstSectionId(config.seasonId, cookieHeader, { deps: subDeps });
        if (resolved) {
          sectionId = resolved;
          log('adding_season', '已按合集自动解析分集 sectionId=' + resolved);
        }
      } catch (e) {
        logger.warn('[task] 自动解析合集分集失败（非致命）: ' + e.message);
      }
    }
    if (videoInfo.scheduledFallback) {
      setStage('adding_season', '跳过合集后置（定时待发布，发布后可用检测补加）');
      log('adding_season', '定时待发布且取不到 cid，跳过合集后置（发布后可用检测补加）');
    } else if (sectionId) {
      setStage('adding_season', '合集后置中');
      // 合集后置为非关键步骤（类比评论置顶，#③）：失败仅记录警告，不阻断投稿整体流程，
      // 也不影响后续评论置顶与 done。season.add 内部已含 -404 重试/传输重试，此处仅兜底其最终失败。
      try {
        await seasonM.add(sectionId, videoInfo.aid, videoInfo.cid, title, csrf, cookieHeader, {
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
      try {
        await commentM.pin(videoInfo.aid, rpid, csrf, cookieHeader, { deps: subDeps });
        log('commenting', '评论已发布并置顶 rpid=' + rpid);
      } catch (pinErr) {
        // 定时发布/索引延迟：置顶暂不可用 → 落「待置顶」队列，发布后由后台轮询自动补置顶。
        try {
          pendingPinM.add({ aid: videoInfo.aid, bvid: ref.bvid || '', rpid, comment: config.comment || '' });
          logger.warn('[task] 置顶暂失败，已入待置顶队列（发布后自动补）: ' + pinErr.message);
          log('commenting', '评论已发布 rpid=' + rpid + '，置顶将在发布后自动完成');
        } catch (ppErr) {
          logger.warn('[task] 待置顶队列写入失败: ' + ppErr.message);
          log('commenting', '评论已发布 rpid=' + rpid + '，置顶失败且待置顶队列写入失败: ' + pinErr.message);
        }
      }
    } catch (commentErr) {
      // 评论发布为非关键步骤：失败仅记录警告，投稿任务仍算成功（继续 to done）。
      logger.warn('[task] 评论发布失败（非致命，投稿已完成）: ' + commentErr.message);
      log('commenting', '评论发布失败（非致命，已跳过）: ' + commentErr.message);
    }

    // 7) done —— season 真实反映：仅当 sectionId（含自动解析）存在，即实际执行了合集后置才为 true。
    const seasonAdded = !!sectionId && !videoInfo.scheduledFallback;
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
  } finally {
    // 无论成功/失败/重试路径，都必须删除临时明文登录态
    if (materialized) { try { materialized.cleanup(); } catch (_) {} }
  }
}

module.exports = { run, STAGES };
