// Compare real Unity GPU transforms against the production Three scene's CAD
// geometry and shared BOOL estimator. Rendering itself was checked separately.
// Run with node --experimental-test-module-mocks; no backend/PLC access.
import assert from 'node:assert/strict'
import {mock} from 'node:test'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import {loadFixtureModel} from './adaptive-transfer-fixture.mjs'
import {buildLineSimulation} from '../frontend/src/three/lineSimulation.js'
import {newTransferCycle,advanceTransferCycle} from '../shared/transferCycle.mjs'
import {sampleAdaptiveTransferPath} from '../shared/adaptiveTransferPath.mjs'

class GeometryScene {
 constructor(){this.scene=new T.Scene();this.camera=new T.PerspectiveCamera(38,1,.01,100);this.camera.position.set(4,6,10);this.renderer={domElement:{style:{}}};this.controls={target:new T.Vector3(),mouseButtons:{},touches:{},update(){}}}
 setCutaway(){}
 release(root){root.traverse(n=>{n.geometry?.dispose();[].concat(n.material||[]).forEach(m=>m.dispose())})}
 dispose(){this.release(this.scene)}
}
mock.module('../frontend/src/three/CadMotionScene.js',{namedExports:{CadMotionScene:GeometryScene}})
mock.module('../frontend/src/runtime/ConfiguredFactoryScene.js',{namedExports:{loadConfiguredGltf:async url=>({scene:(await loadFixtureModel(url.match(/(cad_[a-z0-9_]+)\.glb$/)[1])).root})}})
globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},fillText(){}})})}
const {LineSimulationScene}=await import('../frontend/src/three/LineSimulationScene.js')
const directory=path.resolve(process.argv[2]||'output/playwright/adaptive-transfer/final-20261111')
const report={success:false,scope:'Actual Unity GPU cargo positions versus production Three CAD path + shared BOOL cycle; not PLC latency',traces:0,samples:0,maxErrorMeters:0}
try{
 const fixtures=JSON.parse(await readFile(path.join(directory,'fixtures.json'),'utf8')),native=JSON.parse(await readFile(path.join(directory,'unity-graphics-result.json'),'utf8'))
 assert.equal(native.success,true);assert.equal(native.actualUnityRendering,true);assert.deepEqual(native.errors,[])
 const keys=new Set()
 for(const fixture of fixtures){
  const plan=buildLineSimulation(fixture.devices,fixture.models,{process:false}),scene=new LineSimulationScene()
  try{
   await scene.loadPlan(plan,fixture.lines,fixture.workshops,'site')
   const cart=scene.entries.get(plan.cart.id),config=cart.savedLink.cycle,units=fixture.evidence.units
   for(let i=0;i<config.stations.length;i++)for(const pickup of [false,true]){
    const key=[fixture.evidence.kind,fixture.evidence.micro,units,i+1,pickup].join('/');assert.equal(keys.has(key),false);keys.add(key)
    const trace=native.traces.find(t=>t.kind===fixture.evidence.kind&&t.micro===fixture.evidence.micro&&Math.abs((t.units??1)-units)<1e-6&&t.station===i+1&&t.pickup===pickup)
    assert.ok(trace,'Missing Unity trace: '+key);assert.equal(trace.positions.length,60);assert.equal(trace.retractPositions.length,75)
    const geometry=plan.transferPaths[config.stations[i].targetDeviceId],state=newTransferCycle(),input={valid:true,docked:true,start:true,pickup,sourcePresent:!pickup,targetPresent:pickup,mouthFraction:geometry.mouthFraction}
    function compare(actual){
     const expected=sampleAdaptiveTransferPath(geometry,state.cargo);expected[1]+=cart.savedLink.materialSize[1]/2;expected[0]*=-1
     const error=Math.hypot(...actual.map((n,j)=>n/units-expected[j]));report.maxErrorMeters=Math.max(report.maxErrorMeters,error);report.samples++
     assert.ok(error<.0002,`${key}: ${state.phase} Unity/Three cargo mismatch ${error} m`)
    }
    for(const actual of trace.positions){advanceTransferCycle(state,input,config.extendSeconds/60,config);compare(actual)}
    advanceTransferCycle(state,input,1,config);assert.equal(state.phase,'wait');compare(trace.mouthPosition)
    Object.assign(input,{sourcePresent:pickup,targetPresent:!pickup});advanceTransferCycle(state,input,0,config)
    for(const actual of trace.retractPositions){advanceTransferCycle(state,input,(config.latchSeconds+config.retractSeconds)/75,config);compare(actual)}
    assert.equal(state.phase,'done');assert.equal(trace.diagnostic.phase,'done');assert.equal(trace.diagnostic.bothPresenceConfirmed,true);report.traces++
   }
  }finally{scene.dispose()}
 }
 assert.equal(native.traces.length,report.traces);report.success=true
}catch(error){report.error=error.stack;process.exitCode=1}
await writeFile(path.join(directory,'engine-parity-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
