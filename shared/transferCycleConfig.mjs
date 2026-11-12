const fields=['version','enabled','handoffMode','startDataItemId','pickupDataItemId','cartHome','extendSeconds','latchSeconds','retractSeconds','conveySeconds','confirmTimeoutSeconds','stations']
const stationFields=['value','targetDeviceId','side','presencePointId','seatNodeName','seatNodeLocal']
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[\u0000-\u001f\u007f]/.test(v)
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000)
const fail=m=>{throw Object.assign(Error(m),{statusCode:400,code:'TRANSFER_CYCLE_INVALID'})}
export function defaultTransferCycle(){return {version:1,enabled:false,handoffMode:'mechanism',startDataItemId:'',pickupDataItemId:'',cartHome:[0,1.25,0],extendSeconds:4,latchSeconds:.75,retractSeconds:4,conveySeconds:3,confirmTimeoutSeconds:10,stations:[]}}
export function publicTransferCycle(value){
 if(!object(value))return undefined
 return Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,structuredClone(value[k])]))
}
export function normalizeTransferCycle(value){
 if(value===undefined)return undefined
 if(!object(value)||Object.keys(value).some(k=>!fields.includes(k))||typeof value.enabled!=='boolean'||value.version!==1)fail('双侧进出料循环配置无效')
 if(value.handoffMode!==undefined&&!['mechanism','adaptive'].includes(value.handoffMode))fail('交接显示方式无效')
 if(!value.enabled)return publicTransferCycle(value)
 if(fields.some(k=>k!=='handoffMode'&&value[k]===undefined))fail('请完整配置双侧进出料循环')
 if(!id(value.startDataItemId)||!id(value.pickupDataItemId)||value.startDataItemId===value.pickupDataItemId)fail('请选择不同的循环命令和取料/送料 BOOL 数据')
 if(!vector(value.cartHome))fail('料车承料位坐标无效')
 for(const k of ['extendSeconds','latchSeconds','retractSeconds','conveySeconds','confirmTimeoutSeconds'])if(typeof value[k]!=='number'||!Number.isFinite(value[k])||value[k]<.1||value[k]>120)fail('进出料显示时长必须为 0.1–120 秒')
 if(value.conveySeconds>value.latchSeconds+value.retractSeconds)fail('设备辊道显示时长不能超过脱钩与退链总时长')
 if(!Array.isArray(value.stations)||!value.stations.length||value.stations.length>500)fail('请配置参与双侧进出料的实际工位')
 const values=new Set(),targets=new Set()
 for(const s of value.stations){
  if(!object(s)||stationFields.some(k=>s[k]===undefined)||Object.keys(s).some(k=>!stationFields.includes(k))||typeof s.value!=='number'||!Number.isFinite(s.value)||values.has(s.value)||!id(s.targetDeviceId)||targets.has(s.targetDeviceId)||!['primary','opposite'].includes(s.side)||!id(s.presencePointId)||typeof s.seatNodeName!=='string'||!s.seatNodeName||s.seatNodeName.length>512||/[\u0000-\u001f\u007f]/.test(s.seatNodeName)||!vector(s.seatNodeLocal))fail('工位、送料侧、物料在位或承料节点配置无效/重复')
  values.add(s.value);targets.add(s.targetDeviceId)
 }
 return publicTransferCycle(value)
}
