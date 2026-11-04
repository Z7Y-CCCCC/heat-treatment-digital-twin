import * as T from 'three'
import {CAD_MOTION_PROFILES,cadMotionFrame} from './cadMotionProfiles.js'
import {connectedGeometryParts} from './cadGeometryParts.js'
import {CART_FEED,locateCartChain,sampleCartChain} from './cartFeedMechanism.js'
import {CLEANER_BATH} from './cleanerBathLayout.js'
import {TRANSFER_DATUM,transferAuthoringY} from '../../../shared/equipmentTransferDatum.mjs'
import {buildLineSimulation,sampleLineSimulation} from './lineSimulation.js'

/** Temporary preview rig. Original GLB bytes and saved disassembly hierarchy stay unchanged. */
export class CadMotionRig {
    constructor(root,modelId){
        this.root=root;this.id=modelId;this.profile=CAD_MOTION_PROFILES[modelId]
        if(!this.profile)throw Error('此模型未配置动作')
        if(!root.getObjectByName(this.profile.prefix+'root'))throw Error('模型缺少已配置的 CAD 动作节点，请检查设备的模型文件。')
        root.updateMatrixWorld(true);this.joints={};this.retired=[];this.scissor=[];this.liftPins=[];this.rods=[]
        this.node=s=>root.getObjectByName(this.profile.prefix+s)
        this.transferAlignment=this.node('root').userData.transferAlignment
        this.authoringY=y=>this.transferAlignment?transferAuthoringY(this.id,y):y
        this.basketStroke=this.transferAlignment?.basketStroke||1.05
        this.cleanerLoadY=this.transferAlignment?TRANSFER_DATUM.loadY:CLEANER_BATH.loadY
        this.liftHeight=this.authoringY(.95)-this.authoringY(.14)
        this.prepareRollers();this.prepareSpecial();this.prepareEffects()
        this.baselines=[];root.traverse(o=>this.baselines.push({o,p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone(),visible:o.visible}))
    }
    parts(suffix){
        const node=this.node(suffix);if(!node)return []
        const meshes=[];node.traverse(o=>{if(o.isMesh)meshes.push(o)})
        return meshes.flatMap(mesh=>{const parts=connectedGeometryParts(mesh);mesh.removeFromParent();this.retired.push(mesh);return parts})
    }
    pivot(key,point,parts){
        const pivot=new T.Group();pivot.name='preview_'+key;pivot.position.copy(point);this.root.add(pivot);pivot.updateMatrixWorld(true)
        parts.forEach(part=>pivot.attach(part.mesh));this.joints[key]=pivot;return pivot
    }
    prepareRollers(){
        this.rollers=[]
        const owner=this.node('roller_bed');if(!owner)return
        const stainless=this.parts('roller_bed_stainless')
        // Roller sleeves are separate solids, even though Blender merged them by material.
        const bins=new Map()
        for(const part of stainless){const key=part.center.x.toFixed(3);if(!bins.has(key))bins.set(key,[]);bins.get(key).push(part)}
        for(const [key,parts] of bins){
            const c=parts[0].center.clone();c.z=0;const pivot=this.pivot('roller_'+key,c,parts)
            // A small cyan witness mark makes a rotationally symmetric roller's movement visible.
            const marker=new T.Mesh(new T.BoxGeometry(.007,.007,parts[0].size.z*.7),new T.MeshBasicMaterial({color:'#25bfe6'}))
            marker.name='preview_rotation_witness';marker.position.set(0,parts[0].size.x/2+.001,parts[0].center.z);pivot.add(marker)
            // The lift deck moves as one assembly. Keep each rotating roller
            // beneath that deck rather than leaving its pivot at the model root.
            if(this.id==='cad_lifting_load_table_111400')owner.attach(pivot)
            this.rollers.push(pivot)
        }
    }
    prepareSpecial(){
        if(this.id==='cad_transfer_cart_101300'){
            this.wheels=[];const parts=[...this.parts('travel_wheels_metal'),...this.parts('travel_wheels_steel'),...this.parts('travel_wheels_stainless')]
            for(const x of [-.7125,.7125])this.wheels.push(this.pivot('wheel_'+x,new T.Vector3(x,.148,0),parts.filter(p=>Math.abs(p.center.x-x)<.1)))
            const gear=this.node('feed_sprocket');if(gear){this.pivot('feed_gear',new T.Vector3(.806,1.16,0),[{mesh:gear}])}
            this.prepareCartChain()
        }
        if(this.id==='cad_air_cooling_table_115800ht'){
            this.fans=[];const parts=[...this.parts('fans_metal'),...this.parts('fans_stainless')]
            for(const x of [-.28,.28])this.fans.push(this.pivot('fan_'+x,new T.Vector3(x,1.035,0),parts.filter(p=>Math.sign(p.center.x)===Math.sign(x))))
        }
        if(this.id==='cad_water_cooling_tank_471000'){
            const parts=this.parts('agitator_stainless');this.pivot('agitator',new T.Vector3(.75,this.authoringY(.72),0),parts)
        }
        if(this.id==='cad_cleaner_170700'){
            this.pumpShafts=this.parts('pumps_stainless').map((p,i)=>this.pivot('pump_'+i,p.center,[p]))
        }
        if(this.id==='cad_multipurpose_furnace_082000')this.prepareMultipurpose()
        if(this.id==='cad_tempering_furnace_091300')this.prepareTempering()
        if(this.id==='cad_lifting_load_table_111400')this.prepareLift()
    }
    prepareTempering(){
        // The author merged solids by material: bearings and motor housings
        // remain in their original groups while the actual rotors are split out.
        const blades=this.parts('internal_fan_metal'),shaft=this.parts('internal_fan_stainless')
        const rollers=this.parts('internal_rollers_stainless')
        if(blades.length!==8||shaft.length!==1||rollers.length!==7)throw Error('回火炉叶轮或辊筒节点与动作配置不匹配，请检查模型文件。')
        this.temperingFan=this.pivot('tempering_impeller',new T.Vector3(0,this.authoringY(1.96),-.1544),[...blades,...shaft])
        this.temperingDriveShafts=this.parts('circulation_fan_stainless').map((part,index)=>({
            pivot:this.pivot('tempering_drive_'+index,part.center,[part]),axis:part.size.x>part.size.y?'x':'y'
        }))
        this.temperingRollers=rollers.map((part,index)=>{
            const pivot=this.pivot('tempering_roller_'+index,part.center,[part])
            const marker=new T.Mesh(new T.BoxGeometry(.35,.005,.008),new T.MeshBasicMaterial({color:'#25bfe6'}))
            marker.name='preview_rotation_witness';marker.position.y=part.size.y/2+.001;pivot.add(marker)
            return pivot
        })
        this.heatMaterials=[]
        this.node('heating_elements').traverse(node=>{
            if(!node.isMesh)return
            const materials=[].concat(node.material).map(material=>{
                const clone=material.clone()
                this.heatMaterials.push({material:clone,emissive:clone.emissive.clone(),intensity:clone.emissiveIntensity})
                return clone
            })
            node.material=Array.isArray(node.material)?materials:materials[0]
        })
    }
    setTemperingFanAngle(angle){
        this.temperingFan.rotation.y=angle
        for(const {pivot,axis} of this.temperingDriveShafts)pivot.rotation[axis]=angle
    }
    prepareCartChain(){
        const rollers=this.parts('return_chain_stainless'),metal=this.parts('return_chain_metal'),steel=this.parts('return_chain_steel')
        const centers=rollers.filter(p=>Math.abs(p.center.z-.038)<.001&&Math.abs(p.size.z-.027)<.002&&Math.abs(p.size.x-.022)<.002)
        if(centers.length!==42)throw Error('料车回链节点与已配置轨迹不匹配')
        const all=[...rollers,...metal,...steel];this.cartChain=[]
        centers.forEach((roller,index)=>{
            const center=roller.center.clone();center.z=.038
            const pieces=all.filter(p=>Math.hypot(p.center.x-center.x,p.center.y-center.y)<.002&&p.center.z>.01&&p.size.x<.055&&p.size.y<.055&&p.size.z<.055)
            if(pieces.length!==4)throw Error('料车链节应包含两片侧板、滚子和销轴')
            const at=locateCartChain(center.x,center.y)
            if(at.error>.0001)throw Error('料车链节偏离回链轨迹')
            const pivot=this.pivot('return_link_'+index,center,pieces);this.cartChain.push({pivot,distance:at.distance,angle:at.angle})
        })
    }
    setCartFeed(progress,travel=CART_FEED.stroke,engaged=true){
        const distance=progress*travel
        this.move(this.node('feed_carriage')?'feed_carriage':'pusher','x',-progress*travel)
        const latch=this.node('hook_latch');if(latch)latch.rotation.z=-.65*(1-Number(engaged))
        this.joints.feed_gear.rotation.z=distance/CART_FEED.sprocketRadius
        this.cartChain.forEach(({pivot,distance:phase,angle})=>{const at=sampleCartChain(phase+distance);pivot.position.fromArray(at.position);pivot.rotation.z=at.angle-angle})
    }
    prepareMultipurpose(){
        this.processPlan=buildLineSimulation([{id:'demo_cart',model_type:'transfer_cart'},{id:'demo_furnace',model_type:this.id}],[{id:this.id,file_path:'/preview-only.glb'}])
        const impeller=this.parts('circulation_impeller_metal'),shaft=this.parts('circulation_impeller_stainless')
        this.multiCirculation=this.pivot('hot_circulation',new T.Vector3(0,this.authoringY(2.565),-3.015),[...impeller.filter(p=>p.size.y<.15),...shaft])
        const blades=this.parts('agitator_impellers'),shafts=this.parts('agitators_stainless').filter(p=>p.size.y>1&&p.size.x<.12&&p.size.z<.12)
        this.multiAgitators=[-1.005,1.005].map((x,i)=>this.pivot('quench_agitator_'+i,new T.Vector3(x,this.authoringY(.4),-1.03),[...blades,...shafts].filter(p=>Math.sign(p.center.x)===Math.sign(x))))
        this.hotRollers=this.parts('hot_rollers_stainless').map((p,i)=>{
            const pivot=this.pivot('hot_roller_'+i,p.center,[p]),mark=new T.Mesh(new T.BoxGeometry(p.size.x*.7,.006,.006),new T.MeshBasicMaterial({color:'#24badc'}))
            mark.position.y=p.size.y/2+.001;pivot.add(mark);return pivot
        })
        this.heatMaterials=[]
        this.node('radiant_tubes')?.traverse(o=>{if(!o.isMesh)return;const materials=[].concat(o.material).map(m=>{const c=m.clone();this.heatMaterials.push({material:c,emissive:c.emissive.clone(),intensity:c.emissiveIntensity});return c});o.material=Array.isArray(o.material)?materials:materials[0]})
    }
    prepareLift(){
        for(const part of this.parts('lift_edge')){
            // Determine the original slope from covariance; keep each rigid arm's length.
            const a=part.mesh.geometry.attributes.position,v=new T.Vector3();let covariance=0
            for(let i=0;i<a.count;i++){v.fromBufferAttribute(a,i).applyMatrix4(part.mesh.matrixWorld).sub(part.center);covariance+=v.x*v.y}
            const sign=Math.sign(covariance),pivot=this.pivot('scissor_'+this.scissor.length,part.center,[part]);this.scissor.push({pivot,sign})
        }
        this.liftPins=[...this.parts('lift_stainless'),...this.parts('pivot_detail'),...this.parts('slide_detail')].map((p,i)=>({pivot:this.pivot('lift_pin_'+i,p.center,[p]),fraction:T.MathUtils.clamp((p.center.y-this.authoringY(.14))/this.liftHeight,0,1)}))
        this.topSupports=this.node('lift_steel')
        const bodyParts=this.parts('hydraulics_teal'),rodParts=this.parts('hydraulics_stainless')
        this.hydraulicDeck=[]
        for(const p of this.parts('hydraulics_metal')){
            if(p.center.y>.9)this.hydraulicDeck.push(this.pivot('hydraulic_deck_'+this.hydraulicDeck.length,p.center,[p]))
            else if(p.center.y>.5)rodParts.push(p)
        }
        for(const p of this.parts('hydraulics_brass')){
            if(p.center.y>.9)this.hydraulicDeck.push(this.pivot('hydraulic_deck_'+this.hydraulicDeck.length,p.center,[p]))
            else bodyParts.push(p)
        }
        this.cylinderBase=new T.Vector3(.48,this.authoringY(.16),0);this.cylinderVector=new T.Vector3(-.45,this.authoringY(.83)-this.authoringY(.16),0)
        this.cylinder=this.pivot('cylinder',this.cylinderBase,bodyParts);this.rod=this.pivot('cylinder_rod',this.cylinderBase,rodParts)
    }
    prepareEffects(){
        this.effects=new T.Group();this.effects.name='preview_process_effects';this.root.add(this.effects)
        const waterMat=new T.MeshStandardMaterial({color:'#29b8df',transparent:true,opacity:.48,roughness:.2,depthWrite:false,side:T.DoubleSide})
        this.water=new T.Mesh(new T.BoxGeometry(1,1,1),waterMat);this.water.visible=false;this.effects.add(this.water)
        const water=this.id==='cad_water_cooling_tank_471000'
        this.fluid={x:water ? -.32 : 0,z:water ? 0 : -.75,w:water ? .72 : 1.5,d:water ? 1.04 : 1.05,min:.20,max:water ? 1.40 : 1.1}
        if(water&&this.transferAlignment){this.fluid.min=this.authoringY(.20);this.fluid.max=this.authoringY(1.32)}
        const oil=this.id==='cad_multipurpose_furnace_082000'
        this.dropMaterial=oil
            ? new T.MeshStandardMaterial({name:'preview_quench_oil',color:'#99591f',roughness:.16,metalness:.05,transparent:true,opacity:.92,depthWrite:false})
            : new T.MeshBasicMaterial({color:'#49c9ef',transparent:true,opacity:.9})
        this.drops=new T.Group();this.effects.add(this.drops);this.drops.visible=false
        this.nozzles=[]
        if(this.id==='cad_cleaner_170700'){
            const nodes=this.parts('spray_headers_brass');this.nozzles=nodes.map(p=>p.center.clone())
            const bath=CLEANER_BATH,h=bath.surfaceY-bath.floorY
            this.fluid={...bath.volumes[0],min:bath.floorY,max:bath.surfaceY}
            this.bathVolumes=bath.volumes.map((v,i)=>{
                const volume=i===0?this.water:new T.Mesh(this.water.geometry,this.water.material)
                volume.name='preview_cleaner_bath_'+v.name;volume.visible=true
                volume.scale.set(v.w,h,v.d);volume.position.set(v.x,bath.floorY+h/2,v.z)
                if(i)this.effects.add(volume);return volume
            })
            this.water.material.opacity=.32
            this.cleanerCharge=new T.Group();this.cleanerCharge.name='preview_cleaner_charge';this.cleanerCharge.visible=false;this.effects.add(this.cleanerCharge)
            const pallet=new T.Mesh(new T.BoxGeometry(.55,.08,.4),new T.MeshStandardMaterial({color:'#dca34f',metalness:.5,roughness:.4}));this.cleanerCharge.add(pallet)
            for(let i=0;i<3;i++){const billet=new T.Mesh(new T.CylinderGeometry(.075,.075,.24,16),new T.MeshStandardMaterial({color:'#8eaeb8',metalness:.7}));billet.position.set((i-1)*.15,.16,0);this.cleanerCharge.add(billet)}
            this.cleanerCharge.position.set(0,this.cleanerLoadY,0)
        }
        const geometry=oil
            ? new T.LatheGeometry([[0,-.016],[.008,-.013],[.012,-.005],[.01,.006],[.004,.018],[0,.028]].map(([x,y])=>new T.Vector2(x,y)),12)
            : new T.SphereGeometry(.012,6,4)
        for(let i=0;i<60;i++){
            const drop=new T.Mesh(geometry,this.dropMaterial)
            if(oil)drop.name='preview_oil_drop_'+i
            this.drops.add(drop)
        }
        this.flow=new T.Group();this.effects.add(this.flow);this.flow.visible=false
        for(const from of this.nozzles){const to=from.clone();to.x*=.18;to.y-=.08;const line=new T.Line(new T.BufferGeometry().setFromPoints([from,to]),new T.LineBasicMaterial({color:'#54ccef',transparent:true,opacity:.35}));this.flow.add(line)}
        if(this.id==='cad_multipurpose_furnace_082000'){
            this.fluid={x:0,z:-.985,w:1.04,d:1.7,min:this.authoringY(.2),max:this.authoringY(1.31)}
            this.water.material.color.set('#8b531d');this.water.material.opacity=.32;this.water.material.roughness=.18;this.showWater(1)
            this.node('quench_liquid')?.traverse(node=>{if(!node.isMesh)return;const mats=[].concat(node.material).map(m=>{const c=m.clone();c.color.set('#8b531d');return c});node.material=Array.isArray(node.material)?mats:mats[0]})
            this.oilSites=[[-.27,-.45],[.27,.45],[.27,-.45],[-.27,.45],[-.27,0],[.27,0],[-.09,-.48],[.12,.48]]
            this.oilFilaments=new T.Group();this.oilFilaments.name='preview_oil_filaments';this.oilFilaments.visible=false;this.effects.add(this.oilFilaments)
            const threadGeometry=new T.CylinderGeometry(.0025,.0045,1,7)
            this.oilSites.forEach((_,i)=>{const thread=new T.Mesh(threadGeometry,this.dropMaterial);thread.name='preview_oil_filament_'+i;this.oilFilaments.add(thread)})
            this.charge=new T.Mesh(new T.BoxGeometry(.54,.28,1.0),new T.MeshStandardMaterial({color:'#c79143',metalness:.5}));this.charge.name='preview_internal_charge';this.charge.position.set(0,this.authoringY(1.81),-.985);this.charge.visible=false;this.effects.add(this.charge)
            this.cyclePallet=new T.Mesh(new T.BoxGeometry(.56,.08,1.04),new T.MeshStandardMaterial({color:'#8b9499',metalness:.7,roughness:.35}));this.cyclePallet.name='preview_cycle_pallet';this.cyclePallet.position.y=-.18;this.cyclePallet.visible=false;this.charge.add(this.cyclePallet)
            this.ripples=new T.Group();this.ripples.visible=false;this.effects.add(this.ripples)
            for(let i=0;i<3;i++){const ring=new T.Mesh(new T.TorusGeometry(.22,.004,6,40),new T.MeshBasicMaterial({color:'#d4a05c',transparent:true,opacity:.5}));ring.rotation.x=Math.PI/2;ring.position.set(0,this.fluid.max+.013,-.985);this.ripples.add(ring)}
        }
        this.bounds=new T.Box3().setFromObject(this.root)
    }
    reset(){for(const {o,p,q,s,visible} of this.baselines){o.position.copy(p);o.quaternion.copy(q);o.scale.copy(s);o.visible=visible}this.heatMaterials?.forEach(({material,emissive,intensity})=>{material.emissive.copy(emissive);material.emissiveIntensity=intensity})}
    move(name,axis,offset){const n=this.node(name);if(n)n.position[axis]+=offset}
    apply(actionId,time){
        if(actionId==='process_cycle')return this.applyProcessCycle(time)
        this.reset();const f=cadMotionFrame(this.id,actionId,time),s=f.amount,t=f.elapsed,angle=t*Math.PI*2
        if(actionId==='travel'){this.root.position.x+=s*.8;this.wheels.forEach(n=>n.rotation.z=-s*.8/.13)}
        if(actionId==='feed')this.setCartFeed(s,CART_FEED.stroke,f.progress<=.5)
        if(actionId==='hook'){const latch=this.node('hook_latch');if(latch)latch.rotation.z=-s*.65}
        if(actionId==='rollers')this.rollers.forEach(n=>n.rotation.z=angle*.6)
        if(actionId==='rollers')this.temperingRollers?.forEach(n=>n.rotation.x=-angle*.6)
        if(actionId==='fans')this.fans.forEach(n=>n.rotation.y=angle*2)
        if(actionId==='agitator'){
            if(this.multiAgitators){this.multiAgitators.forEach(n=>n.rotation.y=angle*1.5);this.showQuench(t)}
            else this.joints.agitator.rotation.y=angle*1.5
        }
        if(actionId==='circulation'||actionId==='heating'){
            if(this.temperingFan)this.setTemperingFanAngle(angle*1.5)
            else this.multiCirculation.rotation.y=angle*1.5
        }
        if(actionId==='heating')this.showHeat(true)
        if(actionId==='hot_rollers')this.hotRollers.forEach(n=>n.rotation.x=angle*.6)
        if(actionId==='gate')this.move('intermediate_gate','y',.85*s)
        if(actionId==='internal_transfer'){
            const p=f.progress,gate=p<.2?p/.2:p>.8?(1-p)/.2:1
            const q=p<.2?0:p<.5?(p-.2)/.3:p<.8?1-(p-.5)/.3:0,travel=q*q*(3-2*q)
            this.move('intermediate_gate','y',.85*gate);this.charge.visible=true;this.charge.position.z=-.985-2.065*travel
            this.hotRollers.forEach(n=>n.rotation.x=-travel*2.065/.039)
        }
        if(actionId==='pumps'||actionId==='spray')this.pumpShafts?.forEach(n=>n.rotation.y=angle*2)
        if(actionId==='door'){
            // Air-table GLB is authored with its door raised at Y=2.53;
            // -0.90 returns its centre to the loading-mouth height (~1.63 m).
            const air=this.id==='cad_air_cooling_table_115800ht',offset=air ? -.90*s : .90*s
            this.move('door','y',offset);this.move('door_carriages','y',offset)
        }
        if(actionId==='lift_up'||actionId==='lift_down')this.applyLift(this.liftHeight+(actionId==='lift_up' ? .24 : -.24)*s)
        if(actionId==='basket_down'||actionId==='basket_up'){
            const down=actionId==='basket_down'?s:1-s,multi=this.id==='cad_multipurpose_furnace_082000',cleaner=this.id==='cad_cleaner_170700'
            if(cleaner)this.setCleanerBasket(down,true)
            else this.move(multi?'elevator_basket':'basket','y',-this.basketStroke*down)
            if(!multi&&!cleaner)this.showWater(1)
            else if(multi){this.charge.visible=true;this.charge.position.y=this.authoringY(1.81)-this.basketStroke*down}
            if(actionId==='basket_up'&&!cleaner)this.showDrips(t,this.authoringY(multi?1.44:1.58)-down*this.basketStroke)
        }
        if(actionId==='fill'||actionId==='drain'){
            const level=actionId==='fill'?f.progress:1-f.progress;this.showWater(level)
            this.showDrips(t,actionId==='fill'?1.4:.35,actionId==='drain')
        }
        if(actionId==='spray'||actionId==='blow')this.showJets(t,actionId==='blow')
        if(this.id==='cad_cleaner_170700'&&['spray','blow'].includes(actionId))this.setCleanerBasket(actionId==='spray'?1:0,true)
        this.root.updateMatrixWorld(true);return f
    }
    applyLift(height){
        const delta=height-this.liftHeight,length=Math.hypot(1.3,this.liftHeight),span=Math.sqrt(length*length-height*height),ratio=span/1.3
        for(const {pivot,sign} of this.scissor){pivot.position.y+=delta/2;pivot.rotation.z=sign*(Math.atan2(height,span)-Math.atan2(this.liftHeight,1.3))}
        for(const {pivot,fraction} of this.liftPins){pivot.position.y+=delta*fraction;pivot.position.x*=ratio}
        for(const name of ['roller_bed','roller_details','stop_detail'])this.move(name,'y',delta)
        if(this.topSupports)this.topSupports.position.y+=delta
        this.hydraulicDeck.forEach(pivot=>{pivot.position.y+=delta})
        const b=new T.Vector3(.03*ratio,this.authoringY(.14)+(this.authoringY(.83)-this.authoringY(.14))/this.liftHeight*height,0),direction=b.sub(this.cylinderBase),q=new T.Quaternion().setFromUnitVectors(this.cylinderVector.clone().normalize(),direction.clone().normalize())
        this.cylinder.quaternion.copy(q);this.rod.quaternion.copy(q)
        this.rod.position.add(direction.clone().normalize().multiplyScalar(direction.length()-this.cylinderVector.length()))
    }
    applyLinked(state={}){
        this.reset()
        const s={door:0,feed:0,basket:0,lift:0,level:0,run:false,runTime:0,circulationTime:0,conveyTime:0,time:0,...state},angle=s.runTime*Math.PI*2
        const air=this.id==='cad_air_cooling_table_115800ht'
        for(const name of ['door','door_carriages'])this.move(name,'y',air ? -.9*(1-s.door) : .9*s.door)
        if(this.id==='cad_transfer_cart_101300'){
            this.setCartFeed(s.feed,s.feedTravel??CART_FEED.stroke,s.hookEngaged??true)
            this.wheels.forEach(n=>n.rotation.z=-(s.travel||0)/.13)
        }
        this.rollers.forEach(n=>n.rotation.z=angle*.6)
        this.fans?.forEach(n=>n.rotation.y=angle*2)
        if(this.joints.agitator)this.joints.agitator.rotation.y=angle*1.5
        this.pumpShafts?.forEach(n=>n.rotation.y=angle*2)
        if(this.scissor.length)this.applyLift(this.liftHeight+.24*s.lift)
        this.move('basket','y',-this.basketStroke*s.basket)
        if(this.id==='cad_cleaner_170700')this.setCleanerBasket(s.basket,!!s.previewCharge)
        if(this.id==='cad_tempering_furnace_091300'){
            this.setTemperingFanAngle(s.circulationTime*Math.PI*3)
            this.temperingRollers.forEach(node=>node.rotation.x=-s.conveyTime*Math.PI*1.2)
            this.showHeat(s.heat)
        }
        if(this.id==='cad_multipurpose_furnace_082000'){
            this.move('intermediate_gate','y',.85*(s.gate||0));this.move('elevator_basket','y',-this.basketStroke*s.basket)
            this.multiCirculation.rotation.y=(s.circulationTime||0)*Math.PI*3
            this.multiAgitators.forEach(n=>n.rotation.y=(s.stirTime||0)*Math.PI*3)
            this.hotRollers.forEach(n=>n.rotation.x=(s.conveyTime||0)*Math.PI*1.2)
            if(s.operation==='quench')this.showQuench(s.time)
            this.showHeat(s.heat)
            if(s.previewCharge){this.charge.visible=true;this.charge.position.set(0,(this.transferAlignment?TRANSFER_DATUM.loadY+.18:this.authoringY(1.81))-this.basketStroke*s.basket,-.985-2.065*(s.chamber||0));this.cyclePallet.visible=true}
        }
        if(this.id==='cad_cleaner_170700'||this.id==='cad_multipurpose_furnace_082000')this.showWater(1)
        else if(this.id==='cad_water_cooling_tank_471000'||s.level>0||['fill','drain'].includes(s.operation))this.showWater(s.level)
        if(s.spray||s.blow)this.showJets(s.time,s.blow)
        if(s.drip)this.showDrips(s.time,this.authoringY(this.oilSites?1.44:1.58)-s.basket*this.basketStroke)
        this.root.updateMatrixWorld(true)
    }
    applyProcessCycle(time){
        const f=cadMotionFrame(this.id,'process_cycle',time),frame=sampleLineSimulation(this.processPlan,f.elapsed),state=frame.states.demo_furnace
        this.applyLinked({...state,operation:frame.step.kind})
        const height=this.transferAlignment?TRANSFER_DATUM.loadY+.18:this.authoringY(1.81)
        const point=id=>id==='demo_cart'?new T.Vector3(0,height,1.05):new T.Vector3(0,height-this.basketStroke*state.basket,-.985-2.065*state.chamber)
        const m=frame.material,p=m.to&&m.progress<1?point(m.from).lerp(point(m.to),m.progress):point(m.holder)
        this.charge.visible=true;this.cyclePallet.visible=true;this.charge.position.copy(p)
        this.root.updateMatrixWorld(true)
        return {...f,stage:frame.step.label}
    }
    setCleanerBasket(amount,charge=false){
        const offset=-CLEANER_BATH.stroke*T.MathUtils.clamp(amount,0,1)
        this.move('internal_rollers','y',offset)
        this.cleanerCharge.visible=charge;this.cleanerCharge.position.y=this.cleanerLoadY+offset
    }
    showWater(level){const v=this.fluid,h=Math.max(.008,(v.max-v.min)*(this.bathVolumes?1:level));this.water.visible=true;this.water.scale.set(v.w,h,v.d);this.water.position.set(v.x,v.min+h/2,v.z)}
    showQuench(time){this.ripples.visible=true;this.ripples.children.forEach((ring,i)=>{const phase=(time*.6+i/3)%1;ring.scale.setScalar(.3+phase*1.3);ring.material.opacity=(1-phase)*.7})}
    showHeat(on){if(on)this.heatMaterials.forEach(({material})=>{material.emissive.set('#b94c12');material.emissiveIntensity=.9})}
    showDrips(t,height,drain=false){
        if(this.oilSites&&!drain){this.showOilDrips(t,height);return}
        this.drops.visible=true;this.dropMaterial.color.set('#49c9ef')
        this.drops.children.forEach((drop,i)=>{const fall=(t*.85+i*.113)%1;drop.position.set(drain ? .55 : this.fluid.x+(i%10-4.5)*.055,height-fall*(drain ? .26 : .25),drain ? .9 : (Math.floor(i/10)-2.5)*.10)})
    }
    showOilDrips(t,height){
        // Oil forms a bead and a thinning neck before detaching. Emit from the
        // raised basket's underside, over the oil bath rather than inside its rollers.
        const above=height>this.fluid.max+.035,count=Math.max(2,Math.ceil(this.oilSites.length*Math.exp(-Math.max(0,t)*.19)))
        this.drops.visible=above;this.oilFilaments.visible=above
        this.drops.children.forEach((drop,i)=>{
            drop.visible=false;if(!above||i>=count)return
            const [x,z]=this.oilSites[i],phase=(t/(1.65+(i%3)*.31)+i*.173)%1
            const falling=Math.max(0,(phase-.45)/.55),formed=Math.min(1,phase/.45)
            const sy=falling>0?1.1+.45*falling:.3+.8*formed,wide=falling>0?.82:.4+.42*formed
            drop.scale.set(wide,sy,wide)
            drop.position.set(this.fluid.x+x,height-.028*sy-.4*falling*falling,this.fluid.z+z)
            drop.visible=drop.position.y-.016*sy>this.fluid.max+.004
        })
        this.oilFilaments.children.forEach((thread,i)=>{
            thread.visible=false;if(!above||i>=count)return
            const [x,z]=this.oilSites[i],phase=(t/(1.65+(i%3)*.31)+i*.173)%1
            const length=Math.min(height-this.fluid.max-.015,.012+.15*Math.pow(Math.min(1,phase/.58),1.6))
            const neck=phase<.45?1:Math.max(.1,(.58-phase)/.13)
            thread.visible=phase>.18&&phase<.58;thread.scale.set(neck,length,neck)
            thread.position.set(this.fluid.x+x,height-length/2,this.fluid.z+z)
        })
    }
    showJets(t,air){
        this.flow.visible=!air;this.drops.visible=true;this.dropMaterial.color.set(air?'#c4eaff':'#49c9ef')
        this.drops.children.forEach((drop,i)=>{const from=this.nozzles[i%this.nozzles.length],k=(t*1.7+Math.floor(i/this.nozzles.length)*.17)%1;drop.position.copy(from);drop.position.x*=1-k*.85;drop.position.y-=k*.08;drop.scale.setScalar(air ? .6 : 1)})
    }
    dispose(){for(const mesh of this.retired)mesh.geometry.dispose()}
}
