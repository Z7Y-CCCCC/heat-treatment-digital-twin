// Presentation-only templates: the rail is the fixed reference. No PLC,
// movement, model scale, rotation, or loading-port calibration is changed.
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => { throw Object.assign(Error(message), { code: 'LINE_PLACEMENT_INVALID', statusCode: 400 }) }
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000
const boxes=row=>row.collisionBoxes?.length?row.collisionBoxes:[row]
const overlaps=(a,pa,b,pb)=>['X','Y','Z'].every(axis=>Math.min(a[axis.toLowerCase()]+pa['max'+axis],b[axis.toLowerCase()]+pb['max'+axis])-Math.max(a[axis.toLowerCase()]+pa['min'+axis],b[axis.toLowerCase()]+pb['min'+axis])>.00001)
export const LINE_PLACEMENT_TEMPLATES = Object.freeze([
  { id: 'single-negative', label: '单侧上排' },
  { id: 'single-positive', label: '单侧下排' },
  { id: 'dual', label: '双侧设备线' }
])

export function resolveLinePlacementTemplate(layout) {
  if (layout.placementTemplate === undefined) return layout // Never migrate a saved layout on read.
  const t = layout.placementTemplate
  if (!t || typeof t !== 'object' || Array.isArray(t) || t.version !== 1
      || !LINE_PLACEMENT_TEMPLATES.some(row => row.id === t.kind)
      || !['negative', 'positive'].includes(t.primarySide) || !finite(t.railOffsetZ)
      || !finite(t.minimumDistance) || t.minimumDistance <= 0) fail('产线布局模板无效')
  if (t.compact !== undefined && typeof t.compact !== 'boolean'
      || t.clearanceGapMeters !== undefined && (!Number.isFinite(t.clearanceGapMeters) || t.clearanceGapMeters <= 0 || t.clearanceGapMeters > 10)) fail('产线布局留缝设置无效')
  const rails = layout.rails || [], lanes = layout.lanes || []
  if (rails.length !== 1 || rails[0].id !== t.railId || rails[0].spacing != null
      || rails[0].offsetZ !== t.railOffsetZ) fail('模板中的小车导轨为固定基准，不能移动或关联旧式跟随间距')
  if (lanes.length !== (t.kind === 'dual' ? 2 : 1) || lanes.filter(row => row.id === t.primaryLaneId).length !== 1
      || t.kind !== 'dual' && t.primarySide !== (t.kind === 'single-negative' ? 'negative' : 'positive')) fail('模板设备线数量或主设备线无效')
  const primary = lanes.find(row => row.id === t.primaryLaneId), sign = t.primarySide === 'negative' ? -1 : 1
  const distance = (primary.offsetZ - t.railOffsetZ) * sign
  if (!finite(distance) || distance < t.minimumDistance - 1e-7 || Math.fround(primary.offsetZ) === Math.fround(t.railOffsetZ)) fail('第一条设备线不能跨越导轨或侵入小车安全通道，请向外摆放')
  const next = { ...layout, placementTemplate: { ...t }, lanes: lanes.map(row => ({ ...row })) }
  if (t.kind === 'dual') {
    const secondary = next.lanes.find(row => row.id === t.secondaryLaneId)
    if (!secondary || t.secondaryLaneId === t.primaryLaneId) fail('双侧模板缺少独立的第二条设备线')
    secondary.offsetZ = Number((t.railOffsetZ - sign * distance).toFixed(6))
    if (!finite(secondary.offsetZ) || Math.fround(secondary.offsetZ) === Math.fround(t.railOffsetZ)) fail('第二条设备线超出场景坐标范围')
  }
  return next
}

export function canMoveLineStructure(layout, type, id) {
  if (type === 'rail') return false
  if (layout.placementTemplate) return layout.placementTemplate.primaryLaneId === id
  // Lock the later row in an existing single-rail/two-row layout too. Applying
  // a template materialises its opposite-side relationship explicitly.
  return layout.rails?.length !== 1 || layout.lanes?.length !== 2 || layout.lanes[0].id === id
}

export function assertLineTemplateTransition(before, next) {
  const old = before.placementTemplate, t = next.placementTemplate
  if (old && !t) fail('不能通过移除模板解除导轨与第二条设备线的约束')
  if (!t) return
  const previous = (before.rails || []).find(row => row.id === t.railId)
  if (previous && previous.offsetZ !== t.railOffsetZ || old && old.railId !== t.railId) fail('切换模板不能移动原有小车导轨')
}

export function lineEnvelopeIntersections(rows) {
  for (const row of rows) if (['x', 'y', 'z', 'minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].some(key => !Number.isFinite(row[key]))
      || ['X', 'Y', 'Z'].some(axis => row['max' + axis] <= row['min' + axis])) fail(`「${row.name || row.id}」模型外形无效，未将未知尺寸当成零`)
  const result = []
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j]
    if (overlaps(a,a,b,b)&&boxes(a).some(pa=>boxes(b).some(pb=>overlaps(a,pa,b,pb)))) result.push([a, b])
  }
  return result
}

export function assertLineTemplateClearance(layout, rows) {
  const t = layout.placementTemplate
  if (!t) return
  const rail = layout.rails.find(row => row.id === t.railId)
  const swept = rows.map(row => row.railId === t.railId ? {
    ...row, x: 0, minX: -rail.length / 2 + row.minX, maxX: rail.length / 2 + row.maxX,
    minZ: Math.min(row.z, row.pathMinZ ?? row.z) - row.z + row.minZ,
    maxZ: Math.max(row.z, row.pathMaxZ ?? row.z) - row.z + row.maxZ
    ,...(row.collisionBoxes?{collisionBoxes:row.collisionBoxes.map(b=>({...b,minX:-rail.length/2+b.minX,maxX:rail.length/2+b.maxX,minZ:Math.min(row.z,row.pathMinZ??row.z)-row.z+b.minZ,maxZ:Math.max(row.z,row.pathMaxZ??row.z)-row.z+b.maxZ}))}:{})
  } : row)
  const collisions = lineEnvelopeIntersections(swept)
  if (collisions.length) fail(`模型外形仍重叠：${collisions.slice(0, 3).map(([a, b]) => `${a.name || a.id} / ${b.name || b.id}`).join('、')}。请调整同排设备前后间距；未缩小模型或挤动导轨。`)
}

