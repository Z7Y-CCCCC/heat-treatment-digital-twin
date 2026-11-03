// Keep one entry per workflow; older authored direct bindings stay editable.
export const LEGACY_BINDINGS = Object.freeze([
  { id:'database', label:'数据库直连' },
  { id:'http_api', label:'接口直连' },
  { id:'business', label:'业务摘要' }
])
export const DATASET_WIDGETS = new Set(['value','text','status','trend','hud_chart_dock','alarm_list','hud_alarm_panel','marquee','metrics','hud_kpi_panel','business_summary','device_list','hud_device_status'])
export function widgetBindingChoices(widget = {}) {
  const choices=[{id:'static',label:'静态内容'}]
  if(DATASET_WIDGETS.has(widget.type))choices.push({id:'dataset',label:'外部数据集'},{id:'plc',label:'设备点位'})
  choices.push({id:'runtime',label:'设备 / 部件信息'})
  const legacy=LEGACY_BINDINGS.find(item=>item.id===widget.data?.mode)
  if(legacy)choices.push({...legacy,label:legacy.label+'（现有绑定）'})
  for(const id of ['plc','dataset'])if(widget.data?.mode===id&&!choices.some(c=>c.id===id))choices.push({id,label:id==='plc'?'设备点位（现有绑定）':'外部数据集（现有绑定）'})
  return choices
}
