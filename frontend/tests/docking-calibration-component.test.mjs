import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { installBrowser, settle, deferred } from './helpers.mjs'
const url=new URL('../src/views/admin/components/DockingCalibration.vue',import.meta.url),source=await readFile(url,'utf8')
const {descriptor}=parse(source.replace(/import \{ DockingCalibrationPreview \} from [^\n]+/,'const DockingCalibrationPreview = globalThis.__dockingPreview'))
const script=compileScript(descriptor,{id:'dock-test'});assert.deepEqual(compileTemplate({source:descriptor.template.content,id:'dock-test',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])
let code=script.content;for(const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)])code=code.replace(match[0],`from ${JSON.stringify(match[2].startsWith('.')?new URL(match[2],url).href:import.meta.resolve(match[2]))}`)
const {default:Component}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);Component.render=()=>null
async function fixture(t,options={}){
 const env=installBrowser(t),previous={authenticated:adminSession.authenticated,pagePermissions:adminSession.pagePermissions};Object.assign(adminSession,{authenticated:true,pagePermissions:normalizePagePermissions({models:{view:true},lines:{view:true,edit:options.edit!==false}})});t.after(()=>Object.assign(adminSession,previous))
 const line={id:'line',workshop_id:'ws',layout_json:JSON.stringify({version:1,lanes:[{id:'lane',offsetZ:-4,length:60}],rails:[{id:'rail',offsetZ:0,length:60}]})}
 const device={id:'target',name:'工位',model_type:'m',line_id:'line',coordinate_space:'line_local',pos_x:10,pos_y:0,pos_z:-4,rotation_y:0,scale:1,instance_config:{laneId:'lane'}}
 const cart={...device,id:'cart',pos_x:0,pos_z:0,instance_config:{railId:'rail',role:'auxiliary'}}
 const model={id:'m',file_path:'/model.glb',default_scale:1,metadata:{loadingPorts:{version:1,inlet:{position:[0,1,1],direction:[0,0,1],nodeName:''},outlet:{position:[0,1,-1],direction:[0,0,-1],nodeName:''}}}}
 const calls={loads:[],saves:[],events:[],previews:[],confirm:[]}
 t.mock.method(adminApi,'getDeviceLoadingPorts',async id=>{calls.loads.push(id);if(options.load)return options.load(id);return {success:true,device:structuredClone(id==='target'?device:cart),model:structuredClone(model),revision:(id==='target'?'a':'b').repeat(64)}})
 t.mock.method(adminApi,'saveDockingCalibration',async body=>{calls.saves.push(structuredClone(body));if(options.save)return options.save(body);return {success:true,devices:[{...device,pos_x:body.position.x,pos_y:body.position.y}]}})
 class Preview{constructor(container,options){this.options=options;calls.previews.push(this)}async load(plan){this.plan=plan}setPosition(value){this.position=value}setView(value){this.view=value}dispose(){this.disposed=true}pause(){this.paused=true}resume(){this.paused=false;this.resumed=true}}
 env.replace('__dockingPreview',Preview)
 const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}}),root={},props={model,models:[model],devices:[device,cart],lines:[reactive(line)],inline:options.inline===true,autoPreview:options.autoPreview===true,active:options.active!==false,confirm:async text=>{calls.confirm.push(text);return options.confirm?options.confirm(text):true},canCalibrate:options.canCalibrate||(()=>true),onCalibrated:r=>{calls.events.push(r);options.onCalibrated?.(r)}}
 let vnode;const render=async(next={})=>{Object.assign(props,next);vnode=h(Component,{...props});renderer.render(vnode,root);await nextTick();await settle()};await render();env.beforeRestore(()=>renderer.render(null,root))
 const f={get vm(){return vnode.component.setupState},props,calls,render};f.vm.viewport={};return f
}
test('preview loads both real context results; moving is draft-only until one explicitly confirmed save',async t=>{const f=await fixture(t);assert.equal(await f.vm.load(),true);assert.deepEqual(f.calls.loads,['target','cart']);f.vm.move('x',1);f.vm.move('y',1);assert.equal(f.calls.saves.length,0);assert.equal(f.vm.dirty,true);assert.equal(await f.vm.save(),true);assert.equal(f.calls.saves.length,1);assert.equal(f.calls.events.length,1);assert.equal(f.vm.busy,false);assert.equal(f.vm.dirty,false);assert.equal(f.vm.plan,null)})
test('undo returns saved entity location without writes; cancellation keeps current draft and selection',async t=>{const f=await fixture(t,{confirm:()=>false});await f.vm.load();f.vm.move('y',1);const dirty=f.vm.position.y;assert.equal(await f.vm.canLeave(),false);assert.equal(f.vm.position.y,dirty);const event={target:{value:'outlet'}};await f.vm.choose('deviceKind',event);assert.equal(f.vm.deviceKind,'inlet');assert.equal(event.target.value,'inlet');f.vm.discardPending();assert.equal(f.vm.dirty,false);assert.equal(f.calls.saves.length,0)})
test('permissionless viewers can inspect but cannot nudge/save',async t=>{const f=await fixture(t,{edit:false});await f.vm.load();f.vm.move('y',1);assert.equal(f.vm.dirty,false);assert.equal(await f.vm.save(),false);assert.equal(f.calls.saves.length,0)})
test('409 leaves the physical draft intact, shows conflict and never emits saved state',async t=>{const f=await fixture(t,{save:()=>({success:false,status:409,error:'来源已更新'})});await f.vm.load();f.vm.move('y',1);const p={...f.vm.position};assert.equal(await f.vm.save(),false);assert.deepEqual(f.vm.position,p);assert.equal(f.vm.conflict,true);assert.equal(f.calls.events.length,0);assert.equal(await f.vm.save(),false);assert.equal(f.calls.saves.length,1)})
test('unconfirmed successful write/readback locks the old revision instead of allowing repeated edits',async t=>{const f=await fixture(t,{save:()=>({success:true,devices:[{id:'target',pos_x:20,pos_y:30}]})});await f.vm.load();f.vm.move('y',1);assert.equal(await f.vm.save(),false);assert.equal(f.vm.conflict,true);assert.match(f.vm.error,/可能已提交/);const p={...f.vm.position};f.vm.move('y',1);assert.deepEqual(f.vm.position,p);assert.equal(f.calls.events.length,0)})
test('late preview after source change is ignored and old render resources released',async t=>{const delay=deferred();const f=await fixture(t,{load:id=>delay.promise});const loading=f.vm.load();await settle();await f.render({lines:[{...f.props.lines[0],layout_json:JSON.stringify({...JSON.parse(f.props.lines[0].layout_json),flowDirection:'left'})}]});delay.resolve({success:true,device:f.props.devices[0],model:f.props.model,revision:'a'.repeat(64)});assert.equal(await loading,false);assert.equal(f.vm.plan,null);assert.equal(f.vm.loading,false);assert.equal(f.calls.previews.length,0)})
test('preflight after async layout guard rechecks source and cannot send stale save',async t=>{let count=0;const delay=deferred();const f=await fixture(t,{canCalibrate:()=>++count===1?true:delay.promise});await f.vm.load();f.vm.move('y',1);const saving=f.vm.save();await settle();await f.render({lines:[{...f.props.lines[0],layout_json:JSON.stringify({...JSON.parse(f.props.lines[0].layout_json),flowDirection:'left'})}]});delay.resolve(true);assert.equal(await saving,false);assert.equal(f.calls.saves.length,0);assert.equal(f.vm.conflict,true)})
test('pending save confirmation is busy and does not open a second confirmation/write',async t=>{const delay=deferred();const f=await fixture(t,{confirm:()=>delay.promise});await f.vm.load();f.vm.move('y',1);const first=f.vm.save();await settle();assert.equal(f.vm.busy,true);assert.equal(await f.vm.save(),false);assert.equal(f.calls.confirm.length,1);delay.resolve(true);assert.equal(await first,true);assert.equal(f.calls.saves.length,1)})
test('source updates preserve unsaved position but invalidate preview until explicit reload',async t=>{const f=await fixture(t);await f.vm.load();f.vm.move('y',1);const p={...f.vm.position};await f.render({devices:f.props.devices.map(d=>d.id==='target'?{...d,pos_x:12}:d)});assert.equal(f.vm.conflict,true);assert.deepEqual(f.vm.position,p);assert.equal(f.vm.previewReady,false);assert.equal(await f.vm.save(),false)})
test('runtime connection/status fields and unrelated names cannot invalidate an authoring preview',async t=>{const f=await fixture(t);await f.vm.load();await f.render({devices:f.props.devices.map(d=>({...d,status:'online',value:42})),lines:[{...f.props.lines[0],name:'display rename'}]});assert.equal(f.vm.conflict,false);assert.equal(f.vm.previewReady,true)})

