const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BACKEND_DIR, createTestDatabase, createRunDirectory, findFreePort, forceStop, startLoggedProcess, waitForHttp } = require('./integration-test-utils.cjs');
const { createSmokeEnvironment } = require('../../desktop/scripts/smoke-sandbox.cjs');
let backend;
(async () => {
    const directory = createRunDirectory('data-center-http');
    const filename = await createTestDatabase(path.join(directory, 'data', 'factory.db'));
    const env = { ...createSmokeEnvironment(directory), DB_TYPE: 'sqlite', SQLITE_FILE: filename, HOST: '127.0.0.1', PORT: String(await findFreePort()), ADMIN_API_TOKEN: '', MCP_API_TOKEN: '' };
    Object.assign(process.env, env);
    const database = require('../db/database'), db = await database.getDb();
    const workshop = await db.get('SELECT * FROM workshops LIMIT 1');
    const factoryId = workshop.factory_id;
    await db.run('INSERT INTO factories (id,name) VALUES (?,?)', ['data_center_foreign_factory', 'Other catalog']);
    await database.closeDb();
    const origin = `http://127.0.0.1:${env.PORT}`;
    backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], { cwd: BACKEND_DIR, env, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    let checks = 0;
    async function request(route, { method = 'GET', session, body, expected = 200, noCsrf = false, factory = factoryId } = {}) {
        const response = await fetch(`${origin}/api${route}`, { method,
            headers: { Origin: origin, 'X-Admin-Request': '1', 'X-Factory-ID': factory,
                ...(session ? { Cookie: session.cookie, ...(!noCsrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data).slice(0, 500)}`); checks++;
        return { data, cacheControl: response.headers.get('cache-control'), cookie: response.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; ') || session?.cookie, csrfToken: data.csrfToken || session?.csrfToken };
    }
    const password = `Fixture-${crypto.randomBytes(20).toString('base64url')}!`;
    const owner = await request('/admin-auth/setup', { method: 'POST', body: { password } });
    async function account(username, pagePermissions) {
        await request('/admin-auth/users', { method: 'POST', session: owner, body: { username, password, role: 'viewer', permissions: { view: false }, pagePermissions }, expected: 201 });
        return request('/admin-auth/login', { method: 'POST', body: { username, password } });
    }
    const reader = await account('catalog_reader', { 'point-monitor': { view: true } });
    const author = await account('catalog_author', { 'settings.database': { view: true, edit: true } });
    const designer = await account('catalog_designer', { 'platform.designer': { view: true, edit: true } });
    const unrelated = await account('catalog_unrelated', { models: { view: true, edit: true } });
    await request('/data-center/catalog', { expected: 401 });
    await request('/data-center/catalog', { session: unrelated, expected: 403 });
    const initial = await request('/data-center/catalog', { session: reader });
    assert.equal(initial.cacheControl, 'no-store'); assert.ok(initial.data.items.length); assert.ok(initial.data.categories.length >= 6);
    await request('/data-center/catalog', { session: designer });
    await request('/data-center/catalog', { session: author });
    const item = initial.data.items.find(i => i.sourceType === 'plc'); assert.ok(item);
    const sample = initial.data.devices.at(-1);
    const previewOnly = (await request(`/data-center/catalog?preview_device_id=${sample.id}`, { session: reader })).data;
    assert.equal(previewOnly.items.length, initial.data.items.length); assert.equal(previewOnly.tables.length, initial.data.tables.length);
    assert.equal(previewOnly.devices.length, initial.data.devices.length); assert.equal(previewOnly.previewDevice.id, sample.id);
    const newCategory = { name: '能耗与环保', revision: initial.data.revision };
    await request('/data-center/categories', { method: 'PUT', body: newCategory, expected: 401 });
    await request('/data-center/categories', { method: 'PUT', session: reader, body: newCategory, expected: 403 });
    await request('/data-center/categories', { method: 'PUT', session: designer, body: newCategory, expected: 403 });
    await request('/data-center/categories', { method: 'PUT', session: author, body: newCategory, noCsrf: true, expected: 403 });
    const saved = (await request('/data-center/categories', { method: 'PUT', session: author, body: newCategory })).data;
    await request('/data-center/categories', { method: 'PUT', session: author, body: newCategory, expected: 409 });
    const itemBody = { categoryId: saved.category.id, revision: saved.revision };
    await request(`/data-center/items/${item.id}`, { method: 'PUT', session: reader, body: itemBody, expected: 403 });
    const assigned = (await request(`/data-center/items/${item.id}`, { method: 'PUT', session: author, body: itemBody })).data;
    await request(`/data-center/items/${item.id}`, { method: 'PUT', session: author, body: { revision: assigned.revision, binding: { mode: 'static' } }, expected: 400 });
    await request(`/data-center/categories/${saved.category.id}`, { method: 'DELETE', session: author, body: { revision: assigned.revision }, expected: 403 });
    const foreign = (await request('/data-center/catalog', { session: owner, factory: 'data_center_foreign_factory' })).data;
    assert.equal(foreign.items.some(i => i.id === item.id), false);
    assert.equal(foreign.categories.some(c => c.id === saved.category.id), false);
    await request(`/data-center/items/${item.id}`, { method: 'PUT', session: owner, factory: 'data_center_foreign_factory', body: { categoryId: 'realtime', revision: foreign.revision }, expected: 404 });
    await request(`/data-center/catalog?device_id=${item.deviceId}`, { session: owner, factory: 'data_center_foreign_factory', expected: 404 });
    await request(`/data-center/catalog?preview_device_id=${item.deviceId}`, { session: owner, factory: 'data_center_foreign_factory', expected: 404 });
    const erased = (await request(`/data-center/categories/${saved.category.id}`, { method: 'DELETE', session: owner, body: { revision: assigned.revision } })).data;
    assert.equal(erased.movedCount, 1);
    const final = (await request('/data-center/catalog', { session: reader })).data;
    assert.equal(final.items.find(i => i.id === item.id).categoryId, 'uncategorized');
    assert.deepEqual(final.items.find(i => i.id === item.id).binding, item.binding);
    await request('/data-center/categories/uncategorized', { method: 'DELETE', session: owner, body: { revision: final.revision }, expected: 400 });
    await request('/data-center/catalog', { session: owner, factory: 'unknown_catalog_factory', expected: 404 });
    const result = { success: true, checks, directory, pageReadIsolation: true, separateViewEditDelete: true, csrfRequired: true, factoryIsolation: true, bindingPreserved: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => forceStop(backend));
