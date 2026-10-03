const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const ModbusRTU = require('modbus-serial');
const {
    getProtocolDefinition,
    normalizePlcOptions,
    parseModbusAddress,
    validatePointAddress,
    buildOpcUaEndpoint
} = require('../services/plcProtocolConfig');
const { ModbusTcpDriver, OpcUaDriver, decodeModbusRegisters } = require('../services/plcProtocolDrivers');
const PlcReader = require('../services/plcReader');
const {
    BACKEND_DIR,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = 'plc-protocol-test-shutdown';

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function waitForEvent(emitter, event) {
    return new Promise((resolve, reject) => {
        const onError = error => { emitter.removeListener(event, onEvent); reject(error); };
        const onEvent = value => { emitter.removeListener('serverError', onError); resolve(value); };
        emitter.once(event, onEvent);
        emitter.once('serverError', onError);
    });
}

async function testModbus() {
    const port = await freePort();
    const vector = {
        getHoldingRegister(addr) {
            if (addr === 0) return 0x1234;
            if (addr === 1) return 0x4148;
            if (addr === 2) return 0x0000;
            return 0;
        },
        getInputRegister(addr) { return addr === 0 ? 42 : 0; },
        getCoil(addr) { return addr === 0; },
        getDiscreteInput() { return false; }
    };
    const server = new ModbusRTU.ServerTCP(vector, { host: '127.0.0.1', port, unitID: 1 });
    await waitForEvent(server, 'initialized');
    const driver = new ModbusTcpDriver({
        protocol: 'MODBUS_TCP',
        ip: '127.0.0.1',
        port,
        timeout: 1000,
        options: { unitId: 1, addressBase: 1, byteOrder: 'BE', wordOrder: 'BE' }
    });
    try {
        await driver.connect();
        const values = await driver.read([
            { tagName: 'word', plc_address: 'HR40001', data_type: 'WORD' },
            { tagName: 'real', plc_address: 'HR40002', data_type: 'REAL' },
            { tagName: 'coil', plc_address: 'C00001', data_type: 'BOOL' },
            { tagName: 'input', plc_address: 'IR30001', data_type: 'WORD' }
        ]);
        assert.strictEqual(values.word, 0x1234);
        assert.strictEqual(values.real, 12.5);
        assert.strictEqual(values.coil, true);
        assert.strictEqual(values.input, 42);
    } finally {
        await driver.disconnect();
        await new Promise(resolve => server._server.close(resolve));
    }
}

async function testOpcUaWithFakeClient() {
    const created = { endpoint: '', options: null, identity: null, closed: false, trustRequested: null };
    const certificateManager = { marker: 'test-certificate-manager' };
    const fakeOpcua = {
        MessageSecurityMode: { None: 'NONE', Sign: 'SIGN', SignAndEncrypt: 'SIGN_ENCRYPT' },
        SecurityPolicy: { None: 'POLICY_NONE', Basic256Sha256: 'POLICY_BASIC' },
        UserTokenType: { Anonymous: 'ANONYMOUS', UserName: 'USERNAME' },
        AttributeIds: { Value: 13 },
        OPCUAClient: {
            create(options) {
                created.options = options;
                return {
                    async connect(endpoint) { created.endpoint = endpoint; },
                    async createSession(identity) {
                        created.identity = identity;
                        return {
                            async read(nodes) {
                                return nodes.map((node, index) => ({
                                    statusCode: { isGood: () => true, toString: () => 'Good' },
                                    value: { value: index === 0 ? 25.5 : true }
                                }));
                            },
                            async close() { created.closed = true; }
                        };
                    },
                    async disconnect() { created.closed = true; }
                };
            }
        }
    };
    const driver = new OpcUaDriver({
        protocol: 'OPC_UA',
        ip: '127.0.0.1',
        port: 4840,
        timeout: 1000,
        options: {
            endpointPath: '/UA/Test',
            username: 'operator',
            password: 'secret',
            securityMode: 'Sign',
            securityPolicy: 'Basic256Sha256',
            trustServerCertificate: true
        }
    }, {
        opcuaModule: fakeOpcua,
        certificateManagerFactory(autoAcceptUnknown) {
            created.trustRequested = autoAcceptUnknown;
            return certificateManager;
        }
    });
    await driver.connect();
    const values = await driver.read([
        { tagName: 'temperature', plc_address: 'ns=2;s=Temperature', data_type: 'REAL' },
        { tagName: 'running', plc_address: 'ns=2;s=Running', data_type: 'BOOL' }
    ]);
    assert.strictEqual(created.endpoint, 'opc.tcp://127.0.0.1:4840/UA/Test');
    assert.strictEqual(created.options.securityMode, 'SIGN');
    assert.strictEqual(created.options.securityPolicy, 'POLICY_BASIC');
    assert.strictEqual(created.options.clientCertificateManager, certificateManager);
    assert.strictEqual(created.trustRequested, true);
    assert.deepStrictEqual(created.identity, { type: 'USERNAME', userName: 'operator', password: 'secret' });
    assert.strictEqual(values.temperature, 25.5);
    assert.strictEqual(values.running, true);
    await driver.disconnect();
    assert.strictEqual(created.closed, true);
}

async function testOpcUaFailedSessionCleanup() {
    let disconnected = false;
    const fakeOpcua = {
        MessageSecurityMode: { None: 'NONE' },
        SecurityPolicy: { None: 'POLICY_NONE' },
        UserTokenType: { Anonymous: 'ANONYMOUS' },
        AttributeIds: { Value: 13 },
        OPCUAClient: {
            create() {
                return {
                    async connect() {},
                    async createSession() { throw new Error('session rejected'); },
                    async disconnect() { disconnected = true; }
                };
            }
        }
    };
    const driver = new OpcUaDriver({
        protocol: 'OPC_UA',
        ip: '127.0.0.1',
        port: 4840,
        timeout: 1000,
        options: { securityMode: 'None' }
    }, { opcuaModule: fakeOpcua });
    await assert.rejects(driver.connect(), /session rejected/);
    await driver.disconnect();
    assert.strictEqual(disconnected, true);

    const missingEndpoint = new OpcUaDriver({
        protocol: 'OPC_UA',
        ip: '',
        port: 4840,
        timeout: 1000,
        options: { securityMode: 'None' }
    }, { opcuaModule: fakeOpcua });
    await assert.rejects(missingEndpoint.connect(), /服务器地址未配置/);
    assert.strictEqual(missingEndpoint.client, null);
}

function testOverdueRetryWatchdog() {
    const reader = new PlcReader();
    reader.stopped = false;
    let reconnects = 0;
    const retryTimer = setTimeout(() => {}, 60000);
    const task = {
        id: 'watchdog-test',
        status: 'retrying',
        nextRetryAt: Date.now() - 1000,
        retryTimer
    };
    reader.tasks.set(task.id, task);
    reader._connectTask = candidate => {
        reconnects += 1;
        candidate.status = 'connecting';
        candidate.nextRetryAt = null;
    };
    reader._recoverOverdueRetries();
    assert.strictEqual(reconnects, 1);
    assert.strictEqual(task.retryTimer, null);
}

async function testConnectingTimeoutWatchdog() {
    const reader = new PlcReader({
        driverFactory() {
            return {
                connect: () => new Promise(() => {}),
                disconnect: async () => {}
            };
        }
    });
    reader.stopped = false;
    const endpoint = {
        protocol: 'MODBUS_TCP',
        ip: '127.0.0.1',
        port: 65000,
        timeout: 1000,
        retryInterval: 1000,
        maxRetries: 0,
        options: { unitId: 1 }
    };
    const task = reader._getOrCreateTask('connecting-timeout-test', endpoint, 1000);
    reader._connectTask(task);
    const deadline = Date.now() + 5000;
    while (task.status === 'connecting' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.strictEqual(task.status, 'retrying');
    assert.match(task.lastError, /连接超时/);
    assert.ok(Number.isFinite(task.nextRetryAt));
    assert.ok(task.retryTimer);
    reader.stop();
}

async function testReadingTimeoutWatchdog() {
    // Exercise both a missing S7 callback and a hung promise-based driver.
    for (const protocol of ['S7', 'MODBUS_TCP']) {
        const reader = new PlcReader();
        reader.stopped = false;
        const task = reader._getOrCreateTask(`hung-read-${protocol}`, {
            protocol, ip: '127.0.0.1', port: 65000, timeout: 1000,
            retryInterval: 1000, maxRetries: 0
        }, 1000);
        task.status = 'connected';
        let lateRead, disconnects = 0, updates = 0;
        reader.onData = () => { updates++; };
        if (protocol === 'S7') {
            task.conn = { readAllItems: callback => { lateRead = () => callback(null, {}); },
                dropConnection: () => { disconnects++; } };
        } else {
            task.driver = { read: () => new Promise(resolve => { lateRead = () => resolve({}); }),
                disconnect: async () => { disconnects++; } };
        }
        try {
            reader._readTask(task);
            await new Promise(resolve => setTimeout(resolve, 1100));
            assert.equal(task.status, 'retrying');
            assert.equal(task.reading, false);
            assert.equal(task.readTimer, null);
            assert.match(task.lastError, /读取超时/);
            assert.equal(disconnects, 1);
            lateRead();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(updates, 0, 'late data from discarded connection must not publish');
            reader._handleTaskFailure(task, new Error('offline again'), '连接失败');
            assert.ok(task.nextRetryAt - Date.now() > 1800, 'second failure uses exponential backoff');
        } finally { reader.stop(); }
    }
}

function createLegacyDatabase(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new Database(filename);
    try {
        db.exec(`CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            line_id TEXT,
            model_type TEXT DEFAULT 'builtin_furnace',
            model_file TEXT,
            template_id TEXT DEFAULT '',
            instance_config TEXT,
            pos_x REAL DEFAULT 0,
            pos_y REAL DEFAULT 0,
            pos_z REAL DEFAULT 0,
            rotation_y REAL DEFAULT 0,
            scale REAL DEFAULT 1,
            coordinate_space TEXT DEFAULT 'line_local',
            sort_order INTEGER DEFAULT 0,
            plc_enabled INTEGER DEFAULT 0,
            plc_protocol TEXT DEFAULT 'S7',
            plc_ip TEXT DEFAULT '',
            plc_port INTEGER DEFAULT 102,
            plc_rack INTEGER DEFAULT 0,
            plc_slot INTEGER DEFAULT 1,
            plc_timeout INTEGER DEFAULT 5000,
            plc_retry_interval INTEGER DEFAULT 10000,
            plc_max_retries INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } finally {
        db.close();
    }
}

async function testProtocolApiAndMigration() {
    const runDirectory = createRunDirectory('plc-protocol-api');
    const dataDirectory = path.join(runDirectory, 'data');
    const uploadsDirectory = path.join(runDirectory, 'uploads');
    const databaseFile = path.join(dataDirectory, 'legacy-factory.db');
    fs.mkdirSync(uploadsDirectory, { recursive: true });
    createLegacyDatabase(databaseFile);
    fs.writeFileSync(path.join(dataDirectory, 'database-config.json'), JSON.stringify({
        type: 'sqlite',
        filename: databaseFile
    }, null, 2));

    const port = await findFreePort(3511);
    const origin = `http://127.0.0.1:${port}`;
    let backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DATA_DIR: dataDirectory,
            UPLOADS_DIR: uploadsDirectory,
            FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
            DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
            DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
        },
        logFile: path.join(runDirectory, 'backend.log')
    });

    try {
        await waitForHttp(`${origin}/api/health`, 30000);
        const capabilities = await requestJson(`${origin}/api/plc/protocols`);
        assert.deepStrictEqual(
            capabilities.protocols.map(item => item.value),
            ['S7', 'MODBUS_TCP', 'OPC_UA']
        );

        await requestJson(`${origin}/api/workshops`, {
            method: 'POST',
            body: JSON.stringify({ id: 'protocol_ws', name: '协议测试车间' })
        });
        await requestJson(`${origin}/api/lines`, {
            method: 'POST',
            body: JSON.stringify({ id: 'protocol_line', name: '协议测试产线', workshop_id: 'protocol_ws' })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({
                id: 'modbus_device',
                name: 'Modbus 设备',
                line_id: 'protocol_line',
                plc_protocol: 'MODBUS_TCP',
                plc_port: 502,
                plc_options: { unitId: 7, addressBase: 1, byteOrder: 'LE', wordOrder: 'BE' }
            })
        });
        await requestJson(`${origin}/api/datapoints`, {
            method: 'POST',
            body: JSON.stringify({
                device_id: 'modbus_device',
                name: 'temperature',
                label: '温度',
                plc_tag: 'HR40001',
                data_type: 'REAL'
            })
        });
        await assert.rejects(
            requestJson(`${origin}/api/datapoints`, {
                method: 'POST',
                body: JSON.stringify({
                    device_id: 'modbus_device',
                    name: 'bad_address',
                    label: '错误地址',
                    plc_tag: 'DB1.DBW0',
                    data_type: 'WORD'
                })
            }),
            /Modbus 地址格式不正确/
        );

        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({
                id: 'opc_device',
                name: 'OPC UA 设备',
                line_id: 'protocol_line',
                plc_protocol: 'OPC_UA',
                plc_port: 4840,
                plc_options: {
                    endpointPath: '/UA/Factory',
                    securityMode: 'Sign',
                    securityPolicy: 'Basic256Sha256',
                    username: 'operator',
                    password: 'site-secret',
                    trustServerCertificate: false
                }
            })
        });
        const opcDevice = await requestJson(`${origin}/api/devices/opc_device`);
        assert.strictEqual(opcDevice.plc_options.password, '******');
        assert.strictEqual(opcDevice.plc_options.endpointPath, '/UA/Factory');
        await requestJson(`${origin}/api/devices/opc_device`, {
            method: 'PUT',
            body: JSON.stringify({ ...opcDevice, name: 'OPC UA 设备（已编辑）' })
        });
        await requestJson(`${origin}/api/datapoints`, {
            method: 'POST',
            body: JSON.stringify({
                device_id: 'opc_device',
                name: 'running',
                label: '运行状态',
                plc_tag: 'ns=2;s=Factory.Device.Running',
                data_type: 'BOOL'
            })
        });

        await requestJson(`${origin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
        backend = null;

        const migrated = new Database(databaseFile, { readonly: true, fileMustExist: true });
        try {
            const columns = migrated.prepare('PRAGMA table_info(devices)').all().map(row => row.name);
            assert.ok(columns.includes('plc_options'));
            const stored = migrated.prepare('SELECT plc_options FROM devices WHERE id = ?').get('opc_device');
            assert.strictEqual(JSON.parse(stored.plc_options).password, 'site-secret');
        } finally {
            migrated.close();
        }
    } finally {
        if (backend) await forceStop(backend);
    }
}

async function main() {
    assert.ok(getProtocolDefinition('S7'));
    assert.ok(getProtocolDefinition('MODBUS_TCP'));
    assert.ok(getProtocolDefinition('OPC_UA'));
    assert.strictEqual(
        normalizePlcOptions('OPC_UA', { endpointPath: '/UA/New' }, { endpointPath: '/UA/Old', password: 'secret' }).password,
        'secret'
    );
    assert.deepStrictEqual(parseModbusAddress('HR40001', 'WORD', { addressBase: 1 }).address, 0);
    assert.strictEqual(validatePointAddress('MODBUS_TCP', 'HR40001', 'WORD', {}), '');
    assert.ok(validatePointAddress('MODBUS_TCP', 'not-an-address', 'WORD', {}));
    const realPoint = parseModbusAddress('HR40001', 'REAL', { addressBase: 1 });
    assert.strictEqual(decodeModbusRegisters([0x4841, 0x0000], realPoint, { byteOrder: 'LE', wordOrder: 'BE' }), 12.5);
    assert.strictEqual(decodeModbusRegisters([0x0000, 0x4148], realPoint, { byteOrder: 'BE', wordOrder: 'LE' }), 12.5);
    assert.strictEqual(decodeModbusRegisters([0x0000, 0x4841], realPoint, { byteOrder: 'LE', wordOrder: 'LE' }), 12.5);
    assert.strictEqual(validatePointAddress('OPC_UA', 'ns=2;s=Tag', 'REAL', {}), '');
    assert.ok(validatePointAddress('OPC_UA', 'Tag', 'REAL', {}));
    assert.strictEqual(buildOpcUaEndpoint('192.168.1.20', 4840, { endpointPath: '/UA/Server' }), 'opc.tcp://192.168.1.20:4840/UA/Server');
    assert.strictEqual(buildOpcUaEndpoint('opc.tcp://192.168.1.20:4840/UA/Existing', 4840, { endpointPath: '/UA/Ignored' }), 'opc.tcp://192.168.1.20:4840/UA/Existing');
    await testModbus();
    await testOpcUaWithFakeClient();
    await testOpcUaFailedSessionCleanup();
    testOverdueRetryWatchdog();
    await testConnectingTimeoutWatchdog();
    await testReadingTimeoutWatchdog();
    await testProtocolApiAndMigration();
    console.log(JSON.stringify({ success: true, protocols: ['S7', 'MODBUS_TCP', 'OPC_UA'], modbusTcp: true, opcUa: true }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
