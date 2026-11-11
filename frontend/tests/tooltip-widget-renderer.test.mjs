import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, provide, reactive } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { deferred, installBrowser, json, settle } from './helpers.mjs'
import { createTooltipContext } from '../src/runtime/tooltipContext.js'
import { WidgetClockKey, useWidgetClock } from '../src/runtime/widgetPlayback.js'
import { createTooltipTemplate, normalizeTooltipTemplates } from '../../shared/tooltipTemplates.mjs'

const url = new URL('../src/runtime/WidgetRenderer.vue', import.meta.url)
const { descriptor } = parse(await readFile(url, 'utf8'))
const compiled = compileScript(descriptor, { id: 'tooltip-renderer', inlineTemplate: true }).content
  .replace(/from (['"])(vue|echarts)\1/g, (_, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
  .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, name) => `from ${JSON.stringify(new URL(name, url).href)}`)
  .replace(/from (["'])([^"']+\.vue)\1/g, `from 'data:text/javascript,export default {}'`)
const rendererModuleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const { default: WidgetRenderer } = await import(rendererModuleUrl)
const surfaceUrl = new URL('../src/runtime/TooltipSurface.vue', import.meta.url)
const surfaceDescriptor = parse(await readFile(surfaceUrl, 'utf8')).descriptor
const surfaceCompiled = compileScript(surfaceDescriptor, { id: 'tooltip-surface-renderer', inlineTemplate: true }).content
  .replace(/from (['"])([^'"]+)\1/g, (_, _quote, name) => `from ${JSON.stringify(name.endsWith('/WidgetRenderer.vue') ? rendererModuleUrl
    : name.startsWith('.') ? new URL(name, surfaceUrl).href : import.meta.resolve(name))}`)
const { default: TooltipSurface } = await import(`data:text/javascript;base64,${Buffer.from(surfaceCompiled).toString('base64')}`)

test('tooltip surface leaves an omitted clock undefined so live renderers inherit the shared ref', () => {
  assert.equal(TooltipSurface.props.playbackNow.default, undefined)
})
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
const text = root => [root.text, ...root.children.map(text)].join(' ')
function fixture(t, Component = WidgetRenderer, { liveClock = false } = {}) {
  const environment = installBrowser(t)
  const placementWork = { hosts:0, children:0, canvases:0 }
  const renderer = createRenderer({
    createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (element, value) => element.text = value,
    setElementText: (element, value) => { element.text = value; element.children = [] },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    patchProp: (element, key, previous, value) => {
      if (key === 'style') {
        const classes = String(element.props.class || '')
        if (classes.includes('tooltip-surface-widget')) placementWork.children++
        else if (classes.includes('tooltip-surface-canvas')) placementWork.canvases++
        else if (classes.includes('tooltip-surface')) placementWork.hosts++
      }
      element.props[key] = value
    },
    insert(element, parent, anchor = null) {
      if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element)
    },
    remove(element) { if (element?.parent) element.parent.children = element.parent.children.filter(child => child !== element) }
  })
  const root = node('root')
  let clock
  const component = liveClock ? {
    inheritAttrs: false,
    setup(_props, { attrs }) {
      clock = useWidgetClock(); provide(WidgetClockKey, clock)
      return () => h(Component, attrs)
    }
  } : Component
  environment.beforeRestore(() => renderer.render(null, root))
  let vm
  return { root, placementWork, get vm() { return vm }, get clock() { return clock }, async render(props) {
    const vnode = h(component, props); renderer.render(vnode, root)
    vm = (liveClock ? vnode.component.subTree.component : vnode.component).exposed
    await nextTick(); await nextTick()
  } }
}

test('all component hover cards omit the old model description while keeping identity and actual point rows',async t=>{
  const view=fixture(t,TooltipSurface),template=normalizeTooltipTemplates().templates.find(template=>template.kind==='part')
  const model=JSON.parse(await readFile(new URL('../../backend/assets/models/cad_cleaner_170700_metadata.json',import.meta.url),'utf8'))
  const before=JSON.stringify(model),point={id:'usage',device_id:'cleaner',label:'日使用率',unit:'%',value:0,quality:'good'}
  assert.ok(model.inspection.parts.length>1)
  for(const part of model.inspection.parts){
    const context=createTooltipContext({kind:'part',device:{id:'cleaner'},part:{...part,point_ids:['usage']},points:[point],runtimeContext:{viewMode:'device',inspectionStage:'exploded'}})
    await view.render({template,context,preview:true})
    assert.equal(view.vm.getRenderedText(`${template.id}_name`),part.name)
    assert.equal(view.vm.getRenderedText(`${template.id}_group`),part.group)
    assert.equal(view.vm.getRenderedText(`${template.id}_point_0_value`),'0 %')
    assert.equal(text(view.root).includes(part.description),false)
    assert.equal(view.vm.getRenderedText(`${template.id}_description`),undefined)
  }
  assert.equal(JSON.stringify(model),before,'model descriptions remain available for detail/inspection pages')
  assert.equal(createTooltipTemplate('part').canvas.height,224)
})

test('real tooltip SFC follows native pointer provider immediately with zero content/canvas style work or clock/API wait', async t => {
  t.mock.timers.enable({ apis:['Date', 'setInterval', 'setTimeout'], now:100000 })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return json({}) })
  const view = fixture(t, TooltipSurface, { liveClock:true })
  const pointer = reactive({ visible:true, x:.2, y:.3 })
  const context = createTooltipContext({ device:{ id:'a', name:'炉 A' }, runtimeContext:{ factoryId:'f', viewId:'overview', viewMode:'factory' } })
  const template = { id:'configured-canvas', kind:'device', canvas:{ width:200, height:80 },
    widgets:Array.from({ length:24 }, (_, index) => ({ id:`text-${index}`, type:'text',
      frame:{ x:0, y:index * 2, width:200, height:20 }, content:{ text:'{value}' }, data:{ mode:'runtime', path:'hover.device.name' } })) }
  await view.render({ context, template, pointerSource:() => pointer, viewport:{ width:1000, height:500 } })
  const before = { ...view.placementWork }, clock = view.clock.value, requests = calls.length
  for (let index = 0; index < 120; index++) {
    pointer.x = .2 + index / 500
    await nextTick()
    const host = view.root.children.find(element => element.type === 'aside')
    assert.equal(host.props.style.transform, `translate3d(${pointer.x * 1000 + 16}px, 166px, 0)`)
    assert.equal(host.props.style.left, '0px')
    assert.equal(host.props.style.top, '0px')
    assert.equal(view.vm.getRenderedText('text-0'), '炉 A')
  }
  assert.equal(view.placementWork.children, before.children, 'pointer motion must not patch 24 authored widget frames')
  assert.equal(view.placementWork.canvases, before.canvases, 'unchanged scale/background must not repatch the canvas')
  assert.equal(view.placementWork.hosts - before.hosts, 119)
  assert.equal(view.clock.value, clock)
  assert.equal(calls.length, requests)
  pointer.visible = false; await nextTick()
  assert.equal(view.root.children.some(element => element.type === 'aside'), false, 'provider null/invalid never becomes an inline live card')
})

test('tooltip content memo preserves reactive PLC reads and does not retain a hidden or previous-device response', async t => {
  const view = fixture(t, TooltipSurface)
  const pointer = reactive({ visible:true, x:.2, y:.3 })
  const points = reactive({ a:{ id:'pa', device_id:'a', category:'analog', name:'temp', value:0, quality:'good' },
    b:{ id:'pb', device_id:'b', category:'analog', name:'temp', value:999, quality:'good' } })
  const template = { id:'live-plc', canvas:{ width:200, height:80 }, widgets:[{ id:'reading', type:'text',
    frame:{ x:0, y:0, width:200, height:30 }, content:{ text:'{value}', fallback:'未连接' },
    data:{ mode:'plc', deviceScope:'current', pointKey:'analog.temp', decimals:0 } }] }
  const context = createTooltipContext({ device:{ id:'a' } })
  const props = { context, template, pointerSource:() => pointer, viewport:{ width:1000, height:500 },
    pointValues:points, deviceCatalog:[{ id:'a' }, { id:'b' }] }
  await view.render(props)
  assert.equal(view.vm.getRenderedText('reading'), '0')
  const contentStyles = view.placementWork.children
  points.a.value = 456; await nextTick()
  assert.equal(view.vm.getRenderedText('reading'), '456', 'reactive child readers update even when the surface content vnode is memoized')
  assert.equal(view.placementWork.children, contentStyles)
  await view.render({ ...props, context:createTooltipContext({ device:{ id:'b' } }) })
  assert.equal(view.vm.getRenderedText('reading'), '999', 'a real device switch invalidates the content memo')
  points.b.quality = 'stale'; await nextTick()
  assert.equal(view.vm.getRenderedText('reading'), '未连接')
})

test('tooltip dataset reader consumes the injected real timer without polling hidden or preview surfaces', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 })
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    const query = new URL(url).searchParams
    calls.push({ at: Date.now(), deviceId: query.get('device_id'), playbackAt: Number(query.get('playback_at')) })
    const value = 400 + calls.length * 10
    return json({ values: { reading: { quality: 'good', deviceId: query.get('device_id'), value,
      rows: [{ temperature: value }], refreshAfterMs: 250 } } })
  })
  const view = fixture(t, TooltipSurface, { liveClock: true })
  const context = reactive(createTooltipContext({ device: { id: 'a', name: '炉 A' },
    runtimeContext: { factoryId: 'factory', viewId: 'overview', viewMode: 'factory' } }))
  const pointer = reactive({ visible: true, x: .5, y: .5 })
  const props = { context, pointer, viewport: { width: 1000, height: 500 }, deviceCatalog: [{ id: 'a' }, { id: 'b' }],
    template: { id: 'live-dataset', kind: 'device', canvas: { width: 200, height: 80 }, widgets: [{
      id: 'reading', type: 'value', frame: { x: 0, y: 0, width: 200, height: 80 }, content: { label: '温度' },
      data: { mode: 'dataset', deviceScope: 'current', datasetId: 'temperature', datasetField: 'temperature', refreshMs: 250 } }] } }
  await view.render(props); await settle()
  assert.deepEqual(calls, [{ at: 100000, deviceId: 'a', playbackAt: 100000 }]); assert.match(text(view.root), /410/)
  t.mock.timers.tick(200); await settle(); assert.equal(calls.length, 1)
  t.mock.timers.tick(100); await settle(); assert.equal(view.clock.value, 100300)
  assert.equal(calls.length, 2); assert.match(text(view.root), /420/)
  pointer.visible = false; await settle()
  t.mock.timers.tick(2000); await settle(); assert.equal(calls.length, 2, 'hidden hover surfaces must not poll')
  Object.assign(context, createTooltipContext({ device: { id: 'b', name: '炉 B' },
    runtimeContext: { factoryId: 'factory', viewId: 'overview', viewMode: 'factory' } }))
  await settle(); assert.equal(calls.length, 2)
  pointer.visible = true; await settle()
  assert.equal(calls.length, 3); assert.equal(calls.at(-1).deviceId, 'b'); assert.match(text(view.root), /430/)
  await view.render({ ...props, preview: true }); await settle()
  t.mock.timers.tick(2000); await settle(); assert.equal(calls.length, 3, 'layout previews retain their supplied records and do not poll')
})

test('hiding a tooltip cancels its pending dataset result and a later hover reads only the new device', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 })
  const pending = deferred(), calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const deviceId = new URL(url).searchParams.get('device_id')
    calls.push({ deviceId, signal: options.signal })
    return calls.length === 1 ? pending.promise : Promise.resolve(json({ values: { reading: {
      quality: 'good', deviceId, value: 720, rows: [{ temperature: 720 }], refreshAfterMs: 250
    } } }))
  })
  const view = fixture(t, TooltipSurface, { liveClock: true })
  const context = reactive(createTooltipContext({ device: { id: 'a', name: '炉 A' }, runtimeContext: { factoryId: 'factory', viewMode: 'factory' } }))
  const pointer = reactive({ visible: true, x: .5, y: .5 })
  await view.render({ context, pointer, viewport: { width: 1000, height: 500 }, deviceCatalog: [{ id: 'a' }, { id: 'b' }],
    template: { id: 'pending-dataset', kind: 'device', canvas: { width: 200, height: 80 }, widgets: [{
      id: 'reading', type: 'value', frame: { x: 0, y: 0, width: 200, height: 80 },
      data: { mode: 'dataset', deviceScope: 'current', datasetId: 'temperature', datasetField: 'temperature', refreshMs: 250 }
    }] } })
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false)
  pointer.visible = false; await settle(); assert.equal(calls[0].signal.aborted, true)
  pending.resolve(json({ values: { reading: { quality: 'good', deviceId: 'a', value: 9999, rows: [{ temperature: 9999 }] } } }))
  t.mock.timers.tick(1000); await settle(); assert.equal(calls.length, 1)
  Object.assign(context, createTooltipContext({ device: { id: 'b', name: '炉 B' }, runtimeContext: { factoryId: 'factory', viewMode: 'factory' } }))
  pointer.visible = true; await settle()
  assert.equal(calls.length, 2); assert.equal(calls[1].deviceId, 'b')
  assert.match(text(view.root), /720/); assert.doesNotMatch(text(view.root), /9999/)
})

test('tooltip identity is current hover metadata even before PLC readiness and never the selected device', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ device: { id: 'b', name: '悬停设备 B' }, runtimeContext: { viewMode: 'factory', deviceId: 'a' } })
  const widget = { id: 'title', type: 'text', content: { text: '{value}', showTitle: false }, data: { mode: 'runtime', path: 'hover.device.name' } }
  await view.render({ widget, runtimeContext, overlayMode: true, dataReady: false, deviceCatalog: [{ id: 'a', name: '设备 A' }] })
  assert.match(text(view.root), /悬停设备 B/)
  assert.doesNotMatch(text(view.root), /设备 A|正在同步当前数据/)
})

test('current tooltip PLC bindings resolve matching current-device points and withhold late/stale readings', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ device: { id: 'b', name: 'B' }, runtimeContext: { viewMode: 'factory' } })
  const widget = { id: 'reading', type: 'text', content: { text: '{value} {unit}', fallback: '未连接' }, data: { mode: 'plc', deviceScope: 'current', pointId: 'template_a', pointKey: 'analog.temp', unit: '°C', decimals: 1 } }
  const points = { template_a: { id: 'template_a', device_id: 'a', category: 'analog', value_role: 'temp', value: 999, quality: 'good' }, b: { id: 'p_b', device_id: 'b', category: 'analog', value_role: 'temp', value: 0, quality: 'good' } }
  await view.render({ widget, runtimeContext, pointValues: points, deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
  assert.match(text(view.root), /0\.0 °C/)
  assert.doesNotMatch(text(view.root), /999/)
  await view.render({ widget, runtimeContext, pointValues: { ...points, b: { ...points.b, value: 666, quality: 'stale' } } })
  assert.match(text(view.root), /未连接/)
  assert.doesNotMatch(text(view.root), /666|999/)
  await view.render({ widget, runtimeContext, pointValues: { template_a: points.template_a } })
  assert.doesNotMatch(text(view.root), /999|0\.0/)
})

test('hover-pinned current and rotating PLC references reuse only a unique hovered-device role after the sample ID disappears', async t => {
  const view = fixture(t)
  const context = createTooltipContext({ device: { id: 'b', name: 'B' } })
  const widget = { id: 'reading', type: 'text', content: { text: '{value} {unit}', fallback: '未连接' },
    data: { mode: 'plc', deviceScope: 'current', pointId: 'deleted_sample', pointKey: 'analog.temp', unit: '°C', decimals: 1 } }
  const points = { b: { id: 'p_b', device_id: 'b', category: 'analog', value_role: 'temp', value: 0, quality: 'good' },
    foreign: { id: 'p_a', device_id: 'a', category: 'analog', value_role: 'temp', value: 999, quality: 'good' } }
  const before = JSON.stringify(widget)
  for (const deviceScope of ['current', 'rotation']) {
    await view.render({ widget: { ...widget, data: { ...widget.data, deviceScope, rotationDeviceIds: ['a', 'b'] } }, runtimeContext: context,
      pointValues: points, deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
    assert.equal(view.vm.getRenderedText(), '0.0 °C')
    await view.render({ widget: { ...widget, data: { ...widget.data, deviceScope } }, runtimeContext: context,
      pointValues: { ...points, duplicate: { ...points.b, id: 'duplicate', value: 666 } } })
    assert.equal(view.vm.getRenderedText(), '未连接 °C', 'ambiguous roles cannot silently pick a reading')
  }
  assert.equal(JSON.stringify(widget), before)
})

test('explicit fixed tooltip PLC references remain strict and never read a same-role replacement or hovered peer', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ device: { id: 'b', name: 'B' } })
  const widget = { id: 'fixed', type: 'text', content: { text: '{value}', fallback: '原绑定失效' },
    data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'a', pointId: 'deleted', pointKey: 'analog.temp', decimals: 0 } }
  const pointValues = { replacement: { id: 'replacement', device_id: 'a', category: 'analog', value_role: 'temp', value: 777, quality: 'good' },
    peer: { id: 'peer', device_id: 'b', category: 'analog', value_role: 'temp', value: 999, quality: 'good' } }
  await view.render({ widget, runtimeContext, pointValues, deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(view.vm.getRenderedText(), '原绑定失效')
  await view.render({ widget, runtimeContext, pointValues: { ...pointValues, deleted: { ...pointValues.replacement, id: 'deleted', value: 0 } },
    deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(view.vm.getRenderedText(), '0', 'an available exact fixed point is still displayed')
})

test('real TooltipSurface preserves authored PLC scope before passing a hover-pinned widget to the renderer', async t => {
  const view = fixture(t, TooltipSurface)
  const widget = { id: 'surface_reading', type: 'text', frame: { width: 150, height: 30 }, content: { text: '{value}', fallback: '未连接' },
    data: { mode: 'plc', deviceScope: 'current', pointId: 'old_sample', pointKey: 'analog.temp', decimals: 0 } }
  const template = { id: 'surface', canvas: { width: 280, height: 230 }, widgets: [widget] }
  const before = JSON.stringify(template)
  const pointValues = { b: { id: 'p_b', device_id: 'b', category: 'analog', value_role: 'temp', value: 0, quality: 'good' },
    a: { id: 'p_a', device_id: 'a', category: 'analog', value_role: 'temp', value: 999, quality: 'good' } }
  const context = createTooltipContext({ device: { id: 'b' } })
  await view.render({ template, context, preview: true, pointValues, deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(view.vm.getRenderedText(widget.id), '0')
  const fixed = { ...template, widgets: [{ ...widget, data: { ...widget.data, deviceScope: 'fixed', deviceId: 'a' } }] }
  await view.render({ template: fixed, context, preview: true, pointValues, deviceCatalog: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(view.vm.getRenderedText(widget.id), '未连接')
  assert.equal(JSON.stringify(template), before)
})

test('tooltip part text and per-field mappings preserve real zero and clear obsolete values', async t => {
  const view = fixture(t), part = { id: 'fan', name: '风机', points: [{ id: 'p', device_id: 'b', value: 0, quality: 'good', unit: 'rpm' }] }
  const context = createTooltipContext({ kind: 'part', device: { id: 'b' }, part })
  const widget = { id: 'part_value', type: 'text', content: { text: '{value}', valueMap: [{ value: 0, text: '停止' }], fallback: '缺少数据' }, data: { mode: 'runtime', path: 'hover.part.points.0.value' } }
  await view.render({ widget, runtimeContext: context })
  assert.match(text(view.root), /停止/)
  const missing = createTooltipContext({ kind: 'part', device: { id: 'b' }, part: { id: 'another' } })
  await view.render({ widget, runtimeContext: missing })
  assert.match(text(view.root), /缺少数据/)
  assert.doesNotMatch(text(view.root), /停止/)
})

test('bad external responses do not show a stale tooltip value or configured example as a live reading', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ device: { id: 'b' } })
  const widget = { id: 'external', type: 'text', content: { text: '{value}', value: 888, fallback: '无记录' }, data: { mode: 'http_api' } }
  await view.render({ widget, runtimeContext, databaseValues: { external: { value: 999, quality: 'bad', rows: [] } } })
  assert.match(text(view.root), /无记录/)
  assert.doesNotMatch(text(view.root), /888|999/)
})

test('tooltip text units follow the hovered point and an empty authored text stays hidden', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ kind: 'part', device: { id: 'b' }, part: { id: 'fan', points: [{ id: 'p', device_id: 'b', value: 0, quality: 'good', unit: 'rpm' }] } })
  const widget = { id: 'speed', type: 'text', content: { text: '{value}{unit}' }, data: { mode: 'runtime', path: 'hover.part.points.0.value', decimals: 0 } }
  await view.render({ widget, runtimeContext })
  assert.match(text(view.root), /0 rpm/)
  await view.render({ widget: { ...widget, title: '不应出现标题', content: { text: '', showTitle: false }, data: { mode: 'static' } }, runtimeContext })
  assert.doesNotMatch(text(view.root), /不应出现标题|文本组件|0 rpm/)
})

test('tooltip numeric elements allow empty internal labels and retain configured alignment', async t => {
  const view = fixture(t), runtimeContext = createTooltipContext({ device: { id: 'b' } })
  const widget = { id: 'number', title: '图层名不作标签', type: 'value', content: { value: 0, label: '', showTitle: false, align: 'right' }, data: { mode: 'static', decimals: 0 } }
  await view.render({ widget, runtimeContext })
  assert.match(text(view.root), /0/)
  assert.doesNotMatch(text(view.root), /图层名不作标签/)
  const body = view.root.children[0].children.find(child => child.props.class?.includes('value-widget-body'))
  assert.equal(body.props.style.textAlign, 'right')
})

test('designer text capture uses the renderer exact multiline and parameter-substituted wording', async t => {
  const view = fixture(t)
  const runtimeContext = createTooltipContext({ kind: 'part', device: { id: 'b' }, part: { id: 'rail', description: '第一行说明\n第二行说明' } })
  const widget = { id: 'description', type: 'text', content: { text: '{value}\n批次 {parameters.batch}', fallback: '—' }, data: { mode: 'runtime', path: 'hover.part.description' } }
  await view.render({ widget, runtimeContext, parameters: { batch: 'A-1' } })
  assert.equal(view.vm.getRenderedText(), '第一行说明\n第二行说明\n批次 A-1')
  await view.render({ widget, runtimeContext, parameters: { batch: 'B-2' } })
  assert.equal(view.vm.getRenderedText(), '第一行说明\n第二行说明\n批次 B-2')
})

test('designer text capture preserves actual zero, units and mapped text rather than raw binding values', async t => {
  const view = fixture(t)
  const runtimeContext = createTooltipContext({ kind: 'part', device: { id: 'b' }, part: { id: 'fan', points: [{ id: 'p', device_id: 'b', value: 0, unit: 'rpm', quality: 'good' }] } })
  const widget = { id: 'speed', type: 'text', content: { text: '{value}{unit}', fallback: '无数据' }, data: { mode: 'runtime', path: 'hover.part.points.0.value', decimals: 0 } }
  await view.render({ widget, runtimeContext })
  assert.equal(view.vm.getRenderedText(), '0 rpm')
  await view.render({ widget: { ...widget, content: { ...widget.content, valueMap: [{ value: 0, text: '停止' }] } }, runtimeContext })
  assert.equal(view.vm.getRenderedText(), '停止 rpm')
})

test('linked tooltip metadata stays tied to the hovered object and cannot be renamed by a text mapping', async t => {
  const view = fixture(t)
  const widget = { id: 'workshop', type: 'text', content: { text: '{value}', valueMap: [{ value: '车间 A', text: '假的固定车间' }] }, data: { mode: 'runtime', path: 'hover.device.workshopName' } }
  await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'a', workshopName: '车间 A' } }) })
  assert.equal(view.vm.getRenderedText(), '车间 A')
  await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'b', workshopName: '车间 B' } }) })
  assert.equal(view.vm.getRenderedText(), '车间 B')
  await view.render({ widget: { ...widget, content: { text: '旧模板里的固定车间' } }, runtimeContext: createTooltipContext({ device: { id: 'b', workshopName: '车间 B' } }) })
  assert.equal(view.vm.getRenderedText(), '车间 B', 'legacy bound formats cannot substitute a constant for associated data')
  const disconnected = createTooltipContext({ device: { id: 'b' }, status: { quality: 'bad' } })
  const actualStatus = disconnected.hover.device.status
  await view.render({ widget: { ...widget, id: 'status', content: { text: '{value}', valueMap: [{ value: actualStatus, text: '数据正常' }] }, data: { mode: 'runtime', path: 'hover.device.status' } }, runtimeContext: disconnected })
  assert.equal(view.vm.getRenderedText(), actualStatus)
  assert.notEqual(view.vm.getRenderedText(), '数据正常')
})

test('device status renders live good, stale, bad, unknown and recovered states independently of process flags', async t => {
  const view = fixture(t), widget = { id: 'data_status', type: 'text', content: { text: '{value}', showTitle: false,
    valueMap: [{ value: '数据异常 / 未连接', text: '数据正常' }, { value: '暂无实时数据', text: '数据正常' }] },
    data: { mode: 'runtime', path: 'hover.device.status' } }
  for (const [status, expected] of [
    [{ quality: 'good', online: true, running: false, alarm: true }, '数据正常'],
    [{ quality: 'stale', online: false, lastSeen: Date.now() }, '数据已过期'],
    [{ quality: 'bad', online: false, lastSeen: Date.now() }, '数据异常 / 未连接'],
    [{ quality: 'unknown', online: true, lastSeen: Date.now() }, '暂无实时数据'],
    [{ lastSeen: Date.now() }, '暂无实时数据'],
    [{ quality: 'good', online: true, running: true, alarm: false }, '数据正常']
  ]) {
    await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'b' }, status }), overlayMode: true })
    assert.equal(view.vm.getRenderedText(), expected)
  }
})

test('a frozen tooltip field with binding provenance is repaired in the renderer and follows device identity and status', async t => {
  const view = fixture(t), widget = { id: 'old_status', type: 'text', content: { text: '数据正常', showTitle: false },
    data: { mode: 'static' }, dynamicBinding: { mode: 'runtime', path: 'hover.device.status', deviceScope: 'current', readOnly: true } }
  const before = JSON.stringify(widget)
  await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'a' }, status: { quality: 'good' } }) })
  assert.equal(view.vm.getRenderedText(), '数据正常')
  await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'b' }, status: { quality: 'bad' } }) })
  assert.equal(view.vm.getRenderedText(), '数据异常 / 未连接')
  await view.render({ widget: { ...widget, dynamicBinding: { mode: 'runtime', path: 'hover.device.workshopName', deviceScope: 'current', readOnly: true } },
    runtimeContext: createTooltipContext({ device: { id: 'b', workshopName: '车间 B' } }) })
  assert.equal(view.vm.getRenderedText(), '车间 B')
  assert.equal(JSON.stringify(widget), before)
})

test('a tooltip data-status lamp cannot turn disconnected or unknown strings into an on state or custom healthy text', async t => {
  const view = fixture(t), widget = { id: 'live_status_lamp', type: 'status', content: { label: '数据状态',
    onText: '永远正常', offText: '永远正常', unknownText: '永远正常' }, data: { mode: 'runtime', path: 'hover.device.status' } }
  const findBody = root => String(root.props.class || '').includes('status-widget-body') ? root : root.children.map(findBody).find(Boolean)
  for (const [status, expected, healthy] of [
    [{ quality: 'good', online: true }, '数据正常', true],
    [{ quality: 'bad', online: false, lastSeen: Date.now() }, '数据异常 / 未连接', false],
    [{ quality: 'stale', online: false, lastSeen: Date.now() }, '数据已过期', false],
    [{ quality: 'unknown', online: true, lastSeen: Date.now() }, '暂无实时数据', false],
    [{ quality: 'good', online: false }, '数据异常 / 未连接', false]
  ]) {
    await view.render({ widget, runtimeContext: createTooltipContext({ device: { id: 'b' }, status }) })
    assert.ok(text(view.root).includes(expected), text(view.root))
    assert.doesNotMatch(text(view.root), /永远正常/)
    const body = findBody(view.root)
    assert.ok(body)
    assert.equal(String(body.props.class).includes('state-on'), healthy, JSON.stringify(status))
  }
})

test('linked device and part point names, IDs and units follow the current point definition and cannot be mapped to constants', async t => {
  const view = fixture(t)
  const reading = (id, deviceId, name, unit) => ({ id, device_id: deviceId, category: 'analog', value_role: 'temp',
    display_name: name, unit, value: 0, quality: 'good' })
  const first = createTooltipContext({ kind: 'part', device: { id: 'a' }, part: { id: 'part_a', pointIds: ['pa'] }, points: [reading('pa', 'a', '炉 A 温度', '°C')] })
  const second = createTooltipContext({ kind: 'part', device: { id: 'b' }, part: { id: 'part_b', pointIds: ['pb'] }, points: [reading('pb', 'b', '炉 B 温度', 'K')] })
  for (const prefix of ['hover.device.pointMap.analog.temp', 'hover.part.points.0']) {
    for (const [field, initial, next] of [['name', '炉 A 温度', '炉 B 温度'], ['label', '炉 A 温度', '炉 B 温度'], ['id', 'pa', 'pb'], ['unit', '°C', 'K']]) {
      const widget = { id: 'linked_point_field', type: 'text', content: { text: '{value}', showTitle: false,
        valueMap: [{ value: initial, text: '伪造常量' }, { value: next, text: '伪造常量' }] }, data: { mode: 'runtime', path: `${prefix}.${field}` } }
      await view.render({ widget, runtimeContext: first })
      assert.equal(view.vm.getRenderedText(), initial)
      await view.render({ widget, runtimeContext: second })
      assert.equal(view.vm.getRenderedText(), next)
      await view.render({ widget: { ...widget, data: { mode: 'static', path: `${prefix}.${field}` }, content: { ...widget.content, text: '旧固定点位信息' } }, runtimeContext: second })
      assert.equal(view.vm.getRenderedText(), next)
    }
    const valueWidget = { id: 'point_code', type: 'text', content: { text: '{value}', valueMap: [{ value: 0, text: '停止' }] },
      data: { mode: 'runtime', path: `${prefix}.value` } }
    await view.render({ widget: valueWidget, runtimeContext: second })
    assert.equal(view.vm.getRenderedText(), '停止', 'numeric point-code mappings are intentionally still supported')
  }
})

test('missing linked metadata cannot be replaced by an invented association through a saved fallback', async t => {
  const view = fixture(t), context = createTooltipContext({ device: { id: 'a' }, status: { quality: 'good' } })
  for (const path of ['hover.device.workshopName', 'hover.device.lineName', 'hover.device.pointMap.analog.missing.name']) {
    await view.render({ runtimeContext: context, widget: { id: 'linked_missing', type: 'text',
      data: { mode: 'runtime', path }, content: { text: '{value}', fallback: '伪造的默认车间／产线', showTitle: false } } })
    assert.equal(view.vm.getRenderedText(), '—')
    assert.doesNotMatch(text(view.root), /伪造/)
  }
})
