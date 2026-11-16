import { planLinePlacementTemplate, lineTemplateSpacingLimits, assertLineTemplateClearance, selectLineTemplateDistance } from './linePlacementTemplate.mjs'
import { syncLineRailLength } from './lineRailLength.mjs'

// Explicit recommendation only. Geometry is measured in line-local space;
// only lane-to-rail depth is recommended. Along-rail X positions and lengths
// belong to the user's manual layout, never to an automatic packing algorithm.
const clone = value => JSON.parse(JSON.stringify(value))
export function planGuidedLineArrangement(layout, kind, rows) {
  return { ...syncPlanRailLength(planLinePlacementTemplate(layout, kind, rows, undefined, { independentSides: true })), originalRows: clone(rows) }
}

function syncPlanRailLength(plan) {
  const layout=syncLineRailLength(plan.layout,plan.rows.filter(row=>row.laneId).map(row=>row.laneId))
  for(const row of plan.rows.filter(row=>row.railId)){
    const rail=layout.rails.find(rail=>rail.id===row.railId)
    if(rail&&Math.abs(row.x)>rail.length/2+1e-6)manual(`${name(row)}超出跟随设备线后的导轨长度，请先调整小车位置`,[row])
  }
  assertLineTemplateClearance(layout,plan.rows)
  return {...plan,layout}
}

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle))
const name = row => `「${row.name || row.id}」`
function manual(message, rows, details={}) {
  throw Object.assign(Error(`${message}。原布局未改动，请到三维调整。`), {
    code: 'LINE_AUTO_ALIGNMENT_REQUIRES_3D', deviceIds: [...new Set(rows.map(row => String(row.id)))], ...details
  })
}
function sides(layout, kind, rows) {
  if (!['single-negative','single-positive','dual'].includes(kind)) throw Error('请选择单侧或双侧布局')
  if (layout.rails.length !== 1 || layout.lanes.length < 1 || layout.lanes.length > 2) throw Error('自动对齐需要一条导轨和一至两条设备线；原布局未改动')
  const primary=layout.lanes.find(l=>l.id===layout.placementTemplate?.primaryLaneId)||layout.lanes[0],rail=layout.rails[0]
  const sign=kind==='dual'?(layout.placementTemplate?.primarySide==='negative'?-1:layout.placementTemplate?.primarySide==='positive'?1:primary.offsetZ<rail.offsetZ?-1:1):kind==='single-negative'?-1:1
  const result=new Map([[primary.id,sign]])
  for(const lane of layout.lanes.filter(l=>l.id!==primary.id)){
    if(kind!=='dual'&&rows.some(r=>r.laneId===lane.id)) manual(`${name(lane)}还有设备，不能切换为单侧`,rows.filter(r=>r.laneId===lane.id))
    if(kind==='dual')result.set(lane.id,-sign)
  }
  return {rail,lanes:result}
}
function port(row) {
  const p=row.loadingPort
  if(!p||[p.position,p.direction].some(v=>!Array.isArray(v)||v.length!==3||v.some(n=>!Number.isFinite(n)))
      ||Math.hypot(p.direction[0],p.direction[2])<.99||Math.abs(p.direction[1])>.01) manual(`${name(row)}没有可确认的已校准料口位置和水平方向`,[row])
  return p
}

// Only whole-model yaw is changed, never the authored port normal, model scale,
// PLC configuration, turntable capability, cart path, height or manual X order.
export function planLineMouthOrientations(layout, kind, rows) {
  const topology=sides(layout,kind,rows),fixed=rows.filter(r=>topology.lanes.has(r.laneId)),carts=rows.filter(r=>r.railId===topology.rail.id)
  if(!fixed.length) return []
  if(carts.length!==1) manual('同一导轨的小车对应关系需要确认，不能猜测服务方向',carts.length?carts:fixed)
  const occupied=new Set(fixed.map(r=>topology.lanes.get(r.laneId))),cart=carts[0]
  if(occupied.size>1) manual(`${name(cart)}需要服务两侧设备；必须先在三维确认真实双侧交接能力，不能自动把单向小车当成旋转小车`,[cart])
  const source=port(cart)
  if(!(cart.transferStroke>0)||!Array.isArray(cart.transferAxis)||cart.transferAxis.length!==3||cart.transferAxis.some(v=>!Number.isFinite(v))
      ||Math.abs(cart.transferAxis.reduce((sum,v,i)=>sum+v*source.direction[i],0))<.98) manual(`${name(cart)}的真实推拉行程或料口与推拉轴的关系尚未确认`,[cart])
  const cartSide=[...occupied][0],changes=[]
  for(const row of [...fixed,cart]){
    const p=port(row),desired=row===cart?cartSide:-topology.lanes.get(row.laneId)
    if(!Number.isFinite(row.rotationY))manual(`${name(row)}的模型朝向无法可靠读取`,[row])
    const delta=wrap((desired>0?0:Math.PI)-Math.atan2(p.direction[0],p.direction[2]))
    if(Math.abs(delta)>1e-5)changes.push({id:row.id,name:row.name||row.id,rotation_y:wrap(row.rotationY+delta),degrees:Math.round(delta*180/Math.PI*100)/100})
  }
  return changes
}

