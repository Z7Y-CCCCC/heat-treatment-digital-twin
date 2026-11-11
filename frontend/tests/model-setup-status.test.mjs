import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { computed, ref } from 'vue'
import { loadingPortSetupStatus, disassemblySetupStatus, partMotionSetupStatus, formatModelSetupOption } from '../src/views/admin/utils/modelSetupStatus.js'
import { useManualDisassemblyPage } from '../src/views/admin/composables/useManualDisassemblyPage.js'
import { normalizeInspection } from '../../shared/inspectionConfig.mjs'

const model = metadata => ({ id: 'fixture', name: '测试炉', file_path: '/fixture.glb', metadata })
const port = () => ({ position: [0, 0.5, 1], direction: [0, 0, 1], nodeName: 'Door' })
const ports = (inlet = null, outlet = null) => ({ version: 1, inlet, outlet })
const part = (offset = [0, 0, 0]) => ({ id: 'door', node_name: 'Door', explode_offset: offset, explode_rotation: [0, 0, 0] })
const binding = () => ({ id: 'door_action', node_path: 'Furnace/Door', source_group: 'doors', source_key: 'front_door_open', action: 'translate', axis: 'y' })
const clone = value => JSON.parse(JSON.stringify(value))

for (const [value, expected] of [[ports(), '未设置'], [ports(port()), '仅进料口'], [ports(null, port()), '仅出料口'], [ports(port(), port()), '双口已设置']]) {
    for (const asJson of [false, true]) test(`loading ports use saved ${asJson ? 'JSON' : 'object'} metadata: ${expected}`, () => {
        const metadata = { loadingPorts: value }
        assert.equal(loadingPortSetupStatus(model(asJson ? JSON.stringify(metadata) : metadata)), expected)
    })
}

test('missing metadata is unset; malformed metadata is abnormal and never throws', () => {
    for (const status of [loadingPortSetupStatus, disassemblySetupStatus, partMotionSetupStatus]) {
        for (const value of [undefined, null, '', '{}']) assert.equal(status(model(value)), '未设置')
        for (const value of ['{bad', 'null', '[]', [], 7]) assert.equal(status(model(value)), '配置异常')
    }
})

test('loading port validation rejects invalid vectors, versions and incomplete configs', () => {
    for (const value of [{}, { version: 2, inlet: null, outlet: null }, ports({ ...port(), position: [0, '', 0] }), ports({ ...port(), direction: [0, 0, 0] })]) {
        assert.equal(loadingPortSetupStatus(model({ loadingPorts: value })), '配置异常')
    }
})

test('suggested datums, instance overrides and editor drafts never imply saved ports', () => {
    const saved = model({ transferDatum: { position: [0, 1, 0] }, loadingPortOverrides: ports(port(), port()) })
    const draft = ports(port(), port())
    assert.equal(loadingPortSetupStatus(saved), '未设置')
    assert.deepEqual(draft, ports(port(), port()))
})

test('empty inspections, enabled flags and missing targets do not imply a layout', () => {
    for (const inspection of [{ enabled: true }, { enabled: false, parts: [] }, { parts: [{ id: 'placeholder', name: '标题', explode_offset: [2, 0, 0] }] }]) {
        assert.equal(disassemblySetupStatus(model({ inspection, disassemblyLayout: { version: 1, configured: true } })), '未设置')
    }
})

test('normalized zero-offset binding defaults are distinguished from explicitly saved layouts', () => {
    const inspection = normalizeInspection({}, [binding()])
    assert.equal(disassemblySetupStatus(model({ partBindings: [binding()] })), '未设置')
    assert.equal(disassemblySetupStatus(model({ inspection })), '默认布局')
    assert.equal(disassemblySetupStatus(model({ inspection, disassemblyLayout: { version: 1, configured: true } })), '已设置 1 个部件')
    for (const disassemblyLayout of [{ version: 2, configured: true }, { version: 1, configured: 'true' }, { version: 1, configured: false }]) {
        assert.equal(disassemblySetupStatus(model({ inspection, disassemblyLayout })), '默认布局')
    }
})

test('legacy offsets/rotations and target aliases recognize existing layouts without normalization', () => {
    const parts = [part([0, 1, 0]), { id: 'base', node_names: ['Base'], explode_offset: [0, 0, 0] }, { id: 'empty', name: '不算部件' }]
    assert.equal(disassemblySetupStatus(model({ inspection: { enabled: false, parts } })), '已设置 2 个部件')
    assert.equal(disassemblySetupStatus(model({ inspection: { parts: [{ nodePaths: ['Root/Part'], explodeRotation: [90, 0, 0] }] } })), '已设置 1 个部件')
})

