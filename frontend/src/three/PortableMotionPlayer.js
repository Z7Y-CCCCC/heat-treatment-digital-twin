const finite=value=>typeof value==='number'&&Number.isFinite(value)
const numericValue=value=>typeof value==='boolean'?Number(value):finite(value)?value:typeof value==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())?Number(value):NaN
const good=value=>value==null||String(value).toLowerCase()==='good'
const timestamp=value=>{
 if(finite(value))return value>0?value:NaN
 if(typeof value!=='string'||!value.trim())return NaN
 const numeric=Number(value),date=Number.isFinite(numeric)?numeric:Date.parse(value)
 return date>0?date:NaN
}

// Only comparison thresholds have a dead band. Equality never coerces a text or boolean into a number.
export function evaluateMotionCondition(raw,trigger,previous){
 const expected=trigger?.value,operator=trigger?.operator||'eq'
 if(!['number','string','boolean'].includes(typeof raw)||typeof raw==='number'&&!finite(raw))return undefined
 if(operator==='eq'||operator==='ne'){
  if(typeof raw!==typeof expected)return undefined
  return operator==='eq'?raw===expected:raw!==expected
 }
 if(!finite(raw)||!finite(expected)||!['gt','gte','lt','lte'].includes(operator))return undefined
 const h=finite(trigger.hysteresis)?Math.max(0,trigger.hysteresis):0,greater=operator==='gt'||operator==='gte'
 const threshold=expected+(previous===true?(greater?-h:h):0)
 return operator==='gt'?raw>threshold:operator==='gte'?raw>=threshold:operator==='lt'?raw<threshold:raw<=threshold
}

// Test inputs are local only: a normalized slider produces a correctly typed false/true observation.
export function motionTestValue(binding,progress){
 const trigger=binding.trigger
 if(trigger?.mode==='endpoints')return progress>1?{extended:true,retracted:true}:progress===.5?{extended:false,retracted:false}:progress>.5?{extended:true,retracted:false}:{extended:false,retracted:true}
 if(trigger?.mode!=='condition')return (binding.inputMin??0)+((binding.inputMax??1)-(binding.inputMin??0))*progress
 const desired=progress>.5,expected=trigger.value,operator=trigger.operator||'eq'
 if(operator==='eq'||operator==='ne'){
  const equal=operator==='eq'?desired:!desired
  if(equal)return expected
  if(typeof expected==='boolean')return !expected
  if(typeof expected==='number')return expected+Math.max(1,Math.abs(expected)*.01)
  return `${expected??''}（预览未满足）`
 }
 const distance=Math.max(1,Number(trigger.hysteresis)||0)+Math.abs(Number(expected)||0)*.01
 return Number(expected)+(desired===(operator==='gt'||operator==='gte')?distance:-distance)
}

