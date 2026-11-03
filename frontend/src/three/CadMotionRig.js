import * as T from 'three'
import {CAD_MOTION_PROFILES,cadMotionFrame} from './cadMotionProfiles.js'
import {connectedGeometryParts} from './cadGeometryParts.js'

/** Temporary preview rig. Original GLB bytes and saved disassembly hierarchy stay unchanged. */
export class CadMotionRig {
    constructor(root,modelId){
        this.root=root;this.id=modelId;this.profile=CAD_MOTION_PROFILES[modelId]
        if(!this.profile)throw Error('此模型未配置动作')
        if(!root.getObjectByName(this.profile.prefix+'root'))throw Error('模型缺少已配置的 CAD 动作节点，请检查设备的模型文件。')
        root.updateMatrixWorld(true);this.joints={};this.retired=[];this.scissor=[];this.liftPins=[];this.rods=[]
        this.node=s=>root.getObjectByName(this.profile.prefix+s)
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
            this.rollers.push(pivot)
        }
    }
    prepareSpecial(){
        if(this.id==='cad_transfer_cart_101300'){
            this.wheels=[];const parts=[...this.parts('travel_wheels_metal'),...this.parts('travel_wheels_steel'),...this.parts('travel_wheels_stainless')]
            for(const x of [-.7125,.7125])this.wheels.push(this.pivot('wheel_'+x,new T.Vector3(x,.148,0),parts.filter(p=>Math.abs(p.center.x-x)<.1)))
            const gear=this.node('feed_sprocket');if(gear){this.pivot('feed_gear',new T.Vector3(.806,1.16,0),[{mesh:gear}])}
        }
        if(this.id==='cad_air_cooling_table_115800ht'){
            this.fans=[];const parts=[...this.parts('fans_metal'),...this.parts('fans_stainless')]
            for(const x of [-.28,.28])this.fans.push(this.pivot('fan_'+x,new T.Vector3(x,1.035,0),parts.filter(p=>Math.sign(p.center.x)===Math.sign(x))))
        }
        if(this.id==='cad_water_cooling_tank_471000'){
            const parts=this.parts('agitator_stainless');this.pivot('agitator',new T.Vector3(.75,.72,0),parts)
        }
        if(this.id==='cad_cleaner_170700'){
            this.pumpShafts=this.parts('pumps_stainless').map((p,i)=>this.pivot('pump_'+i,p.center,[p]))
        }
        if(this.id==='cad_multipurpose_furnace_082000')this.prepareMultipurpose()
        if(this.id==='cad_lifting_load_table_111400')this.prepareLift()
    }
    prepareMultipurpose(){
        const impeller=this.parts('circulation_impeller_metal'),shaft=this.parts('circulation_impeller_stainless')
        this.multiCirculation=this.pivot('hot_circulation',new T.Vector3(0,2.565,-3.015),[...impeller.filter(p=>p.size.y<.15),...shaft])
        const blades=this.parts('agitator_impellers'),shafts=this.parts('agitators_stainless').filter(p=>p.size.y>1&&p.size.x<.12&&p.size.z<.12)
        this.multiAgitators=[-1.005,1.005].map((x,i)=>this.pivot('quench_agitator_'+i,new T.Vector3(x,.4,-1.03),[...blades,...shafts].filter(p=>Math.sign(p.center.x)===Math.sign(x))))
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
        this.liftPins=[...this.parts('lift_stainless'),...this.parts('pivot_detail'),...this.parts('slide_detail')].map((p,i)=>({pivot:this.pivot('lift_pin_'+i,p.center,[p]),fraction:T.MathUtils.clamp((p.center.y-.14)/.81,0,1)}))
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
        this.cylinderBase=new T.Vector3(.48,.16,0);this.cylinderVector=new T.Vector3(-.45,.67,0)
        this.cylinder=this.pivot('cylinder',this.cylinderBase,bodyParts);this.rod=this.pivot('cylinder_rod',this.cylinderBase,rodParts)
    }
    prepareEffects(){
        this.effects=new T.Group();this.effects.name='preview_process_effects';this.root.add(this.effects)
        const waterMat=new T.MeshStandardMaterial({color:'#29b8df',transparent:true,opacity:.48,roughness:.2,depthWrite:false,side:T.DoubleSide})
        this.water=new T.Mesh(new T.BoxGeometry(1,1,1),waterMat);this.water.visible=false;this.effects.add(this.water)
        const water=this.id==='cad_water_cooling_tank_471000'
        this.fluid={x:water ? -.32 : 0,z:water ? 0 : -.75,w:water ? .72 : 1.5,d:water ? 1.04 : 1.05,min:.20,max:water ? 1.40 : 1.1}
        this.dropMaterial=new T.MeshBasicMaterial({color:'#49c9ef',transparent:true,opacity:.9})
        this.drops=new T.Group();this.effects.add(this.drops);this.drops.visible=false
        this.nozzles=[]
        if(this.id==='cad_cleaner_170700'){
            const nodes=this.parts('spray_headers_brass');this.nozzles=nodes.map(p=>p.center.clone())
        }
        const geometry=new T.SphereGeometry(.012,6,4)
        for(let i=0;i<60;i++)this.drops.add(new T.Mesh(geometry,this.dropMaterial))
        this.flow=new T.Group();this.effects.add(this.flow);this.flow.visible=false
        for(const from of this.nozzles){const to=from.clone();to.x*=.18;to.y-=.08;const line=new T.Line(new T.BufferGeometry().setFromPoints([from,to]),new T.LineBasicMaterial({color:'#54ccef',transparent:true,opacity:.35}));this.flow.add(line)}
        if(this.id==='cad_multipurpose_furnace_082000'){
            this.fluid={x:0,z:-.985,w:1.04,d:1.7,min:.2,max:1.31}
            this.charge=new T.Mesh(new T.BoxGeometry(.54,.28,1.0),new T.MeshStandardMaterial({color:'#c79143',metalness:.5}));this.charge.name='preview_internal_charge';this.charge.position.set(0,1.81,-.985);this.charge.visible=false;this.effects.add(this.charge)
            this.ripples=new T.Group();this.ripples.visible=false;this.effects.add(this.ripples)
            for(let i=0;i<3;i++){const ring=new T.Mesh(new T.TorusGeometry(.22,.004,6,40),new T.MeshBasicMaterial({color:'#7ec9d1',transparent:true,opacity:.7}));ring.rotation.x=Math.PI/2;ring.position.set(0,1.323,-.985);this.ripples.add(ring)}
        }
        this.bounds=new T.Box3().setFromObject(this.root)
    }
    reset(){for(const {o,p,q,s,visible} of this.baselines){o.position.copy(p);o.quaternion.copy(q);o.scale.copy(s);o.visible=visible}this.heatMaterials?.forEach(({material,emissive,intensity})=>{material.emissive.copy(emissive);material.emissiveIntensity=intensity})}
    move(name,axis,offset){const n=this.node(name);if(n)n.position[axis]+=offset}
    apply(actionId,time){
        this.reset();const f=cadMotionFrame(this.id,actionId,time),s=f.amount,t=f.elapsed,angle=t*Math.PI*2
        if(actionId==='travel'){this.root.position.x+=s*.8;this.wheels.forEach(n=>n.rotation.z=-s*.8/.13)}
        if(actionId==='feed'){this.move('pusher','x',s*.5);this.joints.feed_gear.rotation.z=-s*6}
        if(actionId==='rollers')this.rollers.forEach(n=>n.rotation.z=angle*.6)
        if(actionId==='fans')this.fans.forEach(n=>n.rotation.y=angle*2)
        if(actionId==='agitator'){
            if(this.multiAgitators){this.multiAgitators.forEach(n=>n.rotation.y=angle*1.5);this.showQuench(t)}
            else this.joints.agitator.rotation.y=angle*1.5
        }
        if(actionId==='circulation'||actionId==='heating')this.multiCirculation.rotation.y=angle*1.5
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
        if(actionId==='lift_up'||actionId==='lift_down')this.applyLift(.81+(actionId==='lift_up' ? .24 : -.24)*s)
        if(actionId==='basket_down'||actionId==='basket_up'){
            const down=actionId==='basket_down'?s:1-s,multi=this.id==='cad_multipurpose_furnace_082000';this.move(multi?'elevator_basket':'basket','y',-1.05*down)
            if(!multi)this.showWater(1)
            else{this.charge.visible=true;this.charge.position.y=1.81-1.05*down}
            if(actionId==='basket_up')this.showDrips(t,1.58-down*1.05)
        }
        if(actionId==='fill'||actionId==='drain'){
            const level=actionId==='fill'?f.progress:1-f.progress;this.showWater(level)
            this.showDrips(t,actionId==='fill'?1.4:.35,actionId==='drain')
        }
        if(actionId==='spray'||actionId==='blow')this.showJets(t,actionId==='blow')
        this.root.updateMatrixWorld(true);return f
    }
    applyLift(height){
        const delta=height-.81,length=Math.hypot(1.3,.81),span=Math.sqrt(length*length-height*height),ratio=span/1.3
        for(const {pivot,sign} of this.scissor){pivot.position.y+=delta/2;pivot.rotation.z=sign*(Math.atan2(height,span)-Math.atan2(.81,1.3))}
        for(const {pivot,fraction} of this.liftPins){pivot.position.y+=delta*fraction;pivot.position.x*=ratio}
        for(const name of ['roller_bed','roller_details','stop_detail'])this.move(name,'y',delta)
        if(this.topSupports)this.topSupports.position.y+=delta
        this.hydraulicDeck.forEach(pivot=>{pivot.position.y+=delta})
        const b=new T.Vector3(.03*ratio,.14+(.83-.14)/.81*height,0),direction=b.sub(this.cylinderBase),q=new T.Quaternion().setFromUnitVectors(this.cylinderVector.clone().normalize(),direction.clone().normalize())
        this.cylinder.quaternion.copy(q);this.rod.quaternion.copy(q)
        this.rod.position.add(direction.clone().normalize().multiplyScalar(direction.length()-this.cylinderVector.length()))
    }
    applyLinked(state={}){
        this.reset()
        const s={door:0,feed:0,basket:0,lift:0,level:0,run:false,runTime:0,time:0,...state},angle=s.runTime*Math.PI*2
        const air=this.id==='cad_air_cooling_table_115800ht'
        for(const name of ['door','door_carriages'])this.move(name,'y',air ? -.9*(1-s.door) : .9*s.door)
        if(this.id==='cad_transfer_cart_101300'){
            this.move('pusher','x',s.feed*.5);this.joints.feed_gear.rotation.z=-s.feed*6
            this.wheels.forEach(n=>n.rotation.z=-(s.travel||0)/.13)
        }
        this.rollers.forEach(n=>n.rotation.z=angle*.6)
        this.fans?.forEach(n=>n.rotation.y=angle*2)
        if(this.joints.agitator)this.joints.agitator.rotation.y=angle*1.5
        this.pumpShafts?.forEach(n=>n.rotation.y=angle*2)
        if(this.scissor.length)this.applyLift(.81+.24*s.lift)
        this.move('basket','y',-1.05*s.basket)
        if(this.id==='cad_multipurpose_furnace_082000'){
            this.move('intermediate_gate','y',.85*(s.gate||0));this.move('elevator_basket','y',-1.05*s.basket)
            this.multiCirculation.rotation.y=(s.circulationTime||0)*Math.PI*3
            this.multiAgitators.forEach(n=>n.rotation.y=(s.stirTime||0)*Math.PI*3)
            this.hotRollers.forEach(n=>n.rotation.x=(s.conveyTime||0)*Math.PI*1.2)
            if(s.operation==='quench')this.showQuench(s.time)
            this.showHeat(s.heat)
        }
        if(this.id==='cad_water_cooling_tank_471000'||s.level>0||['fill','drain'].includes(s.operation))this.showWater(s.level)
        if(s.spray||s.blow)this.showJets(s.time,s.blow)
        if(s.drip)this.showDrips(s.time,1.58-s.basket*1.05)
        this.root.updateMatrixWorld(true)
    }
    showWater(level){const v=this.fluid,h=Math.max(.008,(v.max-v.min)*level);this.water.visible=true;this.water.scale.set(v.w,h,v.d);this.water.position.set(v.x,v.min+h/2,v.z)}
    showQuench(time){this.ripples.visible=true;this.ripples.children.forEach((ring,i)=>{const phase=(time*.6+i/3)%1;ring.scale.setScalar(.3+phase*1.3);ring.material.opacity=(1-phase)*.7})}
    showHeat(on){if(on)this.heatMaterials.forEach(({material})=>{material.emissive.set('#b94c12');material.emissiveIntensity=.9})}
    showDrips(t,height,drain=false){
        this.drops.visible=true;this.dropMaterial.color.set('#49c9ef')
        this.drops.children.forEach((drop,i)=>{const fall=(t*.85+i*.113)%1;drop.position.set(drain ? .55 : this.fluid.x+(i%10-4.5)*.055,height-fall*(drain ? .26 : .25),drain ? .9 : (Math.floor(i/10)-2.5)*.10)})
    }
    showJets(t,air){
        this.flow.visible=!air;this.drops.visible=true;this.dropMaterial.color.set(air?'#c4eaff':'#49c9ef')
        this.drops.children.forEach((drop,i)=>{const from=this.nozzles[i%this.nozzles.length],k=(t*1.7+Math.floor(i/this.nozzles.length)*.17)%1;drop.position.copy(from);drop.position.x*=1-k*.85;drop.position.y-=k*.08;drop.scale.setScalar(air ? .6 : 1)})
    }
    dispose(){for(const mesh of this.retired)mesh.geometry.dispose()}
}
