'use strict';
// Isolated maintenance contracts: no application database initializer, real
// driver, device deletion, or user configuration is loaded by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../cleanup-deleted-device-dashboard.cjs');
const service = require('../../backend/services/dashboardDeviceDeletion.js');
const { cleanupDeletedDeviceContent: transform } = require('../../shared/dashboardDeviceDeletion.mjs');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value) : copy(value);
const OUTPUT = path.resolve(__dirname, '../../output');
const DELETED = 'fixture-deleted', ALIVE = 'fixture-survivor';

function documentFixture() {
  const widget = (id, extra = {}) => ({ id, type: 'text', title: '原标题', visible: true, locked: true, zIndex: 4,
    frame: { x: 25, y: 50, width: 220, height: 45, rotation: 0 }, runtimeTarget: 'web',
    style: { color: '#eef7ff', background: '#101527', borderRadius: 18, padding: 8, fontSize: 21, surfaceSkin: 'inline' },
    content: { text: '{value} ℃', customLabel: '不改正文', rows: [{ label: '原字段', value: 1 }] },
    data: { mode: 'runtime', deviceScope: 'current', deviceId: '', path: 'device.name', readOnly: true },
    visibility: { viewIds: [], viewModes: [], rules: [], ruleMode: 'all', matchBoundDevice: false },
    conditions: [{ operator: '==', value: 1, color: '#ff0000' }], events: [], metadata: { authoredBy: 'Ethan' }, ...extra });
  const view = (id, extra = {}) => ({ id, mode: 'device', targetType: 'device', targetId: '',
    parentViewId: 'factory_overview', returnViewId: 'factory_overview', componentState: { show: [], hide: [] }, ...extra });
  return { schemaVersion: 3, projectId: 'fixture-project', sceneId: 'fixture-scene', name: '原始布局',
    metadata: { revision: 7, updatedAt: '2026-11-01T10:00:00.000Z', retained: { original: true } },
    canvas: { width: 1920, height: 1080 }, theme: { accentColor: '#a2a7ed' }, parameters: [{ id: 'original' }],
    scene: { defaultViewId: 'factory_overview', layout: { original: true }, views: [
      view('factory_overview', { mode: 'factory', targetType: 'factory', parentViewId: '', returnViewId: '' }),
      view('device_shared'), view('private_deleted', { targetId: DELETED, parentViewId: 'device_shared' }),
    ] },
    tooltipTemplates: { version: 1, defaults: { device: 'shared-tooltip' }, templates: [{ id: 'shared-tooltip',
      kind: 'device', name: '共享提示', widgets: [widget('hover-current', { data: { mode: 'runtime', deviceScope: 'current', path: 'hover.device.name' } })] }] },
    widgets: [
      widget('a-private', { visibility: { viewIds: ['private_deleted'], rules: [] },
        data: { mode: 'plc', deviceScope: 'fixed', deviceId: DELETED, pointId: 'fixture-point-deleted', readOnly: true } }),
      widget('b-events', { events: [{ action: 'switch_view', viewId: 'private_deleted', deviceId: DELETED },
        { action: 'switch_view', viewId: 'device_shared', deviceId: ALIVE }, { action: 'open_url', url: '/history/fixture-deleted' }] }),
      widget('c-list', { content: { text: '原始设备列表', deviceIds: [ALIVE, DELETED],
        deviceActions: { [DELETED]: [{ action: 'switch_view', viewId: 'private_deleted', deviceId: DELETED }],
          [ALIVE]: [{ action: 'switch_view', viewId: 'device_shared', deviceId: ALIVE, trigger: 'click', custom: { retained: true, deviceIds: [DELETED, ALIVE] } }],
          'unrelated-action-key': [{ action: 'open_url', url: '/history/fixture-deleted' }] },
        arbitraryMap: { [DELETED]: 'raw unrelated data' } } }),
      widget('d-rotation', { data: { mode: 'plc', deviceScope: 'rotation', rotationDeviceIds: [DELETED, ALIVE],
        pointId: 'fixture-point-live', pointKey: 'analog.temp', unit: '℃', readOnly: true } }),
      widget('e-exhausted', { content: { text: '不改标题', deviceIds: [DELETED] } }),
      widget('f-untouched'),
      widget('g-shared-fixed', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: DELETED,
        pointId: 'fixture-point-deleted', unit: '℃', readOnly: true } }),
    ] };
}

