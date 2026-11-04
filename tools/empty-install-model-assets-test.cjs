'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { BACKEND_DIR, createRunDirectory, findFreePort, startLoggedProcess, forceStop, waitForHttp, requestJson, testFetch } = require('../backend/scripts/integration-test-utils.cjs');
const Database = require('../backend/node_modules/better-sqlite3');
const bundle = require('../backend/services/modelAssetBundle');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('empty-install-model-assets');
const data = path.join(directory, 'data'), uploads = path.join(directory, 'uploads');
const tables = ['factories','factory_settings','workshops','lines','devices','data_points','models','bindings','device_templates','datapoint_templates','projects','scenes','widgets','releases','event_logs','metric_snapshots'];
let child; const checks = [];
async function main() {
    fs.mkdirSync(data, { recursive: true });
    const port = await findFreePort(), origin = 'http://127.0.0.1:' + port;
    const start = async () => {
        child = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], { cwd: BACKEND_DIR,
            env: { ...process.env, APP_DATA_DIR: data, UPLOADS_DIR: uploads, APP_EMPTY_INSTALL: '1', PORT: String(port), HOST: '127.0.0.1' }, logFile: path.join(directory, 'backend.log') });
        await waitForHttp(origin + '/api/health');
        await waitForHttp(origin + '/api/config');
    };
    const counts = () => {
        const db = new Database(path.join(data, 'factory.db'), { readonly: true });
        try { return Object.fromEntries(tables.map(t => [t, db.prepare('SELECT COUNT(*) AS n FROM `' + t + '`').get().n])); }
        finally { db.close(); }
    };
    const assertEmpty = () => { for (const [table, n] of Object.entries(counts())) assert.equal(n, 0, table); };
    const post = (url, body) => requestJson(origin + url, { method: 'POST', body: JSON.stringify(body) });
    const zip = path.join(root, '导入文件/正式模型资产/cad_cleaner_170700.zip');
    const send = async (op, file = zip, sha = '', requestId = '') => {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'asset.zip');
        if (sha) form.append('inspectedSha256', sha);
        const response = await testFetch(origin + '/api/models/asset-' + op, { method: 'POST', headers: requestId ? { 'X-Asset-Request-ID': requestId } : {}, body: form });
        return { status: response.status, data: await response.json() };
    };
    try {
        await start(); assertEmpty();
        const config = await requestJson(origin + '/api/config');
        assert.equal(config.factories.length, 0); assert.equal(config.models.length, 0); assert.equal(config.workshops.length, 0); assert.equal(config.environmentModel, null);
        assert.deepEqual(await requestJson(origin + '/api/models'), []);
        for (let i = 0; i < 25; i++) assert.deepEqual(await requestJson(origin + '/api/models'), []);
        checks.push('ordinary model reads do not consume the asset-transfer-only rate limit');
        checks.push('fresh boot: all 16 business tables zero; config/models readable without any factory or built-in');
        await forceStop(child); child = null; await start(); assertEmpty();
        checks.push('restart stays empty');
        // Even if a later dev process has no release flag, the persistent marker
        // prevents the database from silently gaining demo data.
        const persistent = new Database(path.join(data, 'factory.db'), { readonly: true });
        assert.equal(persistent.prepare("SELECT value FROM settings WHERE `key`='install_content_policy'").get().value, 'empty-v1'); persistent.close();
        const first = await post('/api/factories', { name: '空系统验收工厂', location: { country: 'CHN' } });
        const factoryId = first.factory.id;
        assert.ok(factoryId); assert.equal(counts().devices, 0); assert.equal(counts().models, 0); assert.equal(counts().widgets, 0);
        const after = await requestJson(origin + '/api/config'); assert.equal(after.factoryId, factoryId);
        checks.push('first factory can be created/selected without seeded workshops, devices, widgets or models');
        const inspection = await send('inspect'); assert.equal(inspection.status, 200); assert.ok(inspection.data.actions.length > 0);
        const invalid = await send('import', zip, '0'.repeat(64)); assert.equal(invalid.status, 400); assert.equal(counts().models, 0);
        const imported = await send('import', zip, inspection.data.inspectedSha256); assert.equal(imported.status, 201, JSON.stringify(imported.data));
        const model = imported.data.model; assert.equal(model.factory_id, factoryId); assert.notEqual(model.id, 'cad_cleaner_170700'); assert.equal(model.is_builtin, false);
        const files = path.join(uploads, model.file_path.slice('/uploads/'.length)); assert.ok(fs.existsSync(files));
        const motion = JSON.parse(fs.readFileSync(path.join(uploads, model.motion_package.clipPath.slice('/uploads/'.length))));
        assert.equal(motion.modelId, model.id); assert.equal(motion.rigSha256, model.motion_package.rigSha256);
        const actionView = await requestJson(origin + '/api/models/' + model.id + '/motion-actions'); assert.equal(actionView.model.motion_package.actions.length, inspection.data.actions.length);
        checks.push('selective model+motion import preserves complete sampling data, hashes and editable node identities; remaps modelId');
        const second = await send('import', zip, inspection.data.inspectedSha256); assert.equal(second.status, 201); assert.notEqual(second.data.model.id, model.id);
        checks.push('repeat import creates independent asset; never overwrites an existing model');
        const requestId = require('node:crypto').randomUUID(), beforeRetry = counts().models;
        const firstAttempt = await send('import', zip, inspection.data.inspectedSha256, requestId);
        const repeatAttempt = await send('import', zip, inspection.data.inspectedSha256, requestId);
        assert.equal(firstAttempt.status, 201); assert.equal(repeatAttempt.status, 201);
        assert.equal(repeatAttempt.data.model.id, firstAttempt.data.model.id); assert.equal(repeatAttempt.data.reused, true);
        assert.equal(counts().models, beforeRetry + 1);
        const otherFile = path.join(root,'导入文件/正式模型资产/cad_fixed_load_table_112200.zip'), otherCheck = await send('inspect',otherFile);
        const collision = await send('import', otherFile, otherCheck.data.inspectedSha256, requestId);
        assert.equal(collision.status,409); assert.equal(counts().models,beforeRetry+1);
        checks.push('retrying a stable batch request is idempotent; changed-file reuse is rejected without creating duplicate models');

        const exported = await testFetch(origin + '/api/models/' + model.id + '/asset-export'); assert.equal(exported.status, 200);
        const exportedFile = path.join(directory, 'roundtrip.zip'); fs.writeFileSync(exportedFile, Buffer.from(await exported.arrayBuffer()));
        const roundtrip = await bundle.inspectAsset(exportedFile); assert.equal(roundtrip.actions.length, inspection.data.actions.length);
        checks.push('re-exported imported asset passes full GLB/motion/hash validation');
        const hall = path.join(root, '导入文件/正式模型资产/factory_hall_lowpoly.zip');
        const hallCheck = await send('inspect', hall), hallImport = await send('import', hall, hallCheck.data.inspectedSha256); assert.equal(hallImport.status, 201, JSON.stringify(hallImport.data));
        const selected = await requestJson(origin + '/api/settings', { method: 'PUT', body: JSON.stringify({ native_environment_config: { environmentModelId: hallImport.data.model.id } }) });
        assert.equal(selected.success, true); assert.equal((await requestJson(origin + '/api/config')).environmentModel.id, hallImport.data.model.id);
        checks.push('imported environment can be selected for Unity from scoped model library');
        const raw = await bundle.readAsset(zip), badEntries = new Map(raw.entries); badEntries.set('../escape.txt', Buffer.from('bad'));
        const bad = path.join(directory, 'traversal.zip'); await bundle.writeZip(bad, badEntries);
        await assert.rejects(bundle.inspectAsset(bad), /数量|路径/);
        const dataMismatch = new Map(raw.entries), manifest = JSON.parse(dataMismatch.get('manifest.json')), changed = JSON.parse(dataMismatch.get('motion.json'));
        changed.modelId = 'another_model'; const bytes = Buffer.from(JSON.stringify(changed)); dataMismatch.set('motion.json', bytes);
        const descriptor = manifest.files.find(f => f.name === 'motion.json'); descriptor.size = bytes.length; descriptor.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        dataMismatch.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
        const mismatch = path.join(directory, 'wrong-model.zip'); await bundle.writeZip(mismatch, dataMismatch);
        await assert.rejects(bundle.inspectAsset(mismatch), /不匹配/);
        checks.push('rejects illegal ZIP paths and motion/model mismatch even with a recomputed file checksum');
        await forceStop(child); child = null; await start();
        assert.equal(counts().factories, 1); assert.equal(counts().models, 4); assert.equal(counts().devices, 0); assert.equal(counts().widgets, 0);
        const loaded = (await requestJson(origin + '/api/models')).find(m => m.id === model.id); assert.ok(loaded.motion_package);
        checks.push('import survives backend restart without default factories/models being reseeded');
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, directory, checks, counts: counts() }, null, 2));
        console.log(JSON.stringify({ success: true, directory, checks }, null, 2));
    } finally { await forceStop(child); }
}
main().catch(error => { fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, checks, error: error.stack }, null, 2)); console.error(error.stack); process.exitCode = 1; });
