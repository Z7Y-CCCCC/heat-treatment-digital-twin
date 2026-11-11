import test from 'node:test'
import assert from 'node:assert/strict'
import { realtimeChartOption } from '../src/runtime/realtimeChartPolicy.js'
import { readFile } from 'node:fs/promises'
test('native overlay draws actual chart samples without competing continuous canvas tweens',()=>{
 const data=[[1,2],[3,4]],axes={min:0,max:10},series={type:'line',data,smooth:true,animation:true,animationDurationUpdate:450}
 const option={animation:true,animationDuration:500,animationDurationUpdate:450,xAxis:axes,series:[series]}
 const result=realtimeChartOption(option,true)
 assert.equal(result.animation,false);assert.equal(result.animationDurationUpdate,0);assert.equal(result.series[0].animation,false)
 assert.equal(result.series[0].data,data);assert.equal(result.xAxis,axes);assert.equal(result.series[0].smooth,true)
 assert.equal(option.animation,true);assert.equal(series.animationDurationUpdate,450)
})
test('designer and ordinary web previews retain authored chart transitions',()=>{
 const option={animation:true,series:{type:'gauge',data:[{value:12}],animationDurationUpdate:250}}
 assert.equal(realtimeChartOption(option,false),option)
 const overlay=realtimeChartOption(option,true);assert.equal(overlay.series.animation,false);assert.equal(overlay.series.data,option.series.data)
})
test('the actual native overlay opts into direct samples even though its shared renderer uses preview styling',async()=>{
 const source=await readFile(new URL('../src/views/DashboardOverlay.vue',import.meta.url),'utf8')
 assert.match(source,/<WidgetRenderer[\s\S]*?native-realtime[\s\S]*?:preview="true"/)
})
