'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'output','installer-preview');
fs.mkdirSync(output,{recursive:true});
const cache=path.join(process.env.LOCALAPPDATA,'electron-builder','Cache','nsis','nsis-3.0.4.1');
const executable=path.join(cache,'makensis.exe');
const source=`Unicode true
Name "热处理数字孪生大屏 · 安装界面验收"
OutFile "${path.join(output,'InstallerPreview.exe')}"
BrandingText "热处理数字孪生大屏 2.3.2"
RequestExecutionLevel user
InstallDir "$TEMP\\HeatTreatmentInstallerPreview"
!include "LogicLib.nsh"
!define PRODUCT_NAME "热处理数字孪生大屏"
!define VERSION "2.3.2"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${path.join(root,'desktop','assets','installer-sidebar.bmp')}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${path.join(root,'desktop','assets','installer-header.bmp')}"
!addincludedir "${path.join(root,'desktop','node_modules','app-builder-lib','templates','nsis','include')}"
!include "${path.join(root,'desktop','display-installer.nsh')}"
!insertmacro customWelcomePage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  DetailPrint "界面验收，不复制软件、不写注册表、不安装运行库。"
SectionEnd
`;
const file=path.join(output,'preview.nsi');fs.writeFileSync(file,source,'utf8');
execFileSync(executable,['/INPUTCHARSET','UTF8',file],{cwd:output,stdio:'inherit',windowsHide:true});
console.log(path.join(output,'InstallerPreview.exe'));
