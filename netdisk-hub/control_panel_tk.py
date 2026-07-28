# -*- coding: utf-8 -*-
"""网盘中转台 · 服务控制面板 (Python tkinter 原生 GUI)

不依赖 IE / WebView2：纯原生控件，日志区用 ScrolledText 系统级滚动条，
按钮 hover 是原生行为，绝不变形/重叠。pythonw 启动无黑窗。
"""
import os
import sys
import time
import socket
import shutil
import subprocess
import threading
import webbrowser
import urllib.request
import tkinter as tk
from tkinter import ttk, scrolledtext

PROJ = os.path.dirname(os.path.abspath(__file__))
NODE = os.path.join(
    os.environ.get("USERPROFILE", os.path.expanduser("~")),
    ".workbuddy", "binaries", "node", "versions", "22.22.2", "node.exe",
)
SERVER_JS = os.path.join(PROJ, "server.js")
PORT = 3000
DETACHED = 0x00000008        # DETACHED_PROCESS
NEW_PROC_GROUP = 0x00000200  # CREATE_NEW_PROCESS_GROUP
CREATE_NO_WINDOW = 0x08000000 # CREATE_NO_WINDOW (隐藏子进程控制台黑窗)

proc = None
start_ts = 0
_inst_lock = None
want_running = False      # 期望运行状态: 看门狗据此维持 node 进程存活
last_auto_start = 0       # 看门狗上次自动拉起时间(节流用)
health_failures = 0       # 连续健康检查失败次数(避免瞬时波动触发重启)
NODE_LOG_MAX_BYTES = 10 * 1024 * 1024


def is_ready():
    """服务可用性检查: 端口存在不代表 Express 仍可正常处理请求。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/ready" % PORT, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def rotate_node_log():
    """服务重启前轮转过大的 node 输出日志，避免单个文件长期无上限增长。"""
    log_dir = os.path.join(PROJ, "logs")
    current = os.path.join(log_dir, "node-out.log")
    try:
        if os.path.getsize(current) < NODE_LOG_MAX_BYTES:
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        os.replace(current, os.path.join(log_dir, "node-out-%s.log" % stamp))
    except FileNotFoundError:
        pass
    except Exception:
        # 轮转失败不应阻断服务启动；下次启动会再次尝试。
        pass


# ── 后端逻辑(与旧 control_panel.py 一致) ────────────────────────
def find_pid():
    """返回 (pid, state)，state ∈ running|other|down"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             text=True, timeout=8,
                             creationflags=CREATE_NO_WINDOW).stdout
    except Exception:
        return "", "down"
    for line in out.splitlines():
        if (":%d" % PORT in line) and "LISTENING" in line:
            pid = line.split()[-1]
            try:
                t = subprocess.run(["tasklist", "/fi", "PID eq %s" % pid],
                                   capture_output=True, text=True, timeout=8,
                                   creationflags=CREATE_NO_WINDOW).stdout
            except Exception:
                t = ""
            if "node.exe" in t.lower():
                return pid, "running"
            return pid, "other"
    return "", "down"


def maybe_install_deps(ui):
    """依赖变更哨兵存在时, 在本(面板)独立进程里安装依赖, 绝不在 node 运行进程上装。"""
    sentinel = os.path.join(PROJ, "data", ".needs-npm-install")
    if not os.path.exists(sentinel):
        return True
    npm = shutil.which("npm") or "npm"
    if ui:
        ui.log("检测到依赖变更, 正在安装…", "warn")
    try:
        result = subprocess.run([npm, "install"], cwd=PROJ, capture_output=True,
                                text=True, timeout=300, creationflags=CREATE_NO_WINDOW)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "未知错误").strip().replace("\n", " ")
            if ui:
                ui.log("依赖安装失败(哨兵已保留): %s" % detail[:300], "err")
            return False
    except Exception as e:
        if ui:
            ui.log("依赖安装失败(哨兵已保留): %s" % e, "err")
        return False
    try:
        os.remove(sentinel)
    except Exception:
        if ui:
            ui.log("依赖已安装，但无法清除安装哨兵", "warn")
        return False
    if ui:
        ui.log("依赖安装完成", "ok")
    return True


