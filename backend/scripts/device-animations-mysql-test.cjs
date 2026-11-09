'use strict';
// Opt-in, real bundled MySQL regression. Every database write is to a fresh
// output fixture. No application/HTTP/UI/PLC process or production config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createRunDirectory, requireTestPath } = require('./integration-test-utils.cjs');
const { createSmokeEnvironment } = require('../../desktop/scripts/smoke-sandbox.cjs');

const root = path.resolve(__dirname, '../..');
const directory = createRunDirectory('device-animations-mysql');
const dataDir = requireTestPath(path.join(directory, 'data'));
const configFile = requireTestPath(path.join(dataDir, 'database-config.json'));
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
let runtime, database, db, connection, config, hostPid, mysqlPid, programData;
const result = { success: false, directory, checks, uiUsed: false, productionWrites: false };

function check(name, details = {}) {
    checks.push({ name, ...details });
    console.log(`PASS ${name}`);
}
function errorInfo(error) {
    return { name: error.name, code: error.code, errno: error.errno,
        sqlState: error.sqlState, message: error.message };
}
function withoutInstance(row) {
    const snapshot = clone(row); delete snapshot.instance_config; return snapshot;
}
function pidExists(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function portListening(port) {
    return new Promise(resolve => {
        if (!Number.isInteger(port) || port < 1) return resolve(false);
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let settled = false;
        const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(1500, () => finish(false));
    });
}

// Capture the actual Express handlers, keeping real services/adapter calls.
// Only registration is replaced; there is no HTTP server or browser.
function captureAnimationRoutes(databaseFacade) {
    const filename = path.join(root, 'backend/routes/devices.js');
    const localRequire = createRequire(filename), routes = new Map();
    const router = Object.fromEntries(['get', 'put', 'post', 'delete'].map(method => [method,
        (route, ...handlers) => { routes.set(`${method.toUpperCase()} ${route}`, handlers.at(-1)); return router; }]));
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
        require: name => name === 'express' ? { Router: () => router }
            : name === '../db/database' ? databaseFacade : localRequire(name),
        console, process, Buffer, URL, global, setTimeout, clearTimeout, setInterval, clearInterval
    }, { filename });
    const get = routes.get('GET /:id/animations'), put = routes.get('PUT /:id/animations');
    assert.equal(typeof get, 'function'); assert.equal(typeof put, 'function');
    return async (method, id, factoryId, body) => {
        const response = { statusCode: 200, locals: {},
            status(status) { this.statusCode = status; return this; },
            json(value) { this.payload = clone(value); return this; } };
        await (method === 'GET' ? get : put)({ params: { id }, factoryId, body }, response);
        assert.ok(response.payload, 'the actual route must send a response');
        return response;
    };
}

