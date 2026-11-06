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
    fields(value, ['position', 'direction', 'nodeName'], path)
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
    return { position, direction: [x / length, 0, z / length], nodeName: value.nodeName }
  })
}
export function normalizeLoadingPortOverrides(input) {
  return normalize(input, 'loadingPortOverrides', (input, path) => {
    const value = parse(input, path)
    fields(value, ['offset', 'yawDegrees'], path)
    const offset = vector(value.offset, `${path}.offset`)
    if (typeof value.yawDegrees !== 'number' || !Number.isFinite(value.yawDegrees)) fail(`${path}.yawDegrees`, '必须是有限数字')
    return { offset, yawDegrees: value.yawDegrees === 0 ? 0 : value.yawDegrees }
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
  if (!override) return { position: [...base.position], direction: [...base.direction], nodeName: base.nodeName }
  const radians = (override.yawDegrees % 360) * Math.PI / 180
  const c = Math.cos(radians), s = Math.sin(radians), [x, , z] = base.direction
  const position = base.position.map((component, axis) => component + override.offset[axis])
  if (position.some(component => !Number.isFinite(component))) fail('loadingPortOverrides.offset', '有效位置超出有限数值范围')
  return { position,
    direction: [x * c + z * s, 0, -x * s + z * c], nodeName: base.nodeName }
}

export default { normalizeLoadingPorts, validateLoadingPorts, normalizeLoadingPortOverrides, validateLoadingPortOverrides, resolveLoadingPort }
