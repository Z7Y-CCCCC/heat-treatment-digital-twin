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
// This fixture runs setup logic with a null render; the shared visual control
// has its own tests and the real account/factory UI is covered in Playwright.
compiled = compiled.replace(/import EnableCapsule from ['"][^'"]+EnableCapsule\.vue['"]/, 'const EnableCapsule = {}')
compiled = compiled.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`)
compiled = compiled.replace("from '../../../../../shared/accountPolicy.mjs'", `from ${JSON.stringify(new URL('../../shared/accountPolicy.mjs', import.meta.url).href)}`)
compiled = compiled.replace("from '../../../../../shared/pagePermissions.mjs'", `from ${JSON.stringify(new URL('../../shared/pagePermissions.mjs', import.meta.url).href)}`)
compiled = compiled.replace("from '../../../../../shared/accountTemplates.mjs'", `from ${JSON.stringify(new URL('../../shared/accountTemplates.mjs', import.meta.url).href)}`)
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
  assert.deepEqual(state.notice, { message: 'account disabled by policy', type: 'error' })
  assert.equal(state.busy, false)
})

test('creation errors pop up without closing or resetting the draft; retry replaces the stale error', async t => {
  let reject = true, creates = 0
  const state = await fixture(t, { listPlatformUsers: async () => [], createPlatformUser: async () => {
    creates++
    if (reject) throw new Error('账号需为 2–32 位中文、字母、数字、下划线或短横线，以中文或字母开头；名称和角色须有效')
  } })
  state.openCreate()
  Object.assign(state.editor, { username: 'fixture', displayName: '尚未保存', password: 'FixturePassword-2026!' })
  state.editor.pagePermissions.models.view = true
  await state.saveEditor()
  assert.equal(state.editorOpen, true)
  assert.equal(state.editor.username, 'fixture')
  assert.equal(state.editor.displayName, '尚未保存')
  assert.equal(state.editor.password, 'FixturePassword-2026!')
  assert.equal(state.editor.pagePermissions.models.view, true)
  assert.equal(state.notice.type, 'error')
  assert.match(state.notice.message, /账号需为/)
  assert.equal(state.busy, false)
  state.clearNotice()
  assert.equal(state.notice, null)
  assert.equal(state.editorOpen, true)
  reject = false
  await state.saveEditor()
  assert.equal(creates, 2)
  assert.deepEqual(state.notice, { message: '账户已创建', type: 'success' })
  assert.equal(state.editorOpen, false)
  state.openCreate()
  assert.equal(state.notice, null, 'opening another editor must not carry stale feedback')
})

test('saving cannot be double-submitted or closed while pending', async t => {
  const response = deferred()
  let creates = 0
  const state = await fixture(t, { listPlatformUsers: async () => [], createPlatformUser: async () => { creates++; await response.promise } })
  state.openCreate()
  const pending = state.saveEditor()
  await state.saveEditor()
  state.closeEditor()
  assert.equal(creates, 1)
  assert.equal(state.editorOpen, true)
  response.reject(new Error('request unavailable'))
  await pending
  assert.equal(state.busy, false)
  state.closeEditor()
  assert.equal(state.editorOpen, false)
  assert.equal(state.notice, null)
})

test('list and deletion failures use the popup rather than stale inline errors', async t => {
  let listFails = false
  const state = await fixture(t, { listPlatformUsers: async () => { if (listFails) throw new Error('list offline'); return [] },
    deletePlatformUser: async () => { throw new Error('delete denied') } })
  listFails = true
  await state.loadUsers()
  assert.deepEqual(state.notice, { message: 'list offline', type: 'error' })
  state.openEdit({ id: 'u1', username: 'fixture', displayName: 'Keep me', role: 'viewer', enabled: true })
  assert.equal(state.notice, null)
  await state.removeEditorUser()
  await state.removeEditorUser()
  assert.deepEqual(state.notice, { message: 'delete denied', type: 'error' })
  assert.equal(state.editorOpen, true)
  assert.equal(state.editor.displayName, 'Keep me')
})

test('feedback is teleported above the editor; the close button is transparent at its upper-right corner', () => {
  assert.doesNotMatch(descriptor.template.content, /users-message|v-if="failed"/)
  assert.match(descriptor.template.content, /<Teleport to="body">\s*<Transition name="user-notice">/)
  assert.match(descriptor.template.content, /:role="notice.type === 'error' \? 'alert' : 'status'"/)
  const css = descriptor.styles.map(style => style.content).join('\n')
  assert.match(css, /\.editor-close\{[^}]*position:absolute;top:8px;right:8px;[^}]*background:transparent/)
  assert.match(css, /\.user-editor-dialog\{[^}]*display:flex;flex-direction:column;[^}]*overflow:hidden/)
  assert.match(css, /\.editor-form\{[^}]*min-height:0;overflow-y:auto/)
  assert.match(css, /\.user-notice\{[^}]*z-index:10020/)
})

test('account editors dismiss only explicitly, never from backdrop clicks or text-selection pointer gestures', () => {
  const backdrop = descriptor.template.content.match(/<div[^>]*class="user-editor-backdrop"[^>]*>/)?.[0]
  assert.ok(backdrop)
  assert.doesNotMatch(backdrop, /@(click|mouse\w*|pointer\w*|touch\w*)/)
  assert.match(backdrop, /@keydown\.esc\.stop\.prevent="closeEditor"/)
  assert.match(descriptor.template.content, /class="editor-close"[^>]*@click="closeEditor"/)
  assert.match(descriptor.template.content, /class="editor-cancel"[^>]*@click="closeEditor"/)
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
