import { playbackSelection, normalizePlayback } from '../../../shared/widgetPlayback.mjs'
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
  const nextAt=new Map(),keys=new Map();let disposed=false,controller=null,running=null,signature='',generation=0
  async function refresh(force=false,now=Date.now()) {
    if(disposed)return
    const context=hooks.context(),params=hooks.parameters(),devices=hooks.devices(),widgets=hooks.widgets().filter(w=>['database','http_api','dataset','business'].includes(w.data?.mode))
    const active=new Set(widgets.map(w=>w.id));for(const id of keys.keys())if(!active.has(id)){keys.delete(id);nextAt.delete(id);hooks.remove(id)}
    const entries=widgets.map(widget=>{
      const selection=playbackSelection(widget.data,context,devices,now)
      const key=JSON.stringify([context,params,widget.data,selection.device?.id || ''])
      return {widget,key,deviceId:selection.device?.id || ''}
    })
    const current=JSON.stringify(entries.map(e=>[e.widget.id,e.key]))
    if(running && current===signature && !force)return running
    if(running){controller?.abort();generation++;running=null;controller=null}
    signature=current
    const due=entries.filter(e=>force || keys.get(e.widget.id)!==e.key || now>=(nextAt.get(e.widget.id)||0))
    if(!due.length)return
    for(const e of due){if(keys.get(e.widget.id)!==e.key)hooks.remove(e.widget.id);keys.set(e.widget.id,e.key)}
    const request=++generation;controller=new AbortController();const signal=controller.signal
    const work=(async()=>{for(let offset=0;offset<due.length;offset+=20){
      if(disposed || signal.aborted)return
      const batch=due.slice(offset,offset+20)
      try {
        const payload=await hooks.read(batch.map(e=>e.widget.id),context,params,now,signal)
        if(disposed || request!==generation || signal.aborted)return
        for(const e of batch){
          const record=payload.values?.[e.widget.id]
          if(record && (!record.deviceId || record.deviceId===e.deviceId))hooks.put(e.widget.id,record)
          else hooks.put(e.widget.id,{value:null,rows:[],series:[],quality:'bad',deviceId:e.deviceId,error:'设备数据暂不可用'})
          // Backend reports remaining cache freshness, so a cache hit cannot add
          // a second complete refresh interval. Relative TTL avoids host clock skew.
          const interval=normalizePlayback(e.widget.data).refreshMs
          const remaining=Number(record?.refreshAfterMs)
          nextAt.set(e.widget.id,now+(record && Number.isFinite(remaining) ? Math.max(100,Math.min(interval,remaining)) : interval))
        }
      }catch(error){if(disposed || signal.aborted || request!==generation)return
        for(const e of batch){hooks.put(e.widget.id,{value:null,rows:[],series:[],quality:'stale',deviceId:e.deviceId,error:'数据连接暂不可用'});nextAt.set(e.widget.id,now+normalizePlayback(e.widget.data).refreshMs)}
      }
    }})()
    running=work
    try{await work}finally{if(request===generation)running=null}
  }
  return {refresh,dispose(){disposed=true;generation++;controller?.abort();nextAt.clear();keys.clear()}}
}
