import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, provide, reactive, ref } from 'vue'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { installBrowser } from './helpers.mjs'
import { catalogBinding } from '../src/runtime/dataCatalog.js'
import { createTooltipContext } from '../src/runtime/tooltipContext.js'
import { WidgetClockKey, WidgetPlaybackKey, createWidgetPlaybackController } from '../src/runtime/widgetPlayback.js'

const charts = []
mock.module('echarts', { namedExports: { init: element => {
    const chart = {
        element, options: [], disposed: false, resizeCount: 0,
        setOption(...args) { this.options.push(args) },
        resize() { this.resizeCount += 1 },
        dispose() { this.disposed = true }
    }
    charts.push(chart)
    return chart
} } })

const source = await readFile(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const ringDescriptor = parse(await readFile(new URL('../src/runtime/HudMetricRing.vue', import.meta.url), 'utf8')).descriptor
const ringCode = compileScript(ringDescriptor, { id: 'shared-hud-ring-regression', inlineTemplate: true }).content
    .replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
const ringModule = `data:text/javascript;base64,${Buffer.from(ringCode).toString('base64')}`
let compiled = compileScript(descriptor, { id: 'widget-regression', inlineTemplate: true }).content
    .replace(/from (['"])(vue|echarts)\1/g, (_, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
    .replace(/from (['"])\.\/hudPresentation\.js\1/g, `from ${JSON.stringify(new URL('../src/runtime/hudPresentation.js', import.meta.url).href)}`)
    .replace(/from (['"])\.\.\/\.\.\/\.\.\/shared\/dashboardParameters\.mjs\1/g, `from ${JSON.stringify(new URL('../../shared/dashboardParameters.mjs', import.meta.url).href)}`)
compiled=compiled.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,(_m,_q,name)=>`from ${JSON.stringify(new URL(name,new URL('../src/runtime/WidgetRenderer.vue',import.meta.url)).href)}`)
compiled=compiled.replace(/from (["'])([^"']*HudMetricRing\.vue)\1/g, `from ${JSON.stringify(ringModule)}`)
compiled=compiled.replace(/from (["'])([^"']+\.vue)\1/g, `from 'data:text/javascript,export default {}'`)
const { default: WidgetRenderer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const hudSource = await readFile(new URL('../src/runtime/hudWidgets.css', import.meta.url), 'utf8')
const hudStyles = compileStyle({ source: hudSource, id: 'hud-regression' })
assert.deepEqual(hudStyles.errors, [])

function hudDeclarations(selector) {
    const declarations = {}
    hudStyles.rawResult.root.walkRules(rule => {
        if (rule.selector === selector) rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    })
    assert.ok(Object.keys(declarations).length, `Missing HUD rule: ${selector}`)
    return declarations
}

function node(type, text = '') { return { type, text, children: [], props: {}, style: {}, parent: null } }
function fixture(t, { clock, controller } = {}) {
    const environment = installBrowser(t)
    charts.length = 0
    const observers = []
    environment.replace('ResizeObserver', class {
        constructor(callback) { this.callback = callback; observers.push(this) }
        observe(element) { this.element = element; this.disconnected = false }
        disconnect() { this.disconnected = true }
    })
    const renderer = createRenderer({
        createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
        setText: (element, text) => { element.text = text }, setElementText: (element, text) => { element.text = text; element.children = [] },
        parentNode: element => element.parent,
        nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
        patchProp: (element, key, _previous, value) => { element.props[key] = value },
        insert(element, parent, anchor = null) {
            if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
            element.parent = parent
            const index = parent.children.indexOf(anchor)
            if (index < 0) parent.children.push(element)
            else parent.children.splice(index, 0, element)
        },
        remove(element) {
            if (element?.parent) element.parent.children = element.parent.children.filter(child => child !== element)
            if (element) element.parent = null
        }
    })
    const root = node('root')
    let updates = 0
    const component = clock ? {
        inheritAttrs: false,
        setup(_props, { attrs }) {
            provide(WidgetClockKey, clock)
            if (controller) provide(WidgetPlaybackKey, controller)
            return () => h(WidgetRenderer, { ...attrs, onVnodeUpdated: () => { updates++ } })
        }
    } : WidgetRenderer
    environment.beforeRestore(() => renderer.render(null, root))
    return {
        root, observers, updates: () => updates,
        render: async props => { renderer.render(h(component, props), root); await nextTick(); await nextTick() }
    }
}

const textContent = root => [root.text, ...root.children.map(textContent)].join(' ')

test('shared reader clock causes no component updates for static or unchanged fixed-device cards', async t => {
    const clock = ref(1000), view = fixture(t, { clock })
    await view.render({ widget: { id: 'static', type: 'text', content: { text: '生产现场' }, data: { mode: 'static', deviceScope: 'global' } } })
    const initial = view.updates()
    for (let time = 1100; time <= 12100; time += 100) { clock.value = time; await nextTick(); await nextTick() }
    assert.equal(view.updates(), initial, 'a static card must not patch 111 times for the external-reader timer')
    const readings = reactive({ a: { analog: { temperature: 700 } } })
    await view.render({ widget: { id: 'fixed', type: 'value', data: { mode: 'runtime', path: 'device.analog.temperature', deviceScope: 'fixed', deviceId: 'a' } },
        deviceCatalog: [{ id: 'a', name: '炉 A' }], deviceDataMap: readings })
    const fixed = view.updates()
    for (let time = 12200; time <= 25000; time += 100) { clock.value = time; await nextTick(); await nextTick() }
    assert.equal(view.updates(), fixed)
    readings.a.analog.temperature = 701; await nextTick(); await nextTick()
    assert.equal(view.updates(), fixed + 1, 'live data still patches immediately, without advancing the clock')
    assert.match(textContent(view.root), /701/)
})

test('injected clock keeps rotation and hover remaining time exact while live PLC history advances', async t => {
    const clock = ref(1500), controller = createWidgetPlaybackController(), view = fixture(t, { clock, controller })
    const widget = { id: 'injected-hover', type: 'hud_chart_dock', title: '炉温', content: { chartType: 'line' },
        data: { mode: 'plc', pointKey: 'analog.temperature', path: 'analog.temperature', requireConfiguredPoint: true,
            deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000, refreshMs: 1000 } }
    const points = reactive({ pa: { id: 'pa', device_id: 'a', category: 'analog', value_role: 'temperature', quality: 'good', lastReadAt: 1500, value: 111 },
        pb: { id: 'pb', device_id: 'b', category: 'analog', value_role: 'temperature', quality: 'good', lastReadAt: 1500, value: 850 } })
    await view.render({ widget, deviceCatalog: [{ id: 'a', name: '炉 A' }, { id: 'b', name: '炉 B' }],
        runtimeContext: { viewMode: 'factory' }, interactive: true, overlayMode: true, pointValues: points })
    clock.value = 1650; await nextTick(); await nextTick()
    view.root.children[0].props.onMouseenter()
    assert.equal(controller.timeFor(widget, 6000), 1650, 'hover must use raw time, not the quantized start of the rotation slot')
    for (const [time, value] of [[2500, 112], [4500, 113], [6500, 114]]) {
        clock.value = time; points.pa.value = value; points.pa.lastReadAt = time
        await nextTick(); await nextTick()
        assert.match(textContent(view.root), /炉 A/)
        assert.equal(charts.at(-1).options.at(-1)[0].series[0].data.at(-1), value)
    }
    view.root.children[0].props.onMouseleave()
    clock.value = 6849; await nextTick(); await nextTick(); assert.match(textContent(view.root), /炉 A/)
    clock.value = 6850; await nextTick(); await nextTick(); assert.match(textContent(view.root), /炉 B/)
    assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data, [850])
})

test('explicit designer clock still overrides an injected live surface clock', async t => {
    const clock = ref(100000), view = fixture(t, { clock })
    const props = { widget: { id: 'explicit', type: 'value', data: { mode: 'runtime', path: 'device.analog.temperature',
        deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000 } },
        deviceCatalog: [{ id: 'a', name: '炉 A' }, { id: 'b', name: '炉 B' }], deviceDataMap: { a: { analog: { temperature: 1 } }, b: { analog: { temperature: 2 } } } }
    await view.render({ ...props, playbackNow: 0 }); assert.match(textContent(view.root), /炉 A/)
    const initial = view.updates(); clock.value = 102000; await nextTick(); await nextTick()
    assert.equal(view.updates(), initial); assert.match(textContent(view.root), /炉 A/)
    await view.render({ ...props, playbackNow: 2000 }); assert.match(textContent(view.root), /炉 B/)
})

test('chart watchers never traverse unrelated telemetry/events/business data but still render real sample changes', async t => {
    const view = fixture(t), visits = { metrics: 0, events: 0, business: 0 }
    const unrelated = name => reactive(Object.defineProperty({ revision: 0 }, 'unrelated', {
        enumerable: true, get() { visits[name]++; return Array.from({ length: 1000 }, (_, index) => index) }
    }))
    const metrics = unrelated('metrics'), events = reactive([unrelated('events')]), businessData = unrelated('business')
    const points = reactive([{ time: '10:00', value: 42 }])
    await view.render({ widget: { id: 'narrow-chart', type: 'trend', content: { chartType: 'line' },
        data: { mode: 'runtime', deviceScope: 'global', path: 'trendPoints' } }, metrics, events, businessData, trendPoints: points })
    assert.deepEqual(visits, { metrics: 0, events: 0, business: 0 })
    const chart = charts.at(-1), rendered = chart.options.length
    metrics.revision++; events[0].revision++; businessData.revision++; await nextTick(); await nextTick()
    assert.deepEqual(visits, { metrics: 0, events: 0, business: 0 }); assert.equal(chart.options.length, rendered)
    points.push({ time: '10:01', value: 43 }); await nextTick(); await nextTick()
    assert.equal(chart.options.length, rendered + 1)
    assert.deepEqual(chart.options.at(-1)[0].series[0].data, [42, 43])
})

test('approved basic efficiency gauges reuse the actual HUD SVG ring and the unchanged bound reading', async t => {
    const view = fixture(t), widget = { id: 'old_efficiency_gauge', type: 'trend',
        style: { surfaceSkin: 'inline' }, data: { mode: 'runtime', path: 'metrics.overall_oee', unit: '%' },
        content: { chartType: 'gauge', min: 0, max: 100, showTitle: false } }
    const before = JSON.stringify(widget)
    await view.render({ widget, overlayMode: true, metrics: { overall_oee: 92.2 } })
    assert.match(textContent(view.root), /92.2/)
    const walk = node => [node, ...node.children.flatMap(walk)]
    assert.ok(walk(view.root).some(node => String(node.props.class || '').includes('hud-module-ring')))
    assert.equal(charts.length, 0, 'do not draw the old blue ECharts half-gauge behind the shared source ring')
    await view.render({ widget, overlayMode: true, metrics: { overall_oee: 84.6 } })
    assert.match(textContent(view.root), /84.6/); assert.doesNotMatch(textContent(view.root), /92.2/)
    assert.equal(JSON.stringify(widget), before)
})
test('dataset numeric cards and gauges inherit the output unit, while an explicit widget unit wins', async t => {
 const view=fixture(t),widget={id:'with_unit',type:'value',data:{mode:'dataset',datasetField:'temperature'},content:{}};
 const record={quality:'good',value:0,unit:'°C',rows:[{temperature:0}]};
 await view.render({widget,databaseValues:{with_unit:record}});
 assert.match(textContent(view.root),/0.*°C/);
 await view.render({widget:{...widget,data:{...widget.data,unit:'K'}},databaseValues:{with_unit:record}});
 assert.match(textContent(view.root),/0.*K/);assert.doesNotMatch(textContent(view.root),/°C/);
 await view.render({widget:{...widget,type:'trend',content:{chartType:'gauge'}},databaseValues:{with_unit:record}});
 assert.ok(charts.at(-1).options.at(-1)[0].series[0].detail.formatter.includes('°C'));
})
test('external-only overlay leaves the loading skeleton when its binding responds even without a PLC ready frame',async t=>{
 const view=fixture(t),widget={id:'http_panel',type:'hud_kpi_panel',data:{mode:'dataset',datasetId:'parts',datasetField:'temperature'},content:{showRing:false,items:[{label:'温度',path:'dataset.temperature'}]}}
 await view.render({widget,overlayMode:true,dataReady:false,databaseValues:{http_panel:{value:75,rows:[{temperature:75}],columns:[{name:'temperature',type:'number'}],quality:'good'}}})
 assert.match(textContent(view.root),/75/);assert.doesNotMatch(textContent(view.root),/正在同步当前数据/)
 await view.render({widget,overlayMode:true,dataReady:false,databaseValues:{http_panel:{value:null,rows:[],quality:'bad'}}})
 assert.doesNotMatch(textContent(view.root),/75|正在同步当前数据/)
})
test('device lists and business summaries consume their dataset rows, not unrelated global device or business data',async t=>{
 const view=fixture(t),record={quality:'good',value:0,rows:[{id:'a',name:'当前接口设备',online:true,running:false,alarm:false,temp:0,value:0,msg:'当前接口工单'}]}
 for(const type of ['device_list','hud_device_status','business_summary']){
  const widget={id:'external_rows',type,data:{mode:'dataset',datasetField:'value'},content:{}}
  await view.render({widget,overlayMode:true,dataReady:false,databaseValues:{external_rows:record},deviceStatusMap:{foreign:{name:'不应出现',online:true}},businessData:{status:'ready',sections:{batches:{available:true,rows:[{id:'不应出现'}]}}}})
  assert.match(textContent(view.root),/当前接口设备/);assert.doesNotMatch(textContent(view.root),/不应出现|正在同步当前数据/)
  await view.render({widget,overlayMode:true,dataReady:false,databaseValues:{external_rows:{quality:'bad',rows:[],value:null}}})
  assert.doesNotMatch(textContent(view.root),/当前接口设备/)
 }
})
test('part-point panels accept real zero values but reject stale points and late responses for a different part',async t=>{
 const view=fixture(t),widget={id:'part',type:'hud_kpi_panel',content:{showRing:false,usePartPoints:true,items:[]},data:{mode:'runtime',path:'selectedPart.name',refreshMs:1000}}
 const base={widget,deviceCatalog:[{id:'a',name:'设备 A'}],runtimeContext:{viewId:'device_part',viewMode:'device',deviceId:'a',partId:'part_b'},playbackNow:1000}
 await view.render({...base,selectedPart:{id:'part_b',name:'部件 B',points:[{name:'反馈',value:0,quality:'good',unit:'mm'}]}})
 assert.match(textContent(view.root),/0.*mm/)
 await view.render({...base,playbackNow:2000,selectedPart:{id:'part_b',points:[{name:'反馈',value:9876,quality:'stale'}]}})
 assert.doesNotMatch(textContent(view.root),/9876/)
 await view.render({...base,playbackNow:3000,selectedPart:{id:'part_a',points:[{name:'反馈',value:4321,quality:'good'}]}})
 assert.doesNotMatch(textContent(view.root),/4321/)
})
const findNode = (root, match) => match(root) ? root : root.children.map(child => findNode(child, match)).find(Boolean)

test('authored HUD surface properties reach designer and runtime rather than the fixed skin', async t => {
    const view=fixture(t), style={background:'rgba(30, 90, 180, .8)',backgroundOpacity:.6,color:'#ff625f',borderColor:'#33ff66',borderRadius:24,padding:28,fontSize:28,shadow:'none',opacity:.75}
    for(const type of ['hud_kpi_panel','hud_device_status','hud_alarm_panel','hud_chart_dock'])for(const overlayMode of [false,true]){
        await view.render({widget:{type,style,content:{items:[]}},overlayMode})
        const rendered=view.root.children[0].props.style
        assert.equal(rendered['--hud-glass-bg'],'rgba(30, 90, 180, 0.6)')
        assert.equal(rendered['--widget-border-color'],'#33ff66')
        assert.equal(rendered['--widget-radius'],'24px')
        assert.equal(rendered['--widget-padding'],'28px')
        assert.equal(rendered['--hud-module-font-size'],'28px')
        assert.equal(rendered['--module-text'],'#ff625f')
        assert.equal(rendered['--widget-shadow'],'none')
        assert.equal(rendered.opacity,.75)
    }
})

test('HUD chart fill uses its independent authored color and alpha; chart typography follows the widget', async t => {
    const view=fixture(t), widget={type:'hud_chart_dock',style:{color:'#ff625f',fontSize:28},content:{chartType:'area',lineColor:'#aa33ff',areaColor:'rgba(10, 220, 80, .5)',areaOpacity:.6,showAxis:true}}
    await view.render({widget,overlayMode:true,trendPoints:[{time:'a',value:1},{time:'b',value:2}]})
    const option=charts.at(-1).options.at(-1)[0]
    assert.equal(option.series[0].lineStyle.color,'#aa33ff')
    assert.equal(option.series[0].areaStyle.color.colorStops[0].color,'rgba(10, 220, 80, 0.3)')
    assert.equal(option.textStyle.color,'#ff625f')
    assert.equal(option.xAxis.axisLabel.color,'#ff625f')
    assert.equal(option.yAxis.axisLabel.fontSize,22)
    assert.equal(option.grid.top,34, 'larger unit captions retain enough top space instead of clipping')
    assert.equal(option.tooltip.textStyle.fontSize,24)
    await view.render({widget:{...widget,id:'external',data:{mode:'dataset',datasetField:'value'}},overlayMode:true,databaseValues:{external:{quality:'good',rows:[{time:'a',value:1},{time:'b',value:2}],series:[{id:'value',color:'#55c7ff',rows:[{time:'a',value:1},{time:'b',value:2}]}]}}})
    assert.equal(charts.at(-1).options.at(-1)[0].series[0].lineStyle.color,'#aa33ff','a generated dataset color cannot disable the single-curve color control')
})

test('HUD subtitle uses the same default in designer and overlay, allows custom text and truly hides a blank value', async t => {
    const view = fixture(t)
    for (const [type, fallback] of [['hud_kpi_panel','PRODUCTION'], ['hud_device_status','EQUIPMENT'], ['hud_alarm_panel','EVENT LOG'], ['hud_chart_dock','PROCESS TREND']]) {
        for (const overlayMode of [false, true]) {
            const widget = { type, title: '我的面板', content: { items: [] } }
            await view.render({ widget, overlayMode })
            assert.equal(findNode(view.root, e => e.props.class === 'hud-module-eyebrow').text, fallback)
            await view.render({ widget: { ...widget, content: { ...widget.content, eyebrow: '车间 · 当班统计' }, style: { eyebrowFontSize: 14, eyebrowColor: '#aad9ff' } }, overlayMode })
            assert.equal(findNode(view.root, e => e.props.class === 'hud-module-eyebrow').text, '车间 · 当班统计')
            const shell = findNode(view.root, e => e.props.style?.['--hud-eyebrow-size'])
            assert.equal(shell.props.style['--hud-eyebrow-size'], '14px')
            assert.equal(shell.props.style['--hud-eyebrow-color'], '#aad9ff')
            for (const eyebrow of ['', '  ', null]) {
                await view.render({ widget: { ...widget, content: { ...widget.content, eyebrow } }, overlayMode })
                assert.equal(findNode(view.root, e => e.props.class === 'hud-module-eyebrow'), undefined)
                assert.doesNotMatch(textContent(view.root), new RegExp(fallback))
                assert.match(textContent(view.root), /我的面板/)
            }
        }
    }
})

test('HUD authored captions and footer are editable without changing bound measurements or status semantics', async t => {
    const view = fixture(t)
    await view.render({ widget: { type: 'hud_kpi_panel', content: { eyebrow: '', chartLabel: '设备效率', chartPath: 'metrics.overall_oee', note: '本班累计', items: [] } }, metrics: { overall_oee: 92 } })
    assert.match(textContent(view.root), /92.*设备效率.*本班累计/)
    await view.render({ widget: { type: 'hud_kpi_panel', content: { eyebrow: '', chartLabel: '', note: '', items: [] } } })
    assert.doesNotMatch(textContent(view.root), /综合效率|本班累计/)
    await view.render({ widget: { type: 'hud_device_status', content: { onlineLabel: '已连接', alarmLabel: '待处理', offlineText: '通信中断', showTemperature: true, temperatureUnit: '℃' } }, deviceStatusMap: { a: { name: '炉一', online: false, temp: 55 } } })
    assert.match(textContent(view.root), /已连接.*0.*待处理.*0.*炉一.*55.*℃.*通信中断/)
    assert.ok(findNode(view.root, e => String(e.props.class).includes('state-offline')))
    await view.render({ widget: { type: 'hud_alarm_panel', content: { criticalLabel: '需处理', missingTimeText: '未记录', fallbackEventText: '现场事件' } }, events: [{ id: 'a', level: 'critical' }] })
    assert.match(textContent(view.root), /未记录.*现场事件.*需处理/)
    await view.render({ widget: { type: 'hud_alarm_panel', content: { emptyText: '暂无报警', emptyHint: '' } } })
    assert.match(textContent(view.root), /暂无报警/)
    assert.doesNotMatch(textContent(view.root), /新事件将在此自动更新/)
    await view.render({ widget: { type: 'hud_chart_dock', content: { statLabel: '', rangeLabel: '温度范围', emptyText: '等待测量', statUnit: '' }, data: { unit: 'K' } } })
    assert.match(textContent(view.root), /温度范围.*等待测量/)
    assert.doesNotMatch(textContent(view.root), /当前温度|区间最低|K/)
})

test('dataset text displays typed values without losing leading zeroes, and unavailable data never uses a static fallback as a real reading', async t => {
    const view=fixture(t),widget={id:'typed_dataset',type:'text',content:{text:'静态占位'},data:{mode:'dataset',datasetId:'erp',datasetField:'code'}}
    const record={value:'00123',quality:'good',columns:[{name:'code',type:'string'}],rows:[],series:[]}
    await view.render({widget,databaseValues:{typed_dataset:record}})
    assert.match(textContent(view.root),/00123/);assert.doesNotMatch(textContent(view.root),/静态占位|123\.0/)
    await view.render({widget:{...widget,content:{text:'工单：{value}',datasetTextMode:'template'}},databaseValues:{typed_dataset:record}})
    assert.match(textContent(view.root),/工单：00123/)
    await view.render({widget,databaseValues:{typed_dataset:{...record,value:'00123',quality:'stale'}}})
    assert.doesNotMatch(textContent(view.root),/00123|静态占位/)
})

test('HUD module ring preserves missing readings and clamps only its graphic', async t => {
    const view = fixture(t)
    const widget = { type: 'hud_kpi_panel', title: '生产运行参数', content: { chartPath: 'metrics.overall_oee', items: [] } }
    await view.render({ widget, overlayMode: true, metrics: {} })
    assert.match(textContent(view.root), /—/)
    await view.render({ widget, overlayMode: true, metrics: { overall_oee: 0 } })
    assert.equal(findNode(view.root, e => e.props.class === 'ring-progress').props['stroke-dasharray'], '0 100')
    await view.render({ widget, overlayMode: true, metrics: { overall_oee: 135 } })
    assert.equal(findNode(view.root, e => e.props.class === 'ring-progress').props['stroke-dasharray'], '100 100')
    assert.match(textContent(view.root), /135/)
})

test('dataset charts and event widgets never fall back to unrelated samples or render a missing value as zero', async t => {
    const view=fixture(t),data={mode:'dataset',datasetId:'erp',datasetField:'temperature'}
    await view.render({widget:{id:'dataset_chart',type:'trend',content:{chartType:'gauge'},data}})
    let option=charts.at(-1).options.at(-1)[0]
    assert.equal(option.series[0].detail.formatter,'—');assert.equal(option.series[0].data[0].value,null)
    assert.equal(option.series[0].pointer.show,false)
    await view.render({widget:{id:'dataset_chart',type:'trend',content:{chartType:'line'},data},trendPoints:[{time:'unrelated',value:123}]})
    option=charts.at(-1).options.at(-1)[0];assert.deepEqual(option.series,[])
    await view.render({widget:{id:'dataset_event',type:'alarm_list',content:{},data},events:[{message:'unrelated'}]})
    assert.doesNotMatch(textContent(view.root),/unrelated/)
    await view.render({widget:{id:'dataset_event',type:'alarm_list',content:{},data},databaseValues:{dataset_event:{quality:'good',rows:[{value:'当前设备消息'}]}}})
    assert.match(textContent(view.root),/当前设备消息/)
})

test('dataset HUD metrics use the bound aggregate, and clear it when the record is stale', async t => {
    const view=fixture(t),widget={id:'dataset_hud',type:'hud_kpi_panel',data:{mode:'dataset',datasetField:'temperature'},content:{chartPath:'dataset.temperature',items:[{label:'温度',path:'dataset.temperature',unit:'°C',decimals:0}]}}
    await view.render({widget,overlayMode:true,databaseValues:{dataset_hud:{quality:'good',value:750,rows:[{temperature:700}]}}})
    assert.match(textContent(view.root),/750/);assert.doesNotMatch(textContent(view.root),/700/)
    await view.render({widget,overlayMode:true,databaseValues:{dataset_hud:{quality:'stale',value:750,rows:[{temperature:700}]}}})
    assert.doesNotMatch(textContent(view.root),/750|700/)
})

test('HUD device module emits the existing device action and distinguishes stale/offline states', async t => {
    const view = fixture(t)
    const actions = []
    await view.render({ widget: { type: 'hud_device_status', content: { limit: 1 } }, overlayMode: true,
        deviceStatusMap: { first: { name: '设备一', online: true, running: true, quality: 'stale' }, second: { name: '设备二', online: false } },
        onAction: action => actions.push(action) })
    assert.match(textContent(view.root), /数据延迟/)
    assert.doesNotMatch(textContent(view.root), /运行中/)
    const button = findNode(view.root, e => e.type === 'button')
    button.props.onClick({ stopPropagation() {} })
    assert.deepEqual(actions[0].event, { action: 'enter_device', deviceId: 'first' })
    assert.match(textContent(view.root), /\/ 2/)
})

test('HUD alarm module keeps an honest empty state and normalizes event severity', async t => {
    const view = fixture(t)
    const widget = { type: 'hud_alarm_panel', content: { limit: 3 } }
    await view.render({ widget, overlayMode: true, events: [] })
    assert.match(textContent(view.root), /暂无事件记录/)
    await view.render({ widget, overlayMode: true, events: [{ id: 1, level: 'CRITICAL', occurred_at: '2026-09-17T14:32:08', message: '温度异常' }] })
    assert.match(textContent(view.root), /14:32:08/)
    assert.match(textContent(view.root), /温度异常/)
    assert.equal(findNode(view.root, e => e.type === 'li').props.class, 'critical')
})

test('HUD chart dock reads the same samples and preserves zero/missing samples', async t => {
    const view = fixture(t)
    await view.render({ overlayMode: true, preview: true, widget: { type: 'hud_chart_dock', content: { chartType: 'area' } },
        trendPoints: [{ time: '10:00', value: 0 }, { time: '10:01', value: 42 }, { time: '10:02', value: null }] })
    const chart = charts.at(-1).options.at(-1)[0]
    assert.deepEqual(chart.series[0].data, [0, 42, null])
    assert.equal(chart.yAxis.scale, true)
    assert.equal(chart.animationDurationUpdate, 450)
    assert.equal(chart.animation, true)
    assert.match(textContent(view.root), /42/)
})

test('HUD KPIs keep the live value and unit in separate typography elements', async t => {
    const view = fixture(t)
    const widget = { id: 'energy_value', type: 'text', content: { text: '今日用电量\n{value} kWh', showTitle: false }, data: { path: 'metrics.energy_consumption' } }
    await view.render({ widget, overlayMode: true, metrics: { energy_consumption: 3712 } })
    assert.match(view.root.children[0].props.class, /text-is-kpi/)
    assert.equal(findNode(view.root, element => element.type === 'small')?.text, 'kWh')
    assert.match(textContent(view.root), /3,?712/)
    await view.render({ widget, overlayMode: true, metrics: { energy_consumption: 3900 } })
    assert.match(textContent(view.root), /3,?900/)
    await view.render({ widget, overlayMode: false, metrics: { energy_consumption: 3900 } })
    assert.doesNotMatch(view.root.children[0].props.class, /text-is-kpi/)
})

test('live native HUD preserves all chart observations without restarting a canvas transition per PLC scan', async t => {
    const view = fixture(t)
    await view.render({ overlayMode: true, preview: true, nativeRealtime: true, widget: { type: 'hud_chart_dock', content: { chartType: 'area' } },
        trendPoints: [{ time: '10:00', value: 0 }, { time: '10:01', value: 42 }, { time: '10:02', value: null }] })
    const chart = charts.at(-1).options.at(-1)[0]
    assert.deepEqual(chart.series[0].data, [0, 42, null])
    assert.equal(chart.animation, false); assert.equal(chart.animationDurationUpdate, 0)
    assert.equal(chart.series[0].animation, false); assert.equal(chart.yAxis.scale, true)
})

test('heading styling is attached to the renderer in every preview context', async t => {
    const view = fixture(t)
    await view.render({ overlayMode: true, widget: { id: 'heading', type: 'text', content: { text: '▸ 生产运行参数', showTitle: false } } })
    assert.match(view.root.children[0].props.class, /hud-heading/)
    await view.render({ overlayMode: true, widget: { id: 'heat_header_brand', type: 'text', content: { text: '热处理 · 生产运行中心\nHEAT TREATMENT / DIGITAL TWIN', showTitle: false } } })
    assert.match(view.root.children[0].props.class, /hud-brand/)
    const body = findNode(view.root, element => element.props.class === 'text-widget-body')
    assert.equal(body.children.filter(element => element.type === 'p').length, 2)
})

test('HUD labels and values retain their migrated font hierarchy and live bindings', async t => {
    const view = fixture(t)
    const label = {
        id: 'cfg_total_label', type: 'text', content: { text: '设备总数', showTitle: false },
        style: { fontSize: 13.88976377952756, color: '#ABC6D8' }
    }
    const value = {
        id: 'cfg_total_value', type: 'text', content: { text: '{value} 台', showTitle: false },
        style: { fontSize: 17.748031496062993, color: '#66DDF7' },
        data: { path: 'metrics.total_devices', decimals: 0 }
    }
    const before = JSON.stringify([label, value])
    await view.render({ widget: label, overlayMode: true })
    const labelSize = view.root.children[0].props.style['--hud-text-size']
    assert.equal(labelSize, `${label.style.fontSize}px`)
    assert.equal(view.root.children[0].props.style.color, label.style.color)
    await view.render({ widget: value, overlayMode: true, metrics: { total_devices: 6 } })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], `${value.style.fontSize}px`)
    assert.ok(parseFloat(view.root.children[0].props.style['--hud-text-size']) > parseFloat(labelSize))
    assert.equal(view.root.children[0].props.style.fontSize, undefined)
    assert.equal(view.root.children[0].props.style.color, value.style.color)
    assert.match(textContent(view.root), /6 台/)
    await view.render({ widget: value, overlayMode: true, metrics: { total_devices: 7 } })
    assert.match(textContent(view.root), /7 台/)
    assert.equal(JSON.stringify([label, value]), before)
})

test('HUD heading size updates and state text continues inheriting its condition color', async t => {
    const view = fixture(t)
    const heading = { id: 'heading', type: 'text', content: { text: '▸ 生产运行参数', showTitle: false }, style: { fontSize: 16.8 } }
    await view.render({ widget: heading, overlayMode: true })
    assert.match(view.root.children[0].props.class, /hud-heading/)
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '16.8px')
    await view.render({ widget: { ...heading, style: { fontSize: 18 } }, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '18px')
    const state = {
        id: 'cfg_alarm_Furnace_01', type: 'text',
        content: { text: '{value}', showTitle: false, onText: '报警', offText: '正常' },
        style: { fontSize: 13.6, color: '#66E3BF' },
        data: { path: 'metrics.active_alarm' },
        conditions: [{ operator: '==', value: true, color: '#f87171' }]
    }
    for (const alarm of [false, true]) {
        await view.render({ widget: state, overlayMode: true, metrics: { active_alarm: alarm } })
        assert.match(view.root.children[0].props.class, /text-is-state/)
        assert.equal(view.root.children[0].props.style['--hud-text-size'], '13.6px')
        assert.equal(view.root.children[0].props.style.color, alarm ? '#f87171' : '#66E3BF')
        assert.match(textContent(view.root), alarm ? /报警/ : /正常/)
    }
})

test('HUD panel alpha changes the surface without fading the content', async t => {
    const view = fixture(t)
    const widget = {
        id: 'alpha-panel', type: 'trend',
        content: { chartType: 'line' },
        style: { backgroundOpacity: 0.24 }
    }
    await view.render({ widget, overlayMode: true })
    const style = view.root.children[0].props.style
    assert.equal(style['--hud-panel-opacity'], 0.24)
    assert.match(style['--hud-glass-bg'], /rgba\(88, 79, 137, 0\.24\)/)
    assert.equal(style.opacity, 1)

    await view.render({ widget: { ...widget, style: { backgroundOpacity: 0 } }, overlayMode: true })
    const transparentStyle = view.root.children[0].props.style
    assert.equal(transparentStyle['--hud-panel-opacity'], 0)
    assert.match(transparentStyle['--hud-glass-bg'], /rgba\(88, 79, 137, 0\)/)
    assert.equal(transparentStyle.opacity, 1)
})

test('HUD font variables do not replace non-overlay sizing or missing-size fallbacks', async t => {
    const view = fixture(t)
    const widget = { id: 'text', type: 'text', content: { text: '设备总数', showTitle: false }, style: { fontSize: '18px' } }
    await view.render({ widget, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '18px')
    await view.render({ widget, overlayMode: false })
    assert.equal(view.root.children[0].props.style.fontSize, '18px')
    assert.equal(view.root.children[0].props.style['--hud-text-size'], undefined)
    await view.render({ widget: { ...widget, style: {} }, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], undefined)
})

test('HUD CSS consumes authored text sizes without rescaling brand or KPI typography', () => {
    const text = hudDeclarations('.hud-widget .widget-kind-text:not(.text-is-kpi):not(.hud-brand):not(.hud-heading) .text-widget-body')
    const heading = hudDeclarations('.hud-widget .hud-heading .text-widget-body')
    assert.equal(text['font-size'], 'var(--hud-text-size, 12px)')
    assert.equal(heading['font-size'], 'var(--hud-text-size, 13px)')
    assert.equal(text.color, 'inherit')
    assert.equal(text.transform, undefined)
    assert.equal(heading.transform, undefined)
    assert.equal(hudDeclarations('.hud-widget .hud-brand p:first-child')['font-size'], '22px')
    assert.equal(hudDeclarations('.hud-widget .hud-brand p:last-child')['font-size'], '10px')
    assert.equal(hudDeclarations('.hud-widget .text-is-kpi p:first-child')['font-size'], '11px')
    assert.equal(hudDeclarations('.hud-widget .text-is-kpi p:last-child')['font-size'], '20px')
})

test('chart options replace prior chart types and removed series instead of merging', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'chart', type: 'trend', content: { chartType: 'line' } }, trendPoints: [{ time: '10:00', value: 42 }] })
    await view.render({ widget: { id: 'chart', type: 'trend', content: { chartType: 'pie' } }, trendPoints: [] })
    assert.ok(charts.length > 0)
    const latest = charts.at(-1).options.at(-1)
    assert.equal(latest[0].series[0].type, 'pie')
    assert.equal(latest[1], true)
    assert.equal(latest[2], true)
})

test('charts observe their own container and are recreated when chart DOM changes', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: {} } })
    const first = charts.at(-1)
    view.observers.at(-1).callback()
    assert.equal(first.resizeCount, 1)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: { layout: 'list' } } })
    assert.equal(first.disposed, true)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: {} } })
    assert.notEqual(charts.at(-1), first)
    assert.equal(charts.at(-1).disposed, false)
})

