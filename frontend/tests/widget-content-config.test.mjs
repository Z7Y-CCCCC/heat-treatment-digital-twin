import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { computed, createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript, compileStyle, compileTemplate } from 'vue/compiler-sfc'
import { installBrowser } from './helpers.mjs'
import { DEFAULT_METRIC_ITEMS, effectiveMetricItems, resolveNavigationContent, editableWidgetText, updateWidgetTextContent,
  widgetImageSource, resolveWidgetImageUrl, widgetStatSource } from '../src/runtime/widgetContentConfig.js'
import { widgetBindingChoices } from '../src/runtime/widgetBindingChoices.js'
import { catalogItemUsable, filterCatalogItems } from '../src/runtime/dataCatalog.js'
import { normalizeDashboardDocument, createDashboardWidget } from '../src/runtime/dashboardSchema.js'
import { normalizeSource, bindingForDevice } from '../../shared/widgetBindingWorkflow.mjs'

const require = createRequire(import.meta.url)
const { normalizeDocument } = require('../../backend/utils/dashboardDocument.js')

const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
const rendererUrl = new URL('../src/runtime/WidgetRenderer.vue', import.meta.url)
const rendererSource = await readFile(rendererUrl, 'utf8')
const rendererDescriptor = parse(rendererSource).descriptor
// Chart painting is irrelevant to reading configuration and cannot use a DOM
// in the memory host; keep the complete actual component/setup/template.
const chartModule = `data:text/javascript,${encodeURIComponent('export function init(){return{setOption(){},resize(){},dispose(){}}}')}`
const code = compileScript(rendererDescriptor, { id: 'content-config-runtime', inlineTemplate: true }).content
  .replace(/from (['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(name.endsWith('.vue')
    ? 'data:text/javascript,export default {}' : name === 'echarts' ? chartModule : name.startsWith('.') ? new URL(name, rendererUrl).href : import.meta.resolve(name))}`)
const { default: WidgetRenderer } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const overlaySource = await readFile(new URL('../src/views/DashboardOverlay.vue', import.meta.url), 'utf8')

const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
const visible = child => child.type === '#comment' ? '' : [child.text, ...child.children.map(visible)].join(' ')
const find = (child, predicate) => predicate(child) ? child : child.children.map(item => find(item, predicate)).find(Boolean)
function memoryFixture(t) {
  // This installs in-memory window/event fixtures, not a real browser or app.
  const environment = installBrowser(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('Content rendering must not acquire data') })
  const remove = child => {
    if (child?.parent) child.parent.children = child.parent.children.filter(item => item !== child)
    if (child) child.parent = null
  }
  const renderer = createRenderer({
    createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (child, value) => { child.text = value }, setElementText: (child, value) => { child.text = value; child.children = [] },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    patchProp: (child, key, _old, value) => { child.props[key] = value },
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove
  })
  const root = node('root')
  environment.beforeRestore(() => renderer.render(null, root))
  return { root, get requests() { return requests }, async render(props) { renderer.render(h(WidgetRenderer, props), root); await nextTick(); await nextTick() } }
}

test('navigation fixed text is preserved for absent or unknown source modes, including blank fields', () => {
  for (const source of [undefined, 'fixed', 'unknown']) {
    const widget = freeze({ type: 'navigation', content: { projectLabel: '保留项目文字', statusText: '', projectLabelSource: source, statusTextSource: source } })
    assert.deepEqual(resolveNavigationContent(widget, { factoryName: '实时工厂', collectionStatus: '后端不可用' }), { projectLabel: '保留项目文字', statusText: '' })
  }
  assert.deepEqual(resolveNavigationContent({ config: { projectLabel: '旧配置', statusText: '旧状态' } }), { projectLabel: '旧配置', statusText: '旧状态' })
  assert.deepEqual(resolveNavigationContent({ content: {}, config: { projectLabel: '被遮住旧配置' } }), { projectLabel: '', statusText: '' })
})

test('navigation source selections independently read current system values and never fall back to retained fixed captions', () => {
  const content = freeze({ projectLabel: '旧项目', statusText: '旧正常文字', projectLabelSource: 'factory', statusTextSource: 'collection' })
  const widget = freeze({ type: 'navigation', content, data: { mode: 'static' } }), before = JSON.stringify(widget)
  assert.deepEqual(resolveNavigationContent(widget, { factoryName: '工厂 B', collectionStatus: '数据已过期' }), { projectLabel: '工厂 B', statusText: '数据已过期' })
  assert.deepEqual(resolveNavigationContent(widget, {}), { projectLabel: '', statusText: '' })
  assert.deepEqual(resolveNavigationContent({ ...widget, content: { ...content, projectLabelSource: 'fixed' } }, { collectionStatus: '后端不可用' }), { projectLabel: '旧项目', statusText: '后端不可用' })
  assert.deepEqual(resolveNavigationContent({ ...widget, content: { ...content, statusTextSource: 'fixed' } }, { factoryName: '工厂 C' }), { projectLabel: '工厂 C', statusText: '旧正常文字' })
  assert.equal(JSON.stringify(widget), before)
})

test('the actual preview renderer changes navigation text when either current values or the saved selections change', async t => {
  const view = memoryFixture(t)
  const widget = freeze({ id: 'navigation', type: 'navigation', title: '', data: { mode: 'static' },
    content: { projectLabel: '固定项目', statusText: '固定状态', projectLabelSource: 'factory', statusTextSource: 'collection' } })
  const before = JSON.stringify(widget)
  await view.render({ widget, preview: true, systemData: { factoryName: '工厂 A', collectionStatus: '等待连接...' } })
  assert.match(visible(view.root), /工厂 A.*等待连接/)
  assert.doesNotMatch(visible(view.root), /固定项目|固定状态/)
  await view.render({ widget, preview: true, systemData: { factoryName: '工厂 B', collectionStatus: '后端不可用' } })
  assert.match(visible(view.root), /工厂 B.*后端不可用/)
  assert.doesNotMatch(visible(view.root), /工厂 A|等待连接|固定状态/)
  await view.render({ widget: { ...widget, content: { ...widget.content, projectLabelSource: 'fixed', statusTextSource: 'fixed' } }, systemData: { factoryName: '工厂 B', collectionStatus: '后端不可用' } })
  assert.match(visible(view.root), /固定项目.*固定状态/)
  assert.doesNotMatch(visible(view.root), /工厂 B|后端不可用/)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('the actual Overlay navigation adapter consumes the same configuration and reactive current config/DataStore values', () => {
  const systemExpression = overlaySource.match(/^const widgetSystemData = computed\(\(\) => (.+)\)$/m)?.[1]
  const navigationExpression = overlaySource.match(/^const navigationCopy = widget => (.+)$/m)?.[1]
  assert.ok(systemExpression && navigationExpression)
  const config = reactive({ settings: { factory_name: '目录工厂 A' } }), dataStore = { plcStatusText: ref('等待连接...') }
  const actual = new Function('computed', 'config', 'dataStore', 'resolveNavigationContent', `const widgetSystemData = computed(() => ${systemExpression}); const navigationCopy = widget => ${navigationExpression}; return { navigationCopy, widgetSystemData }`)(computed, config, dataStore, resolveNavigationContent)
  const widget = freeze({ type: 'navigation', content: { projectLabel: '旧项目', statusText: '旧正常', projectLabelSource: 'factory', statusTextSource: 'collection' } })
  assert.deepEqual(actual.navigationCopy(widget), { projectLabel: '目录工厂 A', statusText: '等待连接...' })
  config.settings.factory_name = '目录工厂 B'; dataStore.plcStatusText.value = '后端不可用'
  assert.deepEqual(actual.navigationCopy(widget), { projectLabel: '目录工厂 B', statusText: '后端不可用' })
  assert.deepEqual(actual.navigationCopy(widget), resolveNavigationContent(widget, actual.widgetSystemData.value))
  assert.match(overlaySource, /:system-data="widgetSystemData"/)
  assert.match(overlaySource, /navigationCopy\(widget\)\.projectLabel/)
  assert.match(overlaySource, /navigationCopy\(widget\)\.statusText/)
})

test('the text editor reads the actual lines value and synchronizes it only after an explicit edit', () => {
  const content = freeze({ lines: ['第一行', '{value}{unit}'], text: '不会被渲染的旧字段', fontSize: 20 }), before = JSON.stringify(content)
  assert.equal(editableWidgetText(content), '第一行\n{value}{unit}')
  const next = updateWidgetTextContent(content, '新标题\r\n新值:{value}{unit}')
  assert.deepEqual(next.lines, ['新标题', '新值:{value}{unit}'])
  assert.equal(next.text, '新标题\r\n新值:{value}{unit}')
  assert.equal(next.fontSize, 20)
  assert.equal(JSON.stringify(content), before)
  assert.equal(editableWidgetText({ lines: [], text: '被遮住旧字段' }), '')
  const fresh = updateWidgetTextContent({ text: '原文字' }, '新文字')
  assert.equal(fresh.text, '新文字'); assert.equal(Object.hasOwn(fresh, 'lines'), false)
})

test('explicit static values ignore retained runtime paths, point IDs and bad live quality in the actual renderer', async t => {
  const view = memoryFixture(t)
  const variants = [
    { path: 'metrics.current_output', source: 'device.analog.temp' },
    { pointId: 'old_point', deviceId: 'a', deviceScope: 'fixed', path: 'analog.temp', requireConfiguredPoint: true },
    { bindingVersion: 2, pointId: 'old_point', deviceId: 'a', deviceScope: 'fixed', path: 'metrics.current_output',
      deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'old_point' } }] }
  ]
  for (const [index, retained] of variants.entries()) {
    const widget = freeze({ id: `fixed-${index}`, type: 'value', title: '', content: { value: 123, showTitle: false }, data: { ...retained, mode: 'static', decimals: 0 } })
    const before = JSON.stringify(widget)
    const props = { metrics: { current_output: 999 }, deviceCatalog: [{ id: 'a', name: 'A' }], deviceStatusMap: { a: { quality: 'bad', online: false } },
      pointValues: { old_point: { id: 'old_point', device_id: 'a', value: 999, quality: 'bad' } } }
    await view.render({ widget, ...props })
    assert.match(visible(view.root), /123/)
    assert.doesNotMatch(visible(view.root), /999|数据延迟|离线/)
    await view.render({ widget: { ...widget, content: { ...widget.content, value: 0 } }, ...props })
    assert.equal(visible(find(view.root, child => child.type === 'strong')).trim(), '0')
    assert.doesNotMatch(visible(view.root), /123|999|数据延迟|离线/)
    assert.equal(JSON.stringify(widget), before)
  }
  assert.equal(view.requests, 0)
})

test('explicit static status inputs immediately control on/off despite retained point/path references and bad live quality', async t => {
  const view = memoryFixture(t)
  for (const retained of [{ path: 'metrics.current_output' }, { pointId: 'old_point', deviceId: 'a', deviceScope: 'fixed', path: 'analog.temp' }]) {
    const widget = freeze({ id: 'fixed-status', type: 'status', title: '', data: { ...retained, mode: 'static' },
      content: { value: 1, label: '固定状态', onText: '配置开启', offText: '配置关闭', unknownText: '旧源异常', showTitle: false } })
    const props = { metrics: { current_output: 999 }, deviceCatalog: [{ id: 'a', name: 'A' }], deviceStatusMap: { a: { quality: 'bad', online: false } },
      pointValues: { old_point: { id: 'old_point', device_id: 'a', value: 999, quality: 'bad' } } }
    await view.render({ widget, ...props })
    assert.match(visible(view.root), /配置开启/)
    assert.doesNotMatch(visible(view.root), /配置关闭|旧源异常/)
    await view.render({ widget: { ...widget, content: { ...widget.content, value: 0 } }, ...props })
    assert.match(visible(view.root), /配置关闭/)
    assert.doesNotMatch(visible(view.root), /配置开启|旧源异常/)
    assert.equal(widget.data.mode, 'static')
    assert.equal(widget.content.value, 1)
  }
  assert.equal(view.requests, 0)
})

test('static main values do not replace the existing independent event and device-list sources', async t => {
  const view = memoryFixture(t), data = freeze({ mode: 'static', pointId: 'old_point', path: 'metrics.current_output' })
  await view.render({ widget: { id: 'events', type: 'alarm_list', title: '', data, content: { value: 123, showTitle: false } }, events: [{ id: 'real_event', msg: '实际事件记录', level: 'info' }], metrics: { current_output: 999 } })
  assert.match(visible(view.root), /实际事件记录/)
  assert.doesNotMatch(visible(view.root), /123|999/)
  await view.render({ widget: { id: 'devices', type: 'device_list', title: '', data, content: { value: 123, showTemperature: false, showTitle: false } },
    deviceStatusMap: { a: { name: '现有设备 A', quality: 'good', online: true } }, metrics: { current_output: 999 } })
  assert.match(visible(view.root), /现有设备 A/)
  assert.doesNotMatch(visible(view.root), /123|999/)
  assert.equal(data.pointId, 'old_point')
  assert.equal(view.requests, 0)
})

test('editing an existing multiline text template changes the actual rendered bound text without changing widget.data', async t => {
  const view = memoryFixture(t), binding = freeze({ mode: 'runtime', path: 'metrics.current_output', unit: '件', decimals: 0 })
  const widget = freeze({ id: 'text', type: 'text', title: '', data: binding, content: { lines: ['原标题', '{value}{unit}'], text: '旧隐藏文本', showTitle: false } })
  const before = JSON.stringify(widget)
  await view.render({ widget, metrics: { current_output: 37 } })
  assert.match(visible(view.root), /原标题.*37件/)
  const next = { ...widget, content: updateWidgetTextContent(widget.content, '新标题\n新值:{value}{unit}') }
  await view.render({ widget: next, metrics: { current_output: 38 } })
  assert.match(visible(view.root), /新标题.*新值:38件/)
  assert.doesNotMatch(visible(view.root), /原标题|旧隐藏文本|37件/)
  assert.equal(next.data, binding)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('image source mode makes fixed and bound values exclusive while preserving absent-mode legacy rendering', () => {
  const binding = freeze({ mode: 'dataset', datasetId: 'pictures', datasetField: 'url', deviceScope: 'global' })
  const content = freeze({ url: 'https://retained.invalid/old.png' }), bound = 'https://current.invalid/new.png'
  assert.equal(resolveWidgetImageUrl(content, binding, bound, 'stale'), content.url)
  assert.equal(resolveWidgetImageUrl({}, binding, bound), bound)
  assert.equal(widgetImageSource(content, binding), 'fixed')
  assert.equal(widgetImageSource({}, binding), 'binding')
  assert.equal(widgetImageSource({}, { mode: 'static' }), 'fixed')
  assert.equal(resolveWidgetImageUrl({ ...content, urlSource: 'binding' }, binding, bound), bound)
  assert.equal(resolveWidgetImageUrl({ url: '', urlSource: 'fixed' }, binding, bound), '')
  assert.equal(resolveWidgetImageUrl({ ...content, urlSource: 'binding' }, { mode: 'static' }, bound), '')
  assert.equal(resolveWidgetImageUrl({ ...content, urlSource: 'binding' }, {}, bound), '')
  for (const quality of ['stale', 'bad', 'configured', 'unknown']) assert.equal(resolveWidgetImageUrl({ ...content, urlSource: 'binding' }, binding, bound, quality), '')
  for (const value of [null, undefined, 1, false, {}]) assert.equal(resolveWidgetImageUrl({ ...content, urlSource: 'binding' }, binding, value), '')
})

test('the actual image renderer uses the selected existing binding, rejects stale values and switches back to fixed without rewriting data', async t => {
  const view = memoryFixture(t)
  const widget = freeze({ id: 'image', type: 'image', title: '', content: { urlSource: 'binding', url: 'https://retained.invalid/old.png' },
    data: { mode: 'dataset', datasetId: 'pictures', datasetField: 'url', deviceScope: 'global' } })
  const before = JSON.stringify(widget), record = { quality: 'good', value: 'https://current.invalid/new.png', rows: [{ url: 'https://current.invalid/new.png' }] }
  await view.render({ widget, databaseValues: { image: record } })
  assert.equal(find(view.root, child => child.type === 'img').props.src, record.value)
  await view.render({ widget, databaseValues: { image: { ...record, quality: 'stale' } } })
  assert.equal(find(view.root, child => child.type === 'img'), undefined)
  await view.render({ widget: { ...widget, content: { ...widget.content, urlSource: 'fixed' } }, databaseValues: { image: { ...record, quality: 'bad' } } })
  assert.equal(find(view.root, child => child.type === 'img').props.src, widget.content.url)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('normal image data pickers allow existing string runtime, PLC and dataset fields but not numeric/boolean fields or unused widget bindings', () => {
  const items = ['runtime', 'plc', 'dataset'].flatMap(mode => ['string', 'number', 'boolean'].map(type => ({ id: `${mode}_${type}`, type, enabled: true,
    binding: { mode, path: mode === 'runtime' ? 'deviceInfo.name' : 'analog.url', pointId: 'text-point', datasetId: 'pictures', datasetField: 'url' } })))
  assert.deepEqual(widgetBindingChoices({ type: 'image', data: { mode: 'static' } }).map(choice => choice.id), ['static', 'dataset', 'plc', 'runtime'])
  assert.deepEqual(filterCatalogItems(items, { widgetType: 'image' }).map(item => item.id), ['runtime_string', 'plc_string', 'dataset_string'])
  for (const item of items) {
    assert.equal(catalogItemUsable(item, { widgetType: 'image' }), item.type === 'string')
    assert.equal(catalogItemUsable(item, { widgetType: 'navigation' }), false)
    assert.equal(catalogItemUsable(item, { widgetType: 'container' }), false)
    assert.equal(catalogItemUsable(item, { tooltip: true, widgetType: 'image' }), false)
  }
})

test('metric configuration and runtime share the four unchanged defaults and retain explicitly empty item arrays', () => {
  assert.deepEqual(DEFAULT_METRIC_ITEMS, [
    { label: '今日产出', path: 'metrics.current_output' }, { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
    { label: '能耗估算', path: 'metrics.energy_consumption' }, { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
  ])
  const content = freeze({}), before = JSON.stringify(content)
  assert.equal(effectiveMetricItems(content), DEFAULT_METRIC_ITEMS)
  assert.equal(effectiveMetricItems({ items: null }), DEFAULT_METRIC_ITEMS)
  const empty = freeze({ items: [] }); assert.equal(effectiveMetricItems(empty), empty.items)
  assert.ok(Object.isFrozen(DEFAULT_METRIC_ITEMS) && DEFAULT_METRIC_ITEMS.every(Object.isFrozen))
  assert.equal(JSON.stringify(content), before)
  assert.match(rendererSource, /const items = effectiveMetricItems\(content\.value\)/)
  const authored = structuredClone(effectiveMetricItems(content)); authored.push({ label: '新增第五项', value: '配置值' })
  assert.equal(authored.length, 5); assert.equal(DEFAULT_METRIC_ITEMS.length, 4)
})

test('the actual metric renderer shows the same default four items and hides them for explicit items=[]', async t => {
  const view = memoryFixture(t), widget = freeze({ id: 'metrics', type: 'metrics', title: '', data: { mode: 'static' }, content: { layout: 'list', showTitle: false } })
  const props = { metrics: { current_output: 10, daily_target: 20, energy_consumption: 3, online_devices: 2, total_devices: 4 } }
  await view.render({ widget, ...props })
  for (const item of DEFAULT_METRIC_ITEMS) assert.ok(visible(view.root).includes(item.label))
  await view.render({ widget: { ...widget, content: { ...widget.content, items: [] } }, ...props })
  for (const item of DEFAULT_METRIC_ITEMS) assert.equal(visible(view.root).includes(item.label), false)
  assert.equal(Object.hasOwn(widget.content, 'items'), false)
  assert.equal(view.requests, 0)
})

test('a static current-scoped main card lets an independently fixed metric read device A while viewing B without changing nonstatic behavior', async t => {
  const view = memoryFixture(t)
  const binding = freeze({ mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a',
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa', unit: 'A单位' } },
      { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb', unit: 'B单位' } }] })
  const widget = freeze({ id: 'independent-metric', type: 'metrics', title: '', data: { mode: 'static', deviceScope: 'current' },
    content: { layout: 'list', showTitle: false, items: [{ label: '固定A指标', binding }] } })
  const before = JSON.stringify(widget)
  const props = { runtimeContext: { deviceId: 'b', viewMode: 'device', viewId: 'device_detail' }, deviceCatalog: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    pointValues: { pa: { id: 'pa', device_id: 'a', value: 111, quality: 'good' }, pb: { id: 'pb', device_id: 'b', value: 222, quality: 'good' } } }
  await view.render({ widget, ...props })
  assert.match(visible(view.root), /固定A指标.*111A单位/)
  assert.doesNotMatch(visible(view.root), /222|B单位/)
  await view.render({ widget: { ...widget, data: { mode: 'plc', deviceId: 'b', deviceScope: 'fixed', pointId: 'pb' } }, ...props })
  assert.match(visible(view.root), /222B单位/)
  assert.doesNotMatch(visible(view.root), /111|A单位/)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('a static main card with a missing or blank independent fixed metric device never guesses current B or a retained A row', async t => {
  const view = memoryFixture(t)
  const props = { runtimeContext: { deviceId: 'b', viewMode: 'device', viewId: 'device_detail' }, deviceCatalog: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    pointValues: { pa: { id: 'pa', device_id: 'a', value: 111, quality: 'good' }, pb: { id: 'pb', device_id: 'b', value: 222, quality: 'good' } } }
  for (const deviceId of ['missing', '']) {
    const widget = freeze({ id: 'missing-fixed-metric', type: 'metrics', title: '', data: { mode: 'static', deviceScope: 'current' },
      content: { layout: 'list', showTitle: false, items: [{ label: '独立固定指标', fallback: '缺少固定设备', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId,
        deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa', unit: 'A单位' } }, { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb', unit: 'B单位' } }] } }] } })
    const before = JSON.stringify(widget)
    await view.render({ widget, ...props })
    assert.match(visible(view.root), /缺少固定设备/)
    assert.doesNotMatch(visible(view.root), /111|222|A单位|B单位/)
    assert.equal(JSON.stringify(widget), before)
  }
  assert.equal(view.requests, 0)
})

test('HUD summary source selections infer legacy statPath only when the operator has not explicitly selected a mode', () => {
  assert.equal(widgetStatSource({}), 'binding')
  assert.equal(widgetStatSource({ statPath: 'metrics.energy_consumption' }), 'field')
  assert.equal(widgetStatSource({ statSource: 'binding', statPath: 'metrics.energy_consumption' }), 'binding')
  assert.equal(widgetStatSource({ statSource: 'field', statPath: '' }), 'field')
  assert.equal(widgetStatSource({ statSource: 'unknown', statPath: 'metrics.energy_consumption' }), 'field')
  assert.equal(widgetStatSource({ statSource: 'unknown' }), 'binding')
})

test('the actual HUD summary follows the selected source, keeps empty explicit fields empty and leaves unit precedence unchanged', async t => {
  const view = memoryFixture(t)
  const reading = () => visible(find(view.root, child => String(child.props.class || '').includes('hud-module-reading')).children.find(child => child.type === 'span'))
  const widget = freeze({ id: 'summary', type: 'hud_chart_dock', title: '', data: { mode: 'runtime', path: 'metrics.current_output', unit: '件', decimals: 0 },
    content: { showTitle: false, statLabel: '当前值', statSource: 'binding', statPath: 'metrics.energy_consumption', statUnit: '', rangeLabel: '', emptyText: '' } })
  const metrics = { current_output: 13, energy_consumption: 29 }
  await view.render({ widget, metrics })
  assert.match(reading(), /当前值.*13/)
  assert.doesNotMatch(reading(), /29|件/)
  await view.render({ widget: { ...widget, content: { ...widget.content, statSource: 'field' } }, metrics })
  assert.match(reading(), /当前值.*29/)
  assert.doesNotMatch(reading(), /13|件/)
  await view.render({ widget: { ...widget, content: { ...widget.content, statSource: 'field', statPath: '' } }, metrics })
  assert.match(reading(), /当前值.*—/)
  assert.doesNotMatch(reading(), /13|29|件/)
  const { statUnit, ...content } = widget.content
  await view.render({ widget: { ...widget, content }, metrics })
  assert.match(reading(), /当前值.*13.*件/)
  assert.equal(widget.content.statPath, 'metrics.energy_consumption')
  assert.equal(widget.content.statUnit, '')
  assert.equal(view.requests, 0)
})

test('HUD summary following units reads the actual reactive unitPath and preserves explicit fixed or empty statUnit overrides', async t => {
  const view = memoryFixture(t)
  const reading = () => visible(find(view.root, child => String(child.props.class || '').includes('hud-module-reading')).children.find(child => child.type === 'span'))
  const widget = freeze({ id: 'unit-path', type: 'hud_chart_dock', title: '',
    data: { mode: 'runtime', path: 'metrics.current_output', unit: '', unitPath: 'parameters.displayUnit' }, content: { statLabel: '当前值', showTitle: false } })
  const before = JSON.stringify(widget)
  await view.render({ widget, metrics: { current_output: 43 }, parameters: { displayUnit: '℃' } })
  assert.match(reading(), /43.*℃/)
  await view.render({ widget, metrics: { current_output: 43 }, parameters: { displayUnit: 'K' } })
  assert.match(reading(), /43.*K/); assert.doesNotMatch(reading(), /℃/)
  await view.render({ widget: { ...widget, content: { ...widget.content, statUnit: '固定单位' } }, metrics: { current_output: 43 }, parameters: { displayUnit: 'K' } })
  assert.match(reading(), /43.*固定单位/); assert.doesNotMatch(reading(), /K|℃/)
  await view.render({ widget: { ...widget, content: { ...widget.content, statUnit: '' } }, metrics: { current_output: 43 }, parameters: { displayUnit: 'K' } })
  assert.match(reading(), /43/); assert.doesNotMatch(reading(), /K|℃|固定单位/)
  assert.equal(Object.hasOwn(widget.content, 'statUnit'), false)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('HUD summary following units reads real point metadata and dataset metadata rather than the empty binding unit', async t => {
  const view = memoryFixture(t)
  const reading = () => visible(find(view.root, child => String(child.props.class || '').includes('hud-module-reading')).children.find(child => child.type === 'span'))
  const widget = freeze({ id: 'point-unit', type: 'hud_chart_dock', title: '', content: { statLabel: '当前值', showTitle: false },
    data: { mode: 'plc', deviceId: 'a', deviceScope: 'fixed', pointId: 'pa', requireConfiguredPoint: true, unit: '' } })
  const props = { deviceCatalog: [{ id: 'a', name: 'A' }], pointValues: { pa: { id: 'pa', device_id: 'a', value: 47, quality: 'good', unit: 'h' } } }
  await view.render({ widget, ...props }); assert.match(reading(), /47.*h/)
  await view.render({ widget, ...props, pointValues: { pa: { ...props.pointValues.pa, unit: 'min' } } })
  assert.match(reading(), /47.*min/); assert.doesNotMatch(reading(), /47.*h/)
  const dataset = freeze({ id: 'dataset-unit', type: 'hud_chart_dock', title: '', content: { statLabel: '当前值', showTitle: false },
    data: { mode: 'dataset', datasetId: 'units', datasetField: 'value', deviceScope: 'global', unit: '' } })
  await view.render({ widget: dataset, databaseValues: { 'dataset-unit': { quality: 'good', value: 5, unit: 'kg', rows: [{ value: 5 }] } } })
  assert.match(reading(), /5.*kg/)
  assert.equal(Object.hasOwn(widget.content, 'statUnit'), false)
  assert.equal(widget.data.unit, '')
  assert.equal(view.requests, 0)
})

test('saved content selections round trip through the existing schema and never auto-enable new modes on legacy widgets', () => {
  const nav = { id: 'nav', type: 'navigation', content: { projectLabel: '保留项目', statusText: '保留状态', projectLabelSource: 'factory', statusTextSource: 'collection' }, data: { mode: 'static' } }
  const image = { id: 'image', type: 'image', content: { url: 'https://retained.invalid/old.png', urlSource: 'binding' }, data: { mode: 'runtime', path: 'deviceInfo.name' } }
  const summary = { id: 'summary', type: 'hud_chart_dock', content: { statSource: 'field', statPath: '' }, data: { mode: 'runtime', path: 'metrics.current_output' } }
  const source = freeze({ widgets: [nav, image, summary] }), before = JSON.stringify(source)
  const normalized = normalizeDashboardDocument(source), backend = normalizeDocument(normalized), again = normalizeDashboardDocument(JSON.parse(JSON.stringify(backend)))
  for (const document of [normalized, backend, again]) {
    assert.equal(document.widgets.find(widget => widget.id === 'nav').content.projectLabelSource, 'factory')
    assert.equal(document.widgets.find(widget => widget.id === 'nav').content.statusTextSource, 'collection')
    assert.equal(document.widgets.find(widget => widget.id === 'image').content.urlSource, 'binding')
    assert.equal(document.widgets.find(widget => widget.id === 'image').data.path, 'deviceInfo.name')
    assert.equal(document.widgets.find(widget => widget.id === 'summary').content.statSource, 'field')
    assert.equal(document.widgets.find(widget => widget.id === 'summary').content.statPath, '')
  }
  const legacy = normalizeDashboardDocument({ widgets: [{ ...nav, content: { projectLabel: '旧项目', statusText: '旧状态' } }, { ...image, content: { url: 'https://retained.invalid/old.png' } }] })
  assert.equal(Object.hasOwn(legacy.widgets.find(widget => widget.id === 'nav').content, 'projectLabelSource'), false)
  assert.equal(Object.hasOwn(legacy.widgets.find(widget => widget.id === 'image').content, 'urlSource'), false)
  assert.equal(Object.hasOwn(createDashboardWidget('navigation').content, 'projectLabelSource'), false)
  assert.equal(JSON.stringify(source), before)
})

test('explicit per-device decimals survive source normalization while absent or invalid values still inherit the primary format', () => {
  const source = freeze({ mode: 'plc', deviceId: 'a', pointId: 'pa', pointKey: 'analog.temp', unit: 'h', unitPath: 'selectedPart.points.0.unit', catalogItemId: 'fixture-point', catalogTableId: 'fixture-table' })
  const original = normalizeSource(source)
  for (const [input, expected] of [[0, 0], [8, 8], ['3', 3], [' 2 ', 2]]) {
    const normalized = normalizeSource({ ...source, decimals: input })
    assert.equal(normalized.decimals, expected)
    const { decimals, ...otherFields } = normalized
    assert.deepEqual(otherFields, original)
    assert.equal(normalized.unitPath, source.unitPath)
  }
  for (const decimals of [undefined, null, '', ' ', false, true, {}, -1, 9, 2.5, NaN, Infinity, 'invalid']) {
    const normalized = normalizeSource({ ...source, decimals })
    assert.equal(Object.hasOwn(normalized, 'decimals'), false)
    assert.equal(bindingForDevice({ mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', decimals: 4,
      deviceBindings: [{ deviceId: 'a', binding: normalized }] }, 'a').decimals, 4)
  }
})

test('per-device decimals and unitPath round trip through frontend, backend and frontend without touching any data source', () => {
  const binding = freeze({ mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', decimals: 3, pointId: 'pa',
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa', unit: '', unitPath: 'selectedPart.points.0.unit', decimals: 0 } },
      { deviceId: 'b', binding: { mode: 'runtime', path: 'device.analog.temp', unit: 'h', unitPath: 'parameters.displayUnit', decimals: 8 } }] })
  const source = freeze({ widgets: [{ id: 'formatted', type: 'text', content: { text: '{value}{unit}' }, data: binding }] }), before = JSON.stringify(source)
  const frontend = normalizeDashboardDocument(source), backend = normalizeDocument(frontend), again = normalizeDashboardDocument(backend)
  for (const document of [frontend, backend, again]) {
    const data = document.widgets.find(widget => widget.id === 'formatted').data
    assert.equal(data.deviceBindings[0].binding.decimals, 0)
    assert.equal(data.deviceBindings[1].binding.decimals, 8)
    assert.equal(data.deviceBindings[0].binding.unitPath, 'selectedPart.points.0.unit')
    assert.equal(data.deviceBindings[1].binding.unitPath, 'parameters.displayUnit')
    assert.equal(data.deviceBindings[0].binding.unit, '')
    assert.equal(bindingForDevice(data, 'a').decimals, 0)
  }
  assert.equal(JSON.stringify(source), before)
})

test('the actual text renderer uses the saved effective device-row decimals rather than the hidden top-level format', async t => {
  const view = memoryFixture(t)
  const data = { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', pointId: 'pa', decimals: 1,
    deviceBindings: [{ deviceId: 'a', binding: normalizeSource({ mode: 'plc', pointId: 'pa', unit: 'h', decimals: 3 }) }] }
  const widget = freeze({ id: 'row-formatted', type: 'text', title: '', content: { text: '{value}{unit}', showTitle: false }, data })
  const before = JSON.stringify(widget)
  await view.render({ widget, deviceCatalog: [{ id: 'a', name: 'A' }], pointValues: { pa: { id: 'pa', device_id: 'a', value: 1.23456, quality: 'good' } } })
  assert.match(visible(view.root), /1\.235h/)
  assert.doesNotMatch(visible(view.root), /1\.2h/)
  assert.equal(JSON.stringify(widget), before)
  assert.equal(view.requests, 0)
})

test('edited renderers still compile their full templates and styles without browser execution', () => {
  for (const [name, source] of [['WidgetRenderer', rendererSource], ['DashboardOverlay', overlaySource]]) {
    const descriptor = parse(source).descriptor
    assert.doesNotThrow(() => compileScript(descriptor, { id: `content-config-${name}` }))
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: `content-config-${name}` }).errors, [])
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, id: `content-config-${name}`, scoped: style.scoped }).errors, [])
  }
})
