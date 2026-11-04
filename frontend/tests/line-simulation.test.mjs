import test from 'node:test'
import assert from 'node:assert/strict'
import {simulationLineMembers,simulationCapabilities,buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'

test('tempering heats with its door closed and drives only the required mechanisms during loading, holding and unloading',()=>{
 const model={id:'cad_tempering_furnace_091300',file_path:'/tempering.glb'}
 const station={id:'tempering',name:'回火炉',model_type:model.id,line_id:'A'}
 const allModels=[...models,model],plan=buildLineSimulation([devices[0],station],allModels)
 assert.deepEqual(plan.steps.map(step=>step.kind),['approach','open','feed','retract','close','tempering_heat','tempering_hold','open_out','pickup_extend','reclaim','close_out'])
 assert.ok(plan.steps.every(step=>step.label))
 const middle=kind=>{const step=plan.steps.find(item=>item.kind===kind);return sampleLineSimulation(plan,step.start+step.duration/2)}
 const feeding=middle('feed').states.tempering
 assert.equal(feeding.door,1);assert.ok(feeding.conveyTime>0);assert.equal(feeding.circulationTime,0)
 for(const kind of ['tempering_heat','tempering_hold']){
  const frame=middle(kind),state=frame.states.tempering
  assert.equal(state.door,0);assert.equal(frame.cart.feed,0);assert.equal(frame.material.holder,station.id)
  assert.equal(state.heat,true);assert.ok(state.circulationTime>0);assert.equal(state.conveyTime,4,'rollers must stop while heating')
  sampleLineSimulation(plan,plan.total);assert.deepEqual(middle(kind),frame,'seeking must be deterministic')
 }
 assert.ok(middle('reclaim').states.tempering.conveyTime<4,'rollers reverse when the cart takes the load back')
 const final=sampleLineSimulation(plan,plan.total).states.tempering
 assert.equal(final.heat,false);assert.equal(final.door,0);assert.equal(final.conveyTime,0)
 assert.ok(!buildLineSimulation([devices[0],station],allModels,{process:false}).steps.some(step=>step.kind.startsWith('tempering_')))
})
const models=['cad_transfer_cart_101300','cad_cleaner_170700','cad_water_cooling_tank_471000','cad_fixed_load_table_112200'].map(id=>({id,file_path:`/${id}.glb`}))
const devices=[{id:'cart',name:'料车实例',model_type:models[0].id,line_id:'A'},
 {id:'cleaner1',name:'一号清洗机',model_type:models[1].id,line_id:'A'},
 {id:'cleaner2',name:'二号清洗机',model_type:models[1].id,line_id:'B'},
 {id:'tank',name:'水冷槽',model_type:models[2].id,line_id:'A'}]
test('line membership is based on instances and explicit line binding, including rail-bound carts',()=>{
 const cart={id:'rail-cart',model_type:models[0].id,instance_config:JSON.stringify({railLineId:'A'})}
 assert.deepEqual(simulationLineMembers([...devices,cart],'A').map(d=>d.id).sort(),['cart','cleaner1','rail-cart','tank'])
 assert.deepEqual(simulationLineMembers(devices,'B').map(d=>d.id),['cleaner2'])
 assert.deepEqual(simulationLineMembers([...devices,{id:'unassigned'}],''),[])
 assert.equal(simulationLineMembers([{...cart,line_id:'B'}],'A').length,0)
})
test('cart-door-chain-material sequence and downstream process are coordinated and seekable',()=>{
 const source=JSON.stringify(devices),plan=buildLineSimulation([devices[0],devices[1],devices[3]],models)
 const mid=(id,kind)=>{const step=plan.steps.find(s=>s.deviceId===id&&s.kind===kind);return sampleLineSimulation(plan,step.start+step.duration/2)}
 let f=mid('cleaner1','feed');assert.equal(f.states.cleaner1.door,1);assert.equal(f.cart.feed,.5);assert.equal(f.material.to,'cleaner1')
 f=mid('cleaner1','retract');assert.equal(f.material.holder,'cleaner1');assert.equal(f.states.cleaner1.door,1)
 f=mid('cleaner1','spray');assert.equal(f.states.cleaner1.door,0);assert.equal(f.states.cleaner1.level,1);assert.equal(f.states.cleaner1.spray,true);assert.equal(f.cart.feed,0)
 f=mid('tank','approach');assert.equal(f.material.holder,'cart');assert.equal(f.cart.from,'cleaner1');assert.equal(f.states.cleaner1.door,0);assert.equal(f.states.cleaner1.spray,false)
 f=mid('tank','quench');assert.equal(f.states.tank.door,0);assert.equal(f.states.tank.basket,1);assert.equal(f.states.tank.run,true)
 f=mid('tank','drip');assert.equal(f.states.tank.basket,0);assert.equal(f.states.tank.drip,true)
 const end=sampleLineSimulation(plan,plan.total);assert.equal(end.complete,true);assert.equal(end.material.holder,'cart');assert.equal(end.cart.feed,0);assert.equal(end.states.tank.door,0)
 const sought=sampleLineSimulation(plan,13);sampleLineSimulation(plan,plan.total);assert.deepEqual(sampleLineSimulation(plan,13),sought)
 assert.equal(JSON.stringify(devices),source)
})
test('chosen instances preserve order, identical models remain independent, and invalid plans fail explicitly',()=>{
 const peer={...devices[1],id:'cleaner-peer',name:'同型另一台'}
 const plan=buildLineSimulation([peer,devices[1]],models)
 assert.equal(plan.stations[0].id,'cleaner-peer');assert.ok(plan.steps.some(s=>s.deviceId==='cleaner1'))
 const step=plan.steps.find(s=>s.deviceId==='cleaner1'&&s.kind==='spray'),f=sampleLineSimulation(plan,step.start+1)
 assert.equal(f.states['cleaner-peer'].spray,false);assert.equal(f.states.cleaner1.spray,true)
 assert.throws(()=>buildLineSimulation([],models),/至少选择/)
 assert.throws(()=>buildLineSimulation([devices[0],{...devices[0],id:'other-cart'},devices[1]],models),/一台料车/)
 assert.throws(()=>buildLineSimulation([{id:'missing',model_type:'missing'}],models),/缺少/)
 const staticModel={id:'static',file_path:'/static.glb'},d={id:'static-instance',model_type:'static'}
 assert.equal(simulationCapabilities(d,[staticModel]).animated,false)
 assert.equal(buildLineSimulation([d],[staticModel]).steps[0].kind,'display')
 const transfer=buildLineSimulation([devices[0],devices[1]],models,{process:false});assert.equal(transfer.steps.some(s=>s.kind==='spray'),false)
})
test('600 multipurpose furnace closes the intermediate gate for heating and quenching, and returns charge before lowering',()=>{
 const model={id:'cad_multipurpose_furnace_082000',file_path:'/600.glb'},furnace={id:'600-instance',name:'600 多用炉',model_type:model.id}
 const plan=buildLineSimulation([devices[0],furnace],[...models,model])
 assert.equal(plan.steps.find(step=>step.kind==='drip').label,'沥油')
 assert.equal(buildLineSimulation([devices[0],devices[3]],models).steps.find(step=>step.kind==='drip').label,'沥水')
 const at=kind=>{const step=plan.steps.find(s=>s.kind===kind);return sampleLineSimulation(plan,step.start+step.duration/2).states[furnace.id]}
 let s=at('hot_feed');assert.equal(s.gate,1);assert.equal(s.door,0);assert.equal(s.chamber,.5);assert.equal(s.basket,0)
 s=at('heat_treat');assert.equal(s.gate,0);assert.equal(s.chamber,1);assert.equal(s.heat,true);assert.ok(s.circulationTime>0)
 s=at('hot_return');assert.equal(s.gate,1);assert.equal(s.chamber,.5)
 s=at('quench');assert.equal(s.gate,0);assert.equal(s.door,0);assert.equal(s.chamber,0);assert.equal(s.basket,1);assert.ok(s.stirTime>0)
 s=at('reclaim');assert.equal(s.basket,0);assert.equal(s.chamber,0);assert.equal(s.door,1)
})