test('out-of-range metric precision cannot crash the entire dashboard', async t => {
    const view = fixture(t)
    await view.render({
        widget: { id: 'metric', type: 'metrics', content: { layout: 'list', items: [{ label: 'Output', path: 'metrics.current_output', decimals: 1000 }] } },
        metrics: { current_output: 12.5 }
    })
    assert.match(textContent(view.root), /12\.50000000/)
})

test('missing values do not satisfy numeric zero conditions and invalid legacy lists are ignored', async t => {
    const view = fixture(t)
    await view.render({ widget: {
        id: 'value', type: 'text', content: { value: null },
        conditions: [{ operator: '==', value: 0, color: 'red' }],
        config: { events: {} }
    } })
    assert.notEqual(view.root.children[0].props.style?.color, 'red')
    await view.render({ widget: { id: 'value', type: 'text', config: { conditions: {}, events: {} } } })
})

test('a PLC widget without runtime samples is stale, not falsely healthy', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'value', type: 'text', data: { mode: 'plc', device_id: 'missing', point_id: 'missing' } } })
    assert.match(view.root.children[0].props.class, /quality-stale/)
})

test('overlay charts use the HUD theme without changing samples or designer styling', async t => {
    const view = fixture(t)
    const widget = { id: 'chart', type: 'trend', content: { chartType: 'area' } }
    const trendPoints = [{ time: '10:00', value: 42 }, { time: '10:01', value: 44 }]
    await view.render({ widget, trendPoints, overlayMode: true })
    const hud = charts.at(-1).options.at(-1)[0]
    assert.equal(hud.backgroundColor, 'transparent')
    assert.equal(hud.series[0].lineStyle.width, 2)
    assert.equal(hud.series[0].areaStyle.color.type, 'linear')
    assert.equal(hud.yAxis.splitLine.lineStyle.type, 'dashed')
    const samples = hud.series[0].data
    await view.render({ widget: { ...widget }, trendPoints, overlayMode: false })
    const designer = charts.at(-1).options.at(-1)[0]
    assert.deepEqual(designer.series[0].data, samples)
    assert.equal(designer.series[0].lineStyle.width, 2)
})

