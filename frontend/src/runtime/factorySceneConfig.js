import { parseSpatialObject } from '../utils/spatialLayout.js'

const finite = (value, fallback = 0) => value == null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value)
const clamp = (v,min,max) => Math.max(min,Math.min(max,v))
const radians = value => Math.abs(finite(value)) <= Math.PI*2+.01 ? finite(value) : finite(value)*Math.PI/180

// glTFast changes handedness by reflecting X (NodeExtension.cs / Jobs.cs).
// Express Unity's world in Three with the SAME reflection, for both camera
// and transforms. Never recenter or normalize the size of imported assets.
export function unityPositionToThree(value = {}) {
  return { x:-finite(value.x), y:finite(value.y), z:finite(value.z) }
}
export function nativeLayoutTransform(layout) {
  const transform=parseSpatialObject(parseSpatialObject(layout).transform)
  return { position:unityPositionToThree(transform), yaw:finite(transform.rotationY ?? transform.rotation_y)*Math.PI/180, scale:[1,1,1] }
}
export function nativeDeviceTransform(device,model={}) {
  const config=parseSpatialObject(device.instance_config)
  const scale=Math.max(.0001,finite(device.scale,1)*finite(model.default_scale,1)*finite(config.scaleMultiplier,1))
  // Match C#'s nullable-bool precedence: explicit false beats a legacy alias.
  const mirror=config.mirrorX ?? config.mirror_x ?? (String(config.mirrorAxis || config.mirror_axis || '').toLowerCase()==='x')
  return {position:unityPositionToThree({x:device.pos_x,y:device.pos_y,z:device.pos_z}),yaw:radians(device.rotation_y),scale:[mirror ? -scale:scale,scale,scale]}
}
export function assetUrl(path,origin) {
  if (!path) return ''
  const url=new URL(String(path),`${origin.replace(/\/$/,'')}/`)
  return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
}

export function buildFactoryScenePlan(config={},origin='http://127.0.0.1:3001') {
  const models=new Map((config.models || []).map(model=>[String(model.id),model]))
  const hall=(config.models || []).find(model=>model.asset_type==='environment' && model.id==='factory_hall_lowpoly')
  const workshops=[], devices=[], seen=new Set(), lines=[]
  for (const workshop of config.workshops || []) {
    const layout=parseSpatialObject(workshop.layout || workshop.layout_json)
    const size=parseSpatialObject(layout.size)
    const ws={id:String(workshop.id),name:workshop.name || workshop.id,transform:nativeLayoutTransform(layout),hall:layout.boundary?.enabled!==false ? {
      url:assetUrl(hall?.file_path,origin),scale:[clamp(finite(size.width,100),10,5000)/100,1,clamp(finite(size.depth,80),10,5000)/80]
    }:null}
    workshops.push(ws)
    const lineMap=new Map()
    for (const line of workshop.lines || []) {
      if (parseSpatialObject(line.layout || line.layout_json).placementPending) continue
      const row={id:String(line.id),name:line.name || line.id,workshopId:ws.id,transform:nativeLayoutTransform(line.layout || line.layout_json)}
      lines.push(row); lineMap.set(row.id,row)
    }
    const append=(device,lineId='')=>{
      const id=String(device.id || '')
      if (!id || seen.has(id)) return
      seen.add(id)
      const model=models.get(String(device.model_type))
      devices.push({id,name:device.name || id,workshopId:ws.id,lineId:lineMap.has(String(lineId)) ? String(lineId):'',modelId:String(device.model_type || ''),
        url:assetUrl(model?.file_path,origin),transform:nativeDeviceTransform(device,model),config:device})
    }
    for (const line of workshop.lines || []) if(lineMap.has(String(line.id))) for(const device of line.devices || []) append(device,line.id)
    for (const device of workshop.devices || []) {
      const instance=parseSpatialObject(device.instance_config)
      append(device,device.line_id || instance.railLineId || instance.laneLineId || '')
    }
  }
  return {workshops,lines,devices}
}

// Equivalent to OrbitCameraController.FocusBounds, including its minimum
// padding clamp. A saved .1 distanceScale is effectively .65 in Unity.
export function nativeCameraPose(bounds,view={},aspect=16/9,hasHall=true) {
  const config=view.camera || {}, fov=hasHall ? 38:42
  const extent={x:(bounds.max.x-bounds.min.x)/2,y:(bounds.max.y-bounds.min.y)/2,z:(bounds.max.z-bounds.min.z)/2}
  const radius=Math.max(3,Math.hypot(extent.x,extent.y,extent.z))
  const vertical=Math.max(12,fov*.5)*Math.PI/180
  const horizontal=Math.atan(Math.tan(vertical)*Math.max(.1,aspect))
  const padding=hasHall ? Math.min(finite(config.distanceScale,1.08),1.08):finite(config.distanceScale,1.08)
  const distance=clamp(radius/Math.sin(Math.min(vertical,horizontal))*Math.max(.65,padding),6,1000)
  const offset=config.targetOffset || [0,0,0]
  const target={x:(bounds.min.x+bounds.max.x)/2-finite(offset[0]),y:(bounds.min.y+bounds.max.y)/2+Math.max(.5,extent.y*.08)+finite(offset[1]),z:(bounds.min.z+bounds.max.z)/2+finite(offset[2])}
  const yaw=finite(config.yaw,-39)*Math.PI/180,pitch=clamp(finite(config.pitch,33),6,82)*Math.PI/180
  return {fov,near:.1,far:Math.max(600,distance+radius+Math.max(40,radius*.35)),target,distance,
    position:{x:target.x+Math.sin(yaw)*Math.cos(pitch)*distance,y:target.y+Math.sin(pitch)*distance,z:target.z-Math.cos(yaw)*Math.cos(pitch)*distance}}
}

export function factorySceneSignature(plan) {
  return JSON.stringify({workshops:plan.workshops,lines:plan.lines,devices:plan.devices.map(({config,...row})=>row)})
}
