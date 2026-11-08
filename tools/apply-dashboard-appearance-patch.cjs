'use strict';
// Explicit, scoped appearance-only patch. No application DB initialization,
// normalization, PLC writes, asset changes or publication is performed.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const STYLE_KEYS = new Set(['background','backgroundOpacity','color','borderColor','borderRadius','padding','fontSize','opacity','shadow','boxShadow','valueColor','onColor','offColor','alarmColor','eyebrowFontSize','eyebrowColor','surfaceSkin','surfaceAccent','backdropFilter','viewOverrides']);
const OVERRIDE_KEYS = new Set(['background','backgroundOpacity','color','borderColor','borderRadius','opacity','shadow','boxShadow','surfaceSkin','surfaceAccent','backdropFilter']);
const CONTENT_KEYS = new Set(['lineColor','areaColor','lineWidth','areaOpacity','axisLabelColor','gridColor','barRadius','donutRatio']);
const copy = value => JSON.parse(JSON.stringify(value));
// mysql2 parses native MySQL JSON columns into objects by default; fixtures
// and older TEXT mirrors return strings. Accept both without normalization.
function jsonValue(value) {
  if (value === null || value === undefined || value === '') return {};
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  assert.ok(typeof value === 'object', 'Expected an original JSON object or JSON string');
  return copy(value);
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function potentialAppearance(widget, view) {
  if (!view || widget.visible === false || widget.visible === 0 || widget.runtimeTarget === 'unity') return false;
  const type = widget.type || widget.widget_type, keys = [widget.id, type, `system:${type}`, widget.groupId && `group:${widget.groupId}`].filter(Boolean), state = view.componentState || {};
  if (keys.some(key => state.hide?.includes(key))) return false;
  if (state.show?.length && !keys.some(key => state.show.includes(key))) return false;
  if (widget.visibility?.viewIds?.length && !widget.visibility.viewIds.includes(view.id)) return false;
  if (widget.visibility?.viewModes?.length && !widget.visibility.viewModes.includes(view.mode)) return false;
  return true;
}
function descendantViews(document, sourceViewId = 'factory_overview') {
  const views = document.scene?.views || [], byId = new Map(views.map(view => [view.id, view]));
  assert.ok(byId.has(sourceViewId), 'Reference view does not exist');
  return views.filter(view => {
    const seen = new Set([view.id]); let parent = view.parentViewId;
    while (parent) { if (parent === sourceViewId) return true; assert.ok(!seen.has(parent), 'View hierarchy contains a cycle'); seen.add(parent); parent = byId.get(parent)?.parentViewId; }
    return false;
  });
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function validateVisualScalar(key, value) {
  if (key === 'surfaceSkin') assert.ok(['glass','inline'].includes(value), 'Unknown surface skin');
  else if (['backgroundOpacity','opacity','borderRadius'].includes(key)) assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= (key === 'borderRadius' ? 80 : 1), `Invalid visual number: ${key}`);
  else {
    assert.ok(typeof value === 'string' && value.length <= 4096 && !/[;{}]|url\s*\(/i.test(value), `Invalid visual string: ${key}`);
    if (key === 'surfaceAccent') assert.ok(/^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value), 'Invalid surface accent');
    if (key === 'backdropFilter' && value !== 'none') {
      const filter = /^blur\((\d+(?:\.\d+)?)px\)(?: saturate\((\d+(?:\.\d+)?)%\))?$/.exec(value);
      assert.ok(filter && Number(filter[1]) <= 40 && (!filter[2] || Number(filter[2]) <= 300), 'Invalid backdrop filter');
    }
    if (key === 'shadow') assert.ok(['none','soft','glow','strong'].includes(value), 'Unknown shadow preset');
  }
}
function validateAppearanceStyle(key, value, document, widget) {
  if (value === undefined) return;
  if (key !== 'viewOverrides') { if (['surfaceSkin','surfaceAccent','backdropFilter'].includes(key)) validateVisualScalar(key, value); return; }
  assert.ok(plain(value), 'View appearance overrides must be a plain object');
  const targets = new Map(descendantViews(document).map(view => [view.id, view]));
  assert.ok(Object.keys(value).length <= targets.size, 'Too many view appearance overrides');
  for (const [viewId, override] of Object.entries(value)) {
    assert.ok(targets.has(viewId) && potentialAppearance(widget, targets.get(viewId)), `Appearance override outside original child scope: ${viewId}`);
    assert.ok(plain(override), 'Each view appearance override must be a plain style object');
    for (const [nestedKey, nestedValue] of Object.entries(override)) {
      assert.ok(OVERRIDE_KEYS.has(nestedKey), `Non-appearance view override rejected: ${nestedKey}`);
      validateVisualScalar(nestedKey, nestedValue);
    }
  }
}
function allowedAppearanceIds(document, sourceViewId = 'factory_overview') {
  const views = document.scene?.views || [], targets = descendantViews(document, sourceViewId);
  assert.ok(targets.length, 'Reference view has no child views');
  const targetIds = new Set(targets.map(view => view.id)), protectedViews = views.filter(view => !targetIds.has(view.id));
  return new Set(document.widgets.filter(widget => targets.some(view => potentialAppearance(widget, view)) && !protectedViews.some(view => potentialAppearance(widget, view))).map(widget => widget.id));
}
function appearanceChanges(before, after) {
  assert.equal(before.widgets.length, after.widgets.length);
  const stripped = copy(after), changes = [];
  for (let index = 0; index < before.widgets.length; index++) {
    const old = before.widgets[index], next = after.widgets[index]; assert.equal(old.id, next.id);
    const fields = { style: [], content: [] };
    for (const group of ['style', 'content']) for (const key of new Set([...Object.keys(old[group] || {}), ...Object.keys(next[group] || {})])) {
      if (JSON.stringify(old[group]?.[key]) === JSON.stringify(next[group]?.[key])) continue;
      assert.ok((group === 'style' ? STYLE_KEYS : CONTENT_KEYS).has(key), `Non-appearance mutation rejected: ${old.id}.${group}.${key}`);
      if (group === 'style') validateAppearanceStyle(key, next.style?.[key], before, old);
      fields[group].push(key);
    }
    if (fields.style.length || fields.content.length) changes.push({ id: old.id, index, ...fields });
    stripped.widgets[index].style = copy(old.style || {});
    stripped.widgets[index].content = copy(old.content || {});
    if (!Object.hasOwn(old, 'style')) delete stripped.widgets[index].style;
    if (!Object.hasOwn(old, 'content')) delete stripped.widgets[index].content;
  }
  assert.deepEqual(stripped, before, 'Data, text, layout, views, tooltip templates and every non-appearance field must remain unchanged');
  return changes;
}
async function main(dependencies = {}) {
  const io = dependencies.fs || fs;
  const { values } = dependencies.values ? { values: dependencies.values } : parseArgs({ options: { config: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, factory: { type: 'string' }, scene: { type: 'string' }, apply: { type: 'boolean' } } });
  for (const key of ['config','before','after','factory','scene']) assert.ok(values[key], `--${key} is required`);
  const backup = JSON.parse(fs.readFileSync(values.before, 'utf8'));
  assert.equal(backup.factory.id, values.factory);
  const original = backup.scenes.find(item => item.id === values.scene); assert.ok(original?.document);
  const next = JSON.parse(fs.readFileSync(values.after, 'utf8'));
  const changes = appearanceChanges(original.document, next);
  assert.ok(changes.length, 'No appearance changes to apply');
  const allowed = allowedAppearanceIds(original.document);
  for (const change of changes) assert.ok(allowed.has(change.id), `Reference/shared/non-child component is protected: ${change.id}`);
  if (!values.apply) { console.log(JSON.stringify({ dryRun: true, factory: values.factory, scene: values.scene, expectedRevision: original.draft_revision, appearanceOnly: true, changedWidgets: changes.length })); return; }
  const config = JSON.parse(fs.readFileSync(values.config, 'utf8')); assert.equal(config.type, 'mysql');
  const directory = io.mkdtempSync(path.join(ROOT, 'output', 'dashboard-appearance-apply-'));
  const mysql = dependencies.mysql || require(path.join(ROOT, 'backend/node_modules/mysql2/promise'));
  const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, dateStrings: true });
  let committed = false;
  try {
    await db.beginTransaction();
    const [rows] = await db.execute('SELECT s.* FROM scenes s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.factory_id=? FOR UPDATE', [values.scene, values.factory]);
    assert.equal(rows.length, 1); const scene = rows[0];
    assert.equal(Number(scene.draft_revision), Number(original.draft_revision), 'Draft revision changed; inspect again instead of overwriting edits');
    assert.deepEqual(jsonValue(scene.draft_json), original.document, 'Draft contents changed; no overwrite is permitted');
    const [legacy] = await db.execute('SELECT id,scene_id,config_json,binding_json FROM widgets WHERE scene_id=? FOR UPDATE', [values.scene]);
    const byId = new Map(legacy.map(row => [row.id, row]));
    for (const change of changes) assert.ok(byId.has(change.id), `Legacy mirror missing: ${change.id}`);
    io.writeFileSync(path.join(directory, 'before.json'), JSON.stringify({ factoryId: values.factory, scene, legacy, changes }, null, 2), { mode: 0o600, flag: 'wx' });
    const revision = Number(scene.draft_revision) + 1;
    const saved = copy(next); saved.metadata = { ...(saved.metadata || {}), revision, updatedAt: new Date().toISOString() };
    const [result] = await db.execute('UPDATE scenes SET draft_json=?,draft_revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND draft_revision=?', [JSON.stringify(saved), revision, values.scene, scene.draft_revision]);
    assert.equal(result.affectedRows, 1);
    const expectedConfigs = new Map(legacy.map(row => [row.id, row.config_json]));
    for (const change of changes) {
      const row = byId.get(change.id), oldConfig = jsonValue(row.config_json), nextConfig = copy(oldConfig);
      assert.deepEqual(oldConfig.style || {}, original.document.widgets[change.index].style || {}, `Legacy style differs: ${change.id}`);
      nextConfig.style = copy(next.widgets[change.index].style || {});
      for (const key of change.content) {
        if (Object.hasOwn(next.widgets[change.index].content || {}, key)) nextConfig[key] = next.widgets[change.index].content[key];
        else delete nextConfig[key];
      }
      const [updated] = await db.execute('UPDATE widgets SET config_json=? WHERE id=? AND scene_id=?', [JSON.stringify(nextConfig), row.id, values.scene]); assert.equal(updated.affectedRows, 1);
      expectedConfigs.set(row.id, JSON.stringify(nextConfig));
      const stripped = copy(nextConfig); stripped.style = copy(oldConfig.style || {}); if (!Object.hasOwn(oldConfig, 'style')) delete stripped.style;
      for (const key of change.content) { if (Object.hasOwn(oldConfig, key)) stripped[key] = oldConfig[key]; else delete stripped[key]; }
      assert.deepEqual(stripped, oldConfig);
    }
    const [stored] = await db.execute('SELECT draft_json,draft_revision,published_release_id FROM scenes WHERE id=?', [values.scene]);
    assert.deepEqual(jsonValue(stored[0].draft_json), saved); assert.equal(Number(stored[0].draft_revision), revision); assert.equal(stored[0].published_release_id, scene.published_release_id);
    const [mirrors] = await db.execute('SELECT id,binding_json,config_json FROM widgets WHERE scene_id=?', [values.scene]);
    assert.deepEqual(mirrors.map(row => [row.id,row.binding_json]).sort(), legacy.map(row => [row.id,row.binding_json]).sort());
    for (const mirror of mirrors) assert.deepEqual(jsonValue(mirror.config_json), jsonValue(expectedConfigs.get(mirror.id)), `Stored legacy config differs: ${mirror.id}`);
    io.writeFileSync(path.join(directory, 'after.json'), JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
    const report = { success: false, committed: false, factory: values.factory, scene: values.scene, beforeRevision: Number(scene.draft_revision), revision, changedWidgets: changes.length, appearanceOnly: true, originalDataAndLayoutPreserved: true, tooltipTemplatesPreserved: true, publishedReleaseUnchanged: scene.published_release_id, beforeHash: hash(original.document), afterHash: hash(saved), backup: path.join(directory, 'before.json'), document: path.join(directory, 'after.json') };
    io.writeFileSync(path.join(directory, 'prepared.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    await db.commit(); committed = true; report.success = true; report.committed = true;
    try { io.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); }
    catch (error) { report.auditWriteError = error.code || 'audit-write-failed'; report.warning = 'Database patch is already committed; do not retry it. Before/after/prepared files are preserved.'; }
    console.log(JSON.stringify(report, null, 2)); return report;
  } catch (error) { if (!committed) await db.rollback(); throw error; } finally { await db.end(); }
}
module.exports = { main, appearanceChanges, allowedAppearanceIds, STYLE_KEYS, CONTENT_KEYS, OVERRIDE_KEYS, validateAppearanceStyle, jsonValue };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
