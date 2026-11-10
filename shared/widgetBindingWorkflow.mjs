// Explicit device-to-data assignments. No runtime same-name/role fallback in v2.
const text = (value, max = 255) => String(value ?? '').slice(0, max)
const clone = value => JSON.parse(JSON.stringify(value))
const modes = new Set(['plc', 'dataset', 'runtime'])
export const EVENT_BINDING = Object.freeze({ mode: 'runtime', path: 'events', source: '', deviceScope: 'global', readOnly: true })
export function normalizeSource(source = {}) {
  const decimals = typeof source.decimals === 'number' || typeof source.decimals === 'string' && source.decimals.trim() !== '' ? Number(source.decimals) : NaN
  return {
    mode: modes.has(source.mode) ? source.mode : 'plc',
    deviceId: text(source.deviceId, 128), pointId: text(source.pointId, 128),
    pointKey: text(source.pointKey), path: text(source.path), source: text(source.source),
    datasetId: text(source.datasetId, 80), datasetField: text(source.datasetField, 64),
    datasetMode: ['first','count','sum','avg','min','max'].includes(source.datasetMode) ? source.datasetMode : 'first',
    unit: text(source.unit, 32), unitPath:text(source.unitPath), requireConfiguredPoint: source.mode === 'plc', readOnly: true,
    ...(Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? { decimals } : {}),
    catalogItemId: text(source.catalogItemId, 100), catalogTableId: text(source.catalogTableId, 100)
  }
}
export function normalizeBindingWorkflow(binding = {}) {
  if (binding.bindingVersion !== 2) return {}
  return { bindingVersion: 2, deviceBindings: (Array.isArray(binding.deviceBindings) ? binding.deviceBindings : []).slice(0, 100)
    .map(row => ({ deviceId: text(row?.deviceId, 128), binding: row?.binding ? normalizeSource(row.binding) : null })) }
}
export function bindingForDevice(binding = {}, deviceId = '') {
  if (binding.bindingVersion !== 2 || binding.deviceScope === 'global' || binding.mode==='static') return binding
  const row = binding.deviceBindings?.find(row => String(row.deviceId) === String(deviceId))
  const source=row?.binding,ready=source && (source.mode==='plc' ? String(source.pointId ?? '') : source.mode==='dataset' ? source.datasetId && source.datasetField : source.mode==='runtime' ? source.path : false)
  if (!ready || !deviceId) return { ...binding, mode: 'plc', pointId: '', pointKey: '', path: '', source: '', requireConfiguredPoint: true, bindingMissing: true }
  return { ...binding, ...row.binding, deviceId: String(deviceId), deviceScope: binding.deviceScope, bindingMissing: false }
}
export function hasExternalBindings(binding = {}) {
  if(binding.mode==='static')return false
  return ['dataset','database','http_api','business'].includes(binding.mode)
    || (binding.deviceBindings || []).some(row => ['dataset','database','http_api','business'].includes(row.binding?.mode))
}
export function hasExternalWidgetBindings(widget = {}) {
  return hasExternalBindings(widget.data) || (widget.content?.items || []).some(item=>item.binding && hasExternalBindings(item.binding))
}
export function preservePlaybackBinding(previous = {}, source = {}) {
  const next = { ...clone(source), decimals: previous.decimals ?? 1, readOnly: true }
  for (const key of ['deviceScope','rotationDeviceIds','rotationIntervalMs','refreshMs','bindingVersion','deviceBindings']) {
    if (previous[key] !== undefined) next[key] = clone(previous[key])
  }
  if (previous.deviceScope && previous.deviceScope !== 'fixed') next.deviceId = previous.deviceId || source.deviceId || ''
  if (source.deviceScope === 'global') next.deviceScope = 'global'
  return next
}
export function sourceFromCatalog(item) {
  return normalizeSource({ ...item.binding, unit: item.unit || item.binding?.unit || '', catalogItemId: item.id, catalogTableId: item.tableId })
}
export function legacyWorkflow(binding = {}, devices = [], points = []) {
  if (binding.bindingVersion === 2) return clone(binding)
  const scope = binding.deviceScope || (binding.deviceId ? 'fixed' : 'current')
  const ids = scope === 'fixed' ? [String(binding.deviceId || '')].filter(Boolean)
    : binding.rotationDeviceIds?.length ? binding.rotationDeviceIds.map(String) : devices.slice(0,100).map(d => String(d.id))
  const key = String(binding.pointKey || binding.path || '').replace(/^device\./, '').replace(/^deviceDataMap\.[^.]+\./, '')
  const rows = ids.map(deviceId => {
    if (binding.mode !== 'plc' && !/^(device\.|deviceDataMap\.)/.test(binding.path || '')) return { deviceId, binding: normalizeSource({ ...binding, deviceId }) }
    const owned = points.filter(p => String(p.device_id) === deviceId && String(p.access_type || 'READ').toUpperCase() === 'READ')
    const direct = owned.find(p => String(p.id) === String(binding.pointId))
    const matches = owned.filter(p => `${p.category || 'analog'}.${p.value_role || p.name}` === key)
    const point = direct || (scope === 'fixed' && binding.pointId ? null : matches.length === 1 ? matches[0] : null)
    return { deviceId, binding: point ? normalizeSource({ mode:'plc', deviceId, pointId:String(point.id), pointKey:key, path:key, unit:point.unit || '' }) : null }
  })
  return { ...clone(binding), bindingVersion:2, deviceScope:scope, deviceBindings:rows, rotationDeviceIds:rows.map(r=>r.deviceId) }
}
export function workflowIssues(binding = {}, label = '组件', requiredDeviceIds) {
  if (binding.bindingVersion !== 2 || binding.deviceScope === 'global' || binding.mode==='static') return []
  const rows = binding.deviceBindings || [], issues = [], seen = new Set()
  const required = Array.isArray(requiredDeviceIds) ? requiredDeviceIds.map(deviceId=>rows.find(row=>row.deviceId===deviceId) || {deviceId,binding:null})
    : binding.deviceScope === 'fixed' ? rows.filter(row => row.deviceId === binding.deviceId) : rows
  if (!required.length) issues.push(`${label} 请添加设备与对应数据`)
  for (const row of rows) {
    if (!row.deviceId || seen.has(row.deviceId)) issues.push(`${label} 的设备清单有空项或重复设备`)
    seen.add(row.deviceId)
  }
  for (const row of required) {
    const b = row.binding
    if (!b || b.mode === 'plc' && !b.pointId || b.mode === 'dataset' && (!b.datasetId || !b.datasetField) || b.mode === 'runtime' && !b.path) issues.push(`${label} 的设备 ${row.deviceId} 未选择对应数据`)
  }
  const units = new Set(required.map(row=>row.binding?.unit).filter(Boolean))
  if (binding.deviceScope === 'rotation' && units.size > 1) issues.push(`${label} 的轮播数据单位不一致，请使用同一单位或先在数据中心换算`)
  return issues
}