// Two switches confirm only the endpoints. Neither switch means "in transit" and never supplies a position.
export function receiveMotionEndpointFeedback(state,binding,data,now,wallNow){
 if(!finite(now))return
 if(!data?.motionInputOnly&&!Object.hasOwn(data||{},'motionInputs')){if(!state.hasSample){state.usable=false;state.running=false;state.reason='等待来源数据'}return}
 const envelope=timestamp(data?.timestamp),input=data?.motionInputs?.[binding.actionId],feedback=input?.endpointFeedback
 const failed=reason=>{state.usable=false;state.running=false;state.reason=reason;state.endpointStage='invalid';state.endpointNeedsResync=true}
 if(finite(wallNow)&&finite(envelope)&&envelope>wallNow+1000){failed('数据时间无效');return}
 const reference=finite(wallNow)?Math.max(wallNow,finite(envelope)?envelope:wallNow):finite(envelope)?envelope:Date.now()
 const read={}
 for(const side of ['extended','retracted']){
  const definition=binding.trigger?.[side],item=feedback?.[side],stamp=timestamp(item?.timestamp)
  if(!definition?.dataItemId||!item||String(item.dataItemId)!==String(definition.dataItemId)||item.quality==null||!good(item.quality)||!finite(stamp)||typeof item.value!=='boolean'){
   failed(String(item?.quality).toLowerCase()==='stale'?'数据超时':'数据无效');return
  }
  if(stamp>reference+1000){failed('数据时间无效');return}
  if(finite(state.endpointSourceTimestamps?.[side])&&stamp<state.endpointSourceTimestamps[side])return
  const age=Math.max(0,(reference-stamp)/1000,finite(data?.cachedAgeMs)?data.cachedAgeMs/1000:0),sourceAt=now-age
  const receivedAt=stamp===state.endpointSourceTimestamps?.[side]?Math.min(state.endpointReceivedAt?.[side]??sourceAt,sourceAt):sourceAt
  const staleMs=finite(item.staleMs)&&item.staleMs>0?item.staleMs:5000
  if(now-receivedAt>staleMs/1000){failed('数据超时');return}
  read[side]={value:item.value,stamp,receivedAt,staleMs}
 }
 state.endpointSourceTimestamps={extended:read.extended.stamp,retracted:read.retracted.stamp}
 state.endpointReceivedAt={extended:read.extended.receivedAt,retracted:read.retracted.receivedAt}
 state.endpointStaleMs={extended:read.extended.staleMs,retracted:read.retracted.staleMs}
 state.receivedAt=Math.min(read.extended.receivedAt,read.retracted.receivedAt)
 state.sourceTimestamp=Math.min(read.extended.stamp,read.retracted.stamp)
 state.sourceStaleMs=Math.min(read.extended.staleMs,read.retracted.staleMs)
 state.rawValue={extended:read.extended.value,retracted:read.retracted.value}
 state.running=false
 if(read.extended.value&&read.retracted.value){failed('到位反馈冲突');state.endpointStage='conflict';return}
 if(input?.quality==null||!good(input.quality)){failed(String(input?.quality).toLowerCase()==='stale'?'数据超时':'数据无效');return}
 if(!read.extended.value&&!read.retracted.value){state.usable=false;state.reason='等待到位反馈';state.endpointStage='waiting';return}
 const extended=read.extended.value,position=binding.invert?(extended?0:1):(extended?1:0)
 state.target=position;state.numericValue=position
 // A reconnect re-aligns to the current confirmed end, rather than resuming a disconnected transition.
 if(!state.hasSample||state.endpointNeedsResync||!(binding.transitionSeconds>0))state.position=position
 state.endpointNeedsResync=false;state.recovering=false;state.hasSample=true;state.usable=true
 state.endpointStage=extended?'extended':'retracted';state.reason=extended?'推料到位':'退回到位'
}

