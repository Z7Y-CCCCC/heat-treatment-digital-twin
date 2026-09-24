import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'

export function disposeSceneObject(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set()
  root?.traverse(node=>{
    if(node.geometry) geometries.add(node.geometry)
    for(const material of (Array.isArray(node.material)?node.material:[node.material]).filter(Boolean)) materials.add(material)
  })
  for(const material of materials) for(const value of Object.values(material)) if(value?.isTexture) textures.add(value)
  textures.forEach(item=>item.dispose()); materials.forEach(item=>item.dispose()); geometries.forEach(item=>item.dispose())
}

function transform(root,value) {
  root.position.set(value.position.x,value.position.y,value.position.z)
  root.rotation.y=value.yaw
  root.scale.set(...value.scale)
}

// Build off-screen, then swap a complete generation. This prevents refreshes
// from leaving a half-built factory or late requests reviving deleted devices.
export async function buildConfiguredFactoryScene(plan,{load=url=>new GLTFLoader().loadAsync(url),cancelled=()=>false}={}) {
  const root=new THREE.Group(),workshops=new Map(),lines=new Map(),devices=new Map(),errors=[],templates=new Map()
  const getAsset=async url=>{
    if(!url) throw new Error('模型库未配置资产文件')
    if(!templates.has(url)) templates.set(url,Promise.resolve().then(()=>load(url)).then(gltf=>gltf.scene))
    return clone(await templates.get(url))
  }
  try {
    for(const ws of plan.workshops) {
      const group=new THREE.Group();group.name=ws.name;transform(group,ws.transform);root.add(group);workshops.set(ws.id,group)
      if(ws.hall) {
        try { const hall=await getAsset(ws.hall.url);hall.scale.multiply(new THREE.Vector3(...ws.hall.scale));group.add(hall) }
        catch(error) {errors.push(`${ws.name}：${error.message}`)}
      }
    }
    for(const line of plan.lines) {
      const group=new THREE.Group();group.name=line.name;transform(group,line.transform);workshops.get(line.workshopId)?.add(group);lines.set(line.id,group)
    }
    for(const row of plan.devices) {
      if(cancelled()) break
      const group=new THREE.Group();group.name=row.name;group.userData.deviceId=row.id;transform(group,row.transform)
      ;(lines.get(row.lineId)||workshops.get(row.workshopId))?.add(group)
      try { group.add(await getAsset(row.url)) }
      catch(error) {
        errors.push(`${row.name}：${error.message}`)
        // Keep the configured position visible, clearly marked as a missing
        // asset instead of silently dropping a device or substituting another.
        const placeholder=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshBasicMaterial({color:0xd9a081,wireframe:true}))
        placeholder.position.y=1;group.add(placeholder);group.userData.missingAsset=true
      }
      devices.set(row.id,group)
    }
    root.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true}})
    root.updateMatrixWorld(true)
    const bounds=new THREE.Box3().setFromObject(root)
    const anchors=plan.devices.filter(row=>devices.has(row.id)).map(row=>{
      const group=devices.get(row.id),box=new THREE.Box3().setFromObject(group),position=box.getCenter(new THREE.Vector3())
      position.y=box.max.y+Math.max(.5,(box.max.y-box.min.y)*.08)
      return {id:row.id,label:row.name,position,missingAsset:!!group.userData.missingAsset}
    })
    // Disposing the attached clones below also frees the shared template
    // geometries/materials; no global cache survives a configuration revision.
    const dispose=()=>disposeSceneObject(root)
    if(cancelled()){dispose();return null}
    return {root,devices,anchors,bounds,errors,hasHall:plan.workshops.some(ws=>!!ws.hall),dispose}
  } catch(error) {disposeSceneObject(root);throw error}
}
