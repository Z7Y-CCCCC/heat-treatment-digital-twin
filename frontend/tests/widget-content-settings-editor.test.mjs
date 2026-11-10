import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { editableWidgetText, updateWidgetTextContent, effectiveMetricItems, DEFAULT_METRIC_ITEMS, widgetStatSource } from '../src/runtime/widgetContentConfig.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { bindingForDevice, legacyWorkflow, sourceFromCatalog } from '../../shared/widgetBindingWorkflow.mjs'
import { installBrowser } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { normalizeDocument } = require('../../backend/utils/dashboardDocument.js')
const designerUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const designer = await readFile(designerUrl, 'utf8')
const script = parse(designer).descriptor.scriptSetup.content
const ast = parseJavaScript(script, { sourceType: 'module' })
const clone = value => JSON.parse(JSON.stringify(value))
const names = ['updateNavigationContent','updateTextContent','staticStatusValue','editableMetric','applyMetricLabel','applyMetricLabelSource','updateMetricPath','setStatSource','setStatUnitSource','metricFormatBinding','metricConfiguredUnit','applyMetricFormat','applyMetricSource','applyMetricScope','addBoundMetric','removeBoundMetric','applyDataWorkflow']
const functions = names.map(name => {
  const fn = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name)
  assert.ok(fn, 'Missing real designer handler: ' + name)
  return script.slice(fn.start, fn.end)
}).join('\n')

