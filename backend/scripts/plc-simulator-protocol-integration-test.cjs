const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const WebSocket = require('ws');
const {
    BACKEND_DIR,
    REPO_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    percentile,
    requestJson,
    sleep,
    startLoggedProcess,
    waitForExit,
    waitForHttp,
    waitUntil
} = require('./integration-test-utils.cjs');

const SIMULATOR_DIR = path.resolve(
    process.env.PLC_SIMULATOR_DIR || path.join(REPO_DIR, '..', 'PLC仿真调试器')
);
const PYTHON = process.env.PYTHON || 'python';
const MODBUS_ENGINE = path.join(SIMULATOR_DIR, 'modbus_engine.py');
const OPCUA_ENGINE = path.join(SIMULATOR_DIR, 'opcua_engine.py');
const MODBUS_DEVICE = 'Furnace_01';
const OPCUA_DEVICE = 'Furnace_02';
const MODBUS_POINTS = {
    temperature: { node: 'HR40001', area: 'holding', offset: 0, type: 'word', field: 'actual_temp', unit: '℃' },
    pressure: { node: 'HR40002', area: 'holding', offset: 1, type: 'real', field: 'pressure', unit: 'bar' },
    running: { node: 'C00001', area: 'coil', offset: 0, type: 'bool', field: 'running', category: 'status' },
    byte: { node: 'HR40004', area: 'holding', offset: 3, type: 'byte', field: 'boundary_byte' },
    int: { node: 'HR40005', area: 'holding', offset: 4, type: 'int', field: 'boundary_int' },
    dword: { node: 'HR40006', area: 'holding', offset: 5, type: 'dword', field: 'boundary_dword' },
    dint: { node: 'HR40008', area: 'holding', offset: 7, type: 'dint', field: 'boundary_dint' }
};
const OPCUA_POINTS = {
    temperature: { node: 'ns=2;s=Factory.Furnace02.Temperature', type: 'real', field: 'actual_temp', unit: '℃' },
    running: { node: 'ns=2;s=Factory.Furnace02.Running', type: 'bool', field: 'running', category: 'status' },
    byte: { node: 'ns=2;s=Factory.Furnace02.Byte', type: 'byte', field: 'boundary_byte' },
    word: { node: 'ns=2;s=Factory.Furnace02.Word', type: 'word', field: 'boundary_word' },
    int: { node: 'ns=2;s=Factory.Furnace02.Int', type: 'int', field: 'boundary_int' },
    dword: { node: 'ns=2;s=Factory.Furnace02.Dword', type: 'dword', field: 'boundary_dword' },
    dint: { node: 'ns=2;s=Factory.Furnace02.Dint', type: 'dint', field: 'boundary_dint' }
};
const INITIAL_MODBUS_VALUES = { temperature: 1200, pressure: 12.5, running: true, byte: 17, int: -123, dword: 305419896, dint: -123456789 };
const INITIAL_OPCUA_VALUES = { temperature: 860.5, running: true, byte: 23, word: 2345, int: -234, dword: 591751049, dint: -234567890 };
const RECOVERED_MODBUS_VALUES = { temperature: 1500, pressure: -25.25, running: false, byte: 42, int: -1234, dword: 4000000000, dint: -2000000000 };
const RECOVERED_OPCUA_VALUES = { temperature: 900.5, running: false, byte: 43, word: 54321, int: -2345, dword: 3000000000, dint: -1900000000 };
const TYPE_BOUNDARIES = {
    bool: [false, true],
    byte: [0, 255],
    word: [0, 65535],
    int: [-32768, 0, 32767],
    dword: [0, 4294967295],
    dint: [-2147483648, 0, 2147483647],
    // 0.125 is exactly representable as Float32: any rounding is a pipeline loss.
    real: [-12.5, 0, 123.75, 0.125]
};
const SHUTDOWN_TOKEN = `plc-simulator-protocol-${process.pid}-${Date.now()}`;

let runDirectory;
let backend;
let backendOrigin;
let modbusSimulator;
let opcuaSimulator;
let socket;