test('overlay bar, ring and gauge widgets share lightweight presentation', async t => {
    const view = fixture(t)
    for (const chartType of ['bar', 'stackedBar', 'scatter', 'pie', 'donut', 'gauge']) {
        await view.render({ overlayMode: true, widget: { id: 'themed', type: 'trend', content: { chartType } }, trendPoints: [{ time: '10:00', value: 42 }] })
        const option = charts.at(-1).options.at(-1)[0]
        assert.equal(option.backgroundColor, 'transparent')
        if (chartType.includes('Bar') || chartType === 'bar') assert.equal(option.series[0].barMaxWidth, 12)
        if (chartType === 'donut') assert.deepEqual(option.series[0].radius, ['73%', '81%'])
        if (chartType === 'gauge') {
            assert.equal(option.series[0].progress.width, 4)
            assert.equal(option.series[0].pointer.show, false)
        }
    }
    await view.render({ overlayMode: true, widget: { id: 'oee', type: 'metrics', content: {} }, metrics: { overall_oee: 92 } })
    const ring = charts.at(-1).options.at(-1)[0].series[0]
    assert.deepEqual(ring.data.map(item => item.value), [92, 8])
})


test('filter controls emit typed values including zero/false, and do not act during layout editing',async t=>{
 const view=fixture(t),actions=[],widget={id:'filter',type:'filter',title:'批次',content:{parameterKey:'batch',control:'select',options:[{label:'零',value:0},{label:'关闭',value:false}]}};
 await view.render({widget,parameters:{batch:0},onAction:value=>actions.push(value)});
 const select=findNode(view.root,n=>n.type==='select');assert.equal(select.props.value,0);select.props.onChange({target:{value:'0'}});assert.equal(actions.at(-1).event.value,0);
 select.props.onChange({target:{value:'1'}});assert.equal(actions.at(-1).event.value,false);
 await view.render({widget,interactive:false,onAction:value=>actions.push(value)});const count=actions.length;findNode(view.root,n=>n.type==='select').props.onChange({target:{value:'0'}});assert.equal(actions.length,count);
})
test('parameter text uses safe interpolation rather than executing expressions',async t=>{
 const view=fixture(t);await view.render({widget:{type:'text',content:{text:'批次 {parameters.batch} / {parameters.zero}'}},parameters:{batch:'<script>no</script>',zero:0}});assert.match(textContent(view.root),/批次 <script>no<\/script> \/ 0/);
})


