'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
function buildInstallerChrome({test=false}={}) {
 if(process.platform!=='win32')throw Error('Build installer chrome on Windows');
 const vswhere=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
 const vs=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{windowsHide:true,encoding:'utf8'}).trim();
 if(!vs)throw Error('The installer requires the MSVC x86 build tools');
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'dt-installer-chrome-')),output=path.join(root,'desktop/.cache/installer-window-chrome');
 fs.mkdirSync(output,{recursive:true});
 const quote=s=>{if(/["\r\n]/.test(s))throw Error('Unsafe compiler path');return '"'+s+'"';};
 // Compile copied ASCII-named inputs: cmd.exe's current code page must never
 // reinterpret the operator's Chinese workspace path in a native command.
 const source=path.join(stage,'chrome.c'),def=path.join(stage,'chrome.def'),dll=path.join(stage,'InstallerWindowChrome.dll');
 fs.copyFileSync(path.join(root,'desktop/installer-window-chrome.c'),source);
 fs.copyFileSync(path.join(root,'desktop/installer-window-chrome.def'),def);
 fs.copyFileSync(path.join(root,'desktop/installer-window-chrome-policy.h'),path.join(stage,'installer-window-chrome-policy.h'));
 const policy='#include "installer-window-chrome-policy.h"\nint main(void){unsigned dpi[]={96,120,144,192};int i;for(i=0;i<4;i++){int w=ChromeScale(800,dpi[i]),size=ChromeScale(32,dpi[i]);if(ChromeCloseLeft(w,dpi[i])+size!=w)return 1;if(ChromeScale(24,dpi[i])<24)return 2;}if(!ChromeCaptionHit(-700,40,-800,0,0,500,1,-32,0,0,32))return 3;if(ChromeCaptionHit(-10,10,-800,0,0,500,1,-32,0,0,32))return 4;if(ChromeCaptionHit(2,510,0,0,800,500,0,0,0,0,0))return 5;return 0;}\n';
 fs.writeFileSync(path.join(stage,'policy-test.c'),policy);
 const testCommand=test?'if errorlevel 1 exit /b 1\r\ncl.exe /nologo /TC /MT policy-test.c /Fe:policy-test.exe\r\nif errorlevel 1 exit /b 1\r\npolicy-test.exe\r\n':'';
 const command='@echo off\r\ncall '+quote(path.join(vs,'VC/Auxiliary/Build/vcvars32.bat'))+' >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe /nologo /utf-8 /TC /LD /O2 /GS- /Zl /DUNICODE /D_UNICODE '+quote(source)+' /Fo'+quote(path.join(stage,'chrome.obj'))+' /link /DLL /NOENTRY /NODEFAULTLIB /MACHINE:X86 /DEF:'+quote(def)+' /OUT:'+quote(dll)+' user32.lib gdi32.lib comctl32.lib kernel32.lib\r\n'+testCommand+'exit /b %errorlevel%\r\n';
 const script=path.join(stage,'build.cmd');fs.writeFileSync(script,command,'utf8');
 execFileSync(process.env.ComSpec||'cmd.exe',['/d','/c',script],{cwd:stage,windowsHide:true,stdio:'pipe'});
 const bytes=fs.readFileSync(dll),pe=bytes.readUInt32LE(0x3c);
 if(bytes.readUInt16LE(pe+4)!==0x14c||bytes.readUInt32LE(pe+24+16)!==0||!(bytes.readUInt16LE(pe+22)&0x2000))throw Error('Expected an entrypoint-free x86 installer DLL');
 const target=path.join(output,'InstallerWindowChrome.dll');fs.copyFileSync(dll,target);
 return target;
}
if(require.main===module)console.log(buildInstallerChrome());
module.exports={buildInstallerChrome};