def start_server(ui):
    global proc, start_ts, want_running
    pid, st = find_pid()
    if st == "running":
        if ui:
            ui.log("服务已在运行 (PID %s)" % pid, "warn")
        want_running = True
        return
    # 依赖变更哨兵: 启动前先在本(面板)进程安装, 避免 node 运行进程上直接换依赖
    if not maybe_install_deps(ui):
        if ui:
            ui.log("为避免以不完整依赖启动，已取消启动", "err")
        return
    cmd = [NODE, SERVER_JS] if os.path.exists(NODE) else ["node", SERVER_JS]
    os.makedirs(os.path.join(PROJ, "logs"), exist_ok=True)
    rotate_node_log()
    # 将 node 自身的 stdout/stderr 重定向到日志文件(DETACHED 下管道不可靠, 改为文件更安全)
    try:
        nodelog = open(os.path.join(PROJ, "logs", "node-out.log"), "a",
                       encoding="utf-8", errors="replace")
    except Exception:
        nodelog = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            cmd, cwd=PROJ, stdout=nodelog, stderr=nodelog,
            creationflags=DETACHED | NEW_PROC_GROUP | CREATE_NO_WINDOW,
        )
    except Exception as e:
        if ui:
            ui.log("启动失败: %s" % e, "err")
        return
    for _ in range(15):
        time.sleep(1)
        if find_pid()[1] == "running":
            start_ts = time.time()
            want_running = True
            if ui:
                ui.log("启动成功", "ok")
            return
    if ui:
        ui.log("启动超时，可能端口被占用或服务报错", "err")


def stop_server(ui):
    global start_ts, want_running
    pid, st = find_pid()
    if st == "other":
        if ui:
            ui.log("端口 %d 被其他程序占用，未终止" % PORT, "warn")
        return
    if not pid:
        if ui:
            ui.log("服务未运行", "warn")
        want_running = False
        return
    subprocess.run(["taskkill", "/pid", pid, "/f"], capture_output=True,
                   creationflags=CREATE_NO_WINDOW)
    start_ts = 0
    want_running = False
    time.sleep(1)
    if ui:
        ui.log("已停止 (PID %s)" % pid, "ok")


def watchdog():
    """期望运行状态下, 同时检查进程存活和 HTTP 就绪状态, 异常则自动拉起。"""
    global last_auto_start, health_failures
    while True:
        time.sleep(5)
        try:
            if not want_running:
                continue
            pid, st = find_pid()
            if st == "running":
                if is_ready():
                    health_failures = 0
                    continue
                health_failures += 1
                if health_failures < 3:
                    continue
                # 连续三次就绪检查失败: 进程可能仍在, 但服务已卡死或被标记不健康。
                subprocess.run(["taskkill", "/pid", pid, "/f"], capture_output=True,
                               creationflags=CREATE_NO_WINDOW)
                health_failures = 0
                time.sleep(1)
            if st == "other":
                continue  # 端口被其它程序占, 不抢
            now = time.time()
            if now - last_auto_start < 10:
                continue  # 节流: 10s 内最多自动拉起一次
            last_auto_start = now
            start_server(None)
        except Exception:
            pass


def restart_server(ui):
    stop_server(ui)
    time.sleep(1.5)
    start_server(ui)


def open_web():
    webbrowser.open("http://localhost:%d" % PORT)


# ── 单实例锁 ────────────────────────────────────────────────────
def guard_single_instance():
    global _inst_lock
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 39111))
        s.listen(1)
        _inst_lock = s
    except OSError:
        show_error_box("控制面板已经在运行了（检测到单实例端口被占用）。\n\n如果确认没有运行，请先结束名为 pythonw 的进程再试。")
        sys.exit(0)


# ── 安全重定向标准流(pythonw 下为 None) ────────────────────────
def ensure_streams():
    try:
        logf = open(os.path.join(PROJ, "panel.log"), "a", encoding="utf-8")
    except Exception:
        logf = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = logf
    if sys.stderr is None:
        sys.stderr = logf
    if sys.stdin is None:
        sys.stdin = open(os.devnull, "r", encoding="utf-8")


# ── 颜色主题(明亮浅色) ──────────────────────────────────────────
BG      = "#f4f6fb"
CARD    = "#ffffff"
TXT     = "#1f2937"
SUB     = "#6b7280"
BORDER  = "#e5e7eb"
GREEN   = "#16a34a"
GREEN_H = "#15803d"
RED     = "#dc2626"
RED_H   = "#b91c1c"
BLUE    = "#2563eb"
BLUE_H  = "#1d4ed8"
PURPLE  = "#7c3aed"
PURPLE_H= "#6d28d9"
GRAY    = "#6b7280"
GRAY_H  = "#4b5563"
LOG_BG  = "#f8fafc"
LOG_TXT = "#0f172a"


