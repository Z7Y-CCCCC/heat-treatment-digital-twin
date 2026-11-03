import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, createRenderer, h, reactive, ref, nextTick } from 'vue'
import { normalizeParameterDefinitions, resolveParameters, datasetParameterDefinitions } from '../../shared/dashboardParameters.mjs'
import { createSoftwareInterface, installSoftwareInterface, useDashboardIntegration } from '../src/runtime/dashboardIntegration.js'
import { createDashboardWidget, normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { exportDashboardTemplate, importDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { installBrowser, deferred, settle } from './helpers.mjs'

const definitions=[{key:'batch',label:'批次',type:'string',defaultValue:'A'},{key:'minimum',type:'number',defaultValue:0},{key:'enabled',type:'boolean',defaultValue:false},{key:'day',type:'date',defaultValue:'2026-11-03'}]
test('typed parameters preserve zero/false and reject unknown keys, invalid dates, nonfinite numbers and credential-like keys',()=>{
 assert.deepEqual(resolveParameters(definitions,{minimum:'0',enabled:'false'}),{batch:'A',minimum:0,enabled:false,day:'2026-11-03'})
 for(const patch of [{unknown:1},{minimum:'bad'},{minimum:Infinity},{enabled:'yes'},{day:'2026-02-30'},{batch:{}}])assert.throws(()=>resolveParameters(definitions,patch))
 for(const key of ['__proto__','constructor','auth_token','password','bad key'])assert.throws(()=>normalizeParameterDefinitions([{key}]))
 assert.throws(()=>normalizeParameterDefinitions([{key:'a'},{key:'a'}]),/重复/)
 assert.throws(()=>normalizeParameterDefinitions(Array(33).fill({key:'x'})),/32/)
})
test('definitions, filter options and parameter actions survive normalize, export and cross-project import',()=>{
 const widget=createDashboardWidget('filter',0);widget.content.parameterKey='batch';widget.content.options=[{label:'批次A',value:'A'},{label:'批次B',value:'B'}];widget.events=[{trigger:'change',action:'set_parameter',parameterKey:'minimum',value:0}]
 const doc=normalizeDashboardDocument({projectId:'p',sceneId:'s',parameters:definitions,widgets:[widget]})
 const result=importDashboardTemplate(exportDashboardTemplate(doc),{projectId:'new_p',sceneId:'new_s'})
 assert.equal(result.sceneId,'new_s');assert.deepEqual(result.parameters,doc.parameters);assert.deepEqual(result.widgets[0].content,widget.content);assert.equal(result.widgets[0].events[0].value,0)
 const used=datasetParameterDefinitions({request:{parameters:[{source:'parameter',key:'batch'}]},match:{contextKey:'parameter',parameterKey:'minimum'}})
 assert.deepEqual(used.map(p=>p.key),['batch','minimum'])
})
function controller(overrides={}) {
 let authorized=true,ready=true,context={factoryId:'a'},params={batch:'A'}
 const hooks={authorize:()=>authorized,isReady:()=>ready,getContext:()=>context,getParameters:()=>params,setParameters:patch=>params={...params,...patch},resetParameters:()=>params={batch:'A'},refreshData:()=>true,switchView:id=>({id}),focusDevice:id=>({id}),setVisible:()=>true,...overrides}
 return {...createSoftwareInterface(hooks),deny(){authorized=false},notReady(){ready=false},ready(){ready=true}}
}
test('software API snapshots and events cannot mutate runtime state, and listener disposal is explicit',async()=>{
 const c=controller();const context=await c.api.getContext();context.factoryId='changed';assert.equal((await c.api.getContext()).factoryId,'a')
 let n=0;const off=c.api.on('parametersChanged',payload=>{n++;payload.batch='mutated'});const original={batch:'B'};c.emit('parametersChanged',original);assert.equal(original.batch,'B');off();c.emit('parametersChanged',{});assert.equal(n,1)
 assert.throws(()=>c.api.on('arbitrary',()=>{}));assert.equal(c.api.writePlc,undefined)
 c.deny();await assert.rejects(c.api.setParameters({}),/权限/);c.dispose();await assert.rejects(c.api.getContext(),/关闭/)
})
test('ready waits for document readiness; a pending action rejects after disposal',async()=>{
 const c=controller();c.notReady();let resolved=false;const p=c.api.ready().then(()=>{resolved=true});await settle();assert.equal(resolved,false);c.ready();await p
 const work=deferred(),d=controller({refreshData:()=>work.promise});const pending=d.api.refreshData();d.dispose();work.resolve(true);await assert.rejects(pending,/关闭/)
})
test('overlapping surface SDK installs do not resurrect an already disposed surface or overwrite another owner',()=>{
 const target={DigitalTwin:'original'},a={},b={};const offA=installSoftwareInterface(target,a),offB=installSoftwareInterface(target,b);offA();assert.equal(target.DigitalTwin,b);offB();assert.equal(target.DigitalTwin,'original')
 const off=installSoftwareInterface(target,a);target.DigitalTwin='external';off();assert.equal(target.DigitalTwin,'external')
})
async function fixture(t) {
 const browser=installBrowser(t),scope=ref('factoryA:scene:accountA'),doc=ref(normalizeDashboardDocument({parameters:definitions})),context=reactive({factoryId:'factoryA',viewId:'factory_overview'}),refreshes=[];let integration
 const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
 const app=renderer.createApp({setup(){integration=useDashboardIntegration({document:doc,scope,context,install:false,authorize:()=>true,devices:ref([{id:'deviceA'}]),refresh:()=>{refreshes.push({...integration.parameters.value})},action:event=>event});return()=>null}});app.mount({});browser.beforeRestore(()=>app.unmount());await nextTick()
 return {integration,scope,doc,context,refreshes,app}
}
test('parameter changes are atomic, reject undeclared keys, refresh on change only, and reset on factory/account scope changes',async t=>{
 const f=await fixture(t);await f.integration.api.setParameters({batch:'B',minimum:0,enabled:false});await nextTick();assert.equal(f.refreshes.at(-1).batch,'B');const count=f.refreshes.length
 await f.integration.api.setParameters({batch:'B'});await nextTick();assert.equal(f.refreshes.length,count)
 await assert.rejects(f.integration.api.setParameters({minimum:Infinity}));await assert.rejects(f.integration.api.setParameters({batch:'C',unknown:'x'}));assert.equal(f.integration.parameters.value.batch,'B')
 f.context.viewId='line_overview';await nextTick();assert.equal(f.integration.parameters.value.batch,'B')
 f.scope.value='factoryB:scene:accountA';await nextTick();assert.equal(f.integration.parameters.value.batch,'A')
 await f.integration.api.setParameters({batch:'B'});f.scope.value='factoryB:scene:accountB';await nextTick();assert.equal(f.integration.parameters.value.batch,'A')
})
test('SDK validates scene/device/widget targets and filters route through the same parameter store',async t=>{
 const f=await fixture(t);assert.equal(f.integration.handle({action:'set_parameter',parameterKey:'batch',value:'B'}),true);assert.equal(f.integration.parameters.value.batch,'B')
 assert.equal(f.integration.handle({action:'write_plc'}),false)
 await assert.rejects(f.integration.api.focusDevice('foreign'),/当前工厂/);await assert.rejects(f.integration.api.switchView('missing'),/不存在/);await assert.rejects(f.integration.api.setVisible('missing',false),/有效组件/)
 const action=await f.integration.api.focusDevice('deviceA');assert.equal(action.event.deviceId,'deviceA')
 f.app.unmount();await assert.rejects(f.integration.api.setParameters({batch:'C'}),/关闭/)
})


test('pointer hover changes do not flood context callbacks, while device/view selection emits distinct callbacks',async t=>{
 const f=await fixture(t),events=[];f.integration.api.on('contextChanged',value=>events.push(['context',value]));f.integration.api.on('deviceSelected',value=>events.push(['device',value]));f.integration.api.on('viewChanged',value=>events.push(['view',value]));
 f.context.hoveredDeviceId='hoverA';f.context.deviceHoverPointer={x:1,y:3};await nextTick();assert.equal(events.length,0);
 f.context.deviceId='deviceA';f.context.viewId='device_detail';await nextTick();assert.deepEqual(events.map(e=>e[0]),['context','view','device']);
})


test('ready listeners receive one current snapshot and throwing async integration callbacks do not break the runtime',async()=>{
 const c=controller(),ready=[];const off=c.api.on('ready',ctx=>ready.push(ctx));await settle();assert.equal(ready.length,1);off();
 const values=[];c.api.on('parametersChanged',async()=>{throw new Error('integration callback failed')});c.api.on('parametersChanged',payload=>values.push(payload));c.emit('parametersChanged',{batch:'B'});await settle();assert.equal(values.length,1);c.dispose();
})
