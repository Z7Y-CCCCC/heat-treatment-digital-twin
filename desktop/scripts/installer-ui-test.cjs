'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { layout, dialogResource } = require('./installer-layout.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'display-installer-ui.nsh'), 'utf8');
const hooks = fs.readFileSync(path.join(root, 'display-installer.nsh'), 'utf8');
const pkg = require('../package.json');
test('wide installer hero and stock uninstaller sidebar use their own required dimensions', () => {
  for (const [name, width, height] of [['installer-art.bmp',1024,625],['installer-sidebar.bmp',164,314]]) {
    const data=fs.readFileSync(path.join(root,'assets',name));
    assert.equal(data.readInt32LE(18),width); assert.equal(data.readInt32LE(22),height);
  }
});

test('the real NSIS package uses the custom native layout, not stock directory/sidebar pages', () => {
  assert.equal(pkg.build.nsis.include, 'display-installer.nsh');
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.installerSidebar, undefined);
  assert.equal(pkg.build.nsis.installerHeader, undefined);
  assert.match(source, /!define MUI_UI .*installer-ui\.bin/);
  assert.match(hooks, /Page custom DisplaySettingsPage DisplaySettingsLeave/);
  assert.match(hooks, /Page custom DisplayFinishPage DisplayFinishLeave/);
  assert.doesNotMatch(hooks, /MUI_PAGE_WELCOME|MUI_PAGE_DIRECTORY|DisplayReadyPage/);
  assert.doesNotMatch(source, /01\s+安装设置|242238|displayRailFont/);
});
test('the checked-in resource is source-matched, resource-only, and has no executable entry point', () => {
  const binary = fs.readFileSync(path.join(root, 'assets/installer-ui.bin'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/installer-ui.json')));
  assert.ok(binary.length < 3 * 1024 * 1024);
  assert.equal(binary.toString('ascii', 0, 2), 'MZ');
  const pe = binary.readUInt32LE(0x3c);
  assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(binary.readUInt32LE(pe + 24 + 16), 0, 'resource container must not contain an executable entry point');
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(binary).digest('hex'));
  const { sha256, ...description } = manifest;
  assert.deepEqual(description, layout);
  for (const dialog of layout.dialogs) assert.ok(binary.includes(dialogResource(dialog)), `dialog ${dialog.id} must match its editable source`);
});
test('all native controls fit the client area at 100%, 125%, 150% and 200% scale', () => {
  for (const scale of [1, 1.25, 1.5, 2]) for (const d of layout.dialogs) for (const c of d.controls) {
    assert.ok(c.x >= 0 && c.y >= 0 && c.w >= 0 && c.h >= 0);
    assert.ok(Math.round((c.x + c.w) * scale) <= Math.round(d.w * scale), `horizontal overflow: ${d.id}/${c.id}`);
    assert.ok(Math.round((c.y + c.h) * scale) <= Math.round(d.h * scale), `vertical overflow: ${d.id}/${c.id}`);
  }
  const d = layout.dialogs.find(d => d.id === 105);
  const page = d.controls.find(c => c.id === 1018), action = d.controls.find(c => c.id === 1), hero = d.controls.find(c => c.id === 1036);
  assert.ok(hero.y + hero.h < action.y && action.y + action.h < page.y, 'hero, central primary action and optional path settings must not overlap');
  assert.equal(action.x + action.w / 2, d.w / 2, 'the quick-install action is centered');
  assert.ok(d.w <= 460 && d.h <= 360, 'keep the compact illustrated wizard bounded');
});
test('primary action stays a native default pushbutton with keyboard and accessible text', () => {
  const next = layout.dialogs[0].controls.find(c => c.id === 1);
  assert.equal(next.cls, 0x80);
  assert.ok(next.style & 0x00010000, 'Tab stop');
  assert.equal(next.style & 0xf, 1, 'default pushbutton');
  assert.match(source, /BM_SETIMAGE/);
  assert.match(source, /GetWindowTextW/);
  assert.match(source, /RoundRect/);
  assert.match(source, /NSD_CreateLink.*更改/);
});
test('new Chinese paths normalize without creating folders or requiring existing files', () => {
  assert.match(source, /GetFullPathNameW\(w r0/);
  assert.doesNotMatch(source, /^\s*GetFullPathName \$0 "\$0"/m);
  assert.match(source, /PathGetDriveNumberW/);
  assert.match(source, /PathIsPrefixW.*\$WINDIR/);
  assert.match(source, /GetFileAttributesW/);
  assert.match(source, /\$PROGRAMFILES64/);
  assert.match(source, /NSD_OnChange.*DisplayPathChanged/);
  assert.doesNotMatch(source, /^\s*(CreateDirectory|WriteReg\w*|Delete|RMDir|Exec\w*)\s/m);
});
test('success, reboot and failure have different outcomes, and failure never launches the app', () => {
  assert.match(source, /SetAutoClose true/);
  assert.match(source, /Function DisplayInstallingLeave[\s\S]*安装未完成/);
  const failed = source.split('Function DisplayInstallingLeave')[1].split('FunctionEnd')[0];
  assert.doesNotMatch(failed, /StartPreparedApp|ExecShell/);
  assert.match(failed, /EnableWindow \$0 1/);
  assert.match(failed, /StrCpy \$displayActionId 2/);
  assert.match(source, /IfAbort 0 display_finish_ok[\s\S]*SetErrorLevel 2/);
  const finish = source.split('Function DisplayFinishPage')[1].split('FunctionEnd')[0];
  const reboot = finish.split('${If} $runtimeNeedsReboot == "1"')[1].split('${Else}')[0];
  assert.match(reboot, /StrCpy \$displayLaunch ""/);
  assert.doesNotMatch(reboot, /NSD_CreateCheckbox|StartPreparedApp/);
  assert.match(hooks, /\$0 == 3010/);
  assert.match(hooks, /\$0 != 0[\s\S]*Abort/);
});
test('display/collector separation, runtime repair, app-data retention and supported OS guards remain intact', () => {
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.match(hooks, /-Action Install -ProvisionDisplayLinks/);
  assert.match(hooks, /-InstallRoot "\$INSTDIR"/);
  assert.match(hooks, /\$0 < 17763/);
  assert.match(hooks, /IsNativeAMD64/);
  assert.match(hooks, /_CHECK_APP_RUNNING/);
  assert.doesNotMatch(source + hooks, /Restart-Computer|shutdown\.exe|sc\.exe|Stop-Service|New-Service/);
});
test('UI preview cannot install, register, repair dependencies or start the real app', () => {
  const preview = fs.readFileSync(path.join(__dirname, 'installer-preview.cjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(preview, /!define DISPLAY_UI_PREVIEW/);
  assert.match(preview, /RequestExecutionLevel user/);
  const section = preview.split('\nSection\n')[1].split('\nSectionEnd')[0];
  assert.doesNotMatch(section, /^\s*(File\s|WriteReg|CreateDirectory|Exec|!insertmacro customInstall)/m);
  assert.match(hooks, /!ifndef DISPLAY_UI_PREVIEW[\s\S]*ExecShellAsUser[\s\S]*!else[\s\S]*SetErrorLevel 73/);
  const harness = fs.readFileSync(path.resolve(root, '../tools/installer-preview-ui.ps1'), 'utf8');
  assert.match(harness, /Only the isolated UI fixture may run/);
  assert.match(harness, /Unsafe operations in preview source/);
});
test('Chinese and English language files cannot silently restore the old dialog font', () => {
  assert.match(hooks, /!macro customHeader[\s\S]*SetFont \/LANG=2052 "Microsoft YaHei UI" 9/);
  assert.match(hooks, /SetFont \/LANG=1033 "Microsoft YaHei UI" 9/);
  assert.equal(layout.font, 'Microsoft YaHei UI');
  for (const page of ['DisplaySettingsPage', 'DisplayInstallingShow', 'DisplayFinishPage']) {
    const body = source.split(`Function ${page}`)[1].split('FunctionEnd')[0];
    assert.match(body, /Call DisplayRefreshFonts/);
  }
});

function nsisFunction(name) {
  const body = source.split(`Function ${name}\n`)[1]?.split('FunctionEnd')[0]
    || source.split(`Function ${name}\r\n`)[1]?.split('FunctionEnd')[0];
  assert.ok(body, `Missing NSIS function ${name}`);
  return body;
}

// Execute only the stack/text/visibility instructions used by the three
// settings helpers. No NSIS process, Win32 window or installation is involved.
function runSettingsHelper(name, state) {
  let active = true;
  for (const original of nsisFunction(name).split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith(';')) continue;
    if (line === '${If} $displayCustomExpanded == 0') { active = Number(state.vars.displayCustomExpanded) === 0; continue; }
    if (line === '${Else}') { active = !active; continue; }
    if (line === '${EndIf}') { active = true; continue; }
    if (!active) continue;
    let match;
    if ((match = /^Call (\w+)$/.exec(line))) runSettingsHelper(match[1], state);
    else if (line === 'Exch $0') { const text = state.stack.pop(); state.stack.push(state.vars[0]); state.vars[0] = text; }
    else if (line === 'Pop $0') { assert.ok(state.stack.length, 'NSIS callback/error stack must not underflow'); state.vars[0] = state.stack.pop(); }
    else if ((match = /^StrCpy \$(\w+) (\d+)$/.exec(line))) state.vars[match[1]] = Number(match[2]);
    else if ((match = /^ShowWindow \$(\w+) \$\{(SW_SHOW|SW_HIDE)\}$/.exec(line))) state.visible[match[1]] = match[2] === 'SW_SHOW';
    else if ((match = /^SendMessage \$(\w+) \$\{WM_SETTEXT\} 0 "STR:(.*)"$/.exec(line))) state.text[match[1]] = match[2].replace('$0', state.vars[0]);
    else assert.fail(`Unmodeled settings instruction: ${line}`);
  }
}

test('every rejected path reopens editable settings and displays its error without corrupting the NSIS stack', () => {
  const validation = nsisFunction('DisplaySettingsLeave');
  const errors = [...validation.matchAll(/Push "([^"]+)"\s+Call DisplayShowPathError\s+Abort/g)].map(m => m[1]);
  assert.equal(errors.length, 7, 'all seven rejection branches must use the common error helper');
  assert.equal((validation.match(/^\s*Abort\s*$/gm) || []).length, errors.length);
  assert.doesNotMatch(validation, /SendMessage \$displayPathError/, 'no hidden-label-only error branch may remain');
  for (const initiallyExpanded of [false, true]) for (const message of errors) {
    const state = { vars: { 0: 'C:\\Windows', displayCustomExpanded: Number(initiallyExpanded) }, visible: {}, text: {}, stack: [message] };
    runSettingsHelper('DisplayShowPathError', state);
    assert.equal(state.vars.displayCustomExpanded, 1);
    for (const control of ['displayPathPanel', 'displayPath', 'displayBrowse', 'displayPathError']) assert.equal(state.visible[control], true, control);
    assert.equal(state.text.displayPathError, message);
    assert.equal(state.text.displayCustomToggle, '收起设置');
    assert.equal(state.vars[0], 'C:\\Windows', 'the error helper preserves the caller path');
    assert.deepEqual(state.stack, []);
    state.stack.push('toggle HWND');
    runSettingsHelper('DisplayToggleCustom', state);
    assert.equal(state.vars.displayCustomExpanded, 0, 'only an explicit user toggle collapses settings');
    state.stack.push('toggle HWND');
    runSettingsHelper('DisplayToggleCustom', state);
    assert.equal(state.vars.displayCustomExpanded, 1);
    assert.deepEqual(state.stack, []);
  }
});

const harnessFile = path.resolve(root, '../tools/installer-preview-ui.ps1');
const harness = fs.readFileSync(harnessFile, 'utf8');
test('preview normal flow expands the real link and verifies visible errors after expanded and collapsed submissions', () => {
  const normal = harness.split("if($Scenario -eq 'normal'){")[1].split("Click '1';Capture")[0];
  assert.ok(normal.indexOf('Set-CustomExpanded $true') < normal.indexOf('$edit=[SetupPreviewNative]::Edit($handle)'));
  assert.match(normal, /foreach\(\$collapsed in @\(\$false,\$true\)\)/);
  assert.match(normal, /if\(\$collapsed\)\{Set-CustomExpanded \$false\}/);
  assert.match(normal, /VisibleTexts\(\$handle\)/);
  assert.doesNotMatch(normal, /::Texts\(\$handle\)/, 'hidden labels cannot satisfy inline-validation checks');
  assert.match(normal, /Rejected path settings remained collapsed/);
  assert.match(harness, /var parent=GetParent\(link\);var id=GetDlgCtrlID\(link\)/);
  assert.match(harness, /PostMessage\(parent,0x111,new IntPtr\(id & 0xffff\),link\)/);
  assert.match(harness, /parent==root/);
});

function nativeHelper(name) {
  const code = harness.split("Add-Type @'")[1].split("'@")[0];
  const match = new RegExp(`public static [\\w\\[\\]]+ ${name}\\(`).exec(code);
  assert.ok(match, `Missing native helper ${name}`);
  let end = code.indexOf('{', match.index), depth = 1;
  while (depth && ++end < code.length) { if (code[end] === '{') depth++; else if (code[end] === '}') depth--; }
  assert.equal(depth, 0);
  return code.slice(match.index, end + 1);
}

test('PowerShell expansion helper and actual C# link routing run against pure mocks with no native calls', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(path.resolve(root, '../output'), 'installer-ui-state-'));
  const temp = path.join(directory, 'Temp'); fs.mkdirSync(temp);
  const methods = ['VisibleTexts', 'Text', 'Edit', 'CustomToggle', 'ClickCustomToggle'].map(nativeHelper).join('\n');
  const mock = `using System;using System.Text;public static class SetupPreviewNative {
public delegate bool EnumProc(IntPtr h,IntPtr l);
public static bool Expanded,ErrorVisible,BadParent;public static int Posts;public static IntPtr LastParent;
public static bool EnumChildWindows(IntPtr h,EnumProc callback,IntPtr l){foreach(var id in new[]{2,3,4})if(!callback(new IntPtr(id),l))break;return true;}
public static bool IsWindowVisible(IntPtr h){return h.ToInt32()==2 || (h.ToInt32()==3 && Expanded) || (h.ToInt32()==4 && ErrorVisible);}
public static bool IsWindowEnabled(IntPtr h){return true;}
public static int GetClassName(IntPtr h,StringBuilder text,int max){text.Append(h.ToInt32()==2?"Button":h.ToInt32()==3?"Edit":"Static");return text.Length;}
public static int GetWindowText(IntPtr h,StringBuilder text,int max){text.Append(h.ToInt32()==2?(Expanded?"收起设置":"自定义安装"):h.ToInt32()==3?@"C:\fixture":"请选择本机磁盘上的完整安装路径。");return text.Length;}
public static int GetWindowLongW(IntPtr h,int index){return 0xb;}
public static IntPtr GetParent(IntPtr h){return new IntPtr(BadParent?1:10);}
public static int GetDlgCtrlID(IntPtr h){return 1437;}
public static bool PostMessage(IntPtr h,int message,IntPtr w,IntPtr l){if(h!=new IntPtr(10) || message!=0x111 || w!=new IntPtr(1437) || l!=new IntPtr(2))throw new Exception("Link notification used the wrong parent or ID");LastParent=h;Posts++;Expanded=!Expanded;return true;}
${methods}
}`;
  assert.doesNotMatch(mock, /DllImport|user32\.dll/);
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(harnessFile)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$function=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Set-CustomExpanded'},$true)
if(-not $function){throw 'Missing PowerShell expansion helper'}
. ([scriptblock]::Create($function.Extent.Text))
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(mock).toString('base64')}')))
$handle=[IntPtr]1;$checks=0
function Check($condition,$message){if(-not $condition){throw $message};$script:checks++}
Set-CustomExpanded $true
Check ([SetupPreviewNative]::Expanded -and [SetupPreviewNative]::Posts -eq 1) 'Opening custom settings failed'
Set-CustomExpanded $true
Check ([SetupPreviewNative]::Posts -eq 1) 'An already-expanded error state was accidentally toggled'
Check ([SetupPreviewNative]::Edit($handle) -ne [IntPtr]::Zero) 'Expanded settings are not editable'
Set-CustomExpanded $false
Check (-not [SetupPreviewNative]::Expanded -and [SetupPreviewNative]::Posts -eq 2) 'Collapsing custom settings failed'
Check ([SetupPreviewNative]::LastParent -eq [IntPtr]10) 'The link was sent to the root instead of the nsDialogs child'
[SetupPreviewNative]::BadParent=$true;$blocked=$false
try{Set-CustomExpanded $true}catch{$blocked=$true}
Check ($blocked -and [SetupPreviewNative]::Posts -eq 2) 'A root-parent link notification was not rejected'
[SetupPreviewNative]::BadParent=$false
Check (-not ([SetupPreviewNative]::VisibleTexts($handle) -match '^请选择')) 'A hidden validation label counted as visible'
[SetupPreviewNative]::ErrorVisible=$true
Check ([SetupPreviewNative]::VisibleTexts($handle) -match '^请选择') 'A visible validation label was not found'
@{success=$true;checks=$checks;nativeCalls=0;uiStarted=$false}|ConvertTo-Json -Compress
`;
  const file = path.join(directory, 'mock.ps1'); fs.writeFileSync(file, '\ufeff' + script);
  const env = { ...process.env };
  for (const key of ['TEMP', 'TMP']) { for (const old of Object.keys(env)) if (old.toUpperCase() === key) delete env[old]; env[key] = temp; }
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { windowsHide: true, encoding: 'utf8', env, timeout: 30000 });
  const evidence = JSON.parse(result.trim());
  assert.equal(evidence.success, true); assert.equal(evidence.checks, 8); assert.equal(evidence.nativeCalls, 0); assert.equal(evidence.uiStarted, false);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
});


test('close control is flush to the top right and settings links contain no duplicate glyphs',()=>{
 const page=layout.dialogs.find(d=>d.id===105),close=page.controls.find(c=>c.id===2);
 assert.equal(close.x+close.w,page.w);assert.equal(close.y,0);
 assert.match(source,/STR:收起设置"/);assert.match(source,/STR:自定义安装"/);
 assert.doesNotMatch(source,/收起设置 [▴▾▲▼·.]|自定义安装 [▴▾▲▼·.]/);
 assert.match(source,/InstallerWindowChrome\.dll.*Attach/);
});
test('native installer-only chrome compiles and its actual shared geometry passes command-line DPI and hit tests without UI', {skip:process.platform!=='win32'},()=>{
 const filename=require('./build-installer-window-chrome.cjs').buildInstallerChrome({test:true});
 const bytes=fs.readFileSync(filename),pe=bytes.readUInt32LE(0x3c);assert.equal(bytes.readUInt16LE(pe+4),0x14c);assert.equal(bytes.readUInt32LE(pe+24+16),0);
 const native=fs.readFileSync(path.join(root,'installer-window-chrome.c'),'utf8');
 assert.match(native,/WM_NCHITTEST/);assert.match(native,/return HTTRANSPARENT/);assert.match(native,/return HTCAPTION/);assert.match(native,/CreateRoundRectRgn/);assert.match(native,/SetWindowRgn/);assert.match(native,/WM_DPICHANGED/);
 assert.doesNotMatch(native,/SendInput|mouse_event|keybd_event|CreateProcess|ShellExecute/);
});

test('borderless frame has no modal rim and independent close/minimize survive installation', () => {
 const frame=layout.dialogs.find(d=>d.id===105);
 assert.equal(frame.style & 0x80,0,'DS_MODALFRAME adds a white non-client rim');
 const native=fs.readFileSync(path.join(root,'installer-window-chrome.c'),'utf8');
 assert.match(native,/#define MINIMIZE_ID 1240/);assert.match(native,/#define CLOSE_ID 1241/);
 assert.match(native,/ShowWindow\(window,SW_MINIMIZE\)/);
 assert.match(native,/msg==WM_CLOSE&&InterlockedCompareExchange\(&busy/);
 assert.match(native,/InterlockedExchange\(&cancelRequested,1\)/);
 assert.doesNotMatch(native,/TerminateProcess|TerminateThread|ExitProcess/);
 assert.match(nsisFunction('DisplayCheckCancel'),/IsCancelRequested[\s\S]*DisplayAbort/);
 for(const hook of ['customCheckAppRunning','customInstall']) {
  const body=hooks.split(`!macro ${hook}`)[1].split('!macroend')[0];
  assert.match(body,/Call DisplayCheckCancel/);assert.match(body,/!insertmacro DisplayStage/);
 }
});

test('details restore worker output after the builder reset and failures retain UTF-8 evidence', () => {
 assert.match(hooks,/ShowInstDetails show/);
 assert.match(source,/!macro DisplayStage TEXT\s+SetDetailsPrint listonly/);
 assert.match(nsisFunction('DisplayInstallingShow'),/SetDetailsView show[\s\S]*BeginInstall/);
 assert.match(nsisFunction('DisplayInstallingLeave'),/EndInstall[\s\S]*SetAutoClose false[\s\S]*SetDetailsView show/);
 assert.match(source,/!macro DisplayAbort TEXT[\s\S]*DetailPrint "\$displayFailure"[\s\S]*SetErrorLevel 2[\s\S]*Abort "\$displayFailure"/);
 const native=fs.readFileSync(path.join(root,'installer-window-chrome.c'),'utf8');
 assert.match(native,/LVM_INSERTITEMW\|\|msg==LVM_SETITEMTEXTW/);
 assert.match(native,/WideCharToMultiByte\(CP_UTF8/);assert.match(native,/CREATE_NEW/);assert.match(native,/FlushFileBuffers/);
 const collector=fs.readFileSync(path.join(root,'collector-installer.nsh'),'utf8');
 assert.match(hooks,/nsExec::ExecToLog \/TIMEOUT=510000/);
 assert.match(collector,/nsExec::ExecToLog \/TIMEOUT=1200000/);
 assert.match(collector,/nsExec::ExecToLog \/TIMEOUT=180000/);
 const preview=fs.readFileSync(path.join(__dirname,'installer-preview.cjs'),'utf8');
 assert.match(preview,/SetDetailsPrint none\s+!insertmacro DisplayStage/,'fixture must reproduce real builder behavior');
 assert.match(preview,/DisplayAbort.*1603/);
 for(const name of ['RuntimePrerequisites.ps1','Install-CollectorPayload.ps1']) {
  const script=fs.readFileSync(path.join(root,name),'utf8');
  assert.match(script,/\[switch\]\$InstallerLog/);
  assert.match(script,/if\(\$InstallerLog\)\{\[Console\]::OutputEncoding=\[Text.Encoding\]::Unicode;\[Console\]::Write\(\[char\]0xFEFF\)/);
 }
 assert.match(hooks,/-ProvisionDisplayLinks -InstallerLog/);
 assert.equal((collector.match(/-InstallerLog`/g)||[]).length,2);
});

