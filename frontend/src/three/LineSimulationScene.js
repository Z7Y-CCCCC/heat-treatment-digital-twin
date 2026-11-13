import * as T from 'three'
import {CadMotionScene} from './CadMotionScene.js'
import {CadMotionRig} from './CadMotionRig.js'
import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'
import {LineSimulationRig} from './LineSimulationRig.js'
import {CleanerProcessEffects} from './CleanerProcessEffects.js'
import {loadConfiguredGltf} from '../runtime/ConfiguredFactoryScene.js'
import {restoreGltfNodeNames} from './gltfNodeIdentity.js'
import {resolveBackendAssetUrl} from './ModelFactory.js'
import {deviceLocalToWorld} from '../utils/spatialLayout.js'
import {parseSimulationConfig} from './lineSimulation.js'
import {fitCameraBox} from '../utils/cameraBoxFit.js'
import {CART_FEED} from './cartFeedMechanism.js'
import {CLEANER_BATH} from './cleanerBathLayout.js'
import {TRANSFER_DATUM} from '../../../shared/equipmentTransferDatum.mjs'
import {buildAdaptiveTransferPath,sampleAdaptiveTransferPath,sameAdaptiveTransferGeometry} from '../../../shared/adaptiveTransferPath.mjs'
import {measureEquipmentLoadCenters,equipmentLoadPoint} from './equipmentLoadCenter.js'
import {CAD_CUTAWAY_SUFFIXES,collectCutawayMaterials} from './cadCutaway.js'
import {siteDeviceTransform,siteLoadingDatum,siteCarrierPath,siteCarrierInitialPosition,assertSiteTransferDriver,solveSiteTransferPose,siteSceneUnitsPerMeter,siteWorldVector,siteWorldPoint,siteParentPoint,applySitePayloadMetrics} from './siteTransferAlignment.js'

function bounds(root){const result=new T.Box3();root.traverse(n=>{if(!n.isMesh)return;for(let p=n;p;p=p.parent)if(!p.visible)return;result.union(new T.Box3().setFromObject(n))});return result}
function label(name){const canvas=document.createElement('canvas');canvas.width=768;canvas.height=96;const c=canvas.getContext('2d');c.fillStyle='#203d52e8';c.fillRect(0,0,768,96);c.font='36px Microsoft YaHei';c.fillStyle='#ffffff';c.textAlign='center';c.fillText(name,384,61,730);const texture=new T.CanvasTexture(canvas);const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,depthTest:false}));sprite.scale.set(3,.375,1);return sprite}

