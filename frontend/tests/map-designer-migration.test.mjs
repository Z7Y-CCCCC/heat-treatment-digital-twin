import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeMapDesignerDocument,createMapDesignerContext } from '../src/runtime/mapDesigner.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import {createRequire} from 'node:module'
const {normalizeDocument,validateDocument}=createRequire(import.meta.url)('../../backend/utils/dashboardDocument.js')
test('legacy map panels become ordinary selectable widgets with independent per-level membership and no destructive writes',()=>{
 const source=normalizeDashboardDocument({widgets:[{id:'owned',type:'text',frame:{x:123,y:54,width:99,height:77},content:{text:'自建'},data:{mode:'static'},visibility:{viewIds:['map_city']}}]}),before=JSON.stringify(source)
 const doc=normalizeDashboardDocument(upgradeMapDesignerDocument(source,{levels:{city:{layout:{facts:{x:8,y:24}},showPanel:false}}}))
 assert.equal(JSON.stringify(source),before);assert.deepEqual(doc.widgets.find(w=>w.id==='owned'),source.widgets.find(w=>w.id==='owned'))
 assert.equal(doc.metadata.unifiedMapDesigner,1);assert.equal(upgradeMapDesignerDocument(doc,{}),doc)
 const facts=doc.widgets.find(w=>w.id==='map_city_facts');assert.equal(facts.type,'hud_kpi_panel');assert.equal(facts.frame.x,153.6);assert.equal(facts.frame.y,259.2)
 const city=doc.scene.views.find(v=>v.id==='map_city');assert.ok(city.componentState.show.includes(facts.id));assert.ok(city.componentState.hide.includes('map_city_regions'))
 assert.equal(doc.widgets.find(w=>w.id==='map_world_facts').frame.x,57.6)
 doc.widgets=doc.widgets.filter(w=>w.id!==facts.id);assert.ok(!upgradeMapDesignerDocument(doc,{}).widgets.some(w=>w.id===facts.id),'user deletion is not silently reversed')
})
test('each legacy HTTP metric preserves its own explicit connection, path and interval in a standard widget',()=>{
 const binding={mode:'http_api',connectionId:'erp',apiPath:'/summary',jsonPath:'data.count',refreshMs:9000}
 const source=normalizeDashboardDocument({}),doc=upgradeMapDesignerDocument(source,{levels:{world:{dataBindings:{factsFactoryCount:binding}}}})
 const value=doc.widgets.find(w=>w.id==='map_world_facts_factsFactoryCount');assert.equal(value.type,'value');assert.equal(value.data.connectionId,'erp');assert.equal(value.data.jsonPath,'data.count');assert.equal(value.data.refreshMs,9000)
 assert.equal(doc.widgets.find(w=>w.id==='map_country_facts').type,'hud_kpi_panel')
})
test('map context is derived from actual configured factories and changes with the selected region, not sample counts',()=>{
 const config={factories:[{id:'a',name:'A',enabled:true,location:{country:'CHN',regionCode:'120000',cityCode:'120100',districtCode:'120101'},workshopCount:2,lineCount:3,deviceCount:4},{id:'b',name:'B',enabled:true,location:{country:'KOR',regionName:'首尔'},workshopCount:1,lineCount:1,deviceCount:2}]}
 assert.deepEqual(createMapDesignerContext(null),{})
 const world=createMapDesignerContext(config);assert.equal(world.factsFactoryCount,2);assert.equal(world.dockDevices,6);assert.equal(world.records.length,2)
 const country=createMapDesignerContext(config,{level:'country',code:'CHN'});assert.equal(country.factsFactoryCount,1);assert.equal(country.factsDeviceCount,4)
 const district=createMapDesignerContext(config,{level:'district',code:'120101'});assert.equal(district.records[0].kind,'factory');assert.equal(district.records[0].id,'a')
 const empty=createMapDesignerContext(config,{level:'district',code:'999999'});assert.equal(empty.factsFactoryCount,0);assert.deepEqual(empty.records,[])
})

test('migration of a full legacy 500-widget project survives backend save normalization without silent truncation',()=>{
 const source=normalizeDashboardDocument({projectId:'p',sceneId:'scene_factory_overview',widgets:Array.from({length:498},(_,i)=>({id:`authored_${i}`,type:'text',content:{text:`保留${i}`}}))})
 assert.equal(source.widgets.length,500)
 const migrated=normalizeDashboardDocument(upgradeMapDesignerDocument(source,{})),saved=normalizeDocument(migrated)
 assert.ok(migrated.widgets.length>500);assert.equal(saved.widgets.length,migrated.widgets.length)
 for(const w of migrated.widgets)assert.ok(saved.widgets.some(s=>s.id===w.id),`missing ${w.id}`)
 assert.doesNotThrow(()=>validateDocument(saved))
})

test('generated map widget IDs are deterministic and globally unique between different factory scenes',()=>{
 const first=upgradeMapDesignerDocument(normalizeDashboardDocument({sceneId:'factory_a_scene'}),{})
 const second=upgradeMapDesignerDocument(normalizeDashboardDocument({sceneId:'factory_b_scene'}),{})
 const ids=doc=>doc.widgets.filter(w=>w.id.startsWith('map_')).map(w=>w.id)
 assert.equal(ids(first).length,30);assert.equal(ids(first).some(id=>ids(second).includes(id)),false)
 assert.deepEqual(ids(first),ids(upgradeMapDesignerDocument(normalizeDashboardDocument({sceneId:'factory_a_scene'}),{})))
 assert.ok(ids(first).every(id=>id.length<=128))
})
