'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
function requiresStartupProof(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!parts) throw Error('Invalid release version');
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 4)));
}
function assertStartupProof(manifest) {
  if (!requiresStartupProof(manifest.version) && !manifest.installerStartup) return;
  const proof = manifest.installerStartup;
  if (proof?.status !== 'passed' || proof.sha256 !== manifest.sha256 || proof.realExecutable !== true
      || proof.settingsReady !== true || proof.installed !== false || proof.nextClicked !== false)
    throw Error('Actual installer startup proof is missing, failed or belongs to different bytes');
}
function verifyInstallerStartup(executable, report) {
  if (process.platform !== 'win32') throw Error('Actual installer startup must be tested on Windows');
  executable = path.resolve(executable); report = path.resolve(report);
  if (path.extname(executable).toLowerCase() !== '.exe') throw Error('Expected the final installer EXE');
  if (fs.existsSync(report)) throw Error('Installer startup report already exists; do not reuse stale evidence');
  const digest = fileDigest(executable);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'installer-startup-smoke.ps1'), '-Executable', executable,
    '-ExpectedSha256', digest.sha256, '-Report', report], { windowsHide: true, stdio: 'pipe', timeout: 90000 });
  const evidence = JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  const proof = { status: evidence.success ? 'passed' : 'failed', sha256: evidence.sha256,
    realExecutable: evidence.realExecutable, settingsReady: evidence.settingsReady,
    installed: evidence.installed, nextClicked: evidence.nextClicked, seconds: evidence.seconds };
  assertStartupProof({ version: '2.3.4', sha256: digest.sha256, installerStartup: proof });
  const after = fileDigest(executable);
  if (after.sha256 !== digest.sha256 || after.size !== digest.size) throw Error('Installer bytes changed during startup verification');
  return proof;
}
if (require.main === module) console.log(JSON.stringify(verifyInstallerStartup(...process.argv.slice(2)), null, 2));
module.exports = { requiresStartupProof, assertStartupProof, verifyInstallerStartup };
