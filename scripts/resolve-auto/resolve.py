# -*- coding: utf-8 -*-
"""DaVinci Resolve 游戏剪辑标准流程的自动化部分（步骤 0-4 与 8-9）。

手动步骤（5-7：拉伸尾部文本对齐、V1 平滑剪接转场、改开场文本）由用户完成。
用法见 scripts/resolve-auto/README.md；本脚本由 index.js 以数组参数 spawn 调用。
"""
import argparse
import ctypes
import os
import re
import subprocess
import sys
import time
import zipfile

VIDEO_EXTS = ('.mp4', '.mkv', '.webm', '.mov')
COVER_EXTS = ('.jpg', '.jpeg', '.png', '.webp')
ILLEGAL_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sanitize_out_name(name, project):
    """输出名消毒：去 .mp4 后缀 / 路径分隔符 / 非法字符；空则回退标准命名。"""
    s = re.sub(r'\.mp4$', '', str(name or '').strip(), flags=re.I)
    s = ILLEGAL_NAME_CHARS.sub('_', s)
    s = re.sub(r'\s+', ' ', s).strip(' .')
    if not s or s in ('.', '..'):
        s = str(project) + ' 官方中文+全DLC+免安装硬盘版 免费学习版下载'
    return s[:120].strip()


def launch_resolve(resolve_exe):
    """启动 Resolve。普通启动失败且因权限不足（WinError 740）时，提权启动（会弹 UAC）。"""
    try:
        subprocess.Popen([resolve_exe])
        return
    except OSError as e:
        if getattr(e, 'winerror', None) != 740:
            raise
        print('[resolve] Resolve 需要管理员权限，尝试提权启动（如弹出 UAC 请点「是」）…')
        n = ctypes.windll.shell32.ShellExecuteW(None, 'runas', resolve_exe, None, None, 1)
        if n <= 32:
            raise RuntimeError(
                '提权启动 Resolve 失败（ShellExecute 返回 ' + str(n) + '），请手动打开 DaVinci Resolve 后重试')


def resolve_running():
    """检测 Resolve 进程是否在运行（不触碰脚本服务，避免打断启动）。"""
    try:
        out = subprocess.run(
            ['tasklist', '/FI', 'IMAGENAME eq Resolve.exe'], capture_output=True, text=True, timeout=15)
        return 'Resolve.exe' in (out.stdout or '')
    except Exception:
        return False


def connect(resolve_exe=None, timeout=240):
    """连接 Resolve；未运行时按步骤 0 自动启动并轮询等待。

    重要：Resolve 启动后脚本服务约 60-90 秒才就绪，过早/过频的 scriptapp 探测
    会打断它的握手（日志里 ScriptServer 反复重启）。因此启动后先暖机 75 秒，
    再以 15 秒间隔温和轮询，避免把服务打进死亡循环。
    """
    api = os.environ.get('RESOLVE_SCRIPT_API') or r'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting'
    lib = os.environ.get('RESOLVE_SCRIPT_LIB') or r'D:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll'
    os.environ['RESOLVE_SCRIPT_API'] = api
    os.environ['RESOLVE_SCRIPT_LIB'] = lib
    if api:
        sys.path.append(os.path.join(api, 'Modules'))
    import DaVinciResolveScript as dvr  # noqa: E402
    resolve = dvr.scriptapp('Resolve')
    if resolve is None and resolve_exe and os.path.exists(resolve_exe):
        print('[resolve] 检测到 Resolve 未运行，自动启动…')
        launch_resolve(resolve_exe)
        print('[resolve] 等待脚本服务就绪（暖机约 75 秒，勿中断）…')
        time.sleep(75)
        deadline = time.time() + timeout
        while time.time() < deadline:
            resolve = dvr.scriptapp('Resolve')
            if resolve is not None:
                break
            time.sleep(15)
    elif resolve is None and resolve_running():
        # 已在运行但连不上：可能是脚本服务刚被误打断，温和重试
        print('[resolve] Resolve 已运行，等待脚本服务恢复…')
        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(15)
            resolve = dvr.scriptapp('Resolve')
            if resolve is not None:
                break
    if resolve is None:
        raise RuntimeError('无法连接 DaVinci Resolve（请确认已安装 Studio 并允许外部脚本）')
    print('[resolve] 已连接，版本 ' + str(resolve.GetVersionString()))
    return resolve