test('malformed inspection positions never look configured', () => {
    for (const inspection of ['invalid', { parts: {} }, { parts: [part([Infinity, 0, 0])] }, { parts: [part([1, 2])] }]) {
        assert.equal(disassemblySetupStatus(model({ inspection })), '配置异常')
    }
})

test('saved part actions count valid unique bindings, including legacy field aliases', () => {
    const b = binding()
    assert.equal(partMotionSetupStatus(model({ partBindings: [b, { ...b, id: 'duplicate' }, { node_name: 'Valve', category: 'gas', value_role: 'valve_open' }] })), '已设置 2 项')
    assert.equal(partMotionSetupStatus(model({ partBindings: [null, {}, { name: '仅标题' }, { node_name: 'Door', source_key: '' }] })), '未设置')
    assert.equal(partMotionSetupStatus(model({ partBindings: {} })), '配置异常')
})

test('built-in CAD and cleaner actions are distinguished from saved PLC bindings', () => {
    assert.equal(partMotionSetupStatus({ id: 'cad_transfer_cart_101300', metadata: {} }), '内置 6 项')
    assert.equal(partMotionSetupStatus({ id: 'ultrasonic_cleaner_cad', metadata: {} }), '内置 6 项')
    assert.equal(partMotionSetupStatus({ id: 'cad_transfer_cart_101300', metadata: { partBindings: [binding()] } }), '已设置 1 项／内置 6 项')
})

test('retired custom process animations and action packages do not count as part actions', () => {
    assert.equal(partMotionSetupStatus(model({ motionAuthoring: { actions: [{ id: 'user_old', clip: 'user_old' }] }, motionActionPack: { actions: ['old'] } })), '未设置')
})

test('option format keeps names/IDs and does not mutate metadata', () => {
    const saved = model({ loadingPorts: ports(port()), inspection: { parts: [part([1, 0, 0])] }, partBindings: [binding()] })
    const before = clone(saved)
    assert.equal(formatModelSetupOption(saved, 'ports'), '测试炉 · 仅进料口')
    assert.equal(formatModelSetupOption(saved, 'disassembly'), '测试炉 · 已设置 1 个部件')
    assert.equal(formatModelSetupOption(saved, 'parts'), '测试炉 · 已设置 1 项')
    assert.equal(formatModelSetupOption({ id: 'original_id' }, 'ports'), 'original_id · 未设置')
    assert.deepEqual(saved, before)
})

test('reactive labels follow saved metadata replacements, never a separate edit draft', () => {
    const models = ref([model({})]), draft = ref({ loadingPorts: ports(port(), port()), partBindings: [binding()] })
    const labels = computed(() => ['ports', 'parts'].map(section => formatModelSetupOption(models.value[0], section)))
    assert.deepEqual(labels.value, ['测试炉 · 未设置', '测试炉 · 未设置'])
    draft.value.partBindings.push(binding())
    assert.deepEqual(labels.value, ['测试炉 · 未设置', '测试炉 · 未设置'])
    models.value = [model(JSON.stringify(draft.value))]
    assert.deepEqual(labels.value, ['测试炉 · 双口已设置', '测试炉 · 已设置 1 项'])
    models.value[0].metadata = {}
    assert.deepEqual(labels.value, ['测试炉 · 未设置', '测试炉 · 未设置'])
})

test('confirmed zero-offset model layout saves update the global menu metadata marker', async () => {
    const models = ref([model({ inspection: { parts: [part()] }, customer: 'keep' })])
    const inspection = clone(models.value[0].metadata.inspection)
    const state = useManualDisassemblyPage({ models, scope: 'model', initialModelId: 'fixture', ask: async () => true, api: {
        getModelInspection: async () => ({ modelId: 'fixture', inspection, revision: 'initial', assetRevision: 'asset' }),
        saveModelInspection: async () => ({ success: true, inspection, revision: 'saved', model: model({ inspection, customer: 'keep', disassemblyLayout: { version: 1, configured: true } }) })
    } })
    await state.ensureSelection()
    state.dirty.value = true
    assert.equal(disassemblySetupStatus(models.value[0]), '默认布局')
    assert.equal(await state.save(inspection), true)
    assert.equal(disassemblySetupStatus(models.value[0]), '已设置 1 个部件')
    assert.equal(models.value[0].metadata.customer, 'keep')
    state.dispose()
})

test('all three original selectors use page-specific saved status without changing model IDs', async () => {
    const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
    for (const [collection, variable, section] of [['manualDisassemblyChoices', 'item', 'disassembly'], ['motionModelOptions', 'model', 'parts'], ['loadingPortModelOptions', 'model', 'ports']]) {
        assert.ok(panel.includes(`<option v-for="${variable} in ${collection}" :key="${variable}.id" :value="${variable}.id">{{ formatModelSetupOption(${variable}, '${section}') }}</option>`))
    }
})