test('production install/preflight hooks compile together without running any install section', {skip:process.platform!=='win32',timeout:60000}, async t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'installer-hooks-compile-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const script=`Unicode true
Name "Installer hook compile fixture"
OutFile "${path.join(directory,'NeverRun.exe')}"
RequestExecutionLevel user
!include LogicLib.nsh
!define DISPLAY_UI_PREVIEW
!define PRODUCT_NAME "Fixture"
!define VERSION "2.3.4"
!addincludedir "${path.join(root,'node_modules/app-builder-lib/templates/nsis/include')}"
!include "${path.join(root,'display-installer.nsh')}"
Var PowerShellPath
!macro IS_POWERSHELL_AVAILABLE
StrCpy $PowerShellPath "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"
!macroend
!macro _CHECK_APP_RUNNING
DetailPrint "Retained app-running guard"
!macroend
Function InstallSelectedCollector
FunctionEnd
Function VerifySelectedCollector
FunctionEnd
!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro customHeader
Section
!insertmacro customCheckAppRunning
!insertmacro customInstall
SectionEnd
`;
 const file=path.join(directory,'fixture.nsi');fs.writeFileSync(file,script);
 const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
 execFileSync(tool.path,['/INPUTCHARSET','UTF8',file],{windowsHide:true,env:{...process.env,...tool.env},stdio:'pipe'});
 assert.ok(fs.statSync(path.join(directory,'NeverRun.exe')).size>0);
});