function harness(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'device-owned-cleanup-transaction-fixture-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(OUTPUT + path.sep), 'Recursive test cleanup must remain inside workspace/output');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const controls = { ...options }, original = documentFixture();
  const unchanged = copy(original); unchanged.sceneId = 'untouched-scene'; unchanged.widgets = [];
  unchanged.scene.views = [copy(original.scene.views[0])];
  const database = {
    factories: [{ id: 'fixture-factory', name: '测试工厂', retained: { original: true } }],
    scenes: [{ id: original.sceneId, project_id: original.projectId, draft_json: JSON.stringify(original), draft_revision: 7,
      updated_at: '2026-11-01 10:00:00', published_release_id: 'release-keep', other_column: 'keep-scene' },
    { id: unchanged.sceneId, project_id: original.projectId, draft_json: JSON.stringify(unchanged), draft_revision: 7,
      updated_at: '2026-11-01 10:00:00', published_release_id: 'release-keep', other_column: 'keep-second-scene' }],
    widgets: original.widgets.map(widget => ({ id: widget.id, scene_id: original.sceneId, widget_type: widget.type, visible: 1,
      config_json: JSON.stringify({ ...copy(widget.content), style: copy(widget.style), visibility: copy(widget.visibility), events: copy(widget.events),
        legacyOnly: { keep: widget.id, empty: null }, unrecognized: ['raw', 17] }),
      binding_json: JSON.stringify({ ...copy(widget.data), legacyBinding: { original: true } }),
      x: widget.frame.x, y: widget.frame.y, width: widget.frame.width, height: widget.frame.height, unrelated: `keep-${widget.id}` })),
    bindings: [{ id: 'binding-private', widget_id: 'a-private', expression: 'keep-until-owner-deleted' },
      { id: 'binding-shared', widget_id: 'g-shared-fixed', expression: 'do-not-rebind' }],
    releases: [{ id: 'release-keep', project_id: original.projectId, document_json: 'unchanged current published snapshot' },
      { id: 'release-history', project_id: original.projectId, document_json: 'unchanged historical snapshot' }],
    settings: [{ factory_id: 'fixture-factory', key: 'other-settings', value: '{"retain":true}', updated_at: 'original' }],
    workshops: [{ id: 'fixture-workshop', factory_id: 'fixture-factory' }],
    devices: [{ id: ALIVE, line_id: 'fixture-line', instance_config: '{}', line_factory_id: 'fixture-factory' }],
    points: [{ id: 'fixture-point-deleted', device_id: DELETED }, { id: 'fixture-point-live', device_id: ALIVE }],
  };
  if (options.jsonObjects) {
    for (const row of database.scenes) row.draft_json = parse(row.draft_json);
    for (const row of database.widgets) { row.config_json = parse(row.config_json); row.binding_json = parse(row.binding_json); }
  }
  const initial = copy(database);
  let persisted = copy(database), working = null, auditDirectory = '', beforePath;
  const counts = {}, writes = [], queries = [];
  const reset = () => {
    for (const key of ['connections', 'begin', 'commit', 'rollback', 'end', 'sceneUpdates', 'mirrorUpdates', 'deletions', 'cleaned']) counts[key] = 0;
    writes.length = queries.length = 0;
  };
  reset();
  const values = { config: path.join(directory, 'fake-config.json'), factory: 'fixture-factory', device: [DELETED] };
  fs.writeFileSync(values.config, JSON.stringify({ type: 'mysql', host: 'fixture-do-not-connect', port: 1,
    user: 'fixture', password: 'fixture', database: 'fixture-only' }));
  const io = { ...fs,
    mkdtempSync() {
      if (controls.failDirectory) throw new Error('Injected directory creation failure');
      auditDirectory = fs.mkdtempSync(path.join(directory, 'audit-')); return auditDirectory;
    },
    writeFileSync(file, data, settings) {
      const name = path.basename(file); writes.push(name);
      if (name === controls.failWrite) {
        const error = new Error(`Injected write failure: ${name}`); error.code = 'ENOSPC'; throw error;
      }
      return fs.writeFileSync(file, data, settings);
    },
  };
  const rows = values => [copy(values)];
  const encode = value => controls.jsonObjects ? parse(value) : value;
  const db = {
    async query(sql) {
      queries.push({ sql, params: [] });
      if (sql === 'SET TRANSACTION READ ONLY' || sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return;
      if (sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT') return this.beginTransaction();
      assert.fail(`Unexpected transaction command in isolated fixture: ${sql}`);
    },
    async beginTransaction() { counts.begin++; assert.equal(working, null); working = copy(persisted); },
    async execute(rawSql, params = []) {
      assert.ok(working, 'SQL must run inside an isolated fixture transaction');
      queries.push({ sql: rawSql, params: copy(params) });
      const sql = rawSql.replace(/\s+FOR UPDATE\s*$/i, '');
      if (controls.failSql && sql.includes(controls.failSql)) throw new Error('Injected SQL failure');
      if (sql === 'SELECT * FROM factories WHERE id=?') {
        const result = copy(working.factories.filter(row => row.id === params[0]));
        if (counts.cleaned && controls.badReadback === 'factory') result[0].name = 'corrupted readback';
        return rows(result);
      }
      if (sql === 'SELECT id FROM factories WHERE id=?') return rows(working.factories.filter(row => row.id === params[0]).map(({ id }) => ({ id })));
      if (/^SELECT id FROM devices WHERE id IN /.test(sql)) return rows(working.devices.filter(row => params.includes(row.id)).map(({ id }) => ({ id })));
      if (/^SELECT id FROM data_points WHERE device_id IN /.test(sql)) return rows(working.points.filter(row => params.includes(row.device_id)).map(({ id }) => ({ id })));
      if (sql === 'SELECT id FROM workshops WHERE factory_id=?') return rows(working.workshops.filter(row => row.factory_id === params[0]).map(({ id }) => ({ id })));
      if (sql.startsWith('SELECT d.id,d.line_id,d.instance_config,w.factory_id AS line_factory_id')) return rows(working.devices);
      if (sql.startsWith('SELECT s.* FROM scenes s JOIN projects')) {
        return rows(sql.includes('WHERE s.id=?') ? working.scenes.filter(row => row.id === params[0]) : working.scenes);
      }
      if (sql.startsWith('SELECT w.* FROM widgets w JOIN scenes')) {
        const result = copy(working.widgets);
        if (counts.cleaned && controls.badReadback === 'mirror') {
          const row = result.find(row => row.id === 'f-untouched'), config = parse(row.config_json);
          config.legacyOnly.keep = 'corrupted readback'; row.config_json = encode(JSON.stringify(config));
        }
        return rows(result);
      }
      if (sql.startsWith('SELECT b.* FROM bindings b JOIN widgets')) return rows(working.bindings);
      if (sql.startsWith('SELECT r.* FROM releases r JOIN projects')) {
        const result = copy(working.releases);
        if (counts.cleaned && controls.badReadback === 'publication') result[0].document_json = 'corrupted publication';
        return rows(result);
      }
      if (sql === 'SELECT * FROM factory_settings WHERE factory_id=? ORDER BY `key`') return rows([...working.settings].sort((a, b) => a.key.localeCompare(b.key)));
      if (sql === 'SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?') return rows(working.settings.filter(row => row.factory_id === params[0] && row.key === params[1]).map(({ value }) => ({ value })));
      if (sql === 'SELECT * FROM widgets WHERE scene_id=?') return rows(working.widgets.filter(row => row.scene_id === params[0]));
      if (sql === 'SELECT scene_id FROM widgets WHERE id=?') return rows(working.widgets.filter(row => row.id === params[0]).map(({ scene_id }) => ({ scene_id })));
      if (sql === 'SELECT COUNT(*) AS total FROM widgets WHERE scene_id=?') return rows([{ total: working.widgets.filter(row => row.scene_id === params[0]).length }]);
      if (sql === 'SELECT COUNT(*) AS total FROM bindings WHERE widget_id=?') return rows([{ total: working.bindings.filter(row => row.widget_id === params[0]).length }]);
      if (sql === 'UPDATE factories SET id=id WHERE id=?' || sql === 'UPDATE scenes SET draft_revision=draft_revision WHERE id=?') return [{ affectedRows: 1 }];
      if (sql.startsWith('UPDATE scenes SET draft_json=')) {
        counts.sceneUpdates++;
        const [draft, revision, id, expected] = params, row = working.scenes.find(row => row.id === id);
        if (controls.failCas || !row || row.draft_revision !== expected) return [{ affectedRows: 0 }];
        row.draft_json = encode(draft); row.draft_revision = revision; row.updated_at = 'fixture current timestamp';
        return [{ affectedRows: 1 }];
      }
      if (sql === 'DELETE FROM bindings WHERE widget_id=?') {
        const old = working.bindings.length; working.bindings = working.bindings.filter(row => row.widget_id !== params[0]);
        return [{ affectedRows: old - working.bindings.length }];
      }
      if (sql === 'DELETE FROM widgets WHERE id=? AND scene_id=?') {
        counts.deletions++; const old = working.widgets.length;
        working.widgets = working.widgets.filter(row => row.id !== params[0] || row.scene_id !== params[1]);
        return [{ affectedRows: old - working.widgets.length }];
      }
      if (sql === 'UPDATE widgets SET config_json=?,binding_json=?,visible=? WHERE id=? AND scene_id=?') {
        counts.mirrorUpdates++;
        if (counts.mirrorUpdates === controls.failMirrorUpdate) throw new Error('Injected mirror SQL failure');
        const [config, binding, visible, id, sceneId] = params;
        const row = working.widgets.find(row => row.id === id && row.scene_id === sceneId);
        if (!row) return [{ affectedRows: 0 }];
        row.config_json = encode(config); row.binding_json = encode(binding); row.visible = visible;
        return [{ affectedRows: 1 }];
      }
      if (sql === 'SELECT draft_json,draft_revision FROM scenes WHERE id=?') {
        const row = working.scenes.find(row => row.id === params[0]);
        const result = { draft_json: row.draft_json, draft_revision: row.draft_revision };
        if (controls.badRevisionReadback) result.draft_revision++;
        if (controls.badDraftReadback) { const doc = parse(row.draft_json); doc.canvas.width++; result.draft_json = encode(JSON.stringify(doc)); }
        return rows([result]);
      }
      if (sql === 'INSERT INTO factory_settings(factory_id,`key`,value) VALUES(?,?,?)') {
        const [factory_id, key, value] = params; working.settings.push({ factory_id, key, value }); return [{ affectedRows: 1 }];
      }
      if (sql === 'UPDATE factory_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE factory_id=? AND `key`=?') {
        const [value, factoryId, key] = params, row = working.settings.find(row => row.factory_id === factoryId && row.key === key);
        row.value = value; row.updated_at = 'fixture current timestamp'; return [{ affectedRows: 1 }];
      }
      assert.fail(`Unexpected SQL in isolated maintenance fixture: ${rawSql}`);
    },
    async commit() {
      assert.ok(working); counts.commit++;
      for (const name of ['before.json', 'after.json', 'prepared.json']) assert.ok(fs.existsSync(path.join(auditDirectory, name)), `Commit requires durable ${name}`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(auditDirectory, 'prepared.json'), 'utf8')).committed, false);
      persisted = copy(working); working = null;
    },
    async rollback() { counts.rollback++; working = null; if (controls.failRollback) throw new Error('Injected rollback failure'); },
    async end() { counts.end++; },
  };
  const mysql = { async createConnection(config) {
    counts.connections++; assert.equal(config.host, 'fixture-do-not-connect'); assert.equal(config.dateStrings, true); return db;
  } };
  const injectedService = { ...service, async cleanupDashboardDeviceDeletion(tx, args) {
    const plan = await service.cleanupDashboardDeviceDeletion(tx, { ...args, now: () => '2026-11-07T12:00:00.000Z' });
    counts.cleaned++; return plan;
  } };
  const run = overrides => tool.main({ values: { ...values, apply: true, before: beforePath, ...overrides }, mysql, fs: io, service: injectedService, transform });
  return { initial, original, controls, counts, writes, queries, values, run,
    current: () => copy(persisted), mutate: edit => edit(persisted), auditDirectory: () => auditDirectory,
    async review() { const report = await run({ apply: false }); beforePath = report.backup; reset(); return report; },
  };
}

