import { compactTrendRows } from './trendChart.js'
// One read for the selected device; changing scopes cancels the old request.
// No database/settings/PLC writes. Never use a previous device's response.
export function createPointHistoryClient(fetcher) {
  let controller=null,generation=0,disposed=false
  async function read(scope,{windowSeconds=600,limit=2000,now=Date.now()}={}) {
    cancel();const version=generation
    if(!fetcher || disposed)return null
    controller=new AbortController();const active=controller,timer=setTimeout(()=>active.abort(),10000)
    timer?.unref?.()
    try{
      const query=new URLSearchParams({device_id:scope.deviceId,point_id:scope.pointId,from:String(Math.max(0,now-windowSeconds*1000)),to:String(now),limit:'2000'})
      if(scope.sourceMode)query.set('source_mode',scope.sourceMode)
      const response=await fetcher('/api/datapoints/history?'+query,{signal:active.signal,credentials:'same-origin',headers:{'X-Factory-Id':scope.factoryId}})
      if(!response.ok)throw Error('历史读取失败（HTTP '+response.status+'）')
      const result=await response.json()
      if(version!==generation || disposed)return null
      if(result.factoryId!==scope.factoryId || result.deviceId!==scope.deviceId || String(result.pointId)!==String(scope.pointId) || !Array.isArray(result.rows) || result.rows.length>5000)throw Error('历史响应范围无效')
      const rows=result.rows.filter(row=>Number.isSafeInteger(row.timestamp) && row.timestamp>=now-windowSeconds*1000 && row.timestamp<=now)
        .map(row=>({...row,time:row.timestamp,value:row.quality==='good' && typeof row.value==='number' && Number.isFinite(row.value)?row.value:null}))
      return {rows:compactTrendRows(rows,limit),storage:result.storage}
    }finally{clearTimeout(timer);if(controller===active)controller=null}
  }
  function cancel(){generation++;controller?.abort();controller=null}
  function dispose(){disposed=true;cancel()}
  return {read,cancel,dispose}
}
