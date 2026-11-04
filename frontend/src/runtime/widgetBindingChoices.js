// Keep one entry per workflow; older authored direct bindings stay editable.
export const LEGACY_BINDINGS = Object.freeze([
  { id:'database', label:'数据库直连' },
  { id:'http_api', label:'接口直连' },
  { id:'business', label:'业务摘要' }
])
export const DATASET_WIDGETS = new Set(['map_region_list','value','text','status','trend','hud_chart_dock','alarm_list','hud_alarm_panel','marquee','metrics','hud_kpi_panel','business_summary','device_list','hud_device_status'])
export const POINT_WIDGETS = new Set([...DATASET_WIDGETS].filter(type=>!['business_summary','device_list','hud_device_status','map_region_list'].includes(type)))
export function widgetBindingChoices(widget = {}, {mapContext=false} = {}) {
  const choices=[{id:'static',label:'静态内容'}]
  if(DATASET_WIDGETS.has(widget.type))choices.push({id:'dataset',label:'外部数据集'})
  if(POINT_WIDGETS.has(widget.type)) {
    choices.push({id:'plc',label:'设备点位'})
    if(!['trend','hud_chart_dock'].includes(widget.type))choices.push({id:'runtime',label:'设备 / 部件信息'})
  }
  if((mapContext || widget.type==='map_region_list') && !choices.some(c=>c.id==='runtime'))choices.push({id:'runtime',label:'地图区域数据'})
  if(mapContext)for(const c of choices)if(c.id==='runtime')c.label='地图区域数据'
  const legacy=LEGACY_BINDINGS.find(item=>item.id===widget.data?.mode)
  if(legacy)choices.push({...legacy,label:legacy.label+'（现有绑定）'})
  for(const [id,label] of [['plc','设备点位'],['dataset','外部数据集'],['runtime','设备 / 部件信息']])if(widget.data?.mode===id&&!choices.some(c=>c.id===id))choices.push({id,label:label+'（现有绑定）'})
  return choices
}
