; EAB Desktop Windows 安装器
; 构建脚本会先写 installer/generated/build.nsh，再调用 NSIS 编译。
; 安装：欢迎 -> 选择安装位置 -> 安装进度 -> 完成并启动
; 卸载：欢迎 -> 卸载选项 -> 确认 -> 卸载进度 -> 完成

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
RequestExecutionLevel admin
ManifestDPIAware true
BrandingText "EAB 企业智能体基座"
ShowInstDetails nevershow
ShowUninstDetails nevershow

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"
!include "nsDialogs.nsh"
!include "generated\build.nsh"

!define PRODUCT_NAME "EAB 企业智能体基座"
!define PRODUCT_SHORT "EAB"
!define PRODUCT_PUBLISHER "重庆居易智能科技有限公司"
!define PRODUCT_WEB_SITE "http://127.0.0.1:8787"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\EAB"
!define APP_KEY "Software\EAB"

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\EAB"
InstallDirRegKey HKLM "${APP_KEY}" "InstallDir"

VIProductVersion "${PRODUCT_VERSION_4}"
VIFileVersion "${PRODUCT_VERSION_4}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "EAB Windows 桌面客户端安装程序"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright EAB"

!define MUI_ICON "${__FILEDIR__}\assets\eab.ico"
!define MUI_UNICON "${__FILEDIR__}\assets\eab.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\assets\wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\assets\wizard.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${__FILEDIR__}\assets\header.bmp"
!define MUI_HEADERIMAGE_RIGHT

!define MUI_WELCOMEPAGE_TITLE "安装 EAB 桌面版"
!define MUI_WELCOMEPAGE_TEXT "EAB 桌面版是访问公司 EAB 服务的 Windows 客户端，和网页版共用会话与业务数据。$\r$\n$\r$\n安装包只安装客户端，不会在本机复制数据库或启动新的服务端。安装需要管理员权限。$\r$\n$\r$\n默认安装到 Program Files\EAB，下一步可以修改安装位置。"

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 EAB 的安装位置。默认安装到 Program Files\EAB；点“浏览”可以改到其他目录。$\r$\n$\r$\n安装信息会写入 Windows“应用和功能”，之后可从“设置 > 应用 > 已安装的应用”卸载。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装到："

!define MUI_FINISHPAGE_TITLE "EAB 安装完成"
!define MUI_FINISHPAGE_TEXT "EAB 桌面版已安装到：$INSTDIR$\r$\n$\r$\n安装包会记住这次下载来源的 EAB 服务器，首次启动自动连接；如果浏览器没有留下来源信息，也可以在首次启动页手动填写地址。$\r$\n$\r$\n卸载入口：Windows 设置 > 应用 > 已安装的应用 > EAB 企业智能体基座。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\EAB.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 EAB"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!define MUI_UNWELCOMEPAGE_TITLE "卸载 EAB 桌面版"
!define MUI_UNWELCOMEPAGE_TEXT "卸载会删除 EAB 程序文件、开始菜单和桌面快捷方式，并移除“应用与功能”中的卸载项。$\r$\n$\r$\n登录状态和服务地址默认保留在 %APPDATA%\EAB；如果不再使用这台电脑，可以在下一页勾选一并删除。"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "即将从以下位置卸载 EAB："
!define MUI_UNCONFIRMPAGE_TEXT_LOCATION "卸载位置："
!define MUI_UNFINISHPAGE_TITLE "EAB 已卸载"
!define MUI_UNFINISHPAGE_TEXT "EAB 桌面版已从这台电脑移除。$\r$\n$\r$\n如果保留了登录状态和服务地址，重新安装后可以直接沿用；需要彻底清理时请手动删除 %APPDATA%\EAB。"
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

!insertmacro MUI_UNPAGE_WELCOME
UninstPage custom un.OptionsPageCreate un.OptionsPageLeave
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

Var RemoveUserData
Var OptionsCheckbox
Var DetectedServerUrl

Function .onInit
  SetRegView 64
  SetShellVarContext all
FunctionEnd

Function .onVerifyInstDir
  ; 防止用户把安装目录选到系统根目录或 Program Files 本身，卸载时误删整层目录。
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == ""
  ${OrIf} $INSTDIR == "$0"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64\"
  ${OrIf} $INSTDIR == "$PROGRAMFILES\"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$WINDIR\"
    MessageBox MB_ICONEXCLAMATION|MB_OK "请选择一个新的子目录，例如 D:\Apps\EAB。不能直接安装到系统目录或 Program Files 根目录。"
    Abort
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  StrCpy $RemoveUserData "0"
FunctionEnd

