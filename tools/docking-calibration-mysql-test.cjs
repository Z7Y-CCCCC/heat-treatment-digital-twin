'use strict';
// Real MySQL CAS regression. Owns a fresh datadir and random loopback port;
// never reads commissioned database credentials or controls a Windows service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory, findFreePort } = require('../backend/scripts/integration-test-utils.cjs');
const { EnduranceMysql } = require('../backend/scripts/endurance-mysql.cjs');
const { createSmokeEnvironment } = require('../desktop/scripts/smoke-sandbox.cjs');
const mysql = require('../backend/node_modules/mysql2/promise');
const directory = createRunDirectory('docking-calibration-mysql');
const environment = createSmokeEnvironment(directory);
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
const { loadDeviceLoadingPorts } = require('../backend/services/loadingPorts');
const { saveDockingCalibration } = require('../backend/services/dockingCalibration');
const runtime = path.resolve(process.argv[2] || 'C:/Program Files/MySQL/MySQL Server 5.7');
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let owned, connection, config, cleanupComplete = false, identity;
let cleanupPromise;

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await connection?.end(); connection = null;
    if (owned) {
      await owned.dispose();
      assert.deepEqual(await owned.captureOwnedProcesses(), [], 'Owned MySQL process tree must be gone');
      assert.equal(fs.existsSync(owned.aliasRoot), false, 'Owned aliases removed after server exit');
    }
    cleanupComplete = true;
  })();
  return cleanupPromise;
}
function facade(db) {
  return {
    get: async (sql, args = []) => (await db.query(sql, args))[0][0] || null,
    all: async (sql, args = []) => (await db.query(sql, args))[0],
    run: async (sql, args = []) => {
      const [result] = await db.query(sql, args);
      return { affectedRows: result.affectedRows, changes: result.affectedRows, insertId: result.insertId };
    }
  };
}
async function transaction(body, factoryId = 'factory-a') {
  const db = await mysql.createConnection(config);
  try {
    await db.beginTransaction();
    const result = await saveDockingCalibration(facade(db), body, factoryId, 'mysql');
    await db.commit(); return result;
  } catch (error) { await db.rollback(); throw error; }
  finally { await db.end(); }
}
async function payload(cartId = 'cart-a') {
  const db = facade(connection);
  const [target, cart] = await Promise.all([
    loadDeviceLoadingPorts(db, 'target-a', 'factory-a'),
    loadDeviceLoadingPorts(db, cartId, 'factory-a')
  ]);
  const line = await db.get('SELECT * FROM `lines` WHERE id=?', ['line-a']);
  return { deviceId: 'target-a', cartId, deviceRevision: target.revision, cartRevision: cart.revision,
    expectedLine: { id: line.id, workshop_id: line.workshop_id, layout_json: line.layout_json },
    position: { x: target.device.pos_x + .1, y: target.device.pos_y + .05 } };
}

