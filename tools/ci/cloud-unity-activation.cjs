'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readCloudRuntime, requireUnityLicense } = require('./cloud-runtime.cjs');

const MARKER = 'CLOUD_UNITY_ACTIVATION_EXECUTION_OK';
const MAX_LOG_BYTES = 4 * 1024 * 1024;
// Return fixed codes, never log excerpts, account identifiers or license data.
const SIGNALS = [
    ['machine-binding-mismatch', /Machine bindings? (?:don['’]t|do not|does not) match/i],
    ['no-editor-license', /No valid Unity Editor license found|No license activation found for this computer|License is not active/i],
    ['no-seat-available', /No seat available/i],
    ['manual-personal-unsupported', /manual activation.{0,80}(?:not supported|unsupported).{0,80}Personal|Personal.{0,80}manual activation.{0,80}(?:not supported|unsupported)/i],
    ['license-signature-rejected', /(?:invalid|failed|failure).{0,40}license signature|license signature.{0,40}(?:invalid|failed|failure)/i],
    ['licensing-network-error', /TimeoutPolicy did not complete|Access token is unavailable|Failed to connect to licensing|licensing.{0,60}(?:connection timed out|connection refused)/i],
];
function diagnosticSignals(text) {
    return SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}
function licenseKind(license) {
    return /<Entitlement\b[^<>]*\bTag\s*=\s*['"]UnityPersonal['"][^<>]*>/i.test(license) ? 'personal' : 'other';
}
function activationPaths(env = process.env) {
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || !/^(?:refs\/heads\/main|refs\/tags\/v\d+\.\d+\.\d+)$/.test(env.GITHUB_REF || '')
        || !path.isAbsolute(env.RUNNER_TEMP || '')) {
        throw Error('Activation proof requires a disposable GitHub-hosted trusted main or version-tag environment');
    }
    const temp = path.resolve(env.RUNNER_TEMP);
    if (temp === path.parse(temp).root) throw Error('Activation proof refuses a filesystem root');
    const root = path.join(temp, 'cloud-release-v1');
    const privateRoot = path.join(root, 'private');
    const editor = path.resolve(env.UNITY_EDITOR_PATH || '');
    if (!path.isAbsolute(env.UNITY_EDITOR_PATH || '') || !editor.startsWith(root + path.sep)) {
        throw Error('Activation proof must use the provisioned cloud editor, never the operator editor');
    }
    // Existing linked ancestors must not redirect a cloud fixture or report.
    for (let current = privateRoot; current.startsWith(temp); current = path.dirname(current)) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Activation proof refuses linked temporary ancestors');
        if (current === temp) break;
    }
    return {
        root, privateRoot, editor,
        fixture: path.join(privateRoot, 'activation-proof-fixture'),
        log: path.join(privateRoot, 'activation-proof.log'),
        report: path.join(root, 'activation-result.json'),
        importLogs: ['activation.log', 'import-stdout.log', 'import-stderr.log'].map(name => path.join(privateRoot, name)),
    };
}
function readPrivateLog(filename) {
    if (!fs.existsSync(filename)) return '';
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOG_BYTES) throw Error('Private activation log is unsafe or oversized');
    const bytes = fs.readFileSync(filename);
    return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
        ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
}
function runActivationProof(env = process.env, run = (file, args) => spawnSync(file, args, {
    windowsHide: true, encoding: 'utf8', stdio: 'ignore', timeout: 300000,
})) {
    const paths = activationPaths(env);
    requireUnityLicense(env);
    const { config } = readCloudRuntime();
    if (fs.existsSync(paths.fixture) || fs.existsSync(paths.log) || fs.existsSync(paths.report)) {
        throw Error('Activation proof paths must be new and must never overwrite previous evidence');
    }
    const rawExit = env.CLOUD_UNITY_IMPORT_EXIT_CODE;
    const numericExit = /^-?\d{1,10}$/.test(rawExit || '') ? Number(rawExit) : NaN;
    const importExitCode = Number.isInteger(numericExit) && numericExit >= -2147483648 && numericExit <= 2147483647 ? numericExit : null;
    const kind = licenseKind(env.UNITY_LICENSE);
    const report = {
        schema: 1, success: false, unityVersion: config.unity.version,
        licenseKind: kind, importExitCode, importSignals: [],
        editorExitCode: null, executionVerified: false, cause: 'not-verified',
        installerBuilt: false, releasePublished: false, fixtureOnly: true,
    };
    function finish(success, cause) {
        report.success = success;
        report.cause = cause;
        fs.mkdirSync(paths.root, { recursive: true });
        fs.writeFileSync(paths.report, JSON.stringify(report, null, 2) + '\n');
        return report;
    }
    try {
        report.importSignals = diagnosticSignals(paths.importLogs.map(readPrivateLog).join('\n'));
        if (importExitCode !== 0 && !(importExitCode === 1 && kind === 'personal')) return finish(false, 'manual-import-failed');
        if (report.importSignals.some(code => code === 'machine-binding-mismatch' || code === 'license-signature-rejected')) {
            return finish(false, 'license-file-rejected');
        }
        // Personal import can return 1 even after successful registration. Neither
        // 0 nor 1 grants a pass here: a separate real editor execution is mandatory.
        fs.mkdirSync(path.join(paths.fixture, 'Assets', 'Editor'), { recursive: true });
        fs.mkdirSync(path.join(paths.fixture, 'ProjectSettings'));
        fs.mkdirSync(path.join(paths.fixture, 'Packages'));
        fs.writeFileSync(path.join(paths.fixture, 'Packages', 'manifest.json'), '{"dependencies":{}}\n');
        fs.writeFileSync(path.join(paths.fixture, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + config.unity.version + '\n');
        fs.writeFileSync(path.join(paths.fixture, 'Assets', 'Editor', 'CloudActivationProbe.cs'),
            'using UnityEditor; using UnityEngine; public static class CloudActivationProbe { public static void Run() { if(Application.unityVersion != "' + config.unity.version + '") { EditorApplication.Exit(2); return; } Debug.Log("' + MARKER + '"); EditorApplication.Exit(0); } }\n');
        const result = run(paths.editor, ['-batchmode', '-nographics', '-quit', '-projectPath', paths.fixture,
            '-executeMethod', 'CloudActivationProbe.Run', '-logFile', paths.log]);
        report.editorExitCode = Number.isInteger(result.status) ? result.status : null;
        if (result.error) return finish(false, 'editor-execution-error');
        const log = readPrivateLog(paths.log);
        const signals = diagnosticSignals(log);
        if (signals.length) report.importSignals = [...new Set([...report.importSignals, ...signals])];
        if (result.status !== 0 || !log.split(/\r?\n/).some(line => line.trim() === MARKER)) {
            return finish(false, 'editor-execution-not-proven');
        }
        if (signals.some(code => ['machine-binding-mismatch', 'license-signature-rejected', 'no-editor-license', 'no-seat-available'].includes(code))) {
            return finish(false, 'editor-license-rejected');
        }
        report.executionVerified = true;
        return finish(true, 'authorized-editor-executed');
    } catch {
        return finish(false, 'activation-proof-error');
    }
}
if (require.main === module) {
    try {
        const result = runActivationProof();
        console.log(JSON.stringify(result));
        if (!result.success) process.exitCode = 1;
    } catch {
        console.error('Cloud Unity activation proof could not run safely; no license contents or private logs were published.');
        process.exitCode = 1;
    }
}
module.exports = { MARKER, diagnosticSignals, licenseKind, activationPaths, runActivationProof };
