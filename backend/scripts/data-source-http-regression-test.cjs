const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
    createRunDirectory,
    createTestDatabase,
    requireTestPath,
    waitUntil
} = require('./integration-test-utils.cjs');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

async function runRegressionTests() {
    const root = createRunDirectory('data-source-http-regression');
    const database = path.join(root, 'external.db');
    const previousEnv = { ...process.env };
    const servers = [];
    const failures = [];
    const passed = [];
    let service;
    try {
        await createTestDatabase(database);
        process.env.APP_DATA_DIR = root;
        process.env.DB_TYPE = 'sqlite';
        process.env.SQLITE_FILE = database;
        process.env.DATA_SOURCE_BACKUP_DIR = path.join(root, 'data-source-backups');
        service = require('../services/dataSources');

        let leakedRequests = 0;
        const redirectTarget = http.createServer((req, res) => {
            leakedRequests += 1;
            res.writeHead(200);
            res.end('unexpected redirect');
        });
        servers.push(redirectTarget);
        const redirectOrigin = await listen(redirectTarget);
        const heldResponses = new Map();
        const observedPaths = [];
        let openStreams = 0;
        const upstream = http.createServer((req, res) => {
            observedPaths.push(req.url);
            if (req.method !== 'GET') {
                res.writeHead(405);
                res.end();
                return;
            }
            if (req.url.startsWith('/hold/')) {
                heldResponses.set(req.url.slice('/hold/'.length), res);
                return;
            }
            if (req.url === '/slow') return;
            if (req.url === '/drop') { req.socket.destroy(); return; }
            if (req.url === '/stream') {
                openStreams += 1;
                res.once('close', () => { openStreams -= 1; });
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.flushHeaders();
                res.write('still streaming');
                return;
            }
            if (req.url === '/redirect') {
                res.writeHead(302, { Location: `${redirectOrigin}/receive` });
                res.end();
                return;
            }
            const authExpected = {
                '/auth/api-key': req.headers['x-api.key'] === 'fixture-api-key',
                '/auth/bearer': req.headers.authorization === 'Bearer fixture-bearer-token',
                '/auth/basic': req.headers.authorization === `Basic ${Buffer.from('operator:fixture-password').toString('base64')}`
            };
            if (Object.hasOwn(authExpected, req.url)) {
                res.writeHead(authExpected[req.url] ? 204 : 401);
                res.end();
                return;
            }
            const match = /^\/status\/(\d+)$/.exec(req.url);
            const status = match ? Number(match[1]) : (['/health', '/v1/health', '/v1/health?probe=1'].includes(req.url) ? 200 : 404);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
        });
        servers.push(upstream);
        const origin = await listen(upstream);
        const draft = (id, changes = {}) => ({
            ...(id ? { id } : {}),
            sourceType: 'http_api',
            name: id || 'unsaved API',
            baseUrl: origin,
            healthPath: '/health',
            authType: 'none',
            requestTimeoutMs: 1000,
            ...changes
        });
        const stored = id => service.listDataSources().connections.find(item => item.id === id);
        const rawStored = id => JSON.parse(fs.readFileSync(path.join(root, 'data-sources.json'), 'utf8')).connections.find(item => item.id === id);
        async function check(label, callback) {
            try { await callback(); passed.push(label); }
            catch (error) { failures.push({ test: label, error: error.stack || error.message }); }
        }

        await check('none / api-key / bearer / basic authentication', async () => {
            for (const config of [
                {},
                { healthPath: '/auth/api-key', authType: 'api_key', apiKeyHeader: 'X-API.Key', apiKey: 'fixture-api-key' },
                { healthPath: '/auth/bearer', authType: 'bearer', token: 'fixture-bearer-token' },
                { healthPath: '/auth/basic', authType: 'basic', user: 'operator', password: 'fixture-password' }
            ]) {
                const result = await service.testDataSource(draft('', config));
                assert.equal(result.health.status, 'healthy');
                assert.equal(result.success, true);
                assert.equal(typeof result.healthToken, 'string');
                for (const secret of ['fixture-api-key', 'fixture-bearer-token', 'fixture-password']) {
                    assert.equal(JSON.stringify(result).includes(secret), false);
                }
            }
        });
        await check('401 / 403 / other HTTP errors remain distinct from network and timeout', async () => {
            for (const status of [401, 403, 404, 503]) {
                const result = await service.testDataSource(draft('', { healthPath: `/status/${status}` }));
                assert.equal(result.success, false);
                assert.equal(result.health.status, [401, 403].includes(status) ? 'auth_failed' : 'http_error');
                assert.equal(result.health.httpStatus, status);
            }
            const network = await service.testDataSource(draft('', { healthPath: '/drop' }));
            assert.equal(network.health.status, 'network_error');
            assert.equal(network.health.httpStatus, null);
            const timedOut = await service.testDataSource(draft('', { healthPath: '/slow' }));
            assert.equal(timedOut.health.status, 'timeout');
            assert.equal(timedOut.health.httpStatus, null);
            assert.ok(timedOut.health.responseTimeMs >= 900 && timedOut.health.responseTimeMs < 5000);
        });
        await check('base URL path prefixes survive health path composition', async () => {
            for (const baseUrl of [`${origin}/v1`, `${origin}/v1/`]) {
                for (const healthPath of ['/health', 'health?probe=1']) {
                    const result = await service.testDataSource(draft('', { baseUrl, healthPath }));
                    assert.equal(result.health.status, 'healthy');
                    assert.ok(observedPaths.at(-1).startsWith('/v1/health'));
                }
            }
        });
        await check('redirects are not followed and never forward API keys', async () => {
            const result = await service.testDataSource(draft('', {
                healthPath: '/redirect', authType: 'api_key', apiKey: 'fixture-redirect-secret'
            }));
            assert.equal(result.health.status, 'http_error');
            assert.equal(result.health.httpStatus, 302);
            assert.equal(leakedRequests, 0);
            assert.equal(JSON.stringify(result).includes('fixture-redirect-secret'), false);
        });
        await check('streaming health responses are released after checking their status', async () => {
            const result = await service.testDataSource(draft('', { healthPath: '/stream' }));
            assert.equal(result.health.status, 'healthy');
            await waitUntil(() => openStreams === 0, 500, 'health response body cancellation');
        });
        await check('malformed auth is a configuration error without credential echoes', async () => {
            for (const config of [
                { authType: 'api_key', apiKey: 'fixture-key\r\nInjected: secret' },
                { authType: 'bearer', token: 'fixture-token\nsecret' },
                { authType: 'api_key', apiKeyHeader: 'Host', apiKey: 'fixture-host-secret' },
                { authType: 'basic', user: 'operator:other', password: 'fixture-password' },
                { authType: 'digest', token: 'fixture-unsupported-secret' },
                { authType: 'bearer', token: '' },
                { authType: 'bearer', token: '   ' }
            ]) {
                const input = draft('', config);
                const result = await service.testDataSource(input);
                assert.equal(result.health.status, 'config_error');
                assert.throws(() => service.saveDataSource(input));
                for (const secret of [config.apiKey, config.token, config.password].filter(Boolean)) {
                    assert.equal(JSON.stringify(result).includes(secret), false);
                    assert.equal(result.health.message.includes(secret), false);
                }
            }
        });
        await check('URL credentials, cross-origin paths, fragments and control characters are rejected', async () => {
            for (const changes of [
                { baseUrl: origin.replace('http://', 'http://operator:fixture-url-secret@') },
                { healthPath: `${redirectOrigin}/health` },
                { healthPath: '/heal\nth' },
                { healthPath: '/health#fragment' },
                { baseUrl: `${origin}/#fragment` },
                { baseUrl: 'ftp://example.invalid' }
            ]) {
                assert.throws(() => service.saveDataSource(draft('', changes)));
                const result = await service.testDataSource(draft('', changes));
                assert.equal(result.health.status, 'config_error');
                assert.equal(JSON.stringify(result).includes('fixture-url-secret'), false);
            }
        });
        await check('server-issued health token saves new tested drafts; arbitrary health is ignored', async () => {
            const input = draft('token_api');
            const forged = service.saveDataSource({ ...input, health: { status: 'healthy', message: 'client-forged', checkedAt: new Date().toISOString() } });
            assert.equal(forged.health, null);
            const result = await service.testDataSource(draft(''));
            const saved = service.saveDataSource({ ...draft('new_tested_api'), healthToken: result.healthToken });
            assert.equal(saved.health.status, 'healthy');
            assert.equal(saved.health.httpStatus, 200);
            const expired = service.saveDataSource({ ...draft('expired_token_api'), healthToken: 'expired-or-restarted-token' });
            assert.equal(expired.health, null);
            const mismatch = service.saveDataSource({ ...draft('mismatched_token_api', { healthPath: '/status/503' }), healthToken: result.healthToken });
            assert.equal(mismatch.health, null);
            const realNow = Date.now;
            const expiredAt = realNow() + 15 * 60 * 1000 + 1;
            Date.now = () => expiredAt;
            try {
                const stale = service.saveDataSource({ ...draft('stale_token_api'), healthToken: result.healthToken });
                assert.equal(stale.health, null);
            } finally { Date.now = realNow; }
        });
        await check('changing connection settings clears health but a rename preserves it', async () => {
            service.saveDataSource(draft('changed_api'));
            await service.testDataSource({ id: 'changed_api' });
            assert.equal(stored('changed_api').health.status, 'healthy');
            const before = stored('changed_api').updatedAt;
            assert.equal(stored('changed_api').updatedAt, before);
            const renamed = service.saveDataSource({ id: 'changed_api', name: 'renamed API' });
            assert.equal(renamed.health.status, 'healthy');
            const changed = service.saveDataSource({ id: 'changed_api', healthPath: '/status/503' });
            assert.equal(changed.health, null);
        });
        await check('testing an unsaved edit does not change the saved connection health', async () => {
            service.saveDataSource(draft('unsaved_edit'));
            const healthy = await service.testDataSource({ id: 'unsaved_edit' });
            const failed = await service.testDataSource({ id: 'unsaved_edit', healthPath: '/status/503' });
            assert.equal(failed.health.status, 'http_error');
            assert.equal(failed.connection.healthPath, '/status/503');
            assert.deepEqual(stored('unsaved_edit').health, healthy.health);
        });
        await check('in-flight checks cannot overwrite a saved edit or a recreated ID', async () => {
            for (const recreate of [false, true]) {
                const id = recreate ? 'recreated_api' : 'racing_save_api';
                service.saveDataSource(draft(id, { healthPath: `/hold/${id}` }));
                const pending = service.testDataSource({ id });
                const response = await waitUntil(() => heldResponses.get(id), 2000, 'pending health request');
                if (recreate) {
                    service.deleteDataSource(id);
                    service.saveDataSource(draft(id, { healthPath: `/hold/${id}` }));
                } else {
                    service.saveDataSource({ id, healthPath: '/status/503' });
                }
                response.writeHead(200); response.end();
                await pending;
                assert.equal(stored(id).health, null);
            }
        });
        await check('the latest started check wins even if an older response arrives last', async () => {
            const id = 'racing_test_api';
            service.saveDataSource(draft(id, { healthPath: '/hold/race' }));
            const first = service.testDataSource({ id });
            const firstResponse = await waitUntil(() => heldResponses.get('race'), 2000, 'first health request');
            heldResponses.delete('race');
            const second = service.testDataSource({ id });
            const secondResponse = await waitUntil(() => heldResponses.get('race'), 2000, 'second health request');
            secondResponse.writeHead(503); secondResponse.end();
            await second;
            firstResponse.writeHead(200); firstResponse.end();
            await first;
            assert.equal(stored(id).health.status, 'http_error');
            assert.equal(stored(id).health.httpStatus, 503);
        });
        await check('masked credentials preserve values; auth/kind switches discard inactive credentials', async () => {
            const id = 'secret_api';
            service.saveDataSource(draft(id, { authType: 'api_key', apiKey: 'fixture-stored-key' }));
            service.saveDataSource({ id, apiKey: '******', name: 'renamed secret API' });
            assert.equal(rawStored(id).apiKey, 'fixture-stored-key');
            service.saveDataSource({ id, authType: 'bearer', token: 'fixture-stored-token' });
            assert.equal(rawStored(id).apiKey, '');
            assert.equal(rawStored(id).token, 'fixture-stored-token');
            service.saveDataSource({ id, authType: 'none' });
            assert.equal(rawStored(id).token, '');
            assert.equal(rawStored(id).password, '');
            assert.throws(() => service.saveDataSource({ id, authType: 'bearer', token: '******' }));
            service.saveDataSource({ id, authType: 'basic', user: 'operator', password: 'fixture-cross-kind-password' });
            service.saveDataSource({ id, sourceType: 'database', type: 'sqlite', filename: database, password: '******' });
            assert.equal(rawStored(id).password, '');
            assert.equal(Object.hasOwn(rawStored(id), 'token'), false);
            service.saveDataSource({ id, password: 'fixture-db-password' });
            service.saveDataSource({ id, password: '' });
            assert.equal(rawStored(id).password, '');
        });
        await check('disabled connections can be tested without losing their masked credentials', async () => {
            const config = service.saveDataSource(draft('disabled_api', {
                enabled: false, healthPath: '/auth/bearer', authType: 'bearer', token: 'fixture-bearer-token'
            }));
            assert.equal(config.token, '******');
            const result = await service.testDataSource(config);
            assert.equal(result.health.status, 'healthy');
            assert.equal(stored(config.id).enabled, false);
            assert.equal(stored(config.id).health.status, 'healthy');
            await assert.rejects(service.listTables(config.id), /停用/);
        });
        await check('rapidly created sources receive distinct IDs', () => {
            const realNow = Date.now;
            const fixedNow = realNow();
            Date.now = () => fixedNow;
            try {
                const first = service.saveDataSource(draft(''));
                const second = service.saveDataSource(draft(''));
                assert.notEqual(first.id, second.id);
            } finally { Date.now = realNow; }
        });
        await check('database drivers remain selectable and API sources cannot be browsed or backed up', async () => {
            for (const type of ['mysql', 'postgres', 'sqlserver', 'sqlite']) {
                const db = service.saveDataSource({ id: `driver_${type}`, type, filename: database });
                assert.equal(db.type, type);
                assert.equal(db.sourceType, 'database');
            }
            const dbCheck = await service.testDataSource({ id: 'driver_sqlite' });
            assert.equal(dbCheck.health.status, 'healthy');
            assert.equal(dbCheck.health.httpStatus, null);
            assert.equal(stored('driver_sqlite').health.httpStatus, null);
            assert.ok((await service.listTables('driver_sqlite')).some(table => table.name === 'settings'));
            assert.ok((await service.listColumns('driver_sqlite', '', 'settings')).some(column => column.name === 'value'));
            const id = 'excluded_api';
            service.saveDataSource(draft(id));
            await assert.rejects(service.listTables(id), /HTTP API/);
            await assert.rejects(service.listColumns(id, '', 'settings'), /HTTP API/);
            await assert.rejects(service.createConnectionBackup(id), /HTTP API/);
            const config = service.saveBackupConfig({ selectedConnectionIds: ['driver_sqlite', id] });
            assert.deepEqual(config.selectedConnectionIds, ['driver_sqlite']);
            assert.equal(service.getBackupStatus().connections.some(item => item.id === id), false);
            service.saveBackupConfig({ selectedConnectionIds: ['driver_sqlite'] });
            service.saveDataSource({ ...draft('driver_sqlite') });
            assert.equal(service.listDataSources().backup.selectedConnectionIds.includes('driver_sqlite'), false);
            assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data-sources.json'), 'utf8')).backup.selectedConnectionIds.includes('driver_sqlite'), false);
        });
        await check('HTTP route save/list/test replies never expose original credentials', async () => {
            const express = require('express');
            const app = express();
            app.use(express.json());
            app.use('/api/data-sources', require('../routes/dataSources'));
            const api = http.createServer(app);
            servers.push(api);
            const apiOrigin = await listen(api);
            async function request(route, input) {
                const response = await fetch(`${apiOrigin}/api/data-sources${route}`, {
                    method: input ? 'POST' : 'GET',
                    headers: input ? { 'content-type': 'application/json' } : {},
                    body: input ? JSON.stringify(input) : undefined,
                    signal: AbortSignal.timeout(5000)
                });
                const body = await response.json();
                assert.equal(response.ok, true);
                for (const secret of ['fixture-route-key', 'fixture-route-token', 'fixture-route-password']) {
                    assert.equal(JSON.stringify(body).includes(secret), false);
                }
                return body;
            }
            for (const config of [
                { authType: 'api_key', apiKey: 'fixture-route-key' },
                { authType: 'bearer', token: 'fixture-route-token' },
                { authType: 'basic', user: 'operator', password: 'fixture-route-password' }
            ]) {
                const saved = await request('/connections', draft(`route_${config.authType}`, config));
                await request('/test', saved.connection);
            }
            await request('');
        });
        await check('MCP rejects failed database tests without saving, rebinding or publishing', async () => {
            const express = require('express');
            const app = express();
            app.use(express.json());
            // This tool does not call localApi; port 0 also makes any accidental
            // local API call fail closed instead of reaching a real installation.
            app.use('/api/mcp', require('../routes/mcp')({ port: 0 }));
            const api = http.createServer(app);
            servers.push(api);
            const apiOrigin = await listen(api);
            const Database = require('better-sqlite3');
            const snapshot = () => {
                const readonly = new Database(database, { readonly: true, fileMustExist: true });
                try {
                    return {
                        scenes: readonly.prepare('SELECT id, draft_revision, draft_json, published_release_id FROM scenes ORDER BY id').all(),
                        releases: readonly.prepare('SELECT id, is_current, snapshot_json FROM releases ORDER BY id').all()
                    };
                } finally { readonly.close(); }
            };
            const before = snapshot();
            const existing = service.saveDataSource({ id: 'mcp_existing', name: 'existing database', type: 'sqlite', filename: database });
            const invoke = async args => {
                const response = await fetch(`${apiOrigin}/api/mcp`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
                        name: 'configure_readonly_business_source', arguments: args
                    } }),
                    signal: AbortSignal.timeout(5000)
                });
                assert.equal(response.status, 200);
                return response.json();
            };
            for (const id of ['mcp_new_invalid', existing.id]) {
                const result = await invoke({ id, name: 'invalid database', type: 'sqlite', filename: path.join(root, 'missing.db') });
                assert.equal(result.result.isError, true);
                assert.equal(JSON.stringify(result).includes('"success":true'), false);
            }
            assert.equal(stored('mcp_new_invalid'), undefined);
            assert.deepEqual(stored(existing.id), existing);
            assert.deepEqual(snapshot(), before);
            const apiResult = await invoke({ ...draft('mcp_api'), bindBusinessWidgets: false });
            assert.equal(apiResult.result.isError, true);
            assert.equal(stored('mcp_api'), undefined);
            const valid = await invoke({ id: 'mcp_valid', name: 'valid database', type: 'sqlite', filename: database, bindBusinessWidgets: false });
            assert.equal(valid.result.isError, false);
            assert.equal(valid.result.structuredContent.success, true);
            assert.equal(valid.result.structuredContent.test.success, true);
            assert.equal(stored('mcp_valid').health.status, 'healthy');
        });
    } finally {
        await service?.stopDataSourceMaintenance({ backup: false });
        await Promise.all(servers.map(close));
        if (service) await require('../db/database').closeDb();
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnv, key)) delete process.env[key];
        Object.assign(process.env, previousEnv);
        fs.rmSync(requireTestPath(root), { recursive: true, force: true });
    }
    const report = { success: failures.length === 0, passed: passed.length, total: passed.length + failures.length, checks: passed, failures };
    console.log(JSON.stringify(report, null, 2));
    if (failures.length) throw new Error(`${failures.length} HTTP data-source regression checks failed`);
    return report;
}

if (require.main === module) {
    runRegressionTests().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { runRegressionTests };
