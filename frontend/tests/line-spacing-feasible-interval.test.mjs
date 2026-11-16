import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareGuidedLineArrangement } from '../../shared/lineGuidedArrangement.mjs'
import { assertLineTemplateClearance, lineTemplateSpacingLimits, planLinePlacementTemplate, selectLineTemplateDistance } from '../../shared/linePlacementTemplate.mjs'

const clone=structuredClone
function narrowFixture(units=1,side=-1,railOffsetZ=0){
  const box={minX:-units,maxX:units,minY:0,maxY:2*units,minZ:-units,maxZ:units}
  const layout={sceneUnitsPerMeter:units,lanes:[{id:'a',offsetZ:railOffsetZ+side*5*units,length:100}],rails:[{id:'r',offsetZ:railOffsetZ,length:100}]}
  const cart={id:'cart',name:'小车',railId:'r',x:-20,y:0,z:railOffsetZ,...box,collisionBoxes:[box],rotationY:0,
    loadingPort:{position:[0,units,side*.805*units],direction:[0,0,side]},transferStroke:1.085*units,transferAxis:[0,0,side],
    transferReach:{stroke:1.085*units,positiveFaceZ:.805*units,negativeFaceZ:-.805*units}}
  const fixedBox={...box,...(side<0?{maxZ:1.711*units}:{minZ:-1.711*units})}
  const fixed={id:'fixed',name:'工位',laneId:'a',x:0,y:0,z:layout.lanes[0].offsetZ-side*units,...fixedBox,collisionBoxes:[fixedBox],rotationY:0,
    loadingPort:{position:[0,units,-side*units],direction:[0,0,-side]},loadingFaceZ:-side*units}
  return {layout,rows:[fixed,cart]}
}
function assertFeasible(plan,side,laneId='a'){
  const rail=plan.layout.rails[0],lane=plan.layout.lanes.find(l=>l.id===laneId)
  const limits=lineTemplateSpacingLimits(plan.layout,plan.rows,[[lane,side]],rail,.15,{measuredMinimum:true})
  const distance=side*(lane.offsetZ-rail.offsetZ)
  assert.ok(distance>=limits.minimum-1e-12,`${distance} must retain measured clearance ${limits.minimum}`)
  assert.ok(distance<=limits.maximum,`${distance} must not exceed original reach ${limits.maximum}`)
  assert.doesNotThrow(()=>assertLineTemplateClearance(plan.layout,plan.rows))
}

test('only the independently unreachable member is diagnosed, not seven members sharing the cart maximum',async()=>{
  const f=narrowFixture(.8),cart=f.rows[1]
  cart.transferStroke=2.17;cart.loadingPort.position[2]=-1.417539438
  const fixed=Array.from({length:8},(_,i)=>{
    const base=clone(f.rows[0]),maxZ=i===5?5.4930004061-.12:1.4
    return {...base,id:i===5?'bl2':`fixed-${i}`,name:i===5?'2号备料台':`可达工位 ${i+1}`,x:i*20,
      maxZ,collisionBoxes:[{...base.collisionBoxes[0],maxZ}],loadingPort:{position:[0,1,.8],direction:[0,0,1]}}
  })
  const rows=[...fixed,cart],before=clone({layout:f.layout,rows})
  await assert.rejects(prepareGuidedLineArrangement(f.layout,'single-negative',rows),error=>{
    assert.equal(error.code,'LINE_AUTO_ALIGNMENT_REQUIRES_3D')
    assert.deepEqual(error.deviceIds,['bl2'])
    assert.match(error.message,/2号备料台.*导轨至料口需至少 6\.866 米.*允许的最大间距 4\.484 米/)
    assert.doesNotMatch(error.message,/可达工位/)
    assert.deepEqual(error.alignmentDiagnostics.cartIds,['cart'])
    assert.equal(error.alignmentDiagnostics.requiredDistanceMeters,6.866251)
    assert.equal(error.alignmentDiagnostics.availableDistanceMeters,4.484424)
    assert.deepEqual(error.alignmentDiagnostics.devices.map(row=>row.id),['bl2'])
    return true
  })
  assert.deepEqual({layout:f.layout,rows},before)
})

