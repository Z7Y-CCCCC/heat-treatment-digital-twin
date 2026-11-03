export function receiveMotionSignal(state,binding,data,now){
 const group=binding.sourceGroup||'analog',key=binding.sourceKey||'',raw=data?.[group]?.[key],q=data?.quality
 const good=v=>v==null||String(v).toLowerCase()==='good',meta=data?.pointMeta?.[`${group}.${key}`]
 const numeric=typeof raw==='boolean'?Number(raw):typeof raw==='number'?raw:typeof raw==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())?Number(raw):NaN
 state.receivedAt=now
 state.usable=!!data&&data.status?.online!==false&&good(data.status?.quality)&&good(typeof q==='string'?q:q?.overall)&&good(q?.[group]?.[key])&&(!meta?.id||String(meta.id)===String(binding.pointId))&&Number.isFinite(numeric)
 if(!state.usable){state.running=false;state.reason='数据无效';return}
 let p=Math.max(0,Math.min(1,(numeric-binding.inputMin)/(binding.inputMax-binding.inputMin)))
 if(binding.invert)p=1-p
 state.target=p;if(!state.hasSample||!(binding.transitionSeconds>0))state.position=p
 state.running=p>.5;state.hasSample=true;state.reason=state.running?'运行':'停止'
}
export function stepMotionSignal(state,binding,delta,now,staleMs){
 if(now-(state.receivedAt??-Infinity)>staleMs/1000){state.usable=false;state.running=false;state.reason='数据超时'}
 if(!state.usable||!Number.isFinite(delta)||delta<=0)return
 const step=binding.transitionSeconds>0?delta/binding.transitionSeconds:Infinity,d=state.target-state.position
 state.position+=Math.sign(d)*Math.min(Math.abs(d),step)
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
 receive(data,now=performance.now()/1000){for(const e of this.entries)receiveMotionSignal(e.signal,e.binding,data,now)}
 advance(delta,now=performance.now()/1000){
  for(const e of this.entries){const s=e.signal;stepMotionSignal(s,e.binding,delta,now,this.staleMs);if(!s.hasSample)continue
   const running=e.binding.mode==='running',time=running?s.seconds%e.clip.duration:s.position*e.clip.duration
   for(const t of e.clip.tracks){const channel=t.channel,n=this.nodes.get(t.node),off=running&&!s.running&&(channel==='v'||channel.startsWith('e')||channel.startsWith('c')),v=off?this.base.get(t.node)[channel]:sampleMotionTrack(e.clip,t,time);if(!v)continue
    if(channel==='p')n.position.fromArray(v);else if(channel==='q')n.quaternion.fromArray(v).normalize();else if(channel==='s')n.scale.fromArray(v);else if(channel==='v')n.visible=v[0]>.5
    else{const m=[].concat(n.material||[])[Number(channel.slice(1))];if(!m)continue;if(channel[0]==='c'){m.color?.fromArray(v);m.opacity=m.userData.linkCutaway?Math.min(.16,v[3]):v[3]}else{m.emissive?.fromArray(v);m.emissiveIntensity=v[3]}}
   }
  }
 }
}
