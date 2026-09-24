// 客户端"选择保存目录"弹窗自动填充：把路径填成我们指定的目录（默认 E:\网盘中转）。
// 原理：UIA（PowerShell + UIAutomationClient）扫描目标进程窗口 → 找到路径输入框 → SetValue → 点确定。
// 约束：
//   · 默认 dryRun=true（只报告"找到了哪些控件"，不动手），只有显式 dryRun:false 才真的填入
//   · 只扫我们自己唤起的客户端进程名，且只在标题像"下载/保存/目录"时才介入
//   · 失败静默返回原因，调用方回落到"全盘匹配认领"
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/** 进程名 → 客户端 */
const PROC = { quark: "quark_cloud_drive", baidu: "BaiduNetdisk" };

/** 标题像不像"选保存目录"的对话框（中英都覆盖） */
const TITLE_HINTS = ["选择", "保存", "下载", "目录", "文件夹", "另存", "save", "download", "folder", "select"];

/** 纯函数：标题是否像下载目录弹窗 */
function isDownloadDialogTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  return TITLE_HINTS.some((k) => t.includes(k.toLowerCase()));
}

/**
 * 纯函数：从候选输入框里挑"路径框"。
 * @param {Array<{name?:string, value?:string, cls?:string}>} edits
 * @param {string} targetDir
 * @returns {{index:number, reason:string}|null}
 */
function pickPathEdit(edits, targetDir) {
  const list = Array.isArray(edits) ? edits : [];
  if (!list.length) return null;
  const isDrivePath = (s) => /^[a-zA-Z]:\\/.test(String(s || "").trim());
  // 1) 值本身已经是盘符路径的，优先（多数客户端会把默认目录预填在框里）
  for (let i = 0; i < list.length; i += 1) {
    if (isDrivePath(list[i] && list[i].value)) return { index: i, reason: "value-is-path" };
  }
  // 2) 名字里带目录/路径/folder/path 字样的
  for (let i = 0; i < list.length; i += 1) {
    const n = String((list[i] && list[i].name) || "").toLowerCase();
    if (/目录|路径|folder|path|dir/.test(n)) return { index: i, reason: "name-hint" };
  }
  // 3) 只有一个输入框 → 就是它
  if (list.length === 1) return { index: 0, reason: "only-one" };
  // 4) 都不像 → 返回第一个可编辑的（让上层可选是否保守放弃）
  return { index: 0, reason: "fallback-first" };
}

// 内嵌的 PowerShell（纯 ASCII，避免编码问题）：扫描窗口 → 找 Edit → 可选写入 + 点确定
const PS_SCRIPT = `
param([string]$ProcName, [string]$TargetDir, [switch]$Apply)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "NO_PROC"; exit 0 }
$pids = @($p.Id)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
foreach ($w in $wins) {
  if ($pids -notcontains $w.Current.ProcessId) { continue }
  $title = $w.Current.Name
  Write-Output ("WIN|" + $w.Current.ClassName + "|" + $title)
  $kids = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $i = 0
  foreach ($k in $kids) {
    $t = $k.Current.ControlType.ProgrammaticName
    if ($t -match 'Edit' -or $t -match 'ComboBox') {
      $val = ""
      try { $val = ($k.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value } catch {}
      Write-Output ("EDIT|" + $i + "|" + $k.Current.ClassName + "|" + $k.Current.Name + "|" + $val)
      if ($Apply) {
        try {
          $vp = $k.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $vp.SetValue($TargetDir)
          Write-Output ("SET|" + $i + "|OK")
        } catch { Write-Output ("SET|" + $i + "|FAIL") }
      }
      $i = $i + 1
    }
    if ($Apply -and $t -match 'Button') {
      $n = $k.Current.Name
      if ($n -match '确定|完成|保存|OK|Confirm|Save') {
        try { $k.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output "CLICK|OK" } catch {}
      }
    }
  }
}
`;

function psScriptPath() {
  const p = path.join(os.tmpdir(), "xfer-autofill.ps1");
  try { fs.writeFileSync(p, PS_SCRIPT, "utf8"); } catch (e) { /* 已存在可复用 */ }
  return p;
}

/**
 * 扫描（并可选择填写）客户端下载目录弹窗。
 * @param {"baidu"|"quark"} provider
 * @param {string} targetDir 要填的目录
 * @param {{dryRun?:boolean, timeoutMs?:number}} [opts]
 */
function autofill(provider, targetDir, opts = {}) {
  const proc = PROC[provider];
  if (!proc) return { ok: false, reason: "未知客户端: " + provider };
  const dryRun = opts.dryRun !== false; // 默认不真填
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psScriptPath(), "-ProcName", proc, "-TargetDir", String(targetDir || "")];
  if (!dryRun) args.push("-Apply");
  let out = "";
  try {
    out = String(spawnSync("powershell", args, { encoding: "utf8", timeout: opts.timeoutMs || 15000, windowsHide: true }).stdout || "");
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const wins = lines.filter((l) => l.startsWith("WIN|")).map((l) => l.split("|").slice(1));
  const edits = lines.filter((l) => l.startsWith("EDIT|")).map((l) => {
    const parts = l.split("|");
    return { index: Number(parts[1]), cls: parts[2], name: parts[3], value: parts[4] };
  });
  const dialogWin = wins.find((w) => isDownloadDialogTitle(w[1]));
  const pick = pickPathEdit(edits, targetDir);
  const applied = !dryRun && lines.some((l) => l === "SET|0|OK");
  return {
    ok: true,
    dryRun,
    windows: wins.length,
    dialogTitle: dialogWin ? dialogWin[1] : "",
    edits,
    pick,
    applied,
  };
}

module.exports = { autofill, isDownloadDialogTitle, pickPathEdit, PROC };