function configureDatabase(filename, modbusPort, opcuaPort) {
    const db = new Database(filename);
    try {
        const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(column => column.name));
        if (!deviceColumns.has('plc_options')) db.exec("ALTER TABLE devices ADD COLUMN plc_options TEXT DEFAULT '{}'");
        db.transaction(() => {
            db.prepare("INSERT INTO settings (key, value) VALUES ('data_mode', 'integrated_plc') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
            db.prepare('UPDATE devices SET plc_enabled=0').run();
            db.prepare(`UPDATE devices SET
                plc_enabled=1, plc_protocol='MODBUS_TCP', plc_ip='127.0.0.1', plc_port=?,
                plc_timeout=3000, plc_retry_interval=500, plc_max_retries=0,
                plc_options=? WHERE id=?`).run(
                modbusPort,
                JSON.stringify({ unitId: 1, addressBase: 1, byteOrder: 'BE', wordOrder: 'BE' }),
                MODBUS_DEVICE
            );
            db.prepare(`UPDATE devices SET
                plc_enabled=1, plc_protocol='OPC_UA', plc_ip='127.0.0.1', plc_port=?,
                plc_timeout=5000, plc_retry_interval=500, plc_max_retries=0,
                plc_options=? WHERE id=?`).run(
                opcuaPort,
                JSON.stringify({
                    endpointPath: '/UA/PLC-Simulator',
                    securityMode: 'None',
                    securityPolicy: 'None',
                    trustServerCertificate: false
                }),
                OPCUA_DEVICE
            );
            db.prepare('DELETE FROM data_points').run();
            const insert = db.prepare(`INSERT INTO data_points (
                device_id, name, label, plc_tag, data_type, unit, category, value_role,
                quality, scale, offset, expression, display_format, sample_interval_ms,
                access_type, point_kind, alarm_record_role, alarm_level, alarm_condition
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', 1, 0, '', '', ?, 'READ', 'normal', '', 'WARNING', '=1')`);
            for (const [deviceId, prefix, points] of [
                [MODBUS_DEVICE, 'modbus', MODBUS_POINTS],
                [OPCUA_DEVICE, 'opc', OPCUA_POINTS]
            ]) {
                for (const [key, point] of Object.entries(points)) {
                    insert.run(deviceId, `${prefix}_${key}`, `${prefix} ${key}`, point.node,
                        point.type.toUpperCase(), point.unit || '', point.category || 'analog', point.field,
                        point.type === 'bool' ? 500 : 250);
                }
            }
        })();
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('集成测试数据库完整性检查失败');
    } finally {
        db.close();
    }
}

function startSimulator(engine, protocolPort, controlPort, logName, extra = []) {
    const protocol = engine === MODBUS_ENGINE ? 'MODBUS_TCP' : 'OPC_UA';
    return startLoggedProcess(PYTHON, [
        engine,
        '--bind', '127.0.0.1',
        protocol === 'MODBUS_TCP' ? '--modbus-port' : '--opc-port', String(protocolPort),
        '--control-port', String(controlPort),
        ...extra
    ], {
        cwd: SIMULATOR_DIR,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
        logFile: path.join(runDirectory, logName)
    });
}

async function writeModbus(controlPort, point, value) {
    return requestJson(`http://127.0.0.1:${controlPort}/value`, {
        method: 'POST',
        body: JSON.stringify({ area: point.area, offset: point.offset, type: point.type, value })
    });
}

async function writeOpcUa(controlPort, point, value) {
    return requestJson(`http://127.0.0.1:${controlPort}/value`, {
        method: 'POST',
        body: JSON.stringify({ nodeId: point.node, type: point.type, value })
    });
}

async function seedPoints(write, controlPort, points, values) {
    for (const [key, point] of Object.entries(points)) {
        if (!Object.hasOwn(values, key)) throw new Error(`缺少初始化点位 ${key}`);
        await write(controlPort, point, values[key]);
    }
}

function connectWebSocket(port, frames, statuses) {
    return new Promise((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => {
            client.terminate();
            reject(new Error('WebSocket 连接超时'));
        }, 10000);
        client.once('open', () => {
            clearTimeout(timer);
            client.on('message', raw => {
                try {
                    const message = JSON.parse(String(raw));
                    const entry = { receivedAt: Date.now(), message };
                    if (message.type === 'realtime_frame') frames.push(entry);
                    if (message.type === 'plc_status') statuses.push(entry);
                } catch (error) {
                    // Ignore non-JSON diagnostic frames.
                }
            });
            resolve(client);
        });
        client.once('error', reject);
    });
}

