'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../apply-dashboard-appearance-patch.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const jsonRecord = value => typeof value === 'string' ? JSON.parse(value) : copy(value);
const OUTPUT = path.resolve(__dirname, '../../output');

function documentFixture() {
  const widget = (id, views, extra = {}) => ({
    id, type: 'text', title: '保留原字段', visible: true, runtimeTarget: 'web',
    frame: { x: 25, y: 50, width: 220, height: 45, rotation: 0 }, zIndex: 5,
    style: { color: '#66ddf7', borderColor: '#28536c', background: '#071c2d', padding: 8, fontSize: 19 },
    content: { text: '{value} ℃', align: 'right', lineColor: '#55c7ff', lineWidth: 2 },
    data: { mode: 'plc', pointId: '638', deviceId: 'deleted-device', unit: '℃', datasets: [{ alias: 'a', color: '#ff0000' }] },
    visibility: { viewIds: views, viewModes: [], rules: [] },
    conditions: [{ operator: '==', value: 1, color: '#ff0000' }],
    events: [{ action: 'switch_view', viewId: 'device_detail' }],
    metadata: { authoredBy: 'Ethan' }, ...extra,
  });
  return {
    schemaVersion: 3, projectId: 'fixture-project', sceneId: 'fixture-scene',
    metadata: { revision: 7, updatedAt: '2026-11-01T10:00:00.000Z', source: 'import', retained: { example: true } },
    scene: { id: 'fixture-scene', views: [
      { id: 'factory_overview', mode: 'factory', parentViewId: '', componentState: { show: [], hide: [] } },
      { id: 'workshop_overview', mode: 'workshop', parentViewId: 'factory_overview', componentState: { show: [], hide: [] } },
      { id: 'device_detail', mode: 'device', parentViewId: 'workshop_overview', componentState: { show: [], hide: [] } },
    ] },
    tooltipTemplates: { templates: [{ id: 'original-tooltip', widgets: [{
      id: 'tooltip-status', type: 'text', content: { text: '数据正常' },
      data: { mode: 'static', path: '', value: '数据正常', readOnly: true },
    }] }] },
    widgets: [
      widget('approved-source', ['factory_overview'], { type: 'hud_kpi_panel' }),
      widget('shared-source', []),
      widget('target-a', ['workshop_overview', 'device_detail']),
      widget('target-b', ['device_detail']),
      widget('untouched-target', ['device_detail']),
    ],
  };
}