function handlers(widget, disabled = false) {
  const selectedWidget = ref(clone(widget)), commits = []
  const dependencies = { selectedWidget, safeCatalogPreviewDeviceId: ref('a'), devices: ref([{id:'a',name:'A'},{id:'b',name:'B'}]), points: ref([]),
    canAdminPage: () => !disabled, deepClone: clone, commitHistory: reason => commits.push(reason), recordProperty: reason => commits.push(reason),
    invalidateDataSetPreview: () => {}, editableWidgetText, updateWidgetTextContent, effectiveMetricItems, bindingForDevice, legacyWorkflow, sourceFromCatalog }
  const factory = new Function(...Object.keys(dependencies), functions + '\nreturn {' + names.join(',') + '}')
  return { selectedWidget, commits, ...factory(...Object.values(dependencies)) }
}
function reopen(widget) {
  const input = { projectId:'config-test',sceneId:'config-test',name:'配置回归',widgets:[clone(widget)],metadata:{factoryId:'factory-test'} }
  const before = JSON.stringify(input)
  const server = normalizeDocument(input)
  assert.equal(JSON.stringify(input), before, 'Server save normalization must not mutate the caller')
  const frontend = normalizeDashboardDocument(server)
  return frontend.widgets.find(item => item.id === widget.id)
}
function memoryHost() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const root = node('root')
  const remove = child => { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = null }
  const renderer = createRenderer({ createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (child, text) => { child.text = text }, setElementText: (child, text) => { child.text = text; child.children = [] },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    patchProp: (child, key, _old, value) => { child.props[key] = value }, remove,
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }
  })
  const find = (child, predicate) => predicate(child) ? child : child.children.map(item => find(item, predicate)).find(Boolean)
  const text = child => [child.text, ...child.children.map(text)].join(' ')
  return { root, renderer, find: predicate => find(root, predicate), text: () => text(root) }
}
async function component(url, renderer = false) {
  const source = await readFile(url, 'utf8'), descriptor = parse(source).descriptor
  let code = compileScript(descriptor, { id: 'content-config-memory', inlineTemplate: true }).content
  if (renderer) code = code.replace(/import HudMetricRing from [^\n]+/, 'const HudMetricRing = { render: () => null }')
    .replace(/import MapRegionList from [^\n]+/, 'const MapRegionList = { render: () => null }')
    .replace(/import \* as echarts from [^\n]+/, 'const echarts = { init: () => ({ setOption(){}, on(){}, resize(){}, dispose(){} }), graphic: { LinearGradient: class {} } }')
  code = code.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name))}`)
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default
}
const NavigationSettings = await component(new URL('../src/views/admin/components/NavigationContentSettings.vue', import.meta.url))
const Renderer = await component(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), true)

test('real navigation fields edit, save, reopen and drive the actual renderer with factory/collection changes', async t => {
  installBrowser(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No API acquisition belongs in a field control or renderer') })
  const state = handlers({id:'navigation-config',type:'navigation',title:'导航',content:{projectLabel:'旧项目文字',statusText:'旧状态文字'},data:{mode:'static'}})
  const systemData = reactive({factoryName:'天津工厂',collectionStatus:'实时采集正常'})
  const host = memoryHost(), app = host.renderer.createApp({ setup: () => () => h('div', [
    h(NavigationSettings, {content:state.selectedWidget.value.content,systemData,onUpdate:state.updateNavigationContent,onCommit:()=>state.commits.push('commit')}),
    h(Renderer, {widget:state.selectedWidget.value,systemData,preview:true})
  ]) })
  const field = label => host.find(node => node.props['aria-label'] === label)
  try {
    app.mount(host.root); await nextTick()
    assert.equal(field('项目文字来源').props.value, 'fixed')
    assert.equal(field('项目文字').props.value, '旧项目文字')
    assert.match(host.text(), /旧项目文字.*旧状态文字/)
    field('项目文字来源').props.onChange({target:{value:'factory'}})
    field('状态文字来源').props.onChange({target:{value:'collection'}})
    await nextTick()
    assert.equal(field('当前工厂名称').props.value, '天津工厂')
    assert.match(host.text(), /天津工厂.*实时采集正常/)
    state.selectedWidget.value = reopen(state.selectedWidget.value); await nextTick()
    assert.equal(field('项目文字来源').props.value, 'factory')
    assert.equal(field('状态文字来源').props.value, 'collection')
    systemData.factoryName='另一工厂'; systemData.collectionStatus='模拟演示运行中'; await nextTick()
    assert.equal(field('当前工厂名称').props.value, '另一工厂')
    assert.match(host.text(), /另一工厂.*模拟演示运行中/)
    systemData.collectionStatus='数据异常'; await nextTick(); assert.match(host.text(), /数据异常/)
    field('项目文字来源').props.onChange({target:{value:'fixed'}})
    field('状态文字来源').props.onChange({target:{value:'fixed'}}); await nextTick()
    assert.equal(field('项目文字').props.value, '旧项目文字', 'Changing source must not destroy the retained fixed caption')
    field('项目文字').props.onInput({target:{value:'自定义项目'}}); field('项目文字').props.onChange(); await nextTick()
    state.selectedWidget.value = reopen(state.selectedWidget.value); await nextTick()
    assert.match(host.text(), /自定义项目.*旧状态文字/)
    assert.equal(requests, 0)
  } finally { app.unmount() }
})

test('read-only navigation settings do not change frozen content or make requests', async () => {
  const content = Object.freeze({projectLabel:'天津工厂',statusText:'真实文字'}), before = JSON.stringify(content), updates = []
  const host = memoryHost(), app = host.renderer.createApp({setup:()=>()=>h(NavigationSettings,{content,disabled:true,onUpdate:value=>updates.push(value)})})
  try { app.mount(host.root); await nextTick(); host.find(node=>node.props['aria-label']==='项目文字来源').props.onChange({target:{value:'factory'}}); host.find(node=>node.props['aria-label']==='项目文字').props.onInput({target:{value:'不允许'}}); assert.deepEqual(updates,[]); assert.equal(JSON.stringify(content),before) }
  finally { app.unmount() }
})

test('the real textarea updates imported lines as well as text, then survives front/backend reopening', async t => {
  installBrowser(t)
  const state = handlers({id:'text-config',type:'text',content:{text:'被覆盖的旧值',lines:['第一行','第二行']},data:{mode:'static'}})
  assert.equal(editableWidgetText(state.selectedWidget.value.content),'第一行\n第二行')
  state.updateTextContent('新内容\n新第二行')
  state.selectedWidget.value=reopen(state.selectedWidget.value)
  assert.deepEqual(state.selectedWidget.value.content.lines,['新内容','新第二行'])
  const host=memoryHost(); host.renderer.render(h(Renderer,{widget:state.selectedWidget.value,preview:true}),host.root); await nextTick()
  try { assert.match(host.text(),/新内容.*新第二行/); assert.doesNotMatch(host.text(),/被覆盖的旧值/) } finally { host.renderer.render(null,host.root) }
})

test('default metrics are only materialized by a real edit, and adding retains all four actual defaults', () => {
  const input={id:'metrics-config',type:'metrics',content:{},data:{mode:'static',deviceScope:'current'},visibility:{}},state=handlers(input)
  assert.equal(Object.hasOwn(state.selectedWidget.value.content,'items'),false)
  assert.equal(effectiveMetricItems(state.selectedWidget.value.content).length,4)
  state.addBoundMetric()
  assert.equal(state.selectedWidget.value.content.items.length,5)
  assert.deepEqual(clone(state.selectedWidget.value.content.items.slice(0,4)),clone(DEFAULT_METRIC_ITEMS))
  state.removeBoundMetric(4); state.applyMetricLabel({index:0,value:'实际产量'})
  state.selectedWidget.value=reopen(state.selectedWidget.value)
  assert.equal(state.selectedWidget.value.content.items.length,4)
  assert.equal(state.selectedWidget.value.content.items[0].label,'实际产量')
})

test('normal metric source selection changes the actual default item, not an unused fallback', () => {
  const state=handlers({id:'metric-source',type:'metrics',content:{},data:{mode:'static',deviceScope:'global'},visibility:{}})
  state.applyMetricSource({index:2,deviceId:'',item:{label:'设备总数',unit:'台',binding:{mode:'runtime',path:'metrics.total_devices',deviceScope:'global'}}})
  const metric=reopen(state.selectedWidget.value).content.items[2]
  assert.equal(metric.binding.path,'metrics.total_devices'); assert.equal(metric.path,''); assert.equal(metric.binding.deviceScope,'global')
  assert.equal(effectiveMetricItems(state.selectedWidget.value.content).length,4)
})

test('static main scope and actual point picker preserve an independent fixed metric through immediate rendering and reopening', async t => {
  installBrowser(t)
  const state=handlers({id:'static-fixed-source',type:'metrics',content:{layout:'list',items:[{label:'A温度',path:'metrics.current_output'}]},data:{mode:'static',deviceScope:'current'},visibility:{}})
  state.applyMetricScope({index:0,scope:'fixed',deviceId:'a'})
  state.applyMetricSource({index:0,deviceId:'a',item:{id:'point_a',label:'A温度',unit:'A单位',binding:{mode:'plc',pointId:'pa',deviceId:'a',pointKey:'analog.temp',requireConfiguredPoint:true}}})
  const metric=state.selectedWidget.value.content.items[0]
  assert.equal(metric.binding.deviceScope,'fixed'); assert.equal(metric.binding.deviceId,'a')
  const values={pa:{id:'pa',device_id:'a',value:111,quality:'good',unit:'A单位'},pb:{id:'pb',device_id:'b',value:222,quality:'good',unit:'B单位'}}
  const props={runtimeContext:{deviceId:'b'},deviceCatalog:[{id:'a',name:'A'},{id:'b',name:'B'}],pointValues:values,deviceStatusMap:{a:{quality:'good'},b:{quality:'good'}},preview:true}
  const host=memoryHost(),app=host.renderer.createApp({setup:()=>()=>h(Renderer,{...props,widget:state.selectedWidget.value})})
  try {
    app.mount(host.root); await nextTick(); assert.match(host.text(),/111A单位/); assert.doesNotMatch(host.text(),/222|B单位/)
    state.selectedWidget.value=reopen(state.selectedWidget.value); await nextTick()
    assert.equal(state.selectedWidget.value.content.items[0].binding.deviceScope,'fixed')
    assert.match(host.text(),/111A单位/); assert.doesNotMatch(host.text(),/222|B单位/)
  } finally {app.unmount()}
})

test('metric format edits target the real device source and preserve other device display paths through save/reopen', () => {
  const state=handlers({id:'format-config',type:'metrics',content:{items:[{label:'温度',labelPath:'deviceInfo.name',unitPath:'selectedPart.unit',unit:'失效回退',binding:{mode:'plc',bindingVersion:2,deviceScope:'current',unitPath:'deviceInfo.unit',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa',unit:'°C',unitPath:'old.unit'}},{deviceId:'b',binding:{mode:'plc',pointId:'pb',unit:'K'}}]}}]},data:{mode:'plc',deviceScope:'current'},visibility:{}})
  state.applyMetricLabel({index:0,value:'自定义温度'})
  state.applyMetricFormat({index:0,deviceId:'a',unit:'摄氏度',unitPath:'',decimals:0})
  assert.equal(bindingForDevice(state.selectedWidget.value.content.items[0].binding,'a').unitPath,'', 'Immediate preview must not inherit a masked top-level unit path')
  const metric=reopen(state.selectedWidget.value).content.items[0]
  assert.equal(metric.label,'自定义温度'); assert.equal(metric.labelPath,undefined)
  assert.equal(metric.unitPath,undefined)
  assert.equal(bindingForDevice(metric.binding,'a').unit,'摄氏度')
  assert.equal(bindingForDevice(metric.binding,'a').unitPath || '','')
  assert.equal(bindingForDevice(metric.binding,'b').unit,'K')
  assert.equal(bindingForDevice(metric.binding,'b').unitPath,'selectedPart.unit')
  assert.equal(metric.decimals,0)
  state.applyMetricFormat({index:0,deviceId:'a',decimals:''}); assert.equal(state.selectedWidget.value.content.items[0].decimals,undefined)
})

test('HUD reading source and unit controls configure actual fields, including empty fixed units', () => {
  const state=handlers({id:'hud-config',type:'hud_chart_dock',content:{statPath:'metrics.old',statUnit:'旧单位'},data:{mode:'runtime',path:'metrics.current_output'},visibility:{}})
  state.setStatSource('binding'); assert.equal(state.selectedWidget.value.content.statPath,undefined)
  state.setStatSource('field'); assert.equal(widgetStatSource(state.selectedWidget.value.content),'field')
  state.setStatUnitSource('source'); assert.equal(Object.hasOwn(state.selectedWidget.value.content,'statUnit'),false)
  state.setStatUnitSource('fixed'); state.selectedWidget.value=reopen(state.selectedWidget.value)
  assert.equal(state.selectedWidget.value.content.statSource,'field'); assert.equal(state.selectedWidget.value.content.statUnit,'')
})

test('fixed status configuration shows the actual rendered literal state without rewriting imported values', () => {
  const state=handlers({id:'status-config',type:'status',content:{value:1},data:{mode:'static'}})
  for (const value of [true,1,'1','on','运行']) assert.equal(state.staticStatusValue(value),'true')
  for (const value of [false,0,'0','off','离线']) assert.equal(state.staticStatusValue(value),'false')
  for (const value of [undefined,null,'','not a boolean']) assert.equal(state.staticStatusValue(value),'')
  assert.equal(state.selectedWidget.value.content.value,1)
})

test('new designer configuration compiles fully and binds normal controls instead of any source explanation panel', () => {
  const descriptor=parse(designer).descriptor
  assert.doesNotMatch(designer,/<WidgetSourceTrace\b|inspector-source-overview/)
  assert.equal((designer.match(/<NavigationContentSettings\b/g)||[]).length,2)
  assert.match(designer,/:system-data="designerSystemData"/)
  assert.match(designer,/watch\(designerStore\.plcStatusText/)
  assert.match(designer,/getRuntimeConfig\(factoryId, request\.signal\)/)
  assert.match(designer,/备用单位字段/)
  assert.match(designer,/@metric-format="applyMetricFormat"/)
  assert.doesNotThrow(()=>compileScript(descriptor,{id:'designer-config'}))
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:'DashboardDesigner.vue',id:'designer-config'}).errors,[])
  for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,id:'designer-config',scoped:style.scoped}).errors,[])
})
