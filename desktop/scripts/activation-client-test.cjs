const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createActivationClient, runStartupActivation } = require('../activation.cjs');
async function fixture(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}
function json(response, payload, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); }
function noActivationUi(origin) {
    return { origin, ipcMain: { handle() { throw new Error('must not grant an activation UI'); }, removeHandler() {} },
        clipboard: {}, getWindow: () => null, createWindow: () => { throw new Error('must not create an activation UI'); } };
}
test('startup tolerates a brief activation-service 503 without bypassing the license check', async t => {
    let calls = 0;
    const origin = await fixture(t, (_req, res) => json(res, ++calls === 1 ? { success: false, error: 'owned restart' } : { success: true, enforce: true, valid: true }, calls === 1 ? 503 : 200));
    await runStartupActivation(noActivationUi(origin));
    assert.equal(calls, 2);
});
test('a persistent activation outage remains a bounded startup error, never permission to continue', async t => {
    let calls = 0;
    const origin = await fixture(t, (_req, res) => { calls++; json(res, { success: false, error: 'owned outage' }, 503); });
    await assert.rejects(runStartupActivation(noActivationUi(origin)), /owned outage|服务/);
    assert.equal(calls, 3);
});
test('an unenforced deployment does not submit a stale activation prompt as a new license', async t => {
    let posts = 0;
    const origin = await fixture(t, (req, res) => {
        if (req.method === 'POST') { posts++; json(res, { success: false, error: 'unexpected write' }, 405); }
        else json(res, { success: true, enforce: false, valid: false });
    });
    const result = await createActivationClient(origin).activate('HTA1.owned-fixture');
    assert.equal(result.required, false); assert.equal(posts, 0);
});
test('malformed license flags cannot be mistaken for an activated machine', async t => {
    const origin = await fixture(t, (_req, res) => json(res, { success: true, enforce: 'false', valid: 'true' }));
    await assert.rejects(runStartupActivation(noActivationUi(origin)), /响应无效/);
});

test('smoke activation retries a transient service outage and confirms the real signed result', async t => {
    const crypto = require('node:crypto');
    const { activateFixture } = require('../../tools/activation-test-fixture.cjs');
    const { decodeActivationCode } = require('../../shared/activationCode.cjs');
    const { canonicalize } = require('../../backend/services/license');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let licenseCalls = 0, posts = 0, activated = false;
    const origin = await fixture(t, (req, res) => {
        if (req.url === '/api/license') {
            if (++licenseCalls === 1) return json(res, { success: false, error: 'owned restart' }, 503);
            return json(res, { success: true, enforce: true, valid: activated });
        }
        if (req.method === 'GET') return json(res, { success: true, required: true, token: 'owned-token', machineId: 'machine-owned-smoke' });
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            posts++;
            const document = decodeActivationCode(JSON.parse(body).activationCode);
            const valid = req.headers['x-activation-token'] === 'owned-token'
                && document.payload.machineId === 'machine-owned-smoke'
                && document.payload.bindingVersion === 2
                && crypto.verify(null, Buffer.from(canonicalize(document.payload)), publicKey, Buffer.from(document.signature, 'base64url'));
            activated = valid;
            json(res, { success: valid, valid }, valid ? 200 : 400);
        });
    });
    await activateFixture(origin, privateKey);
    assert.equal(posts, 1);
    assert.equal(activated, true);
    assert.ok(licenseCalls >= 4, 'activation result is checked through the service after installation');
});

test('smoke activation fails after three outages instead of waiving authorization', async t => {
    const { activateFixture } = require('../../tools/activation-test-fixture.cjs');
    let calls = 0;
    const origin = await fixture(t, (_req, res) => { calls++; json(res, { success: false, error: 'owned outage' }, 503); });
    await assert.rejects(activateFixture(origin, null), /owned outage/);
    assert.equal(calls, 3);
});

test('smoke activation never retries or ignores a rejected license', async t => {
    const { activateFixture } = require('../../tools/activation-test-fixture.cjs');
    const { privateKey } = require('node:crypto').generateKeyPairSync('ed25519');
    let posts = 0;
    const origin = await fixture(t, (req, res) => {
        if (req.url === '/api/license') return json(res, { success: true, enforce: true, valid: false });
        if (req.method === 'GET') return json(res, { success: true, required: true, token: 'owned-token', machineId: 'machine-owned-smoke' });
        posts++; json(res, { success: false, error: 'owned rejected signature' }, 400);
    });
    await assert.rejects(activateFixture(origin, privateKey), /owned rejected signature/);
    assert.equal(posts, 1);
});
