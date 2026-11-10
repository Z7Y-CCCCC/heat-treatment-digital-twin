import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { baseParse } from '@vue/compiler-dom'
import { parse as parseJavaScript } from '@babel/parser'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { createWidgetReadScheduler } from '../src/runtime/widgetReadScheduler.js'
import { dashboardWidgetIdentityIssues } from '../../shared/dashboardWidgetIdentity.mjs'
import { installBrowser } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { normalizeDocument } = require('../../backend/utils/dashboardDocument.js')
const clone = value => JSON.parse(JSON.stringify(value))
const sourceUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const source = await readFile(sourceUrl, 'utf8'), descriptor = parse(source).descriptor
const ast = parseJavaScript(descriptor.scriptSetup.content, { sourceType: 'module' })
const declarations = name => {
  const node = ast.program.body.find(node => node.type === 'FunctionDeclaration' ? node.id?.name === name
    : node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === name))
  assert.ok(node, `Missing actual Designer declaration ${name}`)
  return descriptor.scriptSetup.content.slice(node.start, node.end)
}
const walk = node => [node, ...(node.children || []).flatMap(walk)]
const elements = walk(baseParse(descriptor.template.content))
const sections = elements.filter(node => node.tag === 'section' && node.props?.some(prop => prop.type === 7
  && ['if','else-if'].includes(prop.name) && /^inspectorTab === '(content|data)'$/.test(prop.exp?.content || '')))
const layer = elements.find(node => node.tag === 'button' && node.props?.some(prop => prop.name === 'for' && prop.exp?.content === 'widget in [...layerWidgets].reverse()'))
const article = elements.find(node => node.tag === 'article' && node.props?.some(prop => prop.name === 'for' && prop.exp?.content === 'widget in canvasWidgets'))
assert.ok(layer && article)

// Reuse the sealed in-memory native Vue host, without importing/running its tests.
const controlTests = await readFile(new URL('./current-content-controls.test.mjs', import.meta.url), 'utf8')
const controlAst = parseJavaScript(controlTests, { sourceType: 'module' })
const hostNode = controlAst.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'memoryHost')
const memoryHost = new Function('installBrowser','createRenderer','baseParse','assert', `${controlTests.slice(hostNode.start,hostNode.end)};return memoryHost`)(installBrowser,createRenderer,baseParse,assert)
const contentNames = controlAst.program.body.find(node => node.type === 'VariableDeclaration'
  && node.declarations.some(item => item.id.name === 'handlerNames')).declarations.find(item => item.id.name === 'handlerNames').init.elements.map(item => item.value)
const handlers = [...new Set([...contentNames,'selectWidget','selectCanvasWidget','renameSelectedWidget','findWidget','recordProperty','saveDraft',
  'movableSelection','beginMove','beginResize','handlePointerMove','endPointerOperation','alignedPosition','snap'])].map(declarations).join('\n')
const selected = ['widgetInstances','inspectorInstanceKey','widgetIdEditError','widgetInstanceKey','selectedWidgets','selectedWidget','selectedWidgetIdIssue','selectedUsesBindingWorkflow'].map(declarations).join('\n')

