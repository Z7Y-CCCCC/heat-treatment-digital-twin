import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, settle, deferred } from './helpers.mjs'
import { DATA_CENTER_SECTIONS, dataCenterPreview, dataCenterQuality, dataCenterObjectLabel, filterDataCenterItems } from '../src/views/admin/utils/dataCenterCatalog.js'
import { firstDataCenterSample } from '../src/views/admin/utils/dataCenterFieldSamples.js'

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
  t.mock.method(adminApi, 'getDataTableRecords', async()=>({success:true, records:[], sourceRecordCount:0, readAt:'2026-11-07T07:44:16Z'}))
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

test('field metadata editor is in its row with icon-only actions and no separate bottom form',()=>{
  const template=descriptor.template.content
  assert.doesNotMatch(template,/class="field-form"|>编辑<|<form v-if="fieldForm"/)
  assert.match(template,/:data-field-id="item.id"/)
  assert.match(template,/:ref="setFieldInput" v-model="fieldForm.label"/)
  assert.match(template,/v-model="fieldForm.categoryId" class="field-inline-input"/)
  assert.match(template,/@keydown="fieldKeys"/)
  assert.match(template,/@keydown.esc="fieldKeys"/)
  assert.match(template,/整理数据项 \$\{item.label\}[^\n]*<svg/)
  assert.match(template,/保存数据项 \$\{item.label\}[^\n]*<svg/)
  assert.match(template,/取消编辑数据项 \$\{item.label\}[^\n]*<svg/)
})

test('row edit focuses the actual input, cancellation is local and unchanged edits leave without confirmation',async t=>{
  let prompts=0,focused=0
  const {state}=fixture(t,{confirm:async()=>{prompts++;return true}});await settle()
  state.setFieldInput({focus:()=>focused++,scrollIntoView(){}})
  await state.editField(state.catalog.items[0])
  assert.equal(focused,1);assert.equal(state.fieldOriginal.revision,'r1')
  assert.equal(state.fieldDirty,false);assert.equal(await state.canLeave(),true)
  assert.equal(prompts,0);assert.equal(state.fieldForm,null);assert.equal(state.fieldOriginal,null)
  await state.editField(state.catalog.items[0]);state.fieldForm.label='临时名称'
  assert.equal(state.cancelField(),true);assert.equal(state.catalog.items[0].label,'炉内温度')
})

test('declined row, category, search, table and preview switches keep the dirty inline draft',async t=>{
  const {state}=fixture(t,{confirm:async()=>false});await settle()
  await state.editField(state.catalog.items[0]);state.fieldForm.label='我的炉温'
  await state.editField(state.catalog.items[1])
  for(const [key,value] of [['query','MES'],['categoryId','energy'],['sourceType','外部数据表'],['selectedTableId','external'],['previewDeviceId','other']]) {
    assert.equal(await state.changeCatalogSelection(key,value),false)
    assert.equal(state.fieldForm.id,'temperature');assert.equal(state.fieldForm.label,'我的炉温')
  }
  assert.equal(state.query,'');assert.equal(state.categoryId,'all');assert.equal(state.selectedTableId,'')
  assert.equal(await state.refreshCatalog(),false)
})

test('accepted switches clear the draft only after confirmation and start the next row at its own baseline',async t=>{
  let prompts=0
  const {state}=fixture(t,{confirm:async()=>{prompts++;return true}});await settle()
  await state.editField(state.catalog.items[0]);state.fieldForm.label='临时'
  await state.editField(state.catalog.items[1])
  assert.equal(prompts,1);assert.equal(state.fieldForm.id,'energy');assert.equal(state.fieldOriginal.label,'能耗')
  state.fieldForm.label='新能耗';assert.equal(await state.changeCatalogSelection('selectedTableId','external'),true)
  assert.equal(state.fieldForm,null);assert.equal(state.selectedTable.id,'external')
})

test('failed row saves preserve the inline draft and its original revision even if the catalog changes',async t=>{
  const {state}=fixture(t);await settle()
  await state.editField(state.catalog.items[0]);state.fieldForm.label='  炉温  '
  state.catalog.revision='new-other-revision'
  t.mock.method(adminApi,'saveDataItemMetadata',async()=>({success:false,error:'版本冲突，请重新读取'}))
  await state.saveField()
  assert.deepEqual(adminApi.saveDataItemMetadata.mock.calls[0].arguments,['temperature',{label:'炉温',categoryId:'realtime',revision:'r1'}])
  assert.equal(state.fieldForm.label,'  炉温  ');assert.equal(state.fieldOriginal.revision,'r1')
  assert.equal(state.failed,true);assert.match(state.message,/版本冲突/)
})

