'use strict';
// Actual newly built Windows player + catalog-bound source -> native transforms.
// The executable is mandatory and must live in the workspace's isolated output/.
// Uses injected read-only observations: no collector, physical PLC or installed service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const checks = [];
const evidence = [];
let directory, helper, unity;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pass = label => { checks.push(label); console.log('PASS ' + label); };
async function main() {
    assert.equal(process.platform, 'win32', 'native acceptance requires Windows');
    assert.ok(process.env.MOTION_TEST_UNITY_EXE, 'Set MOTION_TEST_UNITY_EXE to the freshly built isolated output/ player. There is deliberately no installed/default fallback.');
    const exe = requireTestPath(path.resolve(process.env.MOTION_TEST_UNITY_EXE));
    assert.ok(/\.exe$/i.test(exe) && fs.statSync(exe).isFile(), 'expected an isolated Windows player executable');
    const assembly = requireTestPath(path.join(path.dirname(exe), path.parse(exe).name + '_Data', 'Managed', 'Assembly-CSharp.dll'));
    const beforeExe = hash(exe), beforeAssembly = hash(assembly);
    directory = createRunDirectory('motion-data-native-player');
    const infoFile = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'motion-authoring-ui-server.cjs')], {
        cwd: root,
        env: { ...process.env, MOTION_AUTHORING_INFO_FILE: infoFile, MOTION_TEST_IMPORT_ASSET: '', MOTION_TEST_IMPORT_HALL: '' },
        logFile: path.join(directory, 'backend.log')
    });
    await waitUntil(() => { assert.equal(helper.exitCode, null, 'owned fixture backend exited'); return fs.existsSync(infoFile); }, 60000, 'isolated read-only motion backend');
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    requireTestPath(info.directory); requireTestPath(info.database); requireTestPath(info.env.APP_DATA_DIR);
    const origin = new URL(info.origin), controlUrl = new URL(info.control);
    assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(controlUrl.protocol, 'http:'); assert.equal(controlUrl.hostname, '127.0.0.1');
    const headers = { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie, 'X-CSRF-Token': info.session.csrfToken };
    const api = async (route, method = 'GET', body) => {
        const response = await fetch(info.origin + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
        const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
    };
    const control = async body => {
        const response = await fetch(info.control, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        assert.equal(response.ok, true, 'isolated source control failed');
        const state = await response.json(); evidence.push({ event: 'source-control', at: Date.now(), state }); return state;
    };
    const route = `/api/models/${info.modelId}/motion-actions`, model = await api(route);
    const moving = model.nodes.find(node => node.name.endsWith('roller_bed_metal'));
    const rotating = model.nodes.find(node => node.name.endsWith('levelling_metal'));
    assert.ok(moving && rotating && moving.id !== rotating.id, 'isolated model must expose two distinct movable nodes');
    const track = (node, operation, to) => ({ nodeId: node.id, operation, axis: operation === 'rotate' ? 'z' : 'y', from: 0, to, start: 0, end: 1, easing: 'linear', pivot: [0, 0, 0], fromColor: '#000000', toColor: '#ffffff' });
    const positionAction = { id: 'user_data_position', label: '数据条件 · 承料台行程', mode: 'position', duration: 2, cycle: 'forward', tracks: [track(moving, 'translate', .4)] };
    const runningAction = { id: 'user_data_running', label: '数据条件 · 连续转动', mode: 'running', duration: 2, cycle: 'forward', tracks: [track(rotating, 'rotate', 360)] };
    const authored = await api(route, 'PUT', { revision: model.revision, actions: [positionAction, runningAction] });
    const clipResponse = await fetch(info.origin + authored.bundle.clipPath, { signal: AbortSignal.timeout(15000) });
    assert.ok(clipResponse.ok); const packageData = await clipResponse.json();
    const catalog = await api('/api/data-center/catalog?device_id=' + encodeURIComponent(info.deviceId));
    const item = catalog.items.find(row => row.binding?.mode === 'plc' && String(row.binding.pointId) === info.pointId && row.type === 'number');
    assert.ok(item, 'the real catalog must contain the fixture source point as a numeric data item');
    const deviceRoute = `/api/devices/${info.deviceId}/animations`, initial = await api(deviceRoute);
    const trigger = { mode: 'condition', operator: 'gte', value: .5, hysteresis: .1 };
    const bindings = [positionAction, runningAction].map(action => ({ actionId: 'clip:' + action.id, dataItemId: item.id, trigger, enabled: true, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: action.mode === 'position' ? .25 : 0 }));
    const saved = await api(deviceRoute, 'PUT', { revision: initial.revision, config: { version: 1, staleMs: 1000, bindings } });
    for (const row of saved.config.bindings) { assert.equal(row.dataItemId, item.id); assert.deepEqual(row.trigger, trigger); }
    pass('newly authored independent position/running clips bind a numeric data-center item and condition through the actual save API');
    const log = path.join(directory, 'unity.log');
    unity = spawn(exe, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '800', '-logFile', log], {
        cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore',
        env: { ...info.env, DIGITAL_TWIN_BACKEND_HTTP_URL: info.origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: info.origin.replace('http:', 'ws:') + '/ws', DIGITAL_TWIN_ADMIN_URL: info.origin + '/admin', DIGITAL_TWIN_APPLICATION_CHROME: 'false', DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false', DIGITAL_TWIN_DISABLE_NATIVE_ADMIN_HOST: '1', DEVICE_ANIMATION_DIAGNOSTICS: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' }
    });
    unity.once('error', error => { evidence.push({ event: 'native-spawn-error', error: error.message }); });
    await authorizeSmokeUnity(info.origin, unity, info.session);
    const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const snapshots = () => readLog().split(/\r?\n/).flatMap(line => {
        if (!line.startsWith('[DeviceAnimation] ')) return [];
        try { const sample = JSON.parse(line.slice(18)); return sample.deviceId === info.deviceId ? [sample] : []; } catch { return []; } // Last log line may still be being written.
    });
    const selected = (snapshot, action) => snapshot.actions.find(row => row.clipId === action.id);
    async function observe(predicate, label, from = 0) {
        let result;
        await waitUntil(() => {
            assert.equal(unity.exitCode, null, readLog().slice(-4500)); assert.equal(helper.exitCode, null, 'owned fixture exited');
            result = snapshots().slice(from).find(sample => selected(sample, positionAction) && selected(sample, runningAction) && predicate(sample));
            return result;
        }, 90000, label, 100);
        evidence.push({ event: label, sample: result }); return result;
    }
    function poseMatches(actual, action, progress) {
        const clip = packageData.clips.find(row => row.id === action.id); assert.ok(clip);
        assert.equal(actual.tracks.length, clip.tracks.length);
        for (const row of actual.tracks) {
            const t = clip.tracks.find(value => value.node === row.node && value.channel === row.channel); assert.ok(t);
            const offset = Math.max(0, Math.min(1, progress)) * (clip.count - 1), left = Math.floor(offset), right = Math.min(clip.count - 1, left + 1), ratio = t.channel === 'v' ? 0 : offset - left;
            let sign = 1;
            if (t.channel === 'q') {
                const dot = Array.from({ length: t.size }, (_, i) => t.values[left * t.size + i] * t.values[right * t.size + i]).reduce((a, b) => a + b, 0); if (dot < 0) sign = -1;
            }
            const expected = Array.from({ length: t.size }, (_, i) => t.values[left * t.size + i] * (1 - ratio) + sign * t.values[right * t.size + i] * ratio);
            if (t.channel === 'p') expected[0] *= -1;
            if (t.channel === 'q') { expected[1] *= -1; expected[2] *= -1; const length = Math.hypot(...expected); expected.forEach((v, i) => { expected[i] = v / length; }); }
            expected.forEach((value, i) => assert.ok(Math.abs(value - row.actual[i]) < .0003, `${action.id}/${row.node}/${row.channel}/${i}: ${value} != ${row.actual[i]}`));
        }
    }
    function both(sample, predicate) { return [positionAction, runningAction].every(action => predicate(selected(sample, action))); }
    function frozen(a, b) {
        for (const action of [positionAction, runningAction]) {
            const before = selected(a, action), after = selected(b, action);
            assert.equal(after.position, before.position); assert.equal(after.seconds, before.seconds); assert.deepEqual(after.tracks, before.tracks);
        }
    }
    const closed = await observe(sample => both(sample, row => row.usable && row.target === 0 && row.position === 0 && !row.running), 'fresh numeric zero observation');
    poseMatches(selected(closed, positionAction), positionAction, 0);
    pass('fresh source zero initializes the native geometry at its observed inactive endpoint');
    let from = snapshots().length;
    await control({ value: .51 });
    const intermediate = await observe(sample => both(sample, row => row.usable && row.target === 1 && row.running) && selected(sample, positionAction).position > 0 && selected(sample, positionAction).position < 1, 'crossing .5 starts the actual native stroke', from);
    poseMatches(selected(intermediate, positionAction), positionAction, selected(intermediate, positionAction).position);
    const opened = await observe(sample => both(sample, row => row.usable && row.target === 1 && row.running) && selected(sample, positionAction).position === 1, 'native active endpoint', from);
    poseMatches(selected(opened, positionAction), positionAction, 1);
    const turning = await observe(sample => selected(sample, runningAction).usable && selected(sample, runningAction).seconds > selected(opened, runningAction).seconds + .4, 'running clip advances native rotation', snapshots().length);
    assert.notDeepEqual(selected(opened, runningAction).tracks, selected(turning, runningAction).tracks);
    const runningClip = packageData.clips.find(row => row.id === runningAction.id);
    poseMatches(selected(turning, runningAction), runningAction, (selected(turning, runningAction).seconds % runningClip.duration) / runningClip.duration);
    pass('0.51 reaches the configured 0.5 threshold; position and running native transforms match compiled samples');
    from = snapshots().length;
    await control({ value: .45 });
    const held = await observe(sample => both(sample, row => row.usable && row.target === 1 && row.running) && selected(sample, runningAction).seconds > selected(turning, runningAction).seconds + .5, 'single-sided hysteresis retains .45', from);
    poseMatches(selected(held, positionAction), positionAction, 1);
    pass('0.45 remains active inside the reverse hysteresis band, without requiring 0.6 to start');
    from = snapshots().length;
    await control({ value: .39 });
    const released = await observe(sample => both(sample, row => row.usable && row.target === 0 && !row.running) && selected(sample, positionAction).position === 0, '0.39 releases condition and reverses the native stroke', from);
    poseMatches(selected(released, positionAction), positionAction, 0);
    const still = await observe(sample => sample.capturedAt > released.capturedAt + 450 && both(sample, row => row.usable && row.target === 0 && !row.running), 'inactive native rotation holds its phase', snapshots().length);
    assert.equal(selected(still, runningAction).seconds, selected(released, runningAction).seconds);
    assert.deepEqual(selected(still, runningAction).tracks, selected(released, runningAction).tracks);
    pass('0.39 releases the condition; position returns to the observed inactive endpoint and running geometry stops');
    from = snapshots().length;
    await control({ value: .51 });
    await observe(sample => both(sample, row => row.usable && row.target === 1 && row.running) && selected(sample, positionAction).position === 1, 'active pose before bad source', from);
    from = snapshots().length;
    await control({ offline: true });
    const bad = await observe(sample => both(sample, row => !row.usable && row.reason === '数据无效'), 'bad source quality freezes native channels', from);
    const badStill = await observe(sample => sample.capturedAt > bad.capturedAt + 500 && both(sample, row => !row.usable), 'bad source remains frozen', snapshots().length);
    frozen(bad, badStill); poseMatches(selected(badStill, positionAction), positionAction, 1);
    pass('bad-quality observations freeze native position, runtime phase and actual channel values');
    from = snapshots().length;
    await control({ offline: false, value: .51 });
    const recovered = await observe(sample => both(sample, row => row.usable && row.target === 1 && row.running) && selected(sample, positionAction).position === 1 && selected(sample, runningAction).seconds > selected(bad, runningAction).seconds, 'fresh recovery resumes existing phase', from);
    assert.ok(selected(recovered, runningAction).seconds >= selected(bad, runningAction).seconds, 'recovery must never restart the running phase');
    from = snapshots().length;
    await control({ paused: true });
    const stale = await observe(sample => both(sample, row => !row.usable && row.reason === '数据超时'), 'actual source expires despite catalog-only broadcasts', from);
    const staleStill = await observe(sample => sample.capturedAt > stale.capturedAt + 700 && both(sample, row => !row.usable), 'source timeout keeps native pose frozen', snapshots().length);
    frozen(stale, staleStill); poseMatches(selected(staleStill, positionAction), positionAction, 1);
    pass('pausing real observations expires the source; background catalog refreshes do not falsely renew PLC motion lifetime');
    from = snapshots().length;
    await control({ paused: false, value: 0 });
    const final = await observe(sample => both(sample, row => row.usable && row.target === 0 && !row.running) && selected(sample, positionAction).position === 0, 'fresh zero recovery follows actual feedback', from);
    poseMatches(selected(final, positionAction), positionAction, 0);
    pass('fresh recovery follows current source feedback without process restart or synthesized success status');
    assert.equal(hash(exe), beforeExe, 'test must not rewrite the executable');
    assert.equal(hash(assembly), beforeAssembly, 'test must not rewrite the managed player assembly');
    assert.ok(readLog().includes('[FactoryRuntime] Native factory ready:'), 'real native factory must have loaded');
    assert.equal(/fallback=[1-9]|Exception:|Motion rig node missing|Motion clip missing|Motion material renderer missing/.test(readLog()), false, readLog().slice(-4500));
    pass('the output-only executable and its managed runtime remain hash-identical throughout data/action authoring and playback');
    const result = { success: true, checks, directory, log, executable: exe, exeSha256: beforeExe, managedAssemblySha256: beforeAssembly, unchangedExecutable: true, noCollectorOrRealPlc: true, installedRuntimeUsed: false, snapshots: snapshots().length, dataItemId: item.id, trigger, evidence };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: true, directory, checks: checks.length, snapshots: result.snapshots }, null, 2));
}
main().catch(error => {
    if (directory) fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, checks, directory, error: error.stack || error.message, evidence }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(helper); });
