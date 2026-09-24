import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, settle } from './helpers.mjs'

// Run the real SFC setup/load path; child renderers are irrelevant to the source
// selection and are stubbed so no canvas, GL context or browser is required.
const sourceUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
let compiled = compileScript(descriptor, { id: 'data-source-designer-test' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const specifier = match[2]
    const target = specifier.endsWith('.vue')
        ? 'data:text/javascript,export default {render:()=>null}'
        : specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier)
    compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Designer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Designer.render = () => null

function fixture(t, connections) {
    const environment = installBrowser(t)
    environment.browser.cancelAnimationFrame = () => {}
    environment.browser.requestAnimationFrame = () => 0
    environment.replace('ResizeObserver', class { observe() {} disconnect() {} })
    environment.replace('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ revision: 1, document: {} }))
    for (const method of ['getDevices', 'getDataPoints', 'getWorkshops', 'getLines']) t.mock.method(adminApi, method, async () => [])
    t.mock.method(adminApi, 'getRealtimePointValues', async () => ({ points: [] }))
    t.mock.method(adminApi, 'getDataSources', async () => ({ connections }))
    const renderer = createRenderer({
        createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
        setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
        patchProp() {}, insert() {}, remove() {}
    })
    const instance = ref(null)
    const app = renderer.createApp({ render: () => h(Designer, { ref: instance }) })
    app.mount({})
    environment.beforeRestore(() => app.unmount())
    return { instance }
}

test('designer keeps all database types but excludes both HTTP API discriminators from all database selectors', async t => {
    const sources = [
        { id: 'primary', type: 'mysql', sourceType: 'database', primary: true },
        ...['mysql', 'postgres', 'sqlserver', 'sqlite'].map(type => ({ id: `legacy_${type}`, type })),
        { id: 'api', sourceType: 'http_api', type: 'http_api' },
        { id: 'api_type_only', type: 'http_api' },
        { id: 'api_source_type_only', sourceType: 'http_api' }
    ]
    const { instance } = fixture(t, sources)
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.loading, false)
    assert.notEqual(state.status.tone, 'danger')
    assert.deepEqual(state.dataSources.map(source => source.id), ['primary', 'legacy_mysql', 'legacy_postgres', 'legacy_sqlserver', 'legacy_sqlite'])
    assert.equal(sources.length, 8, 'filtering must not mutate the API result')

    // Both ordinary datasets and business components share this filtered list.
    const selectors = descriptor.template.content.match(/<select\b[^>]*v-model="(?:dataset|selectedWidget\.data)\.connectionId"[^>]*>[\s\S]*?<\/select>/g)
    assert.equal(selectors?.length, 2)
    assert.ok(selectors.every(selector => selector.includes('v-for="source in dataSources"')))
})

test('an empty or malformed data-source response does not break designer loading', async t => {
    const { instance } = fixture(t, null)
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    assert.deepEqual(state.dataSources, [])
    assert.notEqual(state.status.tone, 'danger')
})

test('HUD preset adds an isolated view without changing the existing view or default', async t => {
    const { instance } = fixture(t, [])
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    const beforeWidgets = JSON.stringify(state.documentModel.widgets)
    const beforeViews = JSON.stringify(state.documentModel.scene.views)
    const defaultView = state.documentModel.scene.defaultViewId
    state.addWidgetPreset({ id: 'factory_hud_modules', label: '工厂总览 HUD 模块' })
    assert.equal(state.documentModel.scene.defaultViewId, defaultView)
    assert.equal(JSON.stringify(state.documentModel.widgets.slice(0,-4)), beforeWidgets)
    assert.equal(JSON.stringify(state.documentModel.scene.views.slice(0,-1)), beforeViews)
    const view = state.documentModel.scene.views.at(-1)
    assert.equal(view.id, 'factory_hud_modules')
    assert.deepEqual(view.componentState.show, state.documentModel.widgets.slice(-4).map(widget => widget.id))
    const count = state.documentModel.widgets.length
    state.addWidgetPreset({ id: 'factory_hud_modules', label: '工厂总览 HUD 模块' })
    assert.equal(state.documentModel.widgets.length, count, 'repeated click should focus, not duplicate')
})
