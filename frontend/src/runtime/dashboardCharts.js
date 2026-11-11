const numeric=value=>value===null || value===undefined || value==='' || typeof value==='boolean' || !Number.isFinite(Number(value)) ? null : Number(value)
const numberAt=(row,key)=>numeric(row?.[key])
export function gaugeChartRange(content = {}, reading = null, unit = '') {
 const value = numeric(reading), configuredMin = numeric(content.min), configuredMax = numeric(content.max)
 const nice = value => { const step = 10 ** Math.floor(Math.log10(Math.max(1, value))); return Math.ceil(value / step) * step }
 const minimum = configuredMin ?? (value !== null && value < 0 ? -nice(Math.abs(value) * 1.1) : 0)
 const maximum = configuredMax ?? (unit === '%' ? 100 : nice(Math.max(100, value === null ? 100 : value * 1.1)))
 return minimum < maximum ? { min: minimum, max: maximum } : { min: 0, max: nice(Math.max(100, value === null ? 100 : value * 1.1)) }
}
export function extendedChartOption(type,{common={},sourceSeries=[],content={},binding={}}) {
 const rows=sourceSeries[0]?.rows || [], time=content.categoryField || content.timeField || 'time', value=content.valueField || 'value'
 const grid={left:45,right:22,top:28,bottom:38,containLabel:true}
 const categories=rows.map((r,i)=>String(r[time] ?? r.label ?? i+1))
 const label={show:content.showDataLabel===true,color:'#d9d3f3',fontSize:10}
 const points=rows.map((r,i)=>({name:categories[i],value:numberAt(r,value)})).filter(p=>p.value!==null)
 const axis={type:'category',data:categories,axisLabel:{color:'#9e99b7'},axisLine:{lineStyle:{color:'#d8d0ff22'}}},vertical={type:'value',splitLine:{lineStyle:{color:'#d8d0ff12'}},axisLabel:{color:'#9e99b7'}}
 if(['pie','donut','rose','funnel'].includes(type)) {
  const data=(content.pieDataMode==='series' || sourceSeries.length>1 ? sourceSeries.map(s=>({name:s.name,value:numeric(s.value)})).filter(p=>p.value!==null) : points).filter(point=>point.value>=0)
  const palette=['#a995d8','#7f91cc','#71aaa3','#d2b783','#a37d9a','#8c9ac4'];data.forEach((p,i)=>{p.itemStyle={color:palette[i%palette.length]}})
  common={...common,legend:{...common.legend,show:content.showLegend!==false && data.length>1},tooltip:{...common.tooltip,trigger:'item'}}
  if(type==='funnel')return {...common,series:[{type:'funnel',top:26,bottom:15,left:'10%',width:'80%',sort:'descending',label:{...label,show:content.showDataLabel!==false},data}]}
  return {...common,series:[{type:'pie',stillShowZeroSum:false,roseType:type==='rose'?'radius':undefined,radius:type==='donut'?[`${Number(content.donutRatio ?? 48)}%`,'76%']:['0%','76%'],center:['50%','55%'],label:{...label,show:content.showDataLabel!==false,formatter:'{b}\n{c}'},itemStyle:{borderColor:'#50456355',borderWidth:1},data}]}
 }
 if(type==='radar') {
  if(sourceSeries.length<3 || !rows.length)return {...common,series:[]}
  const validRows=rows.filter(r=>sourceSeries.every(s=>numberAt(r,s.field || s.id)!==null))
  const indicator=sourceSeries.map(s=>({name:s.name,max:Math.max(1,Number(content.max) || Math.max(0,...validRows.map(r=>numberAt(r,s.field || s.id) || 0))*1.1)}))
  return {...common,radar:{indicator,radius:'63%',axisName:{color:'#b4accb'},splitArea:{areaStyle:{color:['#a796dc08','#a796dc10']}},splitLine:{lineStyle:{color:'#a796dc22'}}},series:[{type:'radar',label,data:validRows.slice(0,20).map((r,i)=>({name:categories[i],value:sourceSeries.map(s=>numberAt(r,s.field || s.id))}))}]}
 }
 if(type==='heatmap') {
  const xf=content.xField || 'x',yf=content.yField || 'y',vf=content.heatValueField || value
  const valid=rows.filter(r=>r[xf]!=null && r[yf]!=null && numberAt(r,vf)!==null),xs=[...new Set(valid.map(r=>String(r[xf])))],ys=[...new Set(valid.map(r=>String(r[yf])))]
  const values=valid.map(r=>numberAt(r,vf)),min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):1
  return {...common,grid:{...grid,bottom:60},xAxis:{...axis,data:xs},yAxis:{...axis,data:ys},visualMap:{min,max:max===min?min+1:max,orient:'horizontal',left:'center',bottom:0,inRange:{color:['#403453','#8170bc','#d3b7fa']},textStyle:{color:'#b4accb'}},series:[{type:'heatmap',label,data:valid.map(r=>[xs.indexOf(String(r[xf])),ys.indexOf(String(r[yf])),numberAt(r,vf)])}]}
 }
 if(type==='candlestick' || type==='boxplot') {
  const keys=type==='candlestick'?[content.openField || 'open',content.closeField || 'close',content.lowField || 'low',content.highField || 'high']:[content.lowField || 'min',content.q1Field || 'q1',content.medianField || 'median',content.q3Field || 'q3',content.highField || 'max']
  const data=rows.map(r=>keys.map(key=>numberAt(r,key))).map(v=>v.every(n=>n!==null)?v:null)
  return {...common,grid,xAxis:axis,yAxis:vertical,series:[{type,itemStyle:{color:'#a695d8',color0:'#5a9f9b',borderColor:'#c1b3eb',borderColor0:'#86c6bf'},data}]}
 }
 if(type==='waterfall') {
  let sum=0;const base=[],delta=[]
  for(const r of rows){const v=numberAt(r,value);if(v===null){base.push(null);delta.push(null);continue}base.push(Math.min(sum,sum+v));delta.push({value:Math.abs(v),delta:v,itemStyle:{color:v>=0?'#a391d6':'#6da7a2'}});sum+=v}
  return {...common,grid,xAxis:axis,yAxis:vertical,legend:{show:false},series:[{type:'bar',stack:'sum',silent:true,itemStyle:{color:'transparent'},data:base},{type:'bar',stack:'sum',label:{...label,formatter:p=>p.data?.delta ?? ''},data:delta}]}
 }
 if(type==='scatter' && content.xField) {
  const data=rows.map(r=>[numberAt(r,content.xField),numberAt(r,value)]).filter(p=>p.every(n=>n!==null))
  return {...common,grid,xAxis:vertical,yAxis:vertical,series:[{type:'scatter',symbolSize:8,label,data}]}
 }
 if(['horizontalBar','lineBar','smoothLine','stepLine','stackedArea'].includes(type)) {
  const horizontal=type==='horizontalBar'
  return {...common,grid,xAxis:horizontal?vertical:axis,yAxis:horizontal?{...axis,inverse:true}:vertical,series:sourceSeries.map((s,i)=>({
   name:s.name,type:horizontal || type==='lineBar'&&i===0?'bar':'line',smooth:type==='smoothLine'?content.smooth!==false:type!=='stepLine'&&content.smooth===true,step:type==='stepLine'?'end':undefined,showSymbol:content.showSymbol===true,
   stack:type==='stackedArea'?'total':undefined,areaStyle:type==='stackedArea'?{opacity:Number(content.areaOpacity ?? .2)}:undefined,
   lineStyle:{width:Number(content.lineWidth || 2)},itemStyle:{color:s.color,borderRadius:horizontal?3:0},label,data:s.rows.map(r=>numberAt(r,value))
  }))}
 }
 return null
}
