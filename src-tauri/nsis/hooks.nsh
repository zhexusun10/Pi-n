; Pi^n Windows NSIS installer hooks.
;
; 1. Terminate only the backend inside this installation's `runtime/`, then
;    remove stale bundled `runtime/`
;    and `node/` directories before extracting the new version so deleted files
;    from older Pi baselines cannot survive an in-place upgrade and fail
;    `.pi-n-bundled-manifest.json` verification.
; 2. Notify Windows Explorer to refresh its shell icon cache after install or
;    upgrade so updated application icons appear immediately.

!include "LogicLib.nsh"
; Resolve the helper relative to this include at compile time, before the
; preinstall macro is expanded from Tauri's generated installer script.
!define PI_N_STOP_RUNTIME_SCRIPT "${__FILEDIR__}\stop-installation-runtime.ps1"

!macro PI_N_REQUIRE_DIRECTORY_REMOVED directory
  ${If} ${FileExists} "${directory}\*.*"
    MessageBox MB_OK|MB_ICONSTOP "Cannot replace Pi^n's bundled runtime. Close this installation and retry. No other Pi^n installations will be stopped." /SD IDOK
    Pop $1
    Pop $0
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\pi-n-stop-runtime.ps1 "${PI_N_STOP_RUNTIME_SCRIPT}"
  ; -File receives the directory as data, including spaces, apostrophes and &.
  ; The trailing \. also makes a drive-root directory safe in Windows argv.
  nsExec::ExecToStack /TIMEOUT=20000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pi-n-stop-runtime.ps1" -InstallDirectory "$INSTDIR\."'
  Pop $0
  Pop $1
  Delete "$PLUGINSDIR\pi-n-stop-runtime.ps1"
  ${If} $0 != 0
    DetailPrint "Pi^n runtime cleanup failed ($0): $1"
    MessageBox MB_OK|MB_ICONSTOP "Cannot stop this installation's old Pi^n runtime. Close it and retry. No other Pi^n installations will be stopped." /SD IDOK
    Pop $1
    Pop $0
    SetErrorLevel 1
    Abort
  ${EndIf}
  RMDir /r "$INSTDIR\runtime"
  !insertmacro PI_N_REQUIRE_DIRECTORY_REMOVED "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\node"
  !insertmacro PI_N_REQUIRE_DIRECTORY_REMOVED "$INSTDIR\node"
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32.dll::SHChangeNotify(l, l, i, i) v (0x08000000, 0, 0, 0)'
!macroend