test('one device card rotates live samples, updates immediately and locks to the selected detail device without another PLC request',async t=>{
 const view=fixture(t),catalog=[{id:'a',name:'设备 A'},{id:'b',name:'设备 B'}],widget={id:'play',type:'value',title:'温度',data:{mode:'runtime',path:'device.analog.temperature',deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000,refreshMs:1000}};
 const props={widget,deviceCatalog:catalog,deviceDataMap:{a:{analog:{temperature:0}},b:{analog:{temperature:850}}},runtimeContext:{viewMode:'factory'}};
 await view.render({...props,playbackNow:0});assert.match(textContent(view.root),/设备 A/);assert.match(textContent(view.root),/0/);
 await view.render({...props,playbackNow:2000});assert.match(textContent(view.root),/设备 B/);assert.match(textContent(view.root),/850/);
 await view.render({...props,playbackNow:2200,deviceDataMap:{...props.deviceDataMap,b:{analog:{temperature:999}}}});assert.match(textContent(view.root),/999/);
 await view.render({...props,playbackNow:3000,deviceDataMap:{...props.deviceDataMap,b:{analog:{temperature:999}}}});assert.match(textContent(view.root),/999/);
 await view.render({...props,playbackNow:3000,runtimeContext:{viewId:'device_exploded',viewMode:'device',deviceId:'a'}});assert.match(textContent(view.root),/设备 A/);assert.doesNotMatch(textContent(view.root),/850|999/);
})

