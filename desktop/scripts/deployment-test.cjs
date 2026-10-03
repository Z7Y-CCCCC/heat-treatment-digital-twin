const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deploymentFile, normalizeDeployment, readDeployment, resolveDeployment, saveDeployment } = require('../deployment.cjs');

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
        assert.throws(() => resolveDeployment(root, { packaged: true, argv: [], env: { ProgramData: root } }), /尚未安装/);
        await saveDeployment(filename, { mode: 'client', backendOrigin: 'http://127.0.0.1:3001' });
        assert.equal(resolveDeployment(root, { packaged: true, argv: [], env: {} }).mode, 'client');
        fs.writeFileSync(filename, '{broken');
        assert.throws(() => readDeployment(filename), /部署配置无法读取/);
        assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
