import { measureLoadingPorts, alignLoadingFaces, alignLoadingHeights } from '../../../three/lineLoadingAlignment.js'
import { parseInstanceConfig } from './common.js'

export const ALIGNMENT_DEVICE_FIELDS = ['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale', 'model_type', 'model_file', 'line_id', 'coordinate_space', 'instance_config']
const copy = value => JSON.parse(JSON.stringify(value))
const finite = (value, label) => { if (value === '' || value == null || !Number.isFinite(Number(value))) throw new Error(`${label}无效`); return Number(value) }

export function loadingAlignmentCandidates(devices, layout, mode, scope, laneId, selectedIds = []) {
  const rows = devices.map(device => {
    const config = parseInstanceConfig(device.instance_config)
    const lane = layout.lanes.find(item => item.id === config.laneId)
    const rail = layout.rails.find(item => item.id === config.railId)
    return { id: device.id, device, binding: lane ? { type: 'lane', item: lane } : rail ? { type: 'rail', item: rail } : null }
  }).filter(row => row.binding)
  let chosen
  if (scope === 'selected') {
    if (new Set(selectedIds).size !== selectedIds.length) throw new Error('不能重复选择同一台设备')
    chosen = selectedIds.map(id => rows.find(row => row.id === id))
    if (chosen.some(row => !row)) throw new Error('所选设备已改变，请重新选择')
  } else if (scope === 'lane') chosen = rows.filter(row => row.binding.type === 'lane' && row.binding.item.id === laneId)
  else if (scope === 'line') chosen = mode === 'faces' ? rows.filter(row => row.binding.type === 'lane') : rows
  else throw new Error('请选择参与范围')
  if (chosen.length < 2) throw new Error('参与范围内至少需要两台已放置设备')
  if (chosen.length > 200) throw new Error('一次最多对齐 200 台设备，请缩小参与范围')
  if (mode === 'faces' && chosen.some(row => row.binding.type !== 'lane')) throw new Error('前后对齐仅适用于设备线上的设备，不移动导轨小车')
  if (chosen.some(row => row.device.coordinate_space !== 'line_local')) throw new Error('请先将参与设备放置在同一产线坐标空间，不能混用车间级坐标')
  return chosen.map(row => {
    let direction
    if (mode === 'faces') {
      const nearest = layout.rails.slice().sort((a, b) => Math.abs(a.offsetZ - row.binding.item.offsetZ) - Math.abs(b.offsetZ - row.binding.item.offsetZ))[0]
      if (!nearest || Math.abs(nearest.offsetZ - row.binding.item.offsetZ) < .001) throw new Error(`「${row.binding.item.name}」请先配置一侧的小车导轨`)
      direction = Math.sign(nearest.offsetZ - row.binding.item.offsetZ)
    }
    return { ...row, x: finite(row.device.pos_x, '设备 X 坐标'), y: finite(row.device.pos_y, '设备高度'), z: finite(row.device.pos_z, '设备 Z 坐标'), direction }
  })
}

export async function prepareLoadingAlignment({ line, layout, devices, models, mode, scope, laneId, selectedIds, referenceId, portKind = 'inlet', referencePortKind = portKind }, options = {}) {
  if (!['faces', 'heights'].includes(mode)) throw new Error('对齐操作无效')
  // Freeze every source before the first asynchronous asset measurement.
  // A layout update during loading must not attach a new CAS token to old poses.
  const snapshot = copy({ line, layout, devices, models, selectedIds })
  line = snapshot.line; layout = snapshot.layout; devices = snapshot.devices; models = snapshot.models; selectedIds = snapshot.selectedIds || []
  const rows = loadingAlignmentCandidates(devices, layout, mode, scope, laneId, selectedIds)
  if (referenceId && !rows.some(row => row.id === referenceId)) throw new Error('请选择参与范围内的基准设备')
  const sourceDevices = copy(rows.map(row => row.device)), sourceModels = copy(models)
  const measured = await measureLoadingPorts(rows.map(row => ({ ...row, portKind: row.id === referenceId ? referencePortKind : portKind })), models, {
    ...options, requireRailDirection: mode === 'faces', requireHeight: mode === 'heights'
  })
  let plan
  const referenceIds = []
  if (mode === 'heights') {
    plan = alignLoadingHeights(measured, referenceId)
    referenceIds.push(referenceId)
  } else {
    const groups = [...new Set(measured.map(row => row.binding.item.id))]
    if (referenceId && groups.length !== 1) throw new Error('指定基准设备时，请将范围限定在同一设备线；多条设备线可使用各线最近进料面')
    plan = groups.flatMap(id => {
      const group = measured.filter(row => row.binding.item.id === id)
      if (group.length < 2) throw new Error(`「${group[0].binding.item.name}」范围内不足两台设备，请调整参与范围`)
      const reference = referenceId || group.slice().sort((a, b) => b.direction * (b.z + b.faceOffset) - a.direction * (a.z + a.faceOffset))[0].id
      // Even the automatic nearest face is a real, unchanged reference, not a
      // rounded target coordinate. Preserve its complete stored precision.
      const aligned = alignLoadingFaces(group, reference)
      referenceIds.push(reference)
      return aligned
    })
  }
  const axis = mode === 'faces' ? 'z' : 'y'
  return {
    mode, axis, rows: plan, referenceIds,
    payload: {
      mode,
      expectedLine: { id: line.id, workshop_id: line.workshop_id, layout_json: line.layout_json || JSON.stringify(layout) },
      devices: plan.map(row => {
        const device = sourceDevices.find(item => item.id === row.id), model = sourceModels.find(item => item.id === device.model_type)
        if (!model) throw new Error(`「${device.name}」没有模型配置`)
        return { id: row.id, position: row[axis], expected: Object.fromEntries(ALIGNMENT_DEVICE_FIELDS.map(key => [key, device[key] ?? null])),
          expectedModel: { id: model.id, file_path: model.file_path ?? null, default_scale: model.default_scale ?? null, metadata: model.metadata ?? null } }
      })
    }
  }
}