test('rotating headings and metadata follow the selected curve, not a stale preview device name',async t=>{
 const view=fixture(t),widget={id:'identity',type:'hud_chart_dock',title:'炉温实时趋势',content:{chartType:'line',statPath:'device.analog.temperature'},data:{mode:'runtime',path:'device.analog.temperature',deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000,refreshMs:1000}}
 const base={widget,deviceCatalog:[{id:'a',name:'3#多用炉',workshopName:'甲车间',lineName:'甲线'},{id:'b',name:'2#多用炉',workshopName:'乙车间',lineName:'乙线'}],runtimeContext:{viewMode:'factory'},deviceDataMap:{a:{analog:{temperature:111}},b:{analog:{temperature:222}}},databaseValues:{identity:{deviceId:'a',deviceName:'3#多用炉'}}}
 await view.render({...base,playbackNow:0})
 assert.match(textContent(view.root),/3#多用炉.*1.*\/.*2/)
 await view.render({...base,playbackNow:1000})
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[111])
 await view.render({...base,playbackNow:2000})
 assert.match(textContent(view.root),/2#多用炉.*2.*\/.*2/)
 assert.doesNotMatch(textContent(view.root),/3#多用炉/)
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[222])
 const textWidget={...widget,type:'text',content:{text:'{value}'},data:{...widget.data,path:'deviceInfo.lineName'}}
 await view.render({...base,widget:textWidget,playbackNow:2000})
 assert.match(textContent(view.root),/乙线/);assert.doesNotMatch(textContent(view.root),/甲线/)
})

test('rotating external cards discard foreign or untagged results rather than relabeling another device data',async t=>{
 const view=fixture(t),catalog=[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}]
 for(const mode of ['dataset','database','http_api']){
  const widget={id:'external_identity',type:'hud_chart_dock',title:'炉温趋势',content:{chartType:'line',value:9876},data:{mode,datasetField:'temperature',deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000}}
  const base={widget,deviceCatalog:catalog,runtimeContext:{viewMode:'factory'},trendPoints:[{time:'GLOBAL',value:9999}]},record={quality:'good',deviceId:'a',deviceName:'过期名称',value:111,rows:[{time:'a',value:111}]}
  await view.render({...base,playbackNow:0,databaseValues:{external_identity:record}})
  assert.match(textContent(view.root),/炉 A/);assert.doesNotMatch(textContent(view.root),/过期名称/)
  assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[111])
  await view.render({...base,playbackNow:2000,databaseValues:{external_identity:record}})
  assert.match(textContent(view.root),/炉 B/);assert.doesNotMatch(textContent(view.root),/过期名称|111|9876|9999/)
  assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0]?.data || [],[])
  await view.render({...base,playbackNow:2200,databaseValues:{external_identity:{...record,deviceId:'b',deviceName:'错误名称',value:222,rows:[{time:'b',value:222}]}}})
  assert.match(textContent(view.root),/炉 B/);assert.doesNotMatch(textContent(view.root),/错误名称|111/)
  assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[222])
  const {deviceId,...untagged}=record
  await view.render({...base,playbackNow:2400,databaseValues:{external_identity:untagged}})
  assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0]?.data || [],[])
 }
})

