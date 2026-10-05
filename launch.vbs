Set s = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
s.CurrentDirectory = dir
s.Run """" & dir & "\node_modules\electron\dist\electron.exe"" .", 1, False
