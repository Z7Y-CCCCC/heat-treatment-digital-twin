import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRenderer,h,ref,reactive,nextTick} from 'vue'
import {parse,compileScript,compileTemplate} from 'vue/compiler-sfc'
import {adminApi} from '../src/config/factoryConfig.js'
import {installBrowser,settle} from './helpers.mjs'
async function component(name){const url=new URL(`../src/views/admin/components/${name}.vue`,import.meta.url),source=await readFile(url,'utf8'),descriptor=parse(source).descriptor
 assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:name+'.vue',id:'workflow-ui'}).errors,[])
 let code=compileScript(descriptor,{id:'workflow-ui'}).content
 code=code.replace(/from\s+(['"])([^'"]+)\1/g,(_m,_q,s)=>'from '+JSON.stringify(s.endsWith('.vue')?'data:text/javascript,export default {render:()=>null}':s==='vue'?import.meta.resolve('vue'):new URL(s,url).href))
 const c=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default;c.render=()=>null;return c}
const Editor=await component('WidgetDataBindingEditor'),Picker=await component('DataCatalogPicker')
function mount(t,c,props){const env=installBrowser(t),r=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}}),ins=ref(null),app=r.createApp({render:()=>h(c,{...props,ref:ins})});app.mount({});env.beforeRestore(()=>app.unmount());return ins.value.$.setupState}
const devices=[{id:'a',name:'A炉'},{id:'b',name:'B炉'},{id:'c',name:'C炉'}]
function editor(t){const widget=reactive({id:'x',type:'hud_chart_dock',content:{},data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',pointId:'a1',pointKey:'analog.t',rotationIntervalMs:12000,deviceBindings:[{deviceId:'a',binding:{mode:'plc',deviceId:'a',pointId:'a1',pointKey:'analog.t',unit:'℃'}},{deviceId:'b',binding:{mode:'plc',deviceId:'b',pointId:'b1',pointKey:'analog.t',unit:'℃'}}]}})
 const changes=[];const state=mount(t,Editor,{widget,devices,points:[],factoryId:'factory_default',onChange:value=>{changes.push(value);widget.data=value}});return{state,widget,changes}}
test('changing a row keeps all other sources, order, and timing through mode switches',async t=>{const {state:s,widget}=editor(t)
 s.select(1,{id:'new-b',tableId:'b-table',type:'number',unit:'℃',binding:{mode:'plc',deviceId:'b',pointId:'b-new',pointKey:'other.temp'}});await nextTick()
 assert.equal(widget.data.deviceBindings[0].binding.pointId,'a1');assert.equal(widget.data.deviceBindings[1].binding.pointId,'b-new');assert.equal(widget.data.rotationIntervalMs,12000)
 s.mode('fixed');await nextTick();s.mode('current');await nextTick();s.mode('rotation');await nextTick()
 assert.deepEqual(widget.data.deviceBindings.map(row=>row.deviceId),['a','b']);assert.equal(widget.data.deviceBindings[1].binding.pointId,'b-new')
 s.move(1,-1);await nextTick();assert.deepEqual(widget.data.deviceBindings.map(row=>row.deviceId),['b','a'])
})
for(const scope of ['current','fixed','rotation'])test(`${scope} mode replaces and clears only its explicitly edited device row`,async t=>{
 const {state:s,widget}=editor(t)
 s.mode(scope);await nextTick();if(scope==='fixed'){s.fixedDevice('b');await nextTick()}
 const untouched=JSON.parse(JSON.stringify(widget.data.deviceBindings[0]))
 s.select(1,{id:'b-replacement',tableId:'plc-b',unit:'℃',binding:{mode:'plc',deviceId:'b',pointId:'b-replacement',pointKey:'analog.actual_b'}});await nextTick()
 assert.equal(widget.data.deviceScope,scope);assert.deepEqual(widget.data.deviceBindings[0],untouched)
 assert.equal(widget.data.deviceBindings[1].binding.pointId,'b-replacement');assert.equal(widget.data.rotationIntervalMs,12000)
 assert.deepEqual(widget.data.rotationDeviceIds,['a','b']);if(scope==='fixed')assert.equal(widget.data.deviceId,'b')
 s.select(1,null);await nextTick()
 assert.equal(widget.data.deviceScope,scope);assert.deepEqual(widget.data.deviceBindings[0],untouched);assert.equal(widget.data.deviceBindings[1].binding,null)
 assert.equal(widget.data.rotationIntervalMs,12000);assert.deepEqual(widget.data.rotationDeviceIds,['a','b'])
 s.select(1,{id:'b-restored',tableId:'plc-b',unit:'℃',binding:{mode:'plc',deviceId:'b',pointId:'b-restored',pointKey:'analog.restored_b'}});await nextTick()
 assert.equal(widget.data.deviceBindings[1].binding.pointId,'b-restored');assert.deepEqual(widget.data.deviceBindings[0],untouched)
})
test('adding a device creates an explicit missing row; deleting/reordering never copies another device data',async t=>{const {state:s,widget}=editor(t);s.add();await nextTick();assert.equal(widget.data.deviceBindings[2].deviceId,'c');assert.equal(widget.data.deviceBindings[2].binding,null);assert.match(s.issues.join(' '),/未选择对应数据/);s.remove(1);await nextTick();assert.deepEqual(widget.data.deviceBindings.map(row=>row.deviceId),['a','c']);assert.equal(widget.data.deviceBindings[1].binding,null)})
test('read-only editor handlers cannot mutate the binding',async t=>{const widget=reactive({type:'value',data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',deviceBindings:[]},content:{}});let changes=0;const s=mount(t,Editor,{widget,devices,disabled:true,onChange:()=>changes++,onMetricSelect:()=>changes++});s.mode('fixed');s.add();s.metricSelect(0,'a',null);assert.equal(changes,0);assert.equal(widget.data.deviceScope,'rotation')})
test('temporarily unbinding the main value retains every saved device assignment and timing',async t=>{const {state:s,widget}=editor(t);s.unbind();await nextTick();assert.equal(widget.data.mode,'static');assert.equal(widget.data.deviceBindings.length,2);s.mode('rotation');await nextTick();assert.equal(widget.data.deviceBindings[1].binding.pointId,'b1');assert.equal(widget.data.rotationIntervalMs,12000)})
test('clearing a selected data item leaves its device row explicitly missing without disturbing the carousel',async t=>{
 const {state:s,widget}=editor(t),other=JSON.parse(JSON.stringify(widget.data.deviceBindings[0]))
 s.select(1,null);await nextTick()
 assert.deepEqual(widget.data.deviceBindings[0],other);assert.equal(widget.data.deviceBindings[1].deviceId,'b');assert.equal(widget.data.deviceBindings[1].binding,null)
 assert.equal(widget.data.rotationIntervalMs,12000);assert.deepEqual(widget.data.rotationDeviceIds,['a','b']);assert.match(s.issues.join(' '),/设备 b 未选择对应数据/)
 s.select(1,{id:'replacement',tableId:'b-table',unit:'℃',binding:{mode:'plc',deviceId:'b',pointId:'replacement-b',pointKey:'analog.new'}});await nextTick()
 assert.equal(widget.data.deviceBindings[1].binding.pointId,'replacement-b');assert.deepEqual(widget.data.deviceBindings[0],other)
})
test('panel metric selection restores only the explicitly assigned device and never a stale top-level fallback',async t=>{
 const {state:s}=editor(t),item={binding:{mode:'plc',bindingVersion:2,deviceScope:'current',pointId:'a1',pointKey:'analog.t',deviceBindings:[{deviceId:'a',binding:{mode:'plc',deviceId:'a',pointId:'a1',pointKey:'analog.t'}}]}}
 assert.equal(s.metricBinding(item,'a').pointId,'a1')
 const missing=s.metricBinding(item,'b');assert.equal(missing.deviceId,'b');assert.equal(missing.pointId,'');assert.equal(missing.pointKey,'');assert.equal(missing.requireConfiguredPoint,true)
})
test('all per-device pickers apply one explicit selection and support a readonly-safe clear',async t=>{
 const events=[],widget=reactive({type:'hud_kpi_panel',data:{mode:'plc',bindingVersion:2,deviceScope:'current',deviceBindings:[]},content:{items:[]}})
 const s=mount(t,Editor,{widget,devices,onMetricSelect:event=>events.push(event)})
 s.metricSelect(0,'a',null);assert.deepEqual(events,[{index:0,deviceId:'a',item:null}])
 const source=await readFile(new URL('../src/views/admin/components/WidgetDataBindingEditor.vue',import.meta.url),'utf8')
 assert.equal((source.match(/:device-only="true" :immediate="true"/g) || []).length,2)
})
test('collapsed PLC summaries use the exact owned point address and current reading, never a same-role substitute',async t=>{
 const values=reactive({'a:a1':{id:'a1',device_id:'a',value:0,quality:'good'},decoy:{id:'other-a',device_id:'a',value:999,quality:'good'}})
 const widget=reactive({type:'value',content:{},data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'a1',pointKey:'analog.temp',catalogTableId:'plc-a',unit:'℃'}}]}})
 const points=[{id:'a1',device_id:'a',plc_tag:'DB101.DBD0',label:'实际温度',unit:'℃'},{id:'other-a',device_id:'a',plc_tag:'DB999.DBD0',label:'同名干扰点',unit:'℃'}]
 const s=mount(t,Editor,{widget,devices,points,values})
 s.rememberCatalog({tables:[{id:'plc-a',name:'A炉 · 实时采集'}],items:[]})
 assert.equal(s.sourceDetails(widget.data.deviceBindings[0]),'A炉 · 实时采集 · DB101.DBD0 · 0℃ · 正常')
 values['a:a1']={id:'a1',device_id:'b',value:777,quality:'good'};await nextTick()
 assert.equal(s.sourceDetails(widget.data.deviceBindings[0]),'A炉 · 实时采集 · DB101.DBD0 · — · 尚未读取')
})
test('global panel metric controls require an explicit scope/device and reject a device source for the global main value',async t=>{
 const changes=[],events=[],widget=reactive({type:'hud_kpi_panel',content:{items:[{label:'能耗',binding:{mode:'dataset',datasetId:'factory-energy',datasetField:'value',deviceScope:'global'}}]},data:{mode:'dataset',datasetId:'factory-main',datasetField:'value',deviceScope:'global'}})
 const s=mount(t,Editor,{widget,devices,onChange:value=>changes.push(value),onMetricScope:event=>events.push(event)})
 assert.equal(s.metricScope(widget.content.items[0]),'global');assert.equal(s.globalMetricBinding(widget.content.items[0]).deviceScope,'global')
 s.metricScopeChange(0,'fixed');assert.deepEqual(events,[{index:0,scope:'fixed',deviceId:undefined}])
 s.globalSource({binding:{mode:'plc',deviceScope:'fixed',deviceId:'a',pointId:'a1'}})
 assert.equal(changes.length,0);assert.match(s.notice,/工厂范围主来源/)
 const unresolved={binding:{mode:'plc',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'a1'}}]}}
 assert.equal(s.metricDevice(unresolved),'');assert.equal(s.globalMetricBinding(unresolved).pointId,'')
})

