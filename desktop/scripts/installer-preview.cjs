'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {version}=require('../package.json');
const scenario=process.argv.find(value=>value.startsWith('--scenario='))?.split('=')[1] || 'normal';
if(!['normal','reboot','failure','cancel'].includes(scenario))throw Error('Unknown preview scenario');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'output','installer-preview',scenario);
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
ShowInstDetails hide
Function .onInit
  StrCpy $LANGUAGE 2052
  StrCpy $runtimeNeedsReboot "${scenario==='reboot'?'1':'0'}"
FunctionEnd
Section
  DetailPrint "界面验收，不复制软件、不写注册表、不安装运行库。"
  Sleep 2200
  SendMessage $mui.InstFilesPage.ProgressBar 0x402 45 0
  SendMessage $mui.InstFilesPage.Text 0xC 0 "STR:准备 Microsoft 运行环境"
  Sleep 2200
  ${scenario==='failure'?'Abort "界面验收：模拟运行环境安装失败"':''}
SectionEnd
`;
const file=path.join(output,'preview.nsi');fs.writeFileSync(file,source,'utf8');
require('./nsis-toolchain.cjs').nsisToolchain().then(tool=>{
  execFileSync(tool.path,['/INPUTCHARSET','UTF8',file],{cwd:output,stdio:'inherit',windowsHide:true,env:{...process.env,...tool.env}});
  console.log(path.join(output,'InstallerPreview.exe'));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
