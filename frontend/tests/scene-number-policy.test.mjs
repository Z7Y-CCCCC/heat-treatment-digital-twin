import test from 'node:test'
import assert from 'node:assert/strict'
import {sceneUnitsEquivalent,displayCoordinateNumber,displaySceneUnits} from '../../shared/sceneNumberPolicy.mjs'
import {assertLineMovementUnits} from '../../shared/lineRailSpacing.mjs'

test('Float32 round-trip noise is not a changed calibration; real differences still have an actionable short error',()=>{
 for(const value of [.79999999616123,Math.fround(.8),.80000000001]){
  const movement={sceneUnitsPerMeter:value},line={sceneUnitsPerMeter:.8},before=JSON.stringify({movement,line})
  assert.equal(sceneUnitsEquivalent(value,.8),true)
  assert.equal(assertLineMovementUnits(movement,line),.8)
  assert.equal(JSON.stringify({movement,line}),before,'Comparing/displaying does not rewrite stored configuration')
 }
 for(const value of [.81,1,0,-1,NaN,Infinity])assert.equal(sceneUnitsEquivalent(value,.8),false)
 assert.throws(()=>assertLineMovementUnits({sceneUnitsPerMeter:.81},{sceneUnitsPerMeter:.8},'料车'),/料车.*改为 0\.8 后保存/)
 assert.equal(sceneUnitsEquivalent(1e-30,2e-30),false,'Tolerance is relative, not an absolute default')
})

test('coordinates show two decimals at most without Float32 tails or negative zero',()=>{
 for(const [value,expected] of [[17.49999968,'17.5'],[6.999986399999998,'7'],[-6.99997999,'-7'],[.098441,'0.1'],[16.700002256,'16.7'],[-.00001,'0'],[1.236,'1.24']])assert.equal(displayCoordinateNumber(value),expected)
 assert.equal(displaySceneUnits(.79999999616123),'0.8')
 assert.equal(displaySceneUnits(.7999993351999881),'0.8','Derived distance sums must not reintroduce tails after saving')
 assert.equal(displaySceneUnits(1e-30),'1e-30')
 assert.equal(displayCoordinateNumber(NaN),'')
 for(const value of ['',null,undefined,false,' ']){assert.equal(displayCoordinateNumber(value),'');assert.equal(displaySceneUnits(value),'')}
})
