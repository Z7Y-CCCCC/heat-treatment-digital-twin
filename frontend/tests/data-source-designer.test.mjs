import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { deferred, installBrowser, settle } from './helpers.mjs'
import { exportDashboardTemplate, importDashboardTemplate, dashboardTemplateReferences, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { applyTemplateFieldBindings, templateFieldBindings } from '../src/runtime/templateFieldMapping.js'

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
    t.mock.method(adminApi, 'getSettings', async () => ({}))
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

test('saving retains edits and the newer selection made while the server is pending', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const pending = deferred()
    let submitted
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => { submitted = document; return pending.promise })
    state.documentModel.name = '提交版本'
    const saving = state.saveDraft()
    state.documentModel.name = '保存期间的新修改'
    state.selectedIds = ['new-selection']
    pending.resolve({ revision: 2, document: submitted })
    assert.equal(await saving, true)
    assert.equal(submitted.name, '提交版本')
    assert.equal(state.documentModel.name, '保存期间的新修改')
    assert.equal(state.revision, 2)
    assert.equal(state.isDirty, true)
    assert.deepEqual(state.selectedIds, ['new-selection'])
})

test('revision conflicts preserve the local draft and never publish', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    t.mock.method(adminApi, 'saveDashboardDraft', async () => ({ error: '修订冲突，请刷新' }))
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => { throw new Error('must not publish') })
    state.documentModel.name = '必须保留的草稿'
    await state.publishVersion()
    assert.equal(state.documentModel.name, '必须保留的草稿')
    assert.equal(state.isDirty, true)
    assert.equal(publish.mock.callCount(), 0)
    assert.equal(state.status.tone, 'danger')
})

test('template import stays in the target scene and can be undone without publishing', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const before = JSON.stringify(state.documentModel)
    const source = normalizeDashboardDocument({ name: '复用方案', sceneId: 'another_scene', projectId: 'another_project' })
    const text = exportDashboardTemplate(source)
    const input = { files: [{ size: text.length, text: async () => text }], value: 'template.json' }
    await state.loadTemplateFile({ target: input })
    assert.equal(state.documentModel.name, '复用方案')
    assert.equal(state.documentModel.sceneId, JSON.parse(before).sceneId)
    assert.equal(state.documentModel.projectId, JSON.parse(before).projectId)
    assert.equal(state.isDirty, true)
    assert.equal(input.value, '')
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('template parser rejects malformed, oversized, duplicate and future templates', () => {
    const document = normalizeDashboardDocument()
    const template = JSON.parse(exportDashboardTemplate(document))
    assert.throws(() => importDashboardTemplate('{}', document), /版本/)
    assert.throws(() => importDashboardTemplate(' '.repeat(5 * 1024 * 1024 + 1), document), /5 MB/)
    template.document.widgets.push(template.document.widgets[0])
    assert.throws(() => importDashboardTemplate(JSON.stringify(template), document), /重复/)
    template.document.widgets.pop()
    template.document.schemaVersion = 999
    assert.throws(() => importDashboardTemplate(JSON.stringify(template), document), /升级/)
})

test('template rebind dialog blocks missing targets, maps shared references and supports undo', async t => {
    const { instance } = fixture(t, [{ id: 'new-db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    state.devices = [{ id: 'new-device', name: '新设备' }]
    state.points = [{ id: 'new-point', device_id: 'new-device', name: '新点位', category: 'analog', value_role: 'pressure', unit: 'bar' }]
    assert.equal(state.templateTargetLabel('points', { id: 1, device_id: 'new-device', label: '实际温度', name: 'actual_temp' }), '新设备（new-device） / 实际温度（actual_temp） · 点位 1')
    assert.equal(state.templateTargetLabel('points', { id: 2, device_id: 'unknown-device', name: 'running' }), 'unknown-device（unknown-device） / running · 点位 2')
    const source = normalizeDashboardDocument({ widgets: [
        { id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'old-device', pointId: 'old-point' }, events: [{ action: 'focus_device', deviceId: 'old-device' }] },
        { id: 'db', type: 'value', data: { mode: 'database', connectionId: 'old-db', datasets: [{ connectionId: 'old-db', table: 'samples', field: 'value' }] } }
    ] })
    const original = JSON.stringify(state.documentModel)
    const text = exportDashboardTemplate(source)
    await state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    assert.ok(state.templateImport)
    assert.equal(JSON.stringify(state.documentModel), original, 'no old IDs are installed before mapping')
    state.confirmTemplateImport()
    assert.match(state.templateImport.error, /选择/)
    Object.assign(state.templateMapping, { 'devices:old-device': 'new-device', 'points:old-point': 'new-point', 'connections:old-db': 'new-db' })
    state.confirmTemplateImport()
    assert.equal(state.templateImport, null)
    assert.ok(state.templateFieldImport, 'database references require a separate field confirmation')
    assert.equal(JSON.stringify(state.documentModel), original, 'field confirmation has not replaced the draft yet')
    state.confirmTemplateFieldImport(state.templateFieldImport.document)
    const plc = state.documentModel.widgets.find(widget => widget.id === 'plc')
    const db = state.documentModel.widgets.find(widget => widget.id === 'db')
    assert.equal(plc.data.deviceId, 'new-device')
    assert.equal(plc.data.pointId, 'new-point')
    assert.equal(plc.data.pointKey, 'analog.pressure')
    assert.equal(plc.data.path, 'analog.pressure')
    assert.equal(plc.data.unit, 'bar')
    assert.equal(plc.events[0].deviceId, 'new-device')
    assert.equal(db.data.connectionId, 'new-db')
    assert.equal(db.data.datasets[0].connectionId, 'new-db')
    assert.equal(dashboardTemplateReferences(state.documentModel).some(ref => ref.id.startsWith('old-')), false)
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), original)
})

test('mapping rejects wrong point ownership, missing IDs and incompatible source types', () => {
    const document = normalizeDashboardDocument({ widgets: [{ id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'a', pointId: 'b' } }] })
    const mapping = { 'devices:a': 'x', 'points:b': 'y' }
    const catalog = { devices: [{ id: 'x' }], points: [{ id: 'y', device_id: 'z' }] }
    assert.throws(() => rebindDashboardTemplate(document, mapping, catalog), /不属于/)
    assert.throws(() => rebindDashboardTemplate(document, { ...mapping, 'devices:a': 'missing' }, catalog), /有效目标/)
    const http = normalizeDashboardDocument({ widgets: [{ id: 'api', type: 'value', data: { mode: 'http_api', connectionId: 'old' } }] })
    assert.throws(() => rebindDashboardTemplate(http, { 'connections:old': 'db' }, { connections: [{ id: 'db', type: 'mysql' }] }), /类型不匹配/)
})

