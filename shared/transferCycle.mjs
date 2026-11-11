// Display estimates only. Endpoint ownership changes require both independent
// BOOL presence observations; elapsed animation time never proves a transfer.
export const TRANSFER_CYCLE_VERSION=1
const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{x=clamp(x);return x*x*(3-2*x)}
export function newTransferCycle(){return {phase:'idle',elapsed:0,convey:0,armed:true,pickup:false,feed:0,hook:0,cargo:0,confirmed:false,paused:false,reason:'等待进出料命令'}}
export function advanceTransferCycle(s,input,delta,c){
 s.paused=false
 if(!Number.isFinite(input.mouthFraction)||input.mouthFraction<0||input.mouthFraction>1){s.paused=true;s.reason='口位几何无效';return s}
 if(!input.valid||!input.docked){s.paused=true;s.reason=!input.valid?'开关量反馈无效或过期，显示冻结':'尚未确认停靠或送料几何不可达';return s}
 if(!input.start)s.armed=true
 if(s.phase==='idle'||s.phase==='done'){
  if(!input.start||!s.armed)return s
  if(input.pickup ? input.sourcePresent||!input.targetPresent : !input.sourcePresent||input.targetPresent){s.reason='物料在位状态不满足本次取放命令';return s}
  Object.assign(s,{phase:'extend',elapsed:0,convey:0,armed:false,pickup:input.pickup,feed:0,hook:input.pickup?1:0,cargo:input.pickup?1:0,confirmed:false})
 }
 if(input.pickup!==s.pickup){s.paused=true;s.reason='取料/送料命令途中改变，显示冻结';return s}
 let remaining=Number.isFinite(delta)&&delta>0?delta:0
 const mouth=clamp(input.mouthFraction)
 for(let guard=0;guard<8;guard++){
  if(s.phase==='wait'){
   const confirmed=s.pickup ? input.sourcePresent&&!input.targetPresent : !input.sourcePresent&&input.targetPresent
   if(!confirmed){s.elapsed+=remaining;s.reason=s.elapsed>=c.confirmTimeoutSeconds?'等待双方物料反馈确认（超时，保持机构）':'等待双方物料反馈确认';return s}
   s.confirmed=true;s.phase='latch';s.elapsed=0
  }
  if(s.phase==='done')return s
  const duration=s.phase==='extend'?c.extendSeconds:s.phase==='latch'?c.latchSeconds:c.retractSeconds
  const used=Math.min(remaining,Math.max(0,duration-s.elapsed));s.elapsed+=used;remaining-=used
  if(s.phase!=='extend')s.convey+=used
  const p=smooth(s.elapsed/duration)
  if(s.phase==='extend'){
   s.feed=p;s.hook=s.pickup?1:0;s.cargo=s.pickup?1-(1-mouth)*p:mouth*p;s.reason=s.pickup?'取料：空钩伸出，设备辊道出料（显示估算）':'送料：推料进入设备口（显示估算）'
  }else if(s.phase==='latch'){
   s.feed=1;s.hook=s.pickup?1-p:p;s.cargo=s.pickup?mouth:mouth+(1-mouth)*smooth(s.convey/c.conveySeconds);s.reason=s.pickup?'双方反馈已确认，勾合物料':'双方反馈已确认，脱钩并由设备辊道接料'
  }else{
   s.feed=1-p;s.hook=s.pickup?0:1;s.cargo=s.pickup?mouth*(1-p):mouth+(1-mouth)*smooth(s.convey/c.conveySeconds);s.reason=s.pickup?'取料：物料回车，机构退回（显示估算）':'送料：空钩退回，物料进入承料位（显示估算）'
  }
  if(s.elapsed<duration||remaining<=0&&s.phase==='extend'&&s.elapsed<duration)return s
  if(s.phase==='extend'){s.phase='wait';s.elapsed=0;continue}
  if(s.phase==='latch'){s.phase='retract';s.elapsed=0;continue}
  s.phase='done';s.feed=0;s.cargo=s.pickup?0:1;s.reason=s.pickup?'取料显示完成（双方在位反馈已确认）':'送料显示完成（双方在位反馈已确认）';return s
 }
 return s
}
// Healthy synthetic playback in the existing admin preview. It invokes the
// same estimator as the native BOOL-driven path, with explicitly synthetic
// presence acknowledgements at the end of extension (never a PLC read/write).
export function sampleTransferCycleAt(config,time,pickup,mouthFraction){
 const state=newTransferCycle(),base={valid:true,docked:true,start:true,pickup,sourcePresent:!pickup,targetPresent:pickup,mouthFraction}
 advanceTransferCycle(state,base,Math.min(Math.max(0,time),config.extendSeconds),config)
 if(time>=config.extendSeconds)advanceTransferCycle(state,{...base,sourcePresent:pickup,targetPresent:!pickup},time-config.extendSeconds,config)
 return state
}
