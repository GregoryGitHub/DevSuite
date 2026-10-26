; Hooks do instalador NSIS (tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; A associação de .md vem do `fileAssociations` do tauri.conf.json, mas o template do Tauri
; registra sempre o ícone do executável e o texto "Open with Dev Suite". Aqui o ProgID
; DevSuite.Markdown ganha o ícone de arquivo Markdown (icons/files/markdown.ico) e aparece no
; "Abrir com" como "Dev Suite - Notas", com o ícone do app Notas. Tudo em SHCTX: HKCU na
; instalação por usuário (sem administrador).

!define DS_MD_PROGID "DevSuite.Markdown"
!define DS_MD_APPNAME "Dev Suite - Notas"
!define DS_SHCNE_ASSOCCHANGED 0x08000000

; CLI `devsuite` (externalBin, instalada em $INSTDIR): a pasta entra no PATH do usuário para
; scripts e agentes de IA. HKCU mesmo na instalação por máquina (é quem instala que usa).
;
; Nada de ReadRegStr/StrCpy aqui: as strings do NSIS têm no máximo 1024 caracteres
; (NSIS_MAX_STRLEN) e um PATH maior que isso volta VAZIO, o que fazia o instalador gravar só a
; pasta da CLI e apagar o resto. O PowerShell lê e grava o valor cru do registro (sem limite,
; sem expandir %VARIÁVEIS% e mantendo o tipo REG_EXPAND_SZ). Se algo falhar, o PATH fica como
; estava. A pasta vai por variável de ambiente (sem problemas de aspas); `$$` = `$` literal.
!define DS_PS_ENV "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$t='ExpandString'; if($$k.GetValueNames() -contains 'Path'){$$t=$$k.GetValueKind('Path')}; $$d=$$env:DS_CLI_DIR.TrimEnd([char]92); $$a=@($$p -split ';' | Where-Object {$$_})"

!macro DS_PATH_PS SCRIPT
  System::Call 'Kernel32::SetEnvironmentVariable(t "DS_CLI_DIR", t "$INSTDIR")'
  nsExec::Exec `"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${DS_PS_ENV}; ${SCRIPT}"`
  Pop $0
  ; HWND_BROADCAST, WM_SETTINGCHANGE: terminais novos já enxergam o PATH.
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro DS_PATH_ADD
  !insertmacro DS_PATH_PS "if(-not ($$a | Where-Object {$$_.TrimEnd([char]92) -ieq $$d})){ $$k.SetValue('Path', (($$a + $$d) -join ';'), $$t) }"
!macroend

!macro DS_PATH_REMOVE
  !insertmacro DS_PATH_PS "$$b=@($$a | Where-Object {$$_.TrimEnd([char]92) -ine $$d}); if($$b.Count -ne $$a.Count){ $$k.SetValue('Path', ($$b -join ';'), $$t) }"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Ícone dos arquivos .md quando o Dev Suite é o app padrão.
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\DefaultIcon" "" "$\"$INSTDIR\icons\markdown.ico$\",0"
  ; Selo no canto da miniatura (ícones grandes, quando há um gerador de miniaturas de .md):
  ; sem TypeOverlay o Explorer usa o ícone do executável (a grade da suíte).
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}" "TypeOverlay" "$\"$INSTDIR\icons\notes.ico$\",0"
  ; Nome e ícone no "Abrir com".
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\shell\open" "" "Abrir com ${DS_MD_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\shell\open" "FriendlyAppName" "${DS_MD_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\Application" "ApplicationName" "${DS_MD_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\Application" "ApplicationIcon" "$\"$INSTDIR\icons\notes.ico$\",0"
  WriteRegStr SHCTX "Software\Classes\${DS_MD_PROGID}\Application" "ApplicationCompany" "Dev Suite"
  ; Aparece no "Abrir com" mesmo quando outro app é o padrão.
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${DS_MD_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${DS_MD_PROGID}" ""

  ; Versão anterior registrava o ProgID genérico "Markdown": sai se for do Dev Suite (senão
  ; o "Abrir com" volta a ter duas entradas).
  ReadRegStr $0 SHCTX "Software\Classes\Markdown\shell\open\command" ""
  ${StrLoc} $1 $0 "${MAINBINARYNAME}.exe" ">"
  ${If} $1 != ""
    DeleteRegKey SHCTX "Software\Classes\Markdown"
    DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Markdown"
    DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Markdown"
    DeleteRegValue SHCTX "Software\Classes\.md" "Markdown_backup"
    DeleteRegValue SHCTX "Software\Classes\.markdown" "Markdown_backup"
  ${EndIf}

  ; O Explorer troca os ícones sem reiniciar.
  System::Call 'shell32::SHChangeNotify(i ${DS_SHCNE_ASSOCCHANGED}, i 0, p 0, p 0)'

  !insertmacro DS_PATH_ADD
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; A chave do ProgID sai pelo APP_UNASSOCIATE do template; aqui só o "Abrir com".
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "${DS_MD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${DS_MD_PROGID}"
  System::Call 'shell32::SHChangeNotify(i ${DS_SHCNE_ASSOCCHANGED}, i 0, p 0, p 0)'

  !insertmacro DS_PATH_REMOVE
!macroend
