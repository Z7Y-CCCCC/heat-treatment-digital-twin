const finite = value => typeof value === 'number' && Number.isFinite(value)
export const FEEDBACK_POSITION_CAPACITY = 64

// This is presentation history, never an input/edge queue. It holds only real
// numeric observations and cannot infer a future pose or renew source freshness.
export function feedbackSmoothingDelay(binding) {
 const ms=binding.feedbackSmoothingMs
 return binding.mode==='position'&&binding.trigger?.mode!=='condition'&&binding.trigger?.mode!=='endpoints'&&finite(ms)&&ms>0&&ms<=1000?ms/1000:0
}

export class FeedbackPositionBuffer {
 constructor(binding,data={}) {
  this.times=new Float64Array(FEEDBACK_POSITION_CAPACITY)
  this.positions=new Float64Array(FEEDBACK_POSITION_CAPACITY)
  this.binding={actionId:binding.actionId,dataItemId:binding.dataItemId,pointId:binding.pointId,sourceGroup:binding.sourceGroup,
   sourceKey:binding.sourceKey,sourceFingerprint:binding.sourceFingerprint,mode:binding.mode,triggerMode:binding.trigger?.mode,
   inputMin:binding.inputMin,inputMax:binding.inputMax,invert:binding.invert,feedbackSmoothingMs:binding.feedbackSmoothingMs}
  this.factoryId=data.factoryId??data.factory_id
  this.deviceId=data.furnace_id??data.device_id??data.deviceId
  this.clear()
 }
 matchesBinding(binding) {
  const b=this.binding
  return b.actionId===binding.actionId&&b.dataItemId===binding.dataItemId&&b.pointId===binding.pointId
   &&b.sourceGroup===binding.sourceGroup&&b.sourceKey===binding.sourceKey&&b.sourceFingerprint===binding.sourceFingerprint
   &&b.mode===binding.mode&&b.triggerMode===binding.trigger?.mode&&b.inputMin===binding.inputMin&&b.inputMax===binding.inputMax
   &&b.invert===binding.invert&&b.feedbackSmoothingMs===binding.feedbackSmoothingMs
 }
 matchesInput(binding,data) {
  return this.matchesBinding(binding)&&this.factoryId===(data.factoryId??data.factory_id)
   &&this.deviceId===(data.furnace_id??data.device_id??data.deviceId)
 }
 clear() {
  this.start=0;this.count=0;this.lastTimestamp=undefined;this.lastRaw=undefined
  this.lastPresentedAt=-Infinity;this.lastPosition=undefined
 }
 align(time,position,stamp,raw) {
  this.clear();this.times[0]=time;this.positions[0]=position;this.count=1
  this.lastTimestamp=finite(stamp)?stamp:undefined;this.lastRaw=raw;this.lastPosition=position
 }
 trimPresented() {
  while(this.count>1&&this.times[(this.start+1)%FEEDBACK_POSITION_CAPACITY]<=this.lastPresentedAt){
   this.start=(this.start+1)%FEEDBACK_POSITION_CAPACITY;this.count--
  }
 }
 // true means the presentation must immediately align to the latest real pose.
 append(time,position,stamp,raw) {
  if(!finite(time)||!finite(position))return false
  if(this.count===0){this.align(time,position,stamp,raw);return true}
  if(finite(stamp)&&finite(this.lastTimestamp)){
   if(stamp<this.lastTimestamp)return false
   if(stamp===this.lastTimestamp){
    if(raw===this.lastRaw)return false
    // A corrected value with the same source clock is not a new trajectory.
    this.align(time,position,stamp,raw);return true
   }
  }
  const last=(this.start+this.count-1)%FEEDBACK_POSITION_CAPACITY
  if(time<=this.times[last]){this.align(time,position,stamp,raw);return true}
  if(this.count===FEEDBACK_POSITION_CAPACITY)this.trimPresented()
  if(this.count===FEEDBACK_POSITION_CAPACITY){this.align(time,position,stamp,raw);return true}
  const index=(this.start+this.count)%FEEDBACK_POSITION_CAPACITY
  this.times[index]=time;this.positions[index]=position;this.count++
  this.lastTimestamp=finite(stamp)?stamp:undefined;this.lastRaw=raw
  return false
 }
 sample(playhead) {
  if(this.count===0)return undefined
  if(!finite(playhead)||playhead<this.lastPresentedAt)return this.lastPosition
  this.lastPresentedAt=playhead;this.trimPresented()
  const left=this.start,right=(left+1)%FEEDBACK_POSITION_CAPACITY
  if(this.count===1||playhead<=this.times[left])this.lastPosition=this.positions[left]
  else{
   const t=Math.max(0,Math.min(1,(playhead-this.times[left])/(this.times[right]-this.times[left])))
   this.lastPosition=this.positions[left]+(this.positions[right]-this.positions[left])*t
  }
  return this.lastPosition
 }
}
