import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { installBrowser, settle } from './helpers.mjs'

const source = new URL('../src/views/admin/components/GroupPortalSettings.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'map-tabs' }).errors, [])
let code = compileScript(descriptor, { id: 'map-tabs' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const name = match[2]
    code = code.replace(match[0], `from ${JSON.stringify(name.endsWith('.vue') ? 'data:text/javascript,export default {}' : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name))}`)
}
const { default: Settings } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Settings.render = () => null
async function fixture(t, edit = true) {
    const env = installBrowser(t), before = { ...adminSession }
    Object.assign(adminSession, { authenticated: true, user: { role: 'viewer' }, pagePermissions: normalizePagePermissions({ 'platform.map': { view: true, edit } }) })
    env.beforeRestore(() => Object.assign(adminSession, before))
    t.mock.method(adminApi, 'getSettings', async () => ({ group_portal_config: {} }))
    t.mock.method(adminApi, 'getDataSources', async () => ({ connections: [] }))
    t.mock.method(adminApi, 'listFactories', async () => ({ activeFactoryId: 'factory_default' }))
    const writes = t.mock.method(adminApi, 'saveSettings', async () => ({ success: true }))
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = ref(null), app = renderer.createApp({ render: () => h(Settings, { ref: instance }) })
    app.mount({}); env.beforeRestore(() => app.unmount()); await settle()
    return { state: instance.value.$.setupState, exposed: instance.value, writes }
}

test('tab switching does not discard drafts, reset the map level or issue writes', async t => {
    const { state, writes } = await fixture(t)
    assert.deepEqual(state.sectionTabs.map(tab => tab.key), ['brand', 'logo', 'theme', 'map', 'components', 'data', 'layout'])
    state.form.brandTitle = '保留草稿'; state.selectedLevel = 'city'
    state.sectionBody = { scrollTop: 100 }; state.activeDrag = { key: 'brand' }
    state.selectSection('data')
    assert.equal(state.activeSection, 'data'); assert.equal(state.levelSection, true); assert.equal(state.componentSection, true)
    assert.equal(state.form.brandTitle, '保留草稿'); assert.equal(state.selectedLevel, 'city')
    assert.equal(state.sectionBody.scrollTop, 0); assert.equal(state.activeDrag, null)
    state.selectSection('unknown'); assert.equal(state.activeSection, 'data')
    assert.equal(writes.mock.callCount(), 0)
})

test('designer module selection opens the matching editable section instead of leaving it hidden', async t => {
    const { state, exposed } = await fixture(t)
    state.selectSection('brand'); exposed.selectComponent('facts', 'province')
    assert.equal(state.activeSection, 'components'); assert.equal(state.selectedComponent, 'facts'); assert.equal(state.selectedLevel, 'province')
    await settle(); assert.equal(state.selectedMetric, 'factsFactoryCount')
})

test('saving from another category reveals an invalid hidden input before any API write', async t => {
    const { state, writes } = await fixture(t)
    let focused = false, reported = false
    state.settingsForm = { querySelector: () => ({ closest: () => ({ dataset: { mapSection: 'theme' } }), focus: () => { focused = true }, reportValidity: () => { reported = true } }) }
    state.selectSection('layout'); await state.save()
    assert.equal(state.activeSection, 'theme'); assert.equal(state.failed, true)
    assert.equal(focused, true); assert.equal(reported, true); assert.equal(writes.mock.callCount(), 0)
})

test('a read-only user may switch categories but cannot drag custom divs inside the disabled fieldset', async t => {
    const { state, writes } = await fixture(t, false)
    state.selectSection('layout'); assert.equal(state.activeSection, 'layout')
    state.layoutStage = { getBoundingClientRect: () => { throw new Error('must not start a drag') } }
    state.startLayoutDrag('brand', { button: 0 }); assert.equal(state.activeDrag, null)
    await state.save(); assert.equal(writes.mock.callCount(), 0)
})
