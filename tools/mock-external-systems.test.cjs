'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SYSTEMS, DEVICES, TABLES, startServer } = require('./mock-external-systems.cjs');
const get = async (origin, apiPath) => {
  const response = await fetch(origin + apiPath, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
};

test('three systems have healthy GET endpoints and useful Chinese connection workbench', async t => {
  const running = await startServer({ port: 0 }); t.after(running.stop);
  assert.equal(running.server.address().address, '127.0.0.1');
  for (const apiPath of ['/health', ...SYSTEMS.map(system => `/${system.id}/health`)]) {
    const health = await get(running.origin, apiPath);
    assert.equal(health.simulated, true); assert.equal(health.status, 'healthy');
    assert.ok(Number.isFinite(Date.parse(health.updatedAt)));
  }
  const homeResponse = await fetch(running.origin + '/');
  assert.match(homeResponse.headers.get('content-type'), /text\/html.*utf-8/);
  const home = await homeResponse.text();
  for (const label of ['模拟 ERP', '模拟 MES', '模拟 VMS', '工厂销售管理系统', 'API 根地址', 'data.rows', '无认证', '复制路径']) assert.ok(home.includes(label), label);
  for (const table of TABLES) assert.ok(home.includes(`/${table.system}/${table.id}`));
  const catalog = await get(running.origin, '/catalog');
  assert.equal(catalog.tables.length, 6);
  for (const table of catalog.tables) {
    assert.equal(table.baseUrl, `${running.origin}/${table.system}`);
    assert.equal(table.healthPath, '/health'); assert.equal(table.rootPath, 'data.rows');
    assert.equal(table.method, 'GET'); assert.equal(table.authType, 'none');
  }
});

test('all six datasets return four marked simulation rows and declared stable field types', async t => {
  let now = Date.parse('2026-11-07T02:00:00Z');
  const running = await startServer({ port: 0, clock: () => now }); t.after(running.stop);
  const baseline = new Map();
  for (const table of TABLES) {
    const apiPath = `/${table.system}/${table.id}`;
    const result = await get(running.origin, apiPath); baseline.set(apiPath, result);
    assert.equal(result.simulated, true); assert.equal(result.system, table.system.toUpperCase());
    assert.equal(result.total, 4); assert.equal(result.total, result.data.rows.length);
    assert.deepEqual(result.data.rows.map(row => row.deviceId), DEVICES.map(device => device.deviceId));
    for (const row of result.data.rows) {
      assert.match(row.deviceName, /^模拟 /);
      for (const column of result.fields) assert.equal(typeof row[column.path], column.type, `${apiPath}:${column.path}`);
    }
  }
  now += 3000;
  for (const table of TABLES) {
    const apiPath = `/${table.system}/${table.id}`, before = baseline.get(apiPath), after = await get(running.origin, apiPath);
    assert.notEqual(after.updatedAt, before.updatedAt);
    const valueField = ({ orders: 'completedQty', inventory: 'availableQty', production: 'completedQty', devices: 'temperature', 'sales-orders': 'paidAmount', 'sales-summary': 'collectionRate' })[table.id];
    assert.notEqual(after.data.rows[0][valueField], before.data.rows[0][valueField], `${apiPath} values change`);
    for (const column of after.fields) assert.equal(typeof after.data.rows[0][column.path], column.type);
  }
});

test('ERP, MES and factory-sales VMS share object and order keys with sensible arithmetic', async t => {
  let now = Date.parse('2026-11-07T02:00:00Z');
  const running = await startServer({ port: 0, clock: () => now }); t.after(running.stop);
  for (const tick of [0, 1, 12, 29, 30, 60, 1000]) {
    now += tick * 3000;
    const erp = (await get(running.origin, '/erp/orders')).data.rows;
    const mes = (await get(running.origin, '/mes/production')).data.rows;
    const sales = (await get(running.origin, '/vms/sales-orders')).data.rows;
    erp.forEach((order, index) => {
      assert.equal(order.deviceId, mes[index].deviceId); assert.equal(order.deviceId, sales[index].deviceId);
      assert.equal(order.orderNo, mes[index].orderNo); assert.equal(order.orderNo, sales[index].orderNo);
      assert.equal(order.salesOrderNo, sales[index].salesOrderNo); assert.equal(order.customerId, sales[index].customerId);
      assert.equal(order.customerName, sales[index].customerName); assert.equal(order.completedQty, mes[index].completedQty);
      assert.ok(sales[index].shippedQty <= mes[index].completedQty);
      assert.equal(sales[index].salesAmount, sales[index].salesQty * sales[index].unitPrice);
      assert.equal(sales[index].outstandingAmount, sales[index].salesAmount - sales[index].paidAmount);
    });
    for (const row of (await get(running.origin, '/vms/sales-summary')).data.rows) {
      assert.ok(row.paidAmount <= row.salesAmount); assert.equal(row.outstandingAmount, row.salesAmount - row.paidAmount);
      assert.ok(row.collectionRate >= 0 && row.collectionRate <= 100);
    }
    for (const row of (await get(running.origin, '/mes/devices')).data.rows) assert.equal(row.pushAtEnd && row.returnAtEnd, false);
  }
});

test('deviceId query returns a single exact record or empty set, never arbitrary real IDs', async t => {
  const running = await startServer({ port: 0 }); t.after(running.stop);
  for (const table of TABLES) {
    const apiPath = `/${table.system}/${table.id}`;
    const match = await get(running.origin, `${apiPath}?deviceId=${DEVICES[0].deviceId}`);
    assert.equal(match.total, 1); assert.equal(match.data.rows[0].deviceId, DEVICES[0].deviceId);
    const empty = await get(running.origin, `${apiPath}?deviceId=not-a-mock-device`);
    assert.equal(empty.total, 0); assert.deepEqual(empty.data.rows, []);
  }
});

test('unknown endpoints are 404 and all non-GET/control requests are rejected without mutation', async t => {
  let now = Date.parse('2026-11-07T02:00:00Z');
  const running = await startServer({ port: 0, clock: () => now }); t.after(running.stop);
  const before = await get(running.origin, '/mes/devices');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await fetch(running.origin + '/mes/devices', { method, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  for (const apiPath of ['/unknown', '/controls', '/erp/missing', '/vms/admin']) {
    const response = await fetch(running.origin + apiPath); assert.equal(response.status, 404);
    assert.equal((await response.json()).simulated, true);
  }
  assert.deepEqual(await get(running.origin, '/mes/devices'), before);
});

test('cannot listen publicly or start a second service on the same port; stop releases port', async () => {
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0 }), /127\.0\.0\.1/);
  await assert.rejects(startServer({ port: -1 }), /端口/);
  const first = await startServer({ port: 0 });
  const port = first.server.address().port;
  try { await assert.rejects(startServer({ port }), error => error.code === 'EADDRINUSE'); }
  finally { await Promise.all([first.stop(), first.stop()]); }
  assert.equal(first.server.listening, false);
  const restarted = await startServer({ port }); await restarted.stop();
});

