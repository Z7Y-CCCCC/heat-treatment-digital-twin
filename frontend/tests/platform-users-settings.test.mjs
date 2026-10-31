import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { getAdminPageCatalog as localCatalog } from '../../shared/adminPages.mjs'
import { settle, deferred } from './helpers.mjs'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'

const url = new URL('../src/views/admin/components/PlatformUsersSettings.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(url, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'users' }).errors, [])
let compiled = compileScript(descriptor, { id: 'users' }).content
compiled = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/runtime\/adminSession\.js['"]/, 'const {$1} = globalThis.__platformUsersFixtureApi')
compiled = compiled.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`)
compiled = compiled.replace("from '../../../../../shared/pagePermissions.mjs'", `from ${JSON.stringify(new URL('../../shared/pagePermissions.mjs', import.meta.url).href)}`)
let fixtureId = 0
async function fixture(t, api) {
  globalThis.__platformUsersFixtureApi = { adminPageCatalog: ref(localCatalog()), getAdminPageCatalog: async () => localCatalog(), ...api }
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled + '\n// fixture ' + fixtureId++).toString('base64')}`)
  delete globalThis.__platformUsersFixtureApi
  Component.render = () => null
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null)
  const app = renderer.createApp({ render: () => h(Component, { ref: instance }) })
  app.mount({})
  t.after(() => app.unmount())
  await settle()
  return instance.value.$.setupState
}

test('editing a returned account only submits delegable permissions and preserves explicit denials', async t => {
  const user = { id: 'u1', username: 'viewer', displayName: 'Viewer', role: 'viewer', enabled: true, permissions: { view: true, launch: false, cast: false, backup: false, edit: false, manageUsers: false } }
  const requests = []
  const state = await fixture(t, { listPlatformUsers: async () => [user], updatePlatformUser: async (id, body) => requests.push({ id, body }) })
  state.openEdit(state.users[0])
  state.editor.displayName = 'Updated'
  state.editor.enabled = false
  state.replacementPassword = 'Changed-2026!'
  await state.saveEditor()
  assert.deepEqual(requests, [{ id: 'u1', body: { displayName: 'Updated', role: 'viewer', enabled: false, password: 'Changed-2026!', permissions: { view: true, launch: false, cast: false, backup: false }, pagePermissions: normalizePagePermissions() } }])
  assert.equal(state.editorOpen, false)
})

test('failed account edit keeps the editor and draft visible with the backend reason', async t => {
  const state = await fixture(t, { listPlatformUsers: async () => [], updatePlatformUser: async () => { throw new Error('account disabled by policy') } })
  state.openEdit({ id: 'u1', username: 'viewer', displayName: 'Draft', role: 'viewer', enabled: true })
  await state.saveEditor()
  assert.equal(state.editorOpen, true)
  assert.equal(state.editor.displayName, 'Draft')
  assert.equal(state.message, 'account disabled by policy')
  assert.equal(state.failed, true)
  assert.equal(state.busy, false)
})

test('page matrix supports read-only templates, view dependencies and saved per-user grants', async t => {
  const requests = []
  const state = await fixture(t, { listPlatformUsers: async () => [], updatePlatformUser: async (id, body) => requests.push(body) })
  state.openEdit({ id: 'u1', username: 'author', role: 'viewer', displayName: 'Author', enabled: true,
    pagePermissions: { models: { view: true, edit: true } } })
  assert.equal(state.editor.pagePermissions.models.edit, true)
  state.setPagePreset('view')
  assert.equal(state.editor.pagePermissions.models.view, true)
  assert.equal(state.editor.pagePermissions.models.edit, false)
  assert.equal(state.editor.pagePermissions.users.view, false)
  state.editor.pagePermissions.models.edit = true
  state.editor.pagePermissions.models.view = false
  state.changePageView({ key: 'models', actions: ['view', 'edit', 'delete'] })
  assert.equal(state.editor.pagePermissions.models.edit, false)
  state.setPagePreset('none')
  state.editor.pagePermissions.devices.view = true
  await state.saveEditor()
  assert.equal(requests[0].pagePermissions.devices.view, true)
  assert.equal(requests[0].pagePermissions.models.view, false)
})

test('an open permission editor learns new pages without resetting unsaved account fields or grants', async t => {
  const catalog = ref(localCatalog())
  let response = null
  const state = await fixture(t, { adminPageCatalog: catalog, listPlatformUsers: async () => [],
    getAdminPageCatalog: async () => { if (response) catalog.value = await response.promise } })
  state.openCreate()
  await settle()
  state.editor.displayName = '尚未保存的账户名称'
  state.editor.pagePermissions.models.view = true
  state.editor.pagePermissions.models.edit = true
  response = deferred()
  const pending = state.refreshPageCatalog()
  state.editor.pagePermissions.devices.view = true
  response.resolve([...catalog.value, { key: 'new-page', label: '新增页面', actions: ['view', 'edit'], ownerOnly: false }])
  await pending
  assert.ok(state.pages.some(p => p.key === 'new-page'))
  assert.deepEqual(state.editor.pagePermissions['new-page'], { view: false, edit: false })
  assert.equal(state.editor.pagePermissions.models.edit, true)
  assert.equal(state.editor.pagePermissions.devices.view, true)
  assert.equal(state.editor.displayName, '尚未保存的账户名称')
  assert.equal(state.editorOpen, true)
  state.setPagePreset('view')
  assert.equal(state.editor.pagePermissions['new-page'].view, true)
  assert.equal(state.editor.pagePermissions['new-page'].edit, false)
})

test('a failed metadata refresh retains the permission draft and can retry', async t => {
  let fail = false
  const state = await fixture(t, { listPlatformUsers: async () => [], getAdminPageCatalog: async () => { if (fail) throw new Error('offline') } })
  state.openCreate()
  await settle()
  state.editor.pagePermissions.models.view = true
  fail = true
  await state.refreshPageCatalog()
  assert.match(state.catalogError, /重试/)
  assert.equal(state.editor.pagePermissions.models.view, true)
  fail = false
  await state.refreshPageCatalog()
  assert.equal(state.catalogError, '')
  assert.equal(state.editor.pagePermissions.models.view, true)
})