function deviceFrame(frames, deviceId, after = 0, minimumFrameIndex = 0) {
    for (let index = frames.length - 1; index >= minimumFrameIndex; index -= 1) {
        const entry = frames[index];
        if (entry.receivedAt < after) break;
        if (entry.message?.payload?.devices?.some(device => device.deviceId === deviceId || device.furnace_id === deviceId)) {
            return entry;
        }
    }
    return null;
}

function frameDevice(entry, deviceId) {
    return entry?.message?.payload?.devices?.find(device => device.deviceId === deviceId || device.furnace_id === deviceId);
}

function deviceStatus(entry, deviceId) {
    return entry?.message?.payload?.devices?.find(device => device.deviceId === deviceId);
}

function frameFence(frames) {
    return { sentAt: Date.now(), frameIndex: frames.length };
}

function pointObservation(entry, deviceId, point) {
    const device = frameDevice(entry, deviceId);
    const category = point.category || 'analog';
    return {
        value: device?.[category]?.[point.field],
        quality: device?.quality?.[category]?.[point.field]
    };
}

function summarizePoints(entry, deviceId, points) {
    return Object.fromEntries(Object.entries(points).map(([key, point]) => [key, {
        address: point.node,
        type: point.type.toUpperCase(),
        ...pointObservation(entry, deviceId, point)
    }]));
}

function allPointsQuality(entry, deviceId, points, quality) {
    return Boolean(frameDevice(entry, deviceId)) && Object.values(points).every(point =>
        pointObservation(entry, deviceId, point).quality === quality);
}

