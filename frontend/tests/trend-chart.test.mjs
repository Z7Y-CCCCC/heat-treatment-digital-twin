import test from 'node:test'
import assert from 'node:assert/strict'
import { configureTrendAxes,appendTrendSample,timeLabel,chartTickError } from '../src/runtime/trendChart.js'
import { migrateDeviceTrend,findBoundPoint } from '../src/runtime/pointBinding.js'
import { extendedChartOption, gaugeChartRange } from '../src/runtime/dashboardCharts.js'
import { normalizeDashboardWidget } from '../src/runtime/dashboardSchema.js'
test('temperature smooth curves have a readable auto scale, unit, grid and 24-hour timestamps',()=>{
 const time=Date.now(),option=extendedChartOption('smoothLine',{sourceSeries:[{name:'炉温',rows:[{time,value:857.3},{time:time+1000,value:859.8}]}]})
 configureTrendAxes(option,{chartType:'smoothLine'},'°C',110)
 assert.ok(option.yAxis.min<857.3);assert.ok(option.yAxis.max>859.8);assert.ok(option.yAxis.max-option.yAxis.min<10)
 assert.equal(option.yAxis.name,'°C');assert.equal(option.yAxis.splitNumber,2);assert.equal(option.yAxis.splitLine.show,true)
 assert.match(option.xAxis.data[0],/^\d\d:\d\d:\d\d$/);assert.equal(option.tooltip,undefined)
 assert.equal(timeLabel(String(time)),timeLabel(time))
})
test('fixed bounds and axis visibility persist; invalid fixed bounds safely auto fit and missing is not zero',()=>{
 const option=()=>({xAxis:{type:'category',data:['a','b']},yAxis:{type:'value'},series:[{type:'line',data:[850,null]}]})
 const fixed=configureTrendAxes(option(),{yAxisMode:'fixed',yMin:0,yMax:1200,showGrid:false,yAxisTitle:'炉温',yDecimals:0},'°C')
 assert.equal(fixed.yAxis.min,0);assert.equal(fixed.yAxis.max,1200);assert.equal(fixed.yAxis.splitLine.show,false);assert.equal(fixed.yAxis.axisLabel.formatter(850.4),'850')
 const auto=configureTrendAxes(option(),{yAxisMode:'fixed',yMin:900,yMax:100,showAxis:false},'°C')
 assert.ok(auto.yAxis.min>840);assert.equal(auto.yAxis.show,false)
})
test('history uses source timestamps, keeps zero, deduplicates cache polls, leaves outage gaps and bounds retention',()=>{
 const time=Date.now(),options={limit:8,windowSeconds:10};let rows=[]
 for(let i=0;i<15;i++)rows=appendTrendSample(rows,{timestamp:time+i*1000,value:i,quality:i===13?'bad':'good'},options)
 assert.equal(rows.length,8);assert.equal(rows.at(-2).value,null)
 assert.equal(appendTrendSample(rows,{timestamp:time+14000,value:999,quality:'good'},options),rows)
 assert.equal(appendTrendSample([],{timestamp:time,value:0,quality:'good'}).at(-1).value,0)
 assert.equal(appendTrendSample([],{timestamp:time,value:'',quality:'good'}).at(-1).value,null)
})
test('legacy device temperature charts migrate to explicit configured point bindings; peers must own a unique READ point',()=>{
 const points=[{id:'a',device_id:'d1',category:'analog',value_role:'actual_temp',access_type:'READ'},{id:'b',device_id:'d2',category:'analog',value_role:'actual_temp',access_type:'READ'}]
 const old={id:'temp',type:'hud_chart_dock',data:{mode:'runtime',path:'device.analog.actual_temp',deviceScope:'rotation'},content:{chartType:'smoothLine'}}
 const next=migrateDeviceTrend(old,points)
 assert.equal(next.data.mode,'plc');assert.equal(next.data.requireConfiguredPoint,true);assert.equal(old.data.mode,'runtime')
 assert.equal(findBoundPoint(next.data,'d2',points).id,'b');assert.equal(findBoundPoint(next.data,'missing',points),null)
 assert.equal(findBoundPoint(next.data,'d2',[...points,{...points[1],id:'c'}]),null)
 const empty=migrateDeviceTrend(old,[]);assert.equal(empty.data.pointId,'');assert.equal(empty.data.requireConfiguredPoint,true)
 assert.equal(normalizeDashboardWidget(empty).data.requireConfiguredPoint,true)
})
test('fixed trend references never migrate or resolve against a different device or replacement point',()=>{
 const point={id:'new',device_id:'other',category:'analog',value_role:'actual_temp',access_type:'READ'}
 const binding={deviceScope:'fixed',deviceId:'deleted',pointId:'638',pointKey:'analog.actual_temp'}
 assert.equal(findBoundPoint(binding,'deleted',[{...point,device_id:'deleted'}]),null)
 assert.equal(findBoundPoint(binding,'other',[point]),null)
 const old={type:'trend',data:{...binding,mode:'runtime',path:'device.analog.actual_temp'}}
 for(const rows of [[point],[{...point,device_id:'deleted',access_type:'WRITE'}],[{...point,device_id:'deleted'},{...point,id:'new2',device_id:'deleted'}],[{...point,device_id:'deleted'}]])assert.equal(migrateDeviceTrend(old,rows).data.pointId,'638')
 const roleOnly={...old,data:{...old.data,pointId:''}}
 assert.equal(migrateDeviceTrend(roleOnly,[point]).data.pointId,'')
 assert.equal(migrateDeviceTrend(roleOnly,[{...point,device_id:'deleted',access_type:'WRITE'}]).data.pointId,'')
 assert.equal(migrateDeviceTrend(roleOnly,[{...point,device_id:'deleted'},{...point,id:'new2',device_id:'deleted'}]).data.pointId,'')
 assert.equal(migrateDeviceTrend(roleOnly,[{...point,device_id:'deleted'}]).data.pointId,'new')
})