function assertRolledBack(h, baseline = h.initial) {
  assert.deepEqual(h.current(), baseline, 'Any pre-commit failure must preserve the complete database fixture');
  assert.equal(h.counts.commit, 0); assert.equal(h.counts.rollback, 1); assert.equal(h.counts.end, 1);
}

test('exports the maintenance entry point and independent verification contracts', () => {
  for (const name of ['main', 'verify', 'independentMirror']) assert.equal(typeof tool[name], 'function');
});

test('dry run is read-only, writes review proof, and closes its snapshot connection', async t => {
  const h = harness(t), report = await h.run({ apply: false });
  assert.equal(report.dryRun, true); assert.equal(report.noDatabaseWrites, true);
  assert.equal(report.removedWidgets, 1); assert.equal(report.removedViews, 1); assert.equal(report.removedBindings, 1);
  assert.deepEqual(h.current(), h.initial); assert.equal(h.counts.commit, 0); assert.equal(h.counts.rollback, 1); assert.equal(h.counts.end, 1);
  assert.ok(h.queries.some(({ sql }) => sql === 'SET TRANSACTION READ ONLY'));
  assert.ok(h.queries.every(({ sql }) => !/^\s*(?:UPDATE|DELETE|INSERT)\b/.test(sql)));
  assert.deepEqual(h.writes, ['before.json', 'result.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(report.backup, 'utf8')).state.scenes, h.initial.scenes);
});

test('apply without a reviewed --before is rejected before creating a connection', async t => {
  const h = harness(t); await assert.rejects(h.run(), /--before from the reviewed dry run is required/);
  assert.equal(h.counts.connections, 0); assert.deepEqual(h.current(), h.initial); assert.deepEqual(h.writes, []);
});

test('directory creation failure occurs before creating a connection', async t => {
  const h = harness(t, { failDirectory: true });
  await assert.rejects(h.run({ apply: false }), /Injected directory creation failure/);
  assert.equal(h.counts.connections, 0); assert.equal(h.counts.end, 0); assert.deepEqual(h.current(), h.initial);
});

test('a live device is rejected without deleting it or its dashboard', async t => {
  const h = harness(t); h.mutate(database => database.devices.push({ id: DELETED, line_id: 'fixture-line', line_factory_id: 'fixture-factory', instance_config: '{}' }));
  const baseline = h.current(); await assert.rejects(h.run({ apply: false }), /target device still exists/);
  assertRolledBack(h, baseline); assert.deepEqual(h.writes, []);
});

for (const [label, edit] of [
  ['factory', database => { database.factories[0].name = 'other edit'; }],
  ['revision', database => { database.scenes[0].draft_revision++; }],
  ['raw draft', database => { const doc = parse(database.scenes[0].draft_json); doc.widgets[5].content.text = 'other edit'; database.scenes[0].draft_json = JSON.stringify(doc); }],
  ['legacy mirror', database => { database.widgets[5].unrelated = 'other edit'; }],
  ['bindings', database => { database.bindings[1].expression = 'other edit'; }],
  ['settings', database => { database.settings[0].value = 'other edit'; }],
  ['historical release', database => { database.releases[1].document_json = 'other edit'; }],
  ['new scene', database => { database.scenes.push({ ...copy(database.scenes[1]), id: 'new-scene' }); }],
]) test(`complete captured-state ${label} drift is rejected before canonical writes`, async t => {
  const h = harness(t); await h.review(); h.mutate(edit); const baseline = h.current();
  await assert.rejects(h.run(), /Configuration changed since the reviewed dry run/);
  assertRolledBack(h, baseline); assert.equal(h.counts.sceneUpdates, 0); assert.equal(h.counts.deletions, 0); assert.equal(h.counts.mirrorUpdates, 0);
});

test('a numeric device alias added after review is rejected even when captured drafts and mirrors are unchanged', async t => {
  const h = harness(t); h.values.device = ['1'];
  h.mutate(database => {
    const doc = parse(database.scenes[0].draft_json), widget = doc.widgets.find(row => row.id === 'b-events');
    widget.visibility = { viewIds: ['device_shared'], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: '1' }], ruleMode: 'all' };
    database.scenes[0].draft_json = JSON.stringify(doc);
    const mirror = database.widgets.find(row => row.id === widget.id), config = parse(mirror.config_json);
    config.visibility = copy(widget.visibility); mirror.config_json = JSON.stringify(config);
  });
  const preview = await h.review(); assert.ok(preview.scenes[0].removedWidgetIds.includes('b-events'));
  const reviewedState = h.current();
  h.mutate(database => database.devices.push({ id: '01', line_id: 'fixture-line', line_factory_id: 'fixture-factory', instance_config: '{}' }));
  const baseline = h.current();
  for (const key of ['factories', 'scenes', 'widgets', 'bindings', 'settings', 'releases']) assert.deepEqual(baseline[key], reviewedState[key], `${key} is unchanged`);
  await assert.rejects(h.run(), /registry or cleanup projection changed since review/);
  assertRolledBack(h, baseline); assert.equal(h.counts.sceneUpdates, 0); assert.equal(h.counts.deletions, 0); assert.deepEqual(h.writes, []);
});