Function un.OptionsPageCreate
  !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否同时清理本机登录状态和服务地址。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 0 100% 14u "同时删除本机登录状态和服务地址（%APPDATA%\EAB）"
  Pop $OptionsCheckbox
  ${NSD_CreateLabel} 0 26u 100% 48u "不勾选时只删除程序文件，保留登录状态和服务地址，重新安装后可以直接沿用。$\r$\n勾选后，这台 Windows 用户下的 EAB 配置、缓存和网页登录状态都会被删除，且不可恢复。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function un.OptionsPageLeave
  ${NSD_GetState} $OptionsCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RemoveUserData "1"
  ${EndIf}
FunctionEnd

Section "EAB Desktop" SecMain
  ; 升级安装时先关闭正在运行的客户端，避免 Electron 文件被占用。
  nsExec::ExecToLog 'taskkill /IM EAB.exe /F /T'
  Sleep 500

  ; 安装器自身下载来源可能是浏览器写入的 Zone.Identifier：
  ; 读取 HostUrl/ReferrerUrl，推导出对应的 EAB 服务器 origin，并写入应用默认配置。
  SetOutPath "$TEMP"
  File /oname=eab-detect-server-url.ps1 "${__FILEDIR__}\scripts\detect-server-url.ps1"
  SetOutPath "$INSTDIR"
  StrCpy $DetectedServerUrl "${SERVER_URL}"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\eab-detect-server-url.ps1" "$EXEPATH"'
  Pop $0
  Pop $1
  ${TrimNewLines} "$1" $1
  ${If} $1 != ""
    StrCpy $DetectedServerUrl $1
  ${EndIf}
  Delete "$TEMP\eab-detect-server-url.ps1"

  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"

  ; 快捷方式和“应用和功能”需要一个稳定的图标路径。
  ; 之前只写了 $INSTDIR\assets\eab.ico，但安装包实际没有释放该目录，Windows 只能回退到无图标的 EAB.exe。
  CreateDirectory "$INSTDIR\assets"
  SetOutPath "$INSTDIR\assets"
  File "${__FILEDIR__}\assets\eab.ico"
  SetOutPath "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 安装标记，卸载阶段据此确认这个目录确实是 EAB 安装目录。
  FileOpen $0 "$INSTDIR\.eab-install" w
  FileWrite $0 "${PRODUCT_VERSION}"
  FileClose $0

  ; 桌面应用运行在 $INSTDIR\resources\app，默认配置必须写到这个目录才能被首次启动读取。
  ${If} $DetectedServerUrl != ""
    FileOpen $0 "$INSTDIR\resources\app\desktop-config.json" w
    FileWrite $0 '{"serverUrl":"'
    FileWrite $0 $DetectedServerUrl
    FileWrite $0 '","source":"installer","updatedAt":"'
    FileWrite $0 "${PRODUCT_VERSION}"
    FileWrite $0 '"}'
    FileClose $0
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\EAB"
  CreateShortcut "$SMPROGRAMS\EAB\EAB.lnk" "$INSTDIR\EAB.exe" "" "$INSTDIR\assets\eab.ico" 0
  CreateShortcut "$DESKTOP\EAB.lnk" "$INSTDIR\EAB.exe" "" "$INSTDIR\assets\eab.ico" 0

  WriteRegStr HKLM "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${APP_KEY}" "Version" "${PRODUCT_VERSION}"

  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\assets\eab.ico"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /IM EAB.exe /F /T'
  Sleep 500

  Delete "$DESKTOP\EAB.lnk"
  Delete "$SMPROGRAMS\EAB\EAB.lnk"
  RMDir "$SMPROGRAMS\EAB"

  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKLM "${APP_KEY}"

  ${If} $RemoveUserData == "1"
    RMDir /r "$APPDATA\EAB"
  ${EndIf}

  Delete "$INSTDIR\Uninstall.exe"
  ; 只有存在安装标记且路径足够长时才递归删除，避免误删用户目录或盘根。
  StrLen $0 "$INSTDIR"
  ${If} $0 > 3
    IfFileExists "$INSTDIR\.eab-install" 0 eab_uninstall_skip_dir
      RMDir /r "$INSTDIR"
    eab_uninstall_skip_dir:
  ${EndIf}
SectionEnd
