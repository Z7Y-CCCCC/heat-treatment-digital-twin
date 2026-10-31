import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { deferred, installBrowser } from './helpers.mjs'

const source = new URL('../src/views/admin/components/ModelNameEditor.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'model-name' }).errors, [])
let code = compileScript(descriptor, { id: 'model-name' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) code = code.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], source).href : import.meta.resolve(match[2]))}`)
const { default: Editor } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Editor.render = () => null
function fixture(t, result, edit = true) {
  installBrowser(t)
  const before = { ...adminSession }
  Object.assign(adminSession, { authenticated: true, user: { role: 'viewer' }, pagePermissions: normalizePagePermissions({ models: { view: true, edit } }) })
  t.after(() => Object.assign(adminSession, before))
  const request = t.mock.method(adminApi, 'renameModel', result)
  const model = ref({ id: 'model-a', name: '原名称', metadata: '{"preserve":true}', file_path: '/assets/a.glb' })
  const disabled = ref(false), events = [], errors = [], busy = [], instance = ref(null)
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const app = renderer.createApp({ render: () => h(Editor, { ref: instance, model: model.value, disabled: disabled.value,
    onRenamed: patch => { events.push(patch); model.value.name = patch.name }, onError: message => errors.push(message), onSaving: value => { busy.push(value); disabled.value = value } }) })
  app.mount({}); t.after(() => app.unmount())
  return { state: instance.value.$.setupState, request, model, disabled, events, errors, busy, app }
}

test('rename trims the name and submits only that field, preserving model identity and metadata', async t => {
  const f = fixture(t, async () => ({ success: true, model: { id: 'model-a', name: '自定义名称' } }))
  await f.state.edit(); f.state.draft = '  自定义名称  '; await f.state.save()
  assert.deepEqual(f.request.mock.calls[0].arguments, ['model-a', '自定义名称'])
  assert.deepEqual(f.model.value, { id: 'model-a', name: '自定义名称', metadata: '{"preserve":true}', file_path: '/assets/a.glb' })
  assert.equal(f.state.editing, false); assert.equal(f.state.saved, true)
  assert.deepEqual(f.busy, [true, false]); assert.deepEqual(f.errors, [])
})
test('blank/overlong names never write; cancel and unchanged names discard without requests', async t => {
  const f = fixture(t, async () => { throw Error('unexpected request') })
  await f.state.edit(); f.state.draft = '  '; await f.state.save()
  f.state.draft = 'a'.repeat(121); await f.state.save()
  assert.equal(f.errors.length, 2); assert.equal(f.state.editing, true)
  await f.state.cancel(); assert.equal(f.state.draft, '原名称')
  await f.state.edit(); await f.state.save(); assert.equal(f.state.editing, false)
  assert.equal(f.request.mock.callCount(), 0)
})
test('a failed rename retains its draft for retry without changing the displayed model', async t => {
  const f = fixture(t, async () => ({ error: '保存失败' }))
  await f.state.edit(); f.state.draft = '待保存'; await f.state.save()
  assert.equal(f.state.editing, true); assert.equal(f.state.draft, '待保存'); assert.equal(f.model.value.name, '原名称')
  assert.deepEqual(f.errors, ['保存失败']); assert.deepEqual(f.events, []); assert.equal(f.state.saving, false)
})
test('duplicate saves coalesce and late responses cannot emit after unmount', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise)
  await f.state.edit(); f.state.draft = '新名称'; const saving = f.state.save(); await f.state.save()
  assert.equal(f.request.mock.callCount(), 1)
  f.app.unmount(); pending.resolve({ success: true, model: { id: 'model-a', name: '新名称' } }); await saving
  assert.deepEqual(f.events, []); assert.deepEqual(f.busy, [true, false])
})
test('read-only and busy editors cannot begin or submit a rename', async t => {
  const f = fixture(t, async () => { throw Error('unexpected request') }, false)
  await f.state.edit(); assert.equal(f.state.editing, false)
  f.state.editing = true; f.state.draft = '禁止写入'; await f.state.save()
  assert.equal(f.request.mock.callCount(), 0)
})