for(const type of ['alarm_list','hud_alarm_panel','marquee'])test(`${type} legacy runtime events project a global editing source without touching the saved binding`,async t=>{
 const widget=reactive({id:'legacy-events',type,content:{},data:{mode:'runtime',path:'events',source:'events',deviceScope:'current',deviceId:'a',rotationDeviceIds:['a','b']}}),changes=[]
 const before=JSON.stringify(widget),s=mount(t,Editor,{widget,devices,points:[],onChange:value=>changes.push(value)})
 assert.equal(s.effective.deviceScope,'global');assert.equal(s.effective.path,'events');assert.equal(s.effective.source,'')
 assert.equal(s.scope,'global');assert.equal(JSON.stringify(widget),before);assert.deepEqual(changes,[])
})

test('event source projection never rewrites external datasets or a different runtime array',async t=>{
 for(const data of [{mode:'dataset',deviceScope:'current',datasetId:'external',datasetField:'message'},
  {mode:'runtime',deviceScope:'fixed',deviceId:'a',path:'events',source:'context.otherEvents'}]){
  const widget=reactive({id:'external-events',type:'marquee',content:{},data}),before=JSON.stringify(widget)
  const s=mount(t,Editor,{widget,devices,points:[]});assert.deepEqual(s.effective,widget.data);assert.equal(JSON.stringify(widget),before)
 }
})
test('catalog fully restores category, table and data without emitting a selection during loading',async t=>{
 const item={id:'point-a',categoryId:'realtime',tableId:'table-a',deviceId:'a',label:'温度',unit:'℃',type:'number',binding:{mode:'plc',pointId:'pa',pointKey:'analog.t',deviceId:'a',deviceScope:'fixed'}}
 t.mock.method(adminApi,'getDataCenterCatalog',async()=>({categories:[{id:'realtime',name:'实时采集'}],tables:[{id:'table-a',name:'A炉采集点位'}],items:[item]}))
 const selections=[],binding=reactive({...item.binding});const s=mount(t,Picker,{binding,deviceId:'a',deviceOnly:true,widgetType:'hud_chart_dock',immediate:true,onSelect:item=>selections.push(item)})
 await settle();await settle();assert.equal(s.categoryId,'realtime');assert.equal(s.tableId,'table-a');assert.equal(s.chosenId,'point-a');assert.equal(selections.length,0)
 s.selectChoice('point-a');assert.equal(selections.length,1);assert.equal(selections[0].binding.pointId,'pa')
})
