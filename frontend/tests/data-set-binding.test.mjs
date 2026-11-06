import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { createDashboardWidget, normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { dashboardTemplateReferences, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { templateFieldBindings, applyTemplateFieldBindings, validateTemplateFieldBinding } from '../src/runtime/templateFieldMapping.js'
import { installBrowser, deferred, settle } from './helpers.mjs'

test('dataset identity, field and aggregation survive normalization and template reference rebinding', () => {
  const widget=createDashboardWidget('value',0);Object.assign(widget.data,{mode:'dataset',datasetId:'erp_a',datasetField:'temperature',datasetMode:'avg'})
  const document=normalizeDashboardDocument({widgets:[widget]})
  assert.equal(document.widgets[0].data.mode,'dataset');assert.equal(document.widgets[0].data.datasetMode,'avg')
  assert.ok(dashboardTemplateReferences(document).some(r=>r.kind==='datasets'&&r.id==='erp_a'))
  const rebound=rebindDashboardTemplate(document,{'datasets:erp_a':'erp_b'},{datasets:[{id:'erp_b'}]})
  assert.equal(rebound.widgets[0].data.datasetId,'erp_b')
  const bindings=templateFieldBindings(rebound)
  bindings[0].target={...bindings[0].source,datasetField:'new_temperature'};bindings[0].fields=[{name:'new_temperature'}]
  validateTemplateFieldBinding(bindings[0])
  assert.equal(applyTemplateFieldBindings(rebound,bindings).widgets[0].data.datasetField,'new_temperature')
  bindings[0].target.datasetField='missing';assert.throws(()=>validateTemplateFieldBinding(bindings[0]),/字段/)
})

const source=new URL('../src/views/admin/components/DataSetBindingEditor.vue',import.meta.url)
const {descriptor}=parse(await readFile(source,'utf8'))
let code=compileScript(descriptor,{id:'data-set-binding'}).content
for(const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)])code=code.replace(match[0],`from ${JSON.stringify(match[2].startsWith('.')?new URL(match[2],source).href:import.meta.resolve(match[2]))}`)
const {default:Editor}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);Editor.render=()=>null
async function fixture(t,preview,load){
  const environment=installBrowser(t),events=[]
  t.mock.method(adminApi,'getDataSets',load || (async()=>({datasets:[{id:'erp',name:'ERP',columns:[{name:'temperature',unit:'°C',role:'value'},{name:'pressure',unit:'MPa'}]}]})))
  t.mock.method(adminApi,'previewDataSet',preview)
  const props=reactive({binding:{mode:'dataset',datasetId:'erp',datasetField:'temperature',datasetMode:'first',deviceScope:'current'},context:{deviceId:'a'}})
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance=ref(null),app=renderer.createApp({render:()=>h(Editor,{...props,ref:instance,onPreview:value=>events.push(value)})});app.mount({});environment.beforeRestore(()=>app.unmount());await settle()
  return {state:instance.value.$.setupState,props,events,app}
}
test('late A-device response cannot overwrite B-device preview',async t=>{
  const a=deferred(),b=deferred(),f=await fixture(t,input=>input.context.deviceId==='a'?a.promise:b.promise)
  const pa=f.state.preview();f.props.context.deviceId='b';await settle();const pb=f.state.preview()
  b.resolve({result:{value:850,rows:[],quality:'good'}});await pb
  a.resolve({result:{value:700,rows:[],quality:'good'}});await pa
  assert.deepEqual(f.events.map(e=>e.value),[850]);assert.equal(f.state.result.value,850)
})
test('changing the selected field updates units and unmounted previews do not emit',async t=>{
  const pending=deferred(),f=await fixture(t,()=>pending.promise)
  f.props.binding.datasetField='pressure';f.state.changed();assert.equal(f.props.binding.unit,'MPa')
  const work=f.state.preview();f.app.unmount();pending.resolve({result:{value:12,rows:[],quality:'good'}});await work
  assert.deepEqual(f.events,[])
})


