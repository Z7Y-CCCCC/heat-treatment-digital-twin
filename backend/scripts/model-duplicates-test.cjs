'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, BACKEND_DIR } = require('./integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const authoring = require('../services/motionAuthoring'), single = require('../services/modelAssetBundle');
const { stringifyModelMetadata } = require('../services/modelAssetMetadata');
const { RECEIPT_KEY, RECEIPT_LIMIT } = require('../services/modelDuplicates');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const glb = marker => authoring.encodeGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'FixtureRoot' }], extras: { marker } }, []);
let server;
(async () => {
    const directory = createRunDirectory('model-duplicates'), data = path.join(directory, 'data'), uploads = path.join(directory, 'uploads');
    const filename = path.join(data, 'factory.db'); await createTestDatabase(filename);
    fs.mkdirSync(path.join(uploads, 'models'), { recursive: true });
    const database = new Database(filename);
    const factoryId = database.prepare('SELECT id FROM factories ORDER BY sort_order, created_at LIMIT 1').get().id;
    database.prepare('INSERT INTO factories (id, name) VALUES (?, ?)').run('duplicate-test-other-factory', 'Other private factory');
    const otherReceipt = JSON.stringify([{ token: 'foreign-sentinel', packageSha256: '0'.repeat(64), modelId: 'foreign-private' }]);
    database.prepare('INSERT INTO factory_settings (factory_id, `key`, value) VALUES (?, ?, ?)').run('duplicate-test-other-factory', RECEIPT_KEY, otherReceipt);
    function seed(id, bytes, factory = factoryId, metadata = {}) {
        fs.writeFileSync(path.join(uploads, 'models', id + '.glb'), bytes);
        database.prepare('INSERT INTO models (id,name,file_path,factory_id,asset_type,placement_level,default_scale,tags,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(id, id, '/uploads/models/' + id + '.glb', factory, 'model', 'device', 1, '[]', stringifyModelMetadata(metadata, { name: id }));
    }
    const ports = { version: 1, inlet: { position: [0, 1, 0], direction: [0, 0, 1], nodeName: 'FixtureRoot' }, outlet: null };
    const sharedBytes = glb('shared'); seed('shared-canonical', sharedBytes, null, { loadingPorts: ports });
    const foreignBytes = glb('foreign'); seed('foreign-private', foreignBytes, 'duplicate-test-other-factory');
    database.close();
    const origin = 'http://127.0.0.1:' + await findFreePort();
    server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: data, UPLOADS_DIR: uploads, HOST: '127.0.0.1', PORT: new URL(origin).port }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const upload = async (bytes, fields = {}) => {
        const form = new FormData(); form.append('modelFile', new Blob([bytes]), 'fixture.glb');
        for (const [key, value] of Object.entries({ id: 'm_' + crypto.randomBytes(12).toString('hex'), name: 'Fixture ' + crypto.randomBytes(3).toString('hex'), tags: '[]', ...fields })) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        const response = await testFetch(origin + '/api/models/upload', { method: 'POST', body: form });
        return { status: response.status, data: await response.json() };
    };
    const count = () => { const db = new Database(filename, { readonly: true }); try { return db.prepare('SELECT COUNT(*) n FROM models').get().n; } finally { db.close(); } };
    const files = () => fs.readdirSync(path.join(uploads, 'models')).sort();
    const checks = [], raw = glb('raw');
    const first = await upload(raw); assert.equal(first.status, 200); assert.equal(first.data.reused, false);
    const beforeRaw = count(), beforeFiles = files();
    const repeated = await upload(raw); assert.equal(repeated.status, 200); assert.equal(repeated.data.reused, true); assert.equal(repeated.data.modelId, first.data.modelId);
    assert.equal(count(), beforeRaw); assert.deepEqual(files(), beforeFiles, 'only the newly uploaded duplicate is removed');
    for (const fields of [{ default_scale: 2 }, { placement_level: 'line' }, { metadata: { customBehavior: { enabled: true } } }]) {
        const result = await upload(raw, fields); assert.equal(result.status, 200); assert.equal(result.data.reused, false); assert.notEqual(result.data.modelId, first.data.modelId);
    }
    checks.push('raw uploads reuse identical content across fresh IDs/names; scale, placement and extension behavior remain distinct');
    const shared = await upload(sharedBytes); assert.equal(shared.status, 200); assert.equal(shared.data.modelId, 'shared-canonical'); assert.equal(shared.data.reused, true);
    assert.deepEqual(JSON.parse(shared.data.model.metadata).loadingPorts, ports, 'omitted optional ports retain richer shared defaults');
    const explicitEmpty = await upload(sharedBytes, { metadata: { loadingPorts: { version: 1, inlet: null, outlet: null } } });
    assert.equal(explicitEmpty.status, 200); assert.equal(explicitEmpty.data.reused, false);
    const customPorts = structuredClone(ports); customPorts.inlet.position[1] = 3;
    const portVariant = await upload(sharedBytes, { metadata: { loadingPorts: customPorts } }); assert.equal(portVariant.data.reused, false);
    const foreign = await upload(foreignBytes); assert.equal(foreign.status, 200); assert.equal(foreign.data.reused, false); assert.notEqual(foreign.data.modelId, 'foreign-private');
    checks.push('shared-visible canonical models allowed; foreign private assets excluded; explicit empty/custom ports preserved');
    async function packageFile(label, source, options = {}) {
        const id = 'fixture_package', model = { id, name: 'Package fixture', asset_type: 'model', placement_level: 'device', default_scale: 1, tags: [], metadata: options.metadata || {} };
        const entries = new Map([['model.glb', source]]);
        if (options.motion) {
            const rig = options.rig || source;
            const clip = { schemaVersion: 1, modelId: id, sourceSha256: sha(source), rigSha256: sha(rig), nodes: [{ name: 'FixtureRoot', p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], v: [1] }],
                clips: [{ id: 'move', label: 'Move', mode: 'position', duration: options.duration || 1, count: 2, tracks: [{ node: 'FixtureRoot', channel: 'p', size: 3, values: [0, 0, 0, options.end || 1, 0, 0] }] }] };
            entries.set('motion.glb', rig); entries.set('motion.json', Buffer.from(JSON.stringify(clip)));
        }
        entries.set('manifest.json', Buffer.from(JSON.stringify({ format: single.FORMAT, version: 1, model, files: [...entries].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) })) })));
        const file = path.join(directory, label + '.zip'); await single.writeZip(file, entries); return file;
    }
    async function inspectZip(file) {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'fixture.zip');
        const response = await testFetch(origin + '/api/models/asset-inspect', { method: 'POST', body: form });
        return { status: response.status, data: await response.json() };
    }
    async function importZip(file, requestId = crypto.randomUUID(), confirm = true) {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'fixture.zip'); form.append('inspectedSha256', await single.fileSha(file));
        if (confirm) { const inspected = await inspectZip(file); if (inspected.status === 200) form.append('importPlan', JSON.stringify(inspected.data.importDecision)); }
        const response = await testFetch(origin + '/api/models/asset-import', { method: 'POST', headers: { 'X-Asset-Request-ID': requestId }, body: form });
        return { status: response.status, data: await response.json() };
    }
    const movingBytes = glb('moving'), motionFile = await packageFile('motion', movingBytes, { motion: true });
    const requestId = crypto.randomUUID(), moving = await importZip(motionFile, requestId); assert.equal(moving.status, 201, JSON.stringify(moving.data)); assert.equal(moving.data.reused, undefined);
    const beforeMotion = count(), again = await importZip(motionFile); assert.equal(again.status, 201); assert.equal(again.data.reused, true); assert.equal(again.data.model.id, moving.data.model.id); assert.equal(count(), beforeMotion);
    assert.equal((await importZip(motionFile, requestId)).data.model.id, moving.data.model.id);
    const reuseId = crypto.randomUUID(); assert.equal((await importZip(motionFile, reuseId)).data.reused, true);
    const changedClip = await packageFile('changed-clip', movingBytes, { motion: true, end: 2 });
    assert.equal((await importZip(changedClip, requestId)).status, 409, 'same request/different package remains a conflict');
    assert.equal((await importZip(changedClip, crypto.randomUUID(), false)).status, 409, 'older clients cannot implicitly overwrite actions');
    const changedCheck = await inspectZip(changedClip); assert.equal(changedCheck.data.importDecision.kind, 'update_actions');
    const updatedClip = await importZip(changedClip); assert.equal(updatedClip.status, 201, JSON.stringify(updatedClip.data));
    assert.equal(updatedClip.data.outcome, 'update_actions'); assert.equal(updatedClip.data.model.id, moving.data.model.id); assert.equal(count(), beforeMotion);
    const updatedFolder = path.dirname(path.join(uploads, updatedClip.data.model.motion_package.rigPath.slice('/uploads/'.length)));
    assert.deepEqual(fs.readdirSync(updatedFolder).sort(), ['motion.glb', 'motion.json'], 'updates do not duplicate model.glb');
    assert.equal((await importZip(changedClip)).data.outcome, 'reuse');
    const replay = await importZip(motionFile, reuseId); assert.equal(replay.data.replayed, true);
    const currentClip = JSON.parse(fs.readFileSync(path.join(uploads, replay.data.model.motion_package.clipPath.slice('/uploads/'.length))));
    assert.equal(currentClip.clips[0].tracks[0].values[3], 2, 'receipt replay returns the current target without reapplying old clips');
    const recipe = { id: 'user_fixture', label: 'Recipe fixture', mode: 'position', duration: 1, cycle: 'forward', tracks: [{ nodeId: '0', operation: 'translate', axis: 'x', from: 0, to: 2, start: 0, end: 1, easing: 'linear', pivot: [0, 0, 0] }] };
    for (const file of [await packageFile('changed-rig', movingBytes, { motion: true, rig: glb('different-rig') }), await packageFile('changed-recipe', movingBytes, { motion: true, metadata: { motionAuthoring: { version: 1, actions: [recipe], authoringExtension: 'kept', bundle: { bundleExtension: 'kept' } } } })]) {
        const variant = await importZip(file); assert.equal(variant.status, 201, JSON.stringify(variant.data)); assert.notEqual(variant.data.model.id, moving.data.model.id); assert.notEqual(variant.data.reused, true);
        const repeatedVariant = await importZip(file); assert.equal(repeatedVariant.status, 201, JSON.stringify(repeatedVariant.data)); assert.equal(repeatedVariant.data.model.id, variant.data.model.id); assert.equal(repeatedVariant.data.reused, true);
        if (file.endsWith('changed-recipe.zip')) {
            const metadata = JSON.parse(variant.data.model.metadata);
            assert.deepEqual(metadata.motionAuthoring.actions, [recipe]); assert.equal(metadata.motionAuthoring.authoringExtension, 'kept'); assert.equal(metadata.motionAuthoring.bundle.bundleExtension, 'kept');
        }
    }
    // A reused canonical ID needs a receipt too, not just deterministic asset_* IDs.
    assert.equal((await importZip(changedClip, reuseId)).status, 409);
    checks.push('fresh ZIPs reuse validated assets; confirmed same-rig clip updates retain model ID; changed rig/non-action extensions remain variants; canonical receipts never reapply old actions');
    const concurrentBytes = glb('concurrent'), concurrentFile = await packageFile('concurrent', concurrentBytes), beforeConcurrent = count();
    const concurrent = await Promise.all([upload(concurrentBytes), importZip(concurrentFile), upload(concurrentBytes), importZip(concurrentFile)]);
    for (const result of concurrent) assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.data));
    assert.equal(new Set(concurrent.map(result => result.data.modelId || result.data.model.id)).size, 1);
    assert.equal(count(), beforeConcurrent + 1, 'raw and ZIP imports share a pre-transaction gate');
    const db = new Database(filename, { readonly: true });
    try {
        const receipts = db.prepare('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?').get(factoryId, RECEIPT_KEY);
        assert.ok(JSON.parse(receipts.value).length <= RECEIPT_LIMIT);
        assert.equal(db.prepare('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?').get('duplicate-test-other-factory', RECEIPT_KEY).value, otherReceipt);
    } finally { db.close(); }
    checks.push('concurrent raw/ZIP attempts create one model; import receipts are bounded and factory-scoped');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2));
    console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stopOwnedSmokeProcess(server); });