test('deleted-device point IDs changing after review are rejected without relying on draft-state drift', async t => {
  const h = harness(t); await h.review(); const reviewedState = h.current();
  h.mutate(database => database.points.push({ id: 'fixture-new-orphan-point', device_id: DELETED }));
  const baseline = h.current();
  for (const key of ['factories', 'scenes', 'widgets', 'bindings', 'settings', 'releases']) assert.deepEqual(baseline[key], reviewedState[key], `${key} is unchanged`);
  await assert.rejects(h.run(), /registry or cleanup projection changed since review/);
  assertRolledBack(h, baseline); assert.equal(h.counts.sceneUpdates, 0); assert.equal(h.counts.mirrorUpdates, 0); assert.deepEqual(h.writes, []);
});

test('scene revision CAS failure rolls back and closes the connection', async t => {
  const h = harness(t); await h.review(); h.controls.failCas = true;
  await assert.rejects(h.run(), /草稿已更新/); assertRolledBack(h); assert.equal(h.counts.sceneUpdates, 1);
});

for (const filename of ['before.json', 'after.json', 'prepared.json']) test(`${filename} write failure prevents commit and rolls back`, async t => {
  const h = harness(t); await h.review(); h.controls.failWrite = filename;
  await assert.rejects(h.run(), /Injected write failure/); assertRolledBack(h);
  if (filename === 'before.json') assert.equal(h.counts.sceneUpdates, 0);
  else { assert.equal(h.counts.sceneUpdates, 1); assert.equal(h.counts.deletions, 1); }
});