export function receiveMotionSignal(state,binding,data,now,wallNow){
 if(binding.trigger?.mode==='endpoints'){receiveMotionEndpointFeedback(state,binding,data,now,wallNow);return}
 if(!finite(now))return
 const group=binding.sourceGroup||'analog',key=binding.sourceKey||'',q=data?.quality,meta=data?.pointMeta?.[`${group}.${key}`]
 const catalog=!!binding.dataItemId,item=catalog?data?.motionInputs?.[binding.actionId]:undefined,raw=catalog?item?.value:data?.[group]?.[key]
 // Independent PLC-only packets are not an omitted catalog snapshot. Only an
 // explicit complete motionInputs snapshot can remove/fault a catalog action.
 if(catalog&&!data?.motionInputOnly&&!Object.hasOwn(data||{},'motionInputs')){if(!state.hasSample){state.usable=false;state.running=false;state.reason='等待来源数据'}return}
 // A motion-only catalog broadcast is not a new PLC observation.
 if(!catalog&&(data?.motionInputOnly||data?.motionInputs&&!data[group]&&!data.pointMeta&&!data.status&&!data.quality))return
 const stamp=timestamp(catalog?item?.timestamp:meta?.timestamp),envelope=timestamp(data?.timestamp)
 const wasUsable=state.usable===true
 const fail=reason=>{state.usable=false;state.running=false;state.reason=reason}
 // Real point-ID bindings need an actual confirmation, not a wrapper clock.
 // Controlled local preview and old unbound model-level definitions retain
 // their previous protocol only when no live wall clock/point ID is supplied.
 if(!catalog&&finite(wallNow)&&String(binding.pointId||'').trim()&&(!meta||String(meta.id)!==String(binding.pointId)||!finite(stamp)||!good(meta.quality))){fail('数据无效');return}
 if(finite(wallNow)&&finite(envelope)&&envelope>wallNow+1000){fail('数据时间无效');return}
 const reference=finite(wallNow)?Math.max(wallNow,finite(envelope)?envelope:wallNow):finite(envelope)?envelope:Date.now()
 const identity=catalog?!!item&&String(item.dataItemId)===String(binding.dataItemId):!meta?.id||String(meta.id)===String(binding.pointId)
 const quality=catalog?item?.quality!=null&&good(item.quality):!!data&&String(data.status?.online).toLowerCase()!=='false'&&good(data.status?.quality)&&good(typeof q==='string'?q:q?.overall)&&good(q?.[group]?.[key])
 // Missing/invalid inputs freeze immediately, even if an earlier packet carried a usable value.
 if(!identity||!quality||catalog&&!finite(stamp)){fail(String(item?.quality).toLowerCase()==='stale'?'数据超时':'数据无效');return}
 if(finite(stamp)&&finite(state.sourceTimestamp)&&stamp<state.sourceTimestamp)return
 const age=finite(stamp)?Math.max(0,(reference-stamp)/1000,finite(data?.cachedAgeMs)?data.cachedAgeMs/1000:0):0
 if(finite(stamp)&&stamp>reference+1000){fail('数据时间无效');return}
 const sourceAt=now-age
 if(!finite(stamp)||stamp!==state.sourceTimestamp){state.receivedAt=sourceAt;state.sourceTimestamp=finite(stamp)?stamp:undefined}
 // Repeated transport packets must not extend the actual source's lifetime.
 else state.receivedAt=Math.min(state.receivedAt??sourceAt,sourceAt)
 state.sourceStaleMs=catalog&&finite(item.staleMs)&&item.staleMs>0?item.staleMs:undefined
 if(now-state.receivedAt>(state.sourceStaleMs??Infinity)/1000){fail('数据超时');return}
 const numeric=numericValue(raw),condition=binding.trigger?.mode==='condition'
 let p
 if(condition){
  const result=evaluateMotionCondition(raw,binding.trigger,state.condition)
  if(result===undefined){fail('数据类型无效');return}
  state.condition=result;p=result?1:0
 }else{
  const min=binding.inputMin??0,max=binding.inputMax??1
  if(catalog&&!finite(raw)){fail('数据类型无效');return}
  if(!finite(numeric)||!finite(min)||!finite(max)||max<=min){fail('数据无效');return}
  p=Math.max(0,Math.min(1,(numeric-min)/(max-min)))
 }
 if(binding.invert)p=1-p
 state.target=p;state.rawValue=raw;state.numericValue=condition?p:numeric
 state.recovering=state.hasSample&&!wasUsable||state.recovering===true
 if(!state.hasSample||!(binding.transitionSeconds>0)&&!state.recovering)state.position=p
 state.usable=true;state.running=p>.5;state.hasSample=true;state.reason=state.running?'运行':'停止'
}
export function stepMotionSignal(state,binding,delta,now,staleMs){
 const timeout=Math.min(finite(staleMs)&&staleMs>0?staleMs:5000,state.sourceStaleMs??Infinity)
 const expired=binding.trigger?.mode==='endpoints'?['extended','retracted'].some(side=>now-(state.endpointReceivedAt?.[side]??-Infinity)>Math.min(finite(staleMs)&&staleMs>0?staleMs:5000,state.endpointStaleMs?.[side]??Infinity)/1000):now-(state.receivedAt??-Infinity)>timeout/1000
 if(expired){state.usable=false;state.running=false;state.reason='数据超时';if(binding.trigger?.mode==='endpoints'){state.endpointNeedsResync=true;state.endpointStage='invalid'}}
 if(!state.usable||!Number.isFinite(delta)||delta<=0)return
 const duration=binding.transitionSeconds>0?binding.transitionSeconds:state.recovering?0.2:0
 const step=duration>0?delta/duration:Infinity,d=state.target-state.position
 state.position+=Math.sign(d)*Math.min(Math.abs(d),step)
 if(state.position===state.target)state.recovering=false
 if(state.running)state.seconds=(state.seconds||0)+delta*(binding.speed||1)
}
export function sampleMotionTrack(clip,track,time){
 const index=Math.max(0,Math.min(1,time/clip.duration))*(clip.count-1),left=Math.floor(index),right=Math.min(clip.count-1,left+1),t=track.channel==='v'?0:index-left,a=track.values.slice(left*track.size,(left+1)*track.size),b=track.values.slice(right*track.size,(right+1)*track.size)
 const sign=track.channel==='q'&&a.reduce((n,x,i)=>n+x*b[i],0)<0?-1:1
 return a.map((x,i)=>x*(1-t)+b[i]*sign*t)
}
export class PortableMotionPlayer{
 constructor(root,packageData,bindings=[],staleMs=5000){
  this.root=root;this.data=packageData;this.staleMs=staleMs;this.nodes=new Map();root.traverse(n=>this.nodes.set(n.name,n))
  this.base=new Map(packageData.nodes.map(n=>[n.name,n]));this.entries=bindings.filter(b=>b.enabled&&b.kind==='clip').map(binding=>({binding,clip:packageData.clips.find(c=>c.id===binding.clipId),signal:{seconds:0,reason:'等待数据'}}))
  for(const row of packageData.nodes){const n=this.nodes.get(row.name);if(!n)throw Error(`动作部件缺失：${row.name}`);n.visible=!!row.v[0];for(const [i,m] of [].concat(n.material||[]).entries()){const c=row['c'+i],e=row['e'+i];if(c){m.color?.fromArray(c);m.opacity=m.userData.linkCutaway?Math.min(.16,c[3]):c[3]}if(e){m.emissive?.fromArray(e);m.emissiveIntensity=e[3]}}}
  for(const e of this.entries)if(!e.clip)throw Error('动作包与绑定版本不一致')
 }
 receive(data,now=performance.now()/1000,wallNow){if(arguments.length===1)wallNow=Date.now();for(const e of this.entries)receiveMotionSignal(e.signal,e.binding,data,now,wallNow)}
 advance(delta,now=performance.now()/1000){
  for(const e of this.entries){const s=e.signal;stepMotionSignal(s,e.binding,delta,now,this.staleMs);if(!s.hasSample||!s.usable)continue
   const running=e.binding.mode==='running',time=running?s.seconds%e.clip.duration:s.position*e.clip.duration
   for(const t of e.clip.tracks){const channel=t.channel,n=this.nodes.get(t.node),off=running&&!s.running&&(channel==='v'||channel.startsWith('e')||channel.startsWith('c')),v=off?this.base.get(t.node)[channel]:sampleMotionTrack(e.clip,t,time);if(!v)continue
    if(channel==='p')n.position.fromArray(v);else if(channel==='q')n.quaternion.fromArray(v).normalize();else if(channel==='s')n.scale.fromArray(v);else if(channel==='v')n.visible=v[0]>.5
    else{const m=[].concat(n.material||[])[Number(channel.slice(1))];if(!m)continue;if(channel[0]==='c'){m.color?.fromArray(v);m.opacity=m.userData.linkCutaway?Math.min(.16,v[3]):v[3]}else{m.emissive?.fromArray(v);m.emissiveIntensity=v[3]}}
   }
  }
 }
}
