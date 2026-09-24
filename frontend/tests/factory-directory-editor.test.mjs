import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer,h,ref,nextTick } from 'vue'
import { parse,compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser,settle } from './helpers.mjs'

const url=new URL('../src/views/admin/components/FactoryDirectorySettings.vue',import.meta.url)
const {descriptor}=parse(await readFile(url,'utf8'))
let code=compileScript(descriptor,{id:'factory-directory-editor-test'}).content
for(const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]){
  const name=match[2],resolved=name.endsWith('.vue')
    ? 'data:text/javascript,export default {}'
    : name.startsWith('.') ? new URL(name,url).href:import.meta.resolve(name)
  code=code.replace(match[0],`from ${JSON.stringify(resolved)}`)
}
const {default:Editor}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Editor.render=()=>null

const factories=[
  {id:'factory_default',name:'默认工厂',location:{country:'CHN',regionName:'天津市'},enabled:true,workshopCount:1,lineCount:2,deviceCount:6},
  {id:'factory_north',name:'北方基地',location:{country:'CHN',regionName:'河北省'},enabled:true,workshopCount:0,lineCount:0,deviceCount:0}
]
function fixture(t){
  const environment=installBrowser(t),storage=new Map(),reloads={count:0},confirmations=[]
  environment.browser.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}
  environment.browser.dispatchEvent=()=>true
  environment.browser.confirm=message=>{confirmations.push(message);return true}
  environment.browser.location={reload(){reloads.count++}}
  environment.replace('CustomEvent',class{constructor(type,options){this.type=type;this.detail=options?.detail}})
  const list=t.mock.method(adminApi,'listFactories',async()=>({factories:[...factories],activeFactoryId:'factory_default'}))
  const create=t.mock.method(adminApi,'createFactory',async input=>({success:true,factory:{id:'factory_new',name:input.name}}))
  const activate=t.mock.method(adminApi,'activateFactory',async id=>({success:true,activeFactoryId:id}))
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance=ref(null),app=renderer.createApp({render:()=>h(Editor,{ref:instance})})
  app.mount({});environment.beforeRestore(()=>app.unmount())
  return {instance,storage,reloads,confirmations,list,create,activate}
}

test('loads real factory rows with hierarchy counts and active configuration scope',async t=>{
  const view=fixture(t);await settle();await nextTick()
  const state=view.instance.value.$.setupState
  assert.equal(state.factories.length,2);assert.equal(state.scopeId,'factory_default');assert.equal(state.activeId,'factory_default')
  assert.equal(state.factories[0].deviceCount,6)
})

test('new factory creation calls the central factory API and explains its isolated hierarchy',async t=>{
  const view=fixture(t);await settle();await nextTick()
  const state=view.instance.value.$.setupState
  state.openCreate();state.newName='南方基地';state.newLocation.regionCode='440000'
  await state.createFactory()
  assert.equal(view.create.mock.callCount(),1)
  assert.equal(view.create.mock.calls[0].arguments[0].name,'南方基地')
  assert.match(state.message,/独立维护/)
})

test('switching the configuration scope prompts then persists and reloads the admin workspace',async t=>{
  const view=fixture(t);await settle();await nextTick()
  const state=view.instance.value.$.setupState
  state.selectScope(state.factories[1])
  assert.equal(view.confirmations.length,1)
  assert.equal(view.storage.get('digital_twin_factory_scope_v1'),'factory_north')
  assert.equal(view.reloads.count,1)
})

test('activating a factory is a separate explicit action from changing the admin configuration scope',async t=>{
  const view=fixture(t);await settle();await nextTick()
  const state=view.instance.value.$.setupState
  state.selectScope(state.factories[1])
  const storedScope=view.storage.get('digital_twin_factory_scope_v1')
  await state.activate(state.factories[1])
  assert.equal(view.activate.mock.callCount(),1)
  assert.equal(view.activate.mock.calls[0].arguments[0],'factory_north')
  assert.equal(state.activeId,'factory_north')
  assert.equal(view.storage.get('digital_twin_factory_scope_v1'),storedScope)
})
