const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const { BACKEND_DIR, REPO_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess,
    requestJson, waitForHttp, waitUntil, waitForExit, forceStop, sleep, percentile } = require('./integration-test-utils.cjs');

const nativeFixtureOnly = process.argv.includes('--native-fixture-only');
const root = createRunDirectory(nativeFixtureOnly ? 'plc-native-fixture' : 'plc-scale');
const simulatorRoot = path.resolve(process.env.PLC_SIMULATOR_DIR || path.join(REPO_DIR, '..', 'PLC仿真调试器'));
const telemetry = path.join(root, 'backend-telemetry.jsonl');
const count = 20, pointCount = 100, durationMs = 180000, intervalMs = 500;
const ids = Array.from({ length: count }, (_, index) => `S7_Load_${String(index + 1).padStart(2, '0')}`);
const points = Array.from({ length: pointCount }, (_, index) => {
    const type = ['BOOL', 'WORD', 'REAL'][index % 3];
    const offset = index * 8;
    return { name: `p${String(index).padStart(3, '0')}`, type, offset, category: type === 'BOOL' ? 'status' : 'analog',
        address: `DB1.${type === 'BOOL' ? `DBX${offset}.0` : type === 'WORD' ? `DBW${offset}` : `DBD${offset}`}` };
});
const changes = new Map();
const expected = (deviceIndex, pointIndex) => changes.has(`${deviceIndex}:${pointIndex}`) ? changes.get(`${deviceIndex}:${pointIndex}`) : pointIndex % 3 === 0 ? (deviceIndex + pointIndex) % 2 === 0
    : deviceIndex * 100 + pointIndex + (pointIndex % 3 === 2 ? .125 : 0);
const simulators = [];
const endpoints = [];
let backend, socket, baseUrl, latest, frames = 0, invalidMessages = 0;
const frameTimes = [];
const deviceSnapshots = new Map();
const checks = {};
const phase = {};
let result;

async function seed(index) {
    for (let p = 0; p < points.length; p++) {
        const point = points[p];
        await requestJson(`http://127.0.0.1:${endpoints[index].control}/value`, { method: 'POST',
            body: JSON.stringify({ area: 'DB', db: 1, offset: point.offset, type: point.type.toLowerCase(), bit: 0, value: expected(index, p) }) });
    }
}

async function launchSimulator(index) {
    const endpoint = endpoints[index];
    simulators[index] = startLoggedProcess(process.env.PYTHON || 'python', [path.join(simulatorRoot, 'snap7_engine.py'),
        '--snap7-dll', path.join(simulatorRoot, 'runtime/snap7.dll'), '--bind', '127.0.0.1',
        '--s7-port', String(endpoint.s7), '--control-port', String(endpoint.control), '--max-clients', '4', '--db', '1:4096'],
    { cwd: simulatorRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }, logFile: path.join(root, `s7-${index}.log`) });
    await waitForHttp(`http://127.0.0.1:${endpoint.control}/health`, 15000);
    await seed(index);
}

function inspectFrame(frame, excluded = -1, checkValues = true) {
    const devices = new Map((frame?.message?.payload?.devices || []).map(device => [device.furnace_id, device]));
    let good = 0;
    for (let d = 0; d < count; d++) {
        if (d === excluded) continue;
        const device = devices.get(ids[d]);
        for (let p = 0; p < points.length; p++) {
            const point = points[p];
            if (device?.quality?.[point.category]?.[point.name] === 'good'
                && (!checkValues || device?.[point.category]?.[point.name] === expected(d, p))) good++;
        }
    }
    return good;
}

