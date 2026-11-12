// Isolated Windows player acceptance: real loopback Modbus -> collector -> WS -> native transforms.
// No installed runtime, production database, site PLC, or operator window is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const directory = createRunDirectory('motion-native-live');
const checks = [];
let helper, unity;
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function main() {
    assert.equal(process.platform, 'win32', 'native player acceptance requires Windows');
    const file = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'device-animation-ui-server.cjs')], {
        cwd: root, env: { ...process.env, MOTION_NATIVE_SINGLE: '1', MOTION_UI_INFO_FILE: file }, logFile: path.join(directory, 'helper.log')
    });
    await waitUntil(() => fs.existsSync(file), 60000, 'isolated collector');
    const info = JSON.parse(fs.readFileSync(file));
    const headers = { 'content-type': 'application/json', Origin: info.origin, 'x-admin-request': '1',
        Cookie: info.session.cookie, 'x-csrf-token': info.session.csrfToken };
    const request = async (suffix, options = {}) => {
        const reply = await fetch(info.origin + suffix, { ...options, headers });
        const data = await reply.json(); assert.equal(reply.ok, true, JSON.stringify(data)); return data;
    };
    const selected = await request('/api/devices/motion_one/animations');
    const binding = (id, point) => ({ actionId: 'clip:' + id, enabled: true, pointId: point,
        inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 2 });
    await request('/api/devices/motion_one/animations', { method: 'PUT', body: JSON.stringify({ revision: selected.revision,
        // The normal five-second diagnostic cadence cannot observe a two-
        // second stroke. Sample the isolated rig once a second, keeping the
        // intermediate-pose assertion (not just an endpoint/status check).
        config: { version: 1, staleMs: 1500, diagnosticLogging:true, diagnosticIntervalSeconds:1,
            bindings: [binding('door', info.pointIds[0]), binding('pumps', info.pointIds[1])] } }) });
    const exe = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    const log = path.join(directory, 'unity.log');
    unity = spawn(exe, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '800', '-logFile', log], {
        cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore', env: { ...info.env,
            DIGITAL_TWIN_BACKEND_HTTP_URL: info.origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: info.origin.replace('http:', 'ws:') + '/ws',
            DIGITAL_TWIN_ADMIN_URL: info.origin + '/admin', DIGITAL_TWIN_APPLICATION_CHROME: 'false',
            DIGITAL_TWIN_DISABLE_NATIVE_ADMIN_HOST: '1', DEVICE_ANIMATION_DIAGNOSTICS: '1',
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' }
    });
    await authorizeSmokeUnity(info.origin, unity, info.session);
    const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const snapshots = () => readLog().split(/\r?\n/).filter(s => s.startsWith('[DeviceAnimation] ')).map(s => JSON.parse(s.slice(18)));
    async function observed(predicate, name, from = 0) {
        let result;
        await waitUntil(() => { assert.equal(unity.exitCode, null, readLog().slice(-4000));
            result = snapshots().slice(from).find(predicate); return result; }, 90000, name, 100);
        return result;
    }
    const action = (s, id) => s.actions.find(a => a.clipId === id);
    const control = async body => { assert.equal((await fetch(info.control, { method: 'POST', body: JSON.stringify(body) })).ok, true); };
    const closed = await observed(s => action(s, 'door')?.usable && action(s, 'door').position === 0, 'initial native feedback');
    const packageData = JSON.parse(fs.readFileSync(path.join(root, 'backend/assets/motions/cad_cleaner_170700.json')));
    function assertPosition(s, progress) {
        const clip = packageData.clips.find(c => c.id === 'door');
        for (const track of action(s, 'door').tracks) {
            const authored = clip.tracks.find(t => t.node === track.node && t.channel === track.channel);
            const offset = progress * (clip.count - 1), left = Math.floor(offset), right = Math.min(clip.count - 1, left + 1);
            const values = Array.from({ length: authored.size }, (_, i) => authored.values[left * authored.size + i] * (1 - offset + left) + authored.values[right * authored.size + i] * (offset - left));
            if (track.channel === 'p') values[0] *= -1;
            else if (track.channel === 'q') { values[1] *= -1; values[2] *= -1; }
            if (['p', 's', 'v', 'q'].includes(track.channel)) values.forEach((v, i) => assert.ok(Math.abs(v - track.actual[i]) < .0002, track.node));
        }
    }
    assertPosition(closed, 0);
    check('Windows player imports hash-verified motion rig and acquires closed pose from actual collector feedback');
    let from = snapshots().length;
    await control({ door: 1, pump: 1 });
    const intermediate = await observed(s => action(s, 'door')?.usable && action(s, 'door').position > .05 && action(s, 'door').position < .95, 'native intermediate stroke', from);
    assertPosition(intermediate, action(intermediate, 'door').position);
    const open = await observed(s => action(s, 'door')?.usable && action(s, 'door').position > .999, 'native opening endpoint', from);
    assertPosition(open, 1);
    const turning = await observed(s => action(s, 'pumps')?.seconds > action(open, 'pumps').seconds + .5, 'native pump advances', from);
    assert.notDeepEqual(action(open, 'pumps').tracks, action(turning, 'pumps').tracks);
    check('PLC coil opening feedback reaches the same baked door endpoint; pump running feedback advances native geometry');
    from = snapshots().length;
    await control({ offline: true });
    const stopped = await observed(s => action(s, 'door') && !action(s, 'door').usable, 'quality loss suspends native motion', from);
    const still = await observed(s => action(s, 'pumps') && !action(s, 'pumps').usable, 'second suspended sample', snapshots().length);
    assert.equal(action(stopped, 'door').position, action(still, 'door').position);
    assert.equal(action(stopped, 'pumps').seconds, action(still, 'pumps').seconds);
    check('bad quality freezes native mechanical pose and runtime phase rather than inventing motion');
    from = snapshots().length;
    await control({ offline: false, door: 0, pump: 0 });
    const recovered = await observed(s => action(s, 'door')?.usable && action(s, 'door').position === 0, 'fresh recovery and reverse closing', from);
    assertPosition(recovered, 0);
    assert.equal(action(recovered, 'pumps').running, false);
    check('fresh collector recovery closes the native door and stops the pump without restarting the player');
    assert.ok(readLog().includes('[FactoryRuntime] Native factory ready:'));
    assert.equal(/fallback=[1-9]|Exception:|Motion material renderer missing|Motion rig node missing/.test(readLog()), false, 'unexpected native fallback or error');
    assert.equal(snapshots().some(s => s.deviceId !== 'motion_one'), false, 'unbound peer must remain static');
    const proof = await (await fetch(info.control)).json(); assert.ok(proof.reads > 5);
    const report = { success: true, checks, modbusReads: proof.reads, loopbackModbusValidated: true,
        realSitePlcValidated: false, directory, log, snapshots: snapshots().length };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(helper);
});