test('mid-mirror SQL failure rolls back draft, removed owner, bindings, and prior mirror updates', async t => {
  const h = harness(t); await h.review(); h.controls.failMirrorUpdate = 2;
  await assert.rejects(h.run(), /Injected mirror SQL failure/); assertRolledBack(h);
  assert.equal(h.counts.sceneUpdates, 1); assert.equal(h.counts.deletions, 1); assert.equal(h.counts.mirrorUpdates, 2);
});

test('SQL readback failure after writes rolls back every mutation', async t => {
  const h = harness(t); await h.review(); h.controls.failSql = 'SELECT draft_json,draft_revision FROM scenes';
  await assert.rejects(h.run(), /Injected SQL failure/); assertRolledBack(h); assert.equal(h.counts.sceneUpdates, 1);
});

for (const label of ['Revision', 'Draft']) test(`bad canonical ${label.toLowerCase()} readback prevents commit`, async t => {
  const h = harness(t); await h.review(); h.controls[`bad${label}Readback`] = true;
  await assert.rejects(h.run(), /Device cleanup draft/); assertRolledBack(h);
});

for (const label of ['mirror', 'factory', 'publication']) test(`independent ${label} readback corruption rolls back`, async t => {
  const h = harness(t); await h.review(); h.controls.badReadback = label;
  await assert.rejects(h.run()); assertRolledBack(h); assert.equal(h.counts.cleaned, 1);
});