export function widgetWorkflowIssues(widget = {}, label = '组件') {
  const primary=widget.data || {},issues=workflowIssues(primary,label)
  const scoped=primary.bindingVersion===2 && primary.deviceScope!=='global' && primary.mode!=='static'
  const ids=scoped ? primary.deviceScope==='fixed' ? [primary.deviceId].filter(Boolean) : (primary.deviceBindings || []).map(row=>row.deviceId) : []
  for(const [index,item] of (widget.content?.items || []).entries()){
    const binding=item.binding
    if(!binding)continue
    const metricLabel=`${label} 指标“${item.label || index+1}”`
    if(scoped && binding.bindingVersion===2 && binding.deviceScope!=='global' && binding.mode!=='static'){
      issues.push(...workflowIssues({...binding,deviceScope:primary.deviceScope,deviceId:primary.deviceId},metricLabel,ids))
    } else issues.push(...workflowIssues(binding,metricLabel))
  }
  return [...new Set(issues)]
}

export function expandedBindingWidgets(widgets = []) {
  return widgets.flatMap(widget=>{
    const primary=widget.data || {},requiredIds=primary.bindingVersion===2 && primary.deviceScope!=='global' && primary.mode!=='static'
      ? new Set(primary.deviceScope==='fixed' ? [primary.deviceId].filter(Boolean) : (primary.deviceBindings || []).map(row=>row.deviceId)) : null
    const expand=(binding,metric=false)=>binding?.bindingVersion===2 && binding.deviceScope!=='global' && binding.mode!=='static'
      ? (binding.deviceBindings || []).filter(row=>row.binding && (metric && requiredIds ? requiredIds.has(row.deviceId) : binding.deviceScope!=='fixed' || row.deviceId===binding.deviceId))
        .map(row=>({...widget,__sourceWidget:widget,data:{...row.binding,deviceId:row.deviceId,deviceScope:'fixed',readOnly:true}}))
      : [binding===widget.data ? widget : {...widget,__sourceWidget:widget,data:binding || {}}]
    return [...expand(widget.data),...(widget.content?.items || []).filter(item=>item.binding).flatMap(item=>expand(item.binding,true))]
  })
}
export function sourceBindingEntries(widget = {}) {
  const owners=[{binding:widget.data},...(widget.content?.items || []).map((item,metricIndex)=>({binding:item.binding,metricIndex}))]
  return owners.filter(owner=>owner.binding).flatMap(({binding,...owner})=>binding.bindingVersion===2
    ? [...(binding.deviceScope==='global'?[{binding,deviceId:binding.deviceId,...owner}]:[]),...(binding.deviceBindings || []).flatMap((row,deviceBindingIndex)=>row.binding
      ? [{binding:row.binding,deviceId:row.deviceId,deviceBindingIndex,...owner}] : [])]
    : [{binding,deviceId:binding.deviceId,...owner}])
}