// Remeasure rotated CAD before calculating clearance. Per-device pivots differ:
// line offsets denote the common mouth plane, not identical model-centre Z.
export async function prepareGuidedLineArrangement(layout, kind, rows, { measure } = {}) {
  // A new empty line can still create its first rail through the existing
  // layout choice. There is no device pose/capability to guess at this stage.
  if(!rows.length)return {...planGuidedLineArrangement(layout,kind,rows),orientations:[],deviceTransforms:[],autoAligned:true}
  const originalRows=clone(rows),orientations=planLineMouthOrientations(layout,kind,rows)
  const rotated=orientations.length?await measure(orientations):clone(rows)
  if(rotated.length!==rows.length||rows.some(r=>!rotated.some(n=>n.id===r.id)))throw Error('重新测量的设备已改变，未应用自动对齐')
  const {rail,lanes}=sides(layout,kind,rotated),fixed=rotated.filter(r=>lanes.has(r.laneId)),cart=rotated.find(r=>r.railId===rail.id)
  if(!fixed.length)return {...planGuidedLineArrangement(layout,kind,rotated),originalRows,orientations,deviceTransforms:[],autoAligned:true}
  const occupiedSide=lanes.get(fixed[0].laneId),source=port(cart)
  if(source.direction[2]*occupiedSide<.999)manual(`${name(cart)}转向后仍未面向设备线`,[cart])
  const anchored=rotated.map(row=>{
    if(row.id===cart.id)return {...row,transferReach:{stroke:row.transferStroke*Math.abs(row.transferAxis[2]),positiveFaceZ:source.position[2],negativeFaceZ:source.position[2]}}
    if(!lanes.has(row.laneId))return {...row}
    const p=port(row),lane=layout.lanes.find(l=>l.id===row.laneId)
    if(p.direction[2]*-lanes.get(row.laneId)<.999)manual(`${name(row)}转向后仍未面向导轨`,[row])
    return {...row,z:lane.offsetZ-p.position[2],loadingFaceZ:p.position[2]}
  })
  const units=layout.sceneUnitsPerMeter??1,gap=.15
  for(const [laneId,sign] of lanes){
    const lane=layout.lanes.find(l=>l.id===laneId),members=anchored.filter(r=>r.laneId===laneId)
    if(!members.length)continue
    const limits=lineTemplateSpacingLimits(layout,anchored,[[lane,sign]],rail,gap,{measuredMinimum:true})
    const minimum=selectLineTemplateDistance(limits,units,{compact:anchored.some(r=>r.collisionBoxes?.length),railOffsetZ:rail.offsetZ,side:sign})
    if(minimum===null){
      const individual=members.map(row=>({row,...lineTemplateSpacingLimits(layout,[anchored.find(r=>r.id===cart.id),row],[[lane,sign]],rail,gap,{measuredMinimum:true})}))
      // After mouth alignment all members share the cart's maximum. That does
      // not make every member a blocker: identify independently infeasible
      // device intervals first, or the actual lower-bound contributors when
      // multiple constraints collectively leave no representable interval.
      let blocked=individual.filter(r=>selectLineTemplateDistance(r,units,{compact:anchored.some(r=>r.collisionBoxes?.length),railOffsetZ:rail.offsetZ,side:sign})===null)
      if(!blocked.length)blocked=individual.filter(r=>r.minimum>=limits.minimum-1e-6)
      const blockers=blocked.map(r=>r.row),meters=n=>Number((n/units).toFixed(6))
      const sourceNotes=blockers.filter(row=>row.loadingPort?.source==='instance'&&Math.abs(row.loadingPort.overrideYawDegrees)>1e-5)
        .map(row=>`${name(row)}${row.loadingPort.kind==='outlet'?'出料口':'进料口'}仍叠加本设备方向微调 ${Number(row.loadingPort.overrideYawDegrees.toFixed(3))}°`)
      const precision=Number((limits.minimum/units).toFixed(3))===Number((limits.maximum/units).toFixed(3))?6:3,display=n=>(n/units).toFixed(precision)
      manual(`${blockers.map(name).join('、')}在自动转向后仍无法兼顾外形留缝与原机构行程（导轨至料口需至少 ${display(limits.minimum)} 米，原机构允许的最大间距 ${display(limits.maximum)} 米）${sourceNotes.length?`。料口来源：${sourceNotes.join('；')}；模型默认框选不会清除此设备微调`:''}`,blockers,{
        alignmentDiagnostics:{laneId,cartIds:[String(cart.id)],requiredDistanceMeters:meters(limits.minimum),availableDistanceMeters:meters(limits.maximum),
          devices:blocked.map(r=>({id:String(r.row.id),requiredDistanceMeters:meters(r.minimum),availableDistanceMeters:meters(r.maximum),
            ...(r.row.loadingPort?.source?{portSource:r.row.loadingPort.source,overrideYawDegrees:r.row.loadingPort.overrideYawDegrees}:{})}))}
      })
    }
  }
  let plan
  try{plan=syncPlanRailLength(planLinePlacementTemplate(layout,kind,anchored,gap,{independentSides:true,measuredMinimum:true}))}
  catch(error){manual(error.message,fixed)}
  const changes=new Map(orientations.map(p=>[p.id,p]))
  return {...plan,originalRows,orientations,autoAligned:true,deviceTransforms:plan.rows.map(row=>({id:row.id,pos_z:row.z,
    ...(changes.has(row.id)?{rotation_y:changes.get(row.id).rotation_y}:{})}))}
}
