const number = v => v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v)
export function timeLabel(value, format = 'time') {
  const date = typeof value === 'number' || /^\d{13}$/.test(String(value)) ? new Date(Number(value)) : /^\d{4}-\d\d-\d\dT/.test(String(value)) ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return String(value ?? '')
  const time = [date.getHours(),date.getMinutes(),date.getSeconds()].map(v => String(v).padStart(2,'0')).join(':')
  return format === 'dateTime' ? `${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${time}` : time
}
// One axis policy for normal and extended curves; never force a temperature
// around 850 into a generic zero-based range with only a few vertical pixels.
export function configureTrendAxes(option, content = {}, unit = '', height = 160) {
  if (!option.xAxis || !option.yAxis || !option.series?.some(s => ['line','bar','scatter'].includes(s.type))) return option
  const horizontal = content.chartType === 'horizontalBar', axis = horizontal ? option.xAxis : option.yAxis, category = horizontal ? option.yAxis : option.xAxis
  if (axis.type !== 'value' || !['category','value'].includes(category.type)) return option
  const numeric = v => {const value=v?.value ?? v;return number(Array.isArray(value)?value[1]:value)}
  const values = option.series.flatMap(s => (s.data || []).map(numeric)).filter(v => v !== null)
  for(const stack of new Set(option.series.map(s=>s.stack).filter(Boolean))) {
    const group=option.series.filter(s=>s.stack===stack)
    for(let i=0;i<Math.max(...group.map(s=>s.data?.length || 0));i++) {
      const at=group.map(s=>numeric(s.data?.[i])).filter(v=>v!==null)
      if(at.length)values.push(at.reduce((sum,v)=>sum+Math.max(0,v),0),at.reduce((sum,v)=>sum+Math.min(0,v),0))
    }
  }
  const auto = content.yAxisMode !== 'fixed', padding = Math.max(.01,Math.min(.5,Number(content.yPadding ?? .12)))
  let min = number(content.yMin), max = number(content.yMax)
  if (auto || min === null || max === null || min >= max) {
    const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1
    const span = Math.max(high-low, Number(content.yMinimumSpan) || (unit === '°C' ? 5 : Math.max(1,Math.abs(high)*.01)))
    const center=(low+high)/2
    min = center - span*(.5+padding); max = center + span*(.5+padding)
    if(content.yIncludeZero === true || option.series.some(s=>s.type==='bar')){min=Math.min(0,min);max=Math.max(0,max)}
  }
  const show = content.showAxis !== false
  Object.assign(axis,{show,scale:true,min,max,splitNumber:height < 130 ? 2 : 4,name:content.yAxisTitle || unit,nameLocation:'end',nameGap:7,nameTextStyle:{color:content.axisLabelColor || '#bac5de',fontSize:10},axisLabel:{...axis.axisLabel,color:content.axisLabelColor || '#bac5de',fontSize:Number(content.axisFontSize || 11),hideOverlap:true,formatter:value=>Number(value.toFixed(Math.max(0,Math.min(4,Number(content.yDecimals ?? 1))))).toLocaleString('zh-CN')},splitLine:{show:content.showGrid!==false,lineStyle:{color:content.gridColor || 'rgba(180,195,225,.18)',type:'dashed'}}})
  if(category.type==='category')Object.assign(category,{show,axisLabel:{...category.axisLabel,color:content.axisLabelColor || '#bac5de',fontSize:Number(content.axisFontSize || 11),hideOverlap:true,interval:'auto',formatter:value=>timeLabel(value,content.timeFormat || 'time')}})
  if(option.tooltip)option.tooltip={...option.tooltip,axisPointer:{...option.tooltip.axisPointer,label:{formatter:params=>timeLabel(params.value,content.timeFormat || 'time')}},valueFormatter:value=>number(value)===null?'—':`${Number(value).toLocaleString('zh-CN',{maximumFractionDigits:4})}${unit ? ' '+unit : ''}`}
  // ECharts uses category values for the tooltip heading as well as tick labels.
  if(category.type==='category')category.data=(category.data || []).map(value=>timeLabel(value,content.timeFormat || 'time'))
  const legend = option.legend?.show && (content.legendPosition || 'top') === 'top'
  const bottomLegend=option.legend?.show && content.legendPosition==='bottom',rightLegend=option.legend?.show && content.legendPosition==='right'
  option.grid={...option.grid,top:legend ? 25 : (show ? 17 : 7),bottom:bottomLegend ? 44 : show ? 24 : 7,left:show ? 60 : 8,right:rightLegend ? 95 : 16,containLabel:false}
  return option
}

// Accept one new source sample, not one redraw/timer tick. Keep zero values;
// never replay the cached sample as fresh history or connect across a fault.
export function appendTrendSample(rows, sample, { limit = 120, windowSeconds = 600 } = {}) {
  const timestamp = Number(sample.timestamp), value = number(sample.value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return rows
  const last = rows.at(-1)
  if (last && timestamp <= last.timestamp) return rows
  const next = [...rows,{time:timestamp,timestamp,value:sample.quality === 'good' ? value : null}]
  return next.filter(row=>row.timestamp>=timestamp-Math.max(10,Number(windowSeconds)||600)*1000).slice(-Math.max(8,Math.min(600,Number(limit)||120)))
}
