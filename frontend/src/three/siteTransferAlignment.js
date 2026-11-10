import * as T from 'three'
import { deviceLocalToWorld, normalizeWorkshopLayout, normalizeSpatialTransform, parentToLocalPoint } from '../utils/spatialLayout.js'
import { nativeDeviceTransform } from '../runtime/factorySceneConfig.js'
import { resolveLoadingPort } from '../../../shared/loadingPorts.mjs'
import { resolveLineRailSpacing, assertLineMovementUnits, movementSceneUnitsPerMeter, lineSceneUnitsPerMeter } from '../../../shared/lineRailSpacing.mjs'

const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {}
const vector = value => value && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]))
const error = (row, message) => Error(`「${row?.name || row?.id || '设备'}」${message}`)
const point = value => new T.Vector3(value.x, value.y, value.z)

export function siteSceneUnitsPerMeter(device, lines = []) {
  const instance = parse(device?.instance_config), movement = parse(instance.movement)
  const id = device?.line_id || instance.railLineId || instance.laneLineId
  const line = lines.find(row => String(row.id) === String(id)), layout = parse(line?.layout || line?.layout_json)
  try {
    // Only an explicitly declared new line field supersedes a legacy layout's
    // independent source calibration. Reading old configurations never writes it.
    if (Object.hasOwn(layout, 'sceneUnitsPerMeter')) return assertLineMovementUnits(movement, layout, device?.name || device?.id)
    if (Object.hasOwn(movement, 'sceneUnitsPerMeter') || Object.hasOwn(movement, 'scene_units_per_meter')) return movementSceneUnitsPerMeter(movement)
    return lineSceneUnitsPerMeter(layout)
  } catch { throw error(device, '现场米制比例无效或与所属产线不一致，请在现有产线结构 / 移动设置中统一场景单位 / 米；未使用默认比例替代') }
}

const validMatrix = matrix => {
  if (!matrix?.isMatrix4 || !matrix.elements.every(Number.isFinite)) return false
  const determinant = matrix.determinant()
  return Number.isFinite(determinant) && determinant !== 0
}
const finiteVector = (value, message) => {
  if (!value.toArray().every(Number.isFinite)) throw Error(message)
  return value
}

// Unity Transform.rotation follows the quaternion chain, independently of
// mirrored scales. Matrix decomposition can turn a Y reflection into a fake
// rotation and wrongly make an upside-down payload parent look valid.
export function siteWorldQuaternion(object) {
  const chain = [], result = new T.Quaternion()
  for (let current = object; current; current = current.parent) chain.push(current)
  for (const current of chain.reverse()) {
    const rotation = current.quaternion
    if (!rotation?.isQuaternion || !rotation.toArray().every(Number.isFinite) || !Number.isFinite(rotation.lengthSq()) || rotation.lengthSq() === 0) throw Error('现场父级旋转无效，未生成物料位置')
    result.multiply(rotation.clone().normalize())
  }
  return result.normalize()
}

export function siteWorldVector(local, parent) {
  if (!local?.isVector3 || !local.toArray().every(Number.isFinite)) throw Error('现场方向或位移无效')
  if (!parent) return local.clone()
  parent.updateWorldMatrix(true, false)
  if (!validMatrix(parent.matrixWorld)) throw Error('现场父级尺度或变换退化，未生成有效交接')
  return finiteVector(local.clone().applyMatrix3(new T.Matrix3().setFromMatrix4(parent.matrixWorld)), '换算后的现场方向或位移无效')
}

export function siteWorldPoint(local, parent) {
  if (!local?.isVector3 || !local.toArray().every(Number.isFinite)) throw Error('现场坐标无效')
  if (!parent) return local.clone()
  parent.updateWorldMatrix(true, false)
  if (!validMatrix(parent.matrixWorld)) throw Error('现场父级尺度或变换退化，未生成有效交接')
  return finiteVector(local.clone().applyMatrix4(parent.matrixWorld), '换算后的现场世界坐标无效')
}