// This fake implements only this maintenance tool's SQL. An unexpected query
// fails instead of falling through to an application database or a real driver.
function harness(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'appearance-transaction-fixture-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(OUTPUT + path.sep), 'Cleanup must stay inside the test output directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const before = documentFixture(), after = copy(before);
  after.widgets[2].style.color = '#eef7ff';
  after.widgets[2].style.borderRadius = 18;
  after.widgets[3].style.background = 'rgba(10,18,34,.12)';
  after.widgets[3].content.lineColor = '#68d5ff';
  after.widgets[3].content.lineWidth = 1.4;
  if (options.editAfter) options.editAfter(after);
  const values = {
    config: path.join(directory, 'fake-config.json'), before: path.join(directory, 'before-input.json'),
    after: path.join(directory, 'after-input.json'), factory: 'fixture-factory', scene: 'fixture-scene', apply: true,
  };
  fs.writeFileSync(values.config, JSON.stringify({ type: 'mysql', host: 'fixture-do-not-connect', port: 1, user: 'fixture', password: 'fixture', database: 'fixture-only' }));
  fs.writeFileSync(values.before, JSON.stringify({ factory: { id: values.factory }, scenes: [{ id: values.scene, draft_revision: 7, document: before }] }));
  fs.writeFileSync(values.after, JSON.stringify(after));
  const database = {
    scene: { id: values.scene, project_id: before.projectId, draft_json: JSON.stringify(before), draft_revision: 7,
      updated_at: '2026-11-01 10:00:00', published_release_id: 'release-keep', other_column: 'keep-scene' },
    legacy: before.widgets.map(widget => ({ id: widget.id, scene_id: values.scene,
      config_json: JSON.stringify({ ...widget.content, style: copy(widget.style), legacyOnly: { keep: widget.id } }),
      binding_json: JSON.stringify(widget.data), widget_type: widget.type, unrelated: `keep-${widget.id}` })),
    releases: [{ id: 'release-keep', document_json: 'unchanged published snapshot' }],
    devices: [{ id: 'untouched-device', name: '现场设备', enabled: true }],
  };
  if (options.editDatabase) options.editDatabase(database);
  // mysql2 decodes native MySQL JSON columns to objects by default. Model
  // both the initial locked rows and every subsequent SQL readback that way.
  if (options.jsonObjects) {
    database.scene.draft_json = jsonRecord(database.scene.draft_json);
    for (const row of database.legacy) {
      row.config_json = jsonRecord(row.config_json);
      row.binding_json = jsonRecord(row.binding_json);
    }
  }
  const initial = copy(database);
  let persisted = copy(database), working = null, auditDirectory = '';
  const counts = { connections: 0, begin: 0, commit: 0, rollback: 0, end: 0, sceneUpdates: 0, widgetUpdates: 0 };
  const writes = [], queries = [];
  const io = {
    ...fs,
    mkdtempSync() { auditDirectory = fs.mkdtempSync(path.join(directory, 'applied-')); return auditDirectory; },
    writeFileSync(file, data, settings) {
      const name = path.basename(file); writes.push(name);
      if (name === options.failWrite) { const error = new Error(`Injected write failure: ${name}`); error.code = 'ENOSPC'; throw error; }
      return fs.writeFileSync(file, data, settings);
    },
  };
  const db = {
    async beginTransaction() { counts.begin++; assert.equal(working, null); working = copy(persisted); },
    async execute(sql, params) {
      assert.ok(working, 'SQL must run inside the fixture transaction');
      queries.push({ sql, params: copy(params) });
      if (sql.startsWith('SELECT s.* FROM scenes')) {
        assert.deepEqual(params, [values.scene, values.factory]);
        return [[copy(working.scene)]];
      }
      if (sql === 'SELECT id,scene_id,config_json,binding_json FROM widgets WHERE scene_id=? FOR UPDATE') {
        assert.deepEqual(params, [values.scene]);
        return [copy(working.legacy.map(({ id, scene_id, config_json, binding_json }) => ({ id, scene_id, config_json, binding_json })))];
      }
      if (sql.startsWith('UPDATE scenes SET draft_json=')) {
        counts.sceneUpdates++;
        const [draft, revision, sceneId, expected] = params;
        if (sceneId !== working.scene.id || expected !== working.scene.draft_revision) return [{ affectedRows: 0 }];
        working.scene.draft_json = options.jsonObjects ? jsonRecord(draft) : draft;
        working.scene.draft_revision = revision; working.scene.updated_at = 'fixture current timestamp';
        return [{ affectedRows: 1 }];
      }
      if (sql === 'UPDATE widgets SET config_json=? WHERE id=? AND scene_id=?') {
        counts.widgetUpdates++;
        if (counts.widgetUpdates === options.failWidgetUpdate) throw new Error('Injected widget update failure');
        const [config, id, sceneId] = params, row = working.legacy.find(row => row.id === id && row.scene_id === sceneId);
        if (!row) return [{ affectedRows: 0 }];
        row.config_json = options.jsonObjects ? jsonRecord(config) : config; return [{ affectedRows: 1 }];
      }
      if (sql === 'SELECT draft_json,draft_revision,published_release_id FROM scenes WHERE id=?') {
        const { draft_json, draft_revision, published_release_id } = working.scene;
        return [[{ draft_json, draft_revision: options.badRevisionReadback ? draft_revision + 1 : draft_revision, published_release_id }]];
      }
      if (sql === 'SELECT id,binding_json,config_json FROM widgets WHERE scene_id=?') {
        const rows = copy(working.legacy.map(({ id, binding_json, config_json }) => ({ id, binding_json, config_json })));
        if (options.badConfigReadback) {
          const row = rows.find(row => row.id === options.badConfigReadback), config = jsonRecord(row.config_json);
          config.legacyOnly.keep = 'corrupted readback'; row.config_json = options.jsonObjects ? config : JSON.stringify(config);
        }
        if (options.badBindingReadback) rows[0].binding_json = '{}';
        return [rows];
      }
      assert.fail(`Unexpected SQL in isolated transaction fixture: ${sql}`);
    },
    async commit() {
      assert.ok(working); counts.commit++;
      for (const name of ['before.json', 'after.json', 'prepared.json']) assert.ok(fs.existsSync(path.join(auditDirectory, name)), `Commit requires ${name} on disk`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(auditDirectory, 'prepared.json'), 'utf8')).committed, false);
      persisted = copy(working); working = null;
    },
    async rollback() { counts.rollback++; assert.ok(working); working = null; },
    async end() { counts.end++; },
  };
  const mysql = { async createConnection(config) {
    counts.connections++;
    assert.equal(config.host, 'fixture-do-not-connect');
    return db;
  } };
  return { before, after, initial, counts, writes, queries,
    current: () => copy(persisted), auditDirectory: () => auditDirectory,
    run: () => main({ values, mysql, fs: io }) };
}

