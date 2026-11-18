'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const MAX_LOG = 4 * 1024 * 1024;
function hasAccount(env = process.env) {
    const email = env.UNITY_EMAIL, password = env.UNITY_PASSWORD;
    if (!email && !password) return false;
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password
        || email.length > 1024 || password.length > 4096 || /[\0\r\n]/.test(email) || /\0/.test(password)) {
        throw Error('One-time secure setup required: configure both UNITY_EMAIL and UNITY_PASSWORD in repository Actions Secrets; never send credentials in chat');
    }
    return true;
}
function trustedRoot(env = process.env) {
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || !/^(?:refs\/heads\/main|refs\/tags\/v\d+\.\d+\.\d+)$/.test(env.GITHUB_REF || '')
        || !path.isAbsolute(env.RUNNER_TEMP || '')) throw Error('Account activation requires a trusted disposable hosted runner');
    const temp = path.resolve(env.RUNNER_TEMP);
    if (temp === path.parse(temp).root) throw Error('Account activation refuses a filesystem root');
    const root = path.join(temp, 'cloud-release-v1');
    for (let p = path.join(root, 'private'); p.startsWith(temp); p = path.dirname(p)) {
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Account activation refuses linked ancestors');
        if (p === temp) break;
    }
    return root;
}
function clientCandidates(editor, root) {
    if (!path.isAbsolute(editor || '') || !path.resolve(editor).startsWith(root + path.sep)) throw Error('Account activation must never use an operator editor');
    return ['Data/Resources/Licensing/Client/Unity.Licensing.Client.exe',
        'Data/Resources/Licensing/Unity.Licensing.Client.exe'].map(p => path.join(path.dirname(editor), p));
}
function readLog(file) {
    if (!fs.existsSync(file)) return '';
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOG) throw Error('Unsafe private account log');
    const bytes = fs.readFileSync(file);
    return bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
}
function launch(privateRoot, file, args, stem, run) {
    const stdout = path.join(privateRoot, stem + '-stdout.log'), stderr = path.join(privateRoot, stem + '-stderr.log');
    if (fs.existsSync(stdout) || fs.existsSync(stderr)) throw Error('Private account logs must be new');
    fs.mkdirSync(privateRoot, { recursive: true });
    let result;
    if (run) {
        result = run(file, args);
        fs.writeFileSync(stdout, result.stdout || ''); fs.writeFileSync(stderr, result.stderr || '');
    } else {
        const out = fs.openSync(stdout, 'wx'), err = fs.openSync(stderr, 'wx');
        try { result = spawnSync(file, args, { windowsHide: true, stdio: ['ignore', out, err], timeout: 300000 }); }
        finally { fs.closeSync(out); fs.closeSync(err); }
    }
    return { exit: Number.isInteger(result.status) ? result.status : null, error: Boolean(result.error),
        text: readLog(stdout) + '\n' + readLog(stderr) };
}
function accountSignals(text) {
    return [
        ['no-seat-available', /no (?:available )?seats?|seat is not available|entitlement groups and 0 free entitlements|LICENSE_LIMIT/i],
        ['no-editor-license', /No license activation found for this computer|No valid Unity Editor license found/i],
        ['account-two-factor-required', /two.factor|2FA|verification code|authentication code/i],
        ['account-authentication-failed', /invalid (?:user|password|credentials)|authentication failed|login failed/i],
        ['licensing-access-token-unavailable', /Access token is unavailable/i],
        ['licensing-connection-failed', /Failed to connect to licensing|connection timed out|connection refused/i],
    ].filter(([, regex]) => regex.test(text)).map(([code]) => code);
}
function activateAccount(paths, env = process.env, run) {
    if (!hasAccount(env) || trustedRoot(env) !== paths.root) throw Error('Authorized account credentials and isolated paths are required');
    const candidates = clientCandidates(paths.editor, paths.root);
    const client = candidates.find(p => fs.existsSync(p) && fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink());
    if (!client) return { success: false, exit: null, signals: ['account-client-missing'] };
    const help = launch(paths.privateRoot, client, ['--help'], 'account-help', run);
    if (help.error || help.exit !== 0 || !help.text.includes('--activate-all')) return { success: false, exit: help.exit, signals: ['account-client-unsupported'] };
    const includePersonal = help.text.includes('--include-personal');
    const statePath = path.join(paths.privateRoot, 'account-seat-state.json');
    if (fs.existsSync(statePath)) throw Error('Existing account seat evidence is never overwritten');
    // No credentials or account identifiers are persisted. This records only the
    // current runner's cleanup route, before even a failed activation may hold a seat.
    fs.writeFileSync(statePath, JSON.stringify({ schema: 1, editor: paths.editor, client,
        clientReturn: includePersonal && help.text.includes('--return-ulf') }) + '\n', { flag: 'wx' });
    const args = ['--activate-all', ...(includePersonal ? ['--include-personal'] : []),
        '--username', env.UNITY_EMAIL, '--password', env.UNITY_PASSWORD];
    const result = launch(paths.privateRoot, client, args, 'account-activate', run);
    const signals = accountSignals(result.text);
    return { success: !result.error && result.exit === 0 && signals.length === 0, exit: result.exit, signals };
}
function returnAccountSeat(env = process.env, run) {
    const root = trustedRoot(env), privateRoot = path.join(root, 'private');
    const statePath = path.join(privateRoot, 'account-seat-state.json');
    const reportPath = path.join(root, 'account-seat-return-result.json');
    if (fs.existsSync(reportPath)) throw Error('Account return evidence is never overwritten');
    const report = { schema: 1, success: true, attempted: false, exit: null, signals: [] };
    function finish() { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return report; }
    if (!fs.existsSync(statePath)) return finish();
    const state = JSON.parse(readLog(statePath));
    if (state.schema !== 1 || typeof state.clientReturn !== 'boolean'
        || !clientCandidates(state.editor, root).includes(state.client)) throw Error('Unsafe account seat return state');
    report.attempted = true;
    let result;
    if (state.clientReturn) result = launch(privateRoot, state.client, ['--return-ulf'], 'account-return-client', run);
    if (!state.clientReturn || /Ulf license file not found|UlfLicenseFileNotFound/i.test(result.text)) {
        const fixture = path.join(privateRoot, 'account-return-fixture');
        if (fs.existsSync(fixture)) throw Error('Account return fixture must be new');
        fs.mkdirSync(path.join(fixture, 'Assets'), { recursive: true });
        const log = path.join(privateRoot, 'account-return-editor.log');
        result = launch(privateRoot, state.editor, ['-batchmode', '-nographics', '-quit', '-returnlicense',
            '-projectPath', fixture, '-logFile', log], 'account-return-editor', run);
        result.text += '\n' + readLog(log);
    }
    report.exit = result.exit; report.signals = accountSignals(result.text);
    report.success = !result.error && result.exit === 0 && report.signals.length === 0;
    return finish();
}
if (require.main === module) {
    try { if (!process.argv.includes('--return-seat')) throw Error('Only the explicit seat return command is supported');
        const result = returnAccountSeat(); console.log(JSON.stringify(result)); if (!result.success) process.exitCode = 1;
    } catch { console.error('Account seat return failed safely; private logs and credentials were not published.'); process.exitCode = 1; }
}
module.exports = { hasAccount, trustedRoot, clientCandidates, activateAccount, returnAccountSeat, accountSignals };