test('hover holds rotation while live points and history continue, then resumes the remaining interval',async t=>{
 const view=fixture(t),widget={id:'hover',type:'hud_chart_dock',title:'炉温趋势',content:{chartType:'line'},data:{mode:'plc',pointKey:'analog.temperature',path:'analog.temperature',requireConfiguredPoint:true,deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000,refreshMs:1000}}
 const base={widget,deviceCatalog:[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}],runtimeContext:{viewMode:'factory'},interactive:true,overlayMode:true}
 const readings=(time,value)=>({pa:{id:'pa',device_id:'a',category:'analog',value_role:'temperature',quality:'good',lastReadAt:time,value},pb:{id:'pb',device_id:'b',category:'analog',value_role:'temperature',quality:'good',lastReadAt:time,value:850}})
 await view.render({...base,playbackNow:1500,pointValues:readings(1500,111)})
 view.root.children[0].props.onMouseenter()
 for(const [time,value] of [[2500,112],[4500,113],[6500,114]]){
  await view.render({...base,playbackNow:time,pointValues:readings(time,value)})
  assert.match(textContent(view.root),/炉 A.*1.*\/.*2/);assert.doesNotMatch(textContent(view.root),/炉 B/)
  assert.equal(charts.at(-1).options.at(-1)[0].series[0].data.at(-1),value)
 }
 view.root.children[0].props.onMouseleave()
 await view.render({...base,playbackNow:6999,pointValues:readings(6999,115)})
 assert.match(textContent(view.root),/炉 A/)
 await view.render({...base,playbackNow:7000,pointValues:readings(7000,116)})
 assert.match(textContent(view.root),/炉 B.*2.*\/.*2/)
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[850])
})

test('layout editing does not rotate; interactive preview rotates and a scope change releases the hold',async t=>{
 const view=fixture(t),widget={id:'preview_hover',type:'value',data:{mode:'runtime',path:'device.analog.temperature',deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000}}
 const base={widget,preview:true,deviceCatalog:[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}],runtimeContext:{viewMode:'factory'},deviceDataMap:{a:{analog:{temperature:111}},b:{analog:{temperature:222}}}}
 await view.render({...base,interactive:false,playbackNow:2000})
 assert.match(textContent(view.root),/炉 A/)
 view.root.children[0].props.onMouseenter()
 await view.render({...base,interactive:false,playbackNow:6000})
 assert.match(textContent(view.root),/炉 A/)
 await view.render({...base,interactive:true,playbackNow:6500})
 assert.match(textContent(view.root),/炉 B/)
 view.root.children[0].props.onMouseenter()
 await view.render({...base,interactive:true,playbackNow:10000})
 assert.match(textContent(view.root),/炉 B/)
 await view.render({...base,interactive:true,playbackNow:11000,runtimeContext:{viewMode:'device',deviceId:'a'}})
 assert.match(textContent(view.root),/炉 A/)
 await view.render({...base,interactive:true,playbackNow:12000})
 assert.match(textContent(view.root),/炉 A/)
})


test('unchanged refreshed dataset samples do not rebuild or reanimate the chart',async t=>{
 const view=fixture(t),widget={id:'stable_chart',type:'trend',content:{chartType:'line'},data:{mode:'dataset',datasetField:'temperature'}};
 const record={quality:'good',value:0,rows:[{time:'A',value:0}],series:[{id:'temperature',value:0,rows:[{time:'A',value:0}]}],fetchedAt:'first'};
 await view.render({widget,databaseValues:{stable_chart:record}});const chart=charts.at(-1),count=chart.options.length;
 await view.render({widget,databaseValues:{stable_chart:{...record,fetchedAt:'second'}}});assert.equal(chart.options.length,count);
})

test('business cards render their own selected-device response rather than the surface-wide snapshot',async t=>{
 const view=fixture(t),widget={id:'business',type:'business_summary',content:{section:'batches',showSource:false},data:{mode:'business',deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000}};
 const props={widget,deviceCatalog:[{id:'a',name:'A'},{id:'b',name:'B'}],runtimeContext:{viewMode:'factory'},businessData:{status:'ready',sections:{batches:{available:true,rows:[{batchNo:'GLOBAL_NOT_SELECTED'}]}}}};
 await view.render({...props,playbackNow:0,databaseValues:{business:{quality:'good',deviceId:'a',deviceName:'A',businessSection:{available:true,rows:[{batchNo:'BATCH_A'}]}}}});
 assert.match(textContent(view.root),/BATCH_A/);assert.doesNotMatch(textContent(view.root),/GLOBAL_NOT_SELECTED/);
 await view.render({...props,playbackNow:2000,databaseValues:{business:{quality:'empty',deviceId:'b',deviceName:'B',businessSection:{available:true,rows:[]}}}});
 assert.doesNotMatch(textContent(view.root),/BATCH_A|GLOBAL_NOT_SELECTED/);assert.match(textContent(view.root),/暂无记录/);
 await view.render({...props,playbackNow:2000,databaseValues:{business:{quality:'good',deviceId:'a',deviceName:'A',businessSection:{available:true,rows:[{batchNo:'BATCH_A'}]}}}});
 assert.match(textContent(view.root),/B/);assert.doesNotMatch(textContent(view.root),/BATCH_A|GLOBAL_NOT_SELECTED/);
})


test('configured point charts sample fresh source timestamps, never simulator fields, and keep per-device histories separate',async t=>{
 const view=fixture(t),time=Date.now(),widget={id:'real_temp',type:'hud_chart_dock',title:'温度趋势',content:{chartType:'smoothLine',showAxis:true},data:{mode:'plc',deviceScope:'fixed',deviceId:'d1',pointId:'p1',pointKey:'analog.actual_temp',path:'analog.actual_temp',unit:'°C',requireConfiguredPoint:true,refreshMs:1000}}
 const props={widget,preview:true,interactive:false,deviceCatalog:[{id:'d1',name:'一号炉'},{id:'d2',name:'二号炉'}],deviceDataMap:{d1:{timestamp:time,analog:{actual_temp:999}}},playbackNow:time}
 await view.render(props)
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[])
 const point={id:'p1',device_id:'d1',category:'analog',value_role:'actual_temp',value:857.3,quality:'good',lastReadAt:time}
 await view.render({...props,playbackNow:time+1000,pointValues:{p1:point}})
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[857.3])
 await view.render({...props,playbackNow:time+2000,pointValues:{p1:point}})
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[857.3],'cached poll must not invent a new sample')
 await view.render({...props,playbackNow:time+3000,pointValues:{p1:{...point,value:0,lastReadAt:time+3000}}})
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[857.3,0])
 await view.render({...props,playbackNow:time+4000,pointValues:{p1:{...point,quality:'bad'}}})
 assert.equal(charts.at(-1).options.at(-1)[0].series[0].data.at(-1),null)
 await view.render({...props,widget:{...widget,data:{...widget.data,deviceId:'d2'}},playbackNow:time+5000,pointValues:{p1:point}})
 assert.deepEqual(charts.at(-1).options.at(-1)[0].series[0].data,[],'another furnace must not inherit this device history or point')
})

test('overlay styling respects authored curve color/width/opacity, bar radius and ring ratio',async t=>{
 const view=fixture(t),base={id:'styled',type:'trend',content:{chartType:'area',lineColor:'#cc88ff',lineWidth:5,areaOpacity:.6}},trendPoints=[{time:'10:00',value:42}]
 await view.render({widget:base,trendPoints,overlayMode:true});let option=charts.at(-1).options.at(-1)[0]
 assert.equal(option.series[0].lineStyle.color,'#cc88ff');assert.equal(option.series[0].lineStyle.width,5);assert.match(option.series[0].areaStyle.color.colorStops[0].color,/, 0.6\)/)
 await view.render({widget:{...base,content:{chartType:'bar',barRadius:9}},trendPoints,overlayMode:true});option=charts.at(-1).options.at(-1)[0];assert.deepEqual(option.series[0].itemStyle.borderRadius,[9,9,0,0])
 await view.render({widget:{...base,content:{chartType:'donut',donutRatio:55}},trendPoints,overlayMode:true});option=charts.at(-1).options.at(-1)[0];assert.deepEqual(option.series[0].radius,['55%','81%'])
})