function assertRolledBack(h) {
  assert.deepEqual(h.current(), h.initial, 'A rejected patch must preserve the complete fixture database');
  assert.equal(h.counts.commit, 0); assert.equal(h.counts.rollback, 1); assert.equal(h.counts.end, 1);
}

for (const id of ['approved-source', 'shared-source']) test(`rejects ${id} styling before creating a connection`, async t => {
  const h = harness(t, { editAfter(document) { document.widgets.find(widget => widget.id === id).style.color = '#ffff00'; } });
  await assert.rejects(h.run(), /Reference\/shared\/non-child component is protected/);
  assert.equal(h.counts.connections, 0); assert.deepEqual(h.current(), h.initial); assert.deepEqual(h.writes, []);
});

for (const [label, edit] of [
  ['revision drift', database => { database.scene.draft_revision++; }],
  ['raw document drift', database => { const doc = JSON.parse(database.scene.draft_json); doc.widgets[2].content.text = 'other engineer edit'; database.scene.draft_json = JSON.stringify(doc); }],
]) test(`rejects ${label} without overwriting an edit`, async t => {
  const h = harness(t, { editDatabase: edit });
  await assert.rejects(h.run(), label === 'revision drift' ? /Draft revision changed/ : /Draft contents changed/);
  assertRolledBack(h); assert.equal(h.counts.sceneUpdates, 0); assert.equal(h.counts.widgetUpdates, 0);
});

test('legacy style mismatch rolls back the draft and previously updated mirror', async t => {
  const h = harness(t, { editDatabase(database) {
    const row = database.legacy.find(row => row.id === 'target-b'), config = JSON.parse(row.config_json);
    config.style.color = '#unrelated-edit'; row.config_json = JSON.stringify(config);
  } });
  await assert.rejects(h.run(), /Legacy style differs: target-b/);
  assertRolledBack(h); assert.equal(h.counts.sceneUpdates, 1); assert.equal(h.counts.widgetUpdates, 1);
});

test('a mid-mirror SQL failure rolls back every draft and mirror update', async t => {
  const h = harness(t, { failWidgetUpdate: 2 });
  await assert.rejects(h.run(), /Injected widget update failure/);
  assertRolledBack(h); assert.equal(h.counts.widgetUpdates, 2);
});

for (const id of ['target-a', 'untouched-target']) test(`bad stored config on ${id} prevents commit`, async t => {
  const h = harness(t, { badConfigReadback: id });
  await assert.rejects(h.run(), new RegExp(`Stored legacy config differs: ${id}`));
  assertRolledBack(h); assert.equal(h.counts.widgetUpdates, 2);
});

test('bad revision readback prevents commit', async t => {
  const h = harness(t, { badRevisionReadback: true });
  await assert.rejects(h.run()); assertRolledBack(h);
});

test('bad binding readback prevents commit', async t => {
  const h = harness(t, { badBindingReadback: true });
  await assert.rejects(h.run()); assertRolledBack(h);
});

for (const filename of ['before.json', 'after.json', 'prepared.json']) test(`${filename} write failure prevents commit`, async t => {
  const h = harness(t, { failWrite: filename });
  await assert.rejects(h.run(), /Injected write failure/); assertRolledBack(h);
  if (filename === 'before.json') assert.equal(h.counts.sceneUpdates, 0);
});

