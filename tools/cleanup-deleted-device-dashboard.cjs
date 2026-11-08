'use strict';
// Explicit maintenance of already-deleted devices only. No application DB
// initialization, physical device/point deletion, normalization or publication.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function assertReferencePrune(before, after, devices, points, label = '') {
  if (Array.isArray(before)) {
    assert.ok(Array.isArray(after), 'Cannot change array shape: ' + label);
    if (['deviceIds', 'device_ids', 'rotationDeviceIds', 'pointIds', 'point_ids'].includes(label.split('.').at(-1))) {
      const removed = label.split('.').at(-1).startsWith('point') ? points : devices;
      assert.deepEqual(after, before.filter(id => !removed.has(String(id))), 'Only deleted IDs can be removed: ' + label);
    } else {
      assert.equal(after.length, before.length, 'No ordinary data row can be removed: ' + label);
      before.forEach((value, index) => assertReferencePrune(value, after[index], devices, points, label + '.' + index));
    }
  } else if (before && typeof before === 'object') {
    assert.ok(after && typeof after === 'object' && !Array.isArray(after), 'Cannot change object shape: ' + label);
    const expectedKeys = Object.keys(before).filter(key => label !== 'content.deviceActions' || !devices.has(key));
    assert.deepEqual(Object.keys(after).sort(), expectedKeys.sort(), 'Cannot remove unrelated data keys: ' + label);
    for (const key of expectedKeys) {
      if (label === 'content.deviceActions') assert.deepEqual(after[key], before[key], 'Surviving device actions must remain exact');
      else assertReferencePrune(before[key], after[key], devices, points, label + '.' + key);
    }
  } else assert.deepEqual(after, before, 'Cannot alter any scalar data or text: ' + label);
}
function independentMirror(row, before, after, plan) {
  const devices = new Set(plan.deletedDeviceIds), points = new Set(plan.deletedPointIds || []);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!['content', 'data', 'visibility', 'events', 'style', 'visible'].includes(key))
      assert.deepEqual(after[key], before[key], 'Cannot alter surviving widget ' + key);
  }
  for (const key of ['content', 'data']) assertReferencePrune(before[key], after[key], devices, points, key);
  const styleBefore = copy(before.style || {}), styleAfter = copy(after.style || {});
  delete styleBefore.viewOverrides; delete styleAfter.viewOverrides;
  assert.deepEqual(styleAfter, styleBefore, 'Surviving visual style must not change');
  // Independently calculate mirror deltas; do not reuse the writer's patch
  // implementation, which would mask a mirrored-column regression.
  const result = copy(row), config = copy(parse(row.config_json) || {}), binding = copy(parse(row.binding_json) || {});
  const delta = (target, old, current) => {
    for (const key of new Set([...Object.keys(old || {}), ...Object.keys(current || {})])) {
      if (hash(old?.[key]) === hash(current?.[key])) continue;
      if (Object.hasOwn(current || {}, key)) target[key] = copy(current[key]); else delete target[key];
    }
  };
  delta(config, before.content, after.content);
  delta(binding, before.data, after.data);
  for (const key of ['visibility', 'events']) if (hash(before[key]) !== hash(after[key])) config[key] = copy(after[key] || (key === 'events' ? [] : {}));
  if (hash(before.style) !== hash(after.style)) { config.style ||= {}; delta(config.style, before.style, after.style); }
  result.config_json = typeof row.config_json === 'string' ? JSON.stringify(config) : config;
  result.binding_json = typeof row.binding_json === 'string' ? JSON.stringify(binding) : binding;
  if (hash(before.visible) !== hash(after.visible)) {
    assert.ok(after.visible === false || after.visible === 0, 'Deletion cannot make a hidden survivor visible');
    result.visible = 0;
  }
  return result;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