test('ordinary and inline mounting without explicit auto-preview never reads or writes device configuration',async t=>{const f=await fixture(t,{inline:true});assert.deepEqual(f.calls.loads,[]);assert.deepEqual(f.calls.saves,[]);assert.equal(f.vm.plan,null);assert.equal(f.vm.dirty,false)})
test('only the inline canvas enables camera rotation and standard-view buttons cannot change entity placement',async t=>{const f=await fixture(t,{inline:true});await f.vm.load();assert.deepEqual(f.calls.previews[0].options,{allowRotate:true});const position={...f.vm.position};f.vm.setView('top');assert.equal(f.calls.previews[0].view,'top');f.vm.setView('front');assert.equal(f.calls.previews[0].view,'front');assert.deepEqual(f.vm.position,position);assert.equal(f.vm.dirty,false);assert.deepEqual(f.calls.saves,[])})
test('standalone preview keeps its previous locked front/top inspection',async t=>{const f=await fixture(t);await f.vm.load();assert.deepEqual(f.calls.previews[0].options,{allowRotate:false})})
test('active inline auto-preview reads both entities on first opening without saving or creating a position draft',async t=>{const f=await fixture(t,{inline:true,autoPreview:true,active:false});assert.deepEqual(f.calls.loads,[]);assert.equal(await f.vm.load(),false);await f.render({active:true});await settle();assert.deepEqual(f.calls.loads,['target','cart']);assert.equal(f.vm.previewReady,true);assert.equal(f.vm.dirty,false);assert.deepEqual(f.calls.saves,[]);assert.equal(f.calls.previews.length,1)})
test('auto-preview also starts on mounted visible canvas and does not wait for a second display button',async t=>{const f=await fixture(t,{inline:true,autoPreview:true});await settle();assert.deepEqual(f.calls.loads,['target','cart']);assert.ok(f.vm.plan);assert.equal(f.vm.dirty,false);assert.deepEqual(f.calls.saves,[])})
test('explicit port choices reload sources and reject both same-facing and back-to-back mouths before restoring a valid pair',async t=>{const f=await fixture(t,{inline:true,autoPreview:true,active:false});await f.render({active:true});await f.vm.choose('cartKind',{target:{value:'inlet'}});assert.equal(f.vm.cartKind,'inlet');assert.deepEqual(f.calls.loads,['target','cart','target','cart']);assert.match(f.vm.error,/没有相向/);await f.vm.choose('deviceKind',{target:{value:'outlet'}});assert.equal(f.vm.deviceKind,'outlet');assert.deepEqual(f.calls.loads,['target','cart','target','cart','target','cart']);assert.equal(f.vm.previewReady,false);assert.match(f.vm.error,/各自外侧/);await f.vm.choose('cartKind',{target:{value:'outlet'}});await f.vm.choose('deviceKind',{target:{value:'inlet'}});assert.equal(f.vm.previewReady,true);assert.equal(f.calls.loads.length,10);assert.equal(f.vm.dirty,false);assert.deepEqual(f.calls.saves,[])})
test('hiding and restoring the same inline surface pauses its renderer but never rereads or discards its existing draft',async t=>{const f=await fixture(t,{inline:true,autoPreview:true,active:false});await f.render({active:true});f.vm.move('y',1);const p={...f.vm.position},preview=f.calls.previews[0];await f.render({active:false});assert.equal(preview.paused,true);assert.deepEqual(f.vm.position,p);assert.equal(f.vm.dirty,true);assert.equal(preview.disposed,undefined);assert.equal(await f.vm.load(),false);await f.render({active:true});assert.equal(preview.resumed,true);assert.equal(preview.paused,false);assert.deepEqual(f.calls.loads,['target','cart']);assert.deepEqual(f.vm.position,p);assert.deepEqual(f.calls.saves,[])})
test('hidden retained calibration still participates in the parent unsaved-leave guard',async t=>{const f=await fixture(t,{inline:true,autoPreview:true,active:false});await f.render({active:true});f.vm.move('y',1);await f.render({active:false});assert.equal(await f.vm.canLeave(),true);assert.equal(f.vm.dirty,false);assert.deepEqual(f.calls.saves,[]);assert.equal(f.calls.confirm.length,1)})
test('hiding an in-flight initial auto-preview aborts it and ignores late results without mounting a hidden renderer',async t=>{const delay=deferred();const f=await fixture(t,{inline:true,autoPreview:true,load:()=>delay.promise});assert.equal(f.vm.busy,true);await f.render({active:false});assert.equal(f.vm.loading,false);delay.resolve({success:true,device:f.props.devices[0],model:f.props.model,revision:'a'.repeat(64)});await settle();assert.equal(f.vm.plan,null);assert.equal(f.calls.previews.length,0);assert.deepEqual(f.calls.saves,[])})
test('auto-preview preflight exceptions show an error and never escape as background reads or writes',async t=>{const f=await fixture(t,{inline:true,autoPreview:true,canCalibrate:()=>{throw Error('产线检查暂不可用')}});await settle();assert.match(f.vm.error,/对接预览检查失败：产线检查暂不可用/);assert.equal(f.vm.busy,false);assert.equal(f.vm.plan,null);assert.deepEqual(f.calls.loads,[]);assert.deepEqual(f.calls.saves,[])})
test('known-clean inline sources refresh once while visible and defer a hidden refresh until the same canvas is reopened',async t=>{
 const f=await fixture(t,{inline:true,autoPreview:true,active:false});await f.render({active:true});const devices=structuredClone(f.props.devices),first=f.calls.previews[0]
 const line=units=>({...f.props.lines[0],layout_json:JSON.stringify({...JSON.parse(f.props.lines[0].layout_json),sceneUnitsPerMeter:units})})
 await f.render({lines:[line(2)]});await settle();assert.equal(first.disposed,true);assert.equal(f.vm.previewReady,true);assert.equal(f.vm.plan.unitsPerMeter,2);assert.equal(f.vm.dirty,false);assert.equal(f.vm.conflict,false);assert.equal(f.vm.autoRefreshPending,false);assert.deepEqual(f.calls.loads,['target','cart','target','cart'])
 await f.render({active:false});await f.render({lines:[line(3)]});assert.equal(f.vm.previewReady,false);assert.equal(f.vm.autoRefreshPending,true);assert.equal(f.calls.loads.length,4)
 await f.render({active:true});await settle();assert.equal(f.vm.previewReady,true);assert.equal(f.vm.plan.unitsPerMeter,3);assert.equal(f.vm.conflict,false);assert.equal(f.calls.loads.length,6);assert.equal(f.vm.dirty,false);assert.deepEqual(f.props.devices,devices);assert.deepEqual(f.calls.saves,[])
})
test('confirmed inline save refreshes from the parent updated source once without sending another write',async t=>{
 let f,saved
 f=await fixture(t,{inline:true,autoPreview:true,active:false,load:id=>({success:true,device:structuredClone(id==='target'?(saved||f.props.devices[0]):f.props.devices[1]),model:structuredClone(f.props.model),revision:(saved&&id==='target'?'c':id==='target'?'a':'b').repeat(64)}),save:body=>{saved={...f.props.devices[0],pos_x:body.position.x,pos_y:body.position.y};return {success:true,devices:[saved]}},onCalibrated:r=>{void f.render({devices:f.props.devices.map(d=>d.id===r.devices[0].id?r.devices[0]:d)})}})
 await f.render({active:true});f.vm.move('y',1);const expected=f.vm.position.y;assert.equal(await f.vm.save(),true);await settle();await nextTick();await settle()
 assert.equal(f.calls.saves.length,1);assert.equal(f.calls.events.length,1);assert.equal(f.calls.loads.length,4);assert.equal(f.vm.previewReady,true);assert.equal(f.vm.plan.deviceResult.device.pos_y,expected);assert.equal(f.vm.position.y,expected);assert.equal(f.vm.dirty,false);assert.equal(f.vm.conflict,false);assert.equal(f.vm.autoRefreshPending,false)
 await settle();assert.equal(f.calls.loads.length,4);assert.equal(f.calls.saves.length,1)
})
test('a later clean source invalidates one in-flight auto read, then read failure consumes its refresh instead of polling forever',async t=>{
 const delay=deferred();let f,stage=0
 const result=id=>({success:true,device:structuredClone(f.props.devices.find(d=>d.id===id)),model:structuredClone(f.props.model),revision:(id==='target'?'a':'b').repeat(64)})
 f=await fixture(t,{inline:true,autoPreview:true,active:false,load:id=>stage===0?delay.promise.then(()=>result(id)):stage===1?result(id):{success:false,error:'读取暂不可用'}})
 const line=units=>({...f.props.lines[0],layout_json:JSON.stringify({...JSON.parse(f.props.lines[0].layout_json),sceneUnitsPerMeter:units})})
 await f.render({active:true});assert.equal(f.vm.loading,true);stage=1;await f.render({lines:[line(2)]});assert.equal(f.vm.autoRefreshPending,true);assert.equal(f.calls.loads.length,2)
 delay.resolve();await settle();await nextTick();await settle();assert.equal(f.calls.loads.length,4);assert.equal(f.vm.plan.unitsPerMeter,2);assert.equal(f.vm.previewReady,true);assert.equal(f.calls.previews.length,1)
 stage=2;await f.render({lines:[line(3)]});await settle();assert.equal(f.calls.loads.length,6);assert.equal(f.vm.autoRefreshPending,false);assert.equal(f.vm.plan,null);assert.equal(f.vm.previewReady,false);assert.match(f.vm.error,/读取暂不可用/)
 for(let i=0;i<3;i++)await settle();assert.equal(f.calls.loads.length,6);assert.deepEqual(f.calls.saves,[])
})
test('dirty, 409 and unconfirmed-write locks never become auto-refreshable merely because undo makes their position clean',async t=>{
 for(const mode of ['dirty','409','unconfirmed'])await t.test(mode,async sub=>{
  const options={inline:true,autoPreview:true,active:false};if(mode==='409')options.save=()=>({success:false,status:409,error:'来源已更新'});if(mode==='unconfirmed')options.save=()=>({success:true,devices:[{id:'target',pos_x:20,pos_y:30}]})
  const f=await fixture(sub,options);await f.render({active:true});f.vm.move('y',1);const draft={...f.vm.position}
  if(mode!=='dirty'){assert.equal(await f.vm.save(),false);assert.equal(f.vm.conflict,true);assert.deepEqual(f.vm.position,draft);f.vm.discardPending();assert.equal(f.vm.dirty,false)}
  await f.render({lines:[{...f.props.lines[0],layout_json:JSON.stringify({...JSON.parse(f.props.lines[0].layout_json),sceneUnitsPerMeter:2})}]});assert.equal(f.vm.conflict,true);assert.equal(f.vm.autoRefreshPending,false);assert.equal(f.calls.loads.length,2)
  if(mode==='dirty'){assert.deepEqual(f.vm.position,draft);assert.equal(f.vm.dirty,true);f.vm.discardPending()}
  await f.render({active:false});await f.render({active:true});await settle();assert.equal(f.calls.loads.length,2);assert.equal(f.vm.conflict,true);assert.equal(f.vm.previewReady,false);assert.equal(await f.vm.save(),false);assert.equal(f.calls.saves.length,mode==='dirty'?0:1)
 })
})
test('inline layout reuses one preview and moves calibration controls below rather than narrowing another nested canvas',()=>{assert.match(source,/:class="\{ 'is-inline': inline \}"/);assert.match(source,/header v-if="!inline"/);assert.equal((source.match(/ref="viewport"/g)||[]).length,1);assert.match(source,/\.is-inline \.calibration-body\{display:flex;flex-direction:column\}/);assert.match(source,/\.is-inline \.calibration-view\{order:0\}/);assert.match(source,/\.is-inline \.calibration-adjustments\{order:1;/)})


test('workbench docking preview uses draft placement but can never adjust or save source entities', async t => {
 const f=await fixture(t),devices=f.props.devices.map(d=>({...d,pos_y:Number(d.pos_y||0)+.25}))
 await f.render({previewOnly:true,devices});assert.equal(await f.vm.load(),true)
 assert.equal(f.vm.editable,false);assert.equal(f.vm.plan.deviceResult.device.pos_y,devices[0].pos_y)
 const position={...f.vm.position};f.vm.move('x',1);f.vm.move('y',1);assert.deepEqual(f.vm.position,position)
 f.vm.position.y+=.5;assert.equal(await f.vm.save(),false);assert.deepEqual(f.calls.saves,[])
})

test('workbench inspection renders wrong-facing configured mouths with a top-view diagnostic instead of a blank error screen',async t=>{
 const f=await fixture(t),before=structuredClone(f.props.devices)
 await f.render({previewOnly:true});f.vm.cartKind='inlet'
 assert.equal(await f.vm.load(),true)
 assert.equal(f.vm.error,'');assert.equal(f.vm.previewReady,true);assert.equal(f.vm.view,'top')
 assert.equal(f.vm.plan.issues[0].code,'PORTS_NOT_FACING')
 assert.equal(f.vm.plan.orientation.deviceTowardCart,true);assert.equal(f.vm.plan.orientation.cartTowardDevice,false)
 assert.equal(f.calls.previews[0].view,'top');assert.equal(f.vm.editable,false)
 assert.deepEqual(f.props.devices,before);assert.deepEqual(f.calls.saves,[])
 const original={...f.vm.position};f.vm.move('x',1);assert.deepEqual(f.vm.position,original)
 assert.equal(await f.vm.save(),false);assert.deepEqual(f.calls.saves,[])
})
