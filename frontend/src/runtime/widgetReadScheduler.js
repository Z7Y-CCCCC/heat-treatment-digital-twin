import { playbackSelection, normalizePlayback } from '../../../shared/widgetPlayback.mjs'
import { hasExternalWidgetBindings } from '../../../shared/widgetBindingWorkflow.mjs'
// One clock and one bounded, sequential batch reader per surface, not a timer
// and a PLC connection per card. The existing backend cache remains the source.
export function createWidgetReadScheduler(hooks) {
  // Two bounded lanes: a slow ERP/database call must not hold fast device APIs.
  // Each lane remains sequential, cancels obsolete contexts and batches <=20.
  const fast=w=>['http_api','dataset'].includes(w.data?.mode) && normalizePlayback(w.data).refreshMs<=500
  const lanes=[true,false].map(urgent=>createReadLane({...hooks,widgets:()=>hooks.widgets().filter(w=>fast(w)===urgent)}))
  return {refresh(force=false,now=Date.now()){return Promise.all(lanes.map(lane=>lane.refresh(force,now)))},dispose(){for(const lane of lanes)lane.dispose()}}
}
function createReadLane(hooks) {
  const nextAt=new Map(),keys=new Map();let disposed=false,running=null,generation=0,latestNow=0
  function snapshotFor(now) {
    const context=hooks.context(),params=hooks.parameters(),devices=hooks.devices(),widgets=hooks.widgets().filter(w=>hasExternalWidgetBindings(w))
    const entries=widgets.map(widget=>{
      const playbackAt=hooks.playbackTime?.(widget,now) ?? now
      const selection=playbackSelection(widget.data,context,devices,playbackAt)
      const key=JSON.stringify([context,params,widget.data,widget.content?.items?.map(item=>item.binding),selection.device?.id || ''])
      return {widget,key,deviceId:selection.device?.id || '',playbackAt}
    })
    return {context,params,entries,byId:new Map(entries.map(e=>[e.widget.id,e])),scope:JSON.stringify([context,params])}
  }
  function reconcile(snapshot) {
    for(const id of keys.keys())if(!snapshot.byId.has(id)){keys.delete(id);nextAt.delete(id);hooks.remove(id)}
    // Clear the old device immediately even if a stable neighbor's batch is
    // still in flight. Its late record must never appear under the new label.
    for(const e of snapshot.entries)if(keys.has(e.widget.id) && keys.get(e.widget.id)!==e.key)hooks.remove(e.widget.id)
  }
  const dueEntries=(snapshot,forced=new Set())=>snapshot.entries.filter(e=>forced.has(e.widget.id) || keys.get(e.widget.id)!==e.key || latestNow>=(nextAt.get(e.widget.id)||0))
  const active=request=>!disposed && !request.controller.signal.aborted && request.generation===generation
  async function refresh(force=false,now=Date.now()) {
    if(disposed)return
    latestNow=now
    const snapshot=snapshotFor(now);reconcile(snapshot)
    if(running){
      const obsolete=running.batch?.length && !running.batch.some(e=>snapshot.byId.get(e.widget.id)?.key===e.key)
      // A different context/parameter set is always cancelled. A selection-only
      // change cancels only a wholly obsolete batch: one slow rotating neighbor
      // cannot repeatedly abort a still-current hovered card's live read.
      if(force || running.scope!==snapshot.scope || obsolete){running.controller.abort();generation++;running=null}
      else return running.promise
    }
    const due=dueEntries(snapshot,force?new Set(snapshot.byId.keys()):undefined)
    if(!due.length)return
    const request={generation:++generation,controller:new AbortController(),scope:snapshot.scope,batch:null,promise:null}
    const signal=request.controller.signal,forced=force?new Set(snapshot.byId.keys()):new Set()
    running=request
    const work=(async()=>{while(active(request)){
      // Rebuild the next bounded batch from the latest selection, rather than
      // draining an obsolete queue of devices captured before a slow response.
      const current=snapshotFor(latestNow);reconcile(current)
      if(current.scope!==request.scope)return
      const waiting=dueEntries(current,forced)
      if(!waiting.length)return
      const batch=waiting.filter(e=>e.playbackAt===waiting[0].playbackAt).slice(0,20)
      request.batch=batch
      for(const e of batch){if(keys.get(e.widget.id)!==e.key)hooks.remove(e.widget.id);keys.set(e.widget.id,e.key);forced.delete(e.widget.id)}
      try {
        const payload=await hooks.read(batch.map(e=>e.widget.id),current.context,current.params,batch[0].playbackAt,signal)
        if(!active(request))return
        const latest=snapshotFor(latestNow)
        if(latest.scope!==request.scope)return
        for(const e of batch){
          if(latest.byId.get(e.widget.id)?.key!==e.key)continue
          const record=payload.values?.[e.widget.id]
          const matches=record && (e.widget.data?.bindingVersion!==2 && !record.deviceId
            || record.deviceId!==undefined && String(record.deviceId || '')===e.deviceId)
          if(matches)hooks.put(e.widget.id,record)
          else hooks.put(e.widget.id,{value:null,rows:[],series:[],quality:'bad',deviceId:e.deviceId,error:'设备数据暂不可用'})
          // Backend reports remaining cache freshness, so a cache hit cannot add
          // a second complete refresh interval. Relative TTL avoids host clock skew.
          const interval=normalizePlayback(e.widget.data).refreshMs
          const remaining=Number(record?.refreshAfterMs)
          nextAt.set(e.widget.id,latestNow+(record && Number.isFinite(remaining) ? Math.max(100,Math.min(interval,remaining)) : interval))
        }
      }catch(error){if(!active(request))return
        const latest=snapshotFor(latestNow)
        if(latest.scope!==request.scope)return
        for(const e of batch){if(latest.byId.get(e.widget.id)?.key!==e.key)continue;hooks.put(e.widget.id,{value:null,rows:[],series:[],quality:'stale',deviceId:e.deviceId,error:'数据连接暂不可用'});nextAt.set(e.widget.id,latestNow+normalizePlayback(e.widget.data).refreshMs)}
      }
      request.batch=null
    }})()
    request.promise=work
    try{await work}finally{if(running===request)running=null}
  }
  return {refresh,dispose(){disposed=true;generation++;running?.controller.abort();nextAt.clear();keys.clear()}}
}