async function component(url, replacement, imports = {}) {
  let code = compileScript(parse(replacement ?? await readFile(url, 'utf8')).descriptor, { id: 'instance-identity-memory', inlineTemplate: true }).content
  code = code.replace(/import \* as echarts from [^\n]+/, 'const echarts={init:element=>({setOption(option){element.chartOption=option},on(){},resize(){},dispose(){}}),graphic:{LinearGradient:class{}}}')
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match,_quote,name) => `from ${JSON.stringify(imports[name]
    || (name.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}' : name.startsWith('.') ? new URL(name,url).href : import.meta.resolve(name)))}`)
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  return { moduleUrl, component: (await import(moduleUrl)).default }
}
const bindingEditor = await component(new URL('../src/views/admin/components/WidgetDataBindingEditor.vue',import.meta.url))
const mapList = await component(new URL('../src/runtime/MapRegionList.vue',import.meta.url))
const ring = await component(new URL('../src/runtime/HudMetricRing.vue',import.meta.url))
const renderer = await component(new URL('../src/runtime/WidgetRenderer.vue',import.meta.url),undefined,{'./MapRegionList.vue':mapList.moduleUrl,'./HudMetricRing.vue':ring.moduleUrl})
const fixtureSource = `<script setup>
import {computed,ref,toRaw} from 'vue'
import WidgetDataBindingEditor from './WidgetDataBindingEditor.vue'
import {deepClone,widgetTypeLabel,normalizeDashboardDocument} from '../../../runtime/dashboardSchema.js'
import {createWidgetInstanceRegistry,dashboardWidgetIdentityIssues,widgetIdError,renameDashboardWidget,allocateNewWidgetIds} from '../../../../../shared/dashboardWidgetIdentity.mjs'
import {editableWidgetText,updateWidgetTextContent,effectiveMetricItems,metricValueSource,deviceListDataSource,widgetImageSource,widgetStatSource,widgetChartSeriesSource,widgetChartSeriesPath} from '../../../runtime/widgetContentConfig.js'
import {bindingForDevice} from '../../../../../shared/widgetBindingWorkflow.mjs'
import {hudTextFields} from '../../../runtime/hudTextConfig.js'
import {DASHBOARD_CHARTS,CHART_FIELD_ROLES} from '../../../../../shared/dashboardCharts.mjs'
import {MAP_DESIGNER_FIELDS} from '../../../runtime/mapDesigner.js'
import {widgetBindingChoices,LEGACY_BINDINGS} from '../../../runtime/widgetBindingChoices.js'
const props=defineProps({document:Object,store:Object})
const documentModel=ref(deepClone(props.document)),selectedIds=ref([]),inspectorTab=ref('content'),loading=ref(false),saving=ref(false)
${selected}
const layerWidgets=computed(()=>documentModel.value.widgets),canvasWidgets=layerWidgets
const componentDisplayStates=computed(()=>Object.fromEntries(layerWidgets.value.map(w=>[widgetInstanceKey(w),{visible:true,reason:''}])))
const selectedUsesMapData=computed(()=>selectedWidget.value?.data?.mode==='runtime' && /^map(?:\\.|$)/.test(selectedWidget.value.data.path || ''))
const liveMetrics=ref({}),mapPreviewData=ref({}),dataSetDefinitions=ref([]),views=ref([]),points=ref([]),workshops=ref([]),lines=ref([])
const devices=ref([{id:'A',name:'A设备'},{id:'B',name:'B设备'}]),safeCatalogPreviewDeviceId=ref('A')
const chartPalettes=[],previewContext={viewMode:'factory',factoryId:'fixture',deviceId:'A'},selectedWidgetSupportsData=true,currentViewIsMapSurface=false
const NavigationContentSettings={render:()=>null},TrendChartSettings={render:()=>null},ColorField={render:()=>null},DataCatalogPicker={render:()=>null},DevicePointBindingEditor={render:()=>null},WidgetPlaybackEditor={render:()=>null},DataSetBindingEditor={render:()=>null}
const previewParts=[],previewPartsBusy=false,previewPartsError='',pointValues={},databasePreviewValues={},playbackDevices=[],playbackNow=0,previewMode=false
const vPermission={},canAdminPage=()=>true,commits=ref([]),commitHistory=label=>commits.value.push(label),invalidateDataSetPreview=()=>{}
const chooseCatalogData=()=>{},changeReusableBinding=()=>{},changeBindingMode=()=>{},setWidgetVisibility=()=>{}
const revealRightPanel=()=>{},focusWidgetInCanvas=()=>{},layerWidgetTitle=w=>w.title,layerWidgetDetail=w=>w.id,toggleLayerVisibility=()=>{},toggleLayerLock=()=>{},widgetFrameStyle=()=>({})
const canvas=computed(()=>documentModel.value.canvas),zoom=ref(1),guides={x:[],y:[]},selectionBox={active:false},currentViewWidgets=layerWidgets,canvasPointAt=(x,y)=>({x,y})
let canvasPointerSelection=null,pointerOperation=null
const deletionSyncConflict=ref(null),designerDisposed=false,revision=ref(0),draftBaselineKnown=ref(true),lastSavedSnapshot=ref(''),status=ref(''),validationIssues=ref([])
const rememberEditorState=()=>({}),resolveDraftConflict=async()=>true,snapshot=(value=documentModel.value)=>JSON.stringify(value)
const refreshBindingCatalog=async()=>{},validationFailure=value=>new Error(value.error),persistLocalDraft=()=>{},resetHistory=()=>{},clearLocalDraft=()=>{},clearFactoryDraft=()=>{},draftFactoryId='fixture',restoreEditorState=()=>{}
const setStatus=text=>status.value=text,setValidationIssues=()=>{},syncBindingReferenceIssues=()=>{},emit=()=>{},flushPendingDashboardDeletions=()=>{}
const adminApi={saveDashboardDraft:async(sceneId,value,revision)=>props.store.save(value,revision)}
${handlers}
defineExpose({documentModel,selectedIds,selectedWidget,selectedUsesBindingWorkflow,inspectorTab,widgetInstanceKey,findWidget,saveDraft,status,commits,
  beginMove,beginResize,handlePointerMove,endPointerOperation,pointerFrameKeys:()=>[...(pointerOperation?.frames?.keys() || [])]})
</script><template><main><div data-layer-root>${layer.loc.source}</div><div data-canvas-root>${article.loc.source.slice(0,article.loc.source.indexOf('>')+1)}<span>{{widget.title}}</span></article></div><template v-if="selectedWidget"><div :key="widgetInstanceKey(selectedWidget)">${sections.map(section=>section.loc.source.replace('v-else-if="inspectorTab','v-if="inspectorTab')).join('')}</div></template></main></template>`
const designer = await component(sourceUrl,fixtureSource,{'./WidgetDataBindingEditor.vue':bindingEditor.moduleUrl})
const settled = async()=>{await nextTick();await nextTick();await nextTick()}

