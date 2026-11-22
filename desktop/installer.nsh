; MiniDSH's NSIS hooks (electron-builder `nsis.include`).
;
; electron-builder's default check TerminateProcess-es every process running
; from the install directory before it installs or uninstalls. For MiniDSH
; that would hard-kill the runtime (`resources\node\node.exe`): every live
; turn left unfinished, every session lease left behind. So the installer and
; the uninstaller REFUSE instead, naming what to do; a silent run exits 2.
; (Measured in S22.2's spike: install and uninstall both refused while the
; app ran, and the app lived.)
;
; This macro REPLACES electron-builder's check, so it is the only one there
; is, and it must be right when it cannot be made as well as when it can:
;
;   1. The exact check, in Windows PowerShell: is any process running from
;      the install directory? It excludes this installer's own process (an
;      uninstaller run in place, `_?=`, lives in that directory and would
;      otherwise refuse itself). It answers with two codes of its own, 3 for
;      "running" and 10 for "nothing is", and nothing else counts as an
;      answer: not 0, which is also what a PowerShell that never ran the
;      script can return. It first asks which language mode it is in. Under
;      Constrained Language Mode (a locked-down workplace PC) the method
;      calls below are refused, and the old script went on with half its
;      variables unset and answered "running" with nothing running: the
;      installer AND the uninstaller then refused for ever. Any error at all
;      is code 4, "could not check".
;
;   2. When that gave no answer (PowerShell blocked or missing, WMI broken,
;      a constrained language mode), the plain check electron-builder itself
;      falls back to, which needs no script: is a process of this person's
;      with the app's image name running? It is coarser both ways. It also
;      sees a second copy of MiniDSH run from another folder (which the
;      person can quit), and it cannot see a runtime whose app has already
;      gone (which ends by itself in seconds).
;
;   3. When neither could answer, go on. Refusing would leave a person on
;      such a PC unable to install or to UNINSTALL, for ever, and going on
;      kills nothing: with this macro in place nothing in the installer ends
;      a process, so the worst case is NSIS failing to replace a file that
;      is in use and saying so.
!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "MINIDSH_INSTDIR", t "$INSTDIR")'
  System::Call 'Kernel32::GetCurrentProcessId() i .r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "MINIDSH_INSTALLER_PID", t "$0")'
  ; Bounded: a broken WMI repository hangs more often than it fails. nsExec
  ; then answers "timeout", which is no answer, and step 2 decides.
  nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$ErrorActionPreference = 'Stop'; try { if ($$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 4 }; $$d = [IO.Path]::GetFullPath($$env:MINIDSH_INSTDIR).TrimEnd([char]92) + [char]92; $$self = [int]$$env:MINIDSH_INSTALLER_PID; if (@(Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$self -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { exit 3 } else { exit 10 } } catch { exit 4 }"`
  Pop $0
  Pop $1
  ${if} $0 != 3
  ${andIf} $0 != 10
    nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $0
    Pop $1
    ; findstr found a row (0): running. No row, or no answer: not known to be.
    ${if} $0 == 0
      StrCpy $0 3
    ${else}
      StrCpy $0 10
    ${endIf}
  ${endIf}
  ${if} $0 == 3
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} is running. Quit it (File > Quit), then run this again."
    ${endIf}
    SetErrorLevel 2
    Quit
  ${endIf}
!macroend