async function run() {
    // Remove inherited DB/collector/identity paths, not merely shadow them.
    // Apply this before any import of the actual database module, including
    // MysqlRuntime's private child host and the VM-captured route dependencies.
    const environment = createSmokeEnvironment(directory, {
        DB_CONNECT_TIMEOUT_MS: '8000', DB_QUERY_TIMEOUT_MS: '10000',
        DB_TRANSACTION_TIMEOUT_MS: '60000'
    });
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    programData = environment.ProgramData;
    assert.equal(process.env.APP_DATA_DIR, dataDir);
    assert.equal(process.env.APP_USER_DATA_DIR, directory);
    for (const key of ['DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
        'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'SQLITE_FILE']) {
        assert.equal(process.env[key], undefined, `${key} must not redirect this fixture`);
    }
    assert.equal(require.cache[require.resolve('../db/database')], undefined,
        'actual database import must happen only after the isolated config exists');
    const runtimeDir = path.join(root, 'desktop/resources/mysql');
    assert.ok(fs.existsSync(path.join(runtimeDir, 'bin/mysqld.exe')), 'bundled mysqld is required');
    const { MysqlRuntime } = require('../../desktop/mysqlRuntime.cjs');
    runtime = new MysqlRuntime({ root: directory, runtimeDir, nodeBinary: process.execPath,
        hostScript: path.join(root, 'backend/services/privateMysqlHost.js'),
        dependenciesDir: path.join(root, 'backend/node_modules'),
        templateFile: path.join(root, 'desktop/resources/templates/factory-template.db'),
        onProgress: detail => console.log(`MYSQL ${detail}`) });
    await runtime.start();
    hostPid = runtime.child.pid;
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'mysql/runtime.json'), 'utf8'));
    assert.equal(config.managedBy, 'desktop-mysql'); assert.equal(config.type, 'mysql');
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.instanceId, state.instanceId);
    assert.equal(config.port, state.port); assert.ok(config.port >= 13307);
    assert.equal(requireTestPath(config.filename), path.join(dataDir, 'factory.db'));
    mysqlPid = Number(fs.readFileSync(path.join(directory, 'mysql/mysqld.pid'), 'utf8').trim());
    assert.ok(Number.isSafeInteger(mysqlPid) && mysqlPid > 0 && mysqlPid !== hostPid);
    assert.equal(pidExists(hostPid), true); assert.equal(pidExists(mysqlPid), true);

    const aliasBase = path.join(programData, 'HeatTreatmentDigitalTwin/mysql-links');
    const alias = path.join(aliasBase, fs.readdirSync(aliasBase)[0]);
    assert.equal(fs.realpathSync(path.join(alias, 'storage')), fs.realpathSync(path.join(directory, 'mysql')));
    requireTestPath(fs.realpathSync(path.join(alias, 'storage')));
    result.isolation = { configFile, dataDir, managedBy: config.managedBy, instanceId: config.instanceId,
        host: config.host, port: config.port, hostPid, mysqlPid, programData, nativeStorageAlias: path.join(alias, 'storage') };
    check('private MySQL identity, config, native storage and owned process isolation');

    database = require('../db/database');
    const actualConfig = database.loadDatabaseConfig();
    assert.equal(actualConfig.instanceId, config.instanceId); assert.equal(actualConfig.port, config.port);
    assert.equal(actualConfig.filename, config.filename);
    db = await database.getDb();
    assert.equal(database.getDbStatus().type, 'mysql'); assert.equal(database.getDbStatus().connected, true);
    const mysql = require('mysql2/promise');
    connection = await mysql.createConnection({ host: config.host, port: config.port,
        user: config.user, password: config.password, database: config.database, connectTimeout: 8000 });
    const { loadDeviceAnimations, validateDeviceAnimations, publicDeviceAnimations } = require('../services/deviceAnimations');
    const { canonicalJson, exactJsonEquals } = require('../services/deviceInspection');
    const factoryId = `animation_mysql_factory_${process.pid}`, workshopId = `animation_mysql_ws_${process.pid}`;
    const lineId = `animation_mysql_line_${process.pid}`, deviceId = `animation_mysql_device_${process.pid}`;
    await db.run('INSERT INTO factories(id,name,location_json) VALUES(?,?,?)', [factoryId, 'Isolated animation MySQL fixture', '{}']);
    await db.run('INSERT INTO workshops(id,factory_id,name,layout_json) VALUES(?,?,?,?)', [workshopId, factoryId, 'Fixture workshop', '{}']);
    await db.run('INSERT INTO `lines`(id,workshop_id,name,layout_json) VALUES(?,?,?,?)', [lineId, workshopId, 'Fixture line', '{}']);
    const initialInstance = '{"z":1,"marker":{"Case":"ABC","decimal":1.0,"order":[1,2]},"inspection":{"enabled":false,"parts":[]}}';
    await db.run(`INSERT INTO devices(id,name,line_id,model_type,instance_config,plc_enabled,plc_ip,plc_port,plc_options)
        VALUES(?,?,?,?,?,0,?,?,?)`, [deviceId, 'Fixture furnace', lineId, 'cad_multipurpose_furnace_082000',
        initialInstance, '192.0.2.53', 1102, '{"fixture":"preserve-network-config"}']);
    const pointIds = {};
    for (const [name, address] of [['door', 'DB910.DBX0.0'], ['gate', 'DB910.DBX0.1']]) {
        const inserted = await db.run(`INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,access_type)
            VALUES(?,?,?,?,'BOOL','doors',?,'READ')`, [deviceId, name, `Fixture ${name}`, address, name]);
        pointIds[name] = String(inserted.insertId || inserted.lastInsertRowid);
        assert.ok(pointIds[name] !== 'undefined');
    }
    const deviceRow = () => db.get('SELECT * FROM devices WHERE id=?', [deviceId]);
    const protectedColumns = withoutInstance(await deviceRow());
    let loaded = await loadDeviceAnimations(db, deviceId, factoryId);
    assert.equal(typeof loaded.device.instance_config, 'object');
    assert.deepEqual(loaded.instance.marker, { Case: 'ABC', decimal: 1, order: [1, 2] });
    const bindings = ['door', 'gate'].map(name => ({ actionId: `clip:${name}`, enabled: true,
        pointId: pointIds[name], inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }));
    assert.equal(validateDeviceAnimations(loaded, { revision: loaded.revision,
        config: { version: 1, staleMs: 5000, bindings } }).bindings.length, 2);
    assert.ok(publicDeviceAnimations(loaded).actions.some(action => action.id === 'clip:process_cycle'),
        'archived cycle asset definitions remain readable, not newly authorable');
    check('real getDb adapter returns native JSON and validates two independent owned door points');

    // The old shipped predicate is observed, not assumed to fail. A sentinel
    // forces rollback even if this MySQL version unexpectedly accepts it.
    const oldBefore = clone(await deviceRow()), oldCases = [];
    for (const [name, value] of [['native-object', undefined], ['JSON-null', 'null'], ['SQL-null', null]]) {
        const rollback = new Error(`owned ${name} old-predicate rollback`);
        let oldProbe, previousValueType;
        try {
            await db.transaction(async tx => {
                if (value !== undefined) await tx.run('UPDATE devices SET instance_config=? WHERE id=?', [value, deviceId]);
                const oldLoadedRow = await tx.get('SELECT * FROM devices WHERE id=?', [deviceId]);
                previousValueType = oldLoadedRow.instance_config === null ? 'null' : typeof oldLoadedRow.instance_config;
                try {
                    const raw = await tx.run('UPDATE devices SET instance_config=? WHERE id=? AND COALESCE(instance_config,\'\')=?',
                        [JSON.stringify({ ...loaded.instance, animationBindings: { version: 1, staleMs: 5000, bindings: [] } }),
                            deviceId, oldLoadedRow.instance_config || '']);
                    oldProbe = { threw: false, result: raw,
                        // This is the old route's documented result mapping,
                        // not an assertion that all MySQL versions throw.
                        derivedOldRouteStatus: raw.changes || raw.affectedRows ? 200 : 409 };
                } catch (error) { oldProbe = { threw: true, error: errorInfo(error), derivedOldRouteStatus: error.statusCode || error.status || 400 }; }
                throw rollback;
            });
        } catch (error) { assert.equal(error, rollback); }
        assert.deepEqual(clone(await deviceRow()), oldBefore);
        const observed = { name, ...oldProbe, previousValueType, rolledBack: true, mutationAfterProbe: false };
        oldCases.push(observed);
        console.log(`OLD RAW CAS ${JSON.stringify(observed)}`);
    }
    result.oldRawPredicate = oldCases[0]; result.oldRawPredicateCases = oldCases;
    check('old native-object/JSON-null/SQL-null predicates observed on fixture and unconditionally rolled back',
        { reproducedError: oldCases.some(probe => probe.threw), observedRouteStatuses: oldCases.map(probe => probe.derivedOldRouteStatus) });

    let beforeCas = null;
    const wrappedDb = { ...db, transaction: callback => db.transaction(tx => callback({ ...tx,
        run: async (sql, params = []) => {
            if (beforeCas && /^UPDATE devices SET instance_config=\? WHERE id=\? AND/.test(sql)) {
                const inject = beforeCas; beforeCas = null; await inject();
            }
            return tx.run(sql, params);
        }
    })) };
    const route = captureAnimationRoutes({ ...database, getDb: async () => wrappedDb });
    const read = async () => { const response = await route('GET', deviceId, factoryId); assert.equal(response.statusCode, 200, JSON.stringify(response.payload)); return response.payload; };
    const save = async payload => route('PUT', deviceId, factoryId, payload);
    let current = await read();
    for (let index = 0; index < 3; index++) {
        const response = await save({ revision: current.revision, config: { version: 1, staleMs: 5000, bindings: clone(bindings) } });
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload)); assert.equal(response.payload.success, true);
        current = await read(); assert.equal(response.payload.revision, current.revision);
        assert.deepEqual(current.config.bindings.map(binding => [binding.actionId, binding.pointId, binding.enabled]),
            bindings.map(binding => [binding.actionId, binding.pointId, binding.enabled]));
        assert.equal(response.locals.configurationResource, 'device-animations');
        assert.equal(response.locals.configurationDeviceId, deviceId);
        assert.deepEqual(withoutInstance(await deviceRow()), protectedColumns);
        const instance = (await deviceRow()).instance_config;
        assert.deepEqual(instance.marker, { Case: 'ABC', decimal: 1, order: [1, 2] });
        assert.deepEqual(instance.inspection, { enabled: false, parts: [] });
    }
    result.repeatedSaveReload = 3;
    check('actual GET/PUT route saves independent doors repeatedly, including unchanged save/reload, preserving PLC and inspection');

    const comparisons = await db.get(`SELECT
        JSON_EXTRACT('{"value":"ABC"}', '$') = JSON_EXTRACT('{"value":"abc"}', '$') AS folded,
        JSON_EXTRACT('{"value":1.0}', '$') = JSON_EXTRACT('{"value":1}', '$') AS numericEqual,
        JSON_EXTRACT('{"value":[1,2]}', '$') = JSON_EXTRACT('{"value":[2,1]}', '$') AS reordered`);
    assert.deepEqual(comparisons, { folded: 0, numericEqual: 1, reordered: 0 });
    const original = (await deviceRow()).instance_config;
    const semantic = JSON.stringify({ inspection: original.inspection, animationBindings: original.animationBindings,
        marker: { order: original.marker.order, decimal: 1, Case: original.marker.Case }, z: original.z }).replace('"decimal":1,', '"decimal":1.0,');
    beforeCas = async () => { await connection.execute('UPDATE devices SET instance_config=? WHERE id=?', [semantic, deviceId]); };
    const semanticSave = await save({ revision: current.revision, config: clone(current.config) });
    assert.equal(semanticSave.statusCode, 200, JSON.stringify(semanticSave.payload)); assert.equal(beforeCas, null);
    current = await read(); assert.equal(semanticSave.payload.revision, current.revision);
    assert.equal(canonicalJson((await deviceRow()).instance_config), canonicalJson(original));
    result.nativeJsonComparisons = comparisons;
    check('native JSON key order and 1.0/1 equality survive a real mutation between route read and CAS');

    for (const [name, change] of [['case-only', instance => { instance.marker.Case = 'abc'; }],
        ['array-order', instance => { instance.marker.order.reverse(); }]]) {
        current = await read();
        const oldInstance = (await deviceRow()).instance_config, concurrent = clone(oldInstance); change(concurrent);
        beforeCas = async () => { await connection.execute('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(concurrent), deviceId]); };
        const conflict = await save({ revision: current.revision, config: clone(current.config) });
        assert.equal(beforeCas, null); assert.equal(conflict.statusCode, 409, JSON.stringify(conflict.payload));
        assert.match(conflict.payload.error, /设备配置已更新/);
        assert.equal(canonicalJson((await deviceRow()).instance_config), canonicalJson(concurrent));
        const refreshed = await read(); assert.notEqual(refreshed.revision, current.revision);
        const stale = await save({ revision: current.revision, config: clone(current.config) });
        assert.equal(stale.statusCode, 409, 'an older client revision cannot overwrite the concurrent JSON edit');
        await db.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(oldInstance), deviceId]);
        check(`actual ${name} concurrent JSON CAS and stale revision reject without overwriting the other writer`);
    }

    for (const [name, value] of [['JSON-null', 'null'], ['SQL-null', null]]) {
        await db.run('UPDATE devices SET instance_config=? WHERE id=?', [value, deviceId]);
        const row = await deviceRow(); assert.equal(row.instance_config, null);
        current = await read();
        const response = await save({ revision: current.revision, config: { version: 1, staleMs: 5000, bindings: clone(bindings) } });
        assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
        const fresh = await read(); assert.equal(response.payload.revision, fresh.revision);
        assert.equal(fresh.config.bindings.length, 2);
        assert.deepEqual(withoutInstance(await deviceRow()), protectedColumns);
        check(`actual route saves and reloads ${name} without invalid JSON fallback`);
    }
    assert.match(exactJsonEquals('instance_config', 'mysql'), /JSON_EXTRACT/);
    result.currentPredicate = exactJsonEquals('instance_config', 'mysql');
    result.success = true;
}

