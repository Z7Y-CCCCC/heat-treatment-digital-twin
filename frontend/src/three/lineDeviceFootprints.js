import * as T from 'three'
import {nativeDeviceTransform} from '../runtime/factorySceneConfig.js'
import {loadConfiguredGltf,disposeSceneObject} from '../runtime/ConfiguredFactoryScene.js'
import {resolveBackendAssetUrl} from './ModelFactory.js'
import {inferLoadingPort} from './lineLoadingAlignment.js'
import {resolveLoadingPort,normalizeLoadingPortOverrides,resolveLoadingPortSource} from '../../../shared/loadingPorts.mjs'
import {CART_FEED} from './cartFeedMechanism.js'

// Project the actual model geometry into production-line X, using the same
// scale, mirroring and handedness as the configured scene / Unity renderer.
export function lineDeviceFootprint(root,device,model){
    const {minX,maxX}=lineDeviceEnvelope(root,device,model)
    return {minX,maxX}
}
export function lineDeviceEnvelope(root,device,model,{parts=false}={}){
    const transform=nativeDeviceTransform(device,model),wrapper=new T.Group()
    wrapper.rotation.y=transform.yaw;wrapper.scale.fromArray(transform.scale);wrapper.add(root)
    try{
        wrapper.updateMatrixWorld(true);const box=new T.Box3().setFromObject(wrapper,true)
        if(box.isEmpty()||!Number.isFinite(box.min.x)||!Number.isFinite(box.max.x))throw Error('模型没有有效几何')
        const result={minX:-box.max.x,maxX:-box.min.x,minY:box.min.y,maxY:box.max.y,minZ:box.min.z,maxZ:box.max.z}
        if(parts){
            result.collisionBoxes=[]
            root.traverse(n=>{if(!n.isMesh)return;const b=new T.Box3().setFromObject(n,true);if(!b.isEmpty())result.collisionBoxes.push({minX:-b.max.x,maxX:-b.min.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z})})
            const config=typeof device.instance_config==='string'?JSON.parse(device.instance_config||'{}'):device.instance_config||{},link=config.animationBindings?.transferLink
            const cart=!!config.railId||device.model_type==='cad_transfer_cart_101300'||device.model_type==='photo_transfer_cart_v6'
            const kind=cart?(link?.sourcePort||'outlet'):(link?.targetPort||'inlet')
            result.rotationY=transform.yaw
            result.loadingPort=null // Automatic alignment never uses an inferred or mirrored mouth.
            try {
                const configured=resolveLoadingPort(model,device,kind)
                const override=normalizeLoadingPortOverrides(config.loadingPortOverrides)[kind]
                const source=resolveLoadingPortSource(model,device,kind)
                if(configured) result.loadingPort={kind,position:wrapper.localToWorld(new T.Vector3(...configured.position)).toArray(),
                    direction:new T.Vector3(...configured.direction).transformDirection(wrapper.matrixWorld).toArray(),
                    source:source.startsWith('instance-')?'instance':'model',calibration:configured.region?'region':'point',
                    overrideYawDegrees:source==='instance-point'?(override?.yawDegrees??0):0}
                if(cart){
                    const metadata=typeof model?.metadata==='string'?JSON.parse(model.metadata):model?.metadata||{}
                    const cad=device.model_type==='cad_transfer_cart_101300'||!!root.getObjectByName('cad_transfer_cart_v1_feed_carriage')
                    const binding=(metadata.partBindings||[]).find(b=>b.source_key==='cart_feed_extension'&&b.axis==='x')
                    const stroke=cad?CART_FEED.stroke:Math.abs(Number(binding?.output_max)-Number(binding?.output_min||0))
                    if(Number.isFinite(stroke)&&stroke>0){
                        const drive=new T.Vector3(cad?-stroke:stroke,0,0).applyMatrix3(new T.Matrix3().setFromMatrix4(wrapper.matrixWorld))
                        result.transferStroke=drive.length();result.transferAxis=drive.normalize().toArray()
                    }
                }
            } catch { /* Geometry-only checks remain usable; auto alignment reports the named missing calibration. */ }
            try{
                const port=resolveLoadingPort(model,device,kind)||inferLoadingPort(root,device,model,kind)
                if(port){
                    const p=new T.Vector3(...port.position),world=wrapper.localToWorld(p.clone());result.loadingFaceZ=world.z
                    if(cart){
                        const metadata=typeof model?.metadata==='string'?JSON.parse(model.metadata):model?.metadata||{}
                        const binding=(metadata.partBindings||[]).find(b=>b.source_key==='cart_feed_extension'&&b.axis==='x')
                        const stroke=cart&&device.model_type==='cad_transfer_cart_101300'?CART_FEED.stroke:Math.abs(Number(binding?.output_max)-Number(binding?.output_min||0))
                        const drive=new T.Vector3(stroke,0,0).applyMatrix3(new T.Matrix3().setFromMatrix4(wrapper.matrixWorld))
                        if(Number.isFinite(stroke)&&Math.abs(drive.z)>.0001){p.x*=-1;p.z*=-1;const opposite=wrapper.localToWorld(p);result.transferReach={stroke:Math.abs(drive.z),positiveFaceZ:Math.max(world.z,opposite.z),negativeFaceZ:Math.min(world.z,opposite.z)}}
                    }
                }
            }catch{/* A normal geometry measurement must still work without port calibration. */}
        }
        return result
    }finally{wrapper.remove(root)}
}
export async function measureLineEnvelopes(devices,models,{signal,load=loadConfiguredGltf}={}){
    const assets=new Map()
    try{
        const result=[]
        for(const device of devices){
            if(signal?.aborted)throw Error('已取消布局检查')
            const model=models.find(m=>m.id===device.model_type),file=device.model_file||model?.file_path
            if(!file)throw Error(`设备「${device.name||device.id}」没有可测量模型，未按设备中心点猜测尺寸`)
            const url=resolveBackendAssetUrl(file)
            if(!assets.has(url))assets.set(url,(await load(url,{signal})).scene)
            result.push({id:device.id,name:device.name||device.id,x:Number(device.pos_x),y:Number(device.pos_y??0),z:Number(device.pos_z),...lineDeviceEnvelope(assets.get(url),device,model,{parts:true})})
        }
        return result
    }finally{for(const root of assets.values())disposeSceneObject(root)}
}
export async function measureLineDevices(devices,models,{signal,load=loadConfiguredGltf}={}){
    const assets=new Map()
    try{
        const result=[]
        for(const device of devices){
            if(signal?.aborted)throw Error('已取消排布')
            const model=models.find(m=>m.id===device.model_type),file=device.model_file||model?.file_path
            if(!file)throw Error(`设备「${device.name||device.id}」没有模型文件，无法计算外形间距`)
            const url=resolveBackendAssetUrl(file)
            if(!assets.has(url))assets.set(url,(await load(url,{signal})).scene)
            result.push({id:device.id,name:device.name||device.id,x:Number(device.pos_x)||0,...lineDeviceFootprint(assets.get(url),device,model)})
        }
        return result
    }finally{for(const root of assets.values())disposeSceneObject(root)}
}
