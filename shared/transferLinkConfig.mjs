// Explicit, optional display-only handoff configuration. Missing stays missing.
export const TRANSFER_LINK_FIELDS=Object.freeze(['enabled','actionId','driveNodeName','targetMode','targetDeviceId','sourcePort','targetPort','presenceDataItemId','materialSize','materialColor','heightToleranceMeters','lateralToleranceMeters','angleToleranceDegrees'])
export function defaultTransferLink(){return {enabled:false,actionId:'',driveNodeName:'',targetMode:'fixed',targetDeviceId:'',sourcePort:'outlet',targetPort:'inlet',presenceDataItemId:'',materialSize:[.6,.3,.6],materialColor:'#E5A34A',heightToleranceMeters:.05,lateralToleranceMeters:.05,angleToleranceDegrees:5}}
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)
const fail=message=>{throw Object.assign(new Error(message),{statusCode:400,code:'TRANSFER_LINK_INVALID'})}
export function publicTransferLink(value){
 if(!object(value))return undefined
 return Object.fromEntries(TRANSFER_LINK_FIELDS.filter(key=>value[key]!==undefined).map(key=>[key,Array.isArray(value[key])?[...value[key]]:value[key]]))
}
export function normalizeTransferLink(value){
 if(value===undefined)return undefined
 if(!object(value)||Object.keys(value).some(key=>!TRANSFER_LINK_FIELDS.includes(key))||typeof value.enabled!=='boolean')fail('进出料联动配置格式无效')
 const result=publicTransferLink(value)
 const required=value.enabled?TRANSFER_LINK_FIELDS.filter(key=>key!=='targetDeviceId'||value.targetMode==='fixed'):Object.keys(value)
 for(const key of required)if(result[key]===undefined)fail('进出料联动缺少 '+key+' 设置')
 for(const key of ['actionId','driveNodeName','targetDeviceId','presenceDataItemId']){
  if(result[key]===undefined)continue
  if(typeof result[key]!=='string'||result[key].length>(key==='driveNodeName'?512:key==='actionId'?160:100)||/[\u0000-\u001f\u007f]/.test(result[key]))fail('进出料联动标识无效：'+key)
  if(value.enabled&&['actionId','driveNodeName','presenceDataItemId'].includes(key)&&!result[key].trim())fail('请配置联动动作、承料节点和真实物料在位反馈')
 }
 if(result.targetMode!==undefined&&!['station','fixed'].includes(result.targetMode))fail('联动目标方式无效')
 if(value.enabled&&result.targetMode==='fixed'&&!result.targetDeviceId?.trim())fail('请选择联动目标设备')
 for(const key of ['sourcePort','targetPort'])if(result[key]!==undefined&&!['inlet','outlet'].includes(result[key]))fail('进出料口选择无效')
 if(result.materialSize!==undefined&&(!Array.isArray(result.materialSize)||result.materialSize.length!==3||result.materialSize.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<=0||n>50)))fail('物料示意尺寸必须是三个大于零、不超过50米的数值')
 if(result.materialColor!==undefined&&(typeof result.materialColor!=='string'||!/^#[0-9A-Fa-f]{6}$/.test(result.materialColor)))fail('物料示意颜色无效')
 for(const [key,max] of [['heightToleranceMeters',1],['lateralToleranceMeters',1],['angleToleranceDegrees',30]]){
  if(result[key]!==undefined&&(typeof result[key]!=='number'||!Number.isFinite(result[key])||result[key]<0||result[key]>max))fail('交接允许偏差无效：'+key)
 }
 return result
}