async function mount(t,document) {
  const host=memoryHost(t),saved=[],store={save:async(value,revision)=>{assert.deepEqual(dashboardWidgetIdentityIssues(value),[]);const doc=normalizeDocument(clone(value));saved.push(doc);return {document:doc,revision:revision+1}}}
  let vm
  const app=host.renderer.createApp({setup:()=>()=>h(designer.component,{ref:value=>vm=value,document,store})})
  app.config.warnHandler=()=>{}
  app.mount(host.root);await settled();t.after(()=>app.unmount())
  const click=async(index,canvas=false)=>{const key=vm.widgetInstanceKey(vm.documentModel.widgets[index]);const prop=canvas?'data-widget-instance':'data-component-instance';const node=host.all().find(node=>node.props[prop]===key);assert.ok(node,`actual instance ${index} rendered`);node.fire('click');await settled();return node}
  return {...host,saved,store,click,get vm(){return vm}}
}

test('current 317 draft: each of all eight duplicate instances is reachable through real canvas/layer clicks without changing raw IDs or content', async t=>{
  const draftUrl=new URL('../../output/realtime-linkage-configuration-20261110-20261109T205029667Z/initial-local-draft/local-editor-document.json',import.meta.url)
  const bytes=await readFile(draftUrl),hash=createHash('sha256').update(bytes).digest('hex'),raw=JSON.parse(bytes)
  assert.equal(raw.widgets.length,317)
  const f=await mount(t,raw),before=JSON.stringify(f.vm.documentModel),evidence=[]
  for(const index of [288,289,290,291,313,314,315,316]){
    for(const canvas of [false,true]){
      await f.click(index,canvas)
      assert.equal(f.vm.selectedWidget,f.vm.documentModel.widgets[index])
      assert.equal(f.vm.selectedWidget.id,raw.widgets[index].id)
      assert.equal(f.vm.selectedUsesBindingWorkflow,raw.widgets[index].type!=='hud_device_status')
      assert.equal(f.field('组件标识').value,raw.widgets[index].id)
      assert.equal(f.vm.selectedIds.length,4,'group remains selected while the Inspector edits the actual clicked member')
    }
    evidence.push({pointer:`/widgets/${index}`,widgetId:raw.widgets[index].id,type:raw.widgets[index].type,
      originalInstanceSha256:createHash('sha256').update(JSON.stringify(raw.widgets[index])).digest('hex'),
      temporaryInstanceKey:f.vm.widgetInstanceKey(f.vm.documentModel.widgets[index]),layerClickMatchedActualObject:true,canvasClickMatchedActualObject:true,
      inspectorComponentIdentifierMatched:true,workflowEnabled:f.vm.selectedUsesBindingWorkflow})
  }
  assert.equal(JSON.stringify(f.vm.documentModel),before)
  assert.equal(await f.vm.saveDraft(),false)
  assert.equal(f.saved.length,0)
  assert.equal(createHash('sha256').update(await readFile(draftUrl)).digest('hex'),hash)
  assert.equal(f.requests(),0)
  console.log(JSON.stringify({evidence:'current-duplicate-instance-reachability',draftSha256:hash,canvasCount:317,instances:evidence,
    documentUnchanged:true,unrepairedDuplicateSaveBlocked:true,transportRequests:0}))
})

