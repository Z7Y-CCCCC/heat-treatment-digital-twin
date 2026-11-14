// Loading port positions are glTF root-local coordinates (including the node
// hierarchy), before device scale/yaw. Directions are horizontal OUTWARD normals.
// The inlet normal therefore points towards the arriving material, not into it.
export const LOADING_PORT_VERSION = 1
export const LOADING_PORT_KINDS = Object.freeze(['inlet', 'outlet'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (path, message) => { throw Object.assign(new Error(`${path}: ${message}`), { path, code: 'LOADING_PORT_INVALID' }) }
const own = (value, key) => Object.hasOwn(value, key)

function parse(value, label, missing = false) {
  if (value === undefined || value === null) {
    if (missing) return {}
    fail(label, '必须是对象')
  }
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { fail(label, 'JSON 格式不正确') }
  }
  if (!object(value)) fail(label, '必须是对象')
  return value
}
function fields(value, allowed, path, required = allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, '不允许此字段')
  for (const key of required) if (!own(value, key)) fail(`${path}.${key}`, '缺少字段')
}
function vector(value, path) {
  if (!Array.isArray(value) || value.length !== 3 || Array.from(value).some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    fail(path, '必须是三个有限数字，不允许空字符串或数值字符串')
  }
  return value.map(component => component === 0 ? 0 : component)
}
// Optional v1 authored selection. Y follows the model, never the screen. The
// lower horizontal edge is the existing runtime's single transfer datum.
export function normalizeLoadingPortRegion(input, path = 'loadingPort.region') {
  const value = parse(input, path)
  fields(value, ['version', 'corners', 'surfaceNormal', 'nodeName'], path, ['version', 'corners', 'surfaceNormal'])
  if (value.version !== 1 || !Array.isArray(value.corners) || value.corners.length !== 4) fail(path, '区域需要版本 1 和四个角点')
  const corners = Array.from(value.corners, (p, i) => vector(p, `${path}.corners.${i}`)), normal = vector(value.surfaceNormal, `${path}.surfaceNormal`)
  const magnitude = Math.hypot(...normal)
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) fail(path, '区域平面法线无效')
  const n = normal.map(v => v / magnitude)
  if (Math.abs(n[1]) > .25) fail(path, '料口必须画在近竖直真实表面，不支持顶面或地面')
  const minus = (a,b) => a.map((v,i)=>v-b[i]), dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0)
  const bottom = minus(corners[1],corners[0]), side = minus(corners[3],corners[0]), top = minus(corners[2],corners[3]), right = minus(corners[2],corners[1])
  const width=Math.hypot(...bottom),height=Math.hypot(...side),tolerance=Math.max(width,height,1)*1e-6
  if (![width,height,dot(bottom,side),dot(bottom,n),dot(side,n),...top,...right].every(Number.isFinite)
    || width <= 1e-9 || height <= 1e-9 || Math.abs(bottom[1]) > tolerance || side[1] <= tolerance
    || Math.abs(dot(bottom,side)) > width*height*1e-5 || Math.abs(dot(bottom,n)) > tolerance || Math.abs(dot(side,n)) > tolerance
    || top.some((v,i)=>Math.abs(v-bottom[i])>tolerance) || right.some((v,i)=>Math.abs(v-side[i])>tolerance)) fail(path, '四角必须是同一真实平面的竖直矩形，且下沿在模型较低 Y')
  if (own(value,'nodeName') && (typeof value.nodeName!=='string'||value.nodeName.length>512||/[\u0000-\u001f\u007f]/.test(value.nodeName))) fail(path,'区域关联节点名称无效')
  return { version:1, corners, surfaceNormal:n, ...(own(value,'nodeName')?{nodeName:value.nodeName}:{}) }
}
export function loadingPortRegionDatum(region) { return region.corners[0].map((v,i)=>(v+region.corners[1][i])/2) }
function checkRegionDatum(region, position, direction, path) {
  const datum=loadingPortRegionDatum(region),scale=Math.max(1,...region.corners.flat().map(Math.abs))
  if (position.some((v,i)=>Math.abs(v-datum[i])>scale*1e-6)) fail(path, '送料基准点必须是区域下沿中点，而不是区域中心')
  const n=region.surfaceNormal,length=Math.hypot(n[0],n[2])
  if ((direction[0]*n[0]+direction[2]*n[2])/length < .9999) fail(path, '外向方向必须来自所画区域的实际面法线')
}
function normalize(input, label, port) {
  if (input === undefined || input === null) return { version: 1, inlet: null, outlet: null }
  const value = parse(input, label)
  fields(value, ['version', 'inlet', 'outlet'], label)
  if (value.version !== LOADING_PORT_VERSION) fail(`${label}.version`, '只支持数值版本 1')
  return { version: 1, ...Object.fromEntries(LOADING_PORT_KINDS.map(kind => [kind,
    value[kind] === null ? null : port(value[kind], `${label}.${kind}`)])) }
}
export function normalizeLoadingPorts(input) {
  return normalize(input, 'loadingPorts', (input, path) => {
    const value = parse(input, path)
    fields(value, ['position', 'direction', 'nodeName', 'region'], path, ['position', 'direction', 'nodeName'])
    const position = vector(value.position, `${path}.position`)
    const direction = vector(value.direction, `${path}.direction`)
    if (direction[1] !== 0) fail(`${path}.direction`, '方向必须水平，Y 必须为 0')
    const magnitude = Math.max(Math.abs(direction[0]), Math.abs(direction[2]))
    if (magnitude === 0) fail(`${path}.direction`, '水平外法线不能为零')
    // Scale first so any finite nonzero vector (including very large/small
    // components) can be normalized without overflowing or underflowing.
    const x = direction[0] / magnitude, z = direction[2] / magnitude
    const length = Math.hypot(x, z)
    if (typeof value.nodeName !== 'string' || value.nodeName.length > 512 || /[\u0000-\u001f\u007f]/.test(value.nodeName)) {
      fail(`${path}.nodeName`, '必须是不含控制字符的字符串，最多 512 个字符')
    }
    const normalizedDirection=[x / length, 0, z / length]
    const region=own(value,'region') ? normalizeLoadingPortRegion(value.region,`${path}.region`) : null
    if (region) checkRegionDatum(region,position,normalizedDirection,path)
    return { position, direction: normalizedDirection, nodeName: value.nodeName, ...(region?{region}:{}) }
  })
}
export function normalizeLoadingPortOverrides(input) {
  return normalize(input, 'loadingPortOverrides', (input, path) => {
    const value = parse(input, path)
    fields(value, ['offset', 'yawDegrees', 'region'], path, ['offset', 'yawDegrees'])
    const offset = vector(value.offset, `${path}.offset`)
    if (typeof value.yawDegrees !== 'number' || !Number.isFinite(value.yawDegrees)) fail(`${path}.yawDegrees`, '必须是有限数字')
    return { offset, yawDegrees: value.yawDegrees === 0 ? 0 : value.yawDegrees, ...(own(value,'region')?{region:normalizeLoadingPortRegion(value.region,`${path}.region`)}:{}) }
  })
}
function validate(normalizer, input) {
  try { const normalized = normalizer(input); return { valid: true, errors: [], normalized } }
  catch (error) { return { valid: false, errors: [{ path: error.path || '', message: error.message }], normalized: null } }
}
export const validateLoadingPorts = input => validate(normalizeLoadingPorts, input)
export const validateLoadingPortOverrides = input => validate(normalizeLoadingPortOverrides, input)

