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

VIDEO_EXTS = ('.mp4', '.mkv', '.webm', '.mov')
COVER_EXTS = ('.jpg', '.jpeg', '.png', '.webp')


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
        raise RuntimeError('无法探测预告片帧数')


def clean_work_dir(work_dir, keep_days=30):
    """清理 _resolve-work 里超过 N 天的中间文件（封面视频/转码预告片均可再生）。"""
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

    # 步骤 2：导入素材到媒体池
    ms = resolve.GetMediaStorage()
    added = ms.AddItemListToMediaPool([os.path.join(folder, cover), os.path.join(folder, trailer)])
    cover_item = pick_media_item(added, cover)
    trailer_item = pick_media_item(added, trailer)
    if not cover_item or not trailer_item:
        raise RuntimeError('素材导入媒体池失败')
    print('[素材] 已导入媒体池（封面原图 + 预告片）')

    mp = proj.GetMediaPool()
    tl = find_timeline(proj, 'Timeline 1')
    if tl is None:
        # 步骤 3：从 DRT 导入时间线模板（保留文本位置/样式）
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
        # 步骤 4：封面（原图静帧，时长由项目默认静帧时长决定，用户手动调整）→ 预告片
        # 封面是静帧天然带无限右手柄；预告片从源第 30 帧起放留左手柄，平滑剪接转场才拖得上去。
        # recordFrame 用时间线起始帧（如 216000=01:00:00:00），否则会落到播放头/错误位置。
        cover_ok = mp.AppendToTimeline([{
            'mediaPoolItem': cover_item,
            'startFrame': 1,
            'endFrame': 300,
            'trackIndex': 1,
            'recordFrame': tl.GetStartFrame(),
        }])
        cover_end = tl.GetStartFrame() + 300
        for c in tl.GetItemListInTrack('video', 1):
            if str(c.GetName() or '').startswith('封面'):
                cover_end = c.GetEnd()
                break
        trailer_frames = probe_frame_count(os.path.join(folder, trailer), args.ffprobe)
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
    tl = proj.GetCurrentTimeline()
    if tl is None:
        tl = find_timeline(proj, 'Timeline 1')
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
    # 命名规则（标准流程）：输出到素材目录，文件名 = 项目名 + 固定版本描述后缀
    target = args.target or os.path.join(args.material_root, args.project)
    out = args.out or (args.project + ' 官方中文+全DLC+免安装硬盘版 免费学习版下载')
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

    # 步骤 9：清残留任务（同名旧任务会互相覆盖/失败阻塞）→ 加任务 → 渲染 → 轮询 → 验证
    proj.DeleteAllRenderJobs()
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
    expected = os.path.join(target, out + '.mp4')
    deadline = time.time() + 30
    while not (os.path.exists(expected) and os.path.getsize(expected) > 0) and time.time() < deadline:
        time.sleep(2)
    if os.path.exists(expected) and os.path.getsize(expected) > 0:
        print('[render] 完成：' + expected + '（' + str(os.path.getsize(expected)) + ' bytes）')
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
