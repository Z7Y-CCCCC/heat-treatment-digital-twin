import test from 'node:test'
import assert from 'node:assert/strict'
import 'vue'
import { deferred, installBrowser, json, settle } from './helpers.mjs'

let moduleId = 0
const signedIn = csrfToken => ({ configured: true, authenticated: true, csrfToken, expiresAt: Date.now() + 600000 })

async function fixture(t) {
    const environment = installBrowser(t)
    const session = await import(`../src/runtime/adminSession.js?regression=${++moduleId}`)
    environment.beforeRestore(() => session.stopAdminSessionTracking())
    return { ...environment, ...session }
}

test('admin fetch attaches cookie and CSRF only to the backend API', async t => {
    const session = await fixture(t)
    const calls = []
    t.mock.method(session.browser, 'fetch', async (url, options = {}) => {
        calls.push({ url, options })
        return json(String(url).endsWith('/login') ? signedIn('token-1') : {})
    })
    await session.unlockAdmin('long-enough-password')
    await session.adminFetch('http://127.0.0.1:3001/api/settings', { method: 'PUT', body: '{}' })
    const mutation = calls.at(-1).options
    assert.equal(mutation.credentials, 'include')
    assert.equal(mutation.headers.get('X-CSRF-Token'), 'token-1')
    await session.adminFetch('https://example.test/api/settings', { method: 'PUT' })
    assert.equal(calls.at(-1).options.credentials, undefined)
    assert.equal(calls.at(-1).options.headers, undefined)
})

test('a late 401 from an older login cannot invalidate a newer session', async t => {
    const session = await fixture(t)
    const old = deferred()
    let loginCount = 0
    t.mock.method(session.browser, 'fetch', async url => String(url).endsWith('/login')
        ? json(signedIn(`token-${++loginCount}`)) : old.promise)
    await session.unlockAdmin('password-one')
    const request = session.adminFetch('http://127.0.0.1:3001/api/devices')
    await session.unlockAdmin('password-two')
    old.resolve(json({ code: 'ADMIN_AUTH_REQUIRED' }, 401))
    await request
    assert.equal(session.adminSession.authenticated, true)
})

test('account sessions can be added and switched using in-memory CSRF tokens', async t => {
    const session = await fixture(t)
    const calls = []
    const slotId = '0123456789abcdef01234567'
    t.mock.method(session.browser, 'fetch', async (url, options = {}) => {
        calls.push({ url: String(url), options })
        if (String(url).endsWith('/accounts/login')) return json({ ...signedIn('viewer-csrf'), accountSlotId: slotId, user: { username: 'viewer_one', role: 'viewer' } })
        if (String(url).endsWith('/accounts/activate')) return json({ ...signedIn('owner-csrf-2'), accountSlotId: 'main', user: { username: 'admin', role: 'owner' } })
        if (String(url).endsWith('/login')) return json({ ...signedIn('owner-csrf'), accountSlotId: 'main', user: { username: 'admin', role: 'owner' } })
        return json({ accounts: [] })
    })

    await session.unlockAdmin('owner-password')
    await session.addAdminAccount(slotId, 'viewer_one', 'viewer-password')
    assert.equal(session.adminSession.accountSlotId, slotId)
    await session.activateAdminAccount('main', 'owner-csrf')
    assert.equal(session.adminSession.accountSlotId, 'main')
    const activation = calls.find(call => call.url.endsWith('/accounts/activate'))
    assert.equal(activation.options.headers['X-CSRF-Token'], 'owner-csrf')
    assert.equal(calls.some(call => JSON.stringify(call.options.body || '').includes('viewer-password')), true)
})

