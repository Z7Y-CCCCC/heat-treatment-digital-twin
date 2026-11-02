const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAdminAuth, DISPLAY_SESSION_MS } = require('../services/adminAuth');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { migrateCustomerReadonly } = require('../../tools/migrate-customer-readonly.cjs');
const { adminSessionCookieName } = require('../middleware/security');
const directory = createRunDirectory('admin-session-persistence'), checks = [];
let time = Date.now();
const dataDir = path.join(directory, 'data');
const restart = () => createAdminAuth({ dataDir, now: () => time });
const check = name => { checks.push(name); console.log('PASS ' + name); };

(async () => {
    let auth = restart();
    const owner = await auth.setup('owner-password', 'owner');
    const customerUser = await auth.createUser(owner.token, owner.status.csrfToken,
        { username: '现场客户', role: 'customer', password: 'customer-password' });
    assert.equal(customerUser.pagePermissions.devices.view, true);
    assert.equal(customerUser.pagePermissions.devices.edit, false);
    assert.equal(customerUser.pagePermissions['point-monitor'].view, true);
    assert.equal(customerUser.pagePermissions.users.view, false);
    const denied = await auth.createUser(owner.token, owner.status.csrfToken,
        { username: '明确拒绝', role: 'customer', password: 'customer-password', pagePermissions: {} });
    assert.equal(denied.pagePermissions.devices.view, false);
    check('customer default grants only devices/monitor read-only; explicit denials and owner-only pages stay denied');
    const customer = await auth.login('customer-password', 'customer', '', '现场客户');
    await auth.updateUser(owner.token, owner.status.csrfToken, customerUser.id,
        { enabled: true, displayName: '改名后仍记住', pagePermissions: { devices: { view: true } } });
    assert.equal(auth.status(customer.token).authenticated, true);
    assert.equal(restart().status(customer.token).authenticated, true);
    assert.throws(() => auth.requireSession(customer.token, customer.status.csrfToken,
        { permission: 'page:point-monitor:view' }), { code: 'ADMIN_PERMISSION_DENIED' });
    check('routine account edits retain every valid login across restart while revoked page grants apply immediately');
    const native = auth.exchangeNativeTicket(auth.createNativeTicket(customer.token, customer.status.csrfToken).ticket);
    const filename = path.join(dataDir, 'admin-sessions.json');
    const disk = fs.readFileSync(filename, 'utf8');
    for (const secret of [owner.token, customer.token, native.token, 'owner-password', 'customer-password']) assert.equal(disk.includes(secret), false);
    auth = restart();
    assert.equal(auth.status(owner.token).authenticated, true);
    assert.equal(auth.status(customer.token).authenticated, true);
    assert.equal(auth.status(customer.token).canAccessAdmin, true);
    assert.equal(auth.status(native.token).displayAuthenticated, false);
    check('restart restores multiple browser sessions without persisting passwords, bearer tokens or native tickets');
    auth.requireSession(customer.token, customer.status.csrfToken, { permission: 'page:devices:view' });
    assert.throws(() => auth.requireSession(customer.token, customer.status.csrfToken, { permission: 'page:devices:edit' }), { code: 'ADMIN_PERMISSION_DENIED' });
    auth.lock(customer.token, customer.status.csrfToken);
    auth = restart();
    assert.equal(auth.status(customer.token).authenticated, false);
    assert.equal(auth.status(customer.token).displayAuthenticated, true);
    assert.equal(auth.status(owner.token).authenticated, true);
    assert.throws(() => auth.requireSession(customer.token, customer.status.csrfToken, { permission: 'page:devices:view' }), { code: 'ADMIN_AUTH_REQUIRED' });
    check('a manual lock survives restart and cannot be bypassed by account activation');
    auth.logout(customer.token, customer.status.csrfToken);
    auth = restart();
    assert.equal(auth.status(customer.token).displayAuthenticated, false);
    const renewed = await auth.login('customer-password', 'renew', '', '现场客户');
    time += 31 * 60000;
    auth = restart();
    assert.equal(auth.status(renewed.token).authenticated, false);
    assert.equal(auth.status(renewed.token).displayAuthenticated, true);
    check('logout stays revoked; restarting never resets the idle timeout');
    time += DISPLAY_SESSION_MS;
    auth = restart();
    assert.equal(auth.status(renewed.token).displayAuthenticated, false);
    check('remembered display sessions expire after thirty days');
    const activeOwner = await auth.login('owner-password', 'new-owner');
    const activeCustomer = await auth.login('customer-password', 'new-customer', '', '现场客户');
    const oldDisk = fs.readFileSync(filename);
    await auth.updateUser(activeOwner.token, activeOwner.status.csrfToken, customerUser.id,
        { enabled: true, password: 'replacement-password' });
    assert.equal(restart().status(activeCustomer.token).displayAuthenticated, false);
    // Restoring a stale session file must not resurrect a reset password's token.
    fs.writeFileSync(filename, oldDisk);
    assert.equal(restart().status(activeCustomer.token).displayAuthenticated, false);
    check('password reset revocation survives restart and rejects stale session files');
    auth = restart();
    const tamperSession = await auth.login('owner-password', 'tamper');
    const tampered = JSON.parse(fs.readFileSync(filename));
    tampered.rows[0][1].userId = 'owner';
    tampered.rows[0][1].lastActivityAt += 1;
    fs.writeFileSync(filename, JSON.stringify(tampered));
    assert.equal(restart().status(tamperSession.token).displayAuthenticated, false);
    fs.writeFileSync(filename, '{broken');
    assert.equal(restart().status('').configured, true);
    check('tampered or corrupt session files fail closed without wiping account configuration');
    const beforeEnv = { PORT: process.env.PORT, APP_DATA_DIR: process.env.APP_DATA_DIR };
    try {
        process.env.APP_DATA_DIR = dataDir; process.env.PORT = '3001'; const cookie = adminSessionCookieName();
        process.env.PORT = '3002'; assert.equal(adminSessionCookieName(), cookie);
        process.env.APP_DATA_DIR = path.join(directory, 'other'); assert.notEqual(adminSessionCookieName(), cookie);
    } finally { for (const [key, value] of Object.entries(beforeEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; }
    check('cookie scope survives a port change and remains isolated from another installation');
    const configBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-security.json')));
    const migration = migrateCustomerReadonly(dataDir, ['明确拒绝']);
    assert.ok(migration.backup);
    const configAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-security.json')));
    assert.deepEqual(configAfter.password, configBefore.password);
    assert.deepEqual(configAfter.users.map(u => u.password), configBefore.users.map(u => u.password));
    assert.deepEqual(migrateCustomerReadonly(dataDir, ['明确拒绝']).changed, []);
    check('the explicitly selected legacy-template migration is backed up, idempotent and leaves credentials untouched');
    const result = { success: true, checks, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