function assertSuccessful(h, report) {
  assert.equal(report.success, true); assert.equal(report.committed, true);
  assert.equal(report.historicalAndCurrentReleasesUnchanged, true); assert.equal(report.allSurvivingDataLayoutAndStylePreserved, true);
  assert.equal(h.counts.commit, 1); assert.equal(h.counts.rollback, 0); assert.equal(h.counts.end, 1);
  const stored = h.current(), oldScene = h.initial.scenes[0], saved = parse(stored.scenes[0].draft_json);
  const expected = transform(h.original, { deviceIds: [DELETED], pointIds: ['fixture-point-deleted'], existingDeviceIds: [ALIVE] }).document;
  expected.metadata = { ...expected.metadata, revision: 8, updatedAt: report.plan.deletedAt };
  assert.deepEqual(saved, expected); assert.equal(stored.scenes[0].draft_revision, 8);
  assert.deepEqual(stored.scenes[1], h.initial.scenes[1], 'Unchanged scenes remain byte-for-byte intact');
  const restored = copy(stored.scenes[0]); restored.draft_json = oldScene.draft_json; restored.draft_revision = oldScene.draft_revision; restored.updated_at = oldScene.updated_at;
  assert.deepEqual(restored, oldScene, 'Publication pointer and unrelated scene columns stay unchanged');
  assert.deepEqual(stored.factories, h.initial.factories); assert.deepEqual(stored.releases, h.initial.releases);
  assert.deepEqual(stored.devices, h.initial.devices); assert.deepEqual(stored.points, h.initial.points);
  assert.deepEqual(stored.bindings, [h.initial.bindings[1]], 'Only the deleted private owner loses its binding');
  assert.deepEqual(saved.tooltipTemplates, h.original.tooltipTemplates);
  for (const id of ['f-untouched', 'g-shared-fixed']) {
    assert.deepEqual(saved.widgets.find(row => row.id === id), h.original.widgets.find(row => row.id === id));
    assert.deepEqual(stored.widgets.find(row => row.id === id), h.initial.widgets.find(row => row.id === id));
  }
  assert.equal(stored.widgets.some(row => row.id === 'a-private'), false);
  for (const row of stored.widgets) {
    const old = h.initial.widgets.find(old => old.id === row.id), config = parse(row.config_json), binding = parse(row.binding_json);
    assert.deepEqual(config.legacyOnly, parse(old.config_json).legacyOnly); assert.deepEqual(config.unrecognized, ['raw', 17]);
    assert.deepEqual(binding.legacyBinding, { original: true });
    assert.deepEqual(config.style, parse(old.config_json).style, 'Styles and raw legacy extensions remain intact');
    const restored = copy(row); restored.config_json = old.config_json; restored.binding_json = old.binding_json; restored.visible = old.visible;
    assert.deepEqual(restored, old, 'No layout or unrelated mirror columns change');
  }
  assert.equal(stored.widgets.find(row => row.id === 'e-exhausted').visible, 0, 'Empty selection never falls back to all devices');
  const oldActions = h.original.widgets.find(row => row.id === 'c-list').content.deviceActions;
  const expectedActions = { [ALIVE]: oldActions[ALIVE], 'unrelated-action-key': oldActions['unrelated-action-key'] };
  assert.deepEqual(saved.widgets.find(row => row.id === 'c-list').content.deviceActions, expectedActions);
  const listConfig = parse(stored.widgets.find(row => row.id === 'c-list').config_json);
  assert.deepEqual(listConfig.deviceActions, expectedActions, 'Legacy HUD mirror drops only the deleted device action key');
  assert.deepEqual(listConfig.arbitraryMap, { [DELETED]: 'raw unrelated data' }, 'Do not infer device ownership from arbitrary object keys');
  const ledger = JSON.parse(stored.settings.find(row => row.key === service.KEY).value);
  assert.equal(ledger.events.length, 1); assert.equal(ledger.deletionAtByDeviceId[DELETED], report.plan.deletedAt);
}

