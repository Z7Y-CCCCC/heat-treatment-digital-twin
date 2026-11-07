const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const unzipper = require('unzipper');
const { createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, BACKEND_DIR } = require('./integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const single = require('../services/modelAssetBundle'), collection = require('../services/modelAssetCollection');
const Database = require('better-sqlite3');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let server;
(async () => {
    const directory = createRunDirectory('model-asset-collection'), data = path.join(directory, 'data'), uploads = path.join(directory, 'uploads');
    const filename = path.join(data, 'factory.db'); await createTestDatabase(filename);
    const origin = 'http://127.0.0.1:' + await findFreePort();
    server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...process.env, APP_DATA_DIR: data, UPLOADS_DIR: uploads, HOST: '127.0.0.1', PORT: new URL(origin).port }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const get = async url => { const r = await testFetch(origin + url); assert.equal(r.status, 200); return r.json(); };
    const send = async (op, file, sha = '', id = crypto.randomUUID()) => {
        const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)]), 'motions.zip'); if (sha) form.append('inspectedSha256', sha);
        if (op === 'import') {
            const check = await send('inspect', file);
            if (check.status === 200) form.append('importPlan', JSON.stringify(check.data.isCollection ? check.data.models.map(item => item.importDecision) : check.data.importDecision));
        }
        const r = await testFetch(origin + '/api/models/asset-' + op, { method: 'POST', headers: { 'X-Asset-Request-ID': id }, body: form }); return { status: r.status, data: await r.json() };
    };
    const exportZip = ids => testFetch(origin + '/api/models/asset-export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelIds: ids }) });
    const count = () => { const db = new Database(filename, { readonly: true }); try { return db.prepare('SELECT COUNT(*) n FROM models').get().n; } finally { db.close(); } };
    const projectDirs = () => fs.existsSync(path.join(uploads, 'projects')) ? fs.readdirSync(path.join(uploads, 'projects')).sort() : [];
    const ids = ['cad_tempering_furnace_091300', 'cad_water_cooling_tank_471000', 'factory_hall_lowpoly'], checks = [];
    const baseline = await get('/api/models');
    const response = await exportZip(ids); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /motion-packages\.zip/);
    const zipFile = path.join(directory, 'all-models.zip'); fs.writeFileSync(zipFile, Buffer.from(await response.arrayBuffer()));
    const archive = await unzipper.Open.file(zipFile), entries = new Map();
    for (const entry of archive.files) entries.set(entry.path, await single.boundedRead(entry, collection.MAX_EXPANDED));
    const manifest = JSON.parse(entries.get('manifest.json')); assert.equal(manifest.format, collection.FORMAT); assert.deepEqual(manifest.models.map(m => m.id), ids);
    assert.equal(manifest.models.length, 3); assert.ok([...entries.keys()].every(name => !name.endsWith('.zip')), 'no nested ZIPs');
    for (const item of manifest.models) {
        assert.match(item.directory, /^models\/\d{2}-/); assert.ok(entries.has(item.directory + '/model.glb'));
        const original = baseline.find(m => m.id === item.id); assert.equal(hash(entries.get(item.directory + '/model.glb')), hash(fs.readFileSync(path.join(BACKEND_DIR, original.file_path))));
    }
    checks.push('one ZIP contains ordered, named per-model folders, original GLBs, motion files and checksummed manifests');
    const checked = await send('inspect', zipFile); assert.equal(checked.status, 200); assert.equal(checked.data.isCollection, true); assert.equal(checked.data.models.length, 3);
    assert.equal(checked.data.models[0].actions.length, 4); assert.equal(checked.data.models[2].actions.length, 0);
    const before = count(), requestId = crypto.randomUUID(), imported = await send('import', zipFile, checked.data.inspectedSha256, requestId);
    assert.equal(imported.status, 201, JSON.stringify(imported.data)); assert.equal(imported.data.models.length, 3); assert.equal(count(), before, 'identical visible shared models are reused, not copied');
    const folders = projectDirs(), retry = await send('import', zipFile, checked.data.inspectedSha256, requestId);
    assert.equal(retry.status, 201); assert.deepEqual(retry.data.models.map(m => m.id), imported.data.models.map(m => m.id)); assert.equal(count(), before); assert.deepEqual(projectDirs(), folders);
    const otherFile = path.join(directory, 'other-collection.zip'), otherExport = await exportZip(['photo_washing_machine_v7']);
    fs.writeFileSync(otherFile, Buffer.from(await otherExport.arrayBuffer())); const otherCheck = await send('inspect', otherFile);
    assert.equal((await send('import', otherFile, otherCheck.data.inspectedSha256, requestId)).status, 409, 'request ID cannot be reused for a different collection');
    assert.equal(count(), before); assert.deepEqual(projectDirs(), folders);
    for (let index = 0; index < 3; index++) {
        const model = imported.data.models[index], original = baseline.find(m => m.id === ids[index]);
        assert.equal(model.id, original.id); assert.equal(model.name, original.name);
        const metadata = JSON.parse(model.metadata), source = JSON.parse(original.metadata);
        const { normalizeInspection } = require('../../shared/inspectionConfig.cjs');
        assert.deepEqual(normalizeInspection(metadata.inspection), normalizeInspection(source.inspection)); assert.deepEqual(metadata.partBindings, source.partBindings);
        if (model.motion_package) {
            const local = p => p.startsWith('/uploads/') ? path.join(uploads, p.slice('/uploads/'.length)) : path.join(BACKEND_DIR, p);
            const data = JSON.parse(fs.readFileSync(local(model.motion_package.clipPath)));
            assert.equal(data.modelId, model.id); assert.equal(model.motion_package.sourceSha256, hash(fs.readFileSync(local(model.file_path))));
            assert.equal((await get('/api/models/' + model.id + '/motion-actions')).model.motion_package.actions.length, checked.data.models[index].actions.length);
        }
    }
    checks.push('identical visible assets reuse canonical models; CAD layouts, bindings and Unity motion payloads retained; stable and fresh retries do not duplicate');
    for (const invalid of [[], [ids[0], ids[0]], ['private_missing_model'], Array(33).fill(ids[0]), [null]]) assert.equal((await exportZip(invalid)).status, 400);
    const old = path.join(directory, 'legacy-single.zip');
    const oldResponse = await testFetch(origin + '/api/models/' + ids[0] + '/asset-export'); assert.equal(oldResponse.status, 200); fs.writeFileSync(old, Buffer.from(await oldResponse.arrayBuffer()));
    const oldCheck = await send('inspect', old); assert.equal(oldCheck.data.isCollection, false); assert.equal(oldCheck.data.actions.length, 4);
    assert.equal((await send('import', old, oldCheck.data.inspectedSha256)).status, 201);
    checks.push('legacy single-model export/import remains compatible; bad/duplicate/oversized selections rejected');
    const unchangedCount = count(), unchangedFolders = projectDirs();
    async function rejectArchive(name, changed) {
        const file = path.join(directory, name + '.zip'); await single.writeZip(file, changed);
        assert.equal((await send('inspect', file)).status, 400, name);
        assert.equal((await send('import', file, await single.fileSha(file))).status, 400, name + ' direct import');
        assert.equal(count(), unchangedCount); assert.deepEqual(projectDirs(), unchangedFolders);
    }
    const traversal = new Map(entries); traversal.set('../escape.glb', Buffer.from('bad')); await rejectArchive('traversal', traversal);
    await rejectArchive('duplicate', [...entries, ['manifest.json', entries.get('manifest.json')]]);
    const corrupt = new Map(entries); corrupt.set(manifest.models[1].directory + '/model.glb', Buffer.from('wrong GLB')); await rejectArchive('tampered-last-model', corrupt);
    const badDirectory = new Map(entries), invalidManifest = structuredClone(manifest); invalidManifest.models[0].directory = '../escape'; badDirectory.set('manifest.json', Buffer.from(JSON.stringify(invalidManifest))); await rejectArchive('invalid-folder', badDirectory);
    const countBomb = fs.readFileSync(zipFile); countBomb.writeUInt16LE(65535, countBomb.length - 22 + 10); const bombFile = path.join(directory, 'count-bomb.zip'); fs.writeFileSync(bombFile, countBomb); assert.equal((await send('inspect', bombFile)).status, 400);
    checks.push('traversal, duplicate entries, broken child hash, spoofed directories and excessive ZIP directory rejected before writes');
    // The final recipe passes transport inspection but fails executable recipe
    // validation after earlier models have been staged/inserted in the transaction.
    const rollback = new Map(entries), rootManifest = structuredClone(manifest), last = rootManifest.models[1];
    const child = JSON.parse(rollback.get(last.directory + '/manifest.json'));
    child.model.metadata.motionAuthoring = { version: 1, actions: [{ id: 'invalid_recipe' }] };
    const bytes = Buffer.from(JSON.stringify(child)); rollback.set(last.directory + '/manifest.json', bytes); last.manifestSha256 = hash(bytes);
    rollback.set('manifest.json', Buffer.from(JSON.stringify(rootManifest)));
    const rollbackFile = path.join(directory, 'rollback.zip'); await single.writeZip(rollbackFile, rollback);
    const rollbackCheck = await send('inspect', rollbackFile); assert.equal(rollbackCheck.status, 200);
    const rejected = await send('import', rollbackFile, rollbackCheck.data.inspectedSha256); assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.equal(count(), unchangedCount); assert.deepEqual(projectDirs(), unchangedFolders, 'all newly staged files must be cleaned after rollback');
    // Also stage a genuinely different first model, then fail on the next one.
    // This retains coverage of rollback-owned files, not just reused assets.
    const stagedRollback = new Map(rollback), stagedRoot = structuredClone(rootManifest), first = stagedRoot.models[0];
    const firstChild = JSON.parse(stagedRollback.get(first.directory + '/manifest.json'));
    firstChild.model.metadata.rollbackProbe = true;
    const firstBytes = Buffer.from(JSON.stringify(firstChild)); stagedRollback.set(first.directory + '/manifest.json', firstBytes); first.manifestSha256 = hash(firstBytes);
    stagedRollback.set('manifest.json', Buffer.from(JSON.stringify(stagedRoot)));
    const stagedFile = path.join(directory, 'staged-rollback.zip'); await single.writeZip(stagedFile, stagedRollback);
    const stagedCheck = await send('inspect', stagedFile); assert.equal(stagedCheck.status, 200);
    assert.equal((await send('import', stagedFile, stagedCheck.data.inspectedSha256)).status, 400);
    assert.equal(count(), unchangedCount); assert.deepEqual(projectDirs(), unchangedFolders);
    const forbidden = await collection.inspectPackage(zipFile);
    assert.equal(forbidden.models.length, 3);
    checks.push('late recipe failure rolls back every model and cleans only newly created owned files');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2)); console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stopOwnedSmokeProcess(server); });