test('stacked series bounds include totals and the smooth switch controls the actual rendered curve',()=>{
 const input={content:{smooth:false},sourceSeries:[{name:'A',rows:[{time:1,value:10}]},{name:'B',rows:[{time:1,value:20}]}]}
 const stacked=configureTrendAxes(extendedChartOption('stackedArea',input),{chartType:'stackedArea'})
 assert.ok(stacked.yAxis.max>=30);assert.ok(stacked.yAxis.min<=0)
 assert.equal(extendedChartOption('smoothLine',input).series[0].smooth,false)
})

test('gauge auto range fits actual temperatures, preserves explicit bounds and rejects blank or invalid ranges', () => {
 const automatic=gaugeChartRange({},850.1,'°C')
 assert.equal(automatic.min,0);assert.ok(automatic.max>850.1)
 assert.deepEqual(gaugeChartRange({min:0,max:1200},850.1,'°C'),{min:0,max:1200})
 assert.deepEqual(gaugeChartRange({min:'',max:''},850.1,'°C'),automatic)
 assert.deepEqual(gaugeChartRange({min:900,max:10},850.1,'°C'),automatic)
 assert.deepEqual(gaugeChartRange({},0,'%'),{min:0,max:100})
 assert.ok(gaugeChartRange({},-20,'°C').min<-20)
})

test('pie excludes negative and missing slices, preserves real zero and never draws equal fake zero-sum sectors', () => {
 const pie=extendedChartOption('pie',{sourceSeries:[{rows:[{time:'A',value:10},{time:'B',value:0},{time:'negative',value:-2},{time:'missing',value:null}]}]})
 assert.deepEqual(pie.series[0].data.map(point=>point.value),[10,0])
 assert.equal(pie.series[0].stillShowZeroSum,false)
})