export function siteParentPoint(world, parent) {
  if (!world?.isVector3 || !world.toArray().every(Number.isFinite)) throw Error('现场物料世界坐标无效')
  if (!parent) return world.clone()
  parent.updateWorldMatrix(true, false)
  if (!validMatrix(parent.matrixWorld)) throw Error('现场物料父级尺度或变换退化，未生成有效位置')
  return finiteVector(world.clone().applyMatrix4(parent.matrixWorld.clone().invert()), '换算后的现场物料本地坐标无效')
}

// The payload contains a unit cube. Sizes are metres, while all rendered
// coordinates are scene units. Compensate the actual rotated parent axes,
// including X reflections/nonuniform scale, but do not fabricate an upright
// metric cuboid by accepting affine shear or a flipped/tilted support axis.
export function applySitePayloadMetrics(payload, sourceRoot, materialSizeMeters, sceneUnitsPerMeter) {
  if (!payload?.isObject3D || !sourceRoot?.isObject3D || !Array.isArray(materialSizeMeters) || materialSizeMeters.length !== 3
    || materialSizeMeters.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    || !Number.isFinite(sceneUnitsPerMeter) || sceneUnitsPerMeter <= 0) throw Error('现场米制比例或物料尺寸无效')
  // Validate the source's actual support axis as well as the compensated
  // payload. A quaternion chain intentionally ignores scale reflections, so
  // source.scale.y < 0 must not masquerade as an upright loading surface merely
  // because the independent payload parent is healthy.
  const sourceUp = siteWorldVector(new T.Vector3(0, 1, 0), sourceRoot), sourceHeight = sourceUp.length()
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0 || sourceUp.divideScalar(sourceHeight).dot(new T.Vector3(0, 1, 0)) < .9999) throw Error('来源承料面倾斜、倒置或退化，无法还原垂直物料')
  const desired = new T.Vector3(...materialSizeMeters).multiplyScalar(sceneUnitsPerMeter)
  if (!desired.toArray().every(value => Number.isFinite(value) && value > 0)) throw Error('换算后的物料尺寸无效')
  const rotation = siteWorldQuaternion(payload.parent).invert().multiply(siteWorldQuaternion(sourceRoot)).normalize()
  const axes = [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)]
    .map(axis => siteWorldVector(axis.applyQuaternion(rotation), payload.parent))
  const lengths = axes.map(axis => axis.length())
  if (lengths.some(value => !Number.isFinite(value) || value <= 0)) throw Error('物料父级尺度退化，未生成有效尺寸')
  const units = axes.map((axis, index) => axis.clone().divideScalar(lengths[index]))
  if (Math.abs(units[0].dot(units[1])) > .0001 || Math.abs(units[0].dot(units[2])) > .0001 || Math.abs(units[1].dot(units[2])) > .0001
    || units[1].dot(new T.Vector3(0, 1, 0)) < .9999) throw Error('物料父级产生剪切、倾斜或倒置，无法还原正交垂直的米制物料')
  const scale = desired.clone().divide(new T.Vector3(...lengths))
  if (!scale.toArray().every(value => Number.isFinite(value) && value > 0)) throw Error('补偿后的物料尺寸无效')
  payload.quaternion.copy(rotation); payload.scale.copy(scale); payload.updateWorldMatrix(true, true)
  const worldHeight = siteWorldVector(new T.Vector3(0, 1, 0), payload).length()
  if (!Number.isFinite(worldHeight) || worldHeight <= 0) throw Error('物料世界高度无效')
  return { worldHeight, worldDimensions: desired, sceneUnitsPerMeter }
}

export function siteDeviceContext(device, lines, workshops) {
  const config = parse(device.instance_config), id = device.line_id || config.railLineId || config.laneLineId
  const line = lines.find(row => String(row.id) === String(id))
  const workshop = workshops.find(row => String(row.id) === String(line?.workshop_id || config.workshop_id || config.workshopId))
  if (!line || !workshop) throw error(device, '未配置当前产线和车间，不能验证现场联动')
  return { config, line, workshop }
}