// No transfer-datum/bounds/front-back fallback: an explicitly null model port
// remains null, even when an instance contains an old override for that port.
export function resolveLoadingPort(model, device, kind = 'inlet') {
  if (!LOADING_PORT_KINDS.includes(kind)) fail('kind', '必须为 inlet 或 outlet')
  const metadata = parse(model?.metadata, '模型元数据', true)
  const instance = parse(device?.instance_config, '设备实例配置', true)
  const base = normalizeLoadingPorts(metadata.loadingPorts)[kind]
  const override = normalizeLoadingPortOverrides(instance.loadingPortOverrides)[kind]
  if (!base) return null
  if (!override) return { position: [...base.position], direction: [...base.direction], nodeName: base.nodeName, ...(base.region?{region:normalizeLoadingPortRegion(base.region)}:{}) }
  const radians = (override.yawDegrees % 360) * Math.PI / 180
  const c = Math.cos(radians), s = Math.sin(radians), [x, , z] = base.direction
  const position = base.position.map((component, axis) => component + override.offset[axis])
  if (position.some(component => !Number.isFinite(component))) fail('loadingPortOverrides.offset', '有效位置超出有限数值范围')
  const direction=[x * c + z * s, 0, -x * s + z * c]
  let region=override.region
  if (!region && base.region) {
    const rotate=p=>{const [px,py,pz]=p.map((v,i)=>v-base.position[i]);return [base.position[0]+px*c+pz*s+override.offset[0],base.position[1]+py+override.offset[1],base.position[2]-px*s+pz*c+override.offset[2]]}
    const [nx,ny,nz]=base.region.surfaceNormal
    region=normalizeLoadingPortRegion({version:1,corners:base.region.corners.map(rotate),surfaceNormal:[nx*c+nz*s,ny,-nx*s+nz*c]})
  }
  if (region) {
    region=normalizeLoadingPortRegion(region)
    // Instance authoring has always been relative to today's model datum.
    // Preserve that existing offset/yaw contract when the default is edited;
    // transform only the effective display region, never rewrite stored data.
    const datum=loadingPortRegionDatum(region),[nx,ny,nz]=region.surfaceNormal
    const angle=Math.atan2(nz*direction[0]-nx*direction[2],nx*direction[0]+nz*direction[2]),rc=Math.cos(angle),rs=Math.sin(angle)
    const rotate=p=>{const [px,py,pz]=p.map((v,i)=>v-datum[i]);return [position[0]+px*rc+pz*rs,position[1]+py,position[2]-px*rs+pz*rc]}
    region=normalizeLoadingPortRegion({...region,corners:region.corners.map(rotate),surfaceNormal:[nx*rc+nz*rs,ny,-nx*rs+nz*rc]})
  }
  return { position, direction, nodeName: region?.nodeName ?? base.nodeName, ...(region?{region}:{}) }
}

export default { normalizeLoadingPorts, validateLoadingPorts, normalizeLoadingPortOverrides, validateLoadingPortOverrides, resolveLoadingPort }