test('confirmed template field mapping is saved before publishing and rejects draft races', async t => {
    const { instance } = fixture(t, [{ id: 'db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    const source = normalizeDashboardDocument({ widgets: [{ id: 'mapped', type: 'value', data: { mode: 'database', connectionId: 'old', datasets: [{ connectionId: 'old', table: 'old_table', field: 'old_field' }] } }] })
    const text = exportDashboardTemplate(source)
    const load = () => state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    await load()
    state.templateMapping['connections:old'] = 'db'
    state.confirmTemplateImport()
    const pending = state.templateFieldImport.document
    const beforeKey = JSON.stringify(state.documentModel)
    state.handleKeydown({ key: 'Delete', target: {}, preventDefault() {} })
    assert.equal(JSON.stringify(state.documentModel), beforeKey, 'modal keyboard input must not alter the background draft')
    state.documentModel.name = 'newer edit'
    state.confirmTemplateFieldImport(pending)
    assert.equal(state.documentModel.name, 'newer edit')
    assert.equal(state.templateFieldImport, null)
    assert.match(state.status.text, /草稿已改变/)
    await load()
    state.templateMapping['connections:old'] = 'db'
    state.confirmTemplateImport()
    const rows = templateFieldBindings(state.templateFieldImport.document)
    rows[0].target = { ...rows[0].source, table: 'target_table', field: 'target_field' }
    state.confirmTemplateFieldImport(applyTemplateFieldBindings(state.templateFieldImport.document, rows))
    let saved
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => { saved = JSON.parse(JSON.stringify(document)); return { revision: 2, document: saved } })
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => {
      assert.equal(saved.widgets.find(widget => widget.id === 'mapped').data.datasets[0].field, 'target_field')
      assert.equal(saved.widgets.find(widget => widget.id === 'mapped').data.datasets[0].connectionId, 'db')
      return { release: { id: 'mapped-release', version: '1.0.2' } }
    })
    await state.publishVersion()
    assert.equal(publish.mock.callCount(), 1)
})

test('project bundle drafts enter data rebinding directly while current factory IDs are preselected', async t => {
    const { instance } = fixture(t, [{ id: 'configured-db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    state.devices = [{ id: 'imported-device', name: '迁入设备' }]
    state.points = [{ id: 'imported-point', device_id: 'imported-device', name: 'temperature', category: 'analog' }]
    state.documentModel = normalizeDashboardDocument({ widgets: [
        { id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'imported-device', pointId: 'imported-point' } },
        { id: 'metric', type: 'value', data: { mode: 'database', connectionId: 'unconfigured_migration_a', datasets: [{ connectionId: 'unconfigured_migration_a', table: 'source_table', field: 'temp' }] } }
    ] })
    const before = JSON.stringify(state.documentModel)
    state.rebindCurrentTemplate()
    assert.equal(state.templateMapping['devices:imported-device'], 'imported-device')
    assert.equal(state.templateMapping['points:imported-point'], 'imported-point')
    assert.equal(state.templateMapping['connections:unconfigured_migration_a'], undefined)
    state.confirmTemplateImport()
    assert.match(state.templateImport.error, /选择/)
    assert.equal(JSON.stringify(state.documentModel), before)
    state.templateMapping['connections:unconfigured_migration_a'] = 'configured-db'
    state.confirmTemplateImport()
    assert.ok(state.templateFieldImport)
    const bindings = templateFieldBindings(state.templateFieldImport.document)
    assert.equal(bindings[0].source.connectionId, 'configured-db')
    bindings[0].target = { ...bindings[0].source, table: 'target_table', field: 'temperature' }
    state.confirmTemplateFieldImport(applyTemplateFieldBindings(state.templateFieldImport.document, bindings))
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'plc').data.pointId, 'imported-point')
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'metric').data.datasets[0].field, 'temperature')
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('view targets and focus actions map to the new hierarchy without changing internal view IDs', () => {
    const document = normalizeDashboardDocument({ scene: { views: [{ id: 'custom', targetType: 'line', targetId: 'old-line' }] }, widgets: [
        { id: 'label', type: 'text', content: { deviceIds: ['old-device'] }, visibility: { rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'old-device' }] }, events: [{ action: 'focus_workshop', workshopId: 'old-workshop' }, { action: 'switch_view', viewId: 'custom' }] }
    ] })
    const mapped = rebindDashboardTemplate(document, { 'lines:old-line': 'new-line', 'workshops:old-workshop': 'new-workshop', 'devices:old-device': 'new-device' }, { lines: [{ id: 'new-line' }], workshops: [{ id: 'new-workshop' }], devices: [{ id: 'new-device' }] })
    assert.equal(mapped.scene.views.find(view => view.id === 'custom').targetId, 'new-line')
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').events[0].workshopId, 'new-workshop')
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').events[1].viewId, 'custom')
    assert.deepEqual(mapped.widgets.find(widget => widget.id === 'label').content.deviceIds, ['new-device'])
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').visibility.rules[0].value, 'new-device')
})