test('PLC point, device reading and selected part update without advancing the playback clock', async t => {
 const view=fixture(t),base={playbackNow:10000,deviceCatalog:[{id:'a',name:'A'}],runtimeContext:{viewMode:'device',deviceId:'a',partId:'part-a'}};
 const widget={id:'live',type:'value',data:{mode:'plc',pointId:'p',deviceScope:'fixed',deviceId:'a',refreshMs:5000,decimals:0}};
 const point=value=>({p:{id:'p',device_id:'a',value,quality:'good'}});
 await view.render({...base,widget,pointValues:point(111)});assert.match(textContent(view.root),/111/);
 await view.render({...base,widget,pointValues:point(222)});assert.match(textContent(view.root),/222/);assert.doesNotMatch(textContent(view.root),/111/);
 const readingWidget={...widget,data:{mode:'runtime',path:'device.analog.actual_temp',deviceScope:'fixed',deviceId:'a',refreshMs:5000}};
 await view.render({...base,widget:readingWidget,deviceDataMap:{a:{analog:{actual_temp:333}}}});assert.match(textContent(view.root),/333/);
 await view.render({...base,widget:readingWidget,deviceDataMap:{a:{analog:{actual_temp:444}}}});assert.match(textContent(view.root),/444/);
 const partWidget={...widget,data:{mode:'runtime',path:'selectedPart.points.0.value',deviceScope:'fixed',deviceId:'a'}};
 await view.render({...base,widget:partWidget,selectedPart:{id:'part-a',points:[{value:555,quality:'good'}]}});assert.match(textContent(view.root),/555/);
 await view.render({...base,widget:partWidget,selectedPart:{id:'part-a',points:[{value:666,quality:'good'}]}});assert.match(textContent(view.root),/666/);
 await view.render({...base,widget:partWidget,selectedPart:{id:'wrong-part',points:[{value:777,quality:'good'}]}});assert.doesNotMatch(textContent(view.root),/777/);
})

test('normal catalog data-status text comes from actual quality rather than process flags, timestamps or a healthy fallback', async t => {
    const view = fixture(t)
    const widget = { id: 'catalog_data_status', type: 'text', content: { text: '{value}', showTitle: false, showDeviceLabel: false, fallback: '数据正常' },
        data: { mode: 'runtime', path: 'deviceInfo.dataStatus', deviceScope: 'current' } }
    const base = { widget, deviceCatalog: [{ id: 'a', name: '设备 A' }], runtimeContext: { viewMode: 'device', deviceId: 'a' }, playbackNow: 1000 }
    for (const [status, expected] of [
        [{ quality: 'good', online: true, running: false, alarm: true }, '数据正常'],
        [{ quality: 'bad', online: true, running: true, alarm: false, lastSeen: Date.now() }, '数据异常 / 未连接'],
        [{ quality: 'stale', online: true, running: true, lastSeen: Date.now() }, '数据已过期'],
        [{ quality: 'good', online: false, running: true }, '数据异常 / 未连接'],
        [{ quality: 'unknown', online: true, running: true, lastSeen: Date.now() }, '暂无实时数据'],
        [{ quality: 'offline', online: false, running: true }, '数据异常 / 未连接'],
        [{ running: true, alarm: false, lastSeen: Date.now() }, '暂无实时数据'],
        [{ quality: 'good', online: true, running: true, alarm: false }, '数据正常']
    ]) {
        await view.render({ ...base, deviceStatusMap: { a: status, unrelated: { quality: 'good', online: true } } })
        assert.match(textContent(view.root), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        if (expected !== '数据正常') assert.doesNotMatch(textContent(view.root), /数据正常/)
    }
})

test('normal catalog model metadata follows the same carousel device and updates without advancing its clock', async t => {
    const view = fixture(t)
    const widget = { id: 'catalog_model_name', type: 'text', content: { text: '{value}', showTitle: false, showDeviceLabel: false },
        data: { mode: 'runtime', path: 'deviceInfo.modelName', deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000, refreshMs: 1000 } }
    const base = { widget, runtimeContext: { viewMode: 'factory' }, deviceCatalog: [{ id: 'a', name: '炉 A', model_name: 'MODEL_A' }, { id: 'b', name: '炉 B', model_type: 'MODEL_B' }],
        deviceStatusMap: { a: { quality: 'good' }, b: { quality: 'bad' } } }
    await view.render({ ...base, playbackNow: 0 })
    assert.match(textContent(view.root), /MODEL_A/); assert.doesNotMatch(textContent(view.root), /MODEL_B/)
    await view.render({ ...base, playbackNow: 2000 })
    assert.match(textContent(view.root), /MODEL_B/); assert.doesNotMatch(textContent(view.root), /MODEL_A/)
    await view.render({ ...base, playbackNow: 2000, deviceCatalog: [base.deviceCatalog[0], { ...base.deviceCatalog[1], modelName: 'MODEL_B_UPDATED' }] })
    assert.match(textContent(view.root), /MODEL_B_UPDATED/); assert.doesNotMatch(textContent(view.root), /MODEL_A/)
    await view.render({ ...base, playbackNow: 4000 })
    assert.match(textContent(view.root), /MODEL_A/); assert.doesNotMatch(textContent(view.root), /MODEL_B/)
})

for (const withUnitPath of [false, true]) test(`tooltip PLC unit uses the actual hovered point ${withUnitPath ? 'dynamic unit path' : 'point-record fallback'} rather than the catalog sample unit`, async t => {
    const view = fixture(t), points = {
        a: { id: 'point-a', device_id: 'a', category: 'analog', value_role: 'temp', value: 0, unit: '℃', quality: 'good' },
        b: { id: 'point-b', device_id: 'b', category: 'analog', value_role: 'temp', value: 275, unit: 'K', quality: 'good' }
    }
    const binding = catalogBinding({ unit: 'OLD_SAMPLE_UNIT', objectScope: 'device', tooltipBinding: { mode: 'plc', pointKey: 'analog.temp', requireConfiguredPoint: true, deviceScope: 'current' } }, { tooltip: true })
    assert.equal(binding.unit, '')
    if (!withUnitPath) delete binding.unitPath
    const widget = { id: `catalog_unit_${withUnitPath}`, type: 'text', content: { text: '{value}{unit}', showTitle: false, showDeviceLabel: false }, data: { ...binding, decimals: 0 } }
    const base = { widget, pointValues: points, deviceCatalog: [{ id: 'a' }, { id: 'b' }], playbackNow: 1000 }
    for (const [id, expected] of [['a', '0 ℃'], ['b', '275 K'], ['a', '0 ℃']]) {
        const runtimeContext = createTooltipContext({ device: { id }, points: Object.values(points), status: { quality: 'good' } })
        await view.render({ ...base, runtimeContext })
        assert.match(textContent(view.root), new RegExp(expected))
        assert.doesNotMatch(textContent(view.root), /OLD_SAMPLE_UNIT/)
        if (id === 'b') assert.doesNotMatch(textContent(view.root), /℃/)
        else assert.doesNotMatch(textContent(view.root), /275 K/)
    }
    const missing = createTooltipContext({ device: { id: 'c' }, points: Object.values(points), status: { quality: 'good' } })
    await view.render({ ...base, runtimeContext: missing })
    assert.doesNotMatch(textContent(view.root), /0 ℃|275 K|OLD_SAMPLE_UNIT/)
})

test('explicit carousel renders each assigned point even when field names differ and a device view is open',async t=>{
 const view=fixture(t),widget={id:'explicit',type:'value',content:{showTitle:false},data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',rotationIntervalMs:2000,decimals:0,pointId:'pa',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa'}},{deviceId:'b',binding:{mode:'plc',pointId:'pb'}}]}}
 const base={widget,deviceCatalog:[{id:'a'},{id:'b'}],runtimeContext:{viewId:'device_detail',deviceId:'a'},pointValues:{pa:{id:'pa',device_id:'a',quality:'good',value:111},pb:{id:'pb',device_id:'b',quality:'good',value:222}}}
 await view.render({...base,playbackNow:0});assert.match(textContent(view.root),/111/)
 await view.render({...base,playbackNow:2000});assert.match(textContent(view.root),/222/);assert.doesNotMatch(textContent(view.root),/111/)
 widget.data.deviceScope='fixed';widget.data.deviceId='b';await view.render({...base,playbackNow:4000});assert.match(textContent(view.root),/222/)
 widget.data.deviceScope='current';await view.render({...base,runtimeContext:{},playbackNow:4000});assert.doesNotMatch(textContent(view.root),/111|222/)
})

test('HUD ring and individual panel metrics render their assigned PLC sources, with bad values unavailable',async t=>{
 const view=fixture(t),source=pointId=>({mode:'plc',bindingVersion:2,deviceScope:'fixed',deviceId:'a',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId}}]})
 const widget={id:'bound-kpi',type:'hud_kpi_panel',content:{useBoundRing:true,chartLabel:'日使用率',items:[{label:'运行小时',binding:source('hours'),unit:'h'}]},data:source('percent')}
 const base={widget,overlayMode:true,deviceCatalog:[{id:'a'}],runtimeContext:{deviceId:'a',viewMode:'device'},pointValues:{percent:{id:'percent',device_id:'a',quality:'good',value:37.5},hours:{id:'hours',device_id:'a',quality:'good',value:9}}}
 await view.render(base);assert.match(textContent(view.root),/37\.5/);assert.match(textContent(view.root),/9h/)
 await view.render({...base,pointValues:{...base.pointValues,percent:{...base.pointValues.percent,quality:'bad',value:88}}});assert.doesNotMatch(textContent(view.root),/88|37\.5/)
})