(async () => {
  owned = new EnduranceMysql(directory, runtime, { processTimeoutMs: 20000 });
  owned.password = ''; owned.prepareAliases();
  owned.launch(['--no-defaults', '--initialize-insecure', `--basedir=${owned.runtimeAlias}`, `--datadir=${owned.dataAlias}`, '--console']);
  let timer;
  const initialized = await Promise.race([owned.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Private MySQL initialization timeout')), 120000); })]).finally(() => clearTimeout(timer));
  assert.equal(initialized, 0, 'Private MySQL initialization failed');
  owned.port = await findFreePort();
  // MySQL 5.7 has no mysqlx option. --no-defaults excludes the site's my.ini.
  owned.launch(['--no-defaults', `--basedir=${owned.runtimeAlias}`, `--datadir=${owned.dataAlias}`, '--bind-address=127.0.0.1', `--port=${owned.port}`, '--max-allowed-packet=64M', '--innodb-buffer-pool-size=64M', '--skip-log-bin', '--console']);
  const credentials = { host: '127.0.0.1', port: owned.port, user: 'root', password: '', dateStrings: true };
  for (let attempt = 0; attempt < 150; attempt++) {
    if (owned.child.exitCode !== null) throw Error('Owned MySQL exited before readiness');
    try { connection = await mysql.createConnection({ ...credentials, connectTimeout: 1000 }); break; }
    catch { await sleep(200); }
  }
  assert.ok(connection, 'Owned MySQL must become ready');
  [[identity]] = await connection.query('SELECT @@version AS version, @@datadir AS datadir, @@port AS port');
  assert.equal(fs.realpathSync(identity.datadir).replace(/[\\/]+$/, ''), fs.realpathSync(owned.dataDir));
  assert.equal(Number(identity.port), owned.port);
  assert.match(identity.version, /^5\.7\./, 'This regression validates the commissioned MySQL major version in a separate instance');
  assert.ok((await owned.captureOwnedProcesses()).length > 0);
  pass('MySQL 5.7 identity matches the newly owned datadir, port and process tree');
  const database = 'docking_calibration_private';
  await connection.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE ${database}`); config = { ...credentials, database };
  for (const sql of [
    'CREATE TABLE workshops (id VARCHAR(120) PRIMARY KEY,factory_id VARCHAR(120) NOT NULL)',
    'CREATE TABLE `lines` (id VARCHAR(120) PRIMARY KEY,workshop_id VARCHAR(120) NOT NULL,layout_json JSON)',
    'CREATE TABLE models (id VARCHAR(120) PRIMARY KEY,name VARCHAR(255),file_path VARCHAR(255),factory_id VARCHAR(120) NULL,placement_level VARCHAR(50),asset_type VARCHAR(50),default_scale DOUBLE NULL,metadata JSON)',
    'CREATE TABLE devices (id VARCHAR(120) PRIMARY KEY,name VARCHAR(255),model_type VARCHAR(120),model_file VARCHAR(255),line_id VARCHAR(120),coordinate_space VARCHAR(50),pos_x DOUBLE,pos_y DOUBLE,pos_z DOUBLE,rotation_y DOUBLE,scale DOUBLE,instance_config JSON,plc_enabled INTEGER)',
    'CREATE TABLE data_points (id INTEGER PRIMARY KEY AUTO_INCREMENT,device_id VARCHAR(120),name VARCHAR(120),label VARCHAR(255),data_type VARCHAR(50),access_type VARCHAR(50),category VARCHAR(50),value_role VARCHAR(50))'
  ]) await connection.query(sql);
  const layout = { version: 1, lanes: [{ id: 'lane-a', offsetZ: -4, length: 60 }], rails: [{ id: 'rail-a', offsetZ: 0, length: 60 }] };
  const metadata = { loadingPorts: { version: 1, inlet: { position: [0, 1, 1], direction: [0, 0, 1], nodeName: '' }, outlet: { position: [0, 1, -1], direction: [0, 0, -1], nodeName: '' } } };
  await connection.query('INSERT INTO workshops VALUES (?,?),(?,?)', ['ws-a', 'factory-a', 'ws-b', 'factory-b']);
  await connection.query('INSERT INTO `lines` VALUES (?,?,?)', ['line-a', 'ws-a', JSON.stringify(layout)]);
  await connection.query('INSERT INTO models VALUES (?,?,?,?,?,?,?,?)', ['model-a', 'Fixture model', '/fixture/model.glb', null, 'device', 'model', 1, JSON.stringify(metadata)]);
  const insert = 'INSERT INTO devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
  await connection.query(insert, ['target-a', 'Fixture station', 'model-a', null, 'line-a', 'line_local', 10, .2, -4, 0, 1, JSON.stringify({ laneId: 'lane-a', laneLineId: 'line-a', preserve: { Case: 'ABC' } }), 0]);
  await connection.query(insert, ['cart-a', 'Fixture cart', 'model-a', null, 'line-a', 'line_local', 2, 0, 0, 0, 1, JSON.stringify({ railId: 'rail-a', railLineId: 'line-a', role: 'auxiliary', preserve: { Case: 'CART' } }), 0]);
  const db = facade(connection), targetBefore = await db.get('SELECT * FROM devices WHERE id=?', ['target-a']);
  const cartBefore = await db.get('SELECT * FROM devices WHERE id=?', ['cart-a']), modelBefore = await db.get('SELECT * FROM models WHERE id=?', ['model-a']);
  let body = await payload(), saved = await transaction(body);
  assert.equal(saved.length, 1);
  for (const key of Object.keys(targetBefore)) if (!['pos_x', 'pos_y'].includes(key)) assert.deepEqual(saved[0][key], targetBefore[key], `Untouched field ${key}`);
  assert.equal(saved[0].pos_x, body.position.x); assert.equal(saved[0].pos_y, body.position.y);
  assert.deepEqual(await db.get('SELECT * FROM devices WHERE id=?', ['cart-a']), cartBefore);
  assert.deepEqual(await db.get('SELECT * FROM models WHERE id=?', ['model-a']), modelBefore);
  pass('Actual MySQL UPDATE with materialized cart reference commits only target X/Y without 1093');
  await assert.rejects(transaction(body), error => error.statusCode === 409);
  pass('Reusing a stale target snapshot is rejected');
  body = await payload(); await connection.query('UPDATE devices SET pos_x=pos_x+.1 WHERE id=?', ['cart-a']);
  await assert.rejects(transaction(body), error => error.statusCode === 409);
  pass('A changed cart reference rejects the calibration');
  body = await payload(); await connection.query('UPDATE models SET default_scale=1.2 WHERE id=?', ['model-a']);
  await assert.rejects(transaction(body), error => error.statusCode === 409);
  pass('A changed model scale rejects the calibration');
  body = await payload(); await connection.query('UPDATE `lines` SET layout_json=? WHERE id=?', [JSON.stringify({ ...layout, flowDirection: 'left' }), 'line-a']);
  await assert.rejects(transaction(body), error => error.statusCode === 409);
  pass('A changed line snapshot rejects the calibration');
  body = await payload(); await assert.rejects(transaction(body, 'factory-b'), error => error.statusCode === 404);
  pass('Cross-factory request cannot write the selected physical station');
  body = await payload();
  const outcomes = await Promise.allSettled([transaction(body), transaction({ ...body, position: { x: body.position.x + .1, y: body.position.y } })]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(row => row.status === 'rejected'); assert.equal(rejected.reason.statusCode, 409);
  pass('Two real concurrent MySQL transactions have exactly one successful CAS writer');
  await connection.query('UPDATE models SET default_scale=NULL WHERE id=?', ['model-a']);
  saved = await transaction(await payload()); assert.equal(saved.length, 1);
  assert.equal((await db.get('SELECT default_scale FROM models WHERE id=?', ['model-a'])).default_scale, null);
  pass('Nullable legacy model scale remains NULL and does not cause false conflict');
  await connection.query('UPDATE devices SET pos_x=90000 WHERE id=?', ['target-a']);
  body = await payload(); body.position.x = 90000.00001;
  await assert.rejects(transaction(body), error => error.statusCode === 400);
  pass('Float32-invisible physical adjustment is rejected by the actual MySQL save path');
  await cleanup();
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory,
    mysqlVersion: identity.version, mysqlPort: identity.port, datadir: owned.dataDir,
    cleanupComplete, operatorDatabaseTouched: false, serviceControlActions: 0, installerBuilt: false }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, mysqlVersion: identity.version, cleanupComplete, directory }));
})().catch(async error => {
  try { await cleanup(); } catch (cleanupError) { error = new AggregateError([error, cleanupError], 'Private MySQL test/cleanup failed'); }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, checks, directory, error: error.stack, cleanupComplete }, null, 2));
  console.error(error); console.error(`Evidence: ${directory}`); process.exitCode = 1;
});