test('publish success reports the saved release without claiming an unacknowledged runtime update', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => ({ revision: 2, document }))
    t.mock.method(adminApi, 'publishDashboard', async () => ({ release: { id: 'release-test', version: '1.0.1' } }))
    await state.publishVersion()
    assert.match(state.status.text, /1\.0\.1 已发布/)
    assert.doesNotMatch(state.status.text, /已收到更新/)
    assert.match(state.status.text, /连接后将加载/)
})

test('canvas resolution follows template import and undo instead of retaining the last preset', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const text = exportDashboardTemplate(state.documentModel)
    state.canvasPreset = '2560x1440'
    state.applyCanvasPreset()
    assert.equal(state.canvasPreset, '2560x1440')
    await state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    assert.equal(state.canvasPreset, '1920x1080')
    state.undo()
    assert.equal(state.canvasPreset, '2560x1440')
})

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
    assert.deepEqual(state.httpApiSources.map(source => source.id), ['api', 'api_type_only', 'api_source_type_only'])
    assert.equal(sources.length, 8, 'filtering must not mutate the API result')

    // Both ordinary datasets and business components share this filtered list.
    const selectors = descriptor.template.content.match(/<select\b[^>]*v-model="(?:dataset|selectedWidget\.data)\.connectionId"[^>]*>[\s\S]*?<\/select>/g)
    assert.equal(selectors?.length, 3)
    assert.equal(selectors.filter(selector => selector.includes('v-for="source in dataSources"')).length, 2)
    assert.equal(selectors.filter(selector => selector.includes('v-for="source in httpApiSources"')).length, 1)
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
