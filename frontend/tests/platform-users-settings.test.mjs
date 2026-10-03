import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/PlatformUsersSettings.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(url, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'users' }).errors, [])
let compiled = compileScript(descriptor, { id: 'users' }).content
compiled = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/runtime\/adminSession\.js['"]/, 'const {$1} = globalThis.__platformUsersFixtureApi')
compiled = compiled.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`)
let fixtureId = 0
async function fixture(t, api) {
  globalThis.__platformUsersFixtureApi = api
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
  assert.deepEqual(requests, [{ id: 'u1', body: { displayName: 'Updated', role: 'viewer', enabled: false, password: 'Changed-2026!', permissions: { view: true, launch: false, cast: false, backup: false } } }])
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
