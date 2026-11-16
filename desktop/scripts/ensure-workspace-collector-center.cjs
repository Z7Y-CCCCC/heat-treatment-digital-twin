'use strict';
// UI only. Never builds/installs a collector runtime, changes its configuration,
// or copies into Program Files. The UI still observes the configured service.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inputFingerprint(project) {
    const inputs = fs.readdirSync(path.join(project, 'collector-center')).filter(name => /\.(cs|config|manifest)$/.test(name))
        .sort().map(name => path.join('collector-center', name));
    inputs.push('desktop/scripts/build-collector-center.cjs', 'desktop/assets/icon.ico');
    const hash = crypto.createHash('sha256'); hash.update('workspace-center-ui-v1\0');
    for (const input of inputs) hash.update(input + '\0' + digest(path.join(project, input)) + '\0');
    return hash.digest('hex');
}
function ensureWorkspaceCollectorCenter({ project = path.resolve(__dirname, '../..'), build } = {}) {
    const fingerprint = inputFingerprint(project);
    // Different source versions get different paths, so an already-open UI is
    // never overwritten and cannot receive the new version's navigation IPC.
    const output = path.join(project, 'desktop/.cache/workspace-collector-center', fingerprint);
    const executable = path.join(output, 'HeatTreatmentCollectorCenter.exe');
    const config = executable + '.config', proof = path.join(output, 'workspace-ui-proof.json');
    let cached = false;
    try {
        const receipt = JSON.parse(fs.readFileSync(proof, 'utf8'));
        cached = receipt.fingerprint === fingerprint && receipt.exe === digest(executable) && receipt.config === digest(config);
    } catch { }
    if (!cached) {
        fs.mkdirSync(output, { recursive: true });
        const lock = path.join(output, 'build.lock');
        let handle;
        try { handle = fs.openSync(lock, 'wx'); }
        catch { throw Error('工作区管理界面正在构建，请稍后重试；不会回退到旧安装目录'); }
        try {
            if (build) build(output);
            else {
                const result = spawnSync(process.execPath, [path.join(project, 'desktop/scripts/build-collector-center.cjs')], {
                    cwd: project, env: { ...process.env, DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR: output }, windowsHide: true, stdio: 'inherit'
                });
                if (result.error) throw result.error;
                if (result.status !== 0) throw Error('工作区管理界面编译失败；不会打开旧界面');
            }
            if (inputFingerprint(project) !== fingerprint) throw Error('管理界面源码在编译期间改变，请重新启动');
            fs.writeFileSync(proof, JSON.stringify({ fingerprint, exe: digest(executable), config: digest(config), uiOnly: true }));
        } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
    }
    return { executable, fingerprint, reused: cached, uiOnly: true };
}
if (require.main === module) {
    try { const result = ensureWorkspaceCollectorCenter(); console.log('工作区管理界面已就绪：' + result.executable); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { ensureWorkspaceCollectorCenter, inputFingerprint };
