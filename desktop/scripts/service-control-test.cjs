const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceControl } = require('../serviceControl.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function response() { return { writeHead(status) { this.status = status; }, end(body) { this.data = JSON.parse(body); } }; }
function fixture(overrides = {}) {
    const queued = [], calls = [];
    const handle = createServiceControl({ restart: async () => { calls.push('restart'); }, openCenter: async () => { calls.push('center'); },
        schedule: action => queued.push(action), ...overrides });
    const request = (method, pathname) => { const result = response(); result.handled = handle({ method }, result, pathname); return result; };
    return { request, queued, calls };
}
test('fixed action whitelist rejects method/body/path tricks without calling any operation', () => {
    const f = fixture();
    for (const [method, path] of [['GET', '/service/unity-restart'], ['POST', '/service/restart?cmd=evil'],
        ['POST', '/service/unity-restart/HOST'], ['POST', '/service/collector-center/../../quit']])
        assert.equal(f.request(method, path).handled, false);
    assert.deepEqual(f.calls, []); assert.equal(f.queued.length, 0);
});
test('restart receipt is accepted, never recovered, before actual new process/readiness confirmation', async () => {
    let resolve;
    const f = fixture({ restart: () => new Promise(r => { resolve = r; }) });
    const accepted = f.request('POST', '/service/unity-restart');
    assert.equal(accepted.status, 202); assert.equal(accepted.data.accepted, true); assert.match(accepted.data.operationId, /^[a-f0-9]{32}$/);
    const route = '/service/unity-restart/' + accepted.data.operationId;
    assert.equal(f.request('GET', route).data.state, 'accepted');
    assert.equal(f.request('POST', '/service/collector-center').status, 409);
    const running = f.queued[0]();
    assert.equal(f.request('GET', route).data.state, 'restarting');
    resolve(); await running;
    assert.equal(f.request('GET', route).data.state, 'ready');
    assert.equal(f.request('GET', '/service/unity-restart/' + 'f'.repeat(32)).status, 404);
});
test('failed restart never reports ready and releases operation mutex', async () => {
    const f = fixture({ restart: async () => { throw new Error('secret-bearing internal path'); } });
    const accepted = f.request('POST', '/service/unity-restart'); await f.queued[0]();
    const result = f.request('GET', '/service/unity-restart/' + accepted.data.operationId);
    assert.deepEqual(result.data, { success: true, state: 'failed' });
    assert.equal(f.request('POST', '/service/unity-restart').status, 202);
});
test('center returns actual spawn failure without leaking command details', async () => {
    const f = fixture({ openCenter: async () => { throw new Error('TOKEN and private location'); } });
    const result = f.request('POST', '/service/collector-center'); await tick(); await tick();
    assert.equal(result.status, 503); assert.equal(result.data.success, false);
    assert.doesNotMatch(JSON.stringify(result.data), /TOKEN|private/);
});
test('center waits for spawn confirmation and blocks duplicate opens', async () => {
    const f = fixture(); const result = f.request('POST', '/service/collector-center');
    assert.equal(result.status, undefined); assert.equal(f.request('POST', '/service/collector-center').status, 409);
    await tick(); assert.equal(result.status, 200); assert.equal(result.data.opened, true); assert.deepEqual(f.calls, ['center']);
});
test('operation receipts expire without affecting work or permitting unknown IDs', () => {
    let now = 1000; const f = fixture({ now: () => now });
    const accepted = f.request('POST', '/service/unity-restart'); now += 120001;
    assert.equal(f.request('GET', '/service/unity-restart/' + accepted.data.operationId).status, 404);
});
test('desktop build includes controller and dispatch stays after loopback private-token gate', () => {
    const fs = require('node:fs'), path = require('node:path');
    const main = fs.readFileSync(path.resolve(__dirname, '../main.cjs'), 'utf8');
    const start = main.slice(main.indexOf('function startDesktopControlServer()'), main.indexOf('function startDesktopControlServer()') + 6600);
    assert.ok(start.indexOf('if (serviceControl(request, response, pathname))') > start.indexOf('suppliedToken !== desktopControlToken'));
    assert.ok(require('../package.json').build.files.includes('serviceControl.cjs'));
    assert.match(main, /await waitForNativeHostReady\(45000\)/);
});