function makeClient(db, readOnly) {
  const select = sql => assert.ok(/^\s*SELECT\b/i.test(sql) && !/;|\bINTO\b/i.test(sql), 'Maintenance reads must be a single SELECT');
  return {
    dialect: 'mysql',
    all: async (sql, parameters = []) => { select(sql); return (await db.execute(sql, parameters))[0]; },
    get: async (sql, parameters = []) => { select(sql); return (await db.execute(sql, parameters))[0][0]; },
    run: async (sql, parameters = []) => {
      assert.equal(readOnly, false, 'Dry runs cannot write');
      const [result] = await db.execute(sql, parameters);
      return { ...result, changes: result.affectedRows || 0 };
    }
  };
}
async function capture(tx, factoryId) {
  const factory = await tx.get('SELECT * FROM factories WHERE id=?', [factoryId]); assert.ok(factory, 'Factory does not exist');
  const scenes = await tx.all('SELECT s.* FROM scenes s JOIN projects p ON p.id=s.project_id WHERE p.factory_id=? ORDER BY s.id', [factoryId]);
  const widgets = await tx.all('SELECT w.* FROM widgets w JOIN scenes s ON s.id=w.scene_id JOIN projects p ON p.id=s.project_id WHERE p.factory_id=? ORDER BY w.id', [factoryId]);
  const bindings = await tx.all('SELECT b.* FROM bindings b JOIN widgets w ON w.id=b.widget_id JOIN scenes s ON s.id=w.scene_id JOIN projects p ON p.id=s.project_id WHERE p.factory_id=? ORDER BY b.id', [factoryId]);
  const releases = await tx.all('SELECT r.* FROM releases r JOIN projects p ON p.id=r.project_id WHERE p.factory_id=? ORDER BY r.id', [factoryId]);
  const settings = await tx.all('SELECT * FROM factory_settings WHERE factory_id=? ORDER BY `key`', [factoryId]);
  // Historical releases remain immutable. Preserve their proof, not another
  // 100 MB copy of every historical snapshot in this small maintenance backup.
  return { factory, scenes, widgets, bindings, settings, releaseDigest: hash(releases), releaseCount: releases.length };
}
function verify(before, after, plan, service, transform) {
  assert.deepEqual(after.factory, before.factory);
  assert.equal(after.releaseDigest, before.releaseDigest, 'Historical/current releases must not change');
  assert.equal(after.releaseCount, before.releaseCount);
  const scenePlans = new Map(plan.scenes.map(scene => [scene.sceneId, scene]));
  const removed = new Set(plan.scenes.flatMap(scene => scene.removedWidgetIds));
  const expectedWidgets = new Map(before.widgets.filter(row => !removed.has(row.id)).map(row => [row.id, copy(row)]));
  for (const oldScene of before.scenes) {
    const actual = after.scenes.find(scene => scene.id === oldScene.id); assert.ok(actual);
    const entry = scenePlans.get(oldScene.id);
    if (!entry) { assert.deepEqual(actual, oldScene); continue; }
    const original = parse(oldScene.draft_json);
    const result = transform(original, { deviceIds: plan.deletedDeviceIds, pointIds: plan.deletedPointIds, existingDeviceIds: plan.remainingDeviceIds });
    const stored = parse(actual.draft_json), expected = copy(result.document);
    assert.deepEqual(entry.removedWidgetIds, result.removedWidgetIds);
    assert.deepEqual(entry.updatedWidgetIds, result.updatedWidgetIds);
    assert.equal(Number(actual.draft_revision), Number(oldScene.draft_revision) + 1);
    expected.metadata = { ...(expected.metadata || {}), revision: Number(actual.draft_revision), updatedAt: plan.deletedAt };
    assert.deepEqual(stored, expected, 'Only the proven deletion projection and revision/time may change');
    const restoredScene = copy(actual); restoredScene.draft_json = copy(oldScene.draft_json); restoredScene.draft_revision = oldScene.draft_revision; restoredScene.updated_at = oldScene.updated_at;
    assert.deepEqual(restoredScene, oldScene, 'No scene layout, pointer or other scene field may change');
    const oldWidgets = new Map(original.widgets.map(widget => [widget.id, widget]));
    const newWidgets = new Map(stored.widgets.map(widget => [widget.id, widget]));
    for (const id of result.updatedWidgetIds) {
      const row = expectedWidgets.get(id); if (!row) continue;
      expectedWidgets.set(id, independentMirror(row, oldWidgets.get(id), newWidgets.get(id), plan));
    }
  }
  assert.deepEqual(after.scenes.map(row => row.id), before.scenes.map(row => row.id));
  assert.deepEqual(after.widgets.map(row => row.id), [...expectedWidgets.keys()]);
  for (const row of after.widgets) assert.deepEqual(row, expectedWidgets.get(row.id), 'Unexpected mirror mutation: ' + row.id);
  assert.deepEqual(after.bindings, before.bindings.filter(row => !removed.has(row.widget_id)));
  assert.deepEqual(after.settings.filter(row => row.key !== service.KEY), before.settings.filter(row => row.key !== service.KEY));
}
async function main(dependencies = {}) {
  const io = dependencies.fs || fs;
  const values = dependencies.values || parseArgs({ options: {
    config: { type: 'string' }, factory: { type: 'string' }, device: { type: 'string', multiple: true },
    before: { type: 'string' }, apply: { type: 'boolean' }
  } }).values;
  for (const key of ['config', 'factory']) assert.ok(values[key], '--' + key + ' is required');
  const devices = [...new Set(values.device || [])]; assert.ok(devices.length, '--device is required');
  if (values.apply) assert.ok(values.before, '--before from the reviewed dry run is required');
  const previous = values.apply ? parse(io.readFileSync(values.before, 'utf8')) : null;
  if (previous) { assert.equal(previous.factoryId, values.factory); assert.deepEqual(previous.deletedDeviceIds, devices); }
  const config = parse(io.readFileSync(values.config, 'utf8')); assert.equal(config.type, 'mysql');
  const service = dependencies.service || require(path.join(ROOT, 'backend/services/dashboardDeviceDeletion.js'));
  const transform = dependencies.transform || require(path.join(ROOT, 'shared/dashboardDeviceDeletion.mjs')).cleanupDeletedDeviceContent;
  const mysql = dependencies.mysql || require(path.join(ROOT, 'backend/node_modules/mysql2/promise'));
  const directory = io.mkdtempSync(path.join(ROOT, 'output', values.apply ? 'device-owned-cleanup-apply-' : 'device-owned-cleanup-preview-'));
  const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, dateStrings: true });
  let committed = false;
  try {
    if (!values.apply) { await db.query('SET TRANSACTION READ ONLY'); await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT'); }
    else { await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await db.beginTransaction(); }
    const tx = makeClient(db, !values.apply);
    if (values.apply) await tx.run('UPDATE factories SET id=id WHERE id=?', [values.factory]);
    const existing = await tx.all(`SELECT id FROM devices WHERE id IN (${devices.map(() => '?').join(',')})${values.apply ? ' FOR UPDATE' : ''}`, devices);
    assert.equal(existing.length, 0, 'A target device still exists; this maintenance tool will not delete or clean a live device');
    if (values.apply) {
      for (const row of previous.state.scenes) await tx.run('UPDATE scenes SET draft_revision=draft_revision WHERE id=?', [row.id]);
    }
    const state = await capture(tx, values.factory);
    if (previous) assert.deepEqual(state, previous.state, 'Configuration changed since the reviewed dry run; inspect again, do not overwrite edits');
    const predicted = await service.predictDashboardDeviceDeletion(tx, { factoryId: values.factory, deviceIds: devices });
    if (previous) assert.deepEqual(predicted, previous.predicted, 'Device/point registry or cleanup projection changed since review; inspect again');
    assert.ok(predicted.scenes.length, 'No proven private content or deleted-device references remain to clean');
    io.writeFileSync(path.join(directory, 'before.json'), JSON.stringify({ factoryId: values.factory, deletedDeviceIds: devices, state, predicted }, null, 2), { flag: 'wx', mode: 0o600 });
    if (!values.apply) {
      const report = { dryRun: true, factoryId: values.factory, deletedDeviceIds: devices, removedWidgets: predicted.removedWidgetCount, removedViews: predicted.removedViewCount, removedBindings: predicted.removedBindingCount,
        scenes: predicted.scenes, backup: path.join(directory, 'before.json'), noDatabaseWrites: true };
      io.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
      console.log(JSON.stringify(report, null, 2)); return report;
    }
    const plan = await service.cleanupDashboardDeviceDeletion(tx, { factoryId: values.factory, deviceIds: devices, reason: 'maintenance' });
    const after = await capture(tx, values.factory);
    verify(state, after, plan, service, transform);
    io.writeFileSync(path.join(directory, 'after.json'), JSON.stringify(after, null, 2), { flag: 'wx', mode: 0o600 });
    io.writeFileSync(path.join(directory, 'prepared.json'), JSON.stringify({ committed: false, plan }, null, 2), { flag: 'wx' });
    await db.commit(); committed = true;
    const report = { success: true, committed: true, factoryId: values.factory, plan,
      historicalAndCurrentReleasesUnchanged: true, allSurvivingDataLayoutAndStylePreserved: true,
      backup: path.join(directory, 'before.json'), after: path.join(directory, 'after.json') };
    try { io.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); }
    catch (error) { report.auditWriteError = error.code || 'audit-write-failed'; report.warning = 'Already committed. Do not retry; before/after/prepared proofs are preserved.'; }
    console.log(JSON.stringify(report, null, 2)); return report;
  } finally { try { if (!committed) await db.rollback(); } finally { await db.end(); } }
}
module.exports = { main, verify, makeClient, canonical, hash, independentMirror, assertReferencePrune };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