test('events source applies the authored factory/device and severity filters to real input events',async t=>{
 const view=fixture(t),widget={id:'events',type:'hud_alarm_panel',data:{mode:'runtime',path:'events',deviceScope:'global'},content:{eventFilters:{scope:'current',level:'warning'}}}
 const base={widget,runtimeContext:{deviceId:'a'},events:[{id:1,source_id:'a',level:'warning',message:'A真实报警'},{id:2,source_id:'b',level:'warning',message:'B真实报警'},{id:3,source_id:'a',level:'info',message:'A提示'}]}
 await view.render(base);assert.match(textContent(view.root),/A真实报警/);assert.doesNotMatch(textContent(view.root),/B真实报警|A提示/)
 await view.render({...base,runtimeContext:{}});assert.doesNotMatch(textContent(view.root),/A真实报警|B真实报警|A提示/)
})

test('system event placeholders are never presented as real alarm or event records',async t=>{
 const view=fixture(t),widget={id:'real-events',type:'hud_alarm_panel',data:{mode:'runtime',path:'events',deviceScope:'global'},content:{emptyText:'暂无真实事件'}}
 const placeholders=[{id:'boot',placeholder:true,level:'info',msg:'等待实时事件接入'},{id:'empty',placeholder:true,level:'info',msg:'最近24小时暂无报警履历'}]
 await view.render({widget,events:placeholders});assert.match(textContent(view.root),/暂无真实事件/);assert.doesNotMatch(textContent(view.root),/等待实时事件接入|最近24小时/)
 await view.render({widget,events:[...placeholders,{id:'boot',level:'info',msg:'真实工艺完成记录'}]});assert.match(textContent(view.root),/真实工艺完成记录/);assert.doesNotMatch(textContent(view.root),/等待实时事件接入|最近24小时/)
})

test('switching factories immediately rejects cached events owned by the previous factory',async t=>{
 const view=fixture(t),widget={id:'factory-events',type:'hud_alarm_panel',data:{mode:'runtime',path:'events',deviceScope:'global'},content:{eventFilters:{scope:'current',level:'warning'},emptyText:'暂无当前设备事件'}}
 const events=[{id:'old',factory_id:'old-factory',source_id:'a',level:'warning',msg:'旧工厂缓存报警'},{id:'new',factoryId:'new-factory',deviceId:'a',level:'warning',msg:'新工厂真实报警'}]
 await view.render({widget,events,runtimeContext:{factoryId:'new-factory',deviceId:'a'}});assert.match(textContent(view.root),/新工厂真实报警/);assert.doesNotMatch(textContent(view.root),/旧工厂缓存报警/)
 await view.render({widget,events,runtimeContext:{factoryId:'empty-factory',deviceId:'a'}});assert.match(textContent(view.root),/暂无当前设备事件/);assert.doesNotMatch(textContent(view.root),/旧工厂缓存报警|新工厂真实报警/)
})

test('external event tables honor the same explicit device and level filters as internal records',async t=>{
 const view=fixture(t),rows=[{source_id:'a',level:'warning',message:'A表记录'},{deviceId:'b',level:'warning',message:'B表记录'},{sourceId:'a',level:'info',message:'A表提示'}]
 for(const mode of ['dataset','database','http_api']){
  const widget={id:'external-events',type:'hud_alarm_panel',data:{mode,datasetId:'events',datasetField:'message',deviceScope:'global'},content:{eventFilters:{scope:'current',level:'warning'},emptyText:'暂无所选事件'}}
  const props={widget,databaseValues:{'external-events':{quality:'good',rows}},runtimeContext:{deviceId:'a'}}
  await view.render(props);assert.match(textContent(view.root),/A表记录/);assert.doesNotMatch(textContent(view.root),/B表记录|A表提示/)
  await view.render({...props,runtimeContext:{}});assert.match(textContent(view.root),/暂无所选事件/);assert.doesNotMatch(textContent(view.root),/A表记录|B表记录/)
  if(mode==='dataset'){await view.render({...props,databaseValues:{'external-events':{quality:'bad',rows}}});assert.doesNotMatch(textContent(view.root),/A表记录/)}
 }
})

test('explicit current/fixed/list sources explain missing context and assignments instead of spinning or substituting a device',async t=>{
 const view=fixture(t),data={mode:'plc',bindingVersion:2,deviceScope:'current',deviceId:'a',pointId:'pa',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa'}}]}
 const base={widget:{id:'source-notice',type:'value',data,content:{showTitle:false}},overlayMode:true,dataReady:false,deviceCatalog:[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}],pointValues:{pa:{id:'pa',device_id:'a',quality:'good',value:111}}}
 await view.render({...base,runtimeContext:{}})
 assert.match(textContent(view.root),/未选择当前查看设备/);assert.doesNotMatch(textContent(view.root),/111|正在同步/)
 await view.render({...base,runtimeContext:{deviceId:'b'}})
 assert.match(textContent(view.root),/炉 B.*未选择对应数据/);assert.doesNotMatch(textContent(view.root),/111|正在同步/)
 await view.render({...base,widget:{...base.widget,data:{...data,deviceScope:'fixed',deviceId:'deleted'}},runtimeContext:{deviceId:'a'}})
 assert.match(textContent(view.root),/指定设备不存在或不可用/);assert.doesNotMatch(textContent(view.root),/111|正在同步/)
 await view.render({...base,widget:{...base.widget,data:{...data,deviceScope:'rotation',deviceBindings:[]}},runtimeContext:{deviceId:'a'}})
 assert.match(textContent(view.root),/轮播清单没有设备与对应数据/);assert.doesNotMatch(textContent(view.root),/111|正在同步/)
 await view.render({...base,runtimeContext:{deviceId:'a'},dataReady:true})
 assert.match(textContent(view.root),/111/);assert.doesNotMatch(textContent(view.root),/未选择|没有设备|不可用/)
})

test('HUD external metrics reject a different device result but allow an explicitly global metric',async t=>{
 const view=fixture(t),source={mode:'dataset',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:'a',binding:{mode:'dataset',datasetId:'set',datasetField:'hours'}}]}
 const widget={id:'metric-owner',type:'hud_kpi_panel',content:{showRing:false,items:[{label:'运行小时',binding:source},{label:'全厂产出',binding:{mode:'dataset',datasetId:'total',datasetField:'quantity',deviceScope:'global'}}]},data:{mode:'plc',bindingVersion:2,deviceScope:'fixed',deviceId:'a',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa'}}]}}
 const base={widget,deviceCatalog:[{id:'a'}],pointValues:{pa:{id:'pa',device_id:'a',quality:'good',value:37.5}},databaseValues:{'metric-owner':{deviceId:'a',quality:'good',metrics:{0:{quality:'good',value:999,deviceId:'b'},1:{quality:'good',value:42,deviceId:''}}}}}
 await view.render(base);assert.doesNotMatch(textContent(view.root),/999/);assert.match(textContent(view.root),/42/)
 await view.render({...base,databaseValues:{'metric-owner':{...base.databaseValues['metric-owner'],metrics:{0:{quality:'good',value:9,deviceId:'a'},1:{quality:'good',value:42,deviceId:''}}}}})
 assert.match(textContent(view.root),/9/);assert.match(textContent(view.root),/42/)
})

test('a global HUD panel reads explicitly fixed secondary PLC, dataset and device metadata from their own device',async t=>{
 const view=fixture(t),widget={id:'global-metric-owner',type:'hud_kpi_panel',data:{mode:'runtime',path:'metrics.overall_oee',deviceScope:'global'},content:{showRing:false,items:[
  {label:'设备小时',binding:{mode:'plc',deviceScope:'fixed',deviceId:'b',pointId:'hours',requireConfiguredPoint:true}},
  {label:'设备能耗',binding:{mode:'dataset',deviceScope:'fixed',deviceId:'b',datasetId:'set',datasetField:'energy'}},
  {label:'设备名称',binding:{mode:'runtime',deviceScope:'fixed',deviceId:'b',path:'deviceInfo.name'}}]}}
 const base={widget,deviceCatalog:[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}],runtimeContext:{deviceId:'a'},pointValues:{hours:{id:'hours',device_id:'b',value:9,quality:'good'}},databaseValues:{'global-metric-owner':{deviceId:'',quality:'good',metrics:{1:{quality:'good',value:42,deviceId:'b'}}}}}
 await view.render(base);assert.match(textContent(view.root),/9/);assert.match(textContent(view.root),/42/);assert.match(textContent(view.root),/炉 B/);assert.doesNotMatch(textContent(view.root),/炉 A/)
 await view.render({...base,runtimeContext:{deviceId:''}});assert.match(textContent(view.root),/9/);assert.match(textContent(view.root),/42/);assert.match(textContent(view.root),/炉 B/)
 await view.render({...base,deviceCatalog:[{id:'a',name:'炉 A'}]});assert.doesNotMatch(textContent(view.root),/9|42|炉 B/,'removed devices cannot be reconstructed from stale cached records')
})
