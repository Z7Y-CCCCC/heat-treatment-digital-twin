import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, reactive, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { adminApi } from '../src/config/factoryConfig.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

const access = reactive({ permissions: {} })
test.mock.module('../src/runtime/adminSession.js', { namedExports: {
    adminSession: access, startAdminSessionTracking() {}, stopAdminSessionTracking() {}, logoutCurrentAdminAccount: async () => {}
} })
const source = new URL('../src/views/CustomerOperations.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'customer-check' }).errors, [])
let code = compileScript(descriptor, { id: 'customer-check' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const name = match[2]
    const resolved = name.endsWith('.vue') ? 'data:text/javascript,export default {}' : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name)
    code = code.replace(match[0], `from ${JSON.stringify(resolved)}`)
}
const { default: Customer } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Customer.render = () => null
function fixture(t, permissions = { backup: true }) {
    const environment = installBrowser(t)
    access.permissions = permissions
    const cast = t.mock.method(adminApi, 'getCastDevices', async () => ({ devices: [{ id: 'screen-a' }], cast: { active: false } }))
    const database = t.mock.method(adminApi, 'getDatabaseBackups', async () => ({ backups: [{ filename: 'saved.sql.gz' }] }))
    const site = t.mock.method(adminApi, 'getSiteBackups', async () => ({ backups: [{ filename: 'saved.zip' }] }))
    const create = t.mock.method(adminApi, 'createDatabaseBackup', async () => ({ success: true, backup: { filename: 'new.sql.gz' } }))
    const createSite = t.mock.method(adminApi, 'createSiteBackup', async () => ({ success: true, backup: { filename: 'new.zip' } }))
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = ref(null)
    const app = renderer.createApp({ render: () => h(Customer, { ref: instance }) })
    const routes = []
    app.provide(routerKey, { push: route => routes.push(route) })
    app.provide(routeLocationKey, { query: {} })
    function mount() { app.mount({}); environment.beforeRestore(() => app.unmount()); return instance.value.$.setupState }
    return { mount, app, environment, routes, cast, database, site, create, createSite }
}
test('customer page loads only the capabilities granted to the account', async t => {
    const view = fixture(t), state = view.mount()
    await settle()
    assert.equal(view.cast.mock.callCount(), 0)
    assert.deepEqual(state.databaseBackups.map(item => item.filename), ['saved.sql.gz'])
    assert.deepEqual(state.siteBackups.map(item => item.filename), ['saved.zip'])
    state.returnToDashboard()
    assert.deepEqual(view.routes, [{ path: '/group' }])
})
test('customer command errors never claim success or clear the last known backup list', async t => {
    const view = fixture(t), state = view.mount()
    await settle()
    view.create.mock.mockImplementation(async () => ({ success: false, error: 'permission denied' }))
    await state.createDatabaseBackup()
    assert.equal(state.failure, true)
    assert.match(state.message, /permission denied/)
    assert.equal(state.busy, '')
    assert.equal(state.databaseBackups[0].filename, 'saved.sql.gz')
})
test('cast-only customer page does not request backup data and reports failed cast commands', async t => {
    const view = fixture(t, { cast: true }), state = view.mount()
    await settle()
    assert.equal(view.database.mock.callCount(), 0)
    assert.equal(view.site.mock.callCount(), 0)
    assert.equal(state.selectedDeviceId, 'screen-a')
    t.mock.method(adminApi, 'startCast', async () => ({ success: false, error: 'screen offline' }))
    await state.startCasting()
    assert.equal(state.failure, true)
    assert.match(state.message, /screen offline/)
    assert.equal(state.castStatus.active, false)
})
test('duplicate customer backup clicks coalesce until the first request completes', async t => {
    const view = fixture(t), state = view.mount()
    await settle()
    const pending = deferred()
    view.create.mock.mockImplementation(() => pending.promise)
    const first = state.createDatabaseBackup()
    await state.createDatabaseBackup()
    assert.equal(view.create.mock.callCount(), 1)
    pending.resolve({ success: true, backup: { filename: 'new.sql.gz' } })
    await first
    assert.equal(state.databaseBackups[0].filename, 'new.sql.gz')
})
test('a delayed initial backup read cannot erase a newly created customer backup', async t => {
    const view = fixture(t), pending = deferred()
    view.database.mock.mockImplementation(() => pending.promise)
    const state = view.mount()
    await state.createDatabaseBackup()
    pending.resolve({ backups: [{ filename: 'old.sql.gz' }] })
    await settle()
    assert.equal(state.databaseBackups[0].filename, 'new.sql.gz')
})
test('customer backup read failures preserve good rows while refreshing the successful list', async t => {
    const view = fixture(t), state = view.mount()
    await settle()
    view.database.mock.mockImplementation(async () => ({ success: false, error: 'offline' }))
    view.site.mock.mockImplementation(async () => ({ backups: [{ filename: 'fresh.zip' }] }))
    await state.loadBackups()
    assert.equal(state.databaseBackups[0]?.filename, 'saved.sql.gz')
    assert.equal(state.siteBackups[0].filename, 'fresh.zip')
    assert.equal(state.failure, true)
    assert.match(state.message, /offline/)
})
test('delayed site listing cannot erase a new site backup or block the database listing', async t => {
    const view = fixture(t), pending = deferred()
    view.site.mock.mockImplementation(() => pending.promise)
    const state = view.mount()
    await state.createSiteBackup()
    pending.resolve({ backups: [{ filename: 'old.zip' }] })
    await settle()
    assert.equal(state.siteBackups[0].filename, 'new.zip')
    assert.equal(state.databaseBackups[0].filename, 'saved.sql.gz')
})
test('unmount invalidates pending customer list and command results', async t => {
    const view = fixture(t), pendingList = deferred(), pendingCreate = deferred()
    view.database.mock.mockImplementation(() => pendingList.promise)
    view.create.mock.mockImplementation(() => pendingCreate.promise)
    const state = view.mount()
    const creating = state.createDatabaseBackup()
    view.app.unmount()
    pendingList.resolve({ backups: [{ filename: 'late-list.sql.gz' }] })
    pendingCreate.resolve({ success: true, backup: { filename: 'late-create.sql.gz' } })
    await creating; await settle()
    assert.equal(state.databaseBackups.length, 0)
    assert.equal(state.message, '')
})
