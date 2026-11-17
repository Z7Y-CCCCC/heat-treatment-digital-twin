'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {version}=require('../package.json');
execFileSync(process.execPath,[path.join(__dirname,'create-installer-ui.cjs')],{windowsHide:true,stdio:'inherit'});
require('./build-installer-window-chrome.cjs').buildInstallerChrome();
const scenario=process.argv.find(value=>value.startsWith('--scenario='))?.split('=')[1] || 'normal';
if(!['normal','reboot','failure','cancel','progress-cancel'].includes(scenario))throw Error('Unknown preview scenario');
const root=path.resolve(__dirname,'../..'),output=process.env.INSTALLER_PREVIEW_DIR
  ? path.resolve(process.env.INSTALLER_PREVIEW_DIR,scenario) : path.join(root,'output','installer-preview',scenario);
fs.mkdirSync(output,{recursive:true});
const source=`Unicode true
Name "热处理数字孪生大屏"
Caption "热处理数字孪生大屏安装 · 预览"
OutFile "${path.join(output,'InstallerPreview.exe')}"
BrandingText "热处理数字孪生大屏 ${version}"
RequestExecutionLevel user
Icon "${path.join(root,'desktop','assets','icon.ico')}"
InstallDir "$PROGRAMFILES64\\热处理数字孪生大屏"
!include "LogicLib.nsh"
!define PRODUCT_NAME "热处理数字孪生大屏"
!define VERSION "${version}"
!define DISPLAY_UI_PREVIEW
!define MUI_ICON "${path.join(root,'desktop','assets','icon.ico')}"
!addincludedir "${path.join(root,'desktop','node_modules','app-builder-lib','templates','nsis','include')}"
!include "${path.join(root,'desktop','display-installer.nsh')}"
!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro customHeader
ShowInstDetails show
Function .onInit
  StrCpy $LANGUAGE 2052
  Call CollectorChoiceInit
  StrCpy $runtimeNeedsReboot "${scenario==='reboot'?'1':'0'}"
FunctionEnd
Section
  ; Reproduce electron-builder's real section reset: the worker hook must undo it.
  SetDetailsPrint none
  !insertmacro DisplayStage "检查升级条件（隔离验收）"
  DetailPrint "界面验收，不复制软件、不写注册表、不安装运行库。"
  Sleep 5000
  Call DisplayCheckCancel
  SendMessage $mui.InstFilesPage.ProgressBar 0x402 45 0
  !insertmacro DisplayStage "准备 Microsoft 运行环境（隔离验收）"
  Sleep ${scenario==='progress-cancel'?'20000':'5000'}
  Call DisplayCheckCancel
  ${scenario==='failure'?`nsExec::ExecToLog /TIMEOUT=5000 '\"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("[Console]::OutputEncoding=[Text.Encoding]::Unicode;[Console]::Write([char]0xFEFF);[Console]::WriteLine('运行环境输出：中文错误详情不会丢失');exit 1603",'utf16le').toString('base64')}'
  Pop $0
  !insertmacro DisplayAbort "界面验收：模拟运行环境安装失败（错误码 $0 / 1603）"`:''}
SectionEnd
`;
const file=path.join(output,'preview.nsi');fs.writeFileSync(file,source,'utf8');
require('./nsis-toolchain.cjs').nsisToolchain().then(tool=>{
  execFileSync(tool.path,['/INPUTCHARSET','UTF8',file],{cwd:output,stdio:'inherit',windowsHide:true,env:{...process.env,...tool.env}});
  console.log(path.join(output,'InstallerPreview.exe'));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
