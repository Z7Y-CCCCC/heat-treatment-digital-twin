import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick, proxyRefs, ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import { parse as parseJavaScript } from '@babel/parser'
import { normalizeDashboardDocument, createDashboardWidgetPreset } from '../src/runtime/dashboardSchema.js'
import { createTooltipTemplate } from '../../shared/tooltipTemplates.mjs'
import { createTooltipContext } from '../src/runtime/tooltipContext.js'
import { installBrowser } from './helpers.mjs'

// Compile the actual existing inspector sections, not a lookalike form. Native
// Vue value/model directives and real @input/@change handlers run in memory.
// The designer store/transport and catalogue child requests are deliberately
// outside this fixture: no browser or real local/production draft is touched.
const require = createRequire(import.meta.url)
const { normalizeDocument } = require('../../backend/utils/dashboardDocument.js')
const designerUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const designerSource = await readFile(designerUrl, 'utf8')
const descriptor = parse(designerSource).descriptor
const sourceAst = parseJavaScript(descriptor.scriptSetup.content, { sourceType: 'module' })
const templateAst = baseParse(descriptor.template.content)
const walk = node => [node, ...(node.children || []).flatMap(walk)]
const sections = walk(templateAst).filter(node => node.tag === 'section' && node.props?.some(prop => prop.type === 7
  && ['if','else-if'].includes(prop.name) && /^inspectorTab === '(content|data)'$/.test(prop.exp?.content || '')))
assert.equal(sections.length, 2)
const handlerNames = ['editableMetric','metricFormatBinding','metricConfiguredUnit','applyMetricFormat','applyMetricLabel','applyMetricLabelSource',
  'updateTextContent','updateContentField','updateNavigationContent','staticStatusValue','updateMetricPath','setMetricValueSource','updateMetricLiteral',
  'setMetricSuffix','updateMetricSuffix','setDeviceListSource','setDeviceListField','setStatSource','setStatUnitSource','setChartSeriesSource','updateEventType','setEventFilter','applyDataWorkflow',
  'applyMetricSource','applyMetricScope','addBoundMetric','removeBoundMetric','renameSelectedWidget']
const handlers = handlerNames.map(name => {
  const node = sourceAst.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name)
  assert.ok(node, `Missing real handler ${name}`)
  return descriptor.scriptSetup.content.slice(node.start, node.end)
}).join('\n')

