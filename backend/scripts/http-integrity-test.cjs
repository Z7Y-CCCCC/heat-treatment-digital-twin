const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const Database = require('better-sqlite3');
const {
    BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort,
    forceStop, requestJson, startLoggedProcess, testFetch, waitForHttp, waitUntil
} = require('./integration-test-utils.cjs');

function glb(document = { asset: { version: '2.0' }, scenes: [{}], scene: 0 }) {
    const json = Buffer.from(JSON.stringify(document));
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
    json.copy(padded);
    const result = Buffer.alloc(20 + padded.length);
    result.write('glTF');
    result.writeUInt32LE(2, 4);
    result.writeUInt32LE(result.length, 8);
    result.writeUInt32LE(padded.length, 12);
    result.writeUInt32LE(0x4e4f534a, 16);
    padded.copy(result, 20);
    return result;
}

async function main() {
    const directory = createRunDirectory('http-integrity');
    const dataDir = path.join(directory, 'data');
    const databaseFile = path.join(dataDir, 'factory.db');
    const uploads = path.join(directory, 'uploads');
    const models = path.join(uploads, 'models');
    const results = [];
    let backend;
    let blockedConnection;
    const stalledSockets = new Set();
    await createTestDatabase(databaseFile);
    fs.mkdirSync(models, { recursive: true });
    const valid = glb();
    const seed = new Database(databaseFile);
    const recentEventTime = new Date(Date.now() - 30 * 60000).toISOString().slice(0, 19);
    const oldEventTime = new Date(Date.now() - 2 * 3600000).toISOString().slice(0, 19);
    for (const [title, value] of [['recent UTC fixture', recentEventTime], ['old UTC fixture', oldEventTime]]) {
        seed.prepare('INSERT INTO event_logs (event_type, title, occurred_at) VALUES (?, ?, ?)').run('audit_time', title, value.replace('T', ' '));
    }
    for (const [id, filename] of [['blocked-model', 'blocked.glb'], ['shared-one', 'shared.glb'], ['shared-two', 'shared.glb']]) {
        fs.writeFileSync(path.join(models, filename), valid);
        seed.prepare('INSERT INTO models (id, name, file_path) VALUES (?, ?, ?)').run(id, id, `/uploads/models/${filename}`);
    }
    seed.exec("CREATE TRIGGER audit_model_delete_failure BEFORE DELETE ON models WHEN OLD.id = 'blocked-model' BEGIN SELECT RAISE(ABORT, 'audit deletion denied'); END");
    seed.prepare('INSERT INTO models (id, name, file_path) VALUES (?, ?, ?)').run('interrupted-delete', 'interrupted-delete', '/uploads/models/interrupted.glb');
    fs.writeFileSync(path.join(models, 'interrupted.glb.pending-delete-0123456789abcdef'), valid);
    fs.writeFileSync(path.join(models, 'committed.glb.pending-delete-0123456789abcdef'), valid);
    seed.close();
    const port = await findFreePort(3941);
    const origin = `http://127.0.0.1:${port}`;
    async function check(name, action) {
        try { await action(); results.push({ name, passed: true }); }
        catch (error) { results.push({ name, passed: false, error: error.stack || error.message }); }
    }
    async function upload(bytes, filename, fields = {}) {
        const form = new FormData();
        form.append('modelFile', new Blob([bytes]), filename);
        for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
        return testFetch(`${origin}/api/models/upload`, { method: 'POST', body: form });
    }
    const put = (url, body) => testFetch(`${origin}${url}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    try {
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: dataDir, UPLOADS_DIR: uploads, PORT: String(port), HOST: '127.0.0.1', DB_BACKUP_RETENTION: '1', TZ: 'Asia/Hong_Kong' },
            logFile: path.join(directory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`);
        await requestJson(`${origin}/api/settings`);

        await check('SQLite events expose UTC explicitly and a one-hour filter uses UTC storage time', async () => {
            const rows = await requestJson(`${origin}/api/platform/events?event_type=audit_time&window_hours=1`);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].title, 'recent UTC fixture');
            assert.equal(Date.parse(rows[0].occurred_at), Date.parse(`${recentEventTime}Z`));
            assert.ok(rows[0].occurred_at.endsWith('Z'));
        });

        await check('the first dashboard config recovers interrupted model deletion before returning assets', async () => {
            await requestJson(`${origin}/api/config`);
            assert.deepEqual(fs.readFileSync(path.join(models, 'interrupted.glb')), valid);
            assert.equal((await testFetch(`${origin}/uploads/models/interrupted.glb`)).status, 200);
            assert.equal(fs.existsSync(path.join(models, 'interrupted.glb.pending-delete-0123456789abcdef')), false);
            assert.equal(fs.existsSync(path.join(models, 'committed.glb.pending-delete-0123456789abcdef')), false);
        });

        await check('a header-only GLB is rejected and the upload is removed', async () => {
            const bytes = Buffer.alloc(12);
            bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8);
            const before = fs.readdirSync(models).sort();
            const response = await upload(bytes, 'header-only.glb');
            assert.equal(response.status, 400);
            assert.deepEqual(fs.readdirSync(models).sort(), before);
        });
        await check('a truncated chunk and unsupported asset version are rejected', async () => {
            const bytes = glb();
            bytes.writeUInt32LE(bytes.length, 12);
            assert.equal((await upload(bytes, 'broken.glb')).status, 400);
            assert.equal((await upload(glb({ asset: { version: '20' } }), 'wrong-version.glb')).status, 400);
        });
        await check('single-file GLTF cannot silently reference missing external resources', async () => {
            assert.equal((await upload(Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'missing.bin' }] })), 'external.gltf')).status, 400);
            for (const uri of ['data:application/octet-stream;base64,%%%%', 'data:application/octet-stream;base64,AA==']) {
                assert.equal((await upload(Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri }] })), 'invalid-data.gltf')).status, 400);
            }
        });
        await check('valid GLB and embedded GLTF remain supported', async () => {
            assert.equal((await upload(valid, 'valid.glb', { id: 'valid-upload' })).status, 200);
            assert.equal((await upload(Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }] })), 'embedded.gltf')).status, 200);
        });
        await check('zero, negative and null model scales cannot hide or corrupt a model', async () => {
            for (const value of [0, -1, null]) assert.equal((await put('/api/models/valid-upload', { default_scale: value })).status, 400);
            assert.equal((await put('/api/models/valid-upload', { default_scale: 1.5 })).status, 200);
        });
        await check('database deletion failure keeps the original model file', async () => {
            const response = await testFetch(`${origin}/api/models/blocked-model`, { method: 'DELETE' });
            assert.equal(response.status, 400);
            assert.deepEqual(fs.readFileSync(path.join(models, 'blocked.glb')), valid);
            assert.equal(fs.readdirSync(models).some(name => name.includes('.pending-delete-')), false);
            assert.ok((await requestJson(`${origin}/api/models`)).find(model => model.id === 'blocked-model'));
        });
        await check('deleting one model does not delete a file shared by another model', async () => {
            const response = await testFetch(`${origin}/api/models/shared-one`, { method: 'DELETE' });
            assert.equal(response.status, 200);
            assert.deepEqual(fs.readFileSync(path.join(models, 'shared.glb')), valid);
        });
        await check('malformed settings bodies never echo supplied secrets', async () => {
            const secret = 'audit-secret-must-not-appear-in-errors';
            const response = await testFetch(`${origin}/api/database/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: `{"password":"${secret}` });
            assert.equal(response.status, 400);
            assert.equal((await response.text()).includes(secret), false);
        });
        await check('a failed connection preflight preserves persisted configuration and service', async () => {
            const before = fs.readFileSync(path.join(dataDir, 'database-config.json'), 'utf8');
            assert.equal((await put('/api/database/config', { type: 'invalid-database' })).status, 400);
            assert.equal(fs.readFileSync(path.join(dataDir, 'database-config.json'), 'utf8'), before);
            assert.ok((await requestJson(`${origin}/api/settings`)).factory_name);
        });
        await check('schema initialization failure rolls back the database switch', async () => {
            const incompatible = path.join(directory, 'incompatible.db');
            const broken = new Database(incompatible);
            broken.exec('CREATE TABLE settings (wrong_column TEXT)');
            broken.close();
            const response = await put('/api/database/config', { type: 'sqlite', filename: incompatible });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).rolledBack, true);
            assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'database-config.json'), 'utf8')).filename, databaseFile);
            assert.ok((await requestJson(`${origin}/api/settings`)).factory_name);
            assert.equal((await requestJson(`${origin}/api/engine/status`)).mode, 'simulation');
        });
        await check('overlapping database maintenance is rejected before changing configuration', async () => {
            // A loopback socket with no DB greeting makes preflight deterministic;
            // no real database, external IP, or production credentials are used.
            const boundary = 'audit_slow_model_upload';
            const beforeUploads = new Set(fs.readdirSync(models));
            const uploadAbort = new AbortController();
            let uploadController;
            const body = new ReadableStream({ start(controller) {
                uploadController = controller;
                controller.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="modelFile"; filename="slow.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`));
                controller.enqueue(valid.subarray(0, 8));
            } });
            const slowUpload = testFetch(`${origin}/api/models/upload`, {
                method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body, duplex: 'half', signal: uploadAbort.signal
            }).then(response => ({ response }), error => ({ error }));
            await waitUntil(() => fs.readdirSync(models).some(name => !beforeUploads.has(name)), 3000, 'partial model upload');
            let accepted;
            const connectionAccepted = new Promise(resolve => { accepted = resolve; });
            blockedConnection = net.createServer(socket => {
                stalledSockets.add(socket);
                socket.on('close', () => stalledSockets.delete(socket));
                accepted();
            });
            await new Promise(resolve => blockedConnection.listen(0, '127.0.0.1', resolve));
            const first = put('/api/database/config', { type: 'mysql', host: '127.0.0.1', port: blockedConnection.address().port, user: 'audit', password: '', database: 'audit' });
            await connectionAccepted;
            try {
                uploadController.enqueue(valid.subarray(8));
                uploadController.enqueue(Buffer.from(`\r\n--${boundary}--\r\n`));
                uploadController.close();
                const uploaded = await slowUpload;
                assert.equal(uploaded.response?.status, 409, uploaded.error?.message);
                assert.deepEqual(new Set(fs.readdirSync(models)), beforeUploads, 'late upload must be removed');
                const second = await put('/api/database/config', { type: 'sqlite', filename: databaseFile });
                assert.equal(second.status, 409);
            } finally {
                uploadAbort.abort();
                for (const socket of stalledSockets) socket.destroy();
                assert.equal((await first).status, 400);
            }
            assert.ok((await requestJson(`${origin}/api/settings`)).factory_name);
        });
        await check('engine restart completes without leaving the HTTP request hanging', async () => {
            assert.equal((await requestJson(`${origin}/api/engine/restart`, { method: 'POST' })).success, true);
        });
        await check('restoring the sole retained backup does not prune the selected source first', async () => {
            assert.equal((await put('/api/settings', { audit_retention_marker: 'before' })).status, 200);
            const backup = (await requestJson(`${origin}/api/database/backups`, { method: 'POST' })).backup;
            assert.equal((await put('/api/settings', { audit_retention_marker: 'after' })).status, 200);
            const response = await testFetch(`${origin}/api/database/backups/${encodeURIComponent(backup.filename)}/restore`, { method: 'POST' });
            assert.equal(response.status, 200, await response.text());
            assert.equal((await requestJson(`${origin}/api/settings`)).audit_retention_marker, 'before');
        });
    } finally {
        for (const socket of stalledSockets) socket.destroy();
        if (blockedConnection) await new Promise(resolve => blockedConnection.close(resolve));
        await forceStop(backend);
        const result = { success: results.length > 0 && results.every(item => item.passed), checks: results, artifacts: directory };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) process.exitCode = 1;
    }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
