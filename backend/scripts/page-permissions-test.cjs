const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { createAdminAuth } = require('../services/adminAuth');
const { PAGE_PERMISSIONS, normalizePagePermissions, canPage, allowsRequirement } = require('../../shared/pagePermissions.cjs');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const { requiresModelPublish } = require('../services/modelPublicationPermission');

(async () => {
    const directory = createRunDirectory('page-permissions');
    let time = Date.now();
    const auth = createAdminAuth({ dataDir: directory, now: () => time });
    const password = crypto.randomBytes(24).toString('base64url');
    const owner = await auth.setup(password, 'fixture-owner');
    const csrf = owner.status.csrfToken;
    const user = await auth.createUser(owner.token, csrf, { username: 'model_author', role: 'viewer', password,
        permissions: { view: false }, pagePermissions: { models: { view: true, edit: true } } });
    const login = await auth.login(password, 'fixture-author', '', user.username);
    assert.equal(login.status.canAccessAdmin, true);
    assert.equal(login.status.permissions.edit, false, 'page edit must not become owner/admin');
    assert.equal(login.status.permissions.manageUsers, false);
    assert.equal(login.status.permissions.view, false);
    assert.equal(canPage(login.status.pagePermissions, 'models', 'edit'), true);
    assert.equal(canPage(login.status.pagePermissions, 'devices'), false);
    for (const definition of PAGE_PERMISSIONS) for (const action of definition.actions) {
        assert.equal(canPage(owner.status.pagePermissions, definition.key, action), true);
        const expected = definition.key === 'models' && ['view', 'edit'].includes(action);
        if (expected) auth.requireSession(login.token, login.status.csrfToken, { permission: `page:${definition.key}:${action}` });
        else assert.throws(() => auth.requireSession(login.token, login.status.csrfToken,
            { permission: `page:${definition.key}:${action}` }), e => e.statusCode === 403);
    }
    for (const name of ['unknown', 'page:models:unknown', 'page:unknown:view']) {
        assert.throws(() => auth.requireSession(owner.token, csrf, { permission: name }), e => e.statusCode === 403);
    }
    for (const invalid of [{ wrong: { view: true } }, { models: { edit: true } }, { models: { view: 'true' } },
        { models: { view: true, manageUsers: true } }, { users: { view: true } }, [], null]) {
        await assert.rejects(auth.createUser(owner.token, csrf, { username: 'invalid_grant', role: 'viewer', password, pagePermissions: invalid }), e => e.statusCode === 400);
    }
    const context = { active: true, owner: false, permissions: { view: false }, pagePermissions: login.status.pagePermissions };
    const released = { assetSpec: { delivery_status: 'released' }, release: { status: 'released', version: '1.0.0', history: [] } };
    assert.equal(requiresModelPublish({}, released), true);
    assert.equal(requiresModelPublish(released, { ...released, inspection: { enabled: true } }), false);
    assert.equal(requiresModelPublish(released, { assetSpec: { delivery_status: 'draft' } }), true);
    assert.equal(allowsRequirement(apiPermission('/api/models/upload', 'POST'), context), true);
    assert.equal(allowsRequirement(apiPermission('/api/models/item', 'DELETE'), context), false);
    assert.equal(allowsRequirement(apiPermission('/api/devices', 'POST'), context), false);
    assert.equal(allowsRequirement(apiPermission('/api/mcp', 'POST'), context), false);
    assert.equal(allowsRequirement(apiPermission('/api/platform/designer', 'GET'), context), false);
    const designer = { ...context, pagePermissions: normalizePagePermissions({ 'platform.designer': { view: true, edit: true } }) };
    assert.equal(allowsRequirement(apiPermission('/api/platform/designer/draft', 'PUT'), designer), true);
    assert.equal(allowsRequirement(apiPermission('/api/platform/releases', 'POST'), designer), false);
    const data = { ...context, pagePermissions: normalizePagePermissions({ 'settings.data': { view: true, edit: true } }) };
    const directoryEditor = { ...context, pagePermissions: normalizePagePermissions({ factories: { view: true, edit: true } }) };
    assert.equal(allowsRequirement(apiPermission('/api/factories/factory_default/collection', 'PUT'), directoryEditor), false);
    assert.equal(allowsRequirement(apiPermission('/api/factories/factory_default/collection', 'PUT'), data), true);
    assert.equal(allowsRequirement(apiPermission('/api/factories/factory_default', 'PUT'), data), false);
    assert.equal(allowsRequirement(apiPermission('/api/settings', 'PUT', { data_mode: 'simulation' }), data), true);
    assert.equal(allowsRequirement(apiPermission('/api/settings', 'PUT', { data_mode: 'simulation', native_quality_profile: 'auto' }), data), false);
    assert.equal(allowsRequirement(apiPermission('/api/settings', 'PUT', { unknown: 'value' }), data), false);
    assert.equal(allowsRequirement(apiPermission('/api/settings', 'PUT', {}), data), false);
    assert.equal(auth.touch(login.token, login.status.csrfToken).authenticated, true, 'page-only account can renew activity without display view');
    time += 31 * 60000;
    assert.equal(auth.status(login.token).canAccessAdmin, false);
    assert.equal(canPage(auth.status(login.token).pagePermissions, 'models'), false);
    assert.throws(() => auth.requireSession(login.token, login.status.csrfToken, { permission: 'page:models:view' }), e => e.statusCode === 401);
    const freshOwner = await auth.login(password, 'fresh-owner');
    await auth.updateUser(freshOwner.token, freshOwner.status.csrfToken, user.id, { enabled: true, pagePermissions: {} });
    assert.throws(() => auth.requireSession(login.token, login.status.csrfToken), e => e.statusCode === 401);
    const relogin = await auth.login(password, 'fresh-author', '', user.username);
    assert.equal(relogin.status.canAccessAdmin, false);
    // Old security files remain usable but never gain business-page grants.
    const filename = path.join(directory, 'admin-security.json');
    const stored = JSON.parse(fs.readFileSync(filename));
    delete stored.users[0].pagePermissions;
    fs.writeFileSync(filename, JSON.stringify(stored));
    const migrated = createAdminAuth({ dataDir: directory });
    assert.equal((await migrated.login(password, 'migrated-author', '', user.username)).status.canAccessAdmin, false);
    stored.users[0].pagePermissions = { users: { view: true } };
    fs.writeFileSync(filename, JSON.stringify(stored));
    assert.throws(() => createAdminAuth({ dataDir: directory }), e => e.code === 'ADMIN_CONFIG_UNAVAILABLE');
    console.log(JSON.stringify({ success: true, pages: PAGE_PERMISSIONS.length, migration: true, defaultDeny: true,
        granularActions: true, lockAndRevocation: true, mixedSettingProtection: true, artifacts: directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
