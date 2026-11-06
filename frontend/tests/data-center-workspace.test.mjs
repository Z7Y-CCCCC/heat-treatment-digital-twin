import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, settle, deferred } from './helpers.mjs'
import { DATA_CENTER_SECTIONS, dataCenterPreview, dataCenterQuality, dataCenterObjectLabel, filterDataCenterItems } from '../src/views/admin/utils/dataCenterCatalog.js'

const sourceUrl = new URL('../src/views/admin/components/DataCenterWorkspace.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: sourceUrl.pathname, id: 'data-center' }).errors, [])
let compiled = compileScript(descriptor, { id: 'data-center' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const specifier = match[2]
  const target = specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier)
  compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Workspace } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Workspace.render = () => null

function definition(revision = 'r1') {
  return { success: true, revision, categories: [{ id: 'realtime', name: '实时采集' }, { id: 'energy', name: '能耗管理' }, { id: 'uncategorized', name: '未分类' }],
    tables: [{ id: 'points_1', name: '1#炉 · 采集点位', sourceType: 'plc', categoryId: 'realtime' }, { id: 'external', name: 'MES生产数据', sourceType: 'dataset', categoryId: 'uncategorized' }],
    items: [{ id: 'temperature', tableId: 'points_1', label: '炉内温度', categoryId: 'realtime', sourceType: 'plc', objectScope: 'device', deviceName: '1#炉', type: 'number', unit: '℃', previewValue: 0, quality: 'good', binding: {mode:'plc', pointKey:'temperature'} },
      { id: 'energy', tableId: 'points_1', label: '能耗', categoryId: 'energy', sourceType: 'plc', objectScope: 'device', deviceName: '1#炉', type:'number', unit:'kWh', quality:'unknown' },
      { id: 'orders', tableId: 'external', label: '订单数量', categoryId: 'uncategorized', sourceType: 'dataset', type:'number', objectScope:'factory', quality:'configured' }] }
}

function fixture(t, options = {}) {
  const env = installBrowser(t)
  env.browser.dispatchEvent = event => { for (const handler of env.browser.listeners.get(event.type) || []) handler(event) }
  env.replace('CustomEvent', class { constructor(type, options) { this.type=type; this.detail=options?.detail } })
  const props = ref({factoryId:'factory_a', canEdit:true, canDelete:true, confirm:async()=>true, ...options})
  t.mock.method(adminApi, 'getDataCenterCatalog', async()=>definition())
  const renderer = createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance = ref(null), app = renderer.createApp({render:()=>h(Workspace,{...props.value,ref:instance})})
  app.mount({}); env.beforeRestore(()=>app.unmount())
  return {state:instance.value.$.setupState,props,env,app}
}

test('data center sections consolidate source, point mapping, monitoring and alarm setup',()=>{
  assert.deepEqual(DATA_CENTER_SECTIONS.map(section=>section.key), ['tables','sources','mapping','monitor','alarms'])
  assert.match(descriptor.template.content, /删除分类不会删除数据或已绑定的组件/)
  assert.match(descriptor.template.content, /不改变原始值或绑定/)
  assert.match(descriptor.template.content, /table-editor/)
  assert.doesNotMatch(descriptor.template.content, /center-nav|role="tablist"|data-center-tab-/)
  assert.match(descriptor.template.content, /role="region" aria-label="数据表"/)
  assert.match(descriptor.template.content, /aria-label="数据使用流程"/)
})

test('catalog filters per field category rather than table category and searches units/object names',()=>{
  const entries = definition().items
  assert.deepEqual(filterDataCenterItems(entries,{categoryId:'energy'}).map(item=>item.id), ['energy'])
  assert.deepEqual(filterDataCenterItems(entries,{query:'℃'}).map(item=>item.id), ['temperature'])
  assert.equal(filterDataCenterItems(entries,{query:'1#炉'}).length,2)
  assert.deepEqual(filterDataCenterItems(entries,{sourceType:'外部数据表'}).map(item=>item.id), ['orders'])
  assert.equal(dataCenterObjectLabel(entries[0]),'1#炉')
  assert.equal(dataCenterObjectLabel(entries[2]),'当前工厂')
})

test('previews preserve zero, false and unknown quality without inventing a healthy status',()=>{
  assert.equal(dataCenterPreview({previewValue:0}),'0')
  assert.equal(dataCenterPreview({previewValue:false}),'否')
  assert.equal(dataCenterPreview({previewValue:null}),'—')
  assert.equal(dataCenterQuality('unknown').label,'未读取')
  assert.equal(dataCenterQuality('configured').label,'已配置')
  assert.equal(dataCenterQuality('offline').key,'bad')
})

test('real setup loads scoped catalog and mixed categories stay discoverable',async t=>{
  const {state}=fixture(t); await settle()
  assert.equal(adminApi.getDataCenterCatalog.mock.calls[0].arguments[0].factoryId,'factory_a')
  state.categoryId='energy'; await nextTick()
  assert.equal(state.tables.length,1)
  assert.equal(state.selectedTable.id,'points_1')
  assert.deepEqual(state.tableItems.map(item=>item.id),['energy'])
  state.categoryId='all';state.query='MES';await nextTick()
  assert.deepEqual(state.items.map(item=>item.id),['orders'])
})

test('category writes use optimistic revision and conflicts retain editable form',async t=>{
  const {state}=fixture(t);await settle()
  t.mock.method(adminApi,'saveDataCategory',async()=>({success:false,error:'数据中心已由其他人修改，请刷新后重试'}))
  state.categoryForm={id:'',name:'能耗管理'}
  await state.saveCategory()
  assert.equal(adminApi.saveDataCategory.mock.calls[0].arguments[0].revision,'r1')
  assert.equal(state.categoryForm.name,'能耗管理')
  assert.equal(state.failed,true)
  assert.match(state.message,/其他人修改/)
})

test('category deletion protects uncategorized and confirms safe migration',async t=>{
  const prompts=[]
  const {state}=fixture(t,{confirm:async text=>{prompts.push(text);return true}});await settle()
  t.mock.method(adminApi,'deleteDataCategory',async()=>({success:true,revision:'r2'}))
  await state.deleteCategory({id:'uncategorized',name:'未分类'})
  assert.equal(adminApi.deleteDataCategory.mock.calls.length,0)
  await state.deleteCategory({id:'energy',name:'能耗管理'})
  assert.deepEqual(adminApi.deleteDataCategory.mock.calls[0].arguments,['energy','r1'])
  assert.match(prompts[0],/原始数据和组件绑定不会删除/)
  assert.equal(state.categoryId,'uncategorized')
})

test('field metadata editing never submits a binding or static read value',async t=>{
  const {state}=fixture(t);await settle()
  t.mock.method(adminApi,'saveDataItemMetadata',async()=>({success:true,revision:'r2'}))
  state.editField(state.catalog.items[0]);state.fieldForm.label='炉温';state.fieldForm.categoryId='energy'
  await state.saveField()
  assert.deepEqual(adminApi.saveDataItemMetadata.mock.calls[0].arguments,['temperature',{label:'炉温',categoryId:'energy',revision:'r1'}])
  assert.equal(state.fieldForm,null)
})

test('readonly accounts cannot create/delete categories or edit field metadata',async t=>{
  const {state}=fixture(t,{canEdit:false,canDelete:false});await settle()
  t.mock.method(adminApi,'saveDataCategory',async()=>{throw new Error('must not write')})
  t.mock.method(adminApi,'deleteDataCategory',async()=>{throw new Error('must not write')})
  await state.editCategory();assert.equal(state.categoryForm,null)
  state.editField(state.catalog.items[0]);assert.equal(state.fieldForm,null)
  await state.deleteCategory({id:'energy',name:'能耗管理'})
  assert.equal(adminApi.deleteDataCategory.mock.calls.length,0)
})

test('slow old factory reads cannot overwrite the newly selected factory',async t=>{
  const {state,props}=fixture(t);await settle()
  const old=deferred();t.mock.method(adminApi,'getDataCenterCatalog',async ({factoryId})=>factoryId==='factory_a'?old.promise:definition('factory_b_revision'))
  const pending=state.load();props.value={...props.value,factoryId:'factory_b'};await nextTick();await settle()
  old.resolve(definition('old_revision'));await pending
  assert.equal(state.catalog.revision,'factory_b_revision')
})

test('deletion cannot be sent after factory changes during confirmation',async t=>{
  const approval=deferred();const {state,props}=fixture(t,{confirm:()=>approval.promise});await settle()
  t.mock.method(adminApi,'deleteDataCategory',async()=>({success:true}))
  const pending=state.deleteCategory({id:'energy',name:'能耗管理'})
  props.value={...props.value,factoryId:'factory_b'};await nextTick();approval.resolve(true);await pending
  assert.equal(adminApi.deleteDataCategory.mock.calls.length,0)
})

test('navigation guard blocks mutations and honours cancelling unsaved catalog forms',async t=>{
  const {state}=fixture(t,{confirm:async()=>false});await settle()
  state.busy=true;assert.equal(await state.canLeave(),false)
  state.busy=false;state.categoryForm={id:'',name:'自定义分类'}
  assert.equal(await state.canLeave(),false)
  assert.equal(state.categoryForm.name,'自定义分类')
  state.discardPending();assert.equal(await state.canLeave(),true)
})

test('factory save decision rejects failed pending metadata save rather than switching factories',async t=>{
  const {state}=fixture(t);await settle()
  t.mock.method(adminApi,'saveDataCategory',async()=>({success:false,error:'分类名已存在'}))
  state.categoryForm={id:'',name:'能耗管理'}
  await assert.rejects(()=>state.savePending(),/分类名已存在/)
  assert.equal(state.categoryForm.name,'能耗管理')
})

test('preview device selection changes sample context without requesting a scoped-down catalog',async t=>{
  const {state}=fixture(t,{devices:[{id:'device_b',name:'设备 B'}]});await settle()
  state.previewDeviceId='device_b';await settle()
  const args=adminApi.getDataCenterCatalog.mock.calls.at(-1).arguments[0]
  assert.equal(args.previewDeviceId,'device_b')
  assert.equal(Object.hasOwn(args,'deviceId'),false)
  assert.equal(state.catalog.items.length,3)
})