function assertSuccessfulPatch(h, report) {
  assert.equal(report.success, true); assert.equal(report.committed, true);
  assert.equal(report.changedWidgets, 2); assert.equal(report.beforeRevision, 7); assert.equal(report.revision, 8);
  assert.equal(h.counts.commit, 1); assert.equal(h.counts.rollback, 0); assert.equal(h.counts.end, 1);
  const stored = h.current(), saved = jsonRecord(stored.scene.draft_json);
  assert.equal(stored.scene.draft_revision, 8); assert.equal(saved.metadata.revision, 8);
  assert.ok(Number.isFinite(Date.parse(saved.metadata.updatedAt)));
  const metadataRestored = copy(saved); metadataRestored.metadata.revision = h.before.metadata.revision; metadataRestored.metadata.updatedAt = h.before.metadata.updatedAt;
  assert.deepEqual(metadataRestored, h.after, 'Only revision/updatedAt may change beyond the prepared appearance patch');
  assert.deepEqual(saved.tooltipTemplates, h.before.tooltipTemplates, 'Do not normalize the original tooltip data or text');
  for (const id of ['approved-source', 'shared-source', 'untouched-target']) {
    assert.deepEqual(saved.widgets.find(widget => widget.id === id), h.before.widgets.find(widget => widget.id === id));
    assert.deepEqual(stored.legacy.find(row => row.id === id), h.initial.legacy.find(row => row.id === id));
  }
  for (const row of stored.legacy) {
    const old = h.initial.legacy.find(old => old.id === row.id);
    assert.deepEqual(row.binding_json, old.binding_json);
    const restored = copy(row); restored.config_json = old.config_json; assert.deepEqual(restored, old);
  }
  assert.equal(stored.scene.published_release_id, h.initial.scene.published_release_id);
  assert.equal(stored.scene.other_column, h.initial.scene.other_column);
  assert.deepEqual(stored.releases, h.initial.releases); assert.deepEqual(stored.devices, h.initial.devices);
  const a = jsonRecord(stored.legacy.find(row => row.id === 'target-a').config_json);
  const b = jsonRecord(stored.legacy.find(row => row.id === 'target-b').config_json);
  assert.deepEqual(a.style, h.after.widgets[2].style); assert.deepEqual(b.style, h.after.widgets[3].style);
  assert.equal(b.lineColor, '#68d5ff'); assert.equal(b.lineWidth, 1.4); assert.equal(b.text, '{value} ℃');
}

test('successful patch preserves source, original tooltip, binding, untouched rows and publication', async t => {
  const h = harness(t), report = await h.run(); assertSuccessfulPatch(h, report);
  assert.deepEqual(h.writes, ['before.json', 'after.json', 'prepared.json', 'result.json']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(h.auditDirectory(), 'result.json'), 'utf8'));
  assert.deepEqual(onDisk, report);
});

test('native MySQL JSON object rows apply successfully without normalizing their values', async t => {
  const h = harness(t, { jsonObjects: true });
  assert.equal(typeof h.initial.scene.draft_json, 'object');
  for (const row of h.initial.legacy) {
    assert.equal(typeof row.config_json, 'object'); assert.equal(typeof row.binding_json, 'object');
  }
  const report = await h.run(); assertSuccessfulPatch(h, report);
  assert.equal(typeof h.current().scene.draft_json, 'object');
  for (const row of h.current().legacy) assert.equal(typeof row.config_json, 'object');
});

for (const id of ['target-b', 'untouched-target']) test(`native MySQL JSON object bad config on ${id} rolls back`, async t => {
  const h = harness(t, { jsonObjects: true, badConfigReadback: id });
  await assert.rejects(h.run(), new RegExp(`Stored legacy config differs: ${id}`));
  assertRolledBack(h); assert.equal(h.counts.sceneUpdates, 1); assert.equal(h.counts.widgetUpdates, 2);
  assert.equal(typeof h.current().scene.draft_json, 'object');
});

test('result log failure after commit reports committed:true and does not roll back or suggest retry', async t => {
  const h = harness(t, { failWrite: 'result.json' }), report = await h.run();
  assertSuccessfulPatch(h, report);
  assert.equal(report.auditWriteError, 'ENOSPC'); assert.match(report.warning, /already committed; do not retry/);
  for (const name of ['before.json', 'after.json', 'prepared.json']) assert.ok(fs.existsSync(path.join(h.auditDirectory(), name)));
  assert.equal(fs.existsSync(path.join(h.auditDirectory(), 'result.json')), false);
});