export class LineSimulationScene extends CadMotionScene {
    constructor(container,onTick){super(container,onTick);this.entries=new Map();this.abort=new AbortController();this.shell=[];this.setNavigationMode('rotate')}
    setNavigationMode(mode){
        const pan=mode==='pan'
        this.controls.enablePan=true;this.controls.screenSpacePanning=true
        this.controls.mouseButtons.LEFT=pan?T.MOUSE.PAN:T.MOUSE.ROTATE
        this.controls.touches.ONE=pan?T.TOUCH.PAN:T.TOUCH.ROTATE
        this.controls.touches.TWO=T.TOUCH.DOLLY_PAN
        this.renderer.domElement.style.cursor=pan?'grab':'auto'
    }
    async loadPlan(plan,lines,workshops,mode,{transferTolerances={heightToleranceMeters:0,lateralToleranceMeters:0,angleToleranceDegrees:0}}={}){
        this.mode=mode;this.transferTolerances=transferTolerances;this.siteLines=lines;this.siteWorkshops=workshops
        const cartLink=parseSimulationConfig(plan.cart?.instance_config).animationBindings?.transferLink
        let cursor=0
        for(const row of plan.rows){
            if(this.disposed)throw Error('加载已取消')
            const model=row.capabilities.model
            if(!model?.file_path)throw Error(`${row.name||row.id} 缺少可加载的模型资产`)
            const gltf=await loadConfiguredGltf(resolveBackendAssetUrl(model.file_path),{signal:this.abort.signal});restoreGltfNodeNames(gltf);const asset=gltf.scene
            if(this.disposed){this.release(asset);throw Error('加载已取消')}
            if(row.model_type==='ultrasonic_cleaner_cad'){const detached=asset.getObjectByName('221_气动管路');if(detached)detached.visible=false}
            const box=bounds(asset),center=box.getCenter(new T.Vector3())
            const loadCenters=row.capabilities.cart?null:measureEquipmentLoadCenters(asset,row.model_type)
            const rig=CAD_MOTION_PROFILES[row.model_type]?new CadMotionRig(asset,row.model_type):new LineSimulationRig(asset,model||{id:row.model_type})
            if(!CAD_MOTION_PROFILES[row.model_type]&&row.capabilities.door&&!rig.bindings.some(b=>b.binding.source_group==='doors')){
                this.release(asset);throw Error(`${row.name||row.id} 缺少已配置的门体动作节点`)
            }
            const entry={row,asset,rig,loadCenters,offset:new T.Group(),wrapper:new T.Group(),baseBox:box,scale:1,feedDirection:row.model_type==='cad_transfer_cart_101300'?-1:1}
            this.entries.set(row.id,entry)
            rig.applyLinked({door:0,feed:0,level:['cad_water_cooling_tank_471000','cad_cleaner_170700'].includes(row.model_type)?1:0,runTime:0,time:0})
            if(row.model_type==='ultrasonic_cleaner_cad')entry.effects=new CleanerProcessEffects(asset,asset)
            if(mode!=='site')entry.offset.position.set(-center.x,-box.min.y,-center.z)
            entry.offset.add(asset);entry.wrapper.add(entry.offset);this.scene.add(entry.wrapper)
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
            if(rig.transferAlignment)entry.port.y=TRANSFER_DATUM.loadY+entry.offset.position.y
            else if(row.model_type==='cad_cleaner_170700')entry.port.y=CLEANER_BATH.loadY+entry.offset.position.y
            if(mode==='site'){
                const transform=siteDeviceTransform(row,model||{},lines,workshops),savedLink=c.animationBindings?.transferLink
                const kind=cartLink?.enabled ? (row.capabilities.cart ? cartLink.sourcePort : cartLink.targetPort) : 'inlet'
                const datum=siteLoadingDatum(row,model||{},transform,kind||'inlet')
                entry.port.copy(datum.local);entry.normal.fromArray(datum.port.direction)
                entry.wrapper.position.set(transform.position.x,transform.position.y,transform.position.z);entry.wrapper.rotation.y=transform.yaw;entry.wrapper.scale.fromArray(transform.scale)
                entry.siteTransform=transform;entry.savedLink=savedLink
            }else if(!row.capabilities.cart){
                const size=box.getSize(new T.Vector3());entry.wrapper.rotation.y=-Math.atan2(entry.normal.x,entry.normal.z)
                entry.wrapper.position.x=cursor;cursor+=Math.max(size.x,size.z)*scale+3
            }
            entry.wrapper.updateMatrixWorld(true);entry.basePosition=entry.wrapper.position.clone();entry.baseYaw=entry.wrapper.rotation.y
            if(mode==='site')entry.siteSavedPosition=entry.basePosition.clone()
            const caption=label(row.name||row.id);caption.position.set(0,box.getSize(new T.Vector3()).y+.35,0);entry.wrapper.add(caption)
            const shellNames=[...new Set([...parseSimulationConfig(model?.metadata).inspection?.shell?.node_names||[],...(CAD_MOTION_PROFILES[row.model_type]?CAD_CUTAWAY_SUFFIXES.map(n=>CAD_MOTION_PROFILES[row.model_type].prefix+n):[])])]
            this.shell.push(...collectCutawayMaterials(asset,shellNames))
        }
        this.plan=plan
        if(plan.cart){
            const cart=this.entries.get(plan.cart.id),first=plan.stations.find(s=>s.capabilities.animated)
            if(mode==='site'){
                // Capture the actual rendered home, not the asset origin or the
                // current animated pose. Later frames use this same baseline.
                cart.siteDriveNode=cart.row.model_type==='cad_transfer_cart_101300'?cart.rig.node?.('feed_carriage'):cart.rig.shuttle
                cart.siteDriveRest=cart.siteDriveNode?.position.clone()
                this.configureSiteCart(cart)
                cart.wrapper.position.copy(cart.basePosition);cart.wrapper.updateMatrixWorld(true)
                for(const station of plan.stations.filter(s=>s.capabilities.animated))this.dock(station.id)
                const railMaterial=new T.LineBasicMaterial({color:'#c99437'})
                for(const offset of [-.32,.32]){
                    const direction=cart.sitePath.end.clone().sub(cart.sitePath.start).normalize(),normal=new T.Vector3(-direction.z,0,direction.x).multiplyScalar(offset)
                    const geometry=new T.BufferGeometry().setFromPoints([cart.sitePath.start.clone().add(normal),cart.sitePath.end.clone().add(normal)])
                    this.scene.add(new T.Line(geometry,railMaterial))
                }
            }
            if(mode!=='site'&&first){const dock=this.dock(first.id);cart.basePosition.copy(dock.position).add(new T.Vector3(3,0,3));cart.baseYaw=dock.yaw;cart.wrapper.position.copy(cart.basePosition);cart.wrapper.rotation.y=cart.baseYaw}
        }
        this.material=new T.Group();this.material.visible=false;this.siteMaterialConfigured=mode==='site'&&!!cartLink?.enabled
        const mat=new T.MeshStandardMaterial({color:this.siteMaterialConfigured?cartLink.materialColor:'#dca34f',metalness:.5,roughness:.4})
        if(mode==='site'&&cartLink?.enabled){
            if(!Array.isArray(cartLink.materialSize)||cartLink.materialSize.length!==3||cartLink.materialSize.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<=0))throw Error('已配置的物料示意尺寸无效')
            // A unit cube permits metre dimensions to be compensated for the
            // actual payload parent, separately from the source model scale.
            this.material.add(new T.Mesh(new T.BoxGeometry(1,1,1),mat))
        }else{
            const pallet=new T.Mesh(new T.BoxGeometry(.55,.08,.4),mat);this.material.add(pallet)
            for(let i=0;i<3;i++){const billet=new T.Mesh(new T.CylinderGeometry(.075,.075,.24,16),new T.MeshStandardMaterial({color:'#8eaeb8',metalness:.7}));billet.position.set((i-1)*.15,.16,0);this.material.add(billet)}
        }
        this.scene.add(this.material)
        if(mode!=='site'&&plan.cart)this.material.scale.setScalar(this.entries.get(plan.cart.id).scale)
        if(this.siteMaterialConfigured){const cart=this.entries.get(plan.cart.id);applySitePayloadMetrics(this.material,cart.wrapper,cart.savedLink.materialSize,cart.sceneUnitsPerMeter)}
        this.bounds=new T.Box3();for(const entry of this.entries.values())this.bounds.union(bounds(entry.wrapper))
        if(plan.cart){
            const cart=this.entries.get(plan.cart.id),position=cart.wrapper.position.clone(),yaw=cart.wrapper.rotation.y
            for(const station of plan.stations.filter(s=>s.capabilities.animated)){
                const dock=this.dock(station.id);cart.wrapper.position.copy(dock.position);cart.wrapper.rotation.y=dock.yaw;cart.wrapper.updateMatrixWorld(true);this.bounds.union(bounds(cart.wrapper))
                if(cart.savedLink?.cycle?.enabled){
                    const cycle=cart.savedLink.cycle,s=cycle.stations.find(s=>s.targetDeviceId===station.id),target=this.entries.get(station.id)
                    const seat=target.asset.getObjectByName(s.seatNodeName);if(!seat)throw Error('缺少已配置承料节点：'+s.seatNodeName)
                    const home=siteWorldPoint(new T.Vector3(...cycle.cartHome),cart.wrapper),inside=siteWorldPoint(new T.Vector3(...s.seatNodeLocal),seat)
                    const mouth=siteLoadingDatum(target.row,target.row.capabilities.model||{},target.siteTransform,cart.savedLink.targetPort).position,path=inside.clone().sub(home)
                    const adaptive=this.adaptivePathFor(cart,target,dock)
                    const fraction=adaptive?adaptive.mouthFraction:mouth.clone().sub(home).dot(path)/path.lengthSq()
                    if(!Number.isFinite(fraction)||fraction<=0||fraction>=1)throw Error('设备口不在车上承料位与设备内承料位之间')
                    plan.transferMouthFractions||={};plan.transferMouthFractions[station.id]=fraction
                    if(adaptive){plan.transferPaths||={};plan.transferPaths[station.id]=adaptive}
                }
            }
            cart.wrapper.position.copy(position);cart.wrapper.rotation.y=yaw;cart.wrapper.updateMatrixWorld(true)
        }
        if(this.bounds.isEmpty())throw Error('没有可显示设备')
        this.setCutaway(true);this.resetCamera()
    }
    port(id,inside=false,state){
        const entry=this.entries.get(id);if(!entry)return new T.Vector3()
        if(inside&&entry.loadCenters){
            const stroke=entry.row.model_type==='cad_cleaner_170700'?CLEANER_BATH.stroke:entry.rig.basketStroke||1.05
            return entry.asset.localToWorld(equipmentLoadPoint(entry.loadCenters,state,stroke))
        }
        const p=entry.port.clone()
        if(inside&&!entry.row.capabilities.cart)p.addScaledVector(entry.normal,-.45)
        if(state?.basket)p.y-=(entry.rig.basketStroke||1.05)*state.basket
        if(state?.lift)p.y+=.24*state.lift
        return entry.wrapper.localToWorld(p)
    }
    configureSiteCart(cart){
        // Read current saved settings on every reconfiguration/frame. Neither a
        // hot units/port change nor a changed parent may reuse a stale dock.
        const config=parseSimulationConfig(cart.row.instance_config),link=config.animationBindings?.transferLink
        assertSiteTransferDriver(cart.row,cart.rig,cart.asset)
        const datum=siteLoadingDatum(cart.row,cart.row.capabilities.model||{},cart.siteTransform,link?.enabled?link.sourcePort:'inlet')
        const metadata=parseSimulationConfig(cart.row.capabilities.model?.metadata)
        const binding=(metadata.partBindings||[]).find(row=>row.source_key==='cart_feed_extension'&&row.action==='translate'&&row.axis==='x')
        const photo=cart.row.model_type==='photo_transfer_cart_v6',home=photo?Number(binding?.output_min??0):0
        // The supported CAD rig really moves its carriage -1.085 on local X;
        // metadata preview-only overrides must not invent a longer real drive.
        const signed=photo&&binding?Number(binding.output_max)-home:cart.row.model_type==='cad_transfer_cart_101300'?-CART_FEED.stroke:NaN
        if(!cart.siteDriveNode?.parent||!cart.siteDriveRest||!Number.isFinite(home)||!Number.isFinite(signed)||signed===0)throw Error(`${cart.row.name||cart.row.id} 没有可核验的推链行程，不能用演示假定现场可达`)
        const path=siteCarrierPath(cart.row,this.siteLines,this.siteWorkshops),units=siteSceneUnitsPerMeter(cart.row,this.siteLines)
        cart.savedLink=link?.enabled?link:null;cart.sitePath=path;cart.sceneUnitsPerMeter=units
        cart.port.copy(datum.local);cart.normal.fromArray(datum.port.direction)
        cart.siteStrokeLocal=Math.abs(signed);cart.siteFeedTravel=photo?signed:-signed;cart.siteFeedHome=home
        cart.siteDriveMaximum=new T.Vector3(signed,0,0)
        cart.sitePrimaryDriveNode=cart.asset.getObjectByName('cad_transfer_cart_v1_feed_carriage')
        cart.siteOppositeDriveNode=cart.asset.getObjectByName('opposite__cad_transfer_cart_v1_feed_carriage')
        if(photo)cart.siteDriveRest.copy(cart.rig.shuttleBase).add(new T.Vector3(home,0,0))
        cart.basePosition.copy(siteCarrierInitialPosition(path,cart.siteSavedPosition))
        return cart.savedLink
    }
    dock(id){
        const station=this.entries.get(id),cart=this.entries.get(this.plan?.cart?.id||[...this.entries.values()].find(e=>e.row.capabilities.cart)?.row.id)
        if(this.mode==='site'){
            const link=this.siteFrameCart===cart?cart.savedLink:this.configureSiteCart(cart)
            if(link?.targetMode==='fixed'&&String(link.targetDeviceId)!==String(id))throw Error(`${station.row.name||id} 不是料车已配置的联动目标`)
            if(link){
                const datum=siteLoadingDatum(station.row,station.row.capabilities.model||{},station.siteTransform,link.targetPort||'inlet')
                station.port.copy(datum.local);station.normal.fromArray(datum.port.direction)
            }
            const side=link?.cycle?.enabled&&link.cycle.stations.find(s=>s.targetDeviceId===String(id))?.side==='opposite'?-1:1
            const localPort=cart.port.clone(),localDirection=cart.normal.clone()
            if(side<0){localPort.x*=-1;localPort.z*=-1;localDirection.x*=-1;localDirection.z*=-1}
            const driveNode=side<0?cart.siteOppositeDriveNode:cart.siteDriveNode
            if(!driveNode?.parent)throw Error('缺少已配置的送料侧机构')
            const normal=siteWorldVector(station.normal,station.wrapper).normalize()
            const offset=siteWorldVector(localPort,cart.wrapper)
            const maximumDriveWorld=siteWorldVector(cart.siteDriveMaximum,driveNode.parent),feed=maximumDriveWorld.clone().normalize()
            const sourceDirection=siteWorldVector(localDirection,cart.wrapper).normalize()
            const sourceAngle=Math.acos(T.MathUtils.clamp(sourceDirection.dot(feed),-1,1))*180/Math.PI
            if(sourceAngle>(link||this.transferTolerances).angleToleranceDegrees+.0001)throw Error(`${cart.row.name||cart.row.id} 已配置进出料口的朝向与实际送料驱动不一致，请校准进出料口；未忽略该配置或旋转料车`)
            let fixedPosition
            if(cart.sitePath.stations){
                const anchors=cart.sitePath.stations.filter(station=>String(station.anchorDeviceId)===String(id))
                if(anchors.length!==1||cart.sitePath.stations.filter(station=>Math.abs(station.value-anchors[0].value)<.0001).length!==1)throw Error(`${station.row.name||id} 没有唯一的已配置料车工位编号和关联设备，请在移动设备中配置；不能用模拟停靠替代真实工位`)
                fixedPosition=siteWorldPoint(anchors[0].position,cart.wrapper.parent)
            }
            const result=solveSiteTransferPose({start:siteWorldPoint(cart.sitePath.start,cart.wrapper.parent),end:siteWorldPoint(cart.sitePath.end,cart.wrapper.parent),cartPortOffset:offset,feedDirection:feed,stationPosition:siteWorldPoint(station.port,station.wrapper),stationDirection:normal,
                stroke:maximumDriveWorld.length(),fixedPosition,...(link||this.transferTolerances),handoffMode:link?.cycle?.enabled?link.cycle.handoffMode||'mechanism':'mechanism',sceneUnitsPerMeter:cart.sceneUnitsPerMeter,name:station.row.name||id})
            return {...result,worldPosition:result.position.clone(),position:siteParentPoint(result.position,cart.wrapper.parent),yaw:cart.baseYaw,feedDirection:feed,cartPortOffset:offset,maximumDriveWorld,feedSide:side}
        }
        const normal=station.normal.clone().transformDirection(station.wrapper.matrixWorld)
        const yaw=Math.atan2(normal.z,-normal.x)+(cart?.wrapper.scale.x<0?Math.PI:0)+(cart?.feedDirection<0?Math.PI:0)
        const offset=cart?cart.port.clone().setY(0).multiply(cart.wrapper.scale).applyAxisAngle(new T.Vector3(0,1,0),yaw):new T.Vector3()
        const position=this.port(id).addScaledVector(normal,.15*(cart?.scale||1)).sub(offset)
        position.y=cart?.basePosition?.y||0
        return {position,yaw}
    }
    adaptivePathFor(cart,target,dock){
        const cycle=cart.savedLink.cycle,station=cycle.stations.find(s=>s.targetDeviceId===target.row.id)
        const nodes=target.asset.getObjectsByProperty('name',station?.seatNodeName||'')
        if(nodes.length!==1)throw Error('设备内承料节点缺失或重名')
        const units=cart.sceneUnitsPerMeter,toMeters=v=>v.toArray().map(n=>n/units)
        const home=dock.worldPosition.clone().add(siteWorldVector(new T.Vector3(...cycle.cartHome),cart.wrapper))
        return buildAdaptiveTransferPath({...cart.savedLink,home:toMeters(home),sourcePort:toMeters(dock.worldPosition.clone().add(dock.cartPortOffset)),sourceDirection:dock.feedDirection.toArray(),mouth:toMeters(siteWorldPoint(target.port,target.wrapper)),targetDirection:siteWorldVector(target.normal,target.wrapper).normalize().toArray(),seat:toMeters(siteWorldPoint(new T.Vector3(...station.seatNodeLocal),nodes[0])),maximumDrive:toMeters(dock.maximumDriveWorld)})
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
        try{
            this.applySimulationFrame(frame)
            this.siteTransferReason='';if(this.material)this.material.userData.siteTransferReason=''
            return {usable:true,reason:''}
        }catch(error){
            if(this.mode!=='site')throw error
            // Invalid hot metrics/affine transforms must not leave yesterday's
            // cuboid displayed as a valid current measurement. A valid next
            // frame can recover without an asset reload or invented PLC input.
            this.siteTransferReason=error.message||String(error)
            if(this.material){this.material.visible=false;this.material.userData.siteTransferReason=this.siteTransferReason}
            return {usable:false,reason:this.siteTransferReason}
        }finally{this.siteFrameCart=null}
    }
    applySimulationFrame(frame){
        if(!this.plan)return
        const cart=this.entries.get(this.plan.cart?.id)
        if(this.mode==='site'&&cart){this.configureSiteCart(cart);this.siteFrameCart=cart}
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
                if(this.mode==='site'){state.feedTravel=entry.siteFeedTravel;state.feedHome=entry.siteFeedHome;state.feedSide=frame.cart.to?this.dock(frame.cart.to).feedSide:frame.cart.feedSide}
                if(entry.rig.node?.('push_hook')){
                    state.hookEngaged=entry.savedLink?.cycle?.enabled?1-Number(frame.cart.hookRelease||0):['feed','reclaim'].includes(frame.step.kind)
                    // Demonstration also retains the original stroke. The
                    // device rollers finish the inside segment; no long belt.
                }
            }
            entry.rig.applyLinked({...state,previewCharge:!this.plan.cart&&frame.step.deviceId===id})
            entry.effects?.apply({time:frame.elapsed,level:state.level,temperature:state.heat?55:25,fill:state.operation==='fill',heat:state.heat,spray:state.spray,ultrasonic:state.ultrasonic,drain:state.operation==='drain',blow:state.blow,wetness:state.level})
        }
        let adaptivePath
        if(this.mode==='site'&&cart?.savedLink?.cycle?.enabled&&['feed','retract','pickup_extend','reclaim'].includes(frame.step.kind)){
            const target=this.entries.get(frame.step.deviceId),dock=this.dock(target.row.id)
            adaptivePath=this.adaptivePathFor(cart,target,dock)
            const savedFraction=this.plan.transferMouthFractions?.[target.row.id]
            if(!Number.isFinite(savedFraction)||Math.abs(adaptivePath.mouthFraction-savedFraction)>1e-6||!sameAdaptiveTransferGeometry(adaptivePath,this.plan.transferPaths?.[target.row.id]))throw Error('承料路径已变化，请重新生成联动预览')
        }
        this.material.visible=!!frame.material.holder
        if(this.material.visible){
            const m=frame.material,point=id=>this.loadPort(id,id!==this.plan.cart?.id,frame.states[id])
            let p
            if(cart?.savedLink?.cycle?.enabled&&(m.cyclePath||m.holder===this.plan.cart.id)){
                const c=cart.savedLink.cycle,home=siteWorldPoint(new T.Vector3(...c.cartHome),cart.wrapper)
                p=home
                if(m.cyclePath){
                    const s=c.stations.find(s=>s.targetDeviceId===m.to),target=this.entries.get(m.to),node=target?.asset.getObjectByName(s?.seatNodeName||'')
                    if(!node)throw Error('缺少已配置设备内承料节点')
                    if(adaptivePath)p.fromArray(sampleAdaptiveTransferPath(adaptivePath,m.progress)).multiplyScalar(cart.sceneUnitsPerMeter)
                    else p.lerp(siteWorldPoint(new T.Vector3(...s.seatNodeLocal),node),m.progress)
                }
                const metrics=applySitePayloadMetrics(this.material,cart.wrapper,cart.savedLink.materialSize,cart.sceneUnitsPerMeter);p.y+=metrics.worldHeight*.5
            }else if(this.mode==='site'&&cart){
                const target=frame.cart.to,home=siteWorldPoint(cart.port,cart.wrapper),dock=target?this.dock(target):null
                const displacement=siteWorldVector(cart.siteDriveNode.position.clone().sub(cart.siteDriveRest),cart.siteDriveNode.parent)
                const destination=id=>{
                    const d=this.dock(id),local=siteParentPoint(d.worldPosition.clone().add(d.cartPortOffset).add(d.maximumDriveWorld),this.entries.get(id).wrapper)
                    const state=frame.states[id],station=this.entries.get(id)
                    if(state?.basket)local.y-=(station.rig.basketStroke||1.05)*state.basket
                    if(state?.lift)local.y+=.24*state.lift
                    return siteWorldPoint(local,station.wrapper)
                }
                if((['feed','reclaim'].includes(frame.step.kind)&&dock)||m.holder===this.plan.cart.id)p=home.add(displacement)
                else p=destination(m.holder)
                if(cart.savedLink){
                    if(!this.siteMaterialConfigured)throw Error('现场物料联动已启用，请重新加载预览以使用已配置的物料')
                    if(typeof cart.savedLink.materialColor!=='string'||!/^#[0-9a-f]{6}$/i.test(cart.savedLink.materialColor))throw Error('已配置的物料示意颜色无效')
                    const metrics=applySitePayloadMetrics(this.material,cart.wrapper,cart.savedLink.materialSize,cart.sceneUnitsPerMeter)
                    this.material.children[0].material.color.set(cart.savedLink.materialColor)
                    p.y+=metrics.worldHeight*.5
                }else if(this.siteMaterialConfigured){this.material.visible=false;return}
            }else if(cart?.rig.node?.('push_hook')&&['feed','retract','pickup_extend','reclaim'].includes(frame.step.kind)){
                // Normal demo: the hook pushes/pulls over its ORIGINAL stroke.
                // During empty-chain travel, the device's rollers carry the
                // tray between the handoff point and its inside bearing seat.
                // Both phases meet at the same point, including timeline seeks.
                const home=point(cart.row.id),drive=siteWorldVector(new T.Vector3(-CART_FEED.stroke,0,0),cart.wrapper)
                const extended=home.clone().add(drive),inside=point(frame.step.deviceId)
                const fraction=T.MathUtils.clamp(frame.progress,0,1),smooth=fraction*fraction*(3-2*fraction)
                if(frame.step.kind==='retract')p=extended.lerp(inside,smooth)
                else if(frame.step.kind==='pickup_extend')p=inside.lerp(extended,smooth)
                else p=home.addScaledVector(drive,frame.cart.feed)
            }else p=m.to&&m.progress<1?point(m.from).lerp(point(m.to),m.progress):point(m.holder)
            this.material.position.copy(this.mode==='site'?siteParentPoint(p,this.material.parent):p)
            if(!this.siteMaterialConfigured)this.material.rotation.y=cart?.wrapper.rotation.y||0
            this.material.updateWorldMatrix(true,true)
        }
    }
    focus(id){
        const entry=this.entries.get(id);if(!entry)return
        // Keep the chosen viewing direction and frame only this device, even when the cart is far away.
        const direction=this.camera.position.clone().sub(this.controls.target).normalize().toArray()
        this.frameNavigation(bounds(entry.wrapper),direction)
    }
    resetCamera(){
        this.frameNavigation(this.bounds,[.7,.55,1.2])
    }
    frameNavigation(box,direction){
        if(!box||box.isEmpty())return
        const b=box.clone().expandByScalar(.3),radius=b.getSize(new T.Vector3()).length()/2
        const pose=fitCameraBox({minX:b.min.x,maxX:b.max.x,minY:b.min.y,maxY:b.max.y,minZ:b.min.z,maxZ:b.max.z},{fov:this.camera.fov,aspect:this.camera.aspect,direction,margin:1.15})
        // Clear any drag inertia before an explicit navigation command.
        const damping=this.controls.enableDamping;this.controls.enableDamping=false;this.controls.update()
        this.controls.target.fromArray(pose.target);this.camera.position.fromArray(pose.position);this.camera.near=Math.max(.01,radius/1000);this.camera.far=Math.max(1000,(this.bounds?.getSize(new T.Vector3()).length()||radius)*100);this.camera.lookAt(this.controls.target);this.camera.updateProjectionMatrix();this.controls.update();this.controls.enableDamping=damping
    }
    dispose(){if(this.disposed)return;this.abort.abort();for(const e of this.entries.values()){e.rig.dispose();e.effects?.dispose()}super.dispose()}
}
