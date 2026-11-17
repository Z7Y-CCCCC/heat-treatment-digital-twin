'use strict';
// Owned databases/profile/files only; never reads or alters an installation.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, startLoggedProcess, waitForOwnedBackend, BACKEND_DIR } = require('./integration-test-utils.cjs');
const { createAssets, visibleGlb, writePackage } = require('../../tools/model-asset-workspace-fixtures.cjs');
const single = require('../services/modelAssetBundle');
const authoring = require('../services/motionAuthoring');
let server, db;
(async () => {
    const sandbox = await createSmokeSandbox('model-asset-updates'), directory = sandbox.directory, fixtures = await createAssets(path.join(directory, 'fixtures'));
    db = new Database(sandbox.filename); const factoryId = db.prepare('SELECT id FROM factories ORDER BY sort_order,created_at LIMIT 1').get().id;
    const origin = 'http://127.0.0.1:' + await findFreePort(), headers = { 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN, 'X-Factory-ID': factoryId, Origin: origin, 'X-Admin-Request': '1' };
    server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env, HOST: '127.0.0.1', PORT: new URL(origin).port }, logFile: path.join(directory, 'backend.log') });
    await waitForOwnedBackend(origin, server);
    const request = async (url, method = 'GET', body) => {
        const r = await fetch(origin + '/api/models' + url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, data: await r.json() };
    };
    const upload = async (operation, file, options, checked, requestId = crypto.randomUUID(), authHeaders = headers) => {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'asset.zip');
        if (options) form.append('updateOptions', JSON.stringify(options));
        if (checked) { form.append('inspectedSha256', checked.inspectedSha256); form.append(options ? 'updatePlan' : 'importPlan', JSON.stringify(options ? checked.updatePlan : checked.importDecision)); }
        const r = await fetch(origin + '/api/models/asset-' + operation, { method: 'POST', headers: { ...authHeaders, 'X-Asset-Request-ID': requestId }, body: form });
        return { status: r.status, data: await r.json() };
    };
    const checked = await upload('inspect', fixtures.complete); assert.equal(checked.status, 200);
    const complete = await upload('import', fixtures.complete, null, checked.data); assert.equal(complete.status, 201, JSON.stringify(complete.data));
    const target = complete.data.model, targetId = target.id, originalMetadata = JSON.parse(target.metadata), records = db.prepare('SELECT COUNT(*) n FROM models').get().n;
    const deviceId = db.prepare('SELECT id FROM devices LIMIT 1').get().id;
    db.prepare('UPDATE devices SET model_type=? WHERE id=?').run(targetId, deviceId);
    const deviceBefore = db.prepare('SELECT * FROM devices ORDER BY id').all(), checks = [];
    const options = { targetId, modules: ['actions'], actionIds: ['fan'] }, firstId = crypto.randomUUID();
    const fanCheck = await upload('inspect', fixtures.fan, options); assert.equal(fanCheck.status, 200, JSON.stringify(fanCheck.data));
    assert.equal(fanCheck.data.updatePlan.actions.find(row => row.id === 'fan').kind, 'add'); assert.equal(fanCheck.data.updatePlan.affectedDeviceCount, 1);
    const fan = await upload('import', fixtures.fan, options, fanCheck.data, firstId); assert.equal(fan.status, 201, JSON.stringify(fan.data));
    const afterFan = JSON.parse(fan.data.model.metadata); assert.deepEqual(afterFan.partBindings.map(row => row.id), ['door', 'fan']);
    assert.deepEqual(afterFan.inspection, originalMetadata.inspection); assert.deepEqual(afterFan.loadingPorts, originalMetadata.loadingPorts); assert.deepEqual(afterFan.preserveFixture, originalMetadata.preserveFixture);
    const local = url => path.join(sandbox.uploadsDir, url.slice('/uploads/'.length));
    const motionData = model => JSON.parse(fs.readFileSync(local(model.motion_package.clipPath)));
    assert.deepEqual(motionData(fan.data.model).clips.map(row => row.id), ['door', 'fan']); assert.equal(db.prepare('SELECT COUNT(*) n FROM models').get().n, records);
    checks.push('one complete import installs geometry/layout/motion; fan supplement merges stable IDs without duplicating models or losing door/layout/ports');
    const layoutOptions = { targetId, modules: ['inspection'] }, layoutCheck = await upload('inspect', fixtures.layout, layoutOptions);
    assert.equal(layoutCheck.status, 200, JSON.stringify(layoutCheck.data)); assert.equal(layoutCheck.data.updatePlan.inspectionChanged, true);
    const layout = await upload('import', fixtures.layout, layoutOptions, layoutCheck.data); assert.equal(layout.status, 201, JSON.stringify(layout.data));
    assert.deepEqual(layout.data.model.motion_package, fan.data.model.motion_package, 'layout update must not relocate/recompile or drop any action');
    assert.equal(JSON.parse(layout.data.model.metadata).inspection.parts.find(row => row.id === 'door-part').explode_offset[0], -2.4);
    const history = await request('/' + targetId + '/asset-history'); assert.equal(history.status, 200); assert.equal(history.data.versions.length, 2);
    assert.deepEqual(history.data.versions[0].modules, ['inspection']); assert.equal(history.data.versions[0].snapshotPath, undefined);
    assert.equal((await request('/' + targetId + '/asset-history/' + history.data.versions[0].id + '/restore', 'POST', { revision: 'stale' })).status, 409);
    const restored = await request('/' + targetId + '/asset-history/' + history.data.versions[0].id + '/restore', 'POST', { revision: history.data.revision }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(JSON.parse(restored.data.model.metadata).inspection, originalMetadata.inspection); assert.deepEqual(motionData(restored.data.model).clips.map(row => row.id), ['door', 'fan']);
    checks.push('inspection-only update preserves compiled descriptors, and version restore uses revision confirmation while preserving later fan actions');
    const replaceOptions = { targetId, modules: ['actions'], actionIds: ['door'] }, conflict = await upload('inspect', fixtures.replaceDoor, replaceOptions);
    assert.equal(conflict.status, 200); assert.deepEqual(conflict.data.updatePlan.conflicts, ['door']); assert.equal(conflict.data.updatePlan.canImport, false);
    assert.equal((await upload('import', fixtures.replaceDoor, replaceOptions, conflict.data)).status, 409);
    replaceOptions.replaceActionIds = ['door']; const replaceCheck = await upload('inspect', fixtures.replaceDoor, replaceOptions); assert.equal(replaceCheck.status, 200);
    const replaced = await upload('import', fixtures.replaceDoor, replaceOptions, replaceCheck.data); assert.equal(replaced.status, 201, JSON.stringify(replaced.data));
    assert.equal(motionData(replaced.data.model).clips.find(row => row.id === 'door').tracks[0].values[7], 1.8); assert.ok(motionData(replaced.data.model).clips.some(row => row.id === 'fan'));
    const replay = await upload('import', fixtures.fan, options, fanCheck.data, firstId); assert.equal(replay.status, 201); assert.equal(replay.data.replayed, true);
    assert.equal(motionData(replay.data.model).clips.find(row => row.id === 'door').tracks[0].values[7], 1.8, 'receipt replay returns current target, never reapplies old payload');
    const changingCheck = await upload('inspect', fixtures.layout, layoutOptions), beforeStale = db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata;
    const changedMetadata = JSON.parse(beforeStale); changedMetadata.preserveFixture.concurrent = true; db.prepare('UPDATE models SET metadata=? WHERE id=?').run(JSON.stringify(changedMetadata), targetId);
    assert.equal((await upload('import', fixtures.layout, layoutOptions, changingCheck.data)).status, 409);
    checks.push('same-ID replacement requires explicit recheck, omitted IDs survive, receipt replay is idempotent, concurrent edits reject stale confirmation');
    const different = await writePackage(path.join(directory, 'different-source.zip'), visibleGlb('different'), { partBindings: [] });
    assert.equal((await upload('inspect', different, options)).status, 409);
    db.prepare('INSERT INTO factories (id,name) VALUES (?,?)').run('asset-private-other', 'Isolated foreign factory');
    db.prepare('INSERT INTO models (id,name,file_path,factory_id,asset_type,placement_level,default_scale,tags,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run('foreign_asset', 'foreign', target.file_path, 'asset-private-other', 'model', 'device', 1, '[]', target.metadata);
    assert.equal((await upload('inspect', fixtures.fan, { ...options, targetId: 'foreign_asset' })).status, 404);
    const exported = await fetch(origin + '/api/models/asset-export', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ modelIds: [targetId], modules: ['actions'], actionIds: ['fan'] }) });
    assert.equal(exported.status, 200); const exportFile = path.join(directory, 'fan-only-export.zip'); fs.writeFileSync(exportFile, Buffer.from(await exported.arrayBuffer()));
    const exportedAsset = await single.readAsset(exportFile); assert.deepEqual(exportedAsset.data.clips.map(row => row.id), ['fan']); assert.deepEqual(exportedAsset.manifest.model.metadata.partBindings.map(row => row.id), ['fan']);
    assert.equal(exportedAsset.manifest.model.metadata.inspection, undefined); assert.equal(exportedAsset.manifest.model.metadata.loadingPorts, undefined); assert.equal(exportedAsset.manifest.model.metadata.assetVersionHistory, undefined);
    const partialCheck = await upload('inspect', exportFile); assert.equal(partialCheck.status, 200); assert.ok(partialCheck.data.supplement);
    assert.equal((await upload('import', exportFile, null, partialCheck.data)).status, 400, 'partial packages require an explicit existing target');
    const badSelection = await fetch(origin + '/api/models/asset-export', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ modelIds: [targetId], modules: ['inspection'], actionIds: ['fan'] }) }); assert.equal(badSelection.status, 400);
    const current = (await request('/')).data.find(model => model.id === targetId), currentMetadata = JSON.parse(current.metadata);
    const newSource = visibleGlb('compatible-new-geometry-version'), geometryFile = await writePackage(path.join(directory, 'compatible-model-update.zip'), newSource,
        { partBindings: currentMetadata.partBindings }, [{ id: 'door', label: '开门', node: 'Door', end: 1.8 }, { id: 'fan', label: '风机', node: 'Fan' }]);
    assert.equal((await upload('inspect', geometryFile, { targetId, modules: ['model'] })).status, 400, 'model replacement cannot strand current clips on a changed source');
    const geometryOptions = { targetId, modules: ['model', 'actions'], actionIds: ['door', 'fan'], replaceActionIds: ['door', 'fan'] };
    const geometryCheck = await upload('inspect', geometryFile, geometryOptions); assert.equal(geometryCheck.status, 200, JSON.stringify(geometryCheck.data)); assert.equal(geometryCheck.data.updatePlan.sourceMatches, false);
    const geometry = await upload('import', geometryFile, geometryOptions, geometryCheck.data); assert.equal(geometry.status, 201, JSON.stringify(geometry.data));
    assert.notEqual(geometry.data.model.file_path, current.file_path); assert.deepEqual(JSON.parse(geometry.data.model.metadata).loadingPorts, originalMetadata.loadingPorts);
    const geometryHistory = await request('/' + targetId + '/asset-history'); assert.ok(geometryHistory.data.versions[0].modules.includes('model'));
    const geometryRestore = await request('/' + targetId + '/asset-history/' + geometryHistory.data.versions[0].id + '/restore', 'POST', { revision: geometryHistory.data.revision }); assert.equal(geometryRestore.status, 200, JSON.stringify(geometryRestore.data));
    assert.equal(motionData(geometryRestore.data.model).sourceSha256, fixtures.sourceSha256); assert.deepEqual(motionData(geometryRestore.data.model).clips.map(row => row.id), ['door', 'fan']);
    assert.equal(JSON.parse(geometryRestore.data.model.metadata).preserveFixture.concurrent, true, 'rollback restores selected assets, not unrelated later configuration');
    const completeExport = await fetch(origin + '/api/models/' + targetId + '/asset-export', { headers }); assert.equal(completeExport.status, 200);
    const completeExportFile = path.join(directory, 'complete-after-history.zip'); fs.writeFileSync(completeExportFile, Buffer.from(await completeExport.arrayBuffer()));
    const historyReimport = await upload('inspect', completeExportFile); assert.equal(historyReimport.status, 200, JSON.stringify(historyReimport.data)); assert.equal(historyReimport.data.importDecision.kind, 'reuse', 'installation-private version history cannot force a duplicate model on complete reimport');
    checks.push('explicit compatible geometry replacement retains model ID/instance bindings, requires matching motion assets, and has an immutable version rollback');
    const partialBefore = JSON.parse(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata);
    partialBefore.inspection.parts[0].point_ids = ['fixture_point_link']; partialBefore.inspection.parts[0].duration = 2.4; partialBefore.inspection.parts[0].delay = .3;
    partialBefore.inspection.parts[1].fixtureExtension = { keep: true }; partialBefore.inspection.exploded.camera.yaw = 31;
    db.prepare('UPDATE models SET metadata=? WHERE id=?').run(JSON.stringify(partialBefore), targetId);
    async function partialLayoutFile(name, inspection) {
        const asset = await single.readAsset(fixtures.complete), manifest = asset.manifest; asset.entries.delete('motion.glb'); asset.entries.delete('motion.json');
        manifest.model.metadata = { inspection }; manifest.files = [...asset.entries].filter(([name]) => name !== 'manifest.json').map(([name, bytes]) => ({ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
        asset.entries.set('manifest.json', Buffer.from(JSON.stringify(manifest))); const file = path.join(directory, name + '.zip'); await single.writeZip(file, asset.entries); return file;
    }
    const onePart = await partialLayoutFile('one-part-layout', { parts: [{ id: 'door-part', explode_offset: [-3.6, 0, 0] }] });
    const onePartCheck = await upload('inspect', onePart, layoutOptions); assert.equal(onePartCheck.status, 200, JSON.stringify(onePartCheck.data));
    const onePartUpdated = await upload('import', onePart, layoutOptions, onePartCheck.data); assert.equal(onePartUpdated.status, 201, JSON.stringify(onePartUpdated.data));
    const partialAfter = JSON.parse(onePartUpdated.data.model.metadata), expected = structuredClone(partialBefore.inspection); expected.parts[0].explode_offset = [-3.6, 0, 0];
    assert.deepEqual(partialAfter.inspection, expected, 'raw single-part patch must preserve peer, timing, camera, point links and arbitrary extension fields');
    const emptyParts = await partialLayoutFile('empty-parts-does-not-delete', { parts: [] }); const emptyPartsCheck = await upload('inspect', emptyParts, layoutOptions);
    assert.equal(emptyPartsCheck.status, 200); assert.equal(emptyPartsCheck.data.updatePlan.changes, false); assert.equal((await upload('import', emptyParts, layoutOptions, emptyPartsCheck.data)).data.outcome, 'reuse');
    const invalidOffset = await partialLayoutFile('invalid-offset', { parts: [{ id: 'door-part', explode_offset: [null, 0, 0] }] }); assert.equal((await upload('inspect', invalidOffset, layoutOptions)).status, 400);
    checks.push('raw one-part layout patches merge stable IDs before normalization, preserving peers/timing/camera/point links; parts[] never deletes and invalid offsets reject');
    const browserHeaders = { Origin: origin, 'X-Admin-Request': '1', 'X-Factory-ID': factoryId }, password = 'Asset-' + crypto.randomBytes(16).toString('hex') + '!';
    const browser = async (route, body, auth = {}) => {
        const response = await fetch(origin + '/api' + route, { method: 'POST', headers: { ...browserHeaders, ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json(); return { status: response.status, data, response };
    };
    const owner = await browser('/admin-auth/setup', { password }); assert.equal(owner.status, 200, JSON.stringify(owner.data));
    const credentials = { Cookie: owner.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), 'X-CSRF-Token': owner.data.csrfToken };
    const scopedCredentials = {};
    for (const [username, grant] of [['models_editor', { models: { view: true, edit: true } }], ['layout_editor', { 'disassembly-layout': { view: true, edit: true } }]]) {
        assert.equal((await browser('/admin-auth/users', { username, password, role: 'viewer', permissions: { view: false }, pagePermissions: grant }, credentials)).status, 201);
        const login = await browser('/admin-auth/login', { username, password }); assert.equal(login.status, 200);
        const auth = { ...browserHeaders, Cookie: login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), 'X-CSRF-Token': login.data.csrfToken };
        scopedCredentials[username] = auth;
        const beforeDenied = db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata;
        if (username === 'models_editor') {
            const trustedPlan = await upload('inspect', fixtures.layout, layoutOptions); assert.equal(trustedPlan.status, 200);
            assert.equal((await upload('inspect', fixtures.layout, layoutOptions, null, crypto.randomUUID(), auth)).status, 403, 'model-only editor cannot select the layout module');
            assert.equal((await upload('import', fixtures.layout, layoutOptions, trustedPlan.data, crypto.randomUUID(), auth)).status, 403);
            const historyNow = await request('/' + targetId + '/asset-history'), layoutVersion = historyNow.data.versions.find(entry => entry.modules.length === 1 && entry.modules[0] === 'inspection');
            assert.equal((await browser('/models/' + targetId + '/asset-history/' + layoutVersion.id + '/restore', { revision: historyNow.data.revision }, auth)).status, 403, 'restore checks the trusted snapshot modules, not just model edit permission');
            const noCsrf = { ...auth }; delete noCsrf['X-CSRF-Token'];
            assert.equal((await upload('import', fixtures.complete, null, historyReimport.data, crypto.randomUUID(), noCsrf)).status, 403);
        } else assert.equal((await upload('import', fixtures.complete, null, checked.data, crypto.randomUUID(), auth)).status, 403, 'layout-only editor cannot introduce models via whole import');
        assert.equal(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata, beforeDenied, 'every denied mutation preserves exact existing model metadata');
    }
    checks.push('real restricted sessions cannot bypass module permissions, whole-model import restrictions, trusted restore scopes or CSRF; denied requests write nothing');
    const historyBeforeTamper = await request('/' + targetId + '/asset-history'), privateHistory = JSON.parse(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata).assetVersionHistory;
    const privateEntry = privateHistory.at(-1), snapshotFile = local(privateEntry.snapshotPath), originalSnapshot = fs.readFileSync(snapshotFile), modelBeforeTamper = db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata;
    try {
        fs.writeFileSync(snapshotFile, Buffer.from('{}'));
        const tampered = await request('/' + targetId + '/asset-history/' + privateEntry.id + '/restore', 'POST', { revision: historyBeforeTamper.data.revision });
        assert.equal(tampered.status, 409); assert.equal(tampered.data.code, 'ASSET_HISTORY_CHANGED');
        assert.equal(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata, modelBeforeTamper);
    } finally { fs.writeFileSync(snapshotFile, originalSnapshot); }
    checks.push('tampered immutable history is rejected by its stored SHA without metadata writes or new rollback artifacts');
    const plainFile = await writePackage(path.join(directory, 'referenced-without-motion.zip'), visibleGlb(), { inspection: originalMetadata.inspection, disassemblyLayout: { version: 1, configured: true }, loadingPorts: originalMetadata.loadingPorts });
    const plainCheck = await upload('inspect', plainFile); assert.equal(plainCheck.status, 200); const plain = await upload('import', plainFile, null, plainCheck.data); assert.equal(plain.status, 201);
    const parsedSource = authoring.glb(visibleGlb()); parsedSource.document.nodes[1].name = 'RenamedDoor';
    const incompatibleFile = await writePackage(path.join(directory, 'incompatible-node-replacement.zip'), authoring.encodeGlb(parsedSource.document, parsedSource.chunks), {});
    const incompatible = await upload('inspect', incompatibleFile, { targetId: plain.data.model.id, modules: ['model'] });
    assert.equal(incompatible.status, 400); assert.equal(incompatible.data.code, 'ASSET_NODE_INCOMPATIBLE');
    assert.equal(db.prepare('SELECT metadata FROM models WHERE id=?').get(plain.data.model.id).metadata, plain.data.model.metadata);
    checks.push('model replacement rejects missing existing layout/port node references before writes, even on a model without motion assets');
    // Model-local loading ports form their own portable, reversible module.
    const portsOptions = { targetId, modules: ['ports'] };
    const ports = { version: 1, inlet: { position: [-.6, 0, .2], direction: [0, 0, 1], nodeName: 'Door',
        region: { version: 1, corners: [[-.9,0,.2],[-.3,0,.2],[-.3,.6,.2],[-.9,.6,.2]], surfaceNormal: [0,0,1], nodeName: 'Door' } },
        outlet: { position: [.6, 0, -.2], direction: [0, 0, -1], nodeName: 'Fan' } };
    const portsFile = await writePackage(path.join(directory, 'ports-only-input.zip'), visibleGlb(), { loadingPorts: ports });
    const portsBefore = JSON.parse(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata);
    const portsCheck = await upload('inspect', portsFile, portsOptions); assert.equal(portsCheck.status, 200, JSON.stringify(portsCheck.data));
    assert.equal(portsCheck.data.contentCapabilities.ports, true); assert.equal(portsCheck.data.updatePlan.portsChanged, true);
    assert.equal((await upload('import', portsFile, portsOptions, portsCheck.data, crypto.randomUUID(), scopedCredentials.layout_editor)).status, 403);
    const portsSaved = await upload('import', portsFile, portsOptions, portsCheck.data, crypto.randomUUID(), scopedCredentials.models_editor);
    assert.equal(portsSaved.status, 201, JSON.stringify(portsSaved.data)); assert.deepEqual(portsSaved.data.updatedModules, ['ports']);
    const withPorts = JSON.parse(portsSaved.data.model.metadata);
    assert.deepEqual(withPorts.loadingPorts, ports);
    for (const key of ['inspection','disassemblyLayout','partBindings','motionAuthoring','preserveFixture']) assert.deepEqual(withPorts[key], portsBefore[key]);
    const { resolveLoadingPort } = require('../../shared/loadingPorts.cjs');
    for (const id of ['fresh-device-a','fresh-device-b']) assert.deepEqual(resolveLoadingPort(portsSaved.data.model, { id, instance_config: {} }, 'inlet').position, ports.inlet.position);
    const customRegion = { ...ports.inlet.region, corners: ports.inlet.region.corners.map(p => [p[0]+2,p[1],p[2]]) };
    assert.deepEqual(resolveLoadingPort(portsSaved.data.model, { instance_config: { loadingPortOverrides: { version: 1, inlet: { offset:[0,0,0],yawDegrees:0,region:customRegion },outlet:null } } }, 'inlet').position, [1.4,0,.2]);
    const portsExport = await fetch(origin+'/api/models/asset-export', { method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({modelIds:[targetId],modules:['ports']}) });
    assert.equal(portsExport.status,200); const portsExportFile=path.join(directory,'ports-only-export.zip');fs.writeFileSync(portsExportFile,Buffer.from(await portsExport.arrayBuffer()));
    const portablePorts=await single.readAsset(portsExportFile);
    assert.deepEqual(Object.keys(portablePorts.manifest.model.metadata).sort(),['assetSupplement','loadingPorts']);
    assert.deepEqual(portablePorts.manifest.model.metadata.loadingPorts,ports);assert.equal(portablePorts.entries.has('motion.glb'),false);
    const autoPreview=await upload('inspect',portsExportFile);assert.deepEqual(autoPreview.data.supplement.modules,['ports']);
    assert.equal((await upload('import',portsExportFile,null,autoPreview.data)).status,400,'ports supplement needs an explicit existing target');
    const absentPorts=await upload('inspect',fixtures.fan,portsOptions);assert.equal(absentPorts.status,400);assert.equal(absentPorts.data.code,'ASSET_MODULE_MISSING');
    const notPorts=await upload('inspect',fixtures.layout,layoutOptions);assert.equal(notPorts.status,200);assert.equal(notPorts.data.updatePlan.portsChanged,false);
    const portsHistory=await request('/'+targetId+'/asset-history');assert.deepEqual(portsHistory.data.versions[0].modules,['ports']);
    const portsRestored=await request('/'+targetId+'/asset-history/'+portsHistory.data.versions[0].id+'/restore','POST',{revision:portsHistory.data.revision});
    assert.equal(portsRestored.status,200,JSON.stringify(portsRestored.data));assert.deepEqual(JSON.parse(portsRestored.data.model.metadata).loadingPorts,portsBefore.loadingPorts);
    const emptyPorts={version:1,inlet:null,outlet:null};
    const clearFile=await writePackage(path.join(directory,'explicit-empty-ports.zip'),visibleGlb(),{loadingPorts:emptyPorts});
    const clearCheck=await upload('inspect',clearFile,portsOptions);assert.equal(clearCheck.status,200);
    const cleared=await upload('import',clearFile,portsOptions,clearCheck.data);assert.equal(cleared.status,201);assert.deepEqual(JSON.parse(cleared.data.model.metadata).loadingPorts,emptyPorts);
    const clearHistory=await request('/'+targetId+'/asset-history');const undoClear=await request('/'+targetId+'/asset-history/'+clearHistory.data.versions[0].id+'/restore','POST',{revision:clearHistory.data.revision});
    assert.equal(undoClear.status,200);assert.deepEqual(JSON.parse(undoClear.data.model.metadata).loadingPorts,portsBefore.loadingPorts);
    // Restoring a previously unconfigured model must restore omission, not
    // manufacture defaults or delete any other independently saved module.
    const unconfiguredSource=visibleGlb('ports-absent-original'),unconfiguredFile=await writePackage(path.join(directory,'no-port-original.zip'),unconfiguredSource,{});
    const noPortCheck=await upload('inspect',unconfiguredFile),noPort=await upload('import',unconfiguredFile,null,noPortCheck.data);assert.equal(noPort.status,201);
    const noPortOptions={targetId:noPort.data.model.id,modules:['ports']},newPortFile=await writePackage(path.join(directory,'first-port-setup.zip'),unconfiguredSource,{loadingPorts:ports});
    const firstPortCheck=await upload('inspect',newPortFile,noPortOptions);assert.equal(firstPortCheck.status,200);assert.equal((await upload('import',newPortFile,noPortOptions,firstPortCheck.data)).status,201);
    const noPortHistory=await request('/'+noPort.data.model.id+'/asset-history');
    const undoFirst=await request('/'+noPort.data.model.id+'/asset-history/'+noPortHistory.data.versions[0].id+'/restore','POST',{revision:noPortHistory.data.revision});assert.equal(undoFirst.status,200);
    assert.equal(Object.hasOwn(JSON.parse(undoFirst.data.model.metadata),'loadingPorts'),false);
    const absentExport=await fetch(origin+'/api/models/asset-export',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({modelIds:[noPort.data.model.id],modules:['ports']})});assert.equal(absentExport.status,400);
    const baseAsset=await single.readAsset(portsFile);
    for(const value of [null,{version:1,inlet:{...ports.inlet,direction:[0,1,0]},outlet:null},{...ports,inlet:{...ports.inlet,pointId:'site-point'}},{...ports,inlet:{...ports.inlet,region:{...ports.inlet.region,nodeName:'MissingNode'}}}]){
        const invalid=structuredClone(baseAsset.manifest);invalid.model.metadata={loadingPorts:value};baseAsset.entries.set('manifest.json',Buffer.from(JSON.stringify(invalid)));
        const file=path.join(directory,'bad-ports-'+crypto.randomUUID()+'.zip');await single.writeZip(file,baseAsset.entries);
        const before=db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata;
        assert.equal((await upload('inspect',file,portsOptions)).status,400);assert.equal(db.prepare('SELECT metadata FROM models WHERE id=?').get(targetId).metadata,before);
    }
    checks.push('ports-only package carries root-local positions/directions/regions, updates with model permission, restores independently, preserves all peer modules and device overrides, and rejects absent/invalid/site-bound or missing-node data');
    assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(), deviceBefore);
    checks.push('source mismatch/private target/invalid export scopes rejected; partial export includes only selected assets and requires explicit target; all device/PLC records unchanged');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2)); console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { db?.close(); await stopOwnedSmokeProcess(server); });
