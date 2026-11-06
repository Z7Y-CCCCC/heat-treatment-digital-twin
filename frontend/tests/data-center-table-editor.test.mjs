import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { readFactoryDraft, listFactoryDrafts, discardFactoryDrafts } from '../src/runtime/factoryDraftCache.js'
import { installBrowser, settle, deferred } from './helpers.mjs'

const sourceUrl=new URL('../src/views/admin/components/DataSetWorkspace.vue',import.meta.url)
const {descriptor,errors}=parse(await readFile(sourceUrl,'utf8'));assert.deepEqual(errors,[])
assert.deepEqual(compileTemplate({source:descriptor.template.content,id:'data-center-table',filename:sourceUrl.pathname}).errors,[])
let code=compileScript(descriptor,{id:'data-center-table'}).content
for(const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)])code=code.replace(match[0],`from ${JSON.stringify(match[2].startsWith('.')?new URL(match[2],sourceUrl).href:import.meta.resolve(match[2]))}`)
const {default:Editor}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);Editor.render=()=>null
const definition=()=>({id:'dataset_a',name:'生产数据',revision:'r1',connectionId:'mysql_a',source:'database',enabled:true,refreshMs:5000,request:{method:'GET',path:'/',parameters:[]},database:{schema:'',table:'orders',orderBy:'',orderDirection:'desc'},columns:[{name:'count',label:'订单数量',path:'count',type:'number',role:'value',unit:'',scale:1,offset:0}],rootPath:'',match:null})

async function fixture(t, options={}) {
  const env=installBrowser(t),oldSession={authenticated:adminSession.authenticated,pagePermissions:adminSession.pagePermissions}
  adminSession.authenticated=true;adminSession.pagePermissions={'settings.database':{view:true,edit:true,delete:true}}
  env.browser.localStorage={getItem:()=> 'factory_a'}
  env.browser.dispatchEvent=()=>{}
  env.replace('CustomEvent',class {constructor(type){this.type=type}})
  t.mock.method(adminApi,'getDataSets',async()=>({success:true,datasets:[definition()]}))
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance=ref(null),app=renderer.createApp({render:()=>h(Editor,{ref:instance,connections:[{id:'mysql_a',name:'MES库',type:'mysql',enabled:true}],confirm:async()=>true,...options})})
  app.mount({});env.beforeRestore(()=>app.unmount());t.after(()=>{discardFactoryDrafts('factory_a');Object.assign(adminSession,oldSession)})
  await settle();return {state:instance.value.$.setupState,app}
}

test('table editor shows data-table wording, selectable database tables and contextual mapping help',()=>{
  assert.doesNotMatch(descriptor.template.content,/数据集/)
  assert.match(descriptor.template.content,/选择来源数据表/)
  assert.match(descriptor.template.content,/高级：手动填写表名/)
  assert.match(descriptor.template.content,/悬停或切换设备时会自动读取它自己的记录/)
})

test('database table list uses existing connection API and selection fills schema without changing binding identity',async t=>{
  const {state}=await fixture(t)
  t.mock.method(adminApi,'getDataSourceTables',async()=>({tables:[{schema:'public',name:'device_orders'}]}))
  await state.loadTables();state.chooseDatabaseTable('1')
  assert.deepEqual(adminApi.getDataSourceTables.mock.calls[0].arguments,['mysql_a'])
  assert.equal(state.draft.database.schema,'public');assert.equal(state.draft.database.table,'device_orders')
  assert.equal(state.draft.id,'dataset_a');assert.equal(state.draft.columns[0].name,'count')
})

test('failed backend save preserves draft, revision and factory cache and rejects pending save',async t=>{
  const {state}=await fixture(t);state.draft.name='更新后的生产数据';await settle()
  t.mock.method(adminApi,'saveDataSet',async()=>({success:false,error:'数据表已被其他人修改'}))
  await assert.rejects(()=>state.savePending(),/其他人修改/)
  assert.equal(state.draft.name,'更新后的生产数据');assert.equal(state.draft.revision,'r1')
  assert.equal(readFactoryDraft('factory_a','data-set-editor').value.name,'更新后的生产数据')
  assert.equal(listFactoryDrafts('factory_a')[0].type,'dataset')
})

test('failed backend delete does not drop an existing data table or saved snapshot',async t=>{
  const {state}=await fixture(t)
  t.mock.method(adminApi,'deleteDataSet',async()=>({success:false,error:'删除失败'}))
  await state.remove()
  assert.equal(state.draft.id,'dataset_a');assert.equal(state.failed,true);assert.equal(state.message,'删除失败')
})

test('failed preview and table discovery show real backend errors, not a fake empty result',async t=>{
  const {state}=await fixture(t)
  t.mock.method(adminApi,'previewDataSet',async()=>({success:false,error:'对象编号不存在'}))
  await state.preview();assert.equal(state.result,null);assert.equal(state.message,'对象编号不存在')
  t.mock.method(adminApi,'getDataSourceTables',async()=>({error:'数据库权限不足'}))
  await state.loadTables();assert.equal(state.tablesError,'数据库权限不足')
})

test('successful pending save clears factory cache while discard restores saved data-table draft',async t=>{
  const {state}=await fixture(t);state.draft.name='更新名';await settle()
  t.mock.method(adminApi,'saveDataSet',async()=>({success:true,dataset:{...state.draft,revision:'r2'}}))
  await state.savePending();assert.equal(readFactoryDraft('factory_a','data-set-editor'),null)
  state.draft.name='丢弃修改';await settle();state.discardPending();await settle()
  assert.equal(state.draft.name,'生产数据');assert.equal(readFactoryDraft('factory_a','data-set-editor'),null)
})

test('busy table reads block leaving the editor and stale table list cannot overwrite another connection',async t=>{
  const {state}=await fixture(t),pending=deferred()
  t.mock.method(adminApi,'getDataSourceTables',()=>pending.promise)
  const read=state.loadTables();assert.equal(await state.canLeave(),false)
  state.draft.connectionId='different';await settle()
  pending.resolve({tables:[{name:'stale'}]});await read
  assert.deepEqual(state.databaseTables,[])
})
