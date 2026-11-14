import { measureLoadingPorts } from '../../../three/lineLoadingAlignment.js'
import { nativeDeviceTransform } from '../../../runtime/factorySceneConfig.js'
import { parseInstanceConfig } from './common.js'
import { normalizeLineLayout } from './lineLayout.js'
import { lineSceneUnitsPerMeter } from '../../../../../shared/lineRailSpacing.mjs'
import * as T from 'three'
import { loadConfiguredGltf, disposeSceneObject } from '../../../runtime/ConfiguredFactoryScene.js'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { normalizeCartTransfer } from '../../../../../shared/cartTransferConfig.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
export function dockingCandidates(devices, lines) {
  const stations = [], carts = []
  for (const device of devices) {
    const config = parseInstanceConfig(device.instance_config)
    const line = lines.find(l => [device.line_id, config.laneLineId, config.railLineId].includes(l.id))
    if (!line || device.coordinate_space !== 'line_local' || device.line_id && device.line_id !== line.id) continue
    const layout = normalizeLineLayout(line.layout_json || line.layout)
    const mobile = ['transfer_cart', 'auxiliary'].includes(config.role) || config.movement && typeof config.movement === 'object' || device.model_type === 'transfer_cart'
    if (mobile && config.railId && layout.rails.some(r => r.id === config.railId)) carts.push({ device, line, config })
    else if (config.laneId && layout.lanes.some(r => r.id === config.laneId)) stations.push({ device, line, config,
      railId: layout.rails.slice().sort((a,b) => Math.abs(a.offsetZ - layout.lanes.find(r => r.id === config.laneId).offsetZ) - Math.abs(b.offsetZ - layout.lanes.find(r => r.id === config.laneId).offsetZ))[0]?.id,
      label: `${line.name || line.id} · ${config.stationNumber ? `工位 ${config.stationNumber} · ` : ''}${device.name || device.id}` })
  }
  return { stations, carts }
}
export async function prepareDockingCalibration({ line, deviceResult, cartResult, deviceKind = 'inlet', cartKind = 'outlet' }, options = {}) {
  const snapshot = copy({ line, deviceResult, cartResult, deviceKind, cartKind })
  line = snapshot.line; deviceResult = snapshot.deviceResult; cartResult = snapshot.cartResult
  if (![deviceResult, cartResult].every(r => r?.success === true && r.device && r.model && r.revision)) throw Error('没有取得设备与小车的校准来源')
  const candidates = dockingCandidates([deviceResult.device, cartResult.device], [line])
  const station = candidates.stations.find(r => r.device.id === deviceResult.device.id)
  if (!station || !candidates.carts.some(r => r.device.id === cartResult.device.id && r.config.railId === station.railId)) throw Error('请选择同产线工位与其最近导轨上的移动小车')
  const rows = await measureLoadingPorts([{ id: deviceResult.device.id, device: deviceResult.device, portKind: deviceKind },
    { id: cartResult.device.id, device: cartResult.device, portKind: cartKind }], [deviceResult.model, cartResult.model], { ...options, requireHeight: true })
  const [deviceRow, cartRow] = rows
  const cartConfig = parseInstanceConfig(cartResult.device.instance_config), transfer = normalizeCartTransfer(cartConfig.cartTransfer)
  const movement = cartConfig.movement || {}, start = movement.start, end = movement.end
  if (start && end && (Math.abs(Number(start.z) - Number(end.z)) > 1e-6 || Math.abs(Number(start.y || 0) - Number(end.y || 0)) > 1e-6)) throw Error('该小车为斜向或变高轨道，本校准页只支持产线 X 向水平导轨；不会虚拟对齐')
  let cartTurn = null
  if (transfer.kind === 'rotating') {
    const asset = await (options.load || loadConfiguredGltf)(resolveBackendAssetUrl(cartResult.device.model_file || cartResult.model.file_path), { signal: options.signal })
    const root = asset.scene || asset.scenes?.[0]
    try {
      if (!root) throw Error('旋转小车模型没有场景')
      root.updateMatrixWorld(true)
      const transform = nativeDeviceTransform(cartResult.device, cartResult.model)
      const matrix = new T.Matrix4().compose(new T.Vector3(), new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0), transform.yaw), new T.Vector3(...transform.scale)), inverse = matrix.clone().invert()
      const rootPoint = new T.Vector3(...cartRow.portPosition).applyMatrix4(inverse), rootDirection = new T.Vector3(...cartRow.portDirection).transformDirection(inverse)
      const desired = new T.Vector3(...deviceRow.portDirection).negate().transformDirection(inverse), rootInverse = root.matrixWorld.clone().invert()
      let pivot, parentMatrix = new T.Matrix4()
      if (transfer.presentation === 'simple') pivot = new T.Box3().setFromObject(root).getCenter(new T.Vector3()).applyMatrix4(rootInverse).setY(rootPoint.y)
      else {
        const anchors=[];root.traverse(node=>{if(node.name===transfer.turntableNodeName)anchors.push(node)})
        const anchor=anchors[0]
        if (anchors.length !== 1 || !anchor || anchor === root) throw Error('小车上转台节点不可用或不唯一，请先检查机构配置')
        parentMatrix = rootInverse.clone().multiply(anchor.parent.matrixWorld)
        if (Math.abs(new T.Vector3(0,1,0).transformDirection(parentMatrix).y) < .9999) throw Error('转台父节点不是竖直旋转轴，不能近似校准')
        pivot = anchor.getWorldPosition(new T.Vector3()).applyMatrix4(rootInverse)
      }
      const parentInverse = parentMatrix.clone().invert(), rest = rootDirection.clone().transformDirection(parentInverse), target = desired.clone().transformDirection(parentInverse)
      const angle = Math.atan2(rest.z * target.x - rest.x * target.z, rest.x * target.x + rest.z * target.z)
      const pivotParent = pivot.clone().applyMatrix4(parentInverse), after = rootPoint.clone().applyMatrix4(parentInverse).sub(pivotParent).applyAxisAngle(new T.Vector3(0,1,0), angle).add(pivotParent).applyMatrix4(parentMatrix).applyMatrix4(matrix)
      cartRow.portPosition = after.toArray(); cartRow.portDirection = deviceRow.portDirection.map(n => n === 0 ? 0 : -n)
      cartTurn = { presentation: transfer.presentation, nodeName: transfer.turntableNodeName, angle, pivot: pivot.toArray(), rootPort: { position: rootPoint.toArray(), direction: rootDirection.toArray() } }
    } finally { if (root) (options.dispose || disposeSceneObject)(root) }
  }
  const world = row => {
    const p = nativeDeviceTransform(row.device, row.id === deviceRow.id ? deviceResult.model : cartResult.model).position
    return row.portPosition.map((n, i) => n + p[['x', 'y', 'z'][i]])
  }
  const devicePort = world(deviceRow), cartPort = world(cartRow)
  if (Math.abs(deviceRow.portDirection[1]) > .001 || Math.abs(deviceRow.portDirection[2]) < .999
      || Math.abs(cartRow.portDirection[1]) > .001 || Math.abs(cartRow.portDirection[2]) < .999) throw Error('料口方向必须垂直导轨，请先在料口选点页核对方向')
  if (deviceRow.portDirection[2] * cartRow.portDirection[2] > -.999) throw Error('两个料口没有相向，请切换小车料口或修正真实朝向')
  // Stop at the selected station using the same handedness-reflected port X.
  // This is an ephemeral parked-cart pose, never a persisted cart transform.
  const cartPreviewX = cartResult.device.pos_x - (devicePort[0] - cartPort[0])
  cartPort[0] = devicePort[0]
  return { line, deviceResult, cartResult, deviceKind, cartKind, rows, devicePort, cartPort, cartPreviewX, cartTurn,
    position: { x: deviceResult.device.pos_x, y: deviceResult.device.pos_y },
    unitsPerMeter: lineSceneUnitsPerMeter(normalizeLineLayout(line.layout_json || line.layout)) }
}
export function dockingPreview(plan, position = plan.position) {
  if (!position || Object.values(position).some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100000)) throw Error('设备位置无效')
  const devicePort = [...plan.devicePort]
  devicePort[0] -= position.x - plan.position.x
  devicePort[1] += position.y - plan.position.y
  const delta = devicePort.map((n, i) => n - plan.cartPort[i])
  return { devicePort, cartPort: [...plan.cartPort], delta, millimeters: delta.map(n => n / plan.unitsPerMeter * 1000),
    aligned: Math.abs(delta[0]) <= plan.unitsPerMeter * .002 && Math.abs(delta[1]) <= plan.unitsPerMeter * .002 }
}
export function dockingSavePayload(plan, position) {
  dockingPreview(plan, position)
  for (const axis of ['x', 'y']) if (position[axis] !== plan.position[axis] && Math.fround(position[axis]) === Math.fround(plan.position[axis])) throw Error('当前场景比例与坐标精度不足，Unity 无法区分该位移；请增大步长或校准产线单位')
  return { deviceId: plan.deviceResult.device.id, cartId: plan.cartResult.device.id,
    deviceRevision: plan.deviceResult.revision, cartRevision: plan.cartResult.revision,
    expectedLine: { id: plan.line.id, workshop_id: plan.line.workshop_id, layout_json: plan.line.layout_json || JSON.stringify(plan.line.layout) },
    position: copy(position) }
}