test('external data updates do not replace an open editor or silently advance its CAS revision',async t=>{
  const {state,env}=fixture(t);await settle();await state.editField(state.catalog.items[0])
  state.fieldForm.label='草稿';const before=adminApi.getDataCenterCatalog.mock.calls.length
  env.browser.dispatchEvent(new CustomEvent('digital-twin-data-center-changed',{detail:{source:'another-page'}}))
  await settle()
  assert.equal(adminApi.getDataCenterCatalog.mock.calls.length,before)
  assert.equal(state.fieldOriginal.revision,'r1');assert.equal(state.fieldForm.label,'草稿')
  assert.match(state.message,/已有更新/)
})

test('saving locks row mutations until the pending metadata request settles',async t=>{
  const {state}=fixture(t);await settle();await state.editField(state.catalog.items[0]);state.fieldForm.label='新炉温'
  const saving=deferred();t.mock.method(adminApi,'saveDataItemMetadata',()=>saving.promise)
  const work=state.saveField()
  assert.equal(state.cancelField(),false);assert.equal(await state.changeCatalogSelection('categoryId','energy'),false)
  saving.resolve({success:false,error:'保留草稿'});await work;assert.equal(state.fieldForm.label,'新炉温')
})

test('a factory change during confirmation cannot apply the old filter',async t=>{
  const approval=deferred(), other=fixture(t,{confirm:()=>approval.promise});await settle()
  await other.state.editField(other.state.catalog.items[0]);other.state.fieldForm.label='旧工厂草稿'
  const change=other.state.changeCatalogSelection('query','MES')
  other.props.value={...other.props.value,factoryId:'factory_b'};await nextTick();approval.resolve(true)
  assert.equal(await change,false);assert.equal(other.state.query,'');assert.equal(other.state.fieldForm,null)
})

test('category drafts are retained on repeated editing and protected before editing another category',async t=>{
  let prompts=0, focused=0
  const {state}=fixture(t,{confirm:async()=>{prompts++;return false}});await settle()
  state.categoryInput={focus:()=>focused++}
  await state.editCategory();state.categoryForm.name='未保存的能耗分类'
  await state.editCategory()
  assert.equal(state.categoryForm.name,'未保存的能耗分类');assert.equal(prompts,0);assert.equal(focused,2)
  await state.editCategory(state.catalog.categories[0])
  assert.equal(state.categoryForm.name,'未保存的能耗分类');assert.equal(prompts,1)
  state.discardPending();await state.editCategory(state.catalog.categories[0]);state.categoryForm.name='改名草稿'
  await state.editCategory(state.catalog.categories[0])
  assert.equal(state.categoryForm.name,'改名草稿');assert.equal(prompts,1)
  await state.editCategory()
  assert.equal(state.categoryForm.name,'改名草稿');assert.equal(prompts,2)
})

test('IME Enter and Escape never save or cancel a row; ordinary shortcuts still work',async t=>{
  const {state}=fixture(t);await settle();await state.editField(state.catalog.items[0]);state.fieldForm.label='中文名称'
  t.mock.method(adminApi,'saveDataItemMetadata',async()=>({success:true,revision:'r2'}))
  for(const key of ['Enter','Escape']) for(const ime of [{isComposing:true},{keyCode:229}]) {
    state.fieldKeys({key,...ime,preventDefault(){assert.fail('IME default must remain native')},stopPropagation(){assert.fail('IME must not be a row command')}})
    assert.equal(state.fieldForm.label,'中文名称');assert.equal(adminApi.saveDataItemMetadata.mock.calls.length,0)
  }
  let prevented=0,stopped=0
  state.fieldKeys({key:'Escape',preventDefault(){prevented++},stopPropagation(){stopped++}})
  assert.equal(prevented,1);assert.equal(stopped,1);assert.equal(state.fieldForm,null)
  await state.editField(state.catalog.items[0]);state.fieldForm.label='新名称'
  state.fieldKeys({key:'Enter',preventDefault(){prevented++}});await settle()
  assert.equal(prevented,2);assert.equal(state.fieldForm,null)
  assert.equal(adminApi.saveDataItemMetadata.mock.calls[0].arguments[1].label,'新名称')
})

test('record browsing is a local table view, lazy loaded and scoped to the selected factory/table', () => {
  assert.match(descriptor.template.content, /aria-label="数据表查看方式"/)
  assert.match(descriptor.template.content, /changeTableView\('records'\)/)
  assert.match(descriptor.template.content, /DataTableBrowser v-else/)
  assert.match(descriptor.template.content, /:factory-id="browseFactoryId" :table="selectedTable"/)
  assert.match(descriptor.template.content, /previewDevices.length && tableView==='fields'/)
})