async function connect(port) {
    deviceSnapshots.clear();
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on('message', raw => {
        try {
            const message = JSON.parse(String(raw));
            if (message.type === 'realtime_frame') {
                const receivedAt = Date.now();
                for (const device of message.payload.devices) deviceSnapshots.set(device.furnace_id, { ...device, receivedAt });
                latest = { receivedAt, message: { ...message, payload: { ...message.payload, devices: [...deviceSnapshots.values()] } } };
                frames++; frameTimes.push(receivedAt);
            }
        } catch { invalidMessages++; }
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
}

async function launchBackend(port) {
    backend = startLoggedProcess(process.execPath, ['--require', path.join(__dirname, 'plc-load-telemetry.cjs'), path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
            APP_DATA_DIR: path.join(root, 'data'), PLC_LOAD_METRICS_FILE: telemetry, PLC_OFFLINE_AFTER_MS: '4000',
            SITE_BACKUP_AUTO_ENABLED: 'false', DESKTOP_SHUTDOWN_TOKEN: 'plc-scale-isolated-shutdown' },
        logFile: path.join(root, 'backend.log') });
    await waitForHttp(`${baseUrl}/api/health`, 30000);
    await connect(port);
    await waitUntil(() => inspectFrame(latest) === count * pointCount, 30000, 'all 2000 real S7 values and qualities');
}

async function stopBackend() {
    socket?.terminate(); socket = null;
    if (backend && backend.exitCode === null) {
        await requestJson(`${baseUrl}/api/internal/shutdown`, { method: 'POST', headers: { 'x-shutdown-token': 'plc-scale-isolated-shutdown' } });
        await waitForExit(backend, 30000);
    }
}

// Diagnostic fixture mode keeps the exact same physical TCP workload without
// repeating or claiming the separate three-minute scale/outage acceptance run.
async function holdForNative(databaseFile, port) {
    const startedAt = Date.now();
    let deadline = startedAt + 900000, samples = 0, badSamples = 0, backendRestarts = 0;
    const stopFile = path.join(root, 'NATIVE-DONE');
    const restartFile = path.join(root, 'RESTART-BACKEND');
    const publish = () => {
        fs.writeFileSync(path.join(root, 'ready-for-native.json'), JSON.stringify({ origin: baseUrl, directory: root,
            databaseFile, readyAt: new Date().toISOString(), stopFile, restartFile, backendRestarts,
            mode: nativeFixtureOnly ? 'native-fixture-only' : 'full-scale-with-native-hold' }, null, 2));
        console.log(JSON.stringify({ phase: 'ready-for-native', root, origin: baseUrl, stopFile, restartFile, backendRestarts }));
    };
    publish();
    while (!fs.existsSync(stopFile) && Date.now() < deadline) {
        await sleep(1000);
        if (fs.existsSync(restartFile)) {
            fs.rmSync(restartFile);
            await stopBackend(); latest = null;
            await launchBackend(port); backendRestarts++;
            deadline = Date.now() + 900000; publish();
        }
        samples++;
        if (inspectFrame(latest) !== 2000 || [...deviceSnapshots.values()].some(device => Date.now() - device.receivedAt > 3000)) badSamples++;
    }
    return { startedAt, endedAt: Date.now(), samples, badSamples, backendRestarts };
}

async function main() {
    const startedAt = Date.now();
    try {
        assert.ok(fs.existsSync(path.join(simulatorRoot, 'snap7_engine.py')));
        for (let i = 0; i < count; i++) endpoints.push({ s7: await findFreePort(12102 + i), control: await findFreePort(12202 + i) });
        assert.equal(new Set(endpoints.map(endpoint => endpoint.s7)).size, count);
        const port = await findFreePort(3641); baseUrl = `http://127.0.0.1:${port}`;
        const databaseFile = path.join(root, 'data/factory.db');
        await createTestDatabase(databaseFile);
        const db = new Database(databaseFile);
        try {
            db.exec('PRAGMA foreign_keys=OFF');
            const model = db.prepare('SELECT * FROM devices ORDER BY id LIMIT 1').get();
            const columns = Object.keys(model);
            const insertDevice = db.prepare(`INSERT INTO devices (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
            const insertPoint = db.prepare(`INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,quality,scale,offset,sample_interval_ms,access_type,point_kind) VALUES (?,?,?,?,?,?,?,'good',1,0,?,'READ','normal')`);
            db.transaction(() => {
                db.exec('DELETE FROM data_points; DELETE FROM devices');
                db.prepare("INSERT INTO settings (`key`,value) VALUES ('data_mode','integrated_plc') ON CONFLICT(`key`) DO UPDATE SET value=excluded.value").run();
                db.prepare("UPDATE factory_settings SET value='integrated_plc' WHERE `key`='data_mode'").run();
                for (let d = 0; d < count; d++) {
                    const device = { ...model, id: ids[d], name: `S7负载设备${d + 1}`, plc_enabled: 1, plc_protocol: 'S7',
                        plc_ip: '127.0.0.1', plc_port: endpoints[d].s7, plc_rack: 0, plc_slot: 1,
                        plc_timeout: 3000, plc_retry_interval: 500, plc_max_retries: 0 };
                    insertDevice.run(...columns.map(name => device[name]));
                    for (const point of points) insertPoint.run(ids[d], point.name, point.name, point.address, point.type, point.category, point.name, intervalMs);
                }
            })();
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM data_points').get().n, 2000);
        } finally { db.close(); }
        fs.writeFileSync(path.join(root, 'data/database-config.json'), JSON.stringify({ type: 'sqlite', filename: databaseFile }));
        fs.writeFileSync(path.join(root, 'data/data-sources.json'), JSON.stringify({ connections: [], backup: { autoEnabled: false, startupEnabled: false, shutdownEnabled: false, selectedConnectionIds: [] } }));
        // Four startup workers bound Python/control traffic while all 20 servers stay independent.
        let next = 0;
        await Promise.all(Array.from({ length: 4 }, async () => { while (next < count) await launchSimulator(next++); }));
        await launchBackend(port);
        checks.all2000InitialValuesAndQualities = true;
        const connected = await Promise.all(endpoints.map(endpoint => requestJson(`http://127.0.0.1:${endpoint.control}/health`)));
        const clientCounts = connected.map(value => Number(value.clients ?? value.simulator?.clients ?? 0));
        assert.ok(clientCounts.every(value => value >= 1), JSON.stringify(connected[0]));
        checks.twentyIndependentTcpEndpointsConnected = true;
        if (nativeFixtureOnly) {
            const hold = await holdForNative(databaseFile, port);
            checks.nativeFixtureAllPointSamplesGood = hold.badSamples === 0;
            checks.noInvalidWebsocketMessages = invalidMessages === 0;
            await stopBackend();
            result = { success: Object.values(checks).every(Boolean), mode: 'native-fixture-only', root,
                checks, hold, topology: { devices: count, pointsPerDevice: pointCount, totalPoints: count * pointCount,
                    tcpEndpoints: count, sampleIntervalMs: intervalMs, loopbackOnly: true },
                artifacts: { telemetry, backendLog: path.join(root, 'backend.log') },
                limits: ['诊断联动夹具；本模式不重复三分钟稳态、故障或重启性能验收', '2000点值与质量来自真实TCP采集；Unity行为必须用独立原生日志验收'] };
            if (!result.success) process.exitCode = 1;
            return;
        }
        console.log(JSON.stringify({ phase: 'steady-start', root, devices: count, points: count * pointCount, clientCounts }));
        phase.steadyStart = Date.now();
        let badSamples = 0, samples = 0;
        const dynamicLatencies = [];
        while (Date.now() - phase.steadyStart < durationMs) {
            await sleep(1000); samples++;
            if (samples % 10 === 0) {
                const sentAt = Date.now();
                for (let d = 0; d < count; d++) changes.set(`${d}:1`, 30000 + samples + d);
                await Promise.all(endpoints.map((endpoint, d) => requestJson(`http://127.0.0.1:${endpoint.control}/value`, { method: 'POST',
                    body: JSON.stringify({ area: 'DB', db: 1, offset: points[1].offset, type: 'word', value: expected(d, 1) }) })));
                await waitUntil(() => inspectFrame(latest) === 2000, 3000, 'all 20 changed sentinels arrive over real TCP');
                dynamicLatencies.push(Date.now() - sentAt);
            }
            if (inspectFrame(latest) !== count * pointCount || Date.now() - latest.receivedAt > 1500) badSamples++;
            if (samples % 30 === 0) console.log(JSON.stringify({ phase: 'steady', seconds: samples, badSamples }));
        }
        phase.steadyEnd = Date.now();
        checks.steadyAllValuesGood = badSamples === 0;
        phase.outageStart = Date.now();
        await forceStop(simulators[0]); simulators[0] = null;
        await waitUntil(() => {
            const device = latest?.message?.payload?.devices.find(item => item.furnace_id === ids[0]);
            return points.every(point => device?.quality?.[point.category]?.[point.name] === 'bad');
        }, 15000, '100 points bad on only the disconnected device');
        phase.outageBadAt = Date.now();
        assert.equal(inspectFrame(latest, 0), 1900);
        checks.singleEndpointOutagePreservesOther1900Points = true;
        await sleep(5000);
        assert.equal(inspectFrame(latest, 0), 1900);
        phase.reconnectStart = Date.now();
        await launchSimulator(0);
        await waitUntil(() => latest.receivedAt > phase.reconnectStart && inspectFrame(latest) === 2000, 30000, '2000 values restored after PLC reconnect');
        phase.reconnectReady = Date.now(); checks.allPointsRecoveredAfterPlcRestart = true;
        await requestJson(`${baseUrl}/api/settings`, { method: 'PUT', body: JSON.stringify({ plc_scale_persistence_marker: 'saved-before-restart' }) });
        await stopBackend(); latest = null;
        phase.backendRestartStart = Date.now();
        await launchBackend(port);
        phase.backendRestartReady = Date.now();
        const settings = await requestJson(`${baseUrl}/api/settings`);
        assert.equal(settings.plc_scale_persistence_marker, 'saved-before-restart');
        checks.backendRestartRetainsConfigurationAnd2000Reads = true;
        await sleep(15000);
        assert.equal(inspectFrame(latest), 2000);
        if (process.argv.includes('--hold-for-native')) {
            await holdForNative(databaseFile, port);
        }
        await stopBackend();
        const rows = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const stable = rows.filter(row => row.timestamp > phase.steadyStart + 5000 && row.timestamp < phase.steadyEnd);
        const stableFrames = frameTimes.filter(time => time >= phase.steadyStart && time <= phase.steadyEnd);
        const gaps = stableFrames.slice(1).map((time, index) => time - stableFrames[index]);
        const first = stable[0], last = stable.at(-1);
        const readBatches = last.readBatches - first.readBatches;
        const readFailures = last.readFailures - first.readFailures;
        checks.steadyReadFailureRateZero = readFailures === 0;
        checks.framesWithin1500Ms = Math.max(...gaps) <= 1500;
        checks.noInvalidWebsocketMessages = invalidMessages === 0;
        result = { success: Object.values(checks).every(Boolean), root, startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(), hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemoryGiB: os.totalmem() / 1024 ** 3 },
            topology: { devices: count, pointsPerDevice: pointCount, totalPoints: count * pointCount, tcpEndpoints: count,
                simulatorProcesses: count, sampleIntervalMs: intervalMs, pointTypes: { BOOL: 34, WORD: 33, REAL: 33 }, loopbackOnly: true, database: 'isolated SQLite' },
            checks, phases: phase, samples, badSamples, frames,
            steady: { durationMs: phase.steadyEnd - phase.steadyStart, readBatches, readFailures, readFailureRate: readFailures / Math.max(1, readBatches + readFailures),
                dynamicSentinelChanges: dynamicLatencies.length * count, dynamicAllDevicesP95Ms: percentile(dynamicLatencies, 95),
                measuredReadPointsPerSecond: (last.readPoints - first.readPoints) / ((last.timestamp - first.timestamp) / 1000),
                frames: stableFrames.length, frameGapP95Ms: percentile(gaps, 95), maxFrameGapMs: Math.max(...gaps),
                backendRssPeakMiB: Math.max(...stable.map(row => row.rss)) / 1024 ** 2,
                backendCpuHostAveragePercent: stable.reduce((sum, row) => sum + row.cpuPercentHost, 0) / stable.length,
                backendCpuOneCoreAveragePercent: stable.reduce((sum, row) => sum + row.cpuPercentOneCore, 0) / stable.length,
                eventLoopP99WorstWindowMs: Math.max(...stable.map(row => row.eventLoopP99Ms)),
                eventLoopMaxMs: Math.max(...stable.map(row => row.eventLoopMaxMs)) },
            limits: ['本机TCP模拟PLC；没有现场网络时延/电磁干扰/真实PLC扫描负载', '后端数据链路；不等于Unity/GPU/电视验收', '三分钟稳态，不是72小时稳定性证明'],
            artifacts: { telemetry, backendLog: path.join(root, 'backend.log') } };
        if (!result.success) process.exitCode = 1;
    } catch (error) { result = { success: false, root, checks, phases: phase, diagnostics: { goodPoints: inspectFrame(latest), devices: latest?.message?.payload?.devices.slice(0, 2) }, error: error.stack || error.message }; process.exitCode = 1; }
    finally {
        socket?.terminate(); await forceStop(backend);
        await Promise.all(simulators.map(child => forceStop(child)));
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
