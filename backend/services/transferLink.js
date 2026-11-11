'use strict';
const {resolveLoadingPort}=require('../../shared/loadingPorts.mjs');
const {normalizeTransferLink,publicTransferLink}=require('../../shared/transferLinkConfig.mjs');
const {TRANSFORM_FIELDS,LAYOUT_CONFIG_FIELDS}=require('../../shared/deviceAuthoring.mjs');
const {isRetiredMotionAction}=require('../../shared/motionActionAvailability.mjs');
const {assertLineMovementUnits,movementSceneUnitsPerMeter}=require('../../shared/lineRailSpacing.mjs');
const object=value=>{try{return typeof value==='string'?JSON.parse(value||'{}'):value||{};}catch{return {};}};
const fail=message=>{throw Object.assign(new Error(message),{statusCode:400,code:'TRANSFER_LINK_INVALID'});};
function driveNodes(action){return [...new Set((action?.channels||[]).filter(channel=>/:p\d*$/.test(channel)).map(channel=>channel.replace(/:p\d*$/,'')))];}
function ports(model,device){
 const result={};
 for(const kind of ['inlet','outlet']){try{const port=resolveLoadingPort(model,device,kind);if(port)result[kind]=port;}catch{/* Malformed or missing authored ports are not guessed. */}}
 return result;
}
function authoredTransform(device,context={}){
 const instance=object(device.instance_config),line=context.lines?.find(row=>String(row.id)===String(device.line_id||instance.railLineId||instance.laneLineId||''));
 const workshopId=line?.workshop_id||instance.workshop_id||instance.workshopId||device.workshopId||'';
 const workshop=context.workshops?.find(row=>String(row.id)===String(workshopId));
 return {...Object.fromEntries(TRANSFORM_FIELDS.filter(key=>device[key]!==undefined).map(key=>[key,device[key]])),
  layoutConfig:Object.fromEntries(LAYOUT_CONFIG_FIELDS.filter(key=>instance[key]!==undefined).map(key=>[key,instance[key]])),
  ...(line?{line:{id:String(line.id),workshopId:String(workshopId),layout:object(line.layout_json),pos_x:line.pos_x,pos_y:line.pos_y,pos_z:line.pos_z,rotation_y:line.rotation_y}}:{}),
  ...(workshop?{workshop:{id:String(workshop.id),layout:object(workshop.layout_json)}}:{})};
}
function buildTransferCapabilities(loaded,targets=[],context={}){
 const ownPorts=ports(loaded.model,loaded.device);
 return {sourcePorts:ownPorts,sourceMovement:loaded.instance?.movement,sourceTransform:authoredTransform(loaded.device,context),actions:(loaded.actions||[]).filter(action=>!isRetiredMotionAction(action)&&action.mode==='position'&&driveNodes(action).length).map(action=>({id:action.id,label:action.label,driveNodes:driveNodes(action)})),
 targetDevices:targets.filter(target=>String(target.id)!==String(loaded.device.id)&&!target.movementEnabled).map(target=>({id:String(target.id),name:target.name||String(target.id),lineId:String(target.line_id||''),ports:ports(target.model,target),transform:authoredTransform(target,context),presencePoints:target.presencePoints||[]}))};
}
function validateTransferSelection(loaded,value,bindings,validatePresence,sourceFingerprint){
 const transfer=normalizeTransferLink(value);
 if(!transfer?.enabled)return transfer;
 const action=loaded.actions.find(action=>action.id===transfer.actionId);
 if(!action||action.mode!=='position'||!driveNodes(action).includes(transfer.driveNodeName))fail('请选择真实位置动作的承料移动节点');
 if(!transfer.cycle?.enabled&&!bindings.some(row=>row.actionId===transfer.actionId&&row.enabled))fail('请先启用所选送料动作并配置实时驱动数据');
 const capabilities=loaded.transferCapabilities;
 if(!capabilities?.sourcePorts?.[transfer.sourcePort])fail('来源设备未配置所选进出料口，请先在进出料口设置中配置真实送料基准');
 const item=loaded.catalog?.items.find(item=>item.id===transfer.presenceDataItemId);
 validatePresence(loaded,item);
 const movement=loaded.instance?.movement;
 if(capabilities?.sourceTransform?.line)assertLineMovementUnits(movement,capabilities.sourceTransform.line.layout,loaded.device.name||loaded.device.id);
 else movementSceneUnitsPerMeter(movement);
 let ids;
 if(transfer.targetMode==='fixed')ids=[transfer.targetDeviceId];
 else{
  if(movement?.enabled!==true||movement.valueMode!=='station')fail('按工位联动需要启用工位位置模式，并明确关联固定设备');
  ids=[...new Set((movement.stations||[]).filter(row=>Number.isFinite(row.value)&&row.anchorDeviceId).map(row=>String(row.anchorDeviceId)))];
  if(!ids.length)fail('请先为料车工位关联实际目标设备，不能猜测附近设备');
 }
 for(const id of ids){
  const target=capabilities?.targetDevices?.find(target=>target.id===String(id));
  if(!target)fail('联动目标不存在、不是当前工厂的固定设备或正在移动');
  if(!target.ports?.[transfer.targetPort])fail('目标设备 '+target.name+' 未配置所选进出料口');
 }
 if(transfer.cycle?.enabled){
  if(transfer.targetMode!=='station'||movement?.stationInputMeaning!=='target'||!movement.arrivalPositionPointId||!movement.startActionPointId)fail('双侧循环需要目标工位、独立到位工位及实际移动 BOOL 反馈');
  const owned=['clip:feed','clip:hook','clip:feed_opposite','clip:hook_opposite'];
  if(loaded.device.model_type!=='cad_transfer_cart_101300'||owned.some(id=>!loaded.actions.some(a=>a.id===id&&a.mode==='position')))fail('该模型缺少同源导出的双侧送料和脱钩动作包');
  if(bindings.some(b=>b.enabled&&owned.includes(b.actionId)))fail('双侧循环统一驱动送料/脱钩，请先停用这四项的独立绑定，避免互相覆盖');
  for(const name of ['start','pickup']){
   const item=loaded.catalog?.items.find(item=>item.id===transfer.cycle[name+'DataItemId']);validatePresence(loaded,item);
   transfer.cycle[name+'SourceFingerprint']=sourceFingerprint(item);
  }
  if(transfer.cycle.stations.length!==(movement.stations||[]).length)fail('请逐一配置所有料车工位的送料侧、在位反馈和承料位');
  for(const station of transfer.cycle.stations){
   const anchor=(movement.stations||[]).find(s=>s.value===station.value&&String(s.anchorDeviceId)===station.targetDeviceId);
   const target=capabilities.targetDevices.find(t=>t.id===station.targetDeviceId);
   if(!anchor||!target?.presencePoints.some(p=>String(p.id)===station.presencePointId))fail('工位目标不匹配，或目标物料反馈不是该固定设备的只读 BOOL');
  }
 }
 return {...transfer,presenceSourceFingerprint:sourceFingerprint(item)};
}
module.exports={driveNodes,buildTransferCapabilities,validateTransferSelection,publicTransferLink,authoredTransform};