async function waitForPointValues(frames, deviceId, points, expected, fence, label, timeoutMs = 5000) {
    try {
        return await waitUntil(() => {
            const entry = deviceFrame(frames, deviceId, fence.sentAt, fence.frameIndex);
            const matches = Object.entries(expected).every(([key, value]) => {
                const observed = pointObservation(entry, deviceId, points[key]);
                return observed.value === value && observed.quality === 'good';
            });
            return entry && matches ? entry : null;
        }, timeoutMs, label);
    } catch (error) {
        const latest = deviceFrame(frames, deviceId, fence.sentAt, fence.frameIndex);
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, latest ${JSON.stringify(summarizePoints(latest, deviceId, points))}`, { cause: error });
    }
}

async function verifyTypeBoundaries(frames, deviceId, controlPort, points, write, evidence) {
    // Run integers/BOOL before REAL so failures retain the completed type coverage.
    const ordered = Object.entries(points).sort((a, b) => Number(a[1].type === 'real') - Number(b[1].type === 'real'));
    for (const [key, point] of ordered) {
        const pointEvidence = { point: key, address: point.node, type: point.type.toUpperCase(), samples: [] };
        evidence.push(pointEvidence);
        for (const expected of TYPE_BOUNDARIES[point.type]) {
            const fence = frameFence(frames);
            const response = await write(controlPort, point, expected);
            if (response.value !== expected) throw new Error(`仿真器未保存 ${deviceId}/${key}=${expected}: ${JSON.stringify(response)}`);
            const sample = { expected, simulatorValue: response.value };
            pointEvidence.samples.push(sample);
            try {
                const observed = await waitForPointValues(frames, deviceId, points, { [key]: expected }, fence,
                    `${deviceId} ${point.type.toUpperCase()} 边界 ${expected}`);
                Object.assign(sample, pointObservation(observed, deviceId, point), {
                    latencyMs: observed.receivedAt - fence.sentAt,
                    sequence: observed.message.payload.seq
                });
            } catch (error) {
                Object.assign(sample, pointObservation(deviceFrame(frames, deviceId, fence.sentAt, fence.frameIndex), deviceId, point));
                throw error;
            }
        }
    }
}

function boundariesComplete(points, evidence) {
    return Object.entries(points).every(([key, point]) => {
        const samples = evidence.find(entry => entry.point === key)?.samples || [];
        return samples.length === TYPE_BOUNDARIES[point.type].length && samples.every((sample, index) =>
            sample.expected === TYPE_BOUNDARIES[point.type][index]
            && sample.value === sample.expected && sample.quality === 'good');
    });
}

async function verifyIsolation(frames, healthyDevice, healthyPoints, controlPort, write, values,
    failedDevice, failedPoints, failedBadFrame, evidence) {
    const failedBadIndex = frames.indexOf(failedBadFrame);
    for (const value of values) {
        const fence = frameFence(frames);
        await write(controlPort, healthyPoints.temperature, value);
        const observed = await waitForPointValues(frames, healthyDevice, healthyPoints, { temperature: value }, fence,
            `${failedDevice} 离线期间 ${healthyDevice} 新值 ${value}`);
        if (!allPointsQuality(observed, healthyDevice, healthyPoints, 'good')) {
            throw new Error(`离线隔离失败：${healthyDevice} 存在非 good 点位`);
        }
        // An offline peer must not briefly regain good quality from stale callbacks.
        const unexpected = frames.slice(failedBadIndex).find(entry => frameDevice(entry, failedDevice)
            && !allPointsQuality(entry, failedDevice, failedPoints, 'bad'));
        if (unexpected) throw new Error(`离线隔离失败：${failedDevice} 未恢复时点位不再全部 bad`);
        const failedFrame = deviceFrame(frames, failedDevice, failedBadFrame.receivedAt);
        if (!allPointsQuality(failedFrame, failedDevice, failedPoints, 'bad')) {
            throw new Error(`离线隔离失败：${failedDevice} 未保持 bad`);
        }
        evidence.push({
            expected: value,
            ...pointObservation(observed, healthyDevice, healthyPoints.temperature),
            newFrame: frames.indexOf(observed) >= fence.frameIndex,
            sentAt: fence.sentAt,
            receivedAt: observed.receivedAt,
            sequence: observed.message.payload.seq,
            failedDeviceAllPointsBad: true
        });
    }
}

async function stopBackend() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    try {
        await requestJson(`${backendOrigin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
    } catch (error) {
        await forceStop(backend);
    }
}

async function cleanup() {
    try { socket?.terminate(); } catch (error) { /* ignore */ }
    socket = null;
    await stopBackend();
    await forceStop(modbusSimulator);
    await forceStop(opcuaSimulator);
    modbusSimulator = null;
    opcuaSimulator = null;
}

async function main() {
    const startedAt = Date.now();
    const frames = [];
    const statuses = [];
    const coverage = {
        initial: {},
        typeBoundaries: { MODBUS_TCP: [], OPC_UA: [] },
        outage: {},
        isolation: { duringModbusOutage: [], duringOpcUaOutage: [] },
        recovery: {}
    };
    let result;
    try {
        if (!fs.existsSync(MODBUS_ENGINE) || !fs.existsSync(OPCUA_ENGINE)) {
            throw new Error(`仿真器缺少协议引擎：${SIMULATOR_DIR}`);
        }
        runDirectory = createRunDirectory('plc-simulator-protocols');
        const modbusPort = await findFreePort(Number(process.env.MODBUS_TEST_PORT || 502));
        const opcuaPort = await findFreePort(Number(process.env.OPCUA_TEST_PORT || 4840));
        const modbusControlPort = await findFreePort(11502);
        const opcuaControlPort = await findFreePort(14840);
        const backendPort = await findFreePort(3521);
        backendOrigin = `http://127.0.0.1:${backendPort}`;
        const dataDirectory = path.join(runDirectory, 'data');
        const databaseFile = path.join(dataDirectory, 'factory.db');
        const uploadsDirectory = path.join(runDirectory, 'uploads');
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.mkdirSync(uploadsDirectory, { recursive: true });
        await createTestDatabase(databaseFile, { source: process.env.PLC_TEST_SOURCE_DB });
        configureDatabase(databaseFile, modbusPort, opcuaPort);
        fs.writeFileSync(path.join(dataDirectory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename: databaseFile }, null, 2));

        modbusSimulator = startSimulator(MODBUS_ENGINE, modbusPort, modbusControlPort, 'modbus-simulator.log', ['--unit-id', '1']);
        opcuaSimulator = startSimulator(OPCUA_ENGINE, opcuaPort, opcuaControlPort, 'opcua-simulator.log', [
            '--endpoint-path', '/UA/PLC-Simulator',
            '--namespace-uri', 'urn:heat-treatment:plc-simulator'
        ]);
        await waitForHttp(`http://127.0.0.1:${modbusControlPort}/health`, 30000);
        await waitForHttp(`http://127.0.0.1:${opcuaControlPort}/health`, 30000);
        await Promise.all([
            seedPoints(writeModbus, modbusControlPort, MODBUS_POINTS, INITIAL_MODBUS_VALUES),
            seedPoints(writeOpcUa, opcuaControlPort, OPCUA_POINTS, INITIAL_OPCUA_VALUES)
        ]);

        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(backendPort),
                APP_DATA_DIR: dataDirectory,
                UPLOADS_DIR: uploadsDirectory,
                FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
                PLC_OFFLINE_AFTER_MS: '2500',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        socket = await connectWebSocket(backendPort, frames, statuses);
        await waitUntil(() => statuses.find(entry => deviceStatus(entry, MODBUS_DEVICE)?.status === 'connected'
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'connected'), 30000, '两种协议初始连接');
        const initialFence = { sentAt: 0, frameIndex: 0 };
        const initialModbus = await waitForPointValues(frames, MODBUS_DEVICE, MODBUS_POINTS, INITIAL_MODBUS_VALUES,
            initialFence, 'Modbus 全部点位初始值', 15000);
        const initialOpcUa = await waitForPointValues(frames, OPCUA_DEVICE, OPCUA_POINTS, INITIAL_OPCUA_VALUES,
            initialFence, 'OPC UA 全部点位初始值', 15000);
        coverage.initial.MODBUS_TCP = summarizePoints(initialModbus, MODBUS_DEVICE, MODBUS_POINTS);
        coverage.initial.OPC_UA = summarizePoints(initialOpcUa, OPCUA_DEVICE, OPCUA_POINTS);

        const modbusLatencies = [];
        const opcuaLatencies = [];
        for (let index = 0; index < 8; index += 1) {
            const modbusValue = 1300 + index;
            const opcuaValue = 870.5 + index;
            const sentAt = Date.now();
            await writeModbus(modbusControlPort, MODBUS_POINTS.temperature, modbusValue);
            await writeOpcUa(opcuaControlPort, OPCUA_POINTS.temperature, opcuaValue);
            const modbusFrame = await waitUntil(() => {
                const device = frameDevice(deviceFrame(frames, MODBUS_DEVICE, sentAt), MODBUS_DEVICE);
                return device?.analog?.actual_temp === modbusValue && device?.quality?.analog?.actual_temp === 'good'
                    ? deviceFrame(frames, MODBUS_DEVICE, sentAt) : null;
            }, 5000, `Modbus 连续值 ${modbusValue}`);
            const opcFrame = await waitUntil(() => {
                const device = frameDevice(deviceFrame(frames, OPCUA_DEVICE, sentAt), OPCUA_DEVICE);
                return device?.analog?.actual_temp === opcuaValue && device?.quality?.analog?.actual_temp === 'good'
                    ? deviceFrame(frames, OPCUA_DEVICE, sentAt) : null;
            }, 5000, `OPC UA 连续值 ${opcuaValue}`);
            modbusLatencies.push(modbusFrame.receivedAt - sentAt);
            opcuaLatencies.push(opcFrame.receivedAt - sentAt);
            await sleep(100);
        }

        const boundaryResults = await Promise.allSettled([
            verifyTypeBoundaries(frames, MODBUS_DEVICE, modbusControlPort, MODBUS_POINTS, writeModbus, coverage.typeBoundaries.MODBUS_TCP),
            verifyTypeBoundaries(frames, OPCUA_DEVICE, opcuaControlPort, OPCUA_POINTS, writeOpcUa, coverage.typeBoundaries.OPC_UA)
        ]);
        const boundaryFailures = boundaryResults.filter(result => result.status === 'rejected');
        if (boundaryFailures.length) throw new Error(boundaryFailures.map(result => result.reason.message).join('\n'));

        const modbusOutageAt = Date.now();
        await forceStop(modbusSimulator);
        modbusSimulator = null;
        const modbusOffline = await waitUntil(() => statuses.find(entry => entry.receivedAt >= modbusOutageAt
            && deviceStatus(entry, MODBUS_DEVICE)?.status === 'offline'), 10000, 'Modbus 断联离线');
        const opcStillConnected = await waitUntil(() => statuses.find(entry => entry.receivedAt >= modbusOutageAt
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'connected'), 8000, 'Modbus 断联时 OPC UA 保持连接');
        const modbusBadFrame = await waitUntil(() => {
            const entry = deviceFrame(frames, MODBUS_DEVICE, modbusOutageAt);
            return allPointsQuality(entry, MODBUS_DEVICE, MODBUS_POINTS, 'bad') ? entry : null;
        }, 10000, 'Modbus 断联后全部点位 bad');
        coverage.outage.MODBUS_TCP = summarizePoints(modbusBadFrame, MODBUS_DEVICE, MODBUS_POINTS);
        await verifyIsolation(frames, OPCUA_DEVICE, OPCUA_POINTS, opcuaControlPort, writeOpcUa, [880.25, 881.5, 882.75],
            MODBUS_DEVICE, MODBUS_POINTS, modbusBadFrame, coverage.isolation.duringModbusOutage);

        const modbusRecoveryAt = Date.now();
        modbusSimulator = startSimulator(MODBUS_ENGINE, modbusPort, modbusControlPort, 'modbus-simulator-recovery.log', ['--unit-id', '1']);
        await waitForHttp(`http://127.0.0.1:${modbusControlPort}/health`, 30000);
        const modbusRecoveryFence = frameFence(frames);
        await seedPoints(writeModbus, modbusControlPort, MODBUS_POINTS, RECOVERED_MODBUS_VALUES);
        const modbusRecovered = await waitForPointValues(frames, MODBUS_DEVICE, MODBUS_POINTS, RECOVERED_MODBUS_VALUES,
            modbusRecoveryFence, 'Modbus 全部点位重连恢复', 15000);
        coverage.recovery.MODBUS_TCP = summarizePoints(modbusRecovered, MODBUS_DEVICE, MODBUS_POINTS);

        const opcOutageAt = Date.now();
        await forceStop(opcuaSimulator);
        opcuaSimulator = null;
        const opcOffline = await waitUntil(() => statuses.find(entry => entry.receivedAt >= opcOutageAt
            && deviceStatus(entry, OPCUA_DEVICE)?.status === 'offline'), 12000, 'OPC UA 断联离线');
        const modbusStillConnected = await waitUntil(() => statuses.find(entry => entry.receivedAt >= opcOutageAt
            && deviceStatus(entry, MODBUS_DEVICE)?.status === 'connected'), 8000, 'OPC UA 断联时 Modbus 保持连接');
        const opcBadFrame = await waitUntil(() => {
            const entry = deviceFrame(frames, OPCUA_DEVICE, opcOutageAt);
            return allPointsQuality(entry, OPCUA_DEVICE, OPCUA_POINTS, 'bad') ? entry : null;
        }, 12000, 'OPC UA 断联后全部点位 bad');
        coverage.outage.OPC_UA = summarizePoints(opcBadFrame, OPCUA_DEVICE, OPCUA_POINTS);
        await verifyIsolation(frames, MODBUS_DEVICE, MODBUS_POINTS, modbusControlPort, writeModbus, [1601, 1602, 1603],
            OPCUA_DEVICE, OPCUA_POINTS, opcBadFrame, coverage.isolation.duringOpcUaOutage);

        const opcRecoveryAt = Date.now();
        opcuaSimulator = startSimulator(OPCUA_ENGINE, opcuaPort, opcuaControlPort, 'opcua-simulator-recovery.log', [
            '--endpoint-path', '/UA/PLC-Simulator',
            '--namespace-uri', 'urn:heat-treatment:plc-simulator'
        ]);
        await waitForHttp(`http://127.0.0.1:${opcuaControlPort}/health`, 30000);
        const opcRecoveryFence = frameFence(frames);
        await seedPoints(writeOpcUa, opcuaControlPort, OPCUA_POINTS, RECOVERED_OPCUA_VALUES);
        const opcRecovered = await waitForPointValues(frames, OPCUA_DEVICE, OPCUA_POINTS, RECOVERED_OPCUA_VALUES,
            opcRecoveryFence, 'OPC UA 全部节点重建和点位重连恢复', 20000);
        coverage.recovery.OPC_UA = summarizePoints(opcRecovered, OPCUA_DEVICE, OPCUA_POINTS);

        const metrics = {
            initial: { modbusAt: initialModbus.receivedAt, opcuaAt: initialOpcUa.receivedAt },
            modbusLatencyMs: { samples: modbusLatencies.length, p95: percentile(modbusLatencies, 95) },
            opcuaLatencyMs: { samples: opcuaLatencies.length, p95: percentile(opcuaLatencies, 95) },
            outage: {
                modbusOfflineAfterMs: modbusOffline.receivedAt - modbusOutageAt,
                opcuaOfflineAfterMs: opcOffline.receivedAt - opcOutageAt,
                modbusAllPointsBadAfterMs: modbusBadFrame.receivedAt - modbusOutageAt,
                opcuaAllPointsBadAfterMs: opcBadFrame.receivedAt - opcOutageAt
            },
            recovery: {
                modbusGoodAfterMs: modbusRecovered.receivedAt - modbusRecoveryAt,
                opcuaGoodAfterMs: opcRecovered.receivedAt - opcRecoveryAt
            }
        };
        const checks = {
            modbusInitialValue: Boolean(initialModbus),
            opcuaInitialValue: Boolean(initialOpcUa),
            modbusContinuousReads: modbusLatencies.length === 8,
            opcuaContinuousReads: opcuaLatencies.length === 8,
            modbusP95Under5000Ms: metrics.modbusLatencyMs.p95 <= 5000,
            opcuaP95Under10000Ms: metrics.opcuaLatencyMs.p95 <= 10000,
            modbusOfflineUnder10000Ms: metrics.outage.modbusOfflineAfterMs <= 10000,
            opcuaOfflineUnder12000Ms: metrics.outage.opcuaOfflineAfterMs <= 12000,
            protocolIsolationDuringModbusOutage: Boolean(opcStillConnected),
            protocolIsolationDuringOpcUaOutage: Boolean(modbusStillConnected),
            modbusRecoveryGood: Boolean(modbusRecovered),
            opcuaRecoveryGood: Boolean(opcRecovered),
            modbusAllPointsInitiallyGood: allPointsQuality(initialModbus, MODBUS_DEVICE, MODBUS_POINTS, 'good'),
            opcuaAllPointsInitiallyGood: allPointsQuality(initialOpcUa, OPCUA_DEVICE, OPCUA_POINTS, 'good'),
            modbusSevenTypeBoundaries: boundariesComplete(MODBUS_POINTS, coverage.typeBoundaries.MODBUS_TCP),
            opcuaSevenTypeBoundaries: boundariesComplete(OPCUA_POINTS, coverage.typeBoundaries.OPC_UA),
            modbusAllPointsBadDuringOutage: allPointsQuality(modbusBadFrame, MODBUS_DEVICE, MODBUS_POINTS, 'bad'),
            opcuaAllPointsBadDuringOutage: allPointsQuality(opcBadFrame, OPCUA_DEVICE, OPCUA_POINTS, 'bad'),
            opcuaFreshGoodFramesDuringModbusOutage: coverage.isolation.duringModbusOutage.length === 3
                && coverage.isolation.duringModbusOutage.every(sample => sample.newFrame && sample.quality === 'good' && sample.failedDeviceAllPointsBad),
            modbusFreshGoodFramesDuringOpcUaOutage: coverage.isolation.duringOpcUaOutage.length === 3
                && coverage.isolation.duringOpcUaOutage.every(sample => sample.newFrame && sample.quality === 'good' && sample.failedDeviceAllPointsBad),
            modbusAllPointsRecovered: allPointsQuality(modbusRecovered, MODBUS_DEVICE, MODBUS_POINTS, 'good'),
            opcuaAllNodesRebuiltAndRecovered: allPointsQuality(opcRecovered, OPCUA_DEVICE, OPCUA_POINTS, 'good')
        };
        result = {
            success: Object.values(checks).every(Boolean),
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            simulatorDirectory: SIMULATOR_DIR,
            endpoints: {
                modbus: `127.0.0.1:${modbusPort}`,
                opcua: `opc.tcp://127.0.0.1:${opcuaPort}/UA/PLC-Simulator`,
                backend: backendOrigin
            },
            metrics,
            checks,
            coverage
        };
        if (!result.success) throw new Error('PLC 仿真器协议集成检查未全部通过');
    } catch (error) {
        result = {
            ...(result || {}),
            success: false,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message || String(error),
            coverage,
            diagnostics: {
                statuses: statuses.slice(-12),
                frames: frames.slice(-12)
            }
        };
        process.exitCode = 1;
    } finally {
        await cleanup();
        if (runDirectory) {
            const resultFile = path.join(runDirectory, 'result.json');
            fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ resultFile, ...result }, null, 2));
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
