// Real nodes7 handshake against an owned localhost Snap7 fixture. No site PLC.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { createRunDirectory, findFreePort, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const PlcReader = require('../backend/services/plcReader');
let simulator, reader;
(async () => {
    const directory = createRunDirectory('plc-empty-s7'), root = path.resolve(__dirname, '..');
    const source = process.env.PLC_SIMULATOR_DIR || path.resolve(root, '../PLC仿真调试器');
    const engine = path.join(source, 'snap7_engine.py'), dll = path.join(source, 'runtime/snap7.dll');
    assert.ok(fs.existsSync(engine) && fs.existsSync(dll), 'local Snap7 fixture required');
    const port = await findFreePort(), control = await findFreePort(), closed = await findFreePort();
    simulator = startLoggedProcess(process.env.PYTHON || 'python', [engine, '--snap7-dll', dll, '--bind', '127.0.0.1', '--s7-port', String(port), '--control-port', String(control), '--db', '1:4096'], {
        cwd: source, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', SNAP7_DLL: dll }, logFile: path.join(directory, 'simulator.log') });
    await waitUntil(() => new Promise(resolve => {
        assert.equal(simulator.exitCode, null); const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(300); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('timeout', () => { socket.destroy(); resolve(false); });
    }), 15000, 'owned S7 simulator');
    let reads = 0, frames = 0; reader = new PlcReader(); reader.stopped = false; reader.onData = () => { frames++; };
    reader._readTask = () => { reads++; throw new Error('no-point connection probe attempted a PLC memory read'); };
    function task(id, port) {
        const plc = { enabled: true, protocol: 'S7', ip: '127.0.0.1', port, rack: 0, slot: 1, timeout: 1000, retryInterval: 1000, maxRetries: 0, options: {} };
        const task = reader._getOrCreateTask(id, plc, 10000); task.connectionOnly = true; task.devices[id] = { deviceName: id, points: [] };
        reader.deviceTaskIds.set(id, new Set([id])); reader.deviceStatus.set(id, { ...reader._createBaseDeviceStatus({ id, name: id }, plc), noReadablePoints: true });
        reader._connectTask(task); return task;
    }
    const live = task('empty-live', port); task('empty-offline', closed);
    await waitUntil(() => reader.deviceStatus.get('empty-live').status === 'no_points', 10000, 'real S7 handshake with no tags');
    await waitUntil(() => reader.deviceStatus.get('empty-offline').status === 'offline', 5000, 'refused localhost PLC reports offline');
    assert.ok(reader.deviceStatus.get('empty-live').lastConnectedAt); assert.equal(reader.deviceStatus.get('empty-live').lastReadAt, null); assert.equal(live.conn, null);
    await stopOwnedSmokeProcess(simulator); reader._connectTask(live);
    await waitUntil(() => reader.deviceStatus.get('empty-live').status === 'offline', 5000, 'real S7 loss reports offline');
    assert.equal(reads, 0); assert.equal(frames, 0); reader.stop();
    const result = { success: true, realS7Handshake: true, reads, frames, detectsConnectionLoss: true, realSitePlcValidated: false, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { reader?.stop(); await stopOwnedSmokeProcess(simulator); });