test('signing out one account clears the active identity without erasing saved account slots', async t => {
    const session = await fixture(t)
    t.mock.method(session.browser, 'fetch', async url => String(url).endsWith('/accounts/logout')
        ? json({ configured: true, authenticated: false, accountSlotId: 'none' })
        : json({ ...signedIn('viewer-csrf'), accountSlotId: 'a'.repeat(24), user: { username: 'viewer_one', role: 'viewer' } }))
    await session.unlockAdmin('viewer-password')
    await session.logoutCurrentAdminAccount()
    assert.equal(session.adminSession.authenticated, false)
    assert.equal(session.adminSession.accountSlotId, 'none')
})

test('an expired-cookie lock refusal permits re-authentication without claiming success', async t => {
    const session = await fixture(t)
    t.mock.method(session.browser, 'fetch', async url => {
        if (String(url).endsWith('/session')) return json({ configured: true, authenticated: false })
        if (String(url).endsWith('/lock')) return json({ code: 'ADMIN_AUTH_REQUIRED', error: '请重新解锁后再次锁定' }, 401)
        return json(signedIn('fresh-token'))
    })
    assert.equal(await session.lockAdmin(), false)
    assert.equal(session.adminSession.lockPending, false)
    assert.match(session.adminSession.warning, /重新解锁/)
    await session.unlockAdmin('valid-password')
    assert.equal(session.adminSession.authenticated, true)
})

test('a network-uncertain lock remains pending and blocks another login', async t => {
    const session = await fixture(t)
    const fetch = t.mock.method(session.browser, 'fetch', async () => { throw new TypeError('network offline') })
    assert.equal(await session.lockAdmin(), false)
    assert.equal(session.adminSession.lockPending, true)
    await assert.rejects(session.unlockAdmin('valid-password'), /服务器尚未确认/)
    assert.equal(fetch.mock.calls.some(call => String(call.arguments[0]).endsWith('/login')), false)
})

test('lock attempts coalesce and distinguish pending broadcasts from confirmed locks', async t => {
    const session = await fixture(t)
    const pending = deferred()
    let locks = 0
    t.mock.method(session.browser, 'fetch', async url => {
        if (String(url).endsWith('/session')) return json(signedIn('token'))
        if (String(url).endsWith('/lock')) { locks += 1; return pending.promise }
        return json(signedIn('token'))
    })
    session.startAdminSessionTracking()
    const first = session.lockAdmin()
    const second = session.lockAdmin()
    await settle()
    assert.equal(locks, 1)
    assert.equal(session.channels[0].messages.at(-1).type, 'lock-pending')
    pending.resolve(json({ success: true }))
    assert.equal(await first, true)
    assert.equal(await second, true)
    assert.equal(session.channels[0].messages.at(-1).type, 'locked')
    assert.equal(session.adminSession.lockPending, false)
})

test('remote pending locks fail closed until a confirmed lock or explicit refusal arrives', async t => {
    const session = await fixture(t)
    t.mock.method(session.browser, 'fetch', async () => json(signedIn('token')))
    await session.unlockAdmin('valid-password')
    session.startAdminSessionTracking()
    const channel = session.channels[0]
    channel.onmessage({ data: { type: 'lock-pending' } })
    assert.equal(session.adminSession.authenticated, false)
    assert.equal(session.adminSession.lockPending, true)
    channel.onmessage({ data: { type: 'lock-rejected', warning: '重新认证以确认锁定' } })
    assert.equal(session.adminSession.lockPending, false)
    assert.equal(session.adminSession.warning, '重新认证以确认锁定')
})

test('session tracking is idempotent and releases listeners and channel on teardown', async t => {
    const session = await fixture(t)
    session.startAdminSessionTracking()
    session.startAdminSessionTracking()
    assert.equal(session.channels.length, 1)
    assert.equal(session.browser.listeners.get('pointerdown').size, 1)
    session.stopAdminSessionTracking()
    assert.equal(session.browser.listeners.get('pointerdown').size, 0)
    assert.equal(session.browser.listeners.get('focus').size, 0)
    assert.equal(document.listeners.get('visibilitychange').size, 0)
    assert.equal(session.channels[0].closed, true)
})
