const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

async function zipFile(filename, entries) {
    await new Promise((resolve, reject) => {
        const archive = archiver('zip'); const out = fs.createWriteStream(filename);
        out.on('close', resolve); out.on('error', reject); archive.on('error', reject); archive.pipe(out);
        for (const [name, bytes] of entries) archive.append(bytes, { name });
        archive.finalize();
    });
}

(async () => {
    const directory = createRunDirectory('project-bundle');
    const database = await createTestDatabase(path.join(directory, 'test.db'));
    process.env.APP_DATA_DIR = directory; process.env.DB_TYPE = 'sqlite'; process.env.SQLITE_FILE = database;
    process.env.DB_BACKUP_DIR = path.join(directory, 'backups'); process.env.DB_RECOVERY_DIR = path.join(directory, 'recovery');
    const { getDb, closeDb } = require('../db/database');
    const { exportBundle, inspectBundle, importBundle } = require('../services/projectBundle');
    const db = await getDb();
    const uploadsRoot = path.join(directory, 'uploads'); const assetsRoot = path.join(directory, 'assets');
    const options = { db, uploadsRoot, assetsRoot };
    for (const root of [uploadsRoot, assetsRoot]) fs.mkdirSync(root, { recursive: true });
    for (const [relative, data] of [
        ['models/sample.gltf', JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'sample.bin', byteLength: 4 }], images: [{ uri: '../appearance/picture.png' }] })],
        ['models/sample.bin', 'mesh'], ['appearance/picture.png', 'image'], ['audio/alarm.wav', 'sound']
    ]) { const filename = path.join(uploadsRoot, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, data); }
    try {
        await db.run('INSERT INTO factories (id, name) VALUES (?, ?)', ['portable_source', '便携工厂']);
        await db.run('INSERT INTO factories (id, name) VALUES (?, ?)', ['unrelated_factory', '不得修改']);
        await db.run('INSERT INTO workshops (id, factory_id, name) VALUES (?, ?, ?)', ['portable_ws', 'portable_source', '车间']);
        await db.run('INSERT INTO `lines` (id, workshop_id, name) VALUES (?, ?, ?)', ['portable_line', 'portable_ws', '产线']);
        await db.run('INSERT INTO device_templates (id, name) VALUES (?, ?)', ['portable_template', '设备模板']);
        await db.run('INSERT INTO datapoint_templates (id, device_template_id, name, label) VALUES (?, ?, ?, ?)', ['portable_pt', 'portable_template', 'temp', '温度']);
        await db.run('INSERT INTO models (id, name, file_path, factory_id, thumbnail) VALUES (?, ?, ?, ?, ?)', ['portable_model', '模型', '/uploads/models/sample.gltf', 'portable_source', '/uploads/appearance/picture.png']);
        await db.run('INSERT INTO devices (id, name, line_id, model_type, model_file, template_id, plc_enabled, plc_ip, plc_options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['portable_device', '设备', 'portable_line', 'portable_model', '/uploads/models/sample.gltf', 'portable_template', 1, '192.168.10.123', JSON.stringify({ password: 'must-never-export' })]);
        const point = await db.run('INSERT INTO data_points (device_id, name, label, plc_tag, voice_config) VALUES (?, ?, ?, ?, ?)', ['portable_device', 'temp', '温度', 'DB1.DBD0', JSON.stringify({ url: '/uploads/audio/alarm.wav' })]);
        const pointId = Number(point.insertId);
        const document = { schemaVersion: 1, projectId: 'portable_project', sceneId: 'portable_scene', widgets: [{ id: 'portable_widget', data: { mode: 'plc', deviceId: 'portable_device', pointId: String(pointId), connectionId: 'primary' }, image: '/uploads/appearance/picture.png', password: 'json-secret' }] };
        await db.run('UPDATE devices SET instance_config = ? WHERE id = ?', [JSON.stringify({ pointId }), 'portable_device']);
        await db.run('INSERT INTO projects (id, factory_id, name, is_active) VALUES (?, ?, ?, ?)', ['portable_project', 'portable_source', '项目', 1]);
        await db.run('INSERT INTO scenes (id, project_id, name, draft_json, published_release_id, is_active) VALUES (?, ?, ?, ?, ?, ?)', ['portable_scene', 'portable_project', '场景', JSON.stringify(document), 'portable_release', 1]);
        await db.run('INSERT INTO widgets (id, scene_id, widget_type, binding_json) VALUES (?, ?, ?, ?)', ['portable_widget', 'portable_scene', 'kpi', JSON.stringify(document.widgets[0].data)]);
        await db.run('INSERT INTO bindings (id, widget_id, source_id) VALUES (?, ?, ?)', ['portable_binding', 'portable_widget', 'portable_device']);
        await db.run('INSERT INTO releases (id, project_id, scene_id, version, snapshot_json, is_current) VALUES (?, ?, ?, ?, ?, ?)', ['portable_release', 'portable_project', 'portable_scene', 'v1', JSON.stringify(document), 1]);
        await db.run('INSERT INTO factory_settings (factory_id, `key`, value) VALUES (?, ?, ?)', ['portable_source', 'native_dashboard_config', JSON.stringify({ title: '专属配置', image: '/uploads/appearance/picture.png' })]);
        const archive = path.join(directory, 'portable.zip');
        await exportBundle('portable_source', archive, options);
        const checked = await inspectBundle(archive);
        assert.equal(checked.inspection.assetCount, 4);
        assert.equal(checked.inspection.counts.devices, 1);
        const zip = await unzipper.Open.file(archive);
        const entries = await Promise.all(zip.files.map(async entry => [entry.path, await entry.buffer()]));
        const configText = entries.find(([name]) => name === 'config.json')[1].toString();
        assert.ok(!configText.includes('must-never-export') && !configText.includes('192.168.10.123') && !configText.includes('json-secret'));
        const first = await importBundle(archive, { name: '一号副本', inspectedSha256: checked.sha256 }, options);
        const second = await importBundle(archive, { name: '二号副本', inspectedSha256: checked.sha256 }, options);
        assert.notEqual(first.factoryId, second.factoryId);
        const newProject = await db.get('SELECT * FROM projects WHERE factory_id = ?', [first.factoryId]);
        const scene = await db.get('SELECT * FROM scenes WHERE project_id = ?', [newProject.id]);
        const draft = JSON.parse(scene.draft_json);
        const newDevice = await db.get('SELECT * FROM devices WHERE id = ?', [draft.widgets[0].data.deviceId]);
        const newPoint = await db.get('SELECT * FROM data_points WHERE id = ?', [draft.widgets[0].data.pointId]);
        assert.notEqual(newDevice.id, 'portable_device'); assert.equal(newPoint.device_id, newDevice.id);
        assert.notEqual(newPoint.id, pointId); assert.equal(JSON.parse(newDevice.instance_config).pointId, newPoint.id);
        assert.equal(newDevice.plc_enabled, 0); assert.equal(newDevice.plc_ip, '');
        assert.equal(draft.projectId, newProject.id); assert.equal(draft.sceneId, scene.id);
        assert.match(draft.widgets[0].data.connectionId, /^unconfigured_/);
        const release = await db.get('SELECT * FROM releases WHERE id = ?', [scene.published_release_id]);
        assert.deepEqual(JSON.parse(release.snapshot_json), draft);
        const importedModel = await db.get('SELECT * FROM models WHERE id = ?', [newDevice.model_type]);
        assert.equal(importedModel.factory_id, first.factoryId);
        assert.equal(importedModel.file_path, newDevice.model_file);
        assert.equal(fs.readFileSync(path.join(uploadsRoot, newDevice.model_file.slice('/uploads/'.length)), 'utf8'), fs.readFileSync(path.join(uploadsRoot, 'models/sample.gltf'), 'utf8'));
        assert.equal(fs.readFileSync(path.join(uploadsRoot, path.posix.dirname(newDevice.model_file).slice('/uploads/'.length), 'sample.bin'), 'utf8'), 'mesh');
        assert.equal((await db.get('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?', [first.factoryId, 'data_mode'])).value, 'simulation');
        assert.equal((await db.get('SELECT name FROM factories WHERE id = ?', ['unrelated_factory'])).name, '不得修改');
        assert.equal((await db.get('SELECT plc_enabled FROM devices WHERE id = ?', ['portable_device'])).plc_enabled, 1);
        // Hash mismatch and malformed packages must not create rows or assets.
        const count = (await db.get('SELECT COUNT(*) AS n FROM factories')).n;
        const assetDirectories = fs.readdirSync(path.join(uploadsRoot, 'projects')).sort();
        await assert.rejects(importBundle(archive, { inspectedSha256: '0'.repeat(64) }, options), /重新检查/);
        const bad = path.join(directory, 'bad.zip');
        await zipFile(bad, entries.map(([name, bytes]) => [name, name.endsWith('sample.bin') ? Buffer.from('bad!') : bytes]));
        await assert.rejects(inspectBundle(bad), /SHA256/);
        const invalid = path.join(directory, 'invalid.zip');
        const changed = entries.map(([name, bytes]) => [name, Buffer.from(bytes)]);
        const config = JSON.parse(configText); config.tables.devices[0].line_id = 'unrelated_line';
        const configBytes = Buffer.from(JSON.stringify(config));
        const manifest = JSON.parse(changed.find(([name]) => name === 'manifest.json')[1]);
        manifest.config.size = configBytes.length; manifest.config.sha256 = crypto.createHash('sha256').update(configBytes).digest('hex');
        await zipFile(invalid, changed.map(([name, bytes]) => [name, name === 'config.json' ? configBytes : name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : bytes]));
        await assert.rejects(inspectBundle(invalid), /包外配置/);
        // A late failure must roll back even after every row and file was written.
        await assert.rejects(importBundle(archive, { inspectedSha256: checked.sha256 }, { ...options, beforeCommit: () => { throw new Error('injected rollback'); } }), /injected rollback/);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM factories')).n, count);
        assert.deepEqual(fs.readdirSync(path.join(uploadsRoot, 'projects')).sort(), assetDirectories);
        // Re-export the imported namespace to prove assets stay portable a second time.
        const again = path.join(directory, 'again.zip'); await exportBundle(first.factoryId, again, options);
        assert.equal((await inspectBundle(again)).inspection.assetCount, 4);
        // Shared appearance travels with the package but only applies by opt-in.
        const { normalizeSettingValue } = require('../routes/settings');
        const appearanceName = `${'a'.repeat(32)}.png`;
        fs.writeFileSync(path.join(uploadsRoot, 'appearance', appearanceName), 'shared appearance');
        await db.upsert('settings', { key: 'group_portal_config', value: normalizeSettingValue('group_portal_config', { brandTitle: '源集团', logoUrl: `/uploads/appearance/${appearanceName}` }) }, 'key');
        await db.upsert('settings', { key: 'loading_experience_config', value: normalizeSettingValue('loading_experience_config', { title: '源加载', imageUrl: `/uploads/appearance/${appearanceName}` }) }, 'key');
        await db.upsert('settings', { key: 'private_migration_test_secret', value: 'NEVER_SHARE_SETTINGS' }, 'key');
        const sharedZip = path.join(directory, 'shared.zip'); await exportBundle('portable_source', sharedZip, options);
        const sharedCheck = await inspectBundle(sharedZip);
        assert.equal(sharedCheck.inspection.sharedAppearance.available, true);
        assert.deepEqual(sharedCheck.inspection.sharedAppearance.keys.sort(), ['group_portal_config', 'loading_experience_config']);
        const sharedArchive = await unzipper.Open.file(sharedZip);
        assert.ok(!(await sharedArchive.files.find(entry => entry.path === 'config.json').buffer()).toString().includes('NEVER_SHARE_SETTINGS'));
        const targetGroup = normalizeSettingValue('group_portal_config', { brandTitle: '目标集团' });
        await db.upsert('settings', { key: 'group_portal_config', value: targetGroup }, 'key');
        const unchecked = await importBundle(sharedZip, { inspectedSha256: sharedCheck.sha256 }, options);
        assert.equal(unchecked.appliedSharedAppearance, false);
        assert.equal((await db.get('SELECT value FROM settings WHERE `key` = ?', ['group_portal_config'])).value, targetGroup);
        const checkedShared = await importBundle(sharedZip, { inspectedSha256: sharedCheck.sha256, applySharedAppearance: true }, options);
        assert.equal(checkedShared.appliedSharedAppearance, true);
        const appliedGroup = JSON.parse((await db.get('SELECT value FROM settings WHERE `key` = ?', ['group_portal_config'])).value);
        const appliedLoading = JSON.parse((await db.get('SELECT value FROM settings WHERE `key` = ?', ['loading_experience_config'])).value);
        assert.equal(appliedGroup.brandTitle, '源集团'); assert.equal(appliedLoading.title, '源加载');
        assert.match(appliedLoading.imageUrl, /^\/uploads\/projects\//);
        assert.equal(appliedGroup.logoUrl, appliedLoading.imageUrl);
        assert.equal(JSON.parse(normalizeSettingValue('loading_experience_config', appliedLoading)).imageUrl, appliedLoading.imageUrl);
        assert.equal(fs.readFileSync(path.join(uploadsRoot, appliedLoading.imageUrl.slice('/uploads/'.length)), 'utf8'), 'shared appearance');
        const sharedAgain = path.join(directory, 'shared-again.zip'); await exportBundle(checkedShared.factoryId, sharedAgain, options);
        assert.equal((await inspectBundle(sharedAgain)).inspection.sharedAppearance.available, true);
        await assert.rejects(importBundle(sharedZip, { inspectedSha256: sharedCheck.sha256, applySharedAppearance: true }, { ...options, beforeCommit: () => { throw new Error('shared rollback'); } }), /shared rollback/);
        assert.deepEqual(JSON.parse((await db.get('SELECT value FROM settings WHERE `key` = ?', ['loading_experience_config'])).value), appliedLoading);
        // HTTP multipart inspect/import and streamed download use the same contract.
        const express = require('express');
        const app = express(); app.use('/api/project-bundles', require('../routes/projectBundles')(options));
        const server = await new Promise(resolve => { const live = app.listen(0, '127.0.0.1', () => resolve(live)); });
        try {
            const base = `http://127.0.0.1:${server.address().port}/api/project-bundles`;
            const unknownFactory = await fetch(`${base}/export`, { headers: { 'x-factory-id': 'missing_factory' } });
            assert.equal(unknownFactory.status, 404, 'an invalid factory header must never fall back to the active factory');
            const exported = await fetch(`${base}/export`, { headers: { 'x-factory-id': first.factoryId } });
            assert.equal(exported.status, 200);
            const bytes = await exported.arrayBuffer(); assert.ok(bytes.byteLength > 0);
            const inspectForm = new FormData(); inspectForm.set('file', new Blob([bytes]), 'project.zip');
            const inspected = await fetch(`${base}/inspect`, { method: 'POST', body: inspectForm });
            assert.equal(inspected.status, 200); const payload = await inspected.json();
            assert.equal(payload.inspection.factoryName, '一号副本');
            assert.equal(payload.inspection.counts.devices, 1);
            assert.equal(payload.inspection.assetCount, 5);
            const importForm = new FormData(); importForm.set('file', new Blob([bytes]), 'project.zip');
            importForm.set('name', 'HTTP 导入副本'); importForm.set('inspectedSha256', payload.sha256);
            const imported = await fetch(`${base}/import`, { method: 'POST', body: importForm });
            assert.equal(imported.status, 201); assert.ok((await imported.json()).factoryId);
            const broadcast = []; global.wsServer = { broadcast: (...args) => broadcast.push(args) };
            const sharedForm = new FormData(); sharedForm.set('file', new Blob([fs.readFileSync(sharedZip)]), 'shared.zip');
            sharedForm.set('name', '共享外观 HTTP'); sharedForm.set('inspectedSha256', sharedCheck.sha256); sharedForm.set('applySharedAppearance', 'true');
            const sharedResponse = await fetch(`${base}/import`, { method: 'POST', body: sharedForm });
            assert.equal(sharedResponse.status, 201); assert.equal((await sharedResponse.json()).appliedSharedAppearance, true);
            assert.equal(broadcast[0][0], 'configuration_changed'); assert.ok(broadcast[0][1].settings.loading_experience_config);
            delete global.wsServer;
        } finally { await new Promise(resolve => server.close(resolve)); }
        // Packaged builtin models become independent, portable library entries.
        fs.mkdirSync(path.join(assetsRoot, 'models'), { recursive: true });
        fs.writeFileSync(path.join(assetsRoot, 'models/photo_transfer_cart_v6.glb'), 'builtin mesh');
        fs.writeFileSync(path.join(assetsRoot, 'models/photo_transfer_cart_v6_preview.png'), 'builtin preview');
        await db.run('UPDATE devices SET model_type = ?, model_file = ? WHERE id = ?', ['photo_transfer_cart_v6', '', 'portable_device']);
        const builtinFile = path.join(directory, 'builtin.zip');
        await exportBundle('portable_source', builtinFile, options);
        const builtinChecked = await inspectBundle(builtinFile);
        assert.equal(builtinChecked.inspection.assetCount, 7);
        const builtinCopy = await importBundle(builtinFile, { inspectedSha256: builtinChecked.sha256 }, options);
        const builtinModel = await db.get('SELECT * FROM models WHERE factory_id = ? AND name LIKE ?', [builtinCopy.factoryId, '%转运%']);
        assert.ok(builtinModel && builtinModel.id !== 'photo_transfer_cart_v6');
        assert.equal(fs.readFileSync(path.join(uploadsRoot, builtinModel.file_path.slice('/uploads/'.length)), 'utf8'), 'builtin mesh');
        console.log('PASS project bundle: independent copies, all assets, glTF dependencies, IDs, drafts/releases, credential removal, hash rejection and transactional rollback');
    } finally { await closeDb(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
