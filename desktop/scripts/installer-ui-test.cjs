'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { layout, dialogResource } = require('./installer-layout.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'display-installer-ui.nsh'), 'utf8');
const hooks = fs.readFileSync(path.join(root, 'display-installer.nsh'), 'utf8');
const pkg = require('../package.json');
test('custom installer illustration and stock uninstaller sidebar use their own required dimensions', () => {
  for (const [name, width, height] of [['installer-art.bmp',600,1100],['installer-sidebar.bmp',164,314]]) {
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
  const page = d.controls.find(c => c.id === 1018), action = d.controls.find(c => c.id === 1);
  assert.ok(page.y + page.h < action.y, 'page content must not overlap the main action');
  assert.ok(d.w <= 460 && d.h <= 275, 'keep the illustrated wizard bounded');
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
