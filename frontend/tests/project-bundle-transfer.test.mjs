import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { getFactoryScope, FACTORY_DIRECTORY_CHANGE_EVENT } from '../src/runtime/factoryScope.js'
import { deferred, installBrowser, json, settle } from './helpers.mjs'

const sourceUrl = new URL('../src/views/admin/components/ProjectBundleTransfer.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: sourceUrl.pathname, id: 'bundle-transfer' }).errors, [])
let compiled = compileScript(descriptor, { id: 'bundle-transfer' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) compiled = compiled.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], sourceUrl).href : import.meta.resolve(match[2]))}`)
const { default: Transfer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Transfer.render = () => null

const inspectionResult = (name = '来源工厂', sha256 = 'a'.repeat(64)) => ({ success: true, sha256, inspection: { factoryName: name, counts: { devices: 2 }, assetCount: 1, assetBytes: 100, sharedAppearance: { available: true }, warnings: ['请重配置连接'] } })
const file = name => new File(['zip contents'], name, { type: 'application/zip' })
function fixture(t, fetch) {
  const environment = installBrowser(t)
  const storage = new Map([['digital_twin_factory_scope_v1', 'original-factory']])
  environment.browser.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const events = [], imported = [], requests = []
  environment.browser.dispatchEvent = event => { events.push(event); return true }
  environment.replace('fetch', async (url, options) => { requests.push({ url: String(url), options }); return fetch(String(url), options) })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null)
  const app = renderer.createApp({ render: () => h(Transfer, { ref: instance, onImported: value => imported.push(value) }) })
  app.mount({})
  environment.beforeRestore(() => app.unmount())
  return { state: instance.value.$.setupState, events, imported, requests, app }
}

test('bundle inspection gates import; SHA/name/default appearance flag travel with the inspected file', async t => {
  const { state, requests, events, imported } = fixture(t, async url => url.endsWith('/inspect') ? json(inspectionResult()) : json({ success: true, factoryId: 'new-factory', name: '目标工厂' }))
  await state.request('import')
  assert.equal(requests.length, 0)
  const selected = file('factory.zip')
  state.chooseFile({ target: { files: [selected] } })
  await state.request('import')
  assert.equal(requests.length, 0)
  await state.request('inspect')
  assert.equal(state.newName, '来源工厂（副本）')
  assert.equal(state.applySharedAppearance, false)
  state.newName = '  目标工厂  '
  await state.request('import')
  assert.equal(requests.length, 2)
  const request = requests[1]
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.body.get('file').name, 'factory.zip')
  assert.equal(request.options.body.get('name'), '目标工厂')
  assert.equal(request.options.body.get('inspectedSha256'), 'a'.repeat(64))
  assert.equal(request.options.body.get('applySharedAppearance'), 'false')
  assert.equal(request.options.headers.get('X-Factory-Id'), 'original-factory')
  assert.equal(imported[0].factoryId, 'new-factory')
  assert.deepEqual(events.map(event => event.type), [FACTORY_DIRECTORY_CHANGE_EVENT])
  assert.equal(getFactoryScope(), 'original-factory')
  assert.match(state.message, /当前编辑工厂未切换/)
  assert.equal(state.inspection, null)
  assert.equal(state.selectedFile, null)
})

test('shared appearance is applied only after explicit selection; changing files clears inspection and opt-in', async t => {
  const { state, requests } = fixture(t, async url => url.endsWith('/inspect') ? json(inspectionResult()) : json({ success: true, factoryId: 'new', name: '副本' }))
  state.chooseFile({ target: { files: [file('first.zip')] } })
  await state.request('inspect')
  state.applySharedAppearance = true
  await state.request('import')
  assert.equal(requests.at(-1).options.body.get('applySharedAppearance'), 'true')
  state.chooseFile({ target: { files: [file('second.zip')] } })
  assert.equal(state.inspection, null)
  assert.equal(state.inspectedSha256, '')
  assert.equal(state.newName, '')
  assert.equal(state.applySharedAppearance, false)
  await state.request('import')
  assert.equal(requests.length, 2)
  assert.match(state.error, /先校验/)
})

test('import failure retains selected file and preview for retry without success events', async t => {
  const { state, events, imported } = fixture(t, async url => url.endsWith('/inspect') ? json(inspectionResult()) : json({ success: false, error: '文件摘要不匹配，请重新校验' }, 409))
  state.chooseFile({ target: { files: [file('retained.zip')] } })
  await state.request('inspect')
  await state.request('import')
  assert.equal(state.selectedFile.name, 'retained.zip')
  assert.equal(state.inspection.factoryName, '来源工厂')
  assert.match(state.error, /摘要不匹配/)
  assert.equal(state.busy, '')
  assert.equal(state.message, '')
  assert.equal(events.length, 0)
  assert.equal(imported.length, 0)
})

test('changing files during response-body parsing cannot restore obsolete inspection or SHA', async t => {
  const body = deferred()
  const { state } = fixture(t, async () => ({ ok: true, status: 200, json: () => body.promise }))
  state.chooseFile({ target: { files: [file('old.zip')] } })
  const pending = state.request('inspect')
  await settle()
  state.chooseFile({ target: { files: [file('new.zip')] } })
  body.resolve(inspectionResult('obsolete', 'b'.repeat(64)))
  await pending
  assert.equal(state.selectedFile.name, 'new.zip')
  assert.equal(state.inspection, null)
  assert.equal(state.inspectedSha256, '')
  assert.equal(state.newName, '')
})

test('duplicate import clicks coalesce and unmounted requests emit no late success', async t => {
  const body = deferred()
  const { state, requests, app, imported, events } = fixture(t, async url => url.endsWith('/inspect') ? json(inspectionResult()) : ({ ok: true, status: 200, json: () => body.promise }))
  state.chooseFile({ target: { files: [file('factory.zip')] } })
  await state.request('inspect')
  const pending = state.request('import')
  await state.request('import')
  await settle()
  assert.equal(requests.length, 2)
  app.unmount()
  body.resolve({ success: true, factoryId: 'new', name: '副本' })
  await pending
  assert.equal(imported.length, 0)
  assert.equal(events.length, 0)
})

test('export body finishing after unmount cannot start a stale download', async t => {
  const body = deferred()
  const { state, app } = fixture(t, async () => ({ ok: true, status: 200, blob: () => body.promise }))
  const create = t.mock.method(URL, 'createObjectURL', () => { throw new Error('stale download must not be created') })
  const pending = state.request('export')
  await settle()
  app.unmount()
  body.resolve(new Blob(['zip']))
  await pending
  assert.equal(create.mock.callCount(), 0)
  assert.equal(state.message, '')
})

test('export uses the chosen source without switching the current editor factory', async t => {
  const { state, requests, events } = fixture(t, async () => json({ success: false, error: 'missing factory' }, 404))
  state.exportFactoryId = 'chosen-source'
  await state.request('export')
  assert.equal(requests[0].options.headers.get('X-Factory-Id'), 'chosen-source')
  assert.equal(getFactoryScope(), 'original-factory')
  assert.equal(events.length, 0)
  assert.match(state.error, /missing factory/)
})
