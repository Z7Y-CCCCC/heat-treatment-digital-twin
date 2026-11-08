'use strict';
// All deletions, draft saves and publications use one freshly seeded private
// output/ SQLite fixture. Never load an installed DB, engine, PLC or user session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };

async function main() {
    const directory = createRunDirectory('dashboard-stale-bindings');
    const filename = await createTestDatabase(path.join(directory, 'factory.db'));
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: filename,
        DB_BACKUP_DIR: path.join(directory, 'backups'), DB_RECOVERY_DIR: path.join(directory, 'recovery'),
        DATA_SOURCE_BACKUP_DIR: path.join(directory, 'source-backups') });
    for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
    fs.writeFileSync(path.join(directory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }));
    const database = require('../db/database');
    const documents = require('../services/dashboardDocuments');
    const { normalizeDocument } = require('../utils/dashboardDocument');
    let server;
    try {
        const db = await database.getDb();
        const initial = await documents.loadDesignerState(db);
        const factoryId = initial.project.factory_id;
        const line = await db.get('SELECT l.id,l.workshop_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1', [factoryId]);
        assert.ok(line);
        await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', ['stale_live_A', '当前炉 A', line.id, '{}']);
        await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', ['stale_live_B', '当前炉 B', line.id, '{}']);
        await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', ['stale_deleted', '将删除的炉', line.id, '{}']);
        async function point(deviceId, name, access = 'READ') {
            await db.run('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,access_type) VALUES(?,?,?,?,?,?)', [deviceId, name, name, 'DB1.DBD0', 'REAL', access]);
            return String((await db.get('SELECT id FROM data_points WHERE device_id=? AND name=?', [deviceId,name])).id);
        }
        const pointA = await point('stale_live_A', '温度 A'), pointB = await point('stale_live_B', '温度 B');
        const pointWrite = await point('stale_live_A', '禁止读取的写点', 'WRITE'), pointDeleted = await point('stale_deleted', '原温度');
        const baseline = clone(initial.document);
        baseline.widgets = baseline.widgets.filter(widget => widget.data?.mode !== 'plc');
        for (const template of baseline.tooltipTemplates.templates) template.widgets = template.widgets.filter(widget => widget.data?.mode !== 'plc');
        let revision = initial.revision;
        const sceneId = initial.scene.id;
        const publishedBefore = await db.all('SELECT id,snapshot_json,is_current FROM releases ORDER BY id');
        const scenePublishedBefore = (await db.get('SELECT published_release_id FROM scenes WHERE id=?', [sceneId])).published_release_id;
        const widget = (id, data = {}, visible = true) => ({ id, type: 'value', title: `核对 ${id}`, visible,
            frame: { x: 20, y: 40, width: 300, height: 80 }, content: {},
            data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'stale_live_A', pointId: pointA, readOnly: true, ...data } });
        const draft = (...widgets) => ({ ...clone(baseline), widgets: [...clone(baseline.widgets), ...widgets] });
        async function save(input) {
            const oldRevision = revision;
            const saved = await documents.saveDraft(db, { sceneId, document: input, expectedRevision: revision, factoryId });
            revision = saved.revision;
            assert.equal(revision, oldRevision + 1);
            return saved;
        }
        async function publishedUnchanged() {
            assert.deepEqual(await db.all('SELECT id,snapshot_json,is_current FROM releases ORDER BY id'), publishedBefore);
            assert.equal((await db.get('SELECT published_release_id FROM scenes WHERE id=?', [sceneId])).published_release_id, scenePublishedBefore);
        }
        async function strictPublish(pattern) {
            await assert.rejects(documents.publishDraft(db, { sceneId, factoryId }), pattern);
            await publishedUnchanged();
        }
        async function rejectDraft(input, pattern) {
            const before = await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?', [sceneId]);
            await assert.rejects(documents.saveDraft(db, { sceneId, document: input, expectedRevision: revision, factoryId }), pattern);
            assert.deepEqual(await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?', [sceneId]), before);
            await publishedUnchanged();
        }

        const valid = await save(draft(widget('valid_read')));
        assert.deepEqual(valid.warnings, []);
        await documents.validatePlcBindings(db, valid.document);
        pass('valid read-only PLC bindings save unchanged without new warnings');

        const missing = await save(draft(widget('deleted_point', { pointId: '99999999' })));
        assert.ok(missing.warnings.some(message => message.includes('组件 deleted_point') && message.includes('核对 deleted_point') && message.includes('点位不存在')));
        const savedMissing = missing.document.widgets.find(widget => widget.id === 'deleted_point');
        assert.equal(savedMissing.data.mode, 'plc'); assert.equal(savedMissing.data.pointId, '99999999');
        assert.equal(savedMissing.data.deviceId, 'stale_live_A'); assert.equal(savedMissing.data.deviceScope, 'fixed');
        const legacy = await db.get('SELECT binding_json FROM widgets WHERE id=?', ['deleted_point']);
        assert.equal(JSON.parse(legacy.binding_json).pointId, '99999999');
        const reopened = await documents.loadDesignerState(db, sceneId, factoryId);
        assert.equal(reopened.revision, revision);
        assert.equal(reopened.document.widgets.find(widget => widget.id === 'deleted_point').data.pointId, '99999999');
        await strictPublish(/组件 deleted_point.*点位不存在/);
        pass('deleted point IDs and layout survive draft save/reopen with named warnings; publication remains blocked');

        const deleteDraft = draft(widget('deleted_device', { deviceId: 'stale_deleted', pointId: pointDeleted }));
        const beforeDeletion = await save(deleteDraft);
        assert.deepEqual(beforeDeletion.warnings, []);
        await db.run('DELETE FROM data_points WHERE device_id=?', ['stale_deleted']);
        await db.run('DELETE FROM devices WHERE id=?', ['stale_deleted']);
        const deleted = await save(beforeDeletion.document);
        const retained = deleted.document.widgets.find(widget => widget.id === 'deleted_device');
        assert.equal(retained.data.deviceId, 'stale_deleted'); assert.equal(retained.data.pointId, pointDeleted);
        assert.equal(retained.visible, true);
        assert.ok(deleted.warnings.some(message => message.includes('设备不存在：stale_deleted')));
        assert.ok(deleted.warnings.some(message => message.includes(`点位不存在：${pointDeleted}`)));
        await strictPublish(/组件 deleted_device.*设备不存在/);
        pass('deleting the owning device retains both original reference IDs in drafts without remapping or deleting the widget');

        const unconfigured = await save(draft(widget('deleted_unconfigured', { deviceId: 'stale_deleted', pointId: '', pointKey: 'temp', requireConfiguredPoint: true })));
        assert.equal(unconfigured.warnings.length, 1);
        assert.ok(unconfigured.warnings[0].includes('设备不存在'));
        assert.equal(unconfigured.document.widgets.find(widget => widget.id === 'deleted_unconfigured').data.pointId, '');
        await strictPublish(/设备不存在/);
        pass('requireConfiguredPoint blanks do not bypass deleted fixed-device checks or fabricate a replacement point');

        const hidden = await save(draft(widget('hidden_deleted', { pointId: '99999999' }, false)));
        assert.ok(hidden.warnings.some(message => message.includes('hidden_deleted')));
        assert.equal(hidden.document.widgets.find(widget => widget.id === 'hidden_deleted').visible, false);
        await strictPublish(/hidden_deleted.*点位不存在/);
        pass('hidden main-canvas widgets keep their stale-binding diagnostics and cannot bypass publication checks');

        const tooltipDraft = draft(widget('valid_read'));
        const template = tooltipDraft.tooltipTemplates.templates.find(item => item.kind === 'part');
        template.widgets = [widget('nested_deleted', { pointId: '99999999' }, false)];
        const nested = await save(tooltipDraft);
        assert.ok(nested.warnings.some(message => message.startsWith(`悬停模板“${template.name}”：组件 nested_deleted`) && message.includes('点位不存在')));
        const nestedWidget = nested.document.tooltipTemplates.templates.find(item => item.id === template.id).widgets[0];
        assert.equal(nestedWidget.data.mode, 'plc'); assert.equal(nestedWidget.data.pointId, '99999999');
        assert.equal(await db.get('SELECT id FROM widgets WHERE id=?', ['nested_deleted']), null);
        await strictPublish(/悬停模板.*nested_deleted.*点位不存在/);
        pass('nested and hidden tooltip references are checked, identified by template/widget, and never copied into main-canvas widget storage');

        const current = await save(draft(widget('current_deleted', { deviceScope: 'current', deviceId: '', pointId: '99999999' })));
        assert.ok(current.warnings.some(message => message.includes('current_deleted') && message.includes('点位不存在')));
        assert.equal(current.warnings.some(message => message.includes('设备不存在')), false);
        await strictPublish(/点位不存在/);
        pass('current-device bindings report missing sample points without inventing a missing fixed owner');

        const readViolation = draft(widget('write_point', { pointId: pointWrite }), widget('soft_missing', { pointId: '99999999' }));
        await rejectDraft(readViolation, /write_point.*只能绑定 READ/);
        await rejectDraft(draft(widget('wrong_owner', { pointId: pointB })), /wrong_owner.*设备与点位不匹配/);
        await rejectDraft(draft(widget('wrong_deleted_owner', { deviceId: 'stale_deleted', pointId: pointB })), /设备与点位不匹配/);
        const nestedWrite = draft(widget('valid_read'));
        nestedWrite.tooltipTemplates.templates[0].widgets = [widget('nested_write', { pointId: pointWrite }, false)];
        await rejectDraft(nestedWrite, /nested_write.*只能绑定 READ/);
        const forbiddenWrite = draft(widget('read_intent_violation', { readOnly: false }));
        await rejectDraft(forbiddenWrite, /写入/);
        pass('WRITE points, mismatched live/deleted owners, nested writes and readOnly=false remain hard draft errors with atomic no-write behavior');

        await db.run('INSERT INTO factories(id,name) VALUES(?,?)', ['stale_foreign_factory', 'Private foreign factory']);
        await db.run('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)', ['stale_foreign_ws', 'Private workshop', 'stale_foreign_factory']);
        await db.run('INSERT INTO `lines`(id,name,workshop_id) VALUES(?,?,?)', ['stale_foreign_line', 'Private line', 'stale_foreign_ws']);
        await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', ['stale_foreign', 'Private device', 'stale_foreign_line', JSON.stringify({ workshop_id: line.workshop_id })]);
        const foreignPoint = await point('stale_foreign', 'Foreign READ');
        await rejectDraft(draft(widget('foreign_fixed', { deviceId: 'stale_foreign', pointId: foreignPoint })), /不属于当前工厂/);
        await rejectDraft(draft(widget('foreign_current', { deviceScope: 'current', deviceId: '', pointId: foreignPoint })), /不属于当前工厂/);
        await assert.rejects(documents.saveDraft(db, { sceneId, document: draft(widget('valid_read')), expectedRevision: revision, factoryId: 'stale_foreign_factory' }), /场景不存在/);
        pass('foreign factory points/devices and spoofed workshop overrides remain hard errors; scene scope cannot be expanded by draft save');

        await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', ['stale_workshop_local', 'Workshop-only device', null, JSON.stringify({ workshop_id: line.workshop_id })]);
        const localPoint = await point('stale_workshop_local', 'Workshop READ');
        const completed = await save(draft(widget('completed', { deviceId: 'stale_workshop_local', pointId: localPoint })));
        assert.deepEqual(completed.warnings, []);
        const publish = await documents.publishDraft(db, { sceneId, factoryId });
        assert.equal(publish.document.widgets.find(widget => widget.id === 'completed').data.pointId, localPoint);
        pass('valid workshop-local ownership is accepted and explicit binding replacement permits normal publication');

        const beforeConflict = await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?', [sceneId]);
        await assert.rejects(documents.saveDraft(db, { sceneId, document: normalizeDocument(draft(widget('valid_read'))), expectedRevision: initial.revision, factoryId }), error => error.code === 'DRAFT_CONFLICT');
        assert.deepEqual(await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?', [sceneId]), beforeConflict);
        pass('stale binding allowances never weaken optimistic draft revision conflicts');

        const express = require('express'), app = express();
        app.use(express.json({ limit: '4mb' }));
        app.use((req, res, next) => { req.factoryId = factoryId; next(); });
        app.use('/api/platform', require('../routes/platform'));
        server = http.createServer(app);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const latestReleaseRows = await db.all('SELECT id,snapshot_json,is_current FROM releases ORDER BY id');
        const httpSave = await fetch(`${origin}/api/platform/designer/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sceneId, document: draft(widget('http_deleted', { pointId: '99999999' })), expectedRevision: revision }) });
        const httpSaved = await httpSave.json();
        assert.equal(httpSave.status, 200); assert.equal(httpSaved.success, true);
        assert.equal(httpSaved.revision, revision + 1); revision = httpSaved.revision;
        assert.ok(httpSaved.warnings.some(message => message.includes('http_deleted') && message.includes('点位不存在')));
        assert.equal(httpSaved.document.widgets.find(widget => widget.id === 'http_deleted').data.pointId, '99999999');
        const httpPublish = await fetch(`${origin}/api/platform/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sceneId }) });
        const failedPublish = await httpPublish.json();
        assert.equal(httpPublish.status, 400);
        assert.ok(failedPublish.errors.some(message => message.includes('http_deleted') && message.includes('点位不存在')));
        assert.deepEqual(await db.all('SELECT id,snapshot_json,is_current FROM releases ORDER BY id'), latestReleaseRows);
        pass('the real platform HTTP route returns 200 plus draft warnings but rejects publication with locatable errors and no release write');

        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2));
        console.log(JSON.stringify({ success: true, checks: checks.length, directory }, null, 2));
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await database.closeDb();
    }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
