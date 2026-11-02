import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, reactive, ref } from 'vue'
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
async function fixture(t,preview){
  const environment=installBrowser(t),events=[]
  t.mock.method(adminApi,'getDataSets',async()=>({datasets:[{id:'erp',name:'ERP',columns:[{name:'temperature',unit:'°C',role:'value'},{name:'pressure',unit:'MPa'}]}]}))
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