def fmt_uptime(sec):
    if sec <= 0:
        return "0s"
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    if h:
        return "%dh %dm %ds" % (h, m, s)
    if m:
        return "%dm %ds" % (m, s)
    return "%ds" % s


# ── 主界面 ──────────────────────────────────────────────────────
class Panel(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("网盘中转台 · 服务控制")
        self.configure(bg=BG)
        self.geometry("480x600")
        self.minsize(440, 520)
        self.busy = False
        self._build()
        self.poll()
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def _btn(self, parent, text, color, hover, cmd):
        b = tk.Button(
            parent, text=text, command=cmd,
            bg=color, fg="white", activebackground=hover, activeforeground="white",
            font=("Segoe UI", 11, "bold"), relief="flat",
            bd=0, cursor="hand2", padx=6, pady=10,
        )
        return b

    def _build(self):
        # 标题栏
        hdr = tk.Frame(self, bg=BG)
        hdr.pack(fill="x", padx=18, pady=(16, 6))
        tk.Label(hdr, text="网盘中转台", bg=BG, fg=TXT,
                 font=("Segoe UI", 17, "bold")).pack(side="left")
        tk.Label(hdr, text="服务控制面板", bg=BG, fg=SUB,
                 font=("Segoe UI", 11)).pack(side="left", padx=(8, 0))

        # 状态卡
        card = tk.Frame(self, bg=CARD, highlightbackground=BORDER,
                        highlightthickness=1)
        card.pack(fill="x", padx=18, pady=(4, 10))
        inner = tk.Frame(card, bg=CARD)
        inner.pack(fill="x", padx=16, pady=14)
        self.dot = tk.Label(inner, text="●", bg=CARD, fg=GRAY,
                            font=("Segoe UI", 14))
        self.dot.pack(side="left", padx=(0, 8))
        info = tk.Frame(inner, bg=CARD)
        info.pack(side="left", fill="x", expand=True)
        self.state_lbl = tk.Label(info, text="检测中…", bg=CARD, fg=TXT,
                                  font=("Segoe UI", 13, "bold"), anchor="w")
        self.state_lbl.pack(fill="x")
        self.detail_lbl = tk.Label(info, text="", bg=CARD, fg=SUB,
                                   font=("Segoe UI", 10), anchor="w")
        self.detail_lbl.pack(fill="x")

        # 按钮区
        btns = tk.Frame(self, bg=BG)
        btns.pack(fill="x", padx=18, pady=(0, 6))
        # 第一行: 启动/停止/重启
        row1 = tk.Frame(btns, bg=BG)
        row1.pack(fill="x")
        self.b_start = self._btn(row1, "启动", GREEN, GREEN_H, self.on_start)
        self.b_stop  = self._btn(row1, "停止", RED, RED_H, self.on_stop)
        self.b_rest  = self._btn(row1, "重启", BLUE, BLUE_H, self.on_restart)
        for b in (self.b_start, self.b_stop, self.b_rest):
            b.pack(side="left", fill="x", expand=True, padx=4, pady=4)
        # 第二行: 打开网页 / 退出
        row2 = tk.Frame(btns, bg=BG)
        row2.pack(fill="x")
        self.b_web = self._btn(row2, "打开网页", PURPLE, PURPLE_H, self.on_open)
        self.b_exit = self._btn(row2, "退出", GRAY, GRAY_H, self.on_close)
        for b in (self.b_web, self.b_exit):
            b.pack(side="left", fill="x", expand=True, padx=4, pady=4)

        # 日志区
        tk.Label(self, text="运行日志", bg=BG, fg=TXT,
                 font=("Segoe UI", 11, "bold"), anchor="w"
                 ).pack(fill="x", padx=18, pady=(8, 2))
        log_card = tk.Frame(self, bg=CARD, highlightbackground=BORDER,
                            highlightthickness=1)
        log_card.pack(fill="both", expand=True, padx=18, pady=(0, 14))
        self.logbox = scrolledtext.ScrolledText(
            log_card, bg=LOG_BG, fg=LOG_TXT,
            font=("Consolas", "10"), relief="flat", bd=0,
            wrap="word", state="disabled", padx=10, pady=8,
        )
        self.logbox.pack(fill="both", expand=True, padx=2, pady=2)

    # ── 日志 ──
    def log(self, msg, cls=""):
        def _append():
            self.logbox.configure(state="normal")
            self.logbox.insert("end", msg + "\n")
            self.logbox.configure(state="disabled")
            self.logbox.see("end")
        self.after(0, _append)

    # ── 状态刷新(后台线程轮询, 不阻塞主线程/不闪黑窗) ──
    def poll(self):
        threading.Thread(target=self._poll_worker, daemon=True).start()

    def _poll_worker(self):
        pid, st = find_pid()
        uptime = int(time.time() - start_ts) if (start_ts and st == "running") else 0
        self.after(0, lambda: self._render_status(pid, st, uptime))
        self.after(2500, self.poll)

    def _render_status(self, pid, st, uptime):
        if st == "running":
            self.dot.configure(fg=GREEN)
            self.state_lbl.configure(text="● 运行中", fg=GREEN)
            self.detail_lbl.configure(
                text="PID %s · 已运行 %s · http://localhost:%d" % (pid, fmt_uptime(uptime), PORT))
        elif st == "other":
            self.dot.configure(fg=RED)
            self.state_lbl.configure(text="● 端口被占用", fg=RED)
            self.detail_lbl.configure(text="PID %s 占用了 %d" % (pid, PORT))
        else:
            self.dot.configure(fg=GRAY)
            self.state_lbl.configure(text="○ 已停止", fg=SUB)
            self.detail_lbl.configure(text="点击「启动」开始服务")

    # ── 操作 ──
    def _set_busy(self, on):
        self.busy = on
        for b in (self.b_start, self.b_stop, self.b_rest, self.b_web, self.b_exit):
            b.configure(state="disabled" if on else "normal")

    def on_start(self):
        if self.busy:
            return
        self._set_busy(True)
        self.log("正在启动服务…")
        threading.Thread(target=self._run, args=(start_server,), daemon=True).start()

    def on_stop(self):
        if self.busy:
            return
        self._set_busy(True)
        self.log("正在停止服务…")
        threading.Thread(target=self._run, args=(stop_server,), daemon=True).start()

    def on_restart(self):
        if self.busy:
            return
        self._set_busy(True)
        self.log("正在重启服务…")
        threading.Thread(target=self._run, args=(restart_server,), daemon=True).start()

    def _run(self, fn):
        fn(self)
        self.after(0, lambda: self._set_busy(False))

    def on_open(self):
        open_web()
        self.log("已在浏览器打开 http://localhost:%d" % PORT)

    def on_close(self):
        pid, st = find_pid()
        if st == "running":
            from tkinter import messagebox
            ans = messagebox.askyesnocancel(
                "退出控制面板",
                "服务正在运行中。\n\n「是」 = 停止服务并退出\n"
                "「否」 = 仅关闭面板(服务在后台继续运行)\n"
                "「取消」 = 不退出",
            )
            if ans is None:
                return                      # 取消:不退出
            if ans:
                self.log("正在停止服务…")
                threading.Thread(target=self._stop_and_exit, daemon=True).start()
                return
        self.destroy()

    def _stop_and_exit(self):
        stop_server(self)
        self.after(0, self.destroy)


def show_error_box(msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, str(msg), "控制面板启动失败", 0x10)
    except Exception:
        pass
    try:
        with open(os.path.join(PROJ, "panel.log"), "a", encoding="utf-8") as f:
            f.write("\n[ERROR] %s\n" % msg)
    except Exception:
        pass


def main():
    global want_running
    ensure_streams()
    try:
        guard_single_instance()
        # 若服务已在运行(面板启动前就开着), 标记为「期望运行」, 看门狗负责维持
        _, st0 = find_pid()
        if st0 == "running":
            want_running = True
        # 启动看门狗: node 崩溃时自动拉起(独立守护线程, 不阻塞 UI)
        threading.Thread(target=watchdog, daemon=True).start()
        app = Panel()
        app.log("面板已就绪")
        app.mainloop()
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        show_error_box("控制面板启动失败:\n\n%s" % tb)


if __name__ == "__main__":
    # 若以控制台方式运行(被 python 而非 pythonw 启动,会带一个黑窗),
    # 自动用 pythonw 重新拉起自己消除黑窗。pythonw 下 sys.stdout 为 None,不会重复触发。
    if sys.stdout is not None:
        import shutil
        pw = shutil.which("pythonw") or shutil.which("pythonw.exe")
        if pw:
            try:
                subprocess.Popen([pw, os.path.abspath(__file__)])
                sys.exit(0)
            except Exception:
                pass
    main()