test('switching from directory to records honours unsaved edits, never saves or changes bindings', async t => {
  let approval = false
  const { state } = fixture(t, { confirm: async () => approval }); await settle()
  t.mock.method(adminApi, 'saveDataItemMetadata', async () => assert.fail('browsing must never save metadata'))
  await state.editField(state.catalog.items[0]); state.fieldForm.label = '未保存的字段'
  assert.equal(await state.changeTableView('records'), false)
  assert.equal(state.tableView, 'fields'); assert.equal(state.fieldForm.label, '未保存的字段')
  approval = true
  assert.equal(await state.changeTableView('records'), true)
  assert.equal(state.tableView, 'records'); assert.equal(state.fieldForm, null)
  assert.equal(adminApi.saveDataItemMetadata.mock.calls.length, 0)
  assert.equal(await state.changeTableView('invalid'), false)
  state.busy = true
  assert.equal(await state.changeTableView('fields'), false)
})

test('factory change during table view confirmation cannot open old records', async t => {
  const approval = deferred()
  const { state, props } = fixture(t, { confirm: () => approval.promise }); await settle()
  await state.editField(state.catalog.items[0]); state.fieldForm.label = '旧工厂'
  const pending = state.changeTableView('records')
  props.value = { ...props.value, factoryId: 'factory_b' }; await nextTick()
  approval.resolve(true)
  assert.equal(await pending, false); assert.equal(state.tableView, 'fields')
})

test('default current-factory entry uses actual catalog scope instead of silently requesting no records', async t => {
  const { state, props } = fixture(t, { factoryId: '' }); await settle()
  t.mock.method(adminApi, 'getDataCenterCatalog', async () => ({ ...definition(), factoryId: 'factory_actual' }))
  await state.load()
  assert.equal(state.browseFactoryId, 'factory_actual')
  assert.equal(state.catalog.factoryId, 'factory_actual')
  props.value = { ...props.value, factoryId: 'factory_other' }; await nextTick(); await settle()
  assert.equal(state.browseFactoryId, 'factory_other')
})

test('directory sample preserves zero/false/null and never fills missing values from another row', () => {
  const sample = firstDataCenterSample([
    { objectId: 'row1', objectName: '第一行', fieldId: 'zero', value: 0, quality: 'good' },
    { objectId: 'row1', fieldId: 'flag', value: false, quality: 'good' },
    { objectId: 'row1', fieldId: 'missing', value: null, quality: 'unknown' },
    { objectId: 'row2', fieldId: 'missing', value: 500, quality: 'good' },
    { objectId: 'row2', fieldId: 'extra', value: '不可拼入', quality: 'good' }
  ])
  assert.equal(sample.objectName, '第一行')
  assert.equal(sample.values.zero.previewValue, 0)
  assert.equal(sample.values.flag.previewValue, false)
  assert.equal(sample.values.missing.previewValue, null)
  assert.equal(sample.values.missing.quality, 'unknown')
  assert.equal(sample.values.extra, undefined)
  assert.deepEqual(firstDataCenterSample([]), { values: {}, objectName: '' })
})

test('same mapped device with multiple business records cannot mix sample rows', () => {
  const sample = firstDataCenterSample([
    { objectId: 'device1', fieldId: 'a', value: 'first' },
    { objectId: 'device1', fieldId: 'b', value: null },
    { objectId: 'device1', fieldId: 'a', value: 'second' },
    { objectId: 'device1', fieldId: 'b', value: 99 }
  ])
  assert.equal(sample.values.a.previewValue, 'first')
  assert.equal(sample.values.b.previewValue, null)
})

test('only selected external field directory reads authorized records; samples never mutate metadata', async t => {
  const { state } = fixture(t); await settle()
  assert.equal(adminApi.getDataTableRecords.mock.calls.length, 0)
  const original = JSON.parse(JSON.stringify(state.catalog))
  t.mock.method(adminApi, 'getDataTableRecords', async () => ({ success: true, sourceRecordCount: 2, readAt: '2026-11-07T08:00:00Z', records: [
    { objectId: 'row1', objectName: '订单一', fieldId: 'orders', value: 0, quality: 'good', updatedAt: '2026-11-07T07:44:16Z' },
    { objectId: 'row2', fieldId: 'orders', value: 99, quality: 'good' }
  ] }))
  await state.changeCatalogSelection('selectedTableId', 'external'); await settle()
  const request = adminApi.getDataTableRecords.mock.calls[0].arguments[0]
  assert.equal(request.tableId, 'external'); assert.equal(request.factoryId, 'factory_a')
  assert.equal(request.mode, 'current'); assert.equal(request.pageSize, 100)
  assert.ok(request.signal instanceof AbortSignal)
  assert.equal(state.displayedTableItems[0].previewValue, 0)
  assert.equal(state.displayedTableItems[0].quality, 'good')
  assert.equal(state.displayedTableItems[0].previewUpdatedAt, '2026-11-07T07:44:16Z')
  assert.equal(state.sampleReadAt, '2026-11-07T08:00:00Z')
  assert.match(state.sampleHint, /订单一.*同一条实际记录/)
  assert.deepEqual(state.catalog, original)
  await state.editField(state.catalog.items.find(item => item.id === 'orders'))
  state.fieldForm.label = '订单件数'
  t.mock.method(adminApi, 'saveDataItemMetadata', async () => ({ success: true, revision: 'r2' }))
  await state.saveField()
  assert.deepEqual(adminApi.saveDataItemMetadata.mock.calls[0].arguments, ['orders', { label: '订单件数', categoryId: 'uncategorized', revision: 'r1' }])
  await state.changeTableView('records'); await settle()
  const count = adminApi.getDataTableRecords.mock.calls.length
  assert.equal(await state.loadFieldSamples(), false)
  assert.equal(adminApi.getDataTableRecords.mock.calls.length, count)
})