test('safe non-grid spacing is selected on either side and with non-unit display calibration',async()=>{
  for(const units of [1,.8,2.5])for(const side of [-1,1]){
    const f=narrowFixture(units,side,.1234567),before=clone(f)
    const plan=await prepareGuidedLineArrangement(f.layout,side<0?'single-negative':'single-positive',f.rows)
    assert.deepEqual(f,before)
    const distance=side*(plan.layout.lanes[0].offsetZ-plan.layout.rails[0].offsetZ)/units
    assert.ok(distance>=1.861-1e-12&&distance<=1.89)
    assert.ok(Math.abs(distance/.05-Math.round(distance/.05))>.01,'The feasible interval contains no 50 mm grid point')
    assertFeasible(plan,side)
    for(const row of plan.rows){const old=f.rows.find(r=>r.id===row.id);assert.equal(row.x,old.x);assert.equal(row.y,old.y)}
    const again=await prepareGuidedLineArrangement(plan.layout,side<0?'single-negative':'single-positive',plan.rows)
    assert.deepEqual(again.layout,plan.layout)
    for(const patch of again.deviceTransforms){
      const first=plan.deviceTransforms.find(row=>row.id===patch.id)
      assert.deepEqual(Object.keys(patch),Object.keys(first))
      assert.ok(Math.abs(patch.pos_z-first.pos_z)<1e-12,'Only arithmetic round-off, never a layout-grid step, is permissible on repeat')
    }
  }
})

test('independent dual sides each keep their original narrow reach interval and rail reference',()=>{
  for(const units of [1,.8,2.5]){
    const f=narrowFixture(units,-1,.1234567),other=narrowFixture(units,1,.1234567)
    f.layout.lanes.push({...other.layout.lanes[0],id:'b'})
    f.rows.push({...other.rows[0],id:'other',laneId:'b'})
    const before=clone(f),plan=planLinePlacementTemplate(f.layout,'dual',f.rows,.15,{independentSides:true,measuredMinimum:true})
    assert.deepEqual(f,before)
    assertFeasible(plan,-1);assertFeasible(plan,1,'b')
    assert.equal(plan.layout.rails[0].offsetZ,f.layout.rails[0].offsetZ)
    assert.equal(plan.layout.placementTemplate.independentSides,true)
  }
})

test('the preferred grid remains unchanged when feasible; sub-microunit intervals retain safe finite precision',()=>{
  assert.equal(selectLineTemplateDistance({minimum:1.251,maximum:1.35},1),1.3)
  const limits={minimum:1.2500000001,maximum:1.2500000002}
  const selected=selectLineTemplateDistance(limits,1)
  assert.ok(selected>=limits.minimum&&selected<=limits.maximum)
  assert.equal(selected,1.2500000001)
  assert.equal(selectLineTemplateDistance({minimum:1.251,maximum:1.25},1),null)
})

test('coupled mouth-aligned sides retain a sub-microunit interval without truncating the opposite coordinate',()=>{
  const f=narrowFixture(1,-1,.1234567),other=narrowFixture(1,1,.1234567)
  f.layout.lanes.push({...other.layout.lanes[0],id:'b'})
  f.rows.push({...other.rows[0],id:'other',laneId:'b'})
  f.rows[1].transferReach.stroke=1.2500000002-.805
  for(const row of f.rows.filter(row=>row.laneId)){
    const side=row.laneId==='a'?-1:1,edge=(1.2500000001-.15)*-side
    row[side<0?'maxZ':'minZ']=edge
    row.collisionBoxes[0][side<0?'maxZ':'minZ']=edge
  }
  const before=clone(f),plan=planLinePlacementTemplate(f.layout,'dual',f.rows,.15,{measuredMinimum:true})
  assert.deepEqual(f,before)
  assertFeasible(plan,-1);assertFeasible(plan,1,'b')
  const rail=plan.layout.rails[0],left=rail.offsetZ-plan.layout.lanes[0].offsetZ,right=plan.layout.lanes[1].offsetZ-rail.offsetZ
  assert.ok(Math.abs(left-right)<1e-12)
})

test('a truly empty reach interval still refuses the whole proposal without mutating poses or layouts',async()=>{
  const f=narrowFixture(),before=clone(f)
  f.rows[1].transferStroke=.5
  const source=clone(f)
  await assert.rejects(prepareGuidedLineArrangement(f.layout,'single-negative',f.rows),error=>error.code==='LINE_AUTO_ALIGNMENT_REQUIRES_3D'&&error.deviceIds.includes('fixed'))
  assert.deepEqual(f,source)
  assert.notDeepEqual(f,before)
})