test('loading datasets never erases the existing binding and a stale refresh cannot replace the current catalog',async t=>{
 const a=deferred(),b=deferred();let calls=0;const f=await fixture(t,async()=>({}),()=>++calls===1?a.promise:b.promise);
 assert.equal(f.props.binding.datasetId,'erp');assert.equal(f.props.binding.datasetField,'temperature');assert.equal(f.state.loading,true);
 const refresh=f.state.load();b.resolve({datasets:[{id:'erp',name:'Current',columns:[{name:'temperature'}]}]});await refresh;
 a.resolve({datasets:[{id:'stale',name:'Old',columns:[]}]});await settle();assert.equal(f.state.datasets[0].id,'erp');assert.equal(f.state.loading,false);assert.equal(f.props.binding.datasetId,'erp');
})

test('ordinary editing honors clock zero and emits the selected device identity and scoped hierarchy', async t => {
  let input
  const f = await fixture(t, async payload => { input=payload;return {result:{value:700,rows:[],quality:'good'}} })
  f.props.binding.deviceScope = 'rotation'
  f.props.binding.rotationDeviceIds = ['a','b']
  f.props.binding.rotationIntervalMs = 2000
  f.props.context = { viewMode: 'factory', deviceId: '' }
  f.props.devices = [{ id:'a',name:'设备 A',lineId:'line_a',workshopId:'workshop_a' },{ id:'b',name:'设备 B',lineId:'line_b',workshopId:'workshop_b' }]
  f.props.playbackNow = 0
  await nextTick()
  await f.state.preview()
  assert.equal(input.context.deviceId,'a')
  assert.equal(input.context.lineId,'line_a')
  assert.equal(input.context.workshopId,'workshop_a')
  assert.equal(f.events[0].deviceId,'a')
  assert.equal(f.events[0].deviceName,'设备 A')
  assert.equal(f.state.result.deviceId,'a')
})

test('rotation rejects late successful and failed previews after only the effective clock changes', async t => {
  const pending=deferred(),f=await fixture(t,()=>pending.promise)
  Object.assign(f.props.binding,{deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000})
  f.props.context={viewMode:'factory'}
  f.props.devices=[{id:'a',name:'A'},{id:'b',name:'B'}]
  f.props.playbackNow=0
  await nextTick()
  const work=f.state.preview()
  f.props.playbackNow=2000
  await nextTick()
  pending.resolve({result:{value:700,rows:[],quality:'good'}})
  await work
  assert.deepEqual(f.events,[])
  assert.equal(f.state.result,null)
  const failed=deferred()
  t.mock.method(adminApi,'previewDataSet',()=>failed.promise)
  const failure=f.state.preview()
  f.props.playbackNow=4000
  await nextTick()
  failed.reject(new Error('old device failure'))
  await failure
  assert.deepEqual(f.events,[])
  assert.equal(f.state.message,'')
})

test('held effective clock accepts refreshed data and errors with the same device identity', async t => {
  const pending=deferred(),f=await fixture(t,()=>pending.promise)
  Object.assign(f.props.binding,{deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000})
  f.props.context={viewMode:'factory'}
  f.props.devices=[{id:'a',name:'A'},{id:'b',name:'B'}]
  f.props.playbackNow=2500
  await nextTick()
  const work=f.state.preview()
  pending.resolve({result:{value:850,rows:[],quality:'good'}})
  await work
  assert.equal(f.events[0].deviceId,'b')
  assert.equal(f.events[0].deviceName,'B')
  t.mock.method(adminApi,'previewDataSet',async()=>{throw new Error('disconnected')})
  await f.state.preview()
  assert.equal(f.events[1].quality,'bad')
  assert.equal(f.events[1].deviceId,'b')
  assert.equal(f.events[1].deviceName,'B')
  assert.equal(f.state.result.value,null)
})

test('global dataset previews clear focused-device context and emit empty device metadata', async t => {
  let input
  const f=await fixture(t,async payload=>{input=payload;return {result:{value:42,rows:[],quality:'good'}}})
  f.props.binding.deviceScope='global'
  f.props.context={deviceId:'a',lineId:'line_a',workshopId:'workshop_a',regionCode:'120000'}
  await nextTick()
  await f.state.preview()
  assert.equal(input.context.deviceId,'')
  assert.equal(input.context.lineId,'')
  assert.equal(input.context.workshopId,'')
  assert.equal(input.context.regionCode,'120000')
  assert.equal(f.events[0].deviceId,'')
  assert.equal(f.events[0].deviceName,'')
})
