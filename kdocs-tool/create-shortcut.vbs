' 双击生成带图标的「启动面板.lnk」快捷方式
' 图标来源：assets/app.ico
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = WScript.CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "启动面板.bat")
icoPath = fso.BuildPath(scriptDir, "assets\app.ico")
lnkPath = fso.BuildPath(scriptDir, "启动面板.lnk")

If Not fso.FileExists(batPath) Then
    WScript.Echo "找不到启动面板.bat: " & batPath
    WScript.Quit 1
End If

If Not fso.FileExists(icoPath) Then
    WScript.Echo "找不到图标文件: " & icoPath
    WScript.Quit 1
End If

Set lnk = WshShell.CreateShortcut(lnkPath)
lnk.TargetPath = batPath
lnk.WorkingDirectory = scriptDir
lnk.IconLocation = icoPath & ",0"
lnk.Save()

WScript.Echo "已生成快捷方式: " & lnkPath & vbCrLf & "现在资源管理器里会显示自定义图标。"