test('native component identifier rejects duplicate/illegal edits atomically; explicit repair preserves other content and normal view references', async t=>{
  const document=normalizeDashboardDocument({widgets:[{id:'same',type:'value',content:{value:1},groupId:'g'},{id:'same',type:'value',content:{value:2},groupId:'g'}]})
  const f=await mount(t,document);await f.click(0)
  const before=clone(f.vm.documentModel),field=f.field('组件标识')
  for(const value of ['same','bad/name',' x ']){field.fire('input',value);field.fire('change',value);await settled();assert.deepEqual(clone(f.vm.documentModel),before);assert.equal(field.value,'same')}
  field.fire('input','first');field.fire('change','first');await settled()
  assert.equal(f.vm.selectedWidget,f.vm.documentModel.widgets[0])
  assert.deepEqual({...clone(f.vm.documentModel.widgets[0]),id:'same'},before.widgets[0])
  assert.deepEqual(clone(f.vm.documentModel.widgets[1]),before.widgets[1])
  assert.deepEqual(dashboardWidgetIdentityIssues(f.vm.documentModel),[])
  assert.equal(await f.vm.saveDraft(),true,f.vm.status)
  assert.equal(f.saved.length,1)
  assert.equal(f.saved[0].widgets.find(w=>w.id==='first').content.value,1)
  assert.equal(f.saved[0].widgets.find(w=>w.id==='same').content.value,2)
  assert.equal(f.requests(),0)
})

test('group dragging/resizing uses both duplicate instance frames instead of overwriting a shared ID, and click suppression only matches the same instance',async t=>{
  const document=normalizeDashboardDocument({canvas:{width:1200,height:800,gridSize:1},widgets:[
    {id:'same',type:'value',groupId:'g',frame:{x:100,y:150,width:100,height:60}},
    {id:'same',type:'value',groupId:'g',frame:{x:400,y:350,width:100,height:60}}]})
  const f=await mount(t,document),[first,second]=f.vm.documentModel.widgets
  const event={button:0,pointerId:5,clientX:100,clientY:100,preventDefault(){},stopPropagation(){}}
  f.vm.beginMove(event,first)
  assert.equal(f.vm.pointerFrameKeys().length,2)
  assert.equal(new Set(f.vm.pointerFrameKeys()).size,2)
  assert.ok(f.vm.pointerFrameKeys().every(key=>key.startsWith('designer-instance:')))
  f.vm.handlePointerMove({...event,clientX:150,clientY:130})
  assert.equal(second.frame.x-first.frame.x,300)
  assert.equal(second.frame.y-first.frame.y,200)
  assert.equal(first.frame.x,150);assert.equal(second.frame.x,450)
  f.vm.endPointerOperation()
  await f.click(1,true)
  assert.equal(f.vm.selectedWidget,second,'pointer state from the first same-ID object must not suppress clicking the second')
  f.vm.beginResize(event,second,'e')
  assert.deepEqual(f.vm.pointerFrameKeys(),[f.vm.widgetInstanceKey(second)])
  f.vm.handlePointerMove({...event,clientX:125})
  assert.equal(first.frame.width,100);assert.equal(second.frame.width,125)
  f.vm.endPointerOperation()
  assert.equal(f.requests(),0)
})

