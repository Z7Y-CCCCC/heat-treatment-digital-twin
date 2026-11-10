import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
import {createRenderer,h,nextTick,ref} from 'vue'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import {adminApi} from '../src/config/factoryConfig.js'
import {adminSession} from '../src/runtime/adminSession.js'
import {discardFactoryDrafts} from '../src/runtime/factoryDraftCache.js'
import {installBrowser,settle} from './helpers.mjs'

// These are the actual SFC controls and their real parent save handler, rendered
// by Vue in memory. HTTP/SQL are an isolated fixture; no browser is launched.
async function compileSfc(url,children={},transform=source=>source){
 const descriptor=parse(transform(await readFile(url,'utf8'))).descriptor
 const script=compileScript(descriptor,{id:'transfer-memory'})
 let code=script.content.replace(/from\s+(['"])([^'"]+)\1/g,(_all,_quote,name)=>`from ${JSON.stringify(children[name] || (name.endsWith('.vue')?'data:text/javascript,export default {render:()=>null}':name.startsWith('.')?new URL(name,url).href:import.meta.resolve(name)))}`)
 const moduleUrl='data:text/javascript;base64,'+Buffer.from(code).toString('base64')
 const component=(await import(moduleUrl)).default
 const template=compileTemplate({source:descriptor.template.content,filename:url.pathname,id:'transfer-memory',compilerOptions:{bindingMetadata:script.bindings}})
 assert.deepEqual(template.errors,[])
 const renderCode=template.code.replace(/from\s+(['"])([^'"]+)\1/g,(_all,_quote,name)=>`from ${JSON.stringify(import.meta.resolve(name))}`)
 component.render=(await import('data:text/javascript;base64,'+Buffer.from(renderCode).toString('base64'))).render
 return {component,moduleUrl}
}
const base=new URL('../src/views/admin/components/',import.meta.url)
const picker=await compileSfc(new URL('MotionDataPicker.vue',base))
const transfer=await compileSfc(new URL('TransferLinkSettings.vue',base),{'./MotionDataPicker.vue':picker.moduleUrl})
const parent=await compileSfc(new URL('DeviceAnimationLink.vue',base),{'./MotionDataPicker.vue':picker.moduleUrl,'./TransferLinkSettings.vue':transfer.moduleUrl},source=>source.replace(/import \{ createDashboardDataStore \} from [^\n]+/,'const createDashboardDataStore=()=>globalThis.__transferMemoryStore'))

function memoryHost(){
 const make=(tag,text='')=>({tag,tagName:tag.toUpperCase(),text,props:{},children:[],parent:null,value:'',checked:false,listeners:new Map(),
  get options(){return this.children.filter(node=>node.tag==='option')},
  addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(handler)},
  removeEventListener(type,handler){this.listeners.set(type,(this.listeners.get(type)||[]).filter(value=>value!==handler))},
  setAttribute(key,value){this.props[key]=value},removeAttribute(key){delete this.props[key]}})
 const root=make('#root'),remove=node=>{if(node.parent){const children=node.parent.children,index=children.indexOf(node);if(index>=0)children.splice(index,1);node.parent=null}}
 const renderer=createRenderer({createElement:tag=>make(tag),createText:text=>make('#text',text),createComment:text=>make('#comment',text),setText:(node,text)=>{node.text=text},setElementText:(node,text)=>{node.text=text;node.children=[]},
  parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]||null,
  insert(node,parent,anchor){remove(node);const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,node);node.parent=parent},
  remove,querySelector:()=>root,patchProp(node,key,_previous,value){node.props[key]=value;if(key==='value'){node._value=value;node.value=String(value??'')}if(key==='checked')node.checked=value;if(key==='type')node.type=value;if(key==='disabled')node.disabled=value===true||value===''}})
 const nodes=()=>{const result=[];const visit=node=>{result.push(node);node.children.forEach(visit)};visit(root);return result}
 const text=node=>node.text+node.children.map(text).join('')
 const control=(label,scope=root)=>{const all=[];const visit=node=>{all.push(node);node.children.forEach(visit)};visit(scope);const found=all.find(node=>node.props['aria-label']===label);assert.ok(found,`real control ${label}`);return found}
 const fire=async(node,type,value)=>{if(value!==undefined){if(node.type==='checkbox')node.checked=Boolean(value);else node.value=String(value)}const event={target:node,currentTarget:node};const handler=node.props['on'+type[0].toUpperCase()+type.slice(1)];for(const fn of [].concat(handler||[],node.listeners.get(type)||[]))await fn(event);await nextTick();await settle()}
 const click=async label=>{const node=nodes().find(node=>node.tag==='button'&&text(node)===label);assert.ok(node,`real button ${label}`);assert.notEqual(node.disabled,true);await fire(node,'click')}
 return {root,renderer,nodes,text,control,fire,click}
}

test('every actual transfer field saves through the parent HTTP API and is restored in real controls after reopen',{timeout:120000},async t=>{
 const require=createRequire(import.meta.url),{createLinkageFixture}=require('../../backend/scripts/realtime-linkage-fixture.cjs')
 const fixture=await createLinkageFixture('transfer-link-vue'),environment=installBrowser(t)
 t.after(()=>fixture.close())
 const previous={authenticated:adminSession.authenticated,pagePermissions:adminSession.pagePermissions}
 adminSession.authenticated=true;adminSession.pagePermissions={'model-animations':{view:true,edit:true}}
 t.after(()=>{Object.assign(adminSession,previous);discardFactoryDrafts('factory_default')})
 environment.replace('__transferMemoryStore',{wsConnected:ref(false),connect(){},dispose(){},setDeviceDataHandler(){},setMotionInputHandler(){}})
 const route='/api/devices/'+fixture.cartId+'/animations'
 let saved=await fixture.ok(route)
 const feed=saved.dataItems.find(item=>String(item.binding?.pointId)===fixture.points.feed),presence=saved.dataItems.find(item=>String(item.binding?.pointId)===fixture.points.presence)
 assert.ok(feed&&presence)
 saved=await fixture.ok(route,'PUT',{revision:saved.revision,config:{version:1,staleMs:5000,bindings:[{actionId:'clip:feed',enabled:true,pointId:'',dataItemId:feed.id,trigger:{mode:'range'},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.1}]}})
 const calls=[]
 // Retain the actual adminApi/adminFetch URL, headers, JSON handling and save
 // transport. Only the loopback origin is redirected into the owned fixture.
 const nativeFetch=globalThis.fetch,{testFetch}=require('../../backend/scripts/integration-test-utils.cjs')
 environment.replace('fetch',(input,options={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url)
  if(url.origin===fixture.origin)return nativeFetch(input,options)
  assert.equal(url.origin,'http://127.0.0.1:3001','no production or other origin may be contacted')
  assert.ok(url.pathname.startsWith('/api/'))
  if(url.pathname.endsWith('/animations')&&options.method==='PUT')calls.push(JSON.parse(options.body))
  return testFetch(fixture.origin+url.pathname+url.search,options)
 })
 const host=memoryHost(),props={factoryId:'factory_default',devices:[await fixture.ok('/api/devices/'+fixture.cartId)],models:[fixture.cartModel,fixture.targetModel],confirm:async()=>true}
 let vnode
 const mount=async()=>{vnode=h(parent.component,props);host.renderer.render(vnode,host.root);for(let i=0;i<300&&(vnode.component.setupState.busy||!vnode.component.setupState.loaded);i++)await new Promise(resolve=>setTimeout(resolve,10));await nextTick();assert.ok(vnode.component.setupState.loaded,vnode.component.setupState.error)}
 environment.beforeRestore(()=>host.renderer.render(null,host.root))
 await mount();assert.equal(vnode.component.setupState.draft.transferLink,undefined)
 await host.click('进出料联动');assert.equal(vnode.component.setupState.dirty,false,'viewing default-disabled controls does not invent saved settings')
 const choose=async(label,value,type='change')=>host.fire(host.control(label),type,value)
 const feedAction=saved.transferCapabilities.actions.find(action=>action.id==='clip:feed')
 await choose('联动送料动作','clip:feed');await choose('联动承料节点',feedAction.driveNodes[0])
 await choose('联动来源进出料口','outlet');await choose('联动目标进出料口','inlet')
 await choose('联动目标方式','fixed');await choose('联动目标设备',fixture.targetId)
 const presenceScope=host.nodes().find(node=>node.props.class==='presence-field');assert.ok(presenceScope)
 await host.fire(host.control('动作数据用途分类',presenceScope),'change',presence.categoryId)
 await host.fire(host.control('动作数据表',presenceScope),'change',presence.tableId)
 const itemControl=host.control('动作驱动数据项',presenceScope)
 assert.ok(itemControl.options.some(node=>node._value===presence.id))
 assert.ok(!itemControl.options.some(node=>node._value===feed.id),'number source is not offered as material presence')
 await host.fire(itemControl,'change',presence.id)
 for(const [label,value] of [['联动高度允许偏差',.07],['联动横向允许偏差',.09],['联动方向允许偏差',7],['联动物料颜色','#1A2B3C'],['联动物料宽',.8],['联动物料高',.3],['联动物料深',.6]])await choose(label,value,'input')
 await choose('启用实时进出料联动',true)
 const expected=JSON.parse(JSON.stringify(vnode.component.setupState.draft.transferLink))
 await host.click('运行状况');await choose('动画采样诊断日志',true);await choose('动画诊断间隔',4,'input')
 const timeoutControl=host.nodes().find(node=>node.tag==='input'&&node.props.type==='number'&&node.props.min==='1000');assert.ok(timeoutControl)
 await host.fire(timeoutControl,'input',3500)
 assert.equal(await vnode.component.exposed.savePending(),true,vnode.component.setupState.error)
 assert.equal(calls.length,1);assert.deepEqual(calls[0].config.transferLink,expected);assert.equal(calls[0].config.staleMs,3500)
 assert.equal(calls[0].config.diagnosticLogging,true);assert.equal(calls[0].config.diagnosticIntervalSeconds,4)
 assert.equal(vnode.component.setupState.dirty,false)
 const apiReopen=await fixture.ok(route);assert.deepEqual(apiReopen.config.transferLink,expected)
 host.renderer.render(null,host.root);await nextTick();await mount();await host.click('进出料联动')
 for(const [label,field] of [['联动送料动作','actionId'],['联动承料节点','driveNodeName'],['联动来源进出料口','sourcePort'],['联动目标进出料口','targetPort'],['联动目标方式','targetMode'],['联动目标设备','targetDeviceId'],['联动高度允许偏差','heightToleranceMeters'],['联动横向允许偏差','lateralToleranceMeters'],['联动方向允许偏差','angleToleranceDegrees'],['联动物料颜色','materialColor']])assert.equal(host.control(label).value,String(expected[field]),label)
 assert.equal(host.control('启用实时进出料联动').checked,true)
 for(const [i,label]of ['宽','高','深'].entries())assert.equal(host.control('联动物料'+label).value,String(expected.materialSize[i]))
 const scope=host.nodes().find(node=>node.props.class==='presence-field')
 assert.equal(host.control('动作数据用途分类',scope).value,presence.categoryId);assert.equal(host.control('动作数据表',scope).value,presence.tableId)
 assert.equal(host.control('动作驱动数据项',scope).value,presence.id,'saved presence data path restores in the actual picker, not only JSON')
 assert.equal(vnode.component.setupState.dirty,false)
 // Clearing is explicit and only disables the dependent transfer, not the feed
 // action, other bindings, existing ports or geometry.
 await host.fire(host.control('解除物料在位反馈',scope),'click')
 assert.equal(vnode.component.setupState.draft.transferLink.enabled,false);assert.equal(vnode.component.setupState.draft.transferLink.presenceDataItemId,'')
 assert.equal(vnode.component.setupState.draft.bindings.find(binding=>binding.actionId==='clip:feed').enabled,true)
 assert.equal(await vnode.component.exposed.savePending(),true,vnode.component.setupState.error)
 const disabled=await fixture.ok(route);assert.equal(disabled.config.transferLink.enabled,false);assert.equal(disabled.config.bindings.find(binding=>binding.actionId==='clip:feed').enabled,true)
 await writeFile(path.join(fixture.directory,'result.json'),JSON.stringify({success:true,actualVueControls:true,actualParentSave:true,isolatedHttpSqlRoundtrip:true,fields:Object.keys(expected),presencePickerPathRestored:true,clearDisablesOnlyTransfer:true,browserOperations:0,liveConfigurationWrites:0},null,2))
})

test('disabled actual transfer controls cannot mutate bindings even when a stale handler is invoked',async t=>{
 const environment=installBrowser(t),host=memoryHost(),value={enabled:false,actionId:'clip:feed',driveNodeName:'pusher',targetDeviceId:'target',targetMode:'fixed',sourcePort:'outlet',targetPort:'inlet',presenceDataItemId:'present',materialSize:[.6,.3,.6],materialColor:'#E5A34A',heightToleranceMeters:.05,lateralToleranceMeters:.05,angleToleranceDegrees:5},updates=[]
 const vnode=h(transfer.component,{value,disabled:true,capabilities:{sourcePorts:{inlet:{},outlet:{}},actions:[{id:'clip:feed',driveNodes:['pusher']}],targetDevices:[]},catalog:{items:[]},onUpdate:next=>updates.push(next)})
 host.renderer.render(vnode,host.root);environment.beforeRestore(()=>host.renderer.render(null,host.root))
 const original=JSON.stringify(value)
 await host.fire(host.control('启用实时进出料联动'),'change',true)
 await host.fire(host.control('联动高度允许偏差'),'input',.9)
 await host.fire(host.control('联动送料动作'),'change','other')
 assert.equal(updates.length,0);assert.equal(JSON.stringify(value),original)
})