export function siteDeviceTransform(device, model, lines, workshops) {
  const { line, workshop } = siteDeviceContext(device, lines, workshops)
  const world = deviceLocalToWorld(device, workshop, line)
  return nativeDeviceTransform({ ...device, pos_x: world.x, pos_y: world.y, pos_z: world.z, rotation_y: Math.atan2(Math.sin(world.rotationY), Math.cos(world.rotationY)) }, model)
}

// All points retain the same authored origin, scale, mirror and handedness as
// Unity. Explicit null ports never fall back to bounds or a model-name guess.
export function siteLoadingDatum(device, model, transform, kind = 'inlet') {
  const port = resolveLoadingPort(model, device, kind)
  if (!port) throw error(device, `没有已配置的${kind === 'outlet' ? '出料口' : '进料口'}基准，请在模型或设备进出料口设置中配置`)
  const matrix = new T.Matrix4().compose(point(transform.position), new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), transform.yaw), new T.Vector3(...transform.scale))
  return { position: new T.Vector3(...port.position).applyMatrix4(matrix), direction: new T.Vector3(...port.direction).transformDirection(matrix), local: new T.Vector3(...port.position), port }
}

export function siteCarrierPath(device, lines, workshops) {
  const { config, line, workshop } = siteDeviceContext(device, lines, workshops)
  const layout = resolveLineRailSpacing(parse(line.layout || line.layout_json))
  const rail = (layout.rails || []).find(row => String(row.id) === String(config.railId || ''))
  if (!rail) throw error(device, '未绑定可用小车导轨，请先在产线管理中放置并绑定导轨')
  const movement = parse(config.movement)
  if (typeof rail.length !== 'number' || !Number.isFinite(rail.length) || rail.length <= 0) throw error(device, '导轨长度无效')
  const convert = (position, coordinateSpace = device.coordinate_space) => {
    const world = deviceLocalToWorld({ ...device, coordinate_space: coordinateSpace, pos_x: position.x, pos_y: position.y, pos_z: position.z }, workshop, line)
    return new T.Vector3(-world.x, world.y, world.z)
  }
  if (movement.enabled === true) {
    if (!vector(movement.start) || !vector(movement.end)) throw error(device, '移动配置起终点无效')
    const start = convert(movement.start), end = convert(movement.end)
    if (Math.hypot(end.x - start.x, end.z - start.z) < .0001) throw error(device, '移动配置轨道基准或水平参考方向无效')
    if (movement.valueMode === 'station') {
      const axis = end.clone().sub(start); axis.y = 0
      const denominator = axis.lengthSq()
      if (denominator < .00000001 || !Array.isArray(movement.stations) || movement.stations.length === 0) throw error(device, '工位模式没有可靠的导轨方向或已配置工位')
      const stations = movement.stations.map(station => {
        const position = station.position || station
        if (!vector(position) || typeof station.value !== 'number' || !Number.isFinite(station.value)) throw error(device, '工位编号或位置配置无效')
        const world = convert(position), distance = world.clone().sub(start).dot(axis) / denominator
        return { value: station.value, anchorDeviceId: String(station.anchorDeviceId || station.anchor_device_id || ''), position: start.clone().addScaledVector(axis, distance) }
      })
      if (new Set(stations.map(station => station.value)).size !== stations.length) throw error(device, '工位编号重复，不能确认真实停靠位置')
      const world = { x: -start.x, y: start.y, z: start.z }
      const local = parentToLocalPoint(parentToLocalPoint(world, normalizeWorkshopLayout(workshop.layout || workshop.layout_json).transform), normalizeSpatialTransform(layout.transform))
      const railStart = convert({ x: -rail.length / 2, y: local.y, z: local.z }, 'line_local'), railEnd = convert({ x: rail.length / 2, y: local.y, z: local.z }, 'line_local')
      if (Math.abs(axis.clone().normalize().dot(railEnd.clone().sub(railStart).normalize())) < .9999) throw error(device, '移动参考方向与产线导轨方向不一致')
      return { start: railStart, end: railEnd, stations, railId: rail.id, lineId: line.id, source: 'stations' }
    }
    return { start, end, railId: rail.id, lineId: line.id, source: 'movement' }
  }
  const world = deviceLocalToWorld(device, workshop, line)
  const local = parentToLocalPoint(parentToLocalPoint(world, normalizeWorkshopLayout(workshop.layout || workshop.layout_json).transform), normalizeSpatialTransform(layout.transform))
  // Retain the saved origin-to-track calibration, not a render-time snap.
  return { start: convert({ x: -rail.length / 2, y: local.y, z: local.z }, 'line_local'), end: convert({ x: rail.length / 2, y: local.y, z: local.z }, 'line_local'), railId: rail.id, lineId: line.id, source: 'rail' }
}

