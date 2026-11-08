'use strict';
// Device lifecycle owns only proven private content and its references. Never
// normalize/rebuild a whole draft, rewrite a release, or rebind shared data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { cleanupDeletedDeviceContent, dashboardReferencedDeviceIds } = require('../../shared/dashboardDeviceDeletion.mjs');

const KEY = 'dashboard_device_deletion_history_v1';
const MAX_EVENTS = 100;
const MAX_LEDGER_BYTES = 60 * 1024; // factory_settings.value is MySQL TEXT.
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const ids = values => [...new Set((values || []).map(String).filter(Boolean))].sort();
const parse = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const conflict = message => Object.assign(new Error(message), { statusCode: 409, status: 409, code: 'DRAFT_CONFLICT' });
// MySQL consistent reads keep the first transaction snapshot even after a
// dummy UPDATE lock. Its current/locking reads are required for fresh drafts,
// registries and the ledger. q() is supplied by the DB facade without loading
// the app's DB initializer; maintenance wrappers may expose the same contract.
const currentRead = (db, sql, locking = false) => locking && (db.dialect === 'mysql' || db.q?.('lifecycle_lock_probe').startsWith('`')) ? sql + ' FOR UPDATE' : sql;

async function draft(db, row) {
    const value = parse(row.draft_json);
    // Brand-new factories have no canonical draft yet. An empty legacy scene
    // has nothing to prune; never silently rebuild/migrate a populated scene.
    if (!value && (row.draft_json === null || row.draft_json === undefined || row.draft_json === '')
        && !Number((await db.get('SELECT COUNT(*) AS total FROM widgets WHERE scene_id=?', [row.id]))?.total || 0)) return null;
    if (!record(value) || !Array.isArray(value.widgets) || !Array.isArray(value.scene?.views))
        throw new Error(`场景 ${row.id} 的草稿尚未升级或已损坏，无法安全清理设备专属组件`);
    return value;
}
async function sceneRows(db, factoryId, locking = false) {
    return db.all(currentRead(db, 'SELECT s.* FROM scenes s JOIN projects p ON p.id=s.project_id WHERE p.factory_id=? ORDER BY s.id', locking), [factoryId]);
}
async function deletedPointIds(db, deviceIds, explicit) {
    if (explicit !== undefined) return ids(explicit);
    if (!deviceIds.length) return [];
    const rows = await db.all(`SELECT id FROM data_points WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`, deviceIds);
    return ids(rows.map(row => row.id));
}
function publicPlan(scene, result, revision = Number(scene.draft_revision || 0)) {
    return {
        sceneId: String(scene.id), beforeRevision: Number(scene.draft_revision || 0), revision,
        removedWidgetIds: result.removedWidgetIds || [], removedViewIds: result.removedViewIds || [],
        removedTooltipTemplateIds: result.removedTooltipTemplateIds || [],
        removedTooltipWidgetIds: result.removedTooltipWidgetIds || [],
        updatedWidgetIds: result.updatedWidgetIds || [], updatedViewIds: result.updatedViewIds || []
    };
}
async function readDashboardCleanupLedger(db, factoryId, { locking = false } = {}) {
    if (!factoryId) return { version: 1, events: [], deletionAtByDeviceId: {} };
    const row = await db.get(currentRead(db, 'SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', locking), [factoryId, KEY]);
    if (!row) return { version: 1, events: [], deletionAtByDeviceId: {} };
    const ledger = parse(row.value);
    if (!record(ledger) || ledger.version !== 1 || !Array.isArray(ledger.events) || ledger.events.length > MAX_EVENTS
        || !record(ledger.deletionAtByDeviceId)
        || ledger.events.some(event => !record(event) || event.factoryId !== String(factoryId) || !Array.isArray(event.deletedDeviceIds) || !Array.isArray(event.scenes) || !Number.isFinite(Date.parse(event.deletedAt)))
        || Object.values(ledger.deletionAtByDeviceId).some(value => typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
        throw new Error('设备删除确认记录损坏，已停止清理；请从可信备份恢复');
    return clone(ledger);
}
async function readDashboardCleanupHistory(db, factoryId) {
    const ledger = await readDashboardCleanupLedger(db, factoryId);
    const represented = new Set(ledger.events.flatMap(event => event.deletedDeviceIds));
    const olderIds = Object.keys(ledger.deletionAtByDeviceId).filter(id => !represented.has(id));
    if (!olderIds.length) return ledger.events;
    const existing = await factoryDeviceIds(db, factoryId);
    const deletedDeviceIds = olderIds.filter(id => !existing.has(id)).sort();
    if (!deletedDeviceIds.length) return ledger.events;
    const remainingDeviceIds = [...existing].sort();
    const deletedAt = new Date(Math.max(...deletedDeviceIds.map(id => Date.parse(ledger.deletionAtByDeviceId[id])))).toISOString();
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([factoryId,
        deletedDeviceIds.map(id => [id, ledger.deletionAtByDeviceId[id]]), remainingDeviceIds])).digest('hex').slice(0, 32);
    // Event details are bounded, but deletion confirmations are not discarded.
    // An old offline cache can replay this trusted current-state snapshot
    // without advancing a scene CAS revision. Recreated IDs are excluded.
    return [...ledger.events, { id: `history_snapshot_${fingerprint}`, factoryId: String(factoryId),
        deletedDeviceIds, deletedPointIds: [], remainingDeviceIds, deletedAt, reason: 'history_snapshot', scenes: [] }];
}
async function recordDashboardCleanup(tx, plan) {
    const ledger = await readDashboardCleanupLedger(tx, plan.factoryId, { locking: true });
    const deletionAtByDeviceId = { ...ledger.deletionAtByDeviceId };
    for (const id of plan.deletedDeviceIds) Object.defineProperty(deletionAtByDeviceId, id, { value: plan.deletedAt, enumerable: true, configurable: true, writable: true });
    const events = [...ledger.events, clone(plan)].slice(-MAX_EVENTS);
    let value = JSON.stringify({ version: 1, events, deletionAtByDeviceId });
    while (Buffer.byteLength(value) > MAX_LEDGER_BYTES && events.length > 1) {
        events.shift(); value = JSON.stringify({ version: 1, events, deletionAtByDeviceId });
    }
    if (Buffer.byteLength(value) > MAX_LEDGER_BYTES) throw new Error('设备删除确认记录超过安全容量，已取消删除，未丢弃确认记录');
    const existing = await tx.get(currentRead(tx, 'SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', true), [plan.factoryId, KEY]);
    if (existing) await tx.run('UPDATE factory_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE factory_id=? AND `key`=?', [value, plan.factoryId, KEY]);
    else await tx.run('INSERT INTO factory_settings(factory_id,`key`,value) VALUES(?,?,?)', [plan.factoryId, KEY, value]);
}
async function predictDashboardDeviceDeletion(db, { factoryId, deviceIds, pointIds } = {}) {
    const deletedDeviceIds = ids(deviceIds), deletedPoints = await deletedPointIds(db, deletedDeviceIds, pointIds);
    const remainingDeviceIds = [...await factoryDeviceIds(db, factoryId)].filter(id => !deletedDeviceIds.includes(id));
    const scenes = [];
    for (const scene of await sceneRows(db, factoryId)) {
        const original = await draft(db, scene); if (!original) continue;
        const result = cleanupDeletedDeviceContent(original, { deviceIds: deletedDeviceIds, pointIds: deletedPoints, existingDeviceIds: remainingDeviceIds });
        if (result.changed) scenes.push(publicPlan(scene, result));
    }
    const removed = scenes.flatMap(scene => scene.removedWidgetIds);
    let bindingCount = 0;
    for (const scene of scenes) for (const id of scene.removedWidgetIds) {
        const owner = await db.get('SELECT scene_id FROM widgets WHERE id=?', [id]);
        if (!owner || String(owner.scene_id) === scene.sceneId)
            bindingCount += Number((await db.get('SELECT COUNT(*) AS total FROM bindings WHERE widget_id=?', [id]))?.total || 0);
    }
    return { factoryId: String(factoryId), deletedDeviceIds, deletedPointIds: deletedPoints, remainingDeviceIds, scenes,
        removedWidgetCount: removed.length,
        removedViewCount: scenes.reduce((sum, scene) => sum + scene.removedViewIds.length, 0),
        removedTooltipWidgetCount: scenes.reduce((sum, scene) => sum + scene.removedTooltipWidgetIds.reduce((n, item) => n + item.widgetIds.length, 0), 0),
        removedTooltipTemplateCount: scenes.reduce((sum, scene) => sum + scene.removedTooltipTemplateIds.length, 0),
        removedBindingCount: bindingCount };
}
function patchKeys(target, before, after) {
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
        if (same(before?.[key], after?.[key])) continue;
        if (Object.hasOwn(after || {}, key)) target[key] = clone(after[key]); else delete target[key];
    }
}
function mirrorPatch(row, before, after) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!same(before[key], after[key]) && !['content', 'data', 'visibility', 'events', 'style', 'visible'].includes(key))
            throw new Error(`设备清理不能改变组件 ${before.id} 的 ${key}`);
    }
    const config = clone(row.config_json == null || row.config_json === '' ? {} : parse(row.config_json)),
        binding = clone(row.binding_json == null || row.binding_json === '' ? {} : parse(row.binding_json));
    if (!record(config) || !record(binding)) throw new Error(`组件 ${before.id} 的镜像配置已损坏，已取消删除`);
    patchKeys(config, before.content, after.content);
    if (!same(before.visibility, after.visibility)) config.visibility = clone(after.visibility || {});
    if (!same(before.events, after.events)) config.events = clone(after.events || []);
    if (!same(before.style, after.style)) {
        const oldStyle = { ...(before.style || {}) }, newStyle = { ...(after.style || {}) };
        delete oldStyle.viewOverrides; delete newStyle.viewOverrides;
        assert.deepEqual(oldStyle, newStyle, 'Device cleanup can only prune view-specific visual references');
        config.style ||= {}; patchKeys(config.style, before.style, after.style);
    }
    patchKeys(binding, before.data, after.data);
    return { config, binding, visible: same(before.visible, after.visible) ? row.visible : (after.visible === false || after.visible === 0 ? 0 : 1) };
}
async function cleanupDashboardDeviceDeletion(tx, { factoryId, deviceIds, pointIds, now = () => new Date().toISOString(), reason = 'device_deletion' } = {}) {
    const deletedDeviceIds = ids(deviceIds);
    if (!factoryId || !deletedDeviceIds.length) return { factoryId: String(factoryId || ''), deletedDeviceIds, scenes: [] };
    // Portable factory/scene write locks serialize lifecycle operations. Read
    // fresh drafts AFTER the lock, not from the earlier preview/count query.
    const factory = await tx.get(currentRead(tx, 'SELECT id FROM factories WHERE id=?', true), [factoryId]);
    if (!factory) throw new Error('当前工厂不存在，不能清理设备专属内容');
    await tx.run('UPDATE factories SET id=id WHERE id=?', [factoryId]);
    const deletedPoints = await deletedPointIds(tx, deletedDeviceIds, pointIds);
    const remainingDeviceIds = [...await factoryDeviceIds(tx, factoryId, { locking: true })].filter(id => !deletedDeviceIds.includes(id));
    const plan = { id: crypto.randomUUID(), factoryId: String(factoryId), deletedDeviceIds,
        deletedPointIds: deletedPoints, remainingDeviceIds, deletedAt: now(), reason, scenes: [] };
    for (const listed of await sceneRows(tx, factoryId, true)) {
        await tx.run('UPDATE scenes SET draft_revision=draft_revision WHERE id=?', [listed.id]);
        const scene = await tx.get(currentRead(tx, 'SELECT s.* FROM scenes s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.factory_id=?', true), [listed.id, factoryId]);
        if (!scene) throw conflict('场景已被其他操作删除，设备删除已取消');
        const original = await draft(tx, scene); if (!original) continue;
        const result = cleanupDeletedDeviceContent(original, { deviceIds: deletedDeviceIds, pointIds: deletedPoints, existingDeviceIds: remainingDeviceIds });
        if (!result.changed) continue;
        const revision = Number(scene.draft_revision || 0) + 1, saved = clone(result.document);
        saved.metadata = { ...(saved.metadata || {}), revision, updatedAt: plan.deletedAt };
        const updated = await tx.run('UPDATE scenes SET draft_json=?,draft_revision=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND COALESCE(draft_revision,0)=?', [JSON.stringify(saved), revision, scene.id, Number(scene.draft_revision || 0)]);
        if (!Number(updated.changes || updated.affectedRows)) throw conflict('草稿已更新，设备删除已取消，请重新读取后重试');
        const mirrors = await tx.all(currentRead(tx, 'SELECT * FROM widgets WHERE scene_id=?', true), [scene.id]), byId = new Map(mirrors.map(row => [String(row.id), row]));
        for (const id of result.removedWidgetIds) {
            // Also remove orphan bindings if the mirror is absent, but never
            // delete bindings owned by an unrelated scene with the same ID.
            const owner = byId.get(String(id)) || await tx.get(currentRead(tx, 'SELECT scene_id FROM widgets WHERE id=?', true), [id]);
            if (owner && String(owner.scene_id) !== String(scene.id)) continue;
            await tx.run('DELETE FROM bindings WHERE widget_id=?', [id]);
            await tx.run('DELETE FROM widgets WHERE id=? AND scene_id=?', [id, scene.id]);
        }
        const oldWidgets = new Map(original.widgets.map(widget => [widget.id, widget])), newWidgets = new Map(saved.widgets.map(widget => [widget.id, widget]));
        for (const id of result.updatedWidgetIds) {
            const row = byId.get(String(id)); if (!row) continue;
            const next = mirrorPatch(row, oldWidgets.get(id), newWidgets.get(id));
            await tx.run('UPDATE widgets SET config_json=?,binding_json=?,visible=? WHERE id=? AND scene_id=?', [JSON.stringify(next.config), JSON.stringify(next.binding), next.visible, id, scene.id]);
        }
        const persisted = await tx.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?', [scene.id]);
        assert.equal(Number(persisted.draft_revision), revision, 'Device cleanup draft revision did not persist');
        assert.deepEqual(parse(persisted.draft_json), saved, 'Device cleanup draft did not persist exactly');
        plan.scenes.push(publicPlan(scene, result, revision));
    }
    await recordDashboardCleanup(tx, plan);
    return plan;
}
async function factoryDeviceIds(db, factoryId, { locking = false } = {}) {
    // No partial directory, pagination limit, catch-to-empty or template IDs.
    const workshops = new Set((await db.all(currentRead(db, 'SELECT id FROM workshops WHERE factory_id=?', locking), [factoryId])).map(row => String(row.id)));
    const devices = await db.all(currentRead(db, "SELECT d.id,d.line_id,d.instance_config,w.factory_id AS line_factory_id FROM devices d LEFT JOIN `lines` l ON l.id=d.line_id LEFT JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? OR d.line_id IS NULL OR d.line_id=''", locking), [factoryId]);
    return new Set(devices.filter(device => device.line_id ? String(device.line_factory_id || '') === String(factoryId)
        : workshops.has(String(parse(device.instance_config, {})?.workshop_id || parse(device.instance_config, {})?.workshopId || ''))).map(device => String(device.id)));
}
async function confirmedMissingDeviceIds(db, factoryId, options = {}) {
    const ledger = await readDashboardCleanupLedger(db, factoryId, options);
    if (!Object.keys(ledger.deletionAtByDeviceId).length) return [];
    const existing = await factoryDeviceIds(db, factoryId, options);
    return Object.keys(ledger.deletionAtByDeviceId).filter(id => !existing.has(id));
}
async function projectPublishedDeviceDeletion(db, document, { factoryId, releaseTimestamp = 0 } = {}) {
    if (!factoryId) return document;
    const existing = await factoryDeviceIds(db, factoryId), ledger = await readDashboardCleanupLedger(db, factoryId);
    const missing = new Set(dashboardReferencedDeviceIds(document).filter(id => !existing.has(id)));
    for (const [id, deletedAt] of Object.entries(ledger.deletionAtByDeviceId)) {
        if (!releaseTimestamp || Date.parse(deletedAt) >= releaseTimestamp) missing.add(id);
    }
    return missing.size ? cleanupDeletedDeviceContent(document, { deviceIds: [...missing], existingDeviceIds: [...existing] }).document : document;
}
function broadcastDashboardCleanup(plan) {
    if (!plan?.deletedDeviceIds?.length) return;
    global.wsServer?.broadcast?.('device_configuration_changed', { factoryId: plan.factoryId, deletedDeviceIds: plan.deletedDeviceIds,
        dashboardCleanup: plan, reloadRequired: true, timestamp: Date.now() });
}
module.exports = { KEY, MAX_EVENTS, MAX_LEDGER_BYTES, readDashboardCleanupLedger, readDashboardCleanupHistory,
    recordDashboardCleanup, predictDashboardDeviceDeletion, cleanupDashboardDeviceDeletion,
    confirmedMissingDeviceIds, factoryDeviceIds, projectPublishedDeviceDeletion, broadcastDashboardCleanup, mirrorPatch };
