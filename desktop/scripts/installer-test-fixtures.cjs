'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function fixture(t, prefix = 'installer-isolated-') {
    // Hosted Windows runners may expose TEMP using an 8.3 alias while
    // Windows PowerShell 5.1 expands it. Compare one real directory identity,
    // not two spellings; keep the exact path and cleanup assertions.
    const temporaryRoot = fs.realpathSync.native(os.tmpdir());
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryRoot, prefix)));
    const verified = path.resolve(directory);
    if (!verified.startsWith(path.resolve(temporaryRoot) + path.sep)) throw Error('Unsafe fixture directory');
    t.after(() => {
        if (path.resolve(fs.realpathSync.native(directory)) !== verified || !verified.startsWith(path.resolve(temporaryRoot) + path.sep)) throw Error('Unsafe fixture cleanup');
        fs.rmSync(verified, { recursive: true, force: true });
    });
    const programData = path.join(directory, 'program-data');
    fs.mkdirSync(programData);
    const env={...process.env};
    for(const name of Object.keys(env)) if(name.toLowerCase()==='programdata') delete env[name];
    env.ProgramData=programData;
    let sequence = 0;
    function runPowerShell(source, options = {}) {
        const script = path.join(directory, 'probe-' + (++sequence) + '.ps1');
        fs.writeFileSync(script, '\uFEFF' + source, 'utf8');
        const result = spawnSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script], {
            windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
            env, ...options
        });
        return { ...result, text: result.stdout?.toString(options.nsis ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '') || '',
            errorText: result.stderr?.toString('utf8') || '' };
    }
    const helper = '. ' + quote(path.join(root, 'desktop/installer-process.ps1')) + '\n';
    return { directory, programData, runPowerShell, helper };
}
function createInstallerIoFixture(directory) {
    const payload=path.join(directory,'program-fixture');
    for (const name of ['Display.exe','resources/runtime/node.exe','resources/backend/server.js','resources/backend/distribution.json',
        'resources/backend/defaults/factory-dashboard.v1.json','resources/shared/motionPackages.json','resources/templates/factory-template.db']) {
        const file=path.join(payload,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'compile fixture only; never run');
    }
    return require('./installer-io-policy.cjs').createInstallerIoPolicy(root,payload,path.join(directory,'generated-io'));
}
module.exports = { fixture, quote, root, createInstallerIoFixture };