def list_dir(d):
    try:
        return os.listdir(d)
    except OSError:
        return []


def find_cover(folder):
    for name in list_dir(folder):
        if not name.startswith('封面'):
            continue
        if name.lower().endswith(COVER_EXTS):
            return name
    return None


def find_trailer(folder):
    for name in list_dir(folder):
        lower = name.lower()
        if lower.endswith(VIDEO_EXTS) and not name.startswith('.'):
            # 排除 yt-dlp 中间产物（.f137.mp4 等半成品）与投稿成品标记
            if any(lower.endswith(ext) for ext in ('.part', '.ytdl', '.temp')):
                continue
            import re
            if re.search(r'\.f\d+(\.\w+)?$', lower):
                continue
            # 排除已渲染成品（命名规则：...免费学习版下载.mp4，或【游戏NNN】开头）
            if '免费学习版下载' in name or name.startswith('【游戏'):
                continue
            return name
    return None


def probe_video_codec(path, ffprobe):
    r = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
    return (r.stdout or '').strip().lower()


def check_trailer_codec(src, ffprobe):
    """仅检查并提示编码（不再转码；素材格式由收集环节把关）。"""
    codec = probe_video_codec(src, ffprobe)
    if codec == 'h264':
        print('[trailer] 视频编码：h264（符合规范）')
    else:
        print('[trailer] 警告：视频编码为 ' + (codec or '未知')
              + '，Resolve 渲染会失败；请按素材规范收集 H.264/AAC mp4（工具不再自动转码）')
    return codec


