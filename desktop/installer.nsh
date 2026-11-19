; MiniDSH's NSIS hooks (electron-builder `nsis.include`).
;
; electron-builder's default check TerminateProcess-es every process running
; from the install directory before it installs or uninstalls. For MiniDSH
; that would hard-kill the runtime (`resources\node\node.exe`): every live
; turn left unfinished, every session lease left behind. So the installer and
; the uninstaller REFUSE instead, naming what to do; a silent run exits 2.
; (Measured in S22.2's spike: install and uninstall both refused while the
; app ran, and the app lived.)
!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "MINIDSH_INSTDIR", t "$INSTDIR")'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$d = [IO.Path]::GetFullPath($$env:MINIDSH_INSTDIR).TrimEnd([char]92) + [char]92; if (@(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { exit 3 } else { exit 0 }"'
  Pop $0
  Pop $1
  ${if} $0 == 3
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} is running. Quit it (File > Quit), then run this again."
    ${endIf}
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend
