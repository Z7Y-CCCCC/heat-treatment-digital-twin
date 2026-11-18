'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MARKER, diagnosticSignals, licenseKind, activationPaths, runActivationProof } = require('./cloud-unity-activation.cjs');

function fixture(t, importCode = '0', personal = true) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-unity-activation-'));
    t.after(() => {
        const resolved = path.resolve(temp);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('cloud-unity-activation-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const env = {
        GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REF: 'refs/heads/main',
        RUNNER_TEMP: temp, UNITY_EDITOR_PATH: path.join(temp, 'cloud-release-v1', 'unity', 'Editor', 'Unity.exe'),
        UNITY_LICENSE: '<root><License id="fixture-only"><Entitlements><Entitlement Ns="unity_editor" Tag="' + (personal ? 'UnityPersonal' : 'UnityPro') + '" /></Entitlements></License></root>',
        CLOUD_UNITY_IMPORT_EXIT_CODE: importCode,
    };
    const paths = activationPaths(env);
    fs.mkdirSync(paths.privateRoot, { recursive: true });
    fs.writeFileSync(paths.importLogs[0], 'fixture-private-license-text\nNext license update check is after fixture date\n');
    let calls = 0;
    const execute = (file, args) => {
        calls++;
        assert.equal(file, paths.editor);
        assert.equal(args[args.indexOf('-projectPath') + 1], paths.fixture);
        assert.equal(args[args.indexOf('-executeMethod') + 1], 'CloudActivationProbe.Run');
        assert.equal(args[args.indexOf('-logFile') + 1], paths.log);
        fs.writeFileSync(paths.log, 'fixture-private-editor-text\n' + MARKER + '\n');
        return { status: 0 };
    };
    return { env, paths, execute, calls: () => calls };
}

test('Personal recognition uses the explicit entitlement, never an account or arbitrary text', () => {
    assert.equal(licenseKind('<root><License><Entitlement Ns="unity_editor" Tag="UnityPersonal" Type="EDITOR" /></License></root>'), 'personal');
    assert.equal(licenseKind('<root><License id="UnityPersonal" /></root>'), 'other');
    assert.equal(licenseKind('<root><License><Entitlement Tag="UnityPro" /></License></root>'), 'other');
});
test('a normal import still needs a separate real editor execution with its exact marker', t => {
    const f = fixture(t), result = runActivationProof(f.env, f.execute);
    assert.equal(result.success, true);
    assert.equal(result.importExitCode, 0);
    assert.equal(result.editorExitCode, 0);
    assert.equal(result.executionVerified, true);
    assert.equal(result.installerBuilt, false);
    assert.equal(result.releasePublished, false);
    assert.equal(f.calls(), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.report, 'utf8')), result);
    assert.doesNotMatch(fs.readFileSync(f.paths.report, 'utf8'), /fixture-private|fixture-only|UnityPersonal|activation-proof-fixture/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.paths.fixture, 'Packages', 'manifest.json'), 'utf8')), { dependencies: {} });
    assert.match(fs.readFileSync(path.join(f.paths.fixture, 'Assets', 'Editor', 'CloudActivationProbe.cs'), 'utf8'), /Application\.unityVersion != "2022\.3\.34f1c1"/);
});
test('Personal import code 1 is not a rejection when independent authorized editor execution is proven', t => {
    const f = fixture(t, '1'), result = runActivationProof(f.env, f.execute);
    assert.equal(result.success, true);
    assert.equal(result.importExitCode, 1);
    assert.equal(result.editorExitCode, 0);
    assert.equal(result.executionVerified, true);
    assert.equal(f.calls(), 1);
});
for (const code of ['0', '1']) {
    for (const scenario of ['no-marker', 'embedded-marker', 'nonzero-editor', 'missing-log', 'timeout', 'null-exit']) {
        test('import code ' + code + ' cannot pass without real execution: ' + scenario, t => {
            const f = fixture(t, code);
            const result = runActivationProof(f.env, () => {
                if (scenario !== 'missing-log') fs.writeFileSync(f.paths.log, scenario === 'no-marker' ? 'fixture-private-editor-text' : scenario === 'embedded-marker' ? 'unrelated-prefix-' + MARKER : MARKER + '\n');
                return { status: scenario === 'nonzero-editor' ? 1 : scenario === 'null-exit' ? null : 0, error: scenario === 'timeout' ? Error('fixture timeout') : undefined };
            });
            assert.equal(result.success, false);
            assert.equal(result.executionVerified, false);
            assert.doesNotMatch(JSON.stringify(result), /fixture-private|fixture timeout/);
        });
    }
}
test('non-Personal code 1, unknown exit codes and invalid license values cannot invoke the probe', t => {
    for (const code of ['1', '2', '-1', '33', 'unknown', '', '0PRIVATE', '2147483648']) {
        const f = fixture(t, code, false);
        const result = runActivationProof(f.env, () => { throw Error('probe must not execute'); });
        assert.equal(result.success, false);
        assert.equal(result.cause, 'manual-import-failed');
        assert.equal(result.executionVerified, false);
    }
    const f = fixture(t);
    assert.throws(() => runActivationProof({ ...f.env, UNITY_LICENSE: 'invalid' }, f.execute), /One-time setup/);
    assert.equal(f.calls(), 0);
});
test('known file binding or signature rejection is a failure, never an accepted code-1 import', t => {
    for (const message of ["Machine bindings don't match", 'License signature is invalid']) {
        const f = fixture(t, '1');
        fs.writeFileSync(f.paths.importLogs[0], message + '\nPRIVATE_ACCOUNT_FIXTURE\n');
        const result = runActivationProof(f.env, () => { throw Error('probe must not execute after a recognized license rejection'); });
        assert.equal(result.success, false);
        assert.equal(result.cause, 'license-file-rejected');
        assert.equal(result.editorExitCode, null);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ACCOUNT_FIXTURE|Machine bindings|License signature/);
    }
});
test('UTF-16 private native output is classified without disclosing its contents', t => {
    const f = fixture(t, '1');
    fs.writeFileSync(f.paths.importLogs[1], Buffer.concat([Buffer.from([255, 254]), Buffer.from("Machine bindings don't match\nPRIVATE_LICENSE_FIXTURE", 'utf16le')]));
    const result = runActivationProof(f.env, f.execute);
    assert.equal(result.success, false);
    assert.deepEqual(result.importSignals, ['machine-binding-mismatch']);
    assert.equal(f.calls(), 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LICENSE_FIXTURE/);
});
test('a forged success marker cannot conceal an actual editor license refusal', t => {
    for (const message of ['No valid Unity Editor license found', 'No seat available']) {
        const f = fixture(t);
        const result = runActivationProof(f.env, () => {
            fs.writeFileSync(f.paths.log, message + '\n' + MARKER + '\n');
            return { status: 0 };
        });
        assert.equal(result.success, false);
        assert.equal(result.executionVerified, false);
        assert.equal(result.cause, 'editor-license-rejected');
    }
});
test('safe diagnostic classification returns fixed codes, not license IDs, credentials or injected text', () => {
    const text = "Machine bindings don't match; PRIVATE_PASSWORD_FIXTURE\nNo seat available; PRIVATE_LICENSE_FIXTURE\nTimeoutPolicy did not complete; PRIVATE_ACCOUNT_FIXTURE";
    assert.deepEqual(diagnosticSignals(text), ['machine-binding-mismatch', 'no-seat-available', 'licensing-network-error']);
    assert.doesNotMatch(JSON.stringify(diagnosticSignals(text)), /PRIVATE_/);
});
test('oversized private logs fail closed without launching an editor or exporting the log', t => {
    const f = fixture(t);
    fs.writeFileSync(f.paths.importLogs[0], Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    const result = runActivationProof(f.env, f.execute);
    assert.equal(result.success, false);
    assert.equal(result.cause, 'activation-proof-error');
    assert.equal(f.calls(), 0);
});
test('existing fixtures, logs and receipts are never reused or overwritten', t => {
    for (const kind of ['fixture', 'log', 'report']) {
        const f = fixture(t);
        if (kind === 'fixture') fs.mkdirSync(f.paths.fixture); else fs.writeFileSync(f.paths[kind], 'keep-original');
        assert.throws(() => runActivationProof(f.env, f.execute), /must be new/);
        assert.equal(f.calls(), 0);
        if (kind !== 'fixture') assert.equal(fs.readFileSync(f.paths[kind], 'utf8'), 'keep-original');
    }
});
test('operator, self-hosted, untrusted ref, escaping editor and filesystem-root paths perform no activation I/O', t => {
    const f = fixture(t);
    for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REF: 'refs/heads/feature' }, { RUNNER_TEMP: path.parse(f.env.RUNNER_TEMP).root }, { UNITY_EDITOR_PATH: path.join(f.env.RUNNER_TEMP, 'operator-editor.exe') }]) {
        assert.throws(() => runActivationProof({ ...f.env, ...patch }, f.execute), /disposable|root|operator/);
    }
    assert.equal(f.calls(), 0);
    assert.equal(fs.existsSync(f.paths.report), false);
    assert.equal(activationPaths({ ...f.env, GITHUB_REF: 'refs/tags/v2.3.7' }).fixture, f.paths.fixture);
});
test('shipping setup keeps private logs private, requires the real proof, and never reads an operator license', () => {
    const script = fs.readFileSync(path.join(__dirname, 'setup-cloud-runner.ps1'), 'utf8');
    assert.match(script, /RUNNER_ENVIRONMENT -ne 'github-hosted'/);
    assert.match(script, /cloud-unity-activation\.cjs/);
    assert.match(script, /if \(\$LASTEXITCODE -ne 0\).*empty-editor execution proof/);
    assert.match(script, /-RedirectStandardOutput \$stdout -RedirectStandardError \$stderr/);
    assert.doesNotMatch(script, /C:\\ProgramData\\Unity|Unity_lic\.ulf|Stop-Process|taskkill|Remove-Item[^\n]+-Recurse/);
    const readiness = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/cloud-readiness.yml'), 'utf8');
    assert.match(readiness, /activation-result\.json/);
    assert.doesNotMatch(readiness, /private\/.*\.log|activation\.log/);
});
