export const pointKey = point => `${point.category || point.category_resolved || 'analog'}.${point.value_role || point.field_name || point.name}`
export const runtimePointKey = binding => String(binding.pointKey || binding.path || '').replace(/^device\./,'').replace(/^deviceDataMap\.[^.]+\./,'')
export function findBoundPoint(binding, deviceId, points = []) {
  const rows=points.filter(p=>String(p.device_id)===String(deviceId) && String(p.access_type || 'READ').toUpperCase()==='READ')
  const direct=rows.find(p=>String(p.id)===String(binding.pointId || ''))
  if(direct)return direct
  const matches=rows.filter(p=>pointKey(p)===runtimePointKey(binding))
  return matches.length===1?matches[0]:null
}
export function migrateDeviceTrend(widget, points = []) {
  if(!['trend','hud_chart_dock'].includes(widget.type) || widget.data?.mode !== 'runtime' || !/^(device\.\w+\.|deviceDataMap\.[^.]+\.)/.test(widget.data.path || ''))return widget
  const key=runtimePointKey(widget.data), matches=points.filter(p=>pointKey(p)===key && String(p.access_type || 'READ').toUpperCase()==='READ')
  const point=matches.find(p=>String(p.device_id)===String(widget.data.deviceId)) || matches[0]
  return {...widget,data:{...widget.data,mode:'plc',path:key,pointKey:key,pointId:point?String(point.id):'',requireConfiguredPoint:true},content:{...widget.content,yAxisMode:widget.content?.yAxisMode || 'auto',timeWindowSeconds:widget.content?.timeWindowSeconds || 600,historyLength:widget.content?.timeWindowSeconds ? widget.content.historyLength : 600}}
}
