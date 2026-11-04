import * as T from 'three'
import {CadMotionScene} from './CadMotionScene.js'
import {CadMotionRig} from './CadMotionRig.js'
import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'
import {LineSimulationRig} from './LineSimulationRig.js'
import {CleanerProcessEffects} from './CleanerProcessEffects.js'
import {loadConfiguredGltf} from '../runtime/ConfiguredFactoryScene.js'
import {restoreGltfNodeNames} from './gltfNodeIdentity.js'
import {resolveBackendAssetUrl,createDeviceModel} from './ModelFactory.js'
import {FurnaceModel} from './FurnaceModel.js'
import {deviceLocalToWorld} from '../utils/spatialLayout.js'
import {parseSimulationConfig} from './lineSimulation.js'
import {fitCameraBox} from '../utils/cameraBoxFit.js'
import {CART_FEED} from './cartFeedMechanism.js'

function bounds(root){const result=new T.Box3();root.traverse(n=>{if(!n.isMesh)return;for(let p=n;p;p=p.parent)if(!p.visible)return;result.union(new T.Box3().setFromObject(n))});return result}
function label(name){const canvas=document.createElement('canvas');canvas.width=768;canvas.height=96;const c=canvas.getContext('2d');c.fillStyle='#203d52e8';c.fillRect(0,0,768,96);c.font='36px Microsoft YaHei';c.fillStyle='#ffffff';c.textAlign='center';c.fillText(name,384,61,730);const texture=new T.CanvasTexture(canvas);const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,depthTest:false}));sprite.scale.set(3,.375,1);return sprite}

