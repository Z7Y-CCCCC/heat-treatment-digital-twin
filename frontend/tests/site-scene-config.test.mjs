import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DEFAULT_STREET_IMAGE, DEFAULT_FACTORY_DESCRIPTION, normalizeSiteSceneConfig, orderedSiteWorkshops } from '../src/runtime/siteSceneConfig.js'

const require=createRequire(import.meta.url)
const {normalizeSettingValue}=require('../../backend/routes/settings.js')

test('per-factory site scene settings keep only uploaded images and unique building positions',()=>{
  assert.equal(DEFAULT_STREET_IMAGE,'/images/street-overview-v2.png')
  const url=`/uploads/appearance/${'a'.repeat(32)}.png`
  const saved=JSON.parse(normalizeSettingValue('site_scene_config',{streetImageUrl:url,buildingSlots:{workshop_a:2,workshop_b:0}}))
  assert.equal(saved.streetImageUrl,url)
  assert.deepEqual(saved.buildingSlots,{workshop_a:2,workshop_b:0})
  assert.equal(saved.streetTitle,'生产运营 · 街道视角')
  assert.equal(saved.factoryDescription,DEFAULT_FACTORY_DESCRIPTION)
  assert.equal(saved.showInfoPanel,true)
  assert.throws(()=>normalizeSettingValue('site_scene_config',{streetImageUrl:'javascript:bad'}),/图片/)
  assert.throws(()=>normalizeSettingValue('site_scene_config',{buildingSlots:{workshop_a:0,workshop_b:0}}),/重复/)
  assert.throws(()=>normalizeSettingValue('site_scene_config',{buildingSlots:{workshop_a:40}}),/无效/)
  assert.throws(()=>normalizeSettingValue('site_scene_config',{accent:'red'}),/强调色/)
  assert.throws(()=>normalizeSettingValue('site_scene_config',{showBrand:'no'}),/开关值/)
  assert.deepEqual(normalizeSiteSceneConfig({streetImageUrl:'javascript:bad',buildingSlots:{workshop_a:2,workshop_b:2}}).buildingSlots,{workshop_a:2})
  assert.equal(normalizeSiteSceneConfig({showBrand:false,accent:'#789abc'}).showBrand,false)
  assert.equal(normalizeSiteSceneConfig({showBrand:false,accent:'#789abc'}).accent,'#789abc')
  assert.equal(normalizeSiteSceneConfig({factoryDescription:'240'}).factoryDescription,DEFAULT_FACTORY_DESCRIPTION)
  assert.equal(normalizeSiteSceneConfig({factoryDescription:'点击已配置的车间建筑进入 Unity 车间模型；办公与公辅建筑仅作园区示意。'}).factoryDescription,DEFAULT_FACTORY_DESCRIPTION)
  assert.equal(JSON.parse(normalizeSettingValue('site_scene_config',{factoryDescription:'240'})).factoryDescription,DEFAULT_FACTORY_DESCRIPTION)
  assert.equal(JSON.parse(normalizeSettingValue('site_scene_config',{factoryDescription:'自定义厂区说明'})).factoryDescription,'自定义厂区说明')
})

test('configured buildings retain real workshop identities when reordered',()=>{
  const rows=[{id:'a',name:'第一车间'},{id:'b',name:'第二车间'},{id:'c',name:'第三车间'}]
  assert.deepEqual(orderedSiteWorkshops(rows,{}).map(item=>item.id),['a','b','c'])
  assert.deepEqual(orderedSiteWorkshops(rows,{buildingSlots:{b:0,c:1,a:2}}).map(item=>item.id),['b','c','a'])
})