// Synthetic site playback starts from the same configured motion baseline as
// native initialization, not from a potentially off-track catalogue origin.
export function siteCarrierInitialPosition(path, savedPosition) {
  if (path.source === 'stations') return path.stations.slice().sort((a, b) => a.value - b.value)[0].position.clone()
  if (path.source === 'movement') return path.start.clone()
  const axis = path.end.clone().sub(path.start), squared = axis.lengthSq(), delta = savedPosition.clone().sub(path.start)
  if (squared < .00000001) throw Error('配置导轨起终点重合')
  const progress = delta.dot(axis) / squared, projected = path.start.clone().addScaledVector(axis, progress)
  if (progress < -.0001 || progress > 1.0001 || projected.distanceTo(savedPosition) > .0001) throw Error('已保存的小车初始位置偏离导轨，请在设备编排中校准；现场预览未自动挪动设备')
  return savedPosition.clone()
}

// This preview uses the standard configured feed rig, not arbitrary action
// authoring. Do not silently replace a saved custom action/node with that rig.
export function assertSiteTransferDriver(row, rig, asset) {
  const config = parse(row.instance_config), link = config.animationBindings?.transferLink
  if (!link?.enabled) return
  const model = row.capabilities?.model || {}, metadata = parse(model.metadata)
  let actionId, nodeName
  if (row.model_type === 'cad_transfer_cart_101300') {
    actionId = 'clip:feed'; nodeName = 'cad_transfer_cart_v1_feed_carriage'
  } else if (row.model_type === 'photo_transfer_cart_v6') {
    const bindingIndex = (metadata.partBindings || []).findIndex(binding => binding.source_key === 'cart_feed_extension' && binding.action === 'translate' && binding.axis === 'x')
    const binding = metadata.partBindings?.[bindingIndex]
    if (binding) { actionId = `part:${binding.id || bindingIndex}`; nodeName = binding.node_name }
  }
  if (!actionId || link.actionId !== actionId || link.driveNodeName !== nodeName || asset.getObjectsByProperty('name', nodeName).length !== 1
    || !config.animationBindings.bindings?.some(binding => binding.actionId === link.actionId && binding.enabled === true)) throw error(row, '已保存的联动动作或承料节点不是此现场方案预览支持的标准送料驱动，请使用实际动作预览核对；未替换为演示推链')
  if (row.model_type === 'cad_transfer_cart_101300' && !rig.node?.('feed_carriage') || row.model_type === 'photo_transfer_cart_v6' && !rig.shuttle) throw error(row, '现场方案预览缺少已配置的送料驱动节点')
}