(async () => {
    let failure;
    try { await run(); }
    catch (error) { failure = error; result.error = errorInfo(error); console.error(error.stack || error); }
    finally {
        const cleanupErrors = [];
        try { await database?.stopDatabaseMaintenance({ backup: false }); await database?.closeDb(); }
        catch (error) { cleanupErrors.push(errorInfo(error)); }
        try { await connection?.end(); } catch (error) { cleanupErrors.push(errorInfo(error)); }
        try { await runtime?.stop(); } catch (error) { cleanupErrors.push(errorInfo(error)); }
        const cleanup = { checkedAt: new Date().toISOString(), hostPid, mysqlPid, port: config?.port,
            hostExited: hostPid ? !pidExists(hostPid) : true, mysqlExited: mysqlPid ? !pidExists(mysqlPid) : true,
            portListening: await portListening(config?.port), errors: cleanupErrors,
            retainedPrivateEvidence: true, recursiveDeletionUsed: false, blanketProcessKillUsed: false };
        fs.writeFileSync(path.join(directory, 'cleanup-proof.json'), JSON.stringify(cleanup, null, 2));
        result.cleanup = cleanup;
        if (!cleanup.hostExited || !cleanup.mysqlExited || cleanup.portListening || cleanupErrors.length) {
            failure ||= new Error('Owned MySQL fixture did not finish cleanly; see cleanup-proof.json');
            result.error ||= errorInfo(failure);
        }
        if (failure) result.success = false;
        result.passed = checks.length; result.resultFile = path.join(directory, 'result.json');
        fs.writeFileSync(result.resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ success: result.success, passed: result.passed,
            result: result.resultFile, cleanup: path.join(directory, 'cleanup-proof.json'),
            oldRawPredicateErrorReproduced: result.oldRawPredicateCases?.some(probe => probe.threw) }, null, 2));
    }
    if (failure) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
