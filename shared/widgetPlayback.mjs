import { normalizeBindingWorkflow, bindingForDevice } from './widgetBindingWorkflow.mjs'
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.round(Math.min(max, Math.max(min, Number(value)))) : fallback
// This timestamp only selects an allowed device; refreshing and cache freshness
// keep using real time. A hover pause can legitimately retain an old clock.
export function isPlaybackTimestamp(value, currentTime = Date.now()) {
  return Number.isSafeInteger(value) && value >= 0 && value <= currentTime + 60000
}
export function normalizePlayback(binding = {}) {
  const scope = ['current','fixed','rotation','global'].includes(binding.deviceScope) ? binding.deviceScope : (binding.deviceId ? 'fixed' : 'current')
  const ids = Array.isArray(binding.rotationDeviceIds) ? [...new Set(binding.rotationDeviceIds.map(String).filter(id=>/^[\w.-]{1,128}$/.test(id)))].slice(0,100) : []
  return { deviceScope:scope, rotationDeviceIds:ids, rotationIntervalMs:bounded(binding.rotationIntervalMs,10000,2000,3600000), refreshMs:bounded(binding.refreshMs,5000,250,3600000), ...normalizeBindingWorkflow(binding) }
}
export function flattenPlaybackDevices(config = {}) {
  const rows=[]
  for (const w of config.workshops || []) {
    for (const d of w.devices || []) rows.push({...d,workshopId:w.id,workshopName:w.name,lineName:'',lineId:d.line_id || ''})
    for (const l of w.lines || []) for (const d of l.devices || []) rows.push({...d,workshopId:w.id,workshopName:w.name,lineName:l.name,lineId:l.id})
  }
  return [...new Map(rows.map(d=>[String(d.id),{...d,id:String(d.id),name:String(d.name || d.id)}])).values()]
}
export function playbackSelection(binding, context = {}, devices = [], now = Date.now()) {
  const config=normalizePlayback(binding), byId=new Map(devices.map(d=>[String(d.id),d]))
  if(config.deviceScope==='global')return {device:null,index:0,total:0,mode:'global'}
  if (binding.bindingVersion === 2 && !context.tooltipTarget) {
    if(config.deviceScope==='fixed')return {device:byId.get(String(binding.deviceId || '')) || null,index:0,total:1,mode:'fixed'}
    if(config.deviceScope==='current')return {device:byId.get(String(context.deviceId || '')) || null,index:0,total:1,mode:'current'}
    const rows=binding.deviceBindings || [], index=rows.length ? Math.floor(Math.max(0,now)/config.rotationIntervalMs)%rows.length : 0
    return {device:byId.get(String(rows[index]?.deviceId || '')) || null,index,total:rows.length,mode:'rotation'}
  }
  // Hover templates have their own object scope, never a rotating main-view
  // selection. Explicit fixed bindings still opt into another registered device.
  if(context.tooltipTarget===true) {
    const selectedId=config.deviceScope==='fixed' ? String(binding.deviceId || '') : String(context.deviceId || '')
    return {device:byId.get(selectedId) || null,index:0,total:1,mode:config.deviceScope==='fixed'?'fixed':'current'}
  }
  const deviceView=!!context.deviceId && (context.viewMode==='device' || /^device_/.test(context.viewId || '') || !!context.inspectionStage)
  if (deviceView) return {device:byId.get(String(context.deviceId)) || null,index:0,total:1,mode:'current'}
  if (config.deviceScope==='fixed') return {device:byId.get(String(binding.deviceId || '')) || null,index:0,total:1,mode:'fixed'}
  let eligible=devices.filter(d=>(!context.workshopId || String(d.workshopId || d.workshop_id || '')===String(context.workshopId)) && (!context.lineId || String(d.lineId || d.line_id || '')===String(context.lineId)))
  if (config.rotationDeviceIds.length) {
    const scoped=new Map(eligible.map(d=>[String(d.id),d]))
    eligible=config.rotationDeviceIds.map(id=>scoped.get(id)).filter(Boolean)
  } else if (config.deviceScope==='current' && context.deviceId) eligible=eligible.filter(d=>String(d.id)===String(context.deviceId))
  const index=eligible.length ? Math.floor(Math.max(0,now)/config.rotationIntervalMs)%eligible.length : 0
  return {device:eligible[index] || null,index,total:eligible.length,mode:eligible.length>1?'rotation':'current'}
}
export function isDeviceBinding(binding = {}) {
  if(binding.deviceScope==='global')return false
  return ['plc','dataset','database','http_api','business'].includes(binding.mode) || /^(deviceDataMap|deviceStatusMap|selectedPart|deviceInfo|device)\./.test(binding.path || '')
}
export function devicePoint(binding, deviceId, pointValues = {}) {
  if (!deviceId) return null
  if (binding.bindingVersion === 2) {
    const selected=bindingForDevice(binding,deviceId), point=pointValues[String(selected.pointId || '')] || pointValues[`${deviceId}:${selected.pointId}`]
    return !selected.bindingMissing && point && String(point.id)===String(selected.pointId) && String(point.device_id)===String(deviceId) ? point : null
  }
  const direct=pointValues[String(binding.pointId || '')]
  if(direct && String(direct.id)===String(binding.pointId) && String(direct.device_id)===String(deviceId))return direct
  const rows=[...new Map(Object.values(pointValues).filter(p=>p && String(p.device_id)===String(deviceId)).map(p=>[String(p.id),p])).values()]
  const exact=rows.find(p=>String(p.id)===String(binding.pointId || ''))
  if (exact) return exact
  // A fixed source with an explicit ID cannot silently switch to another
  // same-role point after deletion. Detail-view context overrides remain
  // reusable on a different device, as do current/rotating bindings.
  if (binding.deviceScope==='fixed' && binding.pointId && String(binding.deviceId || '')===String(deviceId)) return null
  const template=pointValues[binding.pointId], key=String(binding.pointKey || (template ? `${template.category || 'analog'}.${template.value_role || template.name || ''}` : binding.path || ''))
  const matches=rows.filter(p=>`${p.category || 'analog'}.${p.value_role || p.name || ''}`===key)
  return matches.length===1 ? matches[0] : null
}
