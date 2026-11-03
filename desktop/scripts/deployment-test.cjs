const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deploymentFile, normalizeDeployment, readDeployment, resolveDeployment, saveDeployment } = require('../deployment.cjs');
test('standalone activation is user-writable but retains a legacy machine anchor when present', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { desktopMachineIdentityFile } = require('../deployment.cjs');
    const env = { ProgramData: path.join(root, 'machine') };
    assert.equal(desktopMachineIdentityFile(root, env), path.join(root, 'machine-identity.json'));
    const legacy = path.join(env.ProgramData, 'HeatTreatmentDigitalTwin', 'machine-identity.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(`${legacy}.bak`, 'retained');
    assert.equal(desktopMachineIdentityFile(root, env), legacy);
});

test('deployment rejects credential-bearing and path-based URLs instead of leaking secrets into Unity arguments', () => {
    for (const backendOrigin of ['file:///etc', 'http://user:secret@server', 'http://server/api', 'http://server/?token=secret']) {
        assert.throws(() => normalizeDeployment({ mode: 'client', backendOrigin }));
    }
    assert.deepEqual(normalizeDeployment({ mode: 'client', backendOrigin: ' https://factory.example:443/ ' }),
        { mode: 'client', backendOrigin: 'https://factory.example' });
    assert.throws(() => normalizeDeployment({ mode: 'server' }));
});

test('saved deployment can be reloaded, never overwrites malformed settings implicitly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-deployment-'));
    try {
        const filename = deploymentFile(root, [], {});
        assert.deepEqual(readDeployment(filename), { mode: 'local' });
        assert.deepEqual(resolveDeployment(root, { packaged: true, argv: [], env: { ProgramData: root } }), { mode: 'local' });
        await saveDeployment(filename, { mode: 'client', backendOrigin: 'http://127.0.0.1:3001' });
        assert.equal(resolveDeployment(root, { packaged: true, argv: [], env: {} }).mode, 'client');
        fs.writeFileSync(filename, '{broken');
        assert.throws(() => readDeployment(filename), /部署配置无法读取/);
        assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Unity development and installed clients share the machine collector configuration, including after stop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-single-collector-'));
    try {
        const machineFile = path.join(root, 'collector-service.json');
        fs.writeFileSync(machineFile, JSON.stringify({ backendOrigin: 'http://127.0.0.1:4567' }));
        const env = { DIGITAL_TWIN_COLLECTOR_CONFIG: machineFile };
        for (const packaged of [true, false]) assert.deepEqual(resolveDeployment(root, { packaged, argv: [], env }),
            { mode: 'client', backendOrigin: 'http://127.0.0.1:4567' });
        await saveDeployment(path.join(root, 'deployment.json'), { mode: 'local' });
        assert.equal(resolveDeployment(root, { packaged: false, argv: [], env }).mode, 'client');
        assert.equal(resolveDeployment(root, { packaged: false, argv: [], env: { ...env, DESKTOP_SMOKE_STANDALONE: 'true' } }).mode, 'local');
        await saveDeployment(path.join(root, 'deployment.json'), { mode: 'display' });
        assert.equal(resolveDeployment(root, { packaged: true, argv: [], env }).mode, 'display', 'explicitly selecting standalone display is not a silent failover');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