async function loadComponent(url, overrides = {}) {
  const source = overrides.source ?? await readFile(url, 'utf8')
  let code = compileScript(parse(source).descriptor, { id: 'current-content-memory', inlineTemplate: true }).content
  code = code.replace(/import \* as echarts from [^\n]+/, `const echarts = { init: element => ({setOption(option){element.chartOption=option},on(){},resize(){},dispose(){}}),graphic:{LinearGradient:class{}} }`)
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(overrides.imports?.[name]
    || (name.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}'
      : name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name)))}`)
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  return { component: (await import(moduleUrl)).default, moduleUrl }
}
const mapList = await loadComponent(new URL('../src/runtime/MapRegionList.vue', import.meta.url))
const ring = await loadComponent(new URL('../src/runtime/HudMetricRing.vue', import.meta.url))
const runtime = await loadComponent(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), {imports:{'./MapRegionList.vue':mapList.moduleUrl,'./HudMetricRing.vue':ring.moduleUrl}})
const bindingEditor = await loadComponent(new URL('../src/views/admin/components/WidgetDataBindingEditor.vue', import.meta.url))
const inspectorSource = `<script setup>
import {computed,ref,toRaw} from 'vue'
import WidgetDataBindingEditor from './WidgetDataBindingEditor.vue'
import {deepClone} from '../../../runtime/dashboardSchema.js'
import {editableWidgetText,updateWidgetTextContent,effectiveMetricItems,metricValueSource,deviceListDataSource,widgetImageSource,widgetStatSource,widgetChartSeriesSource,widgetChartSeriesPath} from '../../../runtime/widgetContentConfig.js'
import {bindingForDevice} from '../../../../../shared/widgetBindingWorkflow.mjs'
import {createWidgetInstanceRegistry,widgetIdError,renameDashboardWidget} from '../../../../../shared/dashboardWidgetIdentity.mjs'
import {hudTextFields} from '../../../runtime/hudTextConfig.js'
import {DASHBOARD_CHARTS,CHART_FIELD_ROLES} from '../../../../../shared/dashboardCharts.mjs'
import {MAP_DESIGNER_FIELDS} from '../../../runtime/mapDesigner.js'
import {widgetBindingChoices,LEGACY_BINDINGS} from '../../../runtime/widgetBindingChoices.js'
const props=defineProps({widget:Object,metrics:Object,mapData:Object,disabled:Boolean,workflow:Boolean,datasets:{type:Array,default:()=>[]}})
const emit=defineEmits(['commit'])
const selectedWidget=computed(()=>props.widget),inspectorTab=ref('content'),safeCatalogPreviewDeviceId=ref('a')
const documentModel=computed(()=>({widgets:[props.widget],scene:{views:[]}})),selectedIds=ref([props.widget.id]),loading=ref(false),widgetIdEditError=ref('')
const widgetInstances=createWidgetInstanceRegistry(toRaw),widgetInstanceKey=widget=>widgetInstances.key(widget)
const selectedWidgetIdIssue=computed(()=>widgetIdEditError.value || widgetIdError(documentModel.value,selectedWidget.value,selectedWidget.value.id))
const selectedUsesMapData=computed(()=>selectedWidget.value.data.mode==='runtime' && /^map(?:\\.|$)/.test(selectedWidget.value.data.path || ''))
const liveMetrics=computed(()=>props.metrics || {}),mapPreviewData=computed(()=>props.mapData || {}),dataSetDefinitions=computed(()=>props.datasets)
const devices=ref([{id:'a',name:'A设备'},{id:'b',name:'B设备'}]),points=ref([]),views=ref([]),workshops=ref([]),lines=ref([])
const chartPalettes=[],previewContext={viewMode:'factory',factoryId:'fixture'},selectedUsesBindingWorkflow=computed(()=>props.workflow),selectedWidgetSupportsData=true,currentViewIsMapSurface=false
const NavigationContentSettings={render:()=>null},TrendChartSettings={render:()=>null},ColorField={render:()=>null},DataCatalogPicker={render:()=>null},DevicePointBindingEditor={render:()=>null},WidgetPlaybackEditor={render:()=>null},DataSetBindingEditor={render:()=>null}
const previewParts=[],previewPartsBusy=false,previewPartsError='',pointValues={},databasePreviewValues={},playbackDevices=[],playbackNow=0,previewMode=false
const vPermission={},canAdminPage=()=>!props.disabled,commitHistory=label=>emit('commit',label),recordProperty=commitHistory,invalidateDataSetPreview=()=>{}
const chooseCatalogData=()=>{},changeReusableBinding=()=>{},changeBindingMode=()=>{}
${handlers}
defineExpose({inspectorTab})
</script><template><div>${sections.map(section => section.loc.source.replace('v-else-if="inspectorTab', 'v-if="inspectorTab')).join('')}</div></template>`
const inspector = await loadComponent(designerUrl, { source: inspectorSource, imports:{'./WidgetDataBindingEditor.vue':bindingEditor.moduleUrl} })
const overlaySource = await readFile(new URL('../src/views/DashboardOverlay.vue', import.meta.url), 'utf8')
const overlayDescriptor = parse(overlaySource).descriptor
const overlayAst = parseJavaScript(overlayDescriptor.scriptSetup.content, { sourceType: 'module' })
const eventQueryNode = overlayAst.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'eventQueryConfig')
assert.ok(eventQueryNode)
const actualEventQuery = new Function('widgets', `${overlayDescriptor.scriptSetup.content.slice(eventQueryNode.start,eventQueryNode.end)};return eventQueryConfig()`)
const tooltipUrl = new URL('../src/views/admin/components/TooltipTemplateEditor.vue', import.meta.url)
const tooltipSource = (await readFile(tooltipUrl, 'utf8'))
  .replace(/import \{ adminApi \} from [^\n]+/, 'const adminApi={getDeviceInspection:async()=>({inspection:{parts:[]}})}')
  .replace('</script>', '\ndefineExpose({selectedIds,template,inspectorTab,previewDeviceId,kind,addWidget})\n</script>')
const tooltipEditor = await loadComponent(tooltipUrl, { source: tooltipSource })
const clone = value => JSON.parse(JSON.stringify(value))
const reopened = doc => normalizeDashboardDocument(normalizeDocument(clone(doc)))
const widgetDocument = widget => normalizeDashboardDocument({name:'配置闭环',projectId:'fixture',sceneId:'fixture',widgets:[widget]})

function memoryHost(t) {
  const environment = installBrowser(t)
  environment.replace('Document',class {})
  environment.replace('ShadowRoot',class {})
  environment.replace('ResizeObserver', class {observe(){} disconnect(){}})
  let requests = 0
  t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('This control test must not acquire or persist real data')})
  const node = (type, text='') => {
    const listeners = new Map()
    const result = {type,tagName:type.toUpperCase(),text,props:{},children:[],parent:null,value:'',checked:false,selected:false,clientHeight:200,
      addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn)},
      removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(item=>item!==fn))},
      getAttribute(name){return this.props[name]},setAttribute(name,value){this.props[name]=value},removeAttribute(name){delete this.props[name]},
      getRootNode(){return globalThis.document},
      get options(){return this.children.filter(child=>child.type==='option')},
      get selectedIndex(){return this.options.findIndex(option=>option.selected)},set selectedIndex(index){this.options.forEach((option,i)=>{option.selected=i===index})},
      classList:{add(){},remove(){},contains(){return false}},style:{},
      dispatchEvent(event){for(const fn of listeners.get(event.type)||[])fn(event)},
      fire(name,value){if(this.type==='select')this.options.forEach(option=>{option.selected=String(option._value)===String(value)});if(typeof value==='boolean')this.checked=value;else this.value=String(value ?? '');const event={target:this,type:name,stopPropagation(){},preventDefault(){}};for(const fn of listeners.get(name)||[])fn(event);const handler=this.props['on'+name[0].toUpperCase()+name.slice(1)];for(const fn of Array.isArray(handler)?handler:handler?[handler]:[])fn(event)}
    }
    return result
  }
  const root=node('root'),remove=child=>{if(child.parent)child.parent.children=child.parent.children.filter(item=>item!==child);child.parent=null}
  const insert=(child,parent,anchor)=>{remove(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child)}
  const renderer=createRenderer({createElement:type=>node(type),createText:value=>node('#text',value),createComment:value=>node('#comment',value),
    setText:(child,value)=>{child.text=value},setElementText:(child,value)=>{child.text=value;child.children=[]},parentNode:child=>child.parent,
    nextSibling:child=>child.parent?.children[child.parent.children.indexOf(child)+1] || null,remove,
    insert,
    insertStaticContent(content,parent,anchor){
      const convert=parsed=>{
        const child=node(parsed.type===1?parsed.tag:parsed.type===3?'#comment':'#text',parsed.type===1?'':parsed.content || '')
        for(const prop of parsed.props || [])if(prop.type===6){child.props[prop.name]=prop.value?.content ?? '';if(prop.name==='value'){child.value=child.props.value;child._value=child.props.value}}
        for(const parsedChild of parsed.children || [])insert(convert(parsedChild),child)
        return child
      }
      const children=baseParse(content).children.map(convert);for(const child of children)insert(child,parent,anchor);return [children[0],children.at(-1)]
    },
    patchProp(child,key,_old,value){child.props[key]=value;if(key==='value'){child.value=String(value ?? '');child._value=value}else if(key==='checked')child.checked=Boolean(value)}
  })
  const all=(child=root)=>[child,...child.children.flatMap(item=>all(item))],text=child=>[child.type==='#comment'?'':child.text,...child.children.map(text)].join(' ')
  const field=label=>{const matches=all().filter(child=>child.props['aria-label']===label);assert.equal(matches.length,1,`Expected one real field: ${label}`);return matches[0]}
  environment.beforeRestore(()=>renderer.render(null,root))
  return {root,renderer,all,field,text,requests:()=>requests,renderText:()=>text(all().find(child=>child.props['data-preview-root']===true))}
}
async function settled(){await nextTick();await nextTick();await nextTick()}
async function mountWidget(t,input,extra={}) {
  const host=memoryHost(t),doc=ref(widgetDocument(input)),runtimeProps=ref(extra),widget=()=>doc.value.widgets.find(item=>item.id===input.id),commits=[],actions=[]
  let inspectorVm
  const app=host.renderer.createApp({setup:()=>()=>h('main',[
    h(inspector.component,{ref:vm=>{inspectorVm=vm},widget:widget(),metrics:runtimeProps.value.metrics,mapData:runtimeProps.value.mapData,datasets:runtimeProps.value.datasets,disabled:runtimeProps.value.disabled,workflow:runtimeProps.value.workflow,onCommit:label=>commits.push(label)}),
    h('section',{'data-preview-root':true},[h(runtime.component,{widget:widget(),preview:true,...runtimeProps.value,onAction:event=>actions.push(event)})])
  ])})
  app.mount(host.root);await settled();t.after(()=>app.unmount())
  return {...host,doc,runtimeProps,widget,commits,actions,get vm(){return inspectorVm},async reopen(){doc.value=reopened(doc.value);await settled()},chart(){return host.all().find(node=>node.chartOption)?.chartOption}}
}
async function mountTooltip(t,kind='device',extra={}) {
  const host=memoryHost(t),template=createTooltipTemplate(kind),doc=ref(normalizeDashboardDocument({tooltipTemplates:{templates:[template],defaults:{[kind]:template.id}}}))
  const id=kind==='part'?`${template.id}_description`:`${template.id}_status_value`
  const hover=ref(createTooltipContext({device:{id:'b',name:'悬停 B',workshopName:'车间 B'},part:{id:'part-b',name:'部件 B',description:'说明 B'},status:{quality:'good',online:true},runtimeContext:{viewMode:'factory',deviceId:'a'}}))
  const widget=()=>doc.value.tooltipTemplates.templates.find(item=>item.id===template.id).widgets.find(item=>item.id===id),commits=[]
  let vm
  const props={views:doc.value.scene.views,devices:[{id:'a',name:'预览 A'},{id:'b',name:'预览 B'}],points:[],pointValues:{},...extra}
  const app=host.renderer.createApp({setup:()=>()=>h('main',[
    h(tooltipEditor.component,{ref:value=>{vm=value},document:doc.value,...props,onChange:label=>commits.push(label)}),
    h('section',{'data-preview-root':true},[h(runtime.component,{widget:widget(),runtimeContext:hover.value,preview:true})])
  ])})
  app.mount(host.root);vm.kind=kind;await settled();vm.selectedIds=[id];await settled();t.after(()=>app.unmount())
  return {...host,doc,widget,hover,commits,get vm(){return vm},async reopen(){doc.value=reopened(doc.value);await settled()}}
}

test('scene preset entrances are absent while already authored preset groups survive normal save/reopen',()=>{
  const nodes=walk(templateAst)
  assert.equal(nodes.some(node=>node.tag==='button' && node.props?.some(prop=>prop.exp?.content?.includes('addWidgetPreset'))),false)
  assert.doesNotMatch(descriptor.template.content,/场景组件组|scene-preset-list|DASHBOARD_WIDGET_PRESETS/)
  const widgets=['factory_hud_modules','device_part_detail'].flatMap(id=>createDashboardWidgetPreset(id))
  const doc=widgetDocument(widgets[0]);doc.widgets=widgets;const before=clone(doc.widgets),after=reopened(doc)
  for(const widget of before){const restored=after.widgets.find(item=>item.id===widget.id);assert.ok(restored,widget.id);assert.equal(restored.groupId,widget.groupId);assert.deepEqual(restored.content,widget.content)}
})

test('fixed metric controls edit the actual literal, preserve zero and survive save/reopen',async t=>{
  const f=await mountWidget(t,{id:'fixed-metric',type:'metrics',content:{layout:'list',items:[{label:'固定计数',value:11,unit:'台'}]},data:{mode:'static'}})
  assert.equal(f.field('指标 1 数值来源').value,'fixed');assert.equal(f.field('指标 1 固定内容').value,'11')
  f.field('指标 1 固定内容').fire('input','0');f.field('指标 1 固定内容').fire('change','0');await settled()
  assert.match(f.renderText(),/固定计数\s*0台/);await f.reopen();assert.equal(f.widget().content.items[0].value,0);assert.match(f.renderText(),/0台/);assert.equal(f.requests(),0)
})

test('explicit blank field selection cannot silently restore an old fixed metric',async t=>{
  const f=await mountWidget(t,{id:'blank-field',type:'metrics',content:{layout:'list',items:[{label:'计数',value:999}]},data:{mode:'static'}})
  f.field('指标 1 数值来源').fire('change','field');await settled();assert.equal(f.field('指标 1 数值来源').value,'field')
  assert.match(f.renderText(),/--/);assert.doesNotMatch(f.renderText(),/999/);await f.reopen();assert.doesNotMatch(f.renderText(),/999/)
  f.field('指标 1 数据项字段').fire('input','metrics.total_devices');f.field('指标 1 数据项字段').fire('change','metrics.total_devices');await settled()
  assert.equal(f.widget().content.items[0].path,'metrics.total_devices')
})

test('the implicit online/total composition is visible without materialization and its actual fields are editable',async t=>{
  const f=await mountWidget(t,{id:'default-composition',type:'metrics',content:{layout:'list'},data:{mode:'static'}},{metrics:{online_devices:3,total_devices:7,running_devices:2}})
  assert.equal(Object.hasOwn(f.widget().content,'items'),false)
  assert.equal(f.field('指标 4 第二项字段').value,'metrics.total_devices');assert.equal(f.field('指标 4 分隔符').value,'/')
  assert.equal(Object.hasOwn(f.widget().content,'items'),false);assert.match(f.renderText(),/3\/7/)
  f.field('指标 4 第二项字段').fire('input','metrics.running_devices');f.field('指标 4 分隔符').fire('input',' : ');f.field('指标 4 分隔符').fire('change',' : ');await settled()
  assert.match(f.renderText(),/3 : 2/);await f.reopen();assert.match(f.renderText(),/3 : 2/)
  f.field('指标 4 组合第二项').fire('change',false);await settled();assert.equal(f.widget().content.items[3].suffixPath,undefined);assert.doesNotMatch(f.renderText(),/3 : 2/)
})

test('an existing independent binding can deliberately be replaced by a literal through normal content controls',async t=>{
  const f=await mountWidget(t,{id:'bound-to-fixed',type:'metrics',content:{layout:'list',items:[{label:'产量',binding:{mode:'runtime',deviceScope:'global',path:'metrics.current_output'}}]},data:{mode:'static'}},{metrics:{current_output:555}})
  assert.match(f.renderText(),/555/);f.field('指标 1 数值来源').fire('change','fixed');await settled();f.field('指标 1 固定内容').fire('input','手动值');await settled()
  assert.match(f.renderText(),/手动值/);assert.doesNotMatch(f.renderText(),/555/);await f.reopen();assert.match(f.renderText(),/手动值/)
})

test('map metric rows have the same explicit fixed/field selection rather than an immutable region fallback',async t=>{
  const f=await mountWidget(t,{id:'map-metric',type:'hud_kpi_panel',content:{showRing:false,items:[{label:'工厂',path:'map.factsFactoryCount'}]},data:{mode:'runtime',path:'map',deviceScope:'global'}},{mapData:{factsFactoryCount:8}})
  f.field('指标 1 数值来源').fire('change','fixed');await settled();f.field('指标 1 固定内容').fire('input','2');await settled();await f.reopen();assert.match(f.renderText(),/工厂\s*2/);assert.doesNotMatch(f.renderText(),/\s8\s/)
})

test('the existing category/time mapping displays its real legacy field and drives all ordinary chart axes after reopening',async t=>{
  for(const chartType of ['line','area','bar','stackedBar']){
    await t.test(chartType,async child=>{
    const f=await mountWidget(child,{id:`chart-${chartType}`,type:'trend',content:{chartType,timeField:'sampleTime',valueField:'reading'},data:{mode:'dataset',datasetId:'samples',datasetField:'reading',deviceScope:'global'}},{databaseValues:{[`chart-${chartType}`]:{quality:'good',value:0,rows:[{sampleTime:'原始时间',batch:'批次 A',reading:0},{sampleTime:'原始时间2',batch:'批次 B',reading:2}]}}})
    assert.equal(f.field('图表分类时间字段').value,'sampleTime');assert.deepEqual(f.chart().xAxis.data,['原始时间','原始时间2'])
    f.field('图表分类时间字段').fire('input','batch');f.field('图表分类时间字段').fire('change','batch');await settled();assert.deepEqual(f.chart().xAxis.data,['批次 A','批次 B'])
    assert.deepEqual(f.chart().series[0].data,[0,2]);await f.reopen();assert.deepEqual(f.chart().xAxis.data,['批次 A','批次 B'])
    })
  }
})

test('legacy static chart series expose their real context field, and field/primary selections survive save/reopen without unrelated fallback',async t=>{
  const f=await mountWidget(t,{id:'static-series',type:'trend',content:{chartType:'line',valueField:'value'},data:{mode:'static'}},{trendPoints:[{time:'原始采样',value:81}],mapData:{records:[{time:'指定行',value:0},{time:'指定行2',value:7}]}})
  const before=JSON.stringify(f.widget())
  assert.equal(f.field('图表序列来源').value,'field');assert.equal(f.field('图表序列字段').value,'trendPoints')
  assert.deepEqual(f.chart().series[0].data,[81]);assert.equal(JSON.stringify(f.widget()),before)
  f.field('图表序列字段').fire('input','map.records');f.field('图表序列字段').fire('change','map.records');await settled()
  assert.deepEqual(f.chart().xAxis.data,['指定行','指定行2']);assert.deepEqual(f.chart().series[0].data,[0,7])
  await f.reopen();assert.deepEqual(f.chart().series[0].data,[0,7]);assert.equal(f.field('图表序列字段').value,'map.records')
  f.field('图表序列字段').fire('input','map.missing');await settled();assert.deepEqual(f.chart().series[0].data,[])
  f.field('图表序列字段').fire('input','');await f.reopen();assert.deepEqual(f.chart().series[0].data,[])
  f.field('图表序列来源').fire('change','binding');await f.reopen();assert.deepEqual(f.chart().series[0].data,[])
  assert.equal(f.field('图表序列来源').value,'binding');assert.equal(f.requests(),0)
})

test('an explicit independent chart field wins over dataset series and quality, while selecting the primary source restores the real external rows',async t=>{
  const f=await mountWidget(t,{id:'external-series',type:'hud_chart_dock',content:{chartType:'line'},data:{mode:'dataset',datasetId:'samples',datasetField:'value',deviceScope:'global'}},{mapData:{records:[{time:'区域 A',value:0}]},databaseValues:{'external-series':{quality:'good',value:55,rows:[{time:'表行',value:55}],series:[{id:'external',label:'表曲线',rows:[{time:'表曲线行',value:55}]}]}}})
  assert.equal(f.field('图表序列来源').value,'binding');assert.deepEqual(f.chart().xAxis.data,['表曲线行'])
  f.field('图表序列来源').fire('change','field');await settled();f.field('图表序列字段').fire('input','map.records');await f.reopen()
  assert.deepEqual(f.chart().xAxis.data,['区域 A']);assert.deepEqual(f.chart().series[0].data,[0])
  const goodRecord=clone(f.runtimeProps.value.databaseValues['external-series'])
  f.runtimeProps.value.databaseValues['external-series']={quality:'bad',value:null,rows:[],series:[]};await settled()
  // A bad/missing primary readout does not replace or suppress an explicitly
  // independent array source. The scalar readout still owns its own quality.
  assert.deepEqual(f.chart().series[0].data,[0])
  f.field('图表序列来源').fire('change','binding');await f.reopen();assert.deepEqual(f.chart().series,[])
  f.runtimeProps.value.databaseValues['external-series']=goodRecord;await settled();assert.deepEqual(f.chart().xAxis.data,['表曲线行'])
  assert.equal(f.requests(),0)
})

test('a legacy static HUD readout visibly follows the latest actual series sample, and explicit primary/field choices do not inherit that fallback',async t=>{
  const f=await mountWidget(t,{id:'sample-readout',type:'hud_chart_dock',content:{chartType:'line',statLabel:'当前值'},data:{mode:'static'}},{trendPoints:[{time:'A',value:81}],mapData:{records:[{time:'B',value:7}]},metrics:{manual:0}})
  const before=JSON.stringify(f.widget());assert.equal(f.field('读数来源').value,'series');assert.match(f.renderText(),/当前值\s*81/);assert.equal(JSON.stringify(f.widget()),before)
  f.field('图表序列字段').fire('input','map.records');await f.reopen();assert.match(f.renderText(),/当前值\s*7/)
  f.field('读数来源').fire('change','binding');await f.reopen();assert.match(f.renderText(),/当前值\s*—/)
  f.field('读数来源').fire('change','series');await settled();assert.match(f.renderText(),/当前值\s*7/)
  f.field('读数来源').fire('change','field');await settled();f.field('读数字段').fire('input','metrics.manual');f.field('读数字段').fire('change','metrics.manual');await f.reopen();assert.match(f.renderText(),/当前值\s*0/)
  assert.equal(f.requests(),0)
})

test('readonly chart source and array-field controls cannot mutate saved content or commit history through synthetic events',async t=>{
  const f=await mountWidget(t,{id:'readonly-series',type:'trend',content:{chartType:'line'},data:{mode:'static'}},{disabled:true,trendPoints:[{time:'A',value:1}]})
  const before=JSON.stringify(f.widget());f.field('图表序列来源').fire('change','binding');f.field('图表序列字段').fire('input','map.records');await settled()
  assert.equal(JSON.stringify(f.widget()),before);assert.deepEqual(f.commits,[]);assert.equal(f.requests(),0)
})

test('the existing marquee query fields show the real alarm filter and alter the actual surface query after save/reopen',async t=>{
  const f=await mountWidget(t,{id:'event-query',type:'marquee',content:{eventType:'alarm',eventWindowHours:1,limit:50,speed:36},data:{mode:'runtime',path:'events',source:'events'}},{events:[]})
  const before=JSON.stringify(f.widget());assert.equal(f.field('事件查询类型').value,'alarm');assert.equal(Number(f.field('事件查询窗口小时').value),1);assert.equal(JSON.stringify(f.widget()),before)
  const query=()=>actualEventQuery({value:f.doc.value.widgets})
  assert.deepEqual(query(),{limit:50,eventWindowHours:1,eventType:'alarm'})
  f.field('事件查询类型').fire('input','manual');f.field('事件查询类型').fire('change','manual');f.field('事件查询窗口小时').fire('input','0');f.field('事件查询窗口小时').fire('change','0');await f.reopen()
  assert.deepEqual(query(),{limit:50,eventWindowHours:0,eventType:'manual'})
  f.widget().content.event_type='旧类型';await settled();f.field('事件查询类型').fire('input','');await f.reopen()
  assert.equal(query().eventType,'');assert.equal(Object.hasOwn(f.widget().content,'event_type'),false);assert.equal(f.requests(),0)
})

test('legacy current-scope system events project the real factory source into existing native range/level controls, and their saved selections filter actual renderer rows',async t=>{
  const f=await mountWidget(t,{id:'legacy-event-scope',type:'marquee',title:'',content:{speed:36,limit:50},data:{mode:'runtime',path:'events',source:'events',deviceScope:'current'}},{workflow:true,runtimeContext:{factoryId:'fixture',deviceId:'a'},events:[
    {id:'a-warn',factoryId:'fixture',sourceId:'a',level:'warning',message:'A警告'},
    {id:'a-info',factoryId:'fixture',sourceId:'a',level:'info',message:'A提示'},
    {id:'b-info',factoryId:'fixture',sourceId:'b',level:'info',message:'B提示'},
    {id:'foreign',factoryId:'other',sourceId:'a',level:'warning',message:'其他工厂'},
    {id:'placeholder',placeholder:true,level:'warning',message:'假示例'}]})
  const before=JSON.stringify(f.widget());f.vm.inspectorTab='data';await settled()
  assert.equal(f.field('事件记录范围').value,'factory');assert.equal(f.field('事件记录级别').value,'')
  assert.equal(f.all().some(node=>node.props['aria-label']==='组件显示方式'),false)
  assert.match(f.renderText(),/A警告.*A提示.*B提示/s);assert.doesNotMatch(f.renderText(),/其他工厂|假示例/);assert.equal(JSON.stringify(f.widget()),before)
  f.field('事件记录范围').fire('change','current');f.field('事件记录级别').fire('change','warning');await f.reopen()
  assert.match(f.renderText(),/A警告/);assert.doesNotMatch(f.renderText(),/A提示|B提示|其他工厂|假示例/)
  assert.deepEqual(f.widget().content.eventFilters,{scope:'current',level:'warning'});assert.equal(f.widget().data.deviceScope,'current')
  f.field('事件记录范围').fire('change','factory');f.field('事件记录级别').fire('change','');await f.reopen();assert.match(f.renderText(),/A警告.*A提示.*B提示/s)
  assert.equal(f.requests(),0)
})

test('the actual container preview caption is an ordinary existing content input, not a source explanation or frozen fallback',async t=>{
  const f=await mountWidget(t,{id:'container-copy',type:'container',title:'',content:{showTitle:false,previewLabel:'部件详情区域'},data:{mode:'static'}},{showContainerPlaceholder:true})
  assert.equal(f.field('容器预览文字').value,'部件详情区域');assert.match(f.renderText(),/部件详情区域/)
  f.field('容器预览文字').fire('input','用户分组');f.field('容器预览文字').fire('change','用户分组');await f.reopen();assert.match(f.renderText(),/用户分组/)
  f.field('容器预览文字').fire('input','');await f.reopen();assert.doesNotMatch(f.renderText(),/部件详情区域|用户分组|容器区域/);assert.equal(f.requests(),0)
})

test('an existing decorative part container retains its old binding but never creates an unconfigured device heading',async t=>{
  const f=await mountWidget(t,{id:'part-panel-compat',type:'container',title:'',content:{showTitle:false,previewLabel:'部件详情区域'},data:{mode:'runtime',path:'selectedPart.points.0.value',deviceScope:'current'}},{showContainerPlaceholder:true,deviceCatalog:[{id:'a',name:'不应显示的设备名'}],runtimeContext:{viewMode:'device',deviceId:'a'},selectedPart:{points:[{value:42}]}})
  const before=clone(f.widget().data);assert.match(f.renderText(),/部件详情区域/);assert.doesNotMatch(f.renderText(),/不应显示的设备名/)
  assert.equal(f.all().some(node=>node.props.class==='widget-device-heading'),false)
  f.field('容器预览文字').fire('input','保留的分组');await f.reopen();assert.deepEqual(f.widget().data,before)
  assert.match(f.renderText(),/保留的分组/);assert.doesNotMatch(f.renderText(),/不应显示的设备名/);assert.equal(f.requests(),0)
})

test('ordinary non-skin metrics rings follow the selected primary/field source rather than ignoring the existing control',async t=>{
  const f=await mountWidget(t,{id:'ordinary-ring',type:'metrics',content:{items:[],useBoundRing:true,chartPath:'metrics.overall_oee'},data:{mode:'runtime',path:'metrics.current_output',deviceScope:'global'}},{metrics:{current_output:37,overall_oee:64}})
  assert.equal(f.chart().series[0].data[0].value,37)
  f.field('圆环数值来源').fire('change','field');await settled();assert.equal(f.chart().series[0].data[0].value,64);await f.reopen();assert.equal(f.chart().series[0].data[0].value,64)
  f.field('圆环指标字段').fire('input','metrics.missing');await settled();assert.equal(f.chart().series[0].label.formatter,'—')
})

test('empty metric and chart text controls retain intentional blanks and hidden empty metrics affect the overlay renderer',async t=>{
  const f=await mountWidget(t,{id:'empty-metric',type:'metrics',content:{layout:'list',hideEmptyItems:true,items:[{label:'有效零',path:'metrics.zero'},{label:'空项',path:'metrics.missing'}]},data:{mode:'static'}},{overlayMode:true,metrics:{zero:0}})
  assert.match(f.renderText(),/有效零\s*0/);assert.doesNotMatch(f.renderText(),/空项/)
  f.field('隐藏空指标').fire('change',false);await settled();assert.match(f.renderText(),/空项/);await f.reopen();assert.match(f.renderText(),/空项/)
  f.widget().content.items=[];await settled();f.field('指标空列表文字').fire('input','无可用指标');await settled();assert.match(f.renderText(),/无可用指标/)
  f.field('指标空列表文字').fire('input','');await f.reopen();assert.doesNotMatch(f.renderText(),/无可用指标|暂无指标数据/)
})

test('map title and every existing record field mapping are ordinary controls with defaults and actual runtime effects',async t=>{
  const mapData={title:'当前天津区域',records:[{name:'旧名称',kind:'region',code:'old-code',count:9,localCount:5,registeredCount:4,
    alias:'天津工厂',recordKind:'factory',factoryCode:'factory-tianjin',factoryId:'天津-ID',n:0,w:2,l:3,d:6}]}
  const f=await mountWidget(t,{id:'map-list',type:'map_region_list',data:{mode:'runtime',path:'map.records',deviceScope:'global'},content:{}},{mapData,preview:false})
  const before=JSON.stringify(f.widget());assert.equal(f.field('地图列表标题来源').value,'region');assert.equal(f.field('地图列表字段 已接入数').value,'localCount');assert.equal(f.field('地图列表字段 设备数').value,'devices');assert.equal(JSON.stringify(f.widget()),before)
  for(const [label,value] of [['名称','alias'],['类型','recordKind'],['区域代码','factoryCode'],['工厂ID','factoryId'],['数量','n'],['车间数','w'],['产线数','l'],['设备数','d']])f.field(`地图列表字段 ${label}`).fire('change',value)
  f.field('地图列表标题来源').fire('change','fixed');await settled();f.field('地图列表固定标题').fire('input','用户列表');await settled()
  assert.match(f.renderText(),/用户列表.*天津工厂.*2 车间.*3 产线.*6 设备.*0/s);assert.doesNotMatch(f.renderText(),/旧名称|5 已接入/)
  const record=f.all().find(node=>node.props.class==='map-record');record.fire('click','');assert.equal(f.actions[0].event.action,'map_enter_factory');assert.equal(f.actions[0].event.id,'天津-ID')
  record.fire('mouseenter','');assert.equal(f.actions[1].event.id,'factory-tianjin');await f.reopen();assert.match(f.renderText(),/用户列表.*天津工厂/s)
  f.field('地图列表标题来源').fire('change','region');await settled();assert.match(f.renderText(),/当前天津区域/);assert.equal(f.requests(),0)
})

test('old static device lists disclose their real factory source without mutation, and source/field changes drive list plus statistics',async t=>{
  const f=await mountWidget(t,{id:'device-status',type:'hud_device_status',content:{},data:{mode:'static',datasetId:'devices'}},{deviceStatusMap:{a:{name:'内部设备',online:false,running:true,alarm:false,quality:'good'}},datasets:[{id:'devices',columns:[{name:'flag',label:'状态字段'}]}],databaseValues:{'device-status':{quality:'good',rows:[{id:'external',name:'外部设备',flag:true,online:false,running:false}]}}})
  const before=JSON.stringify(f.widget());f.vm.inspectorTab='data';await settled();assert.equal(f.field('设备列表数据来源').value,'runtime');assert.equal(f.field('设备列表字段 在线').value,'online');assert.equal(JSON.stringify(f.widget()),before)
  f.field('设备列表字段 在线').fire('change','running');await settled();assert.match(f.renderText(),/在线\s*1.*内部设备/s);await f.reopen();assert.equal(f.widget().data.mode,'static');assert.match(f.renderText(),/在线\s*1/s)
  f.field('设备列表数据来源').fire('change','dataset');await settled();f.field('设备列表字段 在线').fire('change','flag');await settled();assert.match(f.renderText(),/在线\s*1.*外部设备/s);assert.doesNotMatch(f.renderText(),/内部设备/)
  await f.reopen();assert.equal(f.widget().data.mode,'dataset');assert.match(f.renderText(),/外部设备/);assert.equal(f.widget().data.deviceScope,'global');assert.equal(f.requests(),0)
})

test('the real tooltip source and fixed text controls override a preset only after explicit selection and survive front/backend reopening',async t=>{
  for(const kind of ['device','part']){
    await t.test(kind,async child=>{
    const f=await mountTooltip(child,kind);assert.equal(f.field('悬停内容来源').value,'runtime');assert.notEqual(f.widget().content.text,'数据正常')
    f.field('悬停内容来源').fire('change','static');await settled();assert.equal(f.field('悬停元素文字').value,'')
    f.field('悬停元素文字').fire('input','用户固定内容\n第二行');f.field('悬停元素文字').fire('change','用户固定内容\n第二行');await settled()
    assert.match(f.renderText(),/用户固定内容.*第二行/s);await f.reopen();assert.equal(f.widget().data.mode,'static');assert.equal(f.widget().content.dataSourceConfigured,true);assert.equal(f.widget().dynamicBinding,undefined);assert.match(f.renderText(),/用户固定内容/)
    assert.equal(f.widget().data.deviceId,'');assert.equal(f.requests(),0)
    })
  }
})

test('tooltip preset fields can choose another actual source while runtime identity follows the hover, not the preview device',async t=>{
  const f=await mountTooltip(t);f.vm.inspectorTab='data';await settled();f.field('悬停字段').fire('change','hover.device.name');await settled()
  assert.equal(f.widget().content.dataSourceConfigured,true);assert.equal(f.widget().dynamicField,undefined);assert.equal(f.widget().data.deviceId,'');assert.match(f.renderText(),/悬停 B/)
  await f.reopen();f.hover.value=createTooltipContext({device:{id:'c',name:'新悬停 C'},status:{online:true,quality:'good'},runtimeContext:{viewMode:'factory',deviceId:'a'}});await settled()
  assert.match(f.renderText(),/新悬停 C/);assert.doesNotMatch(f.renderText(),/预览 A|预览 B|悬停 B/)
  f.vm.inspectorTab='content';await settled();f.field('悬停元素文字').fire('change','设备：{value}');await settled();assert.match(f.renderText(),/设备：新悬停 C/);await f.reopen();assert.match(f.renderText(),/设备：新悬停 C/)
})

test('readonly source/metric/map controls do not change content, provenance or commit history even if a synthetic event is fired',async t=>{
  const f=await mountWidget(t,{id:'readonly',type:'metrics',content:{layout:'list',items:[{label:'不可编辑',value:1}]},data:{mode:'static'}},{disabled:true})
  const before=JSON.stringify(f.widget());f.field('指标 1 数值来源').fire('change','field');f.field('指标 1 固定内容').fire('input','99');assert.equal(JSON.stringify(f.widget()),before);assert.deepEqual(f.commits,[])
})

test('explicit normal HUD layout overrides the old small-frame compact heuristic and survives reopening',async t=>{
  const f=await mountWidget(t,{id:'hud-layout',type:'hud_chart_dock',frame:{x:0,y:0,width:400,height:200},content:{},data:{mode:'static'}})
  assert.equal(f.field('HUD 紧凑布局').checked,true)
  const shell=()=>f.all().find(node=>node.props.class?.includes('widget-kind-hud_chart_dock'))
  assert.match(shell().props.class,/hud-module-compact/)
  f.field('HUD 紧凑布局').fire('change',false);await settled();assert.doesNotMatch(shell().props.class,/hud-module-compact/)
  await f.reopen();assert.equal(f.widget().content.compact,false);assert.doesNotMatch(shell().props.class,/hud-module-compact/)
})