for (const jsonObjects of [false, true]) test(`${jsonObjects ? 'MySQL JSON objects' : 'JSON TEXT strings'} preserve survivors, raw mirrors, layout, style, and publication on success`, async t => {
  const h = harness(t, { jsonObjects }); await h.review(); const report = await h.run(); assertSuccessful(h, report);
  assert.deepEqual(h.writes, ['before.json', 'after.json', 'prepared.json', 'result.json']);
  assert.equal(typeof h.current().scenes[0].draft_json, jsonObjects ? 'object' : 'string');
  for (const row of h.current().widgets) {
    assert.equal(typeof row.config_json, jsonObjects ? 'object' : 'string'); assert.equal(typeof row.binding_json, jsonObjects ? 'object' : 'string');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.auditDirectory(), 'result.json'), 'utf8')), report);
});

test('native MySQL JSON object corrupt mirror readback is rejected and rolled back', async t => {
  const h = harness(t, { jsonObjects: true }); await h.review(); h.controls.badReadback = 'mirror';
  await assert.rejects(h.run(), /Unexpected mirror mutation/); assertRolledBack(h);
  assert.equal(typeof h.current().scenes[0].draft_json, 'object');
});

test('failure writing final result after commit reports committed:true and never rolls back or suggests retry', async t => {
  const h = harness(t); await h.review(); h.controls.failWrite = 'result.json';
  const report = await h.run(); assertSuccessful(h, report);
  assert.equal(report.auditWriteError, 'ENOSPC'); assert.match(report.warning, /Already committed\. Do not retry/);
  for (const filename of ['before.json', 'after.json', 'prepared.json']) assert.ok(fs.existsSync(path.join(h.auditDirectory(), filename)));
  assert.equal(fs.existsSync(path.join(h.auditDirectory(), 'result.json')), false);
});

