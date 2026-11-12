// Packaged models + synthetic screenshot-like coordinates, never operator data.
import {loadFixtureModel,createAdaptiveTransferFixture} from './adaptive-transfer-fixture.mjs'
export async function createLinkageUsabilityFixture(){
 const base=await createAdaptiveTransferFixture({kind:'dual',units:.8})
 const specs=[['1号多用炉','cad_multipurpose_furnace_082000'],['2号多用炉','cad_multipurpose_furnace_082000'],['升降备料台','cad_lifting_load_table_111400'],['2号备料台','cad_fixed_load_table_112200'],['1号回火炉','cad_tempering_furnace_091300'],['清洗机','cad_cleaner_170700'],['1号风冷台','cad_air_cooling_table_115800ht'],['1号水冷槽','cad_water_cooling_tank_471000']]
 const models=[base.models[0]],ids=[...new Set(specs.map(s=>s[1]))]
 for(const id of ids)models.push((await loadFixtureModel(id)).model)
 models.forEach(m=>m.default_scale=1)
 const layout=structuredClone(base.lines[0].layout);delete layout.placementTemplate
 layout.rails[0].length=60;layout.rails[0].offsetZ=.5;layout.lanes.forEach((l,i)=>{l.length=60;l.offsetZ=i?8:-7})
 const xs=[-20.99998053,-6.99997999,6.999986399999998,20.999983800000005]
 const targets=specs.map(([name,model_type],i)=>({id:'station_'+(i+1),name,model_type,line_id:'fixture_line',coordinate_space:'line_local',pos_x:xs[i%4],pos_y:0,pos_z:i<4?-7:8,rotation_y:i<4?0:Math.PI,scale:2.5,instance_config:{laneId:'lane'+(i<4?0:1),laneLineId:'fixture_line',stationNumber:i+1}}))
 const cart=structuredClone(base.devices[0]);cart.name='料车';cart.pos_x=-21;cart.pos_y=.098441;cart.pos_z=.5;cart.scale=2.5
 cart.instance_config.role='transfer_cart'
 cart.instance_config.movement={...cart.instance_config.movement,sceneUnitsPerMeter:.79999999616123,stationInputMeaning:'current',simulationEnabled:false,arrivalPositionPointId:'',start:{x:-21,y:.098441,z:.5},end:{x:21,y:.098441,z:.5},stations:targets.map((d,i)=>({value:i+1,label:`${i+1}号工位 · ${d.name}`,anchorDeviceId:d.id,deviceLineKey:`fixture_line::lane${i<4?0:1}`,deviceLineName:`设备线 ${i<4?1:2}`,distanceMeters:i%4?17.49999968:0,position:{x:d.pos_x,y:.098441,z:.5}}))}
 // This saved strict cycle deliberately does not cover the added stations.
 // Ordinary demos must not require users to repair it before playing.
 cart.instance_config.animationBindings.transferLink.cycle.extendSeconds=17
 cart.lineLayout=layout;cart.dataPoints=[{id:'101',device_id:cart.id,name:'当前位置',category:'analog',field_name:'position',data_type:'WORD',access_type:'READ'},{id:'102',device_id:cart.id,name:'实际移动',category:'motors',field_name:'moving',data_type:'BOOL',access_type:'READ'}]
 return {models,devices:[cart,...targets],lines:[{...base.lines[0],name:'双侧八设备 · 一键演示',layout}],workshops:base.workshops,evidence:{virtualSignals:true,operatorWrites:0,screenshotLike:true,units:.8,movementUnits:.79999999616123}}
}
