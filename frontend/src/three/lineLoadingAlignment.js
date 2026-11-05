import * as T from 'three'
import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'
import {nativeDeviceTransform} from '../runtime/factorySceneConfig.js'
import {loadConfiguredGltf,disposeSceneObject} from '../runtime/ConfiguredFactoryScene.js'
import {resolveBackendAssetUrl} from './ModelFactory.js'

// Measure the loading face, not the model origin or protruding door handles.
// Keep the authored geometry intact; the resulting correction is a device position.
export function loadingFaceOffset(root,device,model,direction){
    const profile=CAD_MOTION_PROFILES[device.model_type] || Object.values(CAD_MOTION_PROFILES).find(p=>root.getObjectByName(p.prefix+'root'))
    if(!profile)throw Error(`「${device.name||device.id}」尚未配置进料口，未移动设备`)
    root.updateMatrixWorld(true)
    const panel=['door_black','door_enamel','door'].map(s=>root.getObjectByName(profile.prefix+s)).find(Boolean)
    const bed=root.getObjectByName(profile.prefix+'roller_bed')
    const node=panel||bed
    if(!node)throw Error(`「${device.name||device.id}」没有进料面节点`)
    const box=new T.Box3().setFromObject(node,true),size=box.getSize(new T.Vector3())
    if(box.isEmpty())throw Error('进料面没有有效几何')
    const transform=nativeDeviceTransform(device,model)
    const matrix=new T.Matrix4().compose(new T.Vector3(),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),transform.yaw),new T.Vector3(...transform.scale))
    const axis=panel?(size.x<size.z?'x':'z'):(size.x>size.z?'x':'z')
    const normal=new T.Vector3(axis==='x'?1:0,0,axis==='z'?1:0).transformDirection(matrix)
    if(Math.abs(normal.z)<.9999)throw Error(`「${device.name||device.id}」进料方向未垂直于导轨，请先调整朝向`)
    if(panel){
        const center=box.getCenter(new T.Vector3()),bodyCenter=new T.Box3().setFromObject(root,true).getCenter(new T.Vector3())
        const side=Math.sign(center[axis]-bodyCenter[axis])||1
        normal.multiplyScalar(side)
        if(normal.z*direction<0)throw Error(`「${device.name||device.id}」炉门背向导轨，请先调整朝向`)
        center[axis]+=side*size[axis]/2
        return center.applyMatrix4(matrix).z
    }
    const projected=box.clone().applyMatrix4(matrix)
    return direction>0?projected.max.z:projected.min.z
}

export function alignLoadingFaces(rows){
    if(rows.length<2)throw Error('同一设备线至少需要两台设备')
    const direction=rows[0].direction
    if(rows.some(r=>r.direction!==direction))throw Error('进料面必须朝向同一侧导轨')
    // Keep the face nearest the rail fixed. Move the remaining equipment to it.
    const front=direction*Math.max(...rows.map(r=>direction*(Number(r.z)+r.faceOffset)))
    return rows.map(r=>({...r,z:Number((front-r.faceOffset).toFixed(6))}))
}

export async function measureLoadingFaces(rows,models,{load=loadConfiguredGltf}={}){
    const assets=new Map()
    try{
        const measured=[]
        for(const row of rows){
            const model=models.find(m=>m.id===row.device.model_type),file=row.device.model_file||model?.file_path
            if(!file)throw Error(`「${row.device.name||row.id}」没有模型文件`)
            const url=resolveBackendAssetUrl(file)
            if(!assets.has(url))assets.set(url,(await load(url)).scene)
            measured.push({...row,faceOffset:loadingFaceOffset(assets.get(url),row.device,model,row.direction)})
        }
        return measured
    }finally{for(const root of assets.values())disposeSceneObject(root)}
}
