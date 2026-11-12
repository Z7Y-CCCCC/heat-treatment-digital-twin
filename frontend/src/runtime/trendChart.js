const number = v => v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v)
const positive = value => { const n=number(value); return n !== null && n>0 ? n : null }
const MAX_AXIS_INTERVALS = 200
export function trendWindowSeconds(value=600) {
  const seconds=Number(value)
  return Number.isSafeInteger(seconds) && seconds>=60 && seconds<=8640000000000 ? seconds : 600
}
// Drawing budget, not a storage policy. Keep extrema/outages and the complete
// time span instead of silently turning a one-hour window into its last 600 points.
export function compactTrendRows(rows,limit=2000) {
  const budget=Math.max(8,Math.min(20000,Math.floor(Number(limit)||2000)))
  if(rows.length<=budget)return rows
  const size=Math.ceil(rows.length/Math.floor(budget/5)),selected=new Map()
  for(let start=0;start<rows.length;start+=size){
    const end=Math.min(rows.length,start+size);let minimum=start,maximum=start,fault=-1
    for(let i=start;i<end;i++){
      if(rows[i].value===null){if(fault<0)fault=i;continue}
      if(rows[minimum].value===null || rows[i].value<rows[minimum].value)minimum=i
      if(rows[maximum].value===null || rows[i].value>rows[maximum].value)maximum=i
    }
    for(const index of [start,end-1,minimum,maximum,fault])if(index>=0)selected.set(index,rows[index])
  }
  return [...selected.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row)
}
function chartTimes(values) {
  let previous=null, day=0
  return values.map(value=>{
    const clock=/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(String(value))
    let timestamp=typeof value==='number' || /^\d{13}$/.test(String(value)) ? Number(value)
      : clock ? new Date(2000,0,1,Number(clock[1]),Number(clock[2]),Number(clock[3] || 0),Number((clock[4] || '').padEnd(3,'0'))).getTime()
      : /^\d{4}-\d\d-\d\d[T ]/.test(String(value)) ? Date.parse(value) : NaN
    if(!Number.isFinite(timestamp))return null
    if(clock){if(previous!==null && timestamp+day<previous)day+=86400000;timestamp+=day}
    previous=timestamp
    return timestamp
  })
}