export class LineSimulationScene extends CadMotionScene {
    constructor(container,onTick){super(container,onTick);this.entries=new Map();this.abort=new AbortController();this.shell=[]}
    async loadPlan(plan,lines,workshops,mode){
        let cursor=0
        for(const row of plan.rows){
            if(this.disposed)throw Error('加载已取消')
            const model=row.capabilities.model
            let asset
            if(row.model_type==='builtin_furnace')asset=new FurnaceModel(row.id,row.name)
            else if(row.model_type==='transfer_cart'&&!model?.file_path)asset=await createDeviceModel(row,[])
            else{const gltf=await loadConfiguredGltf(resolveBackendAssetUrl(model.file_path),{signal:this.abort.signal});restoreGltfNodeNames(gltf);asset=gltf.scene}
            if(this.disposed){this.release(asset);throw Error('加载已取消')}
            if(row.model_type==='ultrasonic_cleaner_cad'){const detached=asset.getObjectByName('221_气动管路');if(detached)detached.visible=false}
            const box=bounds(asset),center=box.getCenter(new T.Vector3())
            const rig=CAD_MOTION_PROFILES[row.model_type]?new CadMotionRig(asset,row.model_type):new LineSimulationRig(asset,model||{id:row.model_type})
            if(!CAD_MOTION_PROFILES[row.model_type]&&row.capabilities.door&&!rig.bindings.some(b=>b.binding.source_group==='doors')){
                this.release(asset);throw Error(`${row.name||row.id} 缺少已配置的门体动作节点`)
            }
            const entry={row,asset,rig,offset:new T.Group(),wrapper:new T.Group(),baseBox:box,scale:1,feedDirection:row.model_type==='cad_transfer_cart_101300'?-1:1}
            this.entries.set(row.id,entry)
            rig.applyLinked({door:0,feed:0,level:row.model_type==='cad_water_cooling_tank_471000'?1:0,runTime:0,time:0})
            if(row.model_type==='ultrasonic_cleaner_cad')entry.effects=new CleanerProcessEffects(asset,asset)
            entry.offset.position.set(-center.x,-box.min.y,-center.z);entry.offset.add(asset);entry.wrapper.add(entry.offset);this.scene.add(entry.wrapper)
            const c=parseSimulationConfig(row.instance_config),scale=Math.max(.0001,(Number(row.scale)||1)*(Number(model?.default_scale)||1)*(Number(c.scaleMultiplier)||1));entry.scale=scale
            entry.wrapper.scale.set((c.mirrorX??c.mirror_x)?-scale:scale,scale,scale)
            entry.wrapper.updateMatrixWorld(true)
            const door=asset.getObjectsByProperty('name',CAD_MOTION_PROFILES[row.model_type]?.prefix+'door')[0]
                ||rig.bindings?.find(b=>b.binding.source_group==='doors')?.node
            const bed=asset.getObjectByName(CAD_MOTION_PROFILES[row.model_type]?.prefix+'roller_bed')
                ||asset.getObjectByName('cart_v6_node_cart_transfer_frame')
            const portBounds=door?bounds(door):bed?bounds(bed):bounds(asset)
            const local=entry.wrapper.worldToLocal(portBounds.getCenter(new T.Vector3()))
            const localBounds=portBounds.clone().applyMatrix4(entry.wrapper.matrixWorld.clone().invert())
            local.y=entry.wrapper.worldToLocal(new T.Vector3(0,door?portBounds.min.y:portBounds.max.y,0)).y+.08
            const delta=local.clone()
            entry.normal=door?(Math.abs(delta.x)>Math.abs(delta.z)?new T.Vector3(Math.sign(delta.x)||1,0,0):new T.Vector3(0,0,Math.sign(delta.z)||1)):new T.Vector3(-1,0,0)
            if(!door&&!row.capabilities.cart){local.x=localBounds.min.x+.03;local.z=localBounds.getCenter(new T.Vector3()).z}
            if(row.capabilities.cart){local.x=entry.feedDirection<0?localBounds.min.x+.12:localBounds.max.x-.12;local.z=localBounds.getCenter(new T.Vector3()).z}
            entry.port=local
            if(row.model_type==='cad_multipurpose_furnace_082000'){
                entry.frontInside=new T.Vector3(0,1.68,-.985).add(entry.offset.position)
                entry.hotInside=new T.Vector3(0,1.68,-3.05).add(entry.offset.position)
            }
            if(mode==='site'){
                const line=lines.find(l=>String(l.id)===String(row.line_id||c.railLineId||c.laneLineId||plan.stations[0]?.line_id)),ws=workshops.find(w=>String(w.id)===String(line?.workshop_id||c.workshop_id||c.workshopId))
                const p=deviceLocalToWorld(row,ws,line);entry.wrapper.position.set(p.x,p.y,p.z);entry.wrapper.rotation.y=p.rotationY
            }else if(!row.capabilities.cart){
                const size=box.getSize(new T.Vector3());entry.wrapper.rotation.y=-Math.atan2(entry.normal.x,entry.normal.z)
                entry.wrapper.position.x=cursor;cursor+=Math.max(size.x,size.z)*scale+3
            }
            entry.wrapper.updateMatrixWorld(true);entry.basePosition=entry.wrapper.position.clone();entry.baseYaw=entry.wrapper.rotation.y
            const caption=label(row.name||row.id);caption.position.set(0,box.getSize(new T.Vector3()).y+.35,0);entry.wrapper.add(caption)
            const shellNames=[...new Set([...parseSimulationConfig(model?.metadata).inspection?.shell?.node_names||[],...(CAD_MOTION_PROFILES[row.model_type]?['housing','lining','hood','upper_housing','tank','tanks','central_lower_body','lower_collection','fans_enamel','cold_housing','hot_housing','refractory','vault_bricks','partition_shell','partition_lining','quench_tank','quench_liquid'].map(n=>CAD_MOTION_PROFILES[row.model_type].prefix+n):[])])]
            for(const name of shellNames)asset.getObjectByName(name)?.traverse(n=>{if(n.isMesh){const materials=[].concat(n.material).map(m=>{const c=m.clone();c.userData.previewOpacity=m.opacity;c.userData.previewTransparent=m.transparent;return c});n.material=Array.isArray(n.material)?materials:materials[0];this.shell.push(...materials)}})
        }
        this.plan=plan
        if(plan.cart){
            const cart=this.entries.get(plan.cart.id),first=plan.stations.find(s=>s.capabilities.animated)
            if(mode!=='site'&&first){const dock=this.dock(first.id);cart.basePosition.copy(dock.position).add(new T.Vector3(3,0,3));cart.baseYaw=dock.yaw;cart.wrapper.position.copy(cart.basePosition);cart.wrapper.rotation.y=cart.baseYaw}
        }
        this.material=new T.Group();const mat=new T.MeshStandardMaterial({color:'#dca34f',metalness:.5,roughness:.4})
        const pallet=new T.Mesh(new T.BoxGeometry(.55,.08,.4),mat);this.material.add(pallet)
        for(let i=0;i<3;i++){const billet=new T.Mesh(new T.CylinderGeometry(.075,.075,.24,16),new T.MeshStandardMaterial({color:'#8eaeb8',metalness:.7}));billet.position.set((i-1)*.15,.16,0);this.material.add(billet)}
        this.scene.add(this.material)
        this.chain=new T.InstancedMesh(new T.BoxGeometry(.065,.025,.04),new T.MeshStandardMaterial({color:'#dba02b',metalness:.7}),160);this.chain.frustumCulled=false;this.scene.add(this.chain)
        this.bounds=new T.Box3();for(const entry of this.entries.values())this.bounds.union(bounds(entry.wrapper))
        if(plan.cart){
            const cart=this.entries.get(plan.cart.id),position=cart.wrapper.position.clone(),yaw=cart.wrapper.rotation.y
            for(const station of plan.stations.filter(s=>s.capabilities.animated)){
                const dock=this.dock(station.id);cart.wrapper.position.copy(dock.position);cart.wrapper.rotation.y=dock.yaw;cart.wrapper.updateMatrixWorld(true);this.bounds.union(bounds(cart.wrapper))
            }
            cart.wrapper.position.copy(position);cart.wrapper.rotation.y=yaw;cart.wrapper.updateMatrixWorld(true)
        }
        if(this.bounds.isEmpty())throw Error('没有可显示设备')
        this.setCutaway(true);this.resetCamera()
    }
    port(id,inside=false,state){
        const entry=this.entries.get(id);if(!entry)return new T.Vector3()
        const p=inside&&entry.frontInside?entry.frontInside.clone().lerp(entry.hotInside,state?.chamber||0):entry.port.clone()
        if(inside&&!entry.row.capabilities.cart&&!entry.frontInside)p.addScaledVector(entry.normal,-.45)
        if(state?.basket)p.y-=1.05*state.basket
        if(state?.lift)p.y+=.24*state.lift
        return entry.wrapper.localToWorld(p)
    }
    dock(id){
        const station=this.entries.get(id),cart=this.entries.get(this.plan?.cart?.id||[...this.entries.values()].find(e=>e.row.capabilities.cart)?.row.id)
        const normal=station.normal.clone().transformDirection(station.wrapper.matrixWorld)
        const yaw=Math.atan2(normal.z,-normal.x)+(cart?.wrapper.scale.x<0?Math.PI:0)+(cart?.feedDirection<0?Math.PI:0)
        const offset=cart?cart.port.clone().setY(0).multiply(cart.wrapper.scale).applyAxisAngle(new T.Vector3(0,1,0),yaw):new T.Vector3()
        const position=this.port(id).addScaledVector(normal,.35).sub(offset)
        position.y=cart?.basePosition?.y||0
        return {position,yaw}
    }
    loadPort(id,inside=false,state){
        const entry=this.entries.get(id)
        if(entry?.row.capabilities.cart&&entry.rig.node?.('push_hook')){
            // Keep the tray's trailing edge at the installed hook's working face.
            const point=new T.Vector3(CART_FEED.homeTrayX+entry.offset.position.x,entry.port.y,entry.offset.position.z)
            return entry.wrapper.localToWorld(point)
        }
        return this.port(id,inside,state)
    }
    applyFrame(frame){
        if(!this.plan)return
        const cart=this.entries.get(this.plan.cart?.id)
        if(cart){
            const start=frame.cart.from?this.dock(frame.cart.from):{position:cart.basePosition,yaw:cart.baseYaw}
            const end=frame.cart.to?this.dock(frame.cart.to):start
            cart.wrapper.position.lerpVectors(start.position,end.position,frame.cart.progress)
            cart.wrapper.rotation.y=start.yaw+Math.atan2(Math.sin(end.yaw-start.yaw),Math.cos(end.yaw-start.yaw))*frame.cart.progress
            cart.wrapper.updateMatrixWorld(true)
        }
        for(const [id,entry] of this.entries){
            const state={...frame.states[id],operation:frame.step.deviceId===id?frame.step.kind:''}
            if(entry.row.capabilities.cart){
                const travel=frame.cart.segments.reduce((sum,segment)=>{const a=segment.from?this.dock(segment.from).position:entry.basePosition,b=this.dock(segment.to).position;return sum+a.distanceTo(b)*segment.progress},0)
                Object.assign(state,{feed:frame.cart.feed,travel:travel/entry.scale,runTime:frame.cart.runTime})
                if(entry.rig.node?.('push_hook')){
                    state.hookEngaged=['feed','reclaim'].includes(frame.step.kind)
                    if(frame.cart.to){
                        const home=entry.wrapper.worldToLocal(this.loadPort(id)),destination=entry.wrapper.worldToLocal(this.loadPort(frame.cart.to,true,frame.states[frame.cart.to]))
                        state.feedTravel=Math.max(0,(destination.x-home.x)*entry.feedDirection)
                    }
                }
            }
            entry.rig.applyLinked(state)
            entry.effects?.apply({time:frame.elapsed,level:state.level,temperature:state.heat?55:25,fill:state.operation==='fill',heat:state.heat,spray:state.spray,ultrasonic:state.ultrasonic,drain:state.operation==='drain',blow:state.blow,wetness:state.level})
        }
        this.material.visible=!!frame.material.holder
        if(this.material.visible){
            const m=frame.material,point=id=>this.loadPort(id,id!==this.plan.cart?.id,frame.states[id])
            const p=m.to&&m.progress<1?point(m.from).lerp(point(m.to),m.progress):point(m.holder)
            this.material.position.copy(p)
            this.material.rotation.y=cart?.wrapper.rotation.y||0
        }
        this.chain.visible=!!cart&&frame.cart.feed>.001&&!!frame.cart.to
        if(this.chain.visible){
            const a=this.port(this.plan.cart.id),b=this.port(frame.cart.to,true).sub(a),length=b.length()*frame.cart.feed
            const direction=b.normalize(),count=Math.min(160,Math.max(1,Math.ceil(length/.08))),matrix=new T.Matrix4(),rotation=new T.Quaternion().setFromUnitVectors(new T.Vector3(1,0,0),direction)
            for(let i=0;i<count;i++)matrix.compose(a.clone().addScaledVector(direction,length*i/count),rotation,new T.Vector3(1,1,1)),this.chain.setMatrixAt(i,matrix)
            this.chain.count=count;this.chain.instanceMatrix.needsUpdate=true
        }
    }
    focus(id){const entry=this.entries.get(id);if(!entry)return;const whole=this.bounds;this.bounds=bounds(entry.wrapper);if(this.plan.cart)this.bounds.union(bounds(this.entries.get(this.plan.cart.id).wrapper));this.resetCamera();this.bounds=whole}
    resetCamera(){
        if(!this.bounds||this.bounds.isEmpty())return
        const b=this.bounds.clone().expandByScalar(.3),radius=b.getSize(new T.Vector3()).length()/2
        const pose=fitCameraBox({minX:b.min.x,maxX:b.max.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z},{fov:this.camera.fov,aspect:this.camera.aspect,direction:[.7,.55,1.2],margin:1.15})
        this.controls.target.fromArray(pose.target);this.camera.position.fromArray(pose.position);this.camera.near=Math.max(.01,radius/1000);this.camera.far=Math.max(1000,radius*100);this.camera.lookAt(this.controls.target);this.camera.updateProjectionMatrix();this.controls.update()
    }
    dispose(){if(this.disposed)return;this.abort.abort();for(const e of this.entries.values()){e.rig.dispose();e.effects?.dispose()}super.dispose()}
}