def probe_frame_count(path, ffprobe):
    r = subprocess.run(
        [ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0',
         '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    try:
        return int((r.stdout or '').strip())
    except ValueError:
        # 部分容器 -count_frames 拿不到，退回容器头的 nb_frames
        r2 = subprocess.run(
            [ffprobe, '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', path],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
        try:
            return int((r2.stdout or '').strip())
        except ValueError:
            raise RuntimeError('无法探测预告片帧数')


def clean_work_dir(work_dir, keep_days=30):
    """清理 _resolve-work 里超过 N 天的残留中间文件（当前流程不再写入，仅做历史清理）。"""
    if not os.path.isdir(work_dir):
        return 0
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for name in os.listdir(work_dir):
        p = os.path.join(work_dir, name)
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                removed += 1
        except OSError:
            pass
    if removed:
        print('[work] 已清理 ' + str(removed) + ' 个超过 ' + str(keep_days) + ' 天的中间文件')
    return removed


def self_check(tl):
    """渲染前自检（仅提示、不阻塞）：V1 结构 / 平滑剪接转场 / 尾部文本对齐。"""
    print('--- 渲染前自检（仅供参考，不阻塞） ---')
    start = tl.GetStartFrame()
    v1 = tl.GetItemListInTrack('video', 1) or []
    cover = trailer = trans = None
    for c in v1:
        nm = str(c.GetName() or '')
        d = c.GetDuration()
        if '平滑剪接' in nm or 'Morph' in nm or 'Dissolve' in nm:
            trans = c
        elif c.GetStart() == start and d <= 300:
            cover = c
        else:
            trailer = c
    if not cover:
        print('[自检] V1 封面：缺失')
    if not trailer:
        print('[自检] V1 预告片：缺失')
    if not trans:
        print('[自检] V1 平滑剪接转场：缺失（请完成手动步骤 6）')
    if trailer:
        vdur = trailer.GetDuration()
        for t in (2, 3):
            items = tl.GetItemListInTrack('video', t) or []
            texts = [c for c in items if str(c.GetName() or '') in ('文本', 'Rich')]
            if not texts:
                print('[自检] V%d：未找到文本' % t)
                continue
            tail = texts[-1]
            diff = tail.GetDuration() - vdur
            if abs(diff) > 60:
                print('[自检] V%d 尾部文本时长 %d ≠ 视频 %d（差 %d 帧，请完成手动步骤 5）'
                      % (t, tail.GetDuration(), vdur, diff))
    print('--- 自检结束 ---')


def ensure_project(pm, name, create=True):
    existing = pm.GetProjectListInCurrentFolder() or []
    if name in existing:
        proj = pm.LoadProject(name)
        print('[project] 载入已有项目：' + name)
    elif create:
        proj = pm.CreateProject(name)
        print('[project] 新建项目：' + name)
    else:
        raise RuntimeError('项目不存在：' + name)
    if not proj:
        raise RuntimeError('项目操作失败：' + name)
    return proj


def pick_media_item(items, name):
    base = os.path.splitext(name)[0].lower()
    for it in items or []:
        if it is None:
            continue
        nm = str(it.GetName() or '').lower()
        if nm == base or nm.startswith(base):
            return it
    return None


def find_pool_item(folder, name):
    """在媒体池（含子文件夹）中按源文件名精确查找条目，用于幂等跳过重复导入。"""
    base = os.path.splitext(name)[0].lower()
    for it in folder.GetClipList() or []:
        if it and str(it.GetName() or '').lower() == base:
            return it
    for sub in folder.GetSubFolderList() or []:
        hit = find_pool_item(sub, name)
        if hit:
            return hit
    return None


def find_timeline(proj, name):
    for i in range(1, proj.GetTimelineCount() + 1):
        tl = proj.GetTimelineByIndex(i)
        if tl and tl.GetName() == name:
            return tl
    return None


def timeline_has_trailer(tl, trailer_name):
    base = os.path.splitext(trailer_name)[0].lower()
    for v in range(1, tl.GetTrackCount('video') + 1):
        for c in tl.GetItemListInTrack('video', v):
            if base in str(c.GetName() or '').lower():
                return True
    return False


def dump_timeline(tl):
    print('--- 时间线结构：' + str(tl.GetName()) + ' ---')
    for ttype in ('video', 'audio'):
        for t in range(1, tl.GetTrackCount(ttype) + 1):
            for c in tl.GetItemListInTrack(ttype, t):
                print('  %s%d | %-32s | start=%s dur=%s' % (
                    ttype[0].upper(), t, str(c.GetName())[:32], c.GetStart(), c.GetDuration()))


def build_template_with_tail(template_path, work_dir, cover_frames, tail_frames):
    """导入前预设模板里的文本时长（DRT 本质是 zip + 明文 XML）。

    - 开场文本（Start = 模板起点）：时长 = cover_frames
    - 尾部文本（Start > 模板起点，V2[3]/V3[3]）：Start = 起点+cover_frames，时长 = tail_frames（= 视频片段帧数）
    - 平滑剪接转场：起点跟随 cover_frames
    返回生成的新 DRT 路径；失败返回 None（调用方回退原模板）。
    """
    try:
        if not os.path.isfile(template_path):
            return None
        os.makedirs(work_dir, exist_ok=True)
        out_path = os.path.join(work_dir, 'Timeline_preset.drt')
        with zipfile.ZipFile(template_path, 'r') as zin:
            entries = [(info, zin.read(info.filename)) for info in zin.infolist()]
        out_entries = []
        changed = False
        for info, data in entries:
            if info.filename.lower().endswith('.xml') and b'Sm2TiGenerator' in data:
                text = data.decode('utf-8')
                gen_blocks = re.findall(r'<Sm2TiGenerator[\s\S]*?</Sm2TiGenerator>', text)
                starts = []
                for block in gen_blocks:
                    m = re.search(r'<Start>(\d+)</Start>', block)
                    if m:
                        starts.append(int(m.group(1)))
                if starts:
                    template_start = min(starts)
                    def _rewrite_gen(m):
                        block = m.group(0)
                        sm = re.search(r'<Start>(\d+)</Start>', block)
                        if not sm:
                            return block
                        start = int(sm.group(1))
                        if start == template_start:
                            return re.sub(r'<Duration>\d+</Duration>',
                                          '<Duration>%d</Duration>' % cover_frames, block, count=1)
                        if start > template_start:
                            block = re.sub(r'<Start>\d+</Start>',
                                           '<Start>%d</Start>' % (template_start + cover_frames), block, count=1)
                            return re.sub(r'<Duration>\d+</Duration>',
                                          '<Duration>%d</Duration>' % tail_frames, block, count=1)
                        return block
                    text = re.sub(r'<Sm2TiGenerator[\s\S]*?</Sm2TiGenerator>', _rewrite_gen, text)

                    def _rewrite_transition(m):
                        block = m.group(0)
                        sm = re.search(r'<Start>(\d+)</Start>', block)
                        if sm and int(sm.group(1)) == template_start + 180:
                            return re.sub(r'<Start>\d+</Start>',
                                          '<Start>%d</Start>' % (template_start + cover_frames), block, count=1)
                        return block
                    text = re.sub(r'<Sm2TiTransition[\s\S]*?</Sm2TiTransition>', _rewrite_transition, text)
                    data = text.encode('utf-8')
                    changed = True
            out_entries.append((info, data))
        if not changed:
            return None
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zout:
            for info, data in out_entries:
                zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zi.compress_type = info.compress_type or zipfile.ZIP_DEFLATED
                zi.external_attr = info.external_attr
                zout.writestr(zi, data)
        print('[timeline] 已生成预设模板：尾部文本 %d 帧、开场文本 %d 帧 → %s'
              % (tail_frames, cover_frames, out_path))
        return out_path
    except Exception as e:
        print('[timeline] 警告：模板预设失败（将使用原模板）：' + str(e))
        return None


def cmd_setup(args):
    folder = os.path.abspath(args.dir)
    if not os.path.isdir(folder):
        raise RuntimeError('素材目录不存在：' + folder)
    cover = find_cover(folder)
    trailer = find_trailer(folder)
    if not cover:
        raise RuntimeError('目录里没找到 封面.*')
    if not trailer:
        raise RuntimeError('目录里没找到预告片视频（mp4/mkv/webm/mov）')
    print('[素材] 封面=' + cover + ' 视频=' + trailer)

    clean_work_dir(args.work_dir, int(os.environ.get('RESOLVE_WORK_KEEP_DAYS', '30')))

    project_name = args.project or os.path.basename(folder)
    resolve = connect(args.exe)
    pm = resolve.GetProjectManager()
    proj = ensure_project(pm, project_name, create=True)

    # 步骤 1：项目时间线帧率 60fps（DRT 模板本身也是 60fps，双保险）
    try:
        proj.SetSetting('timelineFrameRate', '60')
        print('[project] 时间线帧率已设为 60fps')
    except Exception as e:
        print('[project] 设置帧率失败（可忽略）：' + str(e))

    # 仅检查编码（不转码），素材格式由收集环节按规范产出
    check_trailer_codec(os.path.join(folder, trailer), args.ffprobe)

    # 步骤 2：导入素材到媒体池（幂等：已有同名条目则复用，不重复导入）
    mp = proj.GetMediaPool()
    cover_item = find_pool_item(mp.GetRootFolder(), cover)
    trailer_item = find_pool_item(mp.GetRootFolder(), trailer)
    if not cover_item or not trailer_item:
        ms = resolve.GetMediaStorage()
        added = ms.AddItemListToMediaPool([os.path.join(folder, cover), os.path.join(folder, trailer)])
        cover_item = cover_item or pick_media_item(added, cover)
        trailer_item = trailer_item or pick_media_item(added, trailer)
    if not cover_item or not trailer_item:
        raise RuntimeError('素材导入媒体池失败')
    print('[素材] 已就绪（封面原图 + 预告片）')

    cover_frames = int(os.environ.get('RESOLVE_COVER_FRAMES', '180') or 180)
    trailer_frames = None
    tail_frames = None
    tl = find_timeline(proj, 'Timeline 1')
    if tl is None:
        # 步骤 3：导入前先量视频长度，把模板 V2/V3 尾部文本预设成同样长度（免手动拉伸）
        trailer_frames = probe_frame_count(os.path.join(folder, trailer), args.ffprobe)
        tail_frames = max(1, trailer_frames - 30)  # 预告片从源第 30 帧起放，左侧留 30 帧手柄
        print('[timeline] 预告片 %d 帧 → V1 片段 %d 帧（源 30..%d）'
              % (trailer_frames, tail_frames, trailer_frames))
        preset = build_template_with_tail(args.template, args.work_dir, cover_frames, tail_frames)
        tl = mp.ImportTimelineFromFile(preset or args.template)
        if not tl and preset:
            print('[timeline] 警告：预设模板导入失败，改用原模板')
            tl = mp.ImportTimelineFromFile(args.template)
        if not tl:
            raise RuntimeError('时间线模板导入失败：' + args.template)
        print('[timeline] 已导入模板：' + str(tl.GetName()))
        if tl.GetName() != 'Timeline 1':
            tl.SetName('Timeline 1')

    proj.SetCurrentTimeline(tl)
    if timeline_has_trailer(tl, trailer):
        print('[timeline] 预告片已在 V1，跳过追加（幂等）')
    else:
        # 步骤 4：封面（原图静帧）→ 预告片
        # 封面时长必须和 DRT 模板的开场文本对齐：模板里 V2/V3 开场文本是 180 帧（3s），
        # 尾部文本从 216180 开始；所以默认也是 180 帧。需要 5s 封面时用 RESOLVE_COVER_FRAMES=300 覆盖。
        # 封面是静帧天然带无限右手柄；预告片从源第 30 帧起放留左手柄，平滑剪接转场才拖得上去。
        # recordFrame 用时间线起始帧（如 216000=01:00:00:00），否则会落到播放头/错误位置。
        # ⚠️ 静止图有自己的帧率（Resolve 一般是 24fps），AppendToTimeline 的 start/endFrame
        # 是「源帧」，会按 tl_fps/still_fps 换算成时间线帧：
        #   以前直接传 endFrame=180 → 179×(60/24)=447.5 → 实测 447 帧，这就是 180 变 447 的原因。
        def _fps(v, default):
            try:
                return float(str(v).strip().split()[0])
            except (TypeError, ValueError):
                return default
        try:
            tl_fps_raw = proj.GetSetting('timelineFrameRate')
        except Exception:
            tl_fps_raw = 60.0
        tl_fps = _fps(tl_fps_raw, 60.0)
        try:
            still_fps_raw = cover_item.GetClipProperty('FPS')
        except Exception:
            still_fps_raw = None
        still_fps = _fps(still_fps_raw, tl_fps)
        if still_fps <= 0:
            still_fps = tl_fps
        cover_src_start = 1
        still_span = max(1, int(round(cover_frames * still_fps / tl_fps)))
        cover_src_end = cover_src_start + still_span
        print('[timeline] 封面入轨：目标 %d 帧 @%.3gfps，静止图 %.3gfps → 源帧 %d..%d'
              % (cover_frames, tl_fps, still_fps, cover_src_start, cover_src_end))
        cover_ok = mp.AppendToTimeline([{
            'mediaPoolItem': cover_item,
            'startFrame': cover_src_start,
            'endFrame': cover_src_end,
            'trackIndex': 1,
            'recordFrame': tl.GetStartFrame(),
        }])
        cover_end = tl.GetStartFrame() + cover_frames
        cover_actual = None
        for c in tl.GetItemListInTrack('video', 1):
            if str(c.GetName() or '').startswith('封面'):
                cover_end = c.GetEnd()
                cover_actual = c.GetDuration()
                break
        if cover_actual is not None:
            print('[timeline] 封面实际时长：%d 帧（目标 %d 帧）' % (round(cover_actual), cover_frames))
            if abs(cover_actual - cover_frames) > 3:
                print('[timeline] 警告：封面实际时长与目标差 %d 帧，请检查静止图/项目帧率'
                      % round(cover_actual - cover_frames))
        if trailer_frames is None:
            trailer_frames = probe_frame_count(os.path.join(folder, trailer), args.ffprobe)
            tail_frames = max(1, trailer_frames - 30)
            print('[timeline] 警告：时间线已存在（模板未重新导入），尾部文本需手动拉伸')
        trailer_ok = mp.AppendToTimeline([{
            'mediaPoolItem': trailer_item,
            'startFrame': 30,
            'endFrame': trailer_frames,
            'trackIndex': 1,
            'recordFrame': cover_end,
        }])
        trailer_audio_ok = mp.AppendToTimeline([{
            'mediaPoolItem': trailer_item,
            'mediaType': 2,
            'startFrame': 30,
            'endFrame': trailer_frames,
            'trackIndex': 1,
            'recordFrame': cover_end,
        }])
        if not cover_ok or not trailer_ok or not trailer_audio_ok:
            raise RuntimeError('素材追加到时间线失败')
        print('[timeline] 已追加 封面(原图) → 预告片(留左手柄) 到 V1/A1')
    dump_timeline(tl)
    print('完成：请按标准流程手动完成 5-7（拉伸 V2[3]/V3[3] 文本、V1 平滑剪接、改开场文本），'
          '然后执行 render 子命令导出。')


def cmd_render(args):
    resolve = connect(args.exe)
    pm = resolve.GetProjectManager()
    proj = ensure_project(pm, args.project, create=False)
    tl = find_timeline(proj, 'Timeline 1')
    if tl is None:
        tl = proj.GetCurrentTimeline()
    if tl is None:
        raise RuntimeError('项目里没有时间线')
    proj.SetCurrentTimeline(tl)
    print('[render] 时间线：' + str(tl.GetName()) + '（end=' + str(tl.GetEndFrame()) + '）')
    self_check(tl)

    # 步骤 8：导出预设 + 格式/编码 + 输出设置
    # 预设加载成功后格式/编码已就绪；失败时兜底手动设置（注意 GetRenderCodecs 返回
    # {显示名: 内部名}，SetCurrentRenderFormatAndCodec 需要内部名如 H264_NVIDIA）
    if args.preset and proj.LoadRenderPreset(args.preset):
        print('[render] 已加载预设：' + args.preset)
    else:
        codecs = proj.GetRenderCodecs('mp4') or {}
        codec = codecs.get('H.264 NVIDIA') or codecs.get('H.264')
        if not codec:
            raise RuntimeError('mp4 格式下没有可用的 H.264 编码')
        if not proj.SetCurrentRenderFormatAndCodec('mp4', codec):
            raise RuntimeError('设置格式/编码失败')
        print('[render] 格式 mp4 / 编码 ' + codec)
    # 命名规则（标准流程）：输出到所选素材目录，文件名 = 项目名 + 固定版本描述后缀
    target = args.target or getattr(args, 'dir', None) or os.path.join(args.material_root, args.project)
    out = sanitize_out_name(args.out or (args.project + ' 官方中文+全DLC+免安装硬盘版 免费学习版下载'), args.project)
    os.makedirs(target, exist_ok=True)
    # 显式 MarkIn/MarkOut 覆盖项目里残留的旧区间（SelectAllFrames 不一定会清掉旧标记）
    settings = {
        'SelectAllFrames': False,
        'MarkIn': tl.GetStartFrame(),
        'MarkOut': tl.GetEndFrame(),
        'TargetDir': target,
        'CustomName': out,
    }
    if args.mark_in is not None and args.mark_out is not None:
        settings['MarkIn'] = args.mark_in
        settings['MarkOut'] = args.mark_out
    if not proj.SetRenderSettings(settings):
        raise RuntimeError('设置渲染参数失败')
    print('[render] 输出目录：' + target + '，文件名：' + out)

    # 步骤 9：只清掉「同名输出」的残留任务（以前 DeleteAllRenderJobs 会连用户其它排队任务一起删）
    for job in (proj.GetRenderJobList() or []):
        jname = os.path.basename(str(job.get('OutputFilename') or ''))
        if jname and jname.lower().startswith(out.lower()):
            try:
                proj.DeleteRenderJob(job.get('JobId'))
            except Exception:
                pass
    if not proj.AddRenderJob():
        raise RuntimeError('添加渲染任务失败')
    jobs = proj.GetRenderJobList() or []
    job_id = jobs[-1].get('JobId') if jobs else None
    print('[render] 开始渲染…')
    proj.StartRendering()
    deadline = time.time() + args.timeout
    while proj.IsRenderingInProgress() and time.time() < deadline:
        time.sleep(5)
    if proj.IsRenderingInProgress():
        raise RuntimeError('渲染超时')
    if job_id:
        st = proj.GetRenderJobStatus(job_id) or {}
        status = str(st.get('JobStatus') or '')
        if status and ('失败' in status or 'failed' in status.lower() or 'error' in status.lower()):
            raise RuntimeError('渲染任务失败：' + status)
    # DaVinci 遇到同名文件会输出「名字 (1).mp4」，所以按前缀找最新产物，不认死文件名
    pat = re.compile(r'^' + re.escape(out) + r'( \(\d+\))?\.mp4$', re.I)
    expected = os.path.join(target, out + '.mp4')
    found = None
    deadline = time.time() + 30
    while time.time() < deadline:
        candidates = []
        try:
            for name in os.listdir(target):
                if pat.match(name):
                    p = os.path.join(target, name)
                    if os.path.isfile(p) and os.path.getsize(p) > 0:
                        candidates.append(p)
        except OSError:
            pass
        if candidates:
            found = max(candidates, key=os.path.getmtime)
            break
        time.sleep(2)
    if found:
        print('[render] 完成：' + found + '（' + str(os.path.getsize(found)) + ' bytes）')
        return
    raise RuntimeError('渲染结束但未找到输出文件：' + expected)


def main():
    parser = argparse.ArgumentParser(prog='resolve-auto')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_setup = sub.add_parser('setup', help='步骤 0-4：启动 Resolve、建项目、导素材、导模板、追加到时间线')
    p_setup.add_argument('--dir', required=True, help='素材目录（含 封面.* + 预告片视频）')
    p_setup.add_argument('--project', default=None, help='项目名（默认取素材目录名）')
    p_setup.add_argument('--template', default=os.environ.get('RESOLVE_TEMPLATE_DRT', 'E:\\素材\\时间线\\Timeline 1.drt'))
    p_setup.add_argument('--ffmpeg', default=os.environ.get(
        'RESOLVE_FFMPEG', r'E:\Codex\tools-hub\material-hub\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe'))
    p_setup.add_argument('--ffprobe', default=os.environ.get(
        'RESOLVE_FFPROBE', r'E:\Codex\tools-hub\material-hub\node_modules\@ffprobe-installer\win32-x64\ffprobe.exe'))
    p_setup.add_argument('--work-dir', default=os.environ.get('RESOLVE_WORK_DIR', 'E:\\素材\\_resolve-work'))
    p_setup.add_argument('--exe', default=os.environ.get('RESOLVE_EXE', r'D:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe'))
    p_setup.set_defaults(func=cmd_setup)

    p_render = sub.add_parser('render', help='步骤 8-9：加载导出预设并渲染')
    p_render.add_argument('--project', required=True, help='项目名')
    p_render.add_argument('--out', default=None, help='输出文件名（不含扩展名，默认按标准流程命名规则）')
    p_render.add_argument('--target', default=None, help='输出目录（默认 E:\\素材\\<项目名>）')
    p_render.add_argument('--dir', default=None, help='素材目录（等同 --target，工具按用户所选目录传入）')
    p_render.add_argument('--preset', default=os.environ.get('RESOLVE_RENDER_PRESET', '导出预设'))
    p_render.add_argument('--material-root', default=os.environ.get('RESOLVE_MATERIAL_ROOT', 'E:\\素材'))
    p_render.add_argument('--mark-in', type=int, default=None, help='可选：只渲染该帧区间（验证用）')
    p_render.add_argument('--mark-out', type=int, default=None)
    p_render.add_argument('--timeout', type=int, default=1800, help='渲染等待上限秒数')
    p_render.add_argument('--exe', default=os.environ.get('RESOLVE_EXE', r'D:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe'))
    p_render.set_defaults(func=cmd_render)

    args = parser.parse_args()
    try:
        args.func(args)
    except RuntimeError as e:
        print('[错误] ' + str(e))
        sys.exit(1)


if __name__ == '__main__':
    main()
