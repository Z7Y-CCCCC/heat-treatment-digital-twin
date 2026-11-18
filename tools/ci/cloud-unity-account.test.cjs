'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { hasAccount, trustedRoot, clientCandidates, activateAccount, returnAccountSeat } = require('./cloud-unity-account.cjs');
const { requireCloudAuthorization } = require('./cloud-runtime.cjs');
const { activationPaths, runActivationProof, MARKER } = require('./cloud-unity-activation.cjs');
const PRIVATE_EMAIL = 'private-fixture@example.invalid', PRIVATE_PASSWORD = 'PRIVATE_PASSWORD_FIXTURE';
function fixture(t) {
    const parent = fs.realpathSync.native(os.tmpdir()), temp = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cloud-account-test-')));
    t.after(() => { const resolved = fs.realpathSync.native(temp); assert.equal(resolved, temp);
        assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('cloud-account-test-'));
        fs.rmSync(resolved, { recursive: true, force: true }); });
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REF: 'refs/heads/main', RUNNER_TEMP: temp,
        UNITY_EDITOR_PATH: path.join(temp, 'cloud-release-v1/unity/Editor/Unity.exe'), UNITY_EMAIL: PRIVATE_EMAIL, UNITY_PASSWORD: PRIVATE_PASSWORD };
    const paths = activationPaths(env), client = clientCandidates(paths.editor, paths.root)[0];
    fs.mkdirSync(path.dirname(client), { recursive: true }); fs.writeFileSync(client, 'isolated client fixture; never executed');
    let editorCalls = 0;
    const editor = (file, args) => { editorCalls++; assert.equal(file, paths.editor);
        assert.equal(args[args.indexOf('-projectPath') + 1], paths.fixture); fs.writeFileSync(paths.log, MARKER + '\n'); return { status: 0 }; };
    const account = (file, args) => { assert.equal(file, client);
        if (args[0] === '--help') return { status: 0, stdout: '--activate-all --include-personal --return-ulf' };
        assert.deepEqual(args, ['--activate-all', '--include-personal', '--username', PRIVATE_EMAIL, '--password', PRIVATE_PASSWORD]);
        return { status: 0, stdout: 'fixture activation processed for ' + PRIVATE_EMAIL + ' ' + PRIVATE_PASSWORD }; };
    return { env, paths, client, editor, account, calls: () => editorCalls };
}
const assertPrivate = result => assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PASSWORD_FIXTURE|private-fixture@example\.invalid|fixture activation processed/);
test('account credentials must be an explicit complete pair and errors never contain their values', () => {
    assert.equal(hasAccount({}), false);
    assert.equal(hasAccount({ UNITY_EMAIL: PRIVATE_EMAIL, UNITY_PASSWORD: PRIVATE_PASSWORD }), true);
    for (const env of [{ UNITY_EMAIL: PRIVATE_EMAIL }, { UNITY_PASSWORD: PRIVATE_PASSWORD }, { UNITY_EMAIL: '\n', UNITY_PASSWORD: PRIVATE_PASSWORD }])
        assert.throws(() => hasAccount(env), error => /secure setup/.test(error.message) && !error.message.includes(PRIVATE_PASSWORD) && !error.message.includes(PRIVATE_EMAIL));
});
test('Personal preflight requires secure account setup before large downloads; supported file mode remains available', () => {
    const personal = '<root><License><Entitlement Tag="UnityPersonal" /></License></root>';
    assert.throws(() => requireCloudAuthorization({ UNITY_LICENSE: personal }), /UNITY_EMAIL and UNITY_PASSWORD/);
    assert.equal(requireCloudAuthorization({ UNITY_EMAIL: PRIVATE_EMAIL, UNITY_PASSWORD: PRIVATE_PASSWORD }), 'account');
    assert.equal(requireCloudAuthorization({ UNITY_LICENSE: '<root><License><Entitlement Tag="UnityPro" /></License></root>' }), 'file');
});
test('account activation zero exit still needs the real isolated editor marker and zero editor exit', t => {
    const f = fixture(t), result = runActivationProof(f.env, f.editor, f.account);
    assert.equal(result.success, true); assert.equal(result.executionVerified, true); assert.equal(result.activationMethod, 'account');
    assert.equal(f.calls(), 1); assertPrivate(result);
    assert.ok(fs.readFileSync(path.join(f.paths.privateRoot, 'account-activate-stdout.log'), 'utf8').includes(PRIVATE_PASSWORD));
    assertPrivate(JSON.parse(fs.readFileSync(f.paths.report, 'utf8')));
});
test('client zero exit with no seat does not launch an editor or claim a licensed build', t => {
    const f = fixture(t); const result = runActivationProof(f.env, f.editor, (_file, args) => args[0] === '--help'
        ? { status: 0, stdout: '--activate-all' } : { status: 0, stdout: 'No seat available. ' + PRIVATE_PASSWORD });
    assert.equal(result.success, false); assert.equal(f.calls(), 0); assert.deepEqual(result.accountSignals, ['no-seat-available']); assertPrivate(result);
});
test('authentication and two-factor failures return fixed codes and never credential excerpts', t => {
    const f = fixture(t); const result = runActivationProof(f.env, f.editor, (_file, args) => args[0] === '--help'
        ? { status: 0, stdout: '--activate-all' } : { status: 1, stderr: 'Authentication failed; 2FA required; ' + PRIVATE_PASSWORD });
    assert.equal(result.success, false); assert.equal(f.calls(), 0);
    assert.deepEqual(result.accountSignals, ['account-two-factor-required', 'account-authentication-failed']); assertPrivate(result);
});
test('unsupported clients and missing official clients fail without account activation', t => {
    for (const missing of [false, true]) { const f = fixture(t); let calls = 0;
        if (missing) fs.unlinkSync(f.client);
        const result = runActivationProof(f.env, f.editor, () => { calls++; return { status: 0, stdout: '--other-help' }; });
        assert.equal(result.success, false); assert.equal(f.calls(), 0); assert.equal(calls, missing ? 0 : 1);
        assert.equal(fs.existsSync(path.join(f.paths.privateRoot, 'account-seat-state.json')), false);
    }
});
test('account success cannot conceal missing execution markers or actual editor license refusal', t => {
    for (const log of ['no execution marker', 'No valid Unity Editor license found\n' + MARKER]) {
        const f = fixture(t), result = runActivationProof(f.env, () => { fs.writeFileSync(f.paths.log, log); return { status: 0 }; }, f.account);
        assert.equal(result.success, false); assert.equal(result.executionVerified, false);
    }
});
test('returning a current-run client seat uses no account credentials and exports no private log', t => {
    const f = fixture(t); assert.equal(activateAccount(f.paths, f.env, f.account).success, true);
    const result = returnAccountSeat({ ...f.env, UNITY_EMAIL: undefined, UNITY_PASSWORD: undefined }, (file, args) => {
        assert.equal(file, f.client); assert.deepEqual(args, ['--return-ulf']); return { status: 0, stdout: 'Returned ' + PRIVATE_PASSWORD };
    }); assert.equal(result.success, true); assert.equal(result.attempted, true); assertPrivate(result);
});
test('an entitlement seat without ULF is returned through a new isolated editor fixture, never the application', t => {
    const f = fixture(t); activateAccount(f.paths, f.env, f.account); const calls = [];
    const result = returnAccountSeat(f.env, (file, args) => { calls.push(file);
        if (file === f.client) return { status: 1, stdout: 'Ulf license file not found (1404)' };
        assert.equal(file, f.paths.editor); assert.ok(args.includes('-returnlicense'));
        assert.ok(args[args.indexOf('-projectPath') + 1].startsWith(f.paths.privateRoot + path.sep));
        assert.notEqual(args[args.indexOf('-projectPath') + 1], f.paths.fixture); return { status: 0, stdout: 'license return successful' };
    }); assert.equal(result.success, true); assert.deepEqual(calls, [f.client, f.paths.editor]);
});
test('an older client without include-personal uses the compatible editor return route', t => {
    const f = fixture(t); activateAccount(f.paths, f.env, (_file, args) => args[0] === '--help'
        ? { status: 0, stdout: '--activate-all' } : { status: 0, stdout: 'processed' });
    const result = returnAccountSeat(f.env, (file, args) => { assert.equal(file, f.paths.editor); assert.ok(args.includes('-returnlicense')); return { status: 0 }; });
    assert.equal(result.success, true);
});
test('return failures remain mandatory failures rather than warning-only release passes', t => {
    const f = fixture(t); activateAccount(f.paths, f.env, f.account);
    const result = returnAccountSeat(f.env, () => ({ status: 1, stderr: 'connection refused ' + PRIVATE_PASSWORD }));
    assert.equal(result.success, false); assertPrivate(result);
});
test('missing state needs no return; existing return reports or forged outside paths are never overwritten or executed', t => {
    const f = fixture(t); let calls = 0; assert.equal(returnAccountSeat(f.env, () => { calls++; }).attempted, false); assert.equal(calls, 0);
    assert.throws(() => returnAccountSeat(f.env), /never overwritten/);
    const g = fixture(t); fs.mkdirSync(g.paths.privateRoot, { recursive: true });
    fs.writeFileSync(path.join(g.paths.privateRoot, 'account-seat-state.json'), JSON.stringify({ schema: 1, editor: path.join(g.env.RUNNER_TEMP, 'operator.exe'), client: g.client, clientReturn: true }));
    assert.throws(() => returnAccountSeat(g.env, () => { calls++; }), /operator|Unsafe/); assert.equal(calls, 0);
});
test('operator, self-hosted, untrusted refs and filesystem roots cannot activate or return accounts', t => {
    const f = fixture(t);
    for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REF: 'refs/heads/feature' }, { RUNNER_TEMP: path.parse(f.env.RUNNER_TEMP).root }])
        assert.throws(() => trustedRoot({ ...f.env, ...patch }), /trusted|root/);
});
test('shipping workflows scope Secrets to preflight/activation and require current-run seat return before publishing', () => {
    const root = path.resolve(__dirname, '../..'); const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    const setup = fs.readFileSync(path.join(__dirname, 'setup-cloud-runner.ps1'), 'utf8');
    assert.match(release, /--require-authorization/); assert.match(release, /UNITY_PASSWORD: \$\{\{ secrets\.UNITY_PASSWORD \}\}/);
    assert.match(release, /if: always\(\)\s+run: node tools\/ci\/cloud-unity-account\.cjs --return-seat/);
    assert.ok(release.indexOf('cloud-unity-account.cjs --return-seat') < release.indexOf("Collect this build's verified installer"));
    assert.doesNotMatch(release, /private\/.*\.(?:log|json)|account-activate-.*\.log/);
    assert.match(setup, /SetEnvironmentVariable\('UNITY_PASSWORD', \$null, 'Process'\)/);
    assert.doesNotMatch(setup, /GITHUB_ENV[^\n]*UNITY_PASSWORD|UNITY_PASSWORD[^\n]*GITHUB_ENV|Unity_lic\.ulf|taskkill|Stop-Process/);
});

test('the existing require-license CLI flag accepts account authorization and still rejects unconfigured Personal files', () => {
    const { spawnSync } = require('node:child_process');
    const runtime = path.join(__dirname, 'cloud-runtime.cjs');
    const account = spawnSync(process.execPath, [runtime, '--require-license'], { windowsHide: true, encoding: 'utf8',
        env: { ...process.env, UNITY_LICENSE: '', UNITY_EMAIL: PRIVATE_EMAIL, UNITY_PASSWORD: PRIVATE_PASSWORD } });
    assert.equal(account.status, 0, account.stderr); assert.equal(JSON.parse(account.stdout).authorizationMethod, 'account'); assertPrivate(account.stdout);
    const file = spawnSync(process.execPath, [runtime, '--require-license'], { windowsHide: true, encoding: 'utf8',
        env: { ...process.env, UNITY_EMAIL: '', UNITY_PASSWORD: '', UNITY_LICENSE: '<root><License><Entitlement Tag="UnityPersonal" /></License></root>' } });
    assert.notEqual(file.status, 0); assert.match(file.stderr, /UNITY_EMAIL and UNITY_PASSWORD/);
});