test('connection still closes when rollback itself fails', async t => {
  const h = harness(t); await h.review(); h.controls.failWrite = 'before.json'; h.controls.failRollback = true;
  await assert.rejects(h.run(), /Injected rollback failure/); assert.equal(h.counts.commit, 0); assert.equal(h.counts.end, 1);
  assert.deepEqual(h.current(), h.initial);
});

for (const [label, edit] of [
  ['frame', widget => { widget.frame.height++; }],
  ['text', widget => { widget.content.text = 'changed'; }],
  ['ordinary row', widget => { widget.content.rows.pop(); }],
  ['style', widget => { widget.style.fontSize++; }],
]) test(`independent mirror verifier rejects surviving ${label} mutation`, t => {
  const h = harness(t), before = h.original.widgets[5], after = copy(before); edit(after);
  assert.throws(() => tool.independentMirror(h.initial.widgets[5], before, after, { deletedDeviceIds: [DELETED], deletedPointIds: [] }));
});

test('independent mirror verifier rejects removal of an unrelated selected device', t => {
  const h = harness(t), before = h.original.widgets[2], after = copy(before); after.content.deviceIds = [];
  delete after.content.deviceActions[DELETED];
  assert.throws(() => tool.independentMirror(h.initial.widgets[2], before, after, { deletedDeviceIds: [DELETED], deletedPointIds: [] }), /Only deleted IDs can be removed/);
});

test('independent mirror verifier allows only exact deleted deviceActions keys to be removed', t => {
  const h = harness(t), before = h.original.widgets[2], after = copy(before);
  delete after.content.deviceActions[DELETED]; after.content.deviceIds = [ALIVE];
  const mirrored = tool.independentMirror(h.initial.widgets[2], before, after, { deletedDeviceIds: [DELETED], deletedPointIds: [] });
  const expected = copy(before.content.deviceActions); delete expected[DELETED];
  assert.deepEqual(parse(mirrored.config_json).deviceActions, expected);
  delete after.content.deviceActions[ALIVE];
  assert.throws(() => tool.independentMirror(h.initial.widgets[2], before, after, { deletedDeviceIds: [DELETED], deletedPointIds: [] }));
});

test('independent mirror verifier rejects edits to any surviving deviceActions action', t => {
  const h = harness(t), before = h.original.widgets[2], after = copy(before);
  delete after.content.deviceActions[DELETED]; after.content.deviceIds = [ALIVE]; after.content.deviceActions[ALIVE][0].viewId = 'other-view';
  assert.throws(() => tool.independentMirror(h.initial.widgets[2], before, after, { deletedDeviceIds: [DELETED], deletedPointIds: [] }));
});
