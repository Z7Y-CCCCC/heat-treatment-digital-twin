import { isAuxiliaryDeviceConfig, parseInstanceConfig, sortByOrder } from './common.js'

const id = value => String(value ?? '')
const key = (kind, value) => `${kind}:${encodeURIComponent(value)}`
const classes = [{ type: 'fixed', label: '固定设备' }, { type: 'auxiliary', label: '辅助设备' }]

// Read-only browsing projection. Missing parents stay visible; no device record
// or workshop-level auxiliary equipment is reassigned by the navigation.
export function buildDeviceDirectory({ workshops = [], lines = [], devices = [] } = {}) {
  const workshopById = new Map(workshops.map(item => [id(item.id), item]))
  const lineById = new Map(lines.map(item => [id(item.id), item]))
  const rows = sortByOrder(devices).map(device => {
    const config = parseInstanceConfig(device.instance_config) || {}, type = isAuxiliaryDeviceConfig({ ...device, instance_config: config }) ? 'auxiliary' : 'fixed'
    const rawLine = lineById.get(id(device.line_id || device.lineId))
    const configuredWorkshop = id(device.workshop_id || device.workshopId || config.workshop_id || config.workshopId)
    const workshopId = type === 'auxiliary' && workshopById.has(configuredWorkshop)
      ? configuredWorkshop : id(rawLine?.workshop_id || rawLine?.workshopId || (workshopById.has(configuredWorkshop) ? configuredWorkshop : ''))
    const workshop = workshopById.get(workshopId)
    const line = rawLine && id(rawLine.workshop_id || rawLine.workshopId) === workshopId ? rawLine : null
    return { device, type, workshopId: workshop ? workshopId : '', lineId: line ? id(line.id) : '',
      path: [workshop?.name || '未分配车间', line?.name || (type === 'auxiliary' ? '车间级设备' : '未分配产线'), device.name || id(device.id)].join(' / ') }
  })
  const nodeByKey = new Map()
  function node(value, matching, children = []) {
    const result = { ...value, count: matching.length, fixedCount: matching.filter(row => row.type === 'fixed').length,
      auxiliaryCount: matching.filter(row => row.type === 'auxiliary').length, rows: matching, children }
    nodeByKey.set(result.key, result); return result
  }
  const workshopOptions = sortByOrder(workshops).map(item => ({ ...item, id: id(item.id) }))
  if (rows.some(row => !row.workshopId) || lines.some(item => !workshopById.has(id(item.workshop_id || item.workshopId))))
    workshopOptions.push({ id: '', name: '未分配车间' })
  const children = workshopOptions.map(workshop => {
    const workshopKey = key('workshop', workshop.id), matching = rows.filter(row => row.workshopId === workshop.id)
    const options = sortByOrder(lines.filter(line => workshop.id ? id(line.workshop_id || line.workshopId) === workshop.id : !workshopById.has(id(line.workshop_id || line.workshopId))))
      .map(item => ({ ...item, id: id(item.id) }))
    if (matching.some(row => !row.lineId)) options.push({ id: '', name: matching.filter(row => !row.lineId).every(row => row.type === 'auxiliary') ? '车间级设备' : '未分配产线' })
    const lineNodes = options.map(line => {
      const lineKey = key('line', JSON.stringify([workshop.id, line.id])), lineRows = matching.filter(row => row.lineId === line.id)
      const path = [workshop.name || workshop.id, line.name || line.id]
      return node({ key: lineKey, kind: 'line', label: line.name || line.id, workshopId: workshop.id, lineId: line.id, parentKey: workshopKey, path }, lineRows,
        classes.map(category => node({ key: `${lineKey}/${category.type}`, kind: 'category', label: category.label, type: category.type,
          workshopId: workshop.id, lineId: line.id, parentKey: lineKey, path: [...path, category.label] }, lineRows.filter(row => row.type === category.type))))
    })
    return node({ key: workshopKey, kind: 'workshop', label: workshop.name || workshop.id, workshopId: workshop.id, parentKey: 'all', path: [workshop.name || workshop.id] }, matching, lineNodes)
  })
  const root = node({ key: 'all', kind: 'all', label: '全部设备', path: ['全部设备'] }, rows, children)
  const first = children.flatMap(workshop => workshop.children.flatMap(line => line.children)).find(item => item.count)
    || children.flatMap(workshop => workshop.children)[0] || children[0] || root
  return { root, rows, nodeByKey, defaultKey: first.key }
}

export function deviceDirectorySelection(directory, selectedKey = '') {
  return directory.nodeByKey.get(selectedKey) || directory.nodeByKey.get(directory.defaultKey) || directory.root
}