test('explicit Y tick spacing respects fixed bounds and aligns automatic bounds without changing samples',()=>{
 const base=()=>({xAxis:{type:'category',data:['A','B']},yAxis:{type:'value'},series:[{type:'line',data:[850.1,852.7]}]})
 const fixed=configureTrendAxes(base(),{yAxisMode:'fixed',yMin:840,yMax:860,yTickInterval:5},'°C')
 assert.equal(fixed.yAxis.interval,5);assert.equal(fixed.yAxis.min,840);assert.equal(fixed.yAxis.max,860)
 const automatic=configureTrendAxes(base(),{yTickInterval:5},'°C')
 assert.equal(automatic.yAxis.min%5,0);assert.equal(automatic.yAxis.max%5,0)
 assert.deepEqual(automatic.series[0].data,[850.1,852.7])
 for(const value of ['',0,-1,NaN,Infinity])assert.equal(configureTrendAxes(base(),{yTickInterval:value}).yAxis.interval,undefined)
 assert.equal(configureTrendAxes(base(),{yAxisMode:'fixed',yMin:0,yMax:1000,yTickInterval:.001}).yAxis.interval,undefined)
 assert.match(chartTickError({yTickInterval:-1}),/大于 0/)
 assert.match(chartTickError({yAxisMode:'fixed',yMin:0,yMax:1000,yTickInterval:.001}),/过密/)
})

test('explicit X time spacing uses real timestamps and exact millisecond intervals, including gaps and distinct series times',()=>{
 const time=Date.parse('2026-11-11T10:00:00+08:00'),source=[{rows:[{time,value:0},{time:time+17000,value:null}]},{rows:[{time:time+3000,value:1},{time:time+27000,value:2}]}]
 const base={tooltip:{},xAxis:{type:'category',data:source[0].rows.map(r=>r.time)},yAxis:{type:'value'},series:source.map(s=>({type:'line',data:s.rows.map(r=>r.value)}))}
 const result=configureTrendAxes(base,{xTickMode:'time',xTickIntervalSeconds:10},'°C',160,source)
 assert.equal(result.xAxis.type,'value');assert.equal(result.xAxis.interval,10000)
 assert.equal(result.xAxis.splitLine.show,true);assert.equal(result.xAxis.splitLine.lineStyle.type,'dashed')
 assert.ok(result.xAxis.max>=time+27000);assert.equal(result.xAxis.data,undefined)
 assert.deepEqual(result.series[0].data,[[time,0],[time+17000,null]])
 assert.deepEqual(result.series[1].data,[[time+3000,1],[time+27000,2]])
 assert.equal(result.tooltip.valueFormatter([time,0]),'0 °C');assert.equal(result.tooltip.valueFormatter([time,null]),'—')
 assert.match(result.xAxis.axisLabel.formatter(time),/^\d\d:\d\d:\d\d$/)
})

test('category tick cadence, plain clock values across midnight and invalid time inputs remain safe',()=>{
 const base=labels=>({xAxis:{type:'category',data:labels},yAxis:{type:'value'},series:[{type:'line',data:labels.map(()=>1)}]})
 const category=configureTrendAxes(base(['A','B','C']),{xTickMode:'category',xLabelEvery:2})
 assert.equal(category.xAxis.axisLabel.interval,1);assert.equal(category.xAxis.axisTick.interval,1)
 const clock=configureTrendAxes(base(['23:59:55','00:00:05']),{xTickMode:'time',xTickIntervalSeconds:5})
 assert.equal(clock.series[0].data[1][0]-clock.series[0].data[0][0],10000)
 assert.equal(clock.xAxis.interval,5000)
 assert.equal(configureTrendAxes(base(['A','B']),{xTickMode:'time',xTickIntervalSeconds:10}).xAxis.type,'category')
 for(const step of [0,-1,NaN,Infinity])assert.equal(configureTrendAxes(base(['10:00:00','10:00:10']),{xTickMode:'time',xTickIntervalSeconds:step}).xAxis.type,'category')
 assert.match(chartTickError({xTickMode:'time',xTickIntervalSeconds:0}),/大于 0/)
 assert.match(chartTickError({xTickMode:'category',xLabelEvery:1.5}),/整数/)
})