test('empty or missing object context is explained without showing configured values as real samples', async t => {
  const { state } = fixture(t); await settle()
  await state.changeCatalogSelection('selectedTableId', 'external'); await settle()
  assert.equal(state.displayedTableItems[0].previewValue, null)
  assert.equal(state.displayedTableItems[0].quality, 'empty')
  assert.match(state.sampleHint, /没有返回记录/)
  for (const notice of ['请选择设备后读取此表', '请选择具体部件后读取此表']) {
    t.mock.method(adminApi, 'getDataTableRecords', async () => ({ success: true, records: [], sourceRecordCount: null, notice }))
    await state.loadFieldSamples()
    assert.equal(state.sampleHint, notice)
    assert.equal(state.displayedTableItems[0].quality, 'unknown')
    assert.equal(state.displayedTableItems[0].previewValue, null)
  }
})

test('unauthorized and failed sample reads clear old values and report actual read status', async t => {
  const { state } = fixture(t); await settle()
  await state.changeCatalogSelection('selectedTableId', 'external'); await settle()
  for (const [status, quality, error] of [[401, 'unknown', '请先登录'], [403, 'unknown', '没有数据读取权限'], [503, 'bad', '来源不可用']]) {
    state.fieldSamples = { orders: { previewValue: 888, quality: 'good' } }
    t.mock.method(adminApi, 'getDataTableRecords', async () => { throw Object.assign(new Error(error), { status }) })
    assert.equal(await state.loadFieldSamples(), false)
    assert.equal(state.displayedTableItems[0].previewValue, null)
    assert.equal(state.displayedTableItems[0].quality, quality)
    assert.equal(state.sampleHint, error)
  }
})

test('table/view changes abort sample requests and discard late responses', async t => {
  const { state } = fixture(t); await settle()
  const pending = deferred()
  t.mock.method(adminApi, 'getDataTableRecords', () => pending.promise)
  await state.changeCatalogSelection('selectedTableId', 'external'); await nextTick()
  const signal = adminApi.getDataTableRecords.mock.calls[0].arguments[0].signal
  await state.changeTableView('records'); await nextTick()
  assert.equal(signal.aborted, true)
  pending.resolve({ success: true, sourceRecordCount: 1, records: [{ objectId: 'row1', fieldId: 'orders', value: 999, quality: 'good' }] })
  await settle()
  assert.deepEqual(state.fieldSamples, {})
  await state.changeCatalogSelection('selectedTableId', 'points_1'); await nextTick()
  assert.equal(state.displayedTableItems[0].previewValue, 0)
})

test('factory changes and unmount prevent old samples appearing in a new workspace', async t => {
  const { state, props, app } = fixture(t); await settle()
  const requests = []
  t.mock.method(adminApi, 'getDataTableRecords', request => { const work = deferred(); requests.push({ request, work }); return work.promise })
  await state.changeCatalogSelection('selectedTableId', 'external'); await nextTick()
  props.value = { ...props.value, factoryId: 'factory_b' }; await settle()
  assert.equal(requests[0].request.signal.aborted, true)
  requests[0].work.resolve({ success: true, sourceRecordCount: 1, records: [{ objectId: 'old', fieldId: 'orders', value: 999, quality: 'good' }] })
  await settle(); assert.deepEqual(state.fieldSamples, {})
  await state.changeCatalogSelection('selectedTableId', 'external'); await nextTick()
  const last = requests.at(-1); assert.equal(last.request.factoryId, 'factory_b')
  app.unmount(); assert.equal(last.request.signal.aborted, true)
  last.work.resolve({ success: true, records: [{ objectId: 'new', fieldId: 'orders', value: 100, quality: 'good' }] })
  await settle(); assert.deepEqual(state.fieldSamples, {})
})