export function lineTemplateSpacingLimits(layout,rows,lanes,rail,gapMeters){
  const units=layout.sceneUnitsPerMeter??1,carts=rows.filter(r=>r.railId===rail.id),gap=gapMeters*units
  let minimum=2*units,maximum=Infinity
  for(const [lane,side] of lanes)for(const row of rows.filter(r=>r.laneId===lane.id)){
    const relative=row.z-lane.offsetZ
    if(!carts.length)minimum=Math.max(minimum,.5*units+gap+(side<0?relative+row.maxZ:-relative-row.minZ))
    for(const cart of carts){
      for(const a of boxes(cart))for(const b of boxes(row)){
        if(Math.min(cart.y+a.maxY,row.y+b.maxY)-Math.max(cart.y+a.minY,row.y+b.minY)<=.00001)continue
        minimum=Math.max(minimum,side<0?rail.offsetZ-Math.min(cart.z,cart.pathMinZ??cart.z)-a.minZ+gap+relative+b.maxZ:Math.max(cart.z,cart.pathMaxZ??cart.z)+a.maxZ-rail.offsetZ+gap-relative-b.minZ)
      }
      if(cart.transferReach&&Number.isFinite(row.loadingFaceZ)){
        const source=side<0?cart.transferReach.negativeFaceZ:cart.transferReach.positiveFaceZ
        maximum=Math.min(maximum,cart.transferReach.stroke+side*(cart.z+source-rail.offsetZ-relative-row.loadingFaceZ))
      }
    }
  }
  return {minimum,maximum}
}

export function planLinePlacementTemplate(layout, kind, rows, gapMeters) {
  if (!LINE_PLACEMENT_TEMPLATES.some(row => row.id === kind)) fail('请选择一种布局模板')
  lineEnvelopeIntersections(rows)
  const next = clone(layout), units = next.sceneUnitsPerMeter ?? 1, dual = kind === 'dual'
  const compact=rows.some(r=>r.collisionBoxes?.length);gapMeters??=compact?.15:.6
  if (!Number.isFinite(units) || units <= 0 || units > 100000 || !Number.isFinite(gapMeters) || gapMeters <= 0 || gapMeters > 10) fail('显示比例或安全留缝无效')
  if (next.rails.length > 1 || next.lanes.length > 2) fail('当前是多导轨或多排布局，不能套用单导轨模板；原布局未改动')
  if (!next.rails.length) next.rails.push({ id: 'rail_template_1', name: '小车导轨 1', type: 'cart_rail', offsetZ: 0, length: 60, sort_order: 0 })
  const rail = next.rails[0], primary = next.lanes.find(row => row.id === next.placementTemplate?.primaryLaneId) || next.lanes[0]
  if (!primary) fail('请先创建设备线')
  let secondary = next.lanes.find(row => row.id !== primary.id)
  if (!dual && secondary && rows.some(row => row.laneId === secondary.id)) fail('第二条设备线上已有设备，请先移回设备池或第一条线，再切换单侧模板；不会删除设备')
  if (dual && !secondary) {
    let id = 'lane_template_opposite'; while (next.lanes.some(row => row.id === id)) id += '_2'
    secondary = { ...primary, id, name: '设备线 2', sort_order: 1 }
  }
  next.lanes = dual ? [primary, secondary] : [primary]
  const side = dual ? (next.placementTemplate?.primarySide || (primary.offsetZ < rail.offsetZ ? 'negative' : 'positive')) : kind === 'single-negative' ? 'negative' : 'positive'
  const sign = side === 'negative' ? -1 : 1
  const limits=lineTemplateSpacingLimits(next,rows,[[primary,sign],...(dual?[[secondary,-sign]]:[])],rail,gapMeters)
  let minimum=compact?Math.ceil((limits.minimum/units-1e-8)*20)/20*units:Math.ceil(limits.minimum*10)/10
  if(minimum>limits.maximum+1e-6)fail(`这组设备的进料面没有对齐，无法同时留缝并在原行程内交接。请先点“进料面前后对齐”，再选择模板；设备联动的“一键演示”不受影响。`)
  // Only explicit, confirmed template application selects the measured gap.
  const distance = minimum
  delete rail.spacing
  next.placementTemplate = { version: 1, kind, railId: rail.id, railOffsetZ: rail.offsetZ, primaryLaneId: primary.id, primarySide: side,
    ...(dual ? { secondaryLaneId: secondary.id } : {}), minimumDistance: minimum,...(compact?{clearanceGapMeters:gapMeters,compact:true}: {}) }
  primary.offsetZ = Number((rail.offsetZ + sign * distance).toFixed(6))
  const resolved = resolveLinePlacementTemplate(next)
  const moved = rows.map(row => {
    const oldLane = layout.lanes.find(lane => lane.id === row.laneId), newLane = resolved.lanes.find(lane => lane.id === row.laneId)
    return oldLane && newLane ? { ...row, z: row.z + newLane.offsetZ - oldLane.offsetZ } : { ...row }
  })
  assertLineTemplateTransition(layout, resolved)
  assertLineTemplateClearance(resolved, moved)
  return { layout: resolved, rows: moved, gapMeters }
}
