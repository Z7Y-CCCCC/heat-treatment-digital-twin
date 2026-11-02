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