export function chartTickError(content = {}) {
  if(content.yTickInterval !== undefined && content.yTickInterval !== '' && positive(content.yTickInterval)===null)return 'Y 轴刻度间隔须大于 0；修正前使用自动间隔。'
  const yStep=positive(content.yTickInterval), span=number(content.yMax)-number(content.yMin)
  if(yStep && content.yAxisMode==='fixed' && span/yStep>MAX_AXIS_INTERVALS)return 'Y 轴刻度过密（超过 200 格），请增大间隔；修正前使用自动间隔。'
  if(content.xTickMode==='time' && positive(content.xTickIntervalSeconds ?? 10)===null)return 'X 轴时间间隔须大于 0；修正前使用自动间隔。'
  if(content.xTickMode==='category' && (!Number.isInteger(Number(content.xLabelEvery ?? 1)) || Number(content.xLabelEvery ?? 1)<1))return 'X 轴数据项间隔须为大于 0 的整数；修正前使用自动间隔。'
  return ''
}
export function timeLabel(value, format = 'time') {
  const date = typeof value === 'number' || /^\d{13}$/.test(String(value)) ? new Date(Number(value)) : /^\d{4}-\d\d-\d\dT/.test(String(value)) ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return String(value ?? '')
  const time = [date.getHours(),date.getMinutes(),date.getSeconds()].map(v => String(v).padStart(2,'0')).join(':')
  return format === 'dateTime' ? `${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${time}` : time
}
// One axis policy for normal and extended curves; never force a temperature
// around 850 into a generic zero-based range with only a few vertical pixels.
export function configureTrendAxes(option, content = {}, unit = '', height = 160, sourceSeries = []) {
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
  const yStep=positive(content.yTickInterval)
  const yInterval=yStep && (max-min)/yStep<=MAX_AXIS_INTERVALS ? yStep : undefined
  if(yInterval && (auto || number(content.yMin)===null || number(content.yMax)===null || number(content.yMin)>=number(content.yMax))){min=Math.floor(min/yInterval)*yInterval;max=Math.ceil(max/yInterval)*yInterval}
  const show = content.showAxis !== false
  Object.assign(axis,{show,scale:true,min,max,splitNumber:height < 130 ? 2 : 4,name:content.yAxisTitle || unit,nameLocation:'end',nameGap:7,nameTextStyle:{color:content.axisLabelColor || '#bac5de',fontSize:10},axisLabel:{...axis.axisLabel,color:content.axisLabelColor || '#bac5de',fontSize:Number(content.axisFontSize || 11),hideOverlap:true,formatter:value=>Number(value.toFixed(Math.max(0,Math.min(4,Number(content.yDecimals ?? 1))))).toLocaleString('zh-CN')},splitLine:{show:content.showGrid!==false,lineStyle:{color:content.gridColor || 'rgba(180,195,225,.18)',type:'dashed'}}})
  axis.interval=yInterval
  if(yInterval)axis.axisTick={show}
  if(category.type==='category')Object.assign(category,{show,axisLabel:{...category.axisLabel,color:content.axisLabelColor || '#bac5de',fontSize:Number(content.axisFontSize || 11),hideOverlap:true,interval:'auto',formatter:value=>timeLabel(value,content.timeFormat || 'time')}})
  if(category.type==='category' && content.xTickMode==='category') {
    const every=Number(content.xLabelEvery ?? 1)
    if(Number.isInteger(every) && every>0){category.axisLabel.interval=every-1;category.axisTick={show,interval:every-1,alignWithLabel:true}}
  }
  // A numeric timestamp axis honors an exact user interval. Calendar-based
  // "time" scales otherwise round some requested intervals to nicer units.
  // Only presentation coordinates change; samples and outage gaps stay intact.
  if(!horizontal && category.type==='category' && content.xTickMode==='time' && option.series.every(series=>['line','bar'].includes(series.type))) {
    const step=(positive(content.xTickIntervalSeconds ?? 10) || 0)*1000, times=chartTimes(category.data || [])
    const perSeriesTimes=option.series.map((series,index)=>{
      const rows=sourceSeries[index]?.rows,field=content.categoryField || content.timeField || 'time'
      return rows?.length===series.data?.length ? chartTimes(rows.map(row=>row[field])) : times
    }), allTimes=perSeriesTimes.flat()
    if(step && times.length && times.every(time=>time!==null) && allTimes.every(time=>time!==null)) {
      const minimum=Math.floor(Math.min(...allTimes)/step)*step,maximum=Math.max(minimum+step,Math.ceil(Math.max(...allTimes)/step)*step)
      if((maximum-minimum)/step<=MAX_AXIS_INTERVALS){
        Object.assign(category,{type:'value',scale:true,min:minimum,max:maximum,interval:step,boundaryGap:[0,0],axisTick:{show},axisLabel:{...category.axisLabel,interval:undefined,formatter:value=>timeLabel(value,content.timeFormat || 'time')}})
        category.splitLine={show:content.showGrid!==false,lineStyle:{color:content.gridColor || 'rgba(180,195,225,.18)',type:'dashed'}}
        delete category.data
        option.series.forEach((series,index)=>{
          series.data=(series.data || []).map((value,i)=>[perSeriesTimes[index][i] ?? null,value?.value ?? value])
        })
      }
    }
  }
  if(option.tooltip)option.tooltip={...option.tooltip,axisPointer:{...option.tooltip.axisPointer,label:{formatter:params=>timeLabel(params.value,content.timeFormat || 'time')}},valueFormatter:value=>{const sample=Array.isArray(value)?value[1]:value;return number(sample)===null?'—':`${Number(sample).toLocaleString('zh-CN',{maximumFractionDigits:4})}${unit ? ' '+unit : ''}`}}
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
  return compactTrendRows(next.filter(row=>row.timestamp>=timestamp-Math.max(10,Number(windowSeconds)||600)*1000),limit)
}
