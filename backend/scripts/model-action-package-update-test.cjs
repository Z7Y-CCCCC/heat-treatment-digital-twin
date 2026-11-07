'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, BACKEND_DIR } = require('./integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const authoring = require('../services/motionAuthoring'), single = require('../services/modelAssetBundle'), collection = require('../services/modelAssetCollection');
const { normalizeModelMetadata } = require('../services/modelAssetMetadata');
const { saveActionUpdate } = require('../services/modelAssetImportPlan');
const WebSocket = require('ws');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const glb = marker => authoring.encodeGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'FixtureRoot' }], extras: { marker } }, []);
const binding = (id, output = 4, key = '推料到位') => ({ id, name: id, node_name: 'FixtureRoot', source_group: 'status', source_key: key,
    action: 'translate', axis: 'x', input_min: 0, input_max: 1, output_min: 0, output_max: output });
let server, socket;
(async () => {
    const directory = createRunDirectory('model-action-package-update'), data = path.join(directory, 'data'), uploads = path.join(directory, 'uploads');
    const filename = path.join(data, 'factory.db'); await createTestDatabase(filename);
    const database = new Database(filename), factoryId = database.prepare('SELECT id FROM factories ORDER BY sort_order, created_at LIMIT 1').get().id;
    database.close();
    const origin = 'http://127.0.0.1:' + await findFreePort();
    server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: data, UPLOADS_DIR: uploads,
        HOST: '127.0.0.1', PORT: new URL(origin).port }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const events = [];
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    socket.on('message', bytes => events.push(JSON.parse(String(bytes))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
    const awaitEvent = async predicate => {
        for (let i = 0; i < 100; i++) { const event = events.find(predicate); if (event) return event; await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.fail('expected committed update event was not received');
    };
    const local = url => path.join(uploads, url.slice('/uploads/'.length));
    const useDb = operation => { const db = new Database(filename); try { return operation(db); } finally { db.close(); } };
    const count = () => useDb(db => db.prepare('SELECT COUNT(*) count FROM models').get().count);
    const current = id => useDb(db => db.prepare('SELECT * FROM models WHERE id = ?').get(id));
    const folders = () => fs.existsSync(path.join(uploads, 'projects')) ? fs.readdirSync(path.join(uploads, 'projects')).sort() : [];
    const request = async (op, file, check = null, requestId = crypto.randomUUID(), confirm = true) => {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'fixture.zip');
        if (op === 'import') { form.append('inspectedSha256', await single.fileSha(file)); if (confirm && check) form.append('importPlan', JSON.stringify(check.isCollection ? check.models.map(item => item.importDecision) : check.importDecision)); }
        const response = await testFetch(origin + '/api/models/asset-' + op, { method: 'POST', headers: { 'X-Asset-Request-ID': requestId }, body: form });
        return { status: response.status, data: await response.json() };
    };
    const inspect = async file => { const r = await request('inspect', file); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
    const source = glb('actions'), sourceId = 'source_fixture';
    const metadata = normalizeModelMetadata({ assetSpec: { device_family: 'stable-family' }, partBindings: [binding('推料')],
        loadingPorts: { version: 1, inlet: { position: [0, 1, 0], direction: [0, 0, 1], nodeName: 'FixtureRoot' }, outlet: null },
        inspection: { version: 2, offset_space: 'model', enabled: true, parts: [{ id: 'inspection-part', name: '拆解部件', node_names: ['FixtureRoot'], offset: [3, 0, 0] }] },
        runtime: { enableGenericBindings: true, importantFlag: 'retain' }, independentExtension: { keep: true } }, { name: '动作包设备' });
    function entries(id, config, bytes = source, motionEnd = null) {
        const files = new Map([['model.glb', bytes]]);
        if (motionEnd != null) {
            const clip = { schemaVersion: 1, modelId: id, sourceSha256: sha(bytes), rigSha256: sha(bytes), nodes: [{ name: 'FixtureRoot', p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], v: [1] }],
                clips: [{ id: 'move', label: 'Move', mode: 'position', duration: 1, count: 2, tracks: [{ node: 'FixtureRoot', channel: 'p', size: 3, values: [0, 0, 0, motionEnd, 0, 0] }] }] };
            files.set('motion.glb', bytes); files.set('motion.json', Buffer.from(JSON.stringify(clip)));
        }
        const model = { id, name: '动作包设备', asset_type: 'model', placement_level: 'device', default_scale: 1, tags: ['fixture'], metadata: config };
        files.set('manifest.json', Buffer.from(JSON.stringify({ format: single.FORMAT, version: 1, model,
            files: [...files].map(([name, content]) => ({ name, size: content.length, sha256: sha(content) })) })));
        return files;
    }
    const pack = async (name, bindings, motionEnd = null, changes = {}) => {
        const file = path.join(directory, name + '.zip'); await single.writeZip(file, entries(sourceId, { ...metadata, partBindings: bindings, ...changes }, source, motionEnd)); return file;
    };
    const firstFile = await pack('initial', metadata.partBindings, 1), firstCheck = await inspect(firstFile);
    assert.equal(firstCheck.importDecision.kind, 'create');
    const firstRequestId = crypto.randomUUID(), first = await request('import', firstFile, firstCheck, firstRequestId);
    assert.equal(first.status, 201, JSON.stringify(first.data)); const id = first.data.model.id, initialCount = count();
    assert.equal(JSON.parse(first.data.model.metadata).assetImport.sourceModelId, sourceId);
    const repeatedReceiptId = crypto.randomUUID(), firstRepeat = await request('import', firstFile, await inspect(firstFile), repeatedReceiptId);
    assert.equal(firstRepeat.data.outcome, 'reuse');
    useDb(db => {
        db.prepare('UPDATE models SET name = ? WHERE id = ?').run('本机模型名不要覆盖', id);
        const raw = JSON.parse(db.prepare('SELECT metadata FROM models WHERE id = ?').get(id).metadata);
        for (const [key, extension] of [['acceptance', 'customAcceptance'], ['release', 'customRelease'], ['optimization', 'customOptimization'], ['inspection', 'customInspection']]) {
            raw[key][extension] = { preserve: true };
            metadata[key][extension] = { preserve: true };
        }
        raw.inspection.parts[0].customPart = 'retain'; metadata.inspection.parts[0].customPart = 'retain';
        // Raw historical field omission must not be filled by action updates.
        delete raw.acceptance.checked_at;
        db.prepare('UPDATE models SET metadata = ? WHERE id = ?').run(JSON.stringify(raw), id);
        const device = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 1').get();
        db.prepare('UPDATE devices SET model_type = ?, instance_config = ? WHERE id = ?').run(id, JSON.stringify({ instanceMarker: 'retain' }), device.id);
    });
    const unchanged = current(id), protectedMetadata = JSON.parse(unchanged.metadata);
    const snapshot = () => useDb(db => ({ devices: db.prepare('SELECT * FROM devices ORDER BY id').all(), points: db.prepare('SELECT * FROM data_points ORDER BY id').all(),
        settings: db.prepare("SELECT * FROM factory_settings WHERE `key` LIKE '%animation%' ORDER BY factory_id, `key`").all() }));
    const initialLinks = snapshot(), checks = [];
    for (const [name, bindings] of [['add', [binding('推料'), binding('退回', 2, '退回到位')]], ['modify', [binding('推料', 6), binding('退回', 2, '退回到位')]], ['delete', []]]) {
        const file = await pack(name, bindings), check = await inspect(file), beforeFolders = folders();
        assert.equal(check.importDecision.kind, 'update_actions'); assert.equal(check.importDecision.targetId, id);
        const denied = await request('import', file, check, crypto.randomUUID(), false); assert.equal(denied.status, 409); assert.equal(denied.data.code, 'IMPORT_CONFIRMATION_REQUIRED');
        assert.deepEqual(folders(), beforeFolders);
        const updated = await request('import', file, check); assert.equal(updated.status, 201, JSON.stringify(updated.data)); assert.equal(updated.data.outcome, 'update_actions');
        assert.equal(updated.data.model.id, id); assert.equal(count(), initialCount); assert.deepEqual(folders(), beforeFolders, 'binding-only updates do not write new model or action assets');
        const record = current(id), actual = JSON.parse(record.metadata);
        assert.deepEqual(actual.partBindings, normalizeModelMetadata({ partBindings: bindings }).partBindings);
        for (const key of ['name', 'factory_id', 'file_path', 'default_scale', 'placement_level', 'asset_type', 'tags', 'thumbnail']) assert.equal(record[key], unchanged[key], key);
        for (const key of ['loadingPorts', 'inspection', 'assetSpec', 'acceptance', 'release', 'independentExtension', 'motionAuthoring']) assert.deepEqual(actual[key], protectedMetadata[key], key);
        assert.equal(actual.runtime.importantFlag, 'retain'); assert.deepEqual(snapshot(), initialLinks);
        const again = await request('import', file, await inspect(file)); assert.equal(again.data.outcome, 'reuse'); assert.equal(again.data.model.id, id); assert.equal(count(), initialCount);
    }
    checks.push('partBindings add/modify/delete require confirmation and retain original ID, model fields, ports, authored inspection, compiled assets, device instance, PLC points and linkage settings');
    // Replace compiled clip samples without copying source geometry; old receipts
    // must return this current model rather than rolling it back to initial clips.
    const clipFile = await pack('clip-update', [], 4), clipCheck = await inspect(clipFile), beforeClipFolders = folders();
    const clipUpdate = await request('import', clipFile, clipCheck); assert.equal(clipUpdate.status, 201, JSON.stringify(clipUpdate.data));
    assert.equal(clipUpdate.data.outcome, 'update_actions'); assert.equal(clipUpdate.data.model.id, id); assert.equal(count(), initialCount);
    const rigFolder = path.dirname(local(clipUpdate.data.model.motion_package.rigPath));
    assert.deepEqual(fs.readdirSync(rigFolder).sort(), ['motion.glb', 'motion.json']); assert.equal(folders().length, beforeClipFolders.length + 1);
    assert.equal(JSON.parse(fs.readFileSync(local(clipUpdate.data.model.motion_package.clipPath))).modelId, id);
    const replay = await request('import', firstFile, firstCheck, repeatedReceiptId); assert.equal(replay.data.replayed, true);
    assert.deepEqual(replay.data.model.metadata, current(id).metadata); assert.equal(JSON.parse(replay.data.model.metadata).partBindings.length, 0);
    const retry = await request('import', firstFile, firstCheck, firstRequestId); assert.equal(retry.data.replayed, true); assert.equal(retry.data.model.motion_package.clipPath, clipUpdate.data.model.motion_package.clipPath);
    assert.equal((await request('import', clipFile, await inspect(clipFile))).data.outcome, 'reuse');
    await awaitEvent(event => event.type === 'model_metadata_changed' && event.payload.modelId === id);
    checks.push('same-rig compiled clips update in-place with only motion files; canonical and created-target request receipts never replay old actions');
    // Exporting the imported ID includes its provenance; fresh imports must still
    // fingerprint as identical and must not grow the model list or uploaded files.
    const exported = await testFetch(origin + '/api/models/' + id + '/asset-export'); assert.equal(exported.status, 200);
    const exportedFile = path.join(directory, 're-export.zip'); fs.writeFileSync(exportedFile, Buffer.from(await exported.arrayBuffer()));
    const exportCheck = await inspect(exportedFile); assert.equal(exportCheck.importDecision.kind, 'reuse');
    assert.equal((await request('import', exportedFile, exportCheck)).data.model.id, id); assert.equal(count(), initialCount);
    const extensionEntries = new Map((await single.readAsset(exportedFile)).entries), extensionManifest = JSON.parse(extensionEntries.get('manifest.json'));
    extensionManifest.model.metadata.inspection.customInspection = { different: true };
    extensionEntries.set('manifest.json', Buffer.from(JSON.stringify(extensionManifest)));
    const extensionFile = path.join(directory, 'compiled-independent-extension.zip'); await single.writeZip(extensionFile, extensionEntries);
    assert.equal((await inspect(extensionFile)).importDecision.kind, 'create', 'full compiled fingerprint must retain unknown independent extensions too');
    checks.push('exported import provenance does not break full-content deduplication');
    // A changed editor revision invalidates the preview, before file creation.
    const staleFile = await pack('stale', [binding('新动作')], 5), staleCheck = await inspect(staleFile), beforeStaleFolders = folders();
    const beforeStale = current(id), concurrentMetadata = JSON.parse(beforeStale.metadata); concurrentMetadata.independentExtension.concurrent = true;
    useDb(db => db.prepare('UPDATE models SET metadata = ? WHERE id = ?').run(JSON.stringify(concurrentMetadata), id));
    const stale = await request('import', staleFile, staleCheck); assert.equal(stale.status, 409); assert.equal(stale.data.code, 'IMPORT_PLAN_STALE');
    assert.deepEqual(folders(), beforeStaleFolders); assert.deepEqual(JSON.parse(current(id).metadata), concurrentMetadata);
    // Exercise the actual SQL CAS independently of transport re-inspection.
    const casDb = new Database(filename);
    try {
        const tx = { run: async (sql, values) => casDb.prepare(sql).run(values) };
        await assert.rejects(() => saveActionUpdate(tx, beforeStale, beforeStale, JSON.stringify(protectedMetadata), factoryId, 'sqlite'), error => error.statusCode === 409);
    } finally { casDb.close(); }
    useDb(db => db.prepare('UPDATE models SET metadata = ? WHERE id = ?').run(beforeStale.metadata, id));
    for (const [column, value] of [['factory_id', null], ['thumbnail', '/uploads/models/changed-thumbnail.png']]) {
        const original = current(id), raceDb = new Database(filename);
        try {
            raceDb.prepare(`UPDATE models SET ${column} = ? WHERE id = ?`).run(value, id);
            const tx = { run: async (sql, values) => raceDb.prepare(sql).run(values) };
            await assert.rejects(() => saveActionUpdate(tx, original, original, original.metadata, factoryId, 'sqlite'), error => error.statusCode === 409, column);
            raceDb.prepare(`UPDATE models SET ${column} = ? WHERE id = ?`).run(original[column], id);
        } finally { raceDb.close(); }
    }
    checks.push('stale preview and actual SQL CAS reject concurrent edits without leaving action files');
    // A confirmed early update followed by a bad final recipe must restore old
    // metadata and remove both the updated action folder and staged new model.
    const bad = entries('bad_recipe_model', { motionAuthoring: { version: 1, actions: [{ id: 'invalid_recipe' }] } }, glb('bad-recipe'));
    const rootManifest = { format: collection.FORMAT, version: 1, models: [] }, collectionEntries = new Map();
    for (const [index, [modelId, files]] of [[sourceId, entries(sourceId, { ...metadata, partBindings: [binding('回滚动作')] }, source, 8)], ['bad_recipe_model', bad]].entries()) {
        const child = JSON.parse(files.get('manifest.json')), folder = `models/0${index + 1}-Fixture`;
        rootManifest.models.push({ directory: folder, id: modelId, name: child.model.name, manifestSha256: sha(files.get('manifest.json')) });
        for (const [name, content] of files) collectionEntries.set(folder + '/' + name, content);
    }
    collectionEntries.set('manifest.json', Buffer.from(JSON.stringify(rootManifest)));
    const collectionFile = path.join(directory, 'rollback.zip'); await single.writeZip(collectionFile, collectionEntries);
    const collectionCheck = await inspect(collectionFile); assert.equal(collectionCheck.models[0].importDecision.kind, 'update_actions');
    const rollbackBefore = current(id), rollbackFolders = folders();
    await new Promise(resolve => setTimeout(resolve, 100)); const eventOffset = events.length;
    const rejected = await request('import', collectionFile, collectionCheck);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.data)); assert.deepEqual(current(id), rollbackBefore); assert.equal(count(), initialCount); assert.deepEqual(folders(), rollbackFolders);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(events.slice(eventOffset).filter(event => event.type === 'model_metadata_changed' || event.type === 'configuration_changed' && event.payload.resource === 'models').length, 0, 'rolled-back imports never broadcast action updates');
    checks.push('late collection recipe failure rolls back in-place updates and cleans every owned action/new-model directory');
    // Geometry, independent configuration and explicit empty ports remain distinct.
    for (const [name, changes] of [['ports', { loadingPorts: { version: 1, inlet: null, outlet: null } }], ['independent', { independentExtension: { different: true } }],
        ['inspection-extension', { inspection: { ...metadata.inspection, customInspection: 'different' } }]]) {
        const file = await pack('different-' + name, [], null, changes), check = await inspect(file); assert.equal(check.importDecision.kind, 'create', name);
    }
    const otherFile = path.join(directory, 'different-geometry.zip'); await single.writeZip(otherFile, entries(sourceId, metadata, glb('different-source')));
    assert.equal((await inspect(otherFile)).importDecision.kind, 'create');
    for (const [name, changes] of [['scale', { default_scale: 2 }], ['placement', { placement_level: 'line' }]]) {
        const files = entries(sourceId, { ...metadata, partBindings: [] }), manifest = JSON.parse(files.get('manifest.json'));
        Object.assign(manifest.model, changes); files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
        const file = path.join(directory, name + '.zip'); await single.writeZip(file, files); assert.equal((await inspect(file)).importDecision.kind, 'create');
    }
    checks.push('different GLB and explicit independent/port settings are not silently merged');
    const seed = (modelId, bytes, factory, bindings = [binding('旧动作')]) => {
        fs.mkdirSync(path.join(uploads, 'models'), { recursive: true }); fs.writeFileSync(path.join(uploads, 'models', modelId + '.glb'), bytes);
        useDb(db => db.prepare('INSERT INTO models (id,name,file_path,factory_id,asset_type,placement_level,default_scale,tags,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(modelId, '动作包设备', '/uploads/models/' + modelId + '.glb', factory, 'model', 'device', 1, '["fixture"]', JSON.stringify({ ...metadata, partBindings: bindings })));
    };
    const sharedId = 'shared_actions_fixture', sharedBytes = glb('shared-actions'); seed(sharedId, sharedBytes, null);
    const sharedFile = path.join(directory, 'shared-update.zip'); await single.writeZip(sharedFile, entries(sharedId, { ...metadata, partBindings: [binding('新共享动作')] }, sharedBytes));
    const sharedCheck = await inspect(sharedFile); assert.equal(sharedCheck.importDecision.kind, 'update_actions'); assert.equal(sharedCheck.importDecision.shared, true);
    const shared = await request('import', sharedFile, sharedCheck); assert.equal(shared.status, 201, JSON.stringify(shared.data)); assert.equal(shared.data.model.id, sharedId); assert.equal(shared.data.model.factory_id, null);
    await awaitEvent(event => event.type === 'model_metadata_changed' && event.payload.modelId === sharedId);
    await awaitEvent(event => event.type === 'configuration_changed' && event.payload.resource === 'models' && !event.payload.factoryId);
    assert.deepEqual(snapshot(), initialLinks);
    checks.push('shared update plan declares reference scope and success invalidates Unity plus already-open screens across factories');
    const ambiguousBytes = glb('ambiguous-actions'); seed('legacy_candidate_a', ambiguousBytes, factoryId); seed('legacy_candidate_b', ambiguousBytes, factoryId);
    const ambiguousFile = path.join(directory, 'ambiguous.zip'); await single.writeZip(ambiguousFile, entries('no_matching_lineage', { ...metadata, partBindings: [binding('不同动作')] }, ambiguousBytes));
    const ambiguous = await request('inspect', ambiguousFile); assert.equal(ambiguous.status, 409); assert.equal(ambiguous.data.code, 'IMPORT_TARGET_AMBIGUOUS');
    const exactFile = path.join(directory, 'exact-id.zip'); await single.writeZip(exactFile, entries('legacy_candidate_b', { ...metadata, partBindings: [binding('不同动作')] }, ambiguousBytes));
    assert.equal((await inspect(exactFile)).importDecision.targetId, 'legacy_candidate_b', 'source ID wins among compatible legacy candidates');
    const foreignFactory = 'foreign_action_factory'; useDb(db => db.prepare('INSERT INTO factories (id,name) VALUES (?,?)').run(foreignFactory, 'Other factory'));
    const foreignBytes = glb('foreign-actions'); seed('foreign_action_model', foreignBytes, foreignFactory);
    const foreignFile = path.join(directory, 'foreign.zip'); await single.writeZip(foreignFile, entries('foreign_action_model', { ...metadata, partBindings: [binding('新动作')] }, foreignBytes));
    assert.equal((await inspect(foreignFile)).importDecision.kind, 'create');
    checks.push('ambiguous legacy targets are rejected, exact source IDs preferred, and foreign private models excluded');
    const repeatedSource = glb('repeated-inside-collection'), repeatedEntries = new Map(), repeatedManifest = { format: collection.FORMAT, version: 1, models: [] };
    for (let index = 0; index < 2; index++) {
        const modelId = 'repeated_' + index, files = entries(modelId, {}, repeatedSource), folder = `models/0${index + 1}-Same`;
        repeatedManifest.models.push({ directory: folder, id: modelId, name: '动作包设备', manifestSha256: sha(files.get('manifest.json')) });
        for (const [name, content] of files) repeatedEntries.set(folder + '/' + name, content);
    }
    repeatedEntries.set('manifest.json', Buffer.from(JSON.stringify(repeatedManifest)));
    const repeatedFile = path.join(directory, 'same-model-twice.zip'); await single.writeZip(repeatedFile, repeatedEntries);
    const repeatedCheck = await inspect(repeatedFile); assert.equal(repeatedCheck.models[0].importDecision.kind, 'create'); assert.equal(repeatedCheck.models[1].importDecision.kind, 'reuse');
    assert.equal(repeatedCheck.models[1].importDecision.fromPackage, 0);
    const repeatedCount = count(), repeatedPackage = await request('import', repeatedFile, repeatedCheck);
    assert.equal(repeatedPackage.status, 201, JSON.stringify(repeatedPackage.data)); assert.equal(new Set(repeatedPackage.data.models.map(model => model.id)).size, 1); assert.equal(count(), repeatedCount + 1);
    checks.push('identical models repeated inside one collection reuse the earlier item instead of a stale-create conflict or duplicate row');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2));
    console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { socket?.terminate(); await stopOwnedSmokeProcess(server); });
