import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, createMemoryHistory } from 'vue-router'
import { installBrowser } from './helpers.mjs'

const session = { ready: true, authenticated: false, displayAuthenticated: false, permissions: {} }
let refreshes = 0
test.mock.module('../src/runtime/adminSession.js', { namedExports: {
    adminSession: session, refreshAdminSession: async () => { refreshes++; session.ready = true }
} })
test.mock.module('vue-router', { namedExports: {
    createWebHistory: createMemoryHistory,
    // Execute production guards and real Vue Router transitions in memory;
    // page rendering is deliberately outside this isolated access check.
    createRouter: options => createRouter({ ...options, routes: options.routes.map(route => ({ ...route, component: { render: () => null } })) })
} })
let sequence = 0
async function fixture(t, overrides = {}) {
    const environment = installBrowser(t)
    Object.assign(session, { ready: true, authenticated: false, displayAuthenticated: false, permissions: {} }, overrides)
    refreshes = 0
    const { default: router } = await import(`../src/router/index.js?access-test=${++sequence}`)
    return { router, environment }
}
test('all protected standalone routes redirect signed-out users while preserving their return target', async t => {
    const { router } = await fixture(t)
    for (const path of ['/', '/group', '/site', '/overlay', '/hud-preview', '/customer']) {
        await router.push(`${path}?fixture=1`)
        assert.equal(router.currentRoute.value.path, '/admin')
        assert.equal(router.currentRoute.value.query.redirect, path === '/' ? '/group' : `${path}?fixture=1`)
    }
})
test('route entry waits for initial session discovery and updates document title', async t => {
    const { router } = await fixture(t, { ready: false, displayAuthenticated: true })
    await router.push('/group')
    assert.equal(refreshes, 1)
    assert.equal(router.currentRoute.value.path, '/group')
    assert.equal(document.title, '生产运营 · 集团分布')
})
test('view-only accounts cannot enter admin or customer operations', async t => {
    const { router } = await fixture(t, { authenticated: true, displayAuthenticated: true, permissions: { view: true } })
    await router.push('/admin')
    assert.equal(router.currentRoute.value.path, '/group')
    await router.push('/customer')
    assert.equal(router.currentRoute.value.path, '/group')
})
test('cast and backup accounts can enter customer operations and editors retain admin access', async t => {
    const { router } = await fixture(t, { authenticated: true, displayAuthenticated: true, permissions: { backup: true } })
    await router.push('/admin')
    assert.equal(router.currentRoute.value.path, '/customer')
    session.permissions = { edit: true }
    await router.push('/admin')
    assert.equal(router.currentRoute.value.path, '/admin')
})
test('only a genuine native overlay stays transparent while signed out', async t => {
    const { router, environment } = await fixture(t)
    await router.push('/overlay?embedded=unity&surface=overlay')
    assert.equal(router.currentRoute.value.path, '/admin')
    environment.browser.chrome = { webview: { postMessage() {} } }
    await router.push('/overlay?embedded=unity&surface=overlay')
    assert.equal(router.currentRoute.value.path, '/overlay')
    await router.push('/overlay?embedded=unity&surface=admin')
    assert.equal(router.currentRoute.value.path, '/admin')
})
test('native customer entry asks the opaque host to open operations without mounting it in the overlay', async t => {
    const { router, environment } = await fixture(t, { displayAuthenticated: true, permissions: { backup: true } })
    const messages = []
    environment.browser.chrome = { webview: { postMessage: message => messages.push(message) } }
    await router.push('/customer?embedded=unity&surface=overlay')
    assert.equal(router.currentRoute.value.path, '/group')
    assert.deepEqual(messages, [{ type: 'host_action', action: 'show_customer' }])
})
