import * as T from 'three'
import {parseSimulationConfig} from './lineSimulation.js'
/** Reuse explicitly authored bindings, with synthetic values confined to this preview. */
export class LineSimulationRig {
    constructor(root,model){
        this.root=root;this.bindings=[];const metadata=parseSimulationConfig(model?.metadata),paths=new Map()
        function visit(parent,prefix=''){parent.children.forEach((o,i)=>{const segment=o.name.replaceAll('/','_')+'#'+i,path=prefix?prefix+'/'+segment:segment;paths.set(path,o);visit(o,path)})}visit(root)
        for(const binding of metadata.partBindings||[]){const node=paths.get(binding.node_path)||root.getObjectByName(binding.node_name||'');if(node)this.bindings.push({binding,node,p:node.position.clone(),r:node.rotation.clone(),visible:node.visible})}
        if(model?.id==='builtin_furnace'){
            const node=root.getObjectByName('front_lift_door');if(node)this.bindings.push({node,p:node.position.clone(),r:node.rotation.clone(),visible:node.visible,binding:{action:'translate',source_group:'doors',axis:'y',output_min:0,output_max:2.5}})
        }
        if(model?.id==='cad_tempering_furnace_091300')for(const name of ['door','door_carriages']){
            const node=root.getObjectByName('cad_tempering_furnace_v1_'+name)
            if(node)this.bindings.push({node,p:node.position.clone(),r:node.rotation.clone(),visible:node.visible,binding:{action:'translate',source_group:'doors',axis:'y',output_min:0,output_max:.9}})
        }
        if(model?.id==='photo_transfer_cart_v6'){
            this.shuttle=root.getObjectByName('cart_v6_node_cart_feed_shuttle');this.shuttleBase=this.shuttle?.position.clone()
            this.wheels=[1,2].map(i=>root.getObjectByName(`cart_v6_node_cart_wheel_axle_${i}_rotate`)).filter(Boolean).map(node=>({node,r:node.rotation.clone()}))
        }
    }
    applyLinked(state){
        for(const {binding:b,node,p,r,visible} of this.bindings){
            node.position.copy(p);node.rotation.copy(r);node.visible=visible
            const axis=['x','y','z'].includes(b.axis)?b.axis:'y',door=b.source_group==='doors'
            if(door&&['translate','rotate_angle'].includes(b.action)){
                const offset=Number(b.output_min||0)+(Number(b.output_max??1)-Number(b.output_min||0))*state.door
                if(b.action==='translate')node.position[axis]+=offset;else node.rotation[axis]+=T.MathUtils.degToRad(offset)
            }else if(b.action==='rotate_speed')node.rotation[axis]+=state.runTime*Math.min(300,Math.abs(Number(b.input_max)||60))*Number(b.speed_factor||Math.PI*2/60)
            else if(state.run&&b.action==='translate')node.position[axis]+=Number(b.output_max||.1)*Math.sin(state.time*Math.PI/4)**2
            else if(state.run&&b.action==='rotate_angle')node.rotation[axis]+=T.MathUtils.degToRad(Number(b.output_max||90))*Math.sin(state.time*Math.PI/4)**2
        }
        if(this.shuttle){this.shuttle.position.copy(this.shuttleBase);this.shuttle.position.x+=Number(state.feed||0)*.6}
        this.wheels?.forEach(({node,r})=>{node.rotation.copy(r);node.rotation.x+=Number(state.travel||0)/.223})
    }
    dispose(){}
}
