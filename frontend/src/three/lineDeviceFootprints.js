import * as T from 'three'
import {nativeDeviceTransform} from '../runtime/factorySceneConfig.js'
import {loadConfiguredGltf,disposeSceneObject} from '../runtime/ConfiguredFactoryScene.js'
import {resolveBackendAssetUrl} from './ModelFactory.js'

// Project the actual model geometry into production-line X, using the same
// scale, mirroring and handedness as the configured scene / Unity renderer.
export function lineDeviceFootprint(root,device,model){
    const transform=nativeDeviceTransform(device,model),wrapper=new T.Group()
    wrapper.rotation.y=transform.yaw;wrapper.scale.fromArray(transform.scale);wrapper.add(root)
    try{
        wrapper.updateMatrixWorld(true);const box=new T.Box3().setFromObject(wrapper,true)
        if(box.isEmpty()||!Number.isFinite(box.min.x)||!Number.isFinite(box.max.x))throw Error('模型没有有效几何')
        return {minX:-box.max.x,maxX:-box.min.x}
    }finally{wrapper.remove(root)}
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