test('actual backend HTTP connector, field discovery and dataset mapper consume every mock table in isolated config', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mock-contract-'));
  const previousEnv = { APP_DATA_DIR: process.env.APP_DATA_DIR, DATA_SOURCE_BACKUP_DIR: process.env.DATA_SOURCE_BACKUP_DIR };
  process.env.APP_DATA_DIR = directory; process.env.DATA_SOURCE_BACKUP_DIR = path.join(directory, 'backups');
  const running = await startServer({ port: 0 });
  t.after(async () => {
    await running.stop();
    for (const [key, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
    // Delete only the exact verified temp directory created by this test.
    const absolute = path.resolve(directory), allowed = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(allowed) && path.basename(absolute).startsWith('dt-mock-contract-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const sources = require('../backend/services/dataSources.js');
  const datasets = require('../backend/services/dataSets.js');
  for (const system of SYSTEMS) {
    const draft = { id: `mock_${system.id}`, name: system.name, sourceType: 'http_api', type: 'http_api', connector: 'http', baseUrl: `${running.origin}/${system.id}`, healthPath: '/health', responseFormat: 'json', authType: 'none', enabled: true };
    const check = await sources.testDataSource(draft); assert.equal(check.success, true, check.error);
    sources.saveDataSource({ ...draft, healthToken: check.healthToken });
  }
  for (const table of TABLES) {
    let assignedValue = false;
    const definition = { id: `mock_${table.system}_${table.id.replace(/-/g, '_')}`, name: table.name, connectionId: `mock_${table.system}`, source: 'http', enabled: true, request: { method: 'GET', path: `/${table.id}`, parameters: [] }, rootPath: 'data.rows', columns: table.fields.map(column => ({ ...column, name: column.path, role: column.path === 'deviceName' ? 'category' : column.type === 'number' && !assignedValue ? (assignedValue = true, 'value') : '' })) };
    const discovery = await datasets.readDefinition(definition, {}, 'factory_default', true, true);
    assert.ok(discovery.roots.includes('data.rows'));
    assert.ok(discovery.fields.some(column => column.path === 'deviceName'));
    const result = await datasets.readDefinition(definition, {}, 'factory_default', true);
    assert.equal(result.quality, 'good', result.error); assert.equal(result.rows.length, 4);
    assert.equal(result.rows[0].deviceId, DEVICES[0].deviceId);
    const mapped = datasets.normalizeDataSet({ ...definition, match: { field: 'deviceId', contextKey: 'deviceId' } });
    const one = await datasets.readDefinition(mapped, { deviceId: DEVICES[0].deviceId }, 'factory_default', true);
    assert.equal(one.rows.length, 1); assert.equal(one.quality, 'good');
  }
});

test('CLI provides help and reports occupied-port error without starting or killing unrelated process', async t => {
  const running = await startServer({ port: 0 }); t.after(running.stop);
  const port = running.server.address().port;
  const invoke = async args => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mock-external-systems.cjs'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const result = await Promise.race([once(child, 'close'), new Promise((_, reject) => { const timer = setTimeout(() => { child.kill(); reject(Error('CLI timeout')); }, 5000); timer.unref(); })]);
    return { code: result[0], output };
  };
  const help = await invoke(['--help']); assert.equal(help.code, 0); assert.match(help.output, /ERP.*MES.*VMS/);
  const collision = await invoke(['--port', String(port)]); assert.equal(collision.code, 1); assert.match(collision.output, /端口已被占用/);
  assert.equal((await get(running.origin, '/health')).status, 'healthy');
});