test('real grouped duplicate click → Workflow native format → explicit unique ID → isolated normal storage/reopen → actual scheduler/cache/renderer stay independent',async t=>{
  const binding=(deviceId,datasetId)=>({mode:'dataset',bindingVersion:2,deviceScope:'fixed',deviceId,datasetId,datasetField:'value',readOnly:true,
    deviceBindings:[{deviceId,binding:{mode:'dataset',deviceScope:'fixed',deviceId,datasetId,datasetField:'value',unit:'原单位'}}]})
  const document=normalizeDashboardDocument({widgets:[{id:'same',type:'value',groupId:'g',content:{label:'第一项'},data:binding('A','table_A')},
    {id:'same',type:'value',groupId:'g',content:{label:'第二项'},data:binding('B','table_B')}]})
  const f=await mount(t,document)
  for(const [index,deviceId,id,unit] of [[0,'A','first','unit_A'],[1,'B','second','unit_B']]){
    await f.click(index);assert.equal(f.vm.selectedUsesBindingWorkflow,true);f.vm.inspectorTab='data';await settled()
    const format=f.field(`设备 ${deviceId} 主数据单位`);format.fire('input',unit);format.fire('change',unit);await settled()
    assert.equal(f.vm.documentModel.widgets[index].data.deviceBindings[0].binding.unit,unit)
    f.vm.inspectorTab='content';await settled();const idField=f.field('组件标识');idField.fire('input',id);idField.fire('change',id);await settled()
    assert.equal(f.vm.selectedWidget,f.vm.documentModel.widgets[index])
  }
  assert.equal(await f.vm.saveDraft(),true,f.vm.status)
  const reopened=normalizeDashboardDocument(clone(f.saved[0])),widgets=reopened.widgets.filter(w=>['first','second'].includes(w.id)),cache={},reads=[]
  const scheduler=createWidgetReadScheduler({widgets:()=>widgets,context:()=>({deviceId:'A'}),parameters:()=>({}),devices:()=>[{id:'A'},{id:'B'}],
    remove:id=>delete cache[id],put:(id,value)=>cache[id]=value,read:async(ids)=>{reads.push(ids);return {values:Object.fromEntries(ids.map(id=>{const w=widgets.find(w=>w.id===id);return [id,{value:id==='first'?38:84,quality:'good',deviceId:w.data.deviceId,rows:[],series:[]}]}))}}})
  t.after(()=>scheduler.dispose());await scheduler.refresh(true,1000)
  assert.equal(cache.first.value,38);assert.equal(cache.second.value,84);assert.equal(Object.keys(cache).length,2)
  assert.equal(f.vm.findWidget('first').data.deviceBindings[0].binding.datasetId,'table_A')
  assert.equal(f.vm.findWidget('second').data.deviceBindings[0].binding.datasetId,'table_B')
  const runtimeRoot={...f.root,type:'runtime-root',children:[],parent:null}
  f.renderer.render(h('section',widgets.map(w=>h(renderer.component,{key:w.id,widget:w,databaseValues:cache,preview:true,dataReady:true,runtimeContext:{deviceId:'A'},deviceCatalog:[{id:'A',name:'A设备'},{id:'B',name:'B设备'}]}))),runtimeRoot)
  await settled();const rendered=f.text(runtimeRoot)
  assert.match(rendered,/38/);assert.match(rendered,/84/);assert.match(rendered,/unit_A/);assert.match(rendered,/unit_B/)
  f.renderer.render(null,runtimeRoot)
  assert.equal(f.requests(),0);assert.ok(reads.flat().includes('first') && reads.flat().includes('second'))
})
