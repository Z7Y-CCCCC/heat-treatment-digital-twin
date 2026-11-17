'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { assertStartupProof, requiresStartupProof, verifyInstallerStartup } = require('../../tools/installer-startup-smoke.cjs');
const root = path.resolve(__dirname, '../..');
test('new releases require byte-bound actual EXE startup, not an unpacked-app smoke result', () => {
  assert.equal(requiresStartupProof('2.3.3'), false);
  for (const version of ['2.3.4', '2.3.10', '2.4.0', '3.0.0']) assert.equal(requiresStartupProof(version), true);
  assert.throws(() => requiresStartupProof('unknown'), /Invalid/);
  const proof = { status: 'passed', sha256: 'a'.repeat(64), realExecutable: true, settingsReady: true, installed: false, nextClicked: false };
  const manifest = { version: '2.3.4', sha256: proof.sha256, installerStartup: proof };
  assert.doesNotThrow(() => assertStartupProof(manifest));
  assert.throws(() => assertStartupProof({ ...manifest, installerStartup: undefined }), /startup proof/);
  for (const patch of [{ status: 'failed' }, { sha256: 'b'.repeat(64) }, { realExecutable: false }, { settingsReady: false }, { installed: true }, { nextClicked: true }])
    assert.throws(() => assertStartupProof({ ...manifest, installerStartup: { ...proof, ...patch } }), /startup proof/);
});
test('final packaging and both upload gates enforce startup, while the probe cannot advance installation', () => {
  for (const file of ['tools/ci/collect-release.cjs', 'tools/ci/verify-release.cjs']) assert.match(fs.readFileSync(path.join(root,file),'utf8'), /assertStartupProof\(manifest\)/);
  const builder = fs.readFileSync(path.join(root,'tools/package-installer.cjs'),'utf8');
  assert.ok(builder.indexOf('verifyInstallerStartup(installer') > builder.indexOf('--prepackaged'));
  const probe = fs.readFileSync(path.join(root,'tools/installer-startup-smoke.ps1'),'utf8');
  assert.match(probe, /Get-FileHash/); assert.match(probe, /WindowStyle Hidden/);
  assert.match(probe, /PostMessage\(\$handle,0x10/);
  assert.doesNotMatch(probe, /PostMessage\([^\n]*0x111|BM_CLICK|WriteReg|Start-Service|SendInput/);
  assert.match(probe, /Stop-Process -Id \$child.Id/);
  assert.match(probe, /installer-startup-\[a-f0-9\]\{32\}/);
});
test('actual NSIS startup opens shared production UI; original quoted DLL invocation fails the same gate', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-startup-regression-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, INSTALLER_PREVIEW_DIR: path.join(directory, '中文 fixture') };
  execFileSync(process.execPath, [path.join(__dirname,'installer-preview.cjs'), '--scenario=cancel'], { cwd: root, env, windowsHide: true, stdio: 'pipe', timeout: 60000 });
  const preview = path.join(env.INSTALLER_PREVIEW_DIR,'cancel');
  const positiveReport = path.join(directory,'positive.json');
  const proof = verifyInstallerStartup(path.join(preview,'InstallerPreview.exe'),positiveReport);
  assert.equal(proof.status,'passed');
  assert.throws(() => verifyInstallerStartup(path.join(preview,'InstallerPreview.exe'),positiveReport), /stale evidence/);
  // Compile the identical shared production include with only the original bug
  // restored. No real installer section, registry writes or app launch exists.
  const uiPath = path.join(root,'desktop/display-installer-ui.nsh');
  const fixedCall = "System::Call '$PLUGINSDIR\\InstallerWindowChrome.dll::Attach(p $HWNDPARENT) i.r0 ?!u'";
  const buggyCall = "System::Call '\"$PLUGINSDIR\\InstallerWindowChrome.dll\"::Attach(p $HWNDPARENT) i.r0'";
  const ui = fs.readFileSync(uiPath,'utf8'); assert.ok(ui.includes(fixedCall));
  const badUi = path.join(directory,'buggy-ui.nsh');
  fs.writeFileSync(badUi,ui.replace(fixedCall,buggyCall).replaceAll('${__FILEDIR__}',path.join(root,'desktop')));
  const badInclude = path.join(directory,'buggy-installer.nsh');
  fs.writeFileSync(badInclude,fs.readFileSync(path.join(root,'desktop/display-installer.nsh'),'utf8')
    .replace('"${__FILEDIR__}\\display-installer-ui.nsh"',JSON.stringify(badUi).replaceAll('\\\\','\\'))
    .replaceAll('${__FILEDIR__}',path.join(root,'desktop')));
  const badExe = path.join(directory,'BuggyPreview.exe'), badScript = path.join(directory,'buggy.nsi');
  fs.writeFileSync(badScript,fs.readFileSync(path.join(preview,'preview.nsi'),'utf8')
    .replace(path.join(root,'desktop','display-installer.nsh'),badInclude)
    .replace(path.join(preview,'InstallerPreview.exe'),badExe));
  const tool = await require('./nsis-toolchain.cjs').nsisToolchain();
  execFileSync(tool.path,['/INPUTCHARSET','UTF8',badScript],{ windowsHide:true,env:{...process.env,...tool.env},stdio:'pipe' });
  const negativeReport = path.join(directory,'negative.json');
  assert.throws(() => verifyInstallerStartup(badExe,negativeReport), /Command failed/);
  const failed = JSON.parse(fs.readFileSync(negativeReport,'utf8').replace(/^\uFEFF/,''));
  assert.equal(failed.success,false); assert.match(failed.error,/安装窗口初始化失败/);
  assert.equal(failed.installed,false); assert.equal(failed.nextClicked,false);
});