// Solve longitudinal travel and pusher extension together; never rotate or
// slide the cart sideways to make an unreachable installation look correct.
export function solveSiteTransferPose({ start, end, cartPortOffset, feedDirection, stationPosition, stationDirection, stroke, fixedPosition, sceneUnitsPerMeter = 1, heightToleranceMeters = 0, lateralToleranceMeters = 0, angleToleranceDegrees = 0, name = '设备' }) {
  const fail = message => { throw Error(`「${name}」${message}；请在产线间距、移动设备和进出料口配置中调整，现场预览未移动设备`) }
  if (![start, end, cartPortOffset, feedDirection, stationPosition, stationDirection].every(v => v?.isVector3 && v.toArray().every(Number.isFinite))) fail('交接坐标无效')
  if (!Number.isFinite(sceneUnitsPerMeter) || sceneUnitsPerMeter <= 0) fail('现场米制比例无效')
  if (!Number.isFinite(stroke) || stroke <= 0) fail('没有可靠的推链行程')
  if (![heightToleranceMeters, lateralToleranceMeters, angleToleranceDegrees].every(Number.isFinite) || heightToleranceMeters < 0 || heightToleranceMeters > 1 || lateralToleranceMeters < 0 || lateralToleranceMeters > 1 || angleToleranceDegrees < 0 || angleToleranceDegrees > 30) fail('交接公差无效')
  const positionEpsilon = .0001 * sceneUnitsPerMeter, toleranceEpsilon = .000001 * sceneUnitsPerMeter
  const heightToleranceWorld = heightToleranceMeters * sceneUnitsPerMeter, lateralToleranceWorld = lateralToleranceMeters * sceneUnitsPerMeter
  if (![positionEpsilon, toleranceEpsilon, heightToleranceWorld, lateralToleranceWorld].every(Number.isFinite)) fail('换算后的交接公差无效')
  const travel = end.clone().sub(start), length = travel.length(), rail = travel.clone().normalize(), feed = feedDirection.clone().normalize(), normal = stationDirection.clone().normalize()
  if (length < positionEpsilon || feed.lengthSq() === 0 || normal.lengthSq() === 0 || Math.abs(feed.y) > .0001 || Math.abs(normal.y) > .0001) fail('轨迹或交接朝向无效')
  const angle = Math.acos(Math.max(-1, Math.min(1, -feed.dot(normal)))) * 180 / Math.PI
  if (angle > angleToleranceDegrees + .0001) fail('炉口与料车推链朝向不相对')
  const delta = stationPosition.clone().sub(start).sub(cartPortOffset), determinant = rail.x * feed.z - rail.z * feed.x
  if (Math.abs(determinant) < .0001) fail('推链方向与导轨平行，无法侧向交接')
  let distance = (delta.x * feed.z - delta.z * feed.x) / determinant
  let extension = (rail.x * delta.z - rail.z * delta.x) / determinant
  if (fixedPosition) {
    if (!fixedPosition.isVector3 || !fixedPosition.toArray().every(Number.isFinite)) fail('已配置的工位停靠坐标无效')
    const projected = fixedPosition.clone().sub(start)
    distance = projected.dot(rail)
    if (projected.clone().addScaledVector(rail, -distance).length() > positionEpsilon) fail('已配置的工位停靠点偏离导轨')
    const residual = stationPosition.clone().sub(fixedPosition).sub(cartPortOffset)
    extension = residual.dot(feed)
    const lateral = residual.clone().addScaledVector(feed, -extension); lateral.y = 0
    if (lateral.length() > lateralToleranceWorld + toleranceEpsilon) fail('已配置工位与进出料口横向错位')
  }
  if (distance < -positionEpsilon || distance > length + positionEpsilon) fail('目标进出料口超出配置导轨或运动起终点')
  const position = fixedPosition ? fixedPosition.clone() : start.clone().addScaledVector(rail, Math.max(0, Math.min(length, distance)))
  if (Math.abs(stationPosition.y - position.y - cartPortOffset.y) > heightToleranceWorld + toleranceEpsilon) fail('料盘与设备进出料口送料高度不一致')
  if (extension < -positionEpsilon) fail('设备口位于料车推链背面，中心间距过小或方向错误')
  if (extension > stroke + positionEpsilon) fail(`设备口距离 ${(extension / sceneUnitsPerMeter).toFixed(3)} 米超出推链行程 ${(stroke / sceneUnitsPerMeter).toFixed(3)} 米`)
  return { position, extension: Math.max(0, Math.min(stroke, extension)), extensionMeters: Math.max(0, Math.min(stroke, extension)) / sceneUnitsPerMeter, strokeMeters: stroke / sceneUnitsPerMeter, railProgress: Math.max(0, Math.min(1, distance / length)) }
}
