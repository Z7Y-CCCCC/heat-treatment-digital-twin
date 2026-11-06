import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'
import {MULTIPURPOSE_CYCLE,MULTIPURPOSE_PROCESS_KINDS} from './multipurposeProcess.js'
export const parseSimulationConfig=value=>{try{return typeof value==='string'?JSON.parse(value):value||{}}catch{return {}}}
const CART_MODELS=new Set(['transfer_cart','photo_transfer_cart_v6','cad_transfer_cart_101300'])
export const isSimulationCart=device=>CART_MODELS.has(device.model_type)
export function simulationLineMembers(devices,lineId){
    if(!lineId)return []
    return devices.filter(d=>{const c=parseSimulationConfig(d.instance_config),owner=d.line_id||(isSimulationCart(d)?c.railLineId||c.laneLineId:'');return String(owner||'')===String(lineId)})
        .sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)||String(a.id).localeCompare(String(b.id)))
}
export function simulationModel(device,models){
    const model=models.find(m=>m.id===device.model_type)
    return model?{...model,file_path:device.model_file||model.file_path}:null
}
export function simulationCapabilities(device,models){
    const model=simulationModel(device,models),metadata=parseSimulationConfig(model?.metadata)
    const bindings=Array.isArray(metadata.partBindings)?metadata.partBindings:[]
    const cad=CAD_MOTION_PROFILES[device.model_type]
    const door=!!cad?.actions.some(a=>a.id==='door')||bindings.some(b=>b.source_group==='doors'&&['translate','rotate_angle'].includes(b.action))||['builtin_furnace','cad_tempering_furnace_091300'].includes(device.model_type)
    let process=[]
    switch(device.model_type){
        case 'cad_tempering_furnace_091300':process=['tempering_heat','tempering_hold'];break
        case 'cad_multipurpose_furnace_082000':process=[...MULTIPURPOSE_PROCESS_KINDS];break
        case 'cad_cleaner_170700':process=['lower','immersion','raise','spray'];break
        case 'ultrasonic_cleaner_cad':process=['fill','heat','spray','ultrasonic','drain','blow'];break
        case 'cad_water_cooling_tank_471000':process=['lower','quench','raise','drip'];break
        case 'cad_lifting_load_table_111400':process=['lift','rollers'];break
        case 'cad_fixed_load_table_112200':process=['rollers'];break
        case 'cad_air_cooling_table_115800ht':process=['fans'];break
        default:if(bindings.some(b=>b.source_group!=='doors'&&['translate','rotate_speed','rotate_angle'].includes(b.action)))process=['run']
    }
    const usable=!!model?.file_path||device.model_type==='builtin_furnace'||device.model_type==='transfer_cart'
    return {model,door,process,cart:isSimulationCart(device),usable,animated:door||process.length>0||isSimulationCart(device)}
}
const LABELS={tempering_heat:'回火加热',tempering_hold:'热风循环保温',fill:'注水',heat:'加热',spray:'喷淋清洗',ultrasonic:'超声清洗',drain:'排水',blow:'吹扫',lower:'承料架下降',quench:'搅拌冷却',raise:'承料架升起',drip:'沥液',lift:'升降备料',rollers:'辊道运转',fans:'风冷',run:'已配置部件运转',gate_open:'打开中间隔热门',hot_feed:'移料进入热室',gate_close:'关闭中间隔热门',heat_treat:'热室加热与循环',gate_open_return:'出热室开隔门',hot_return:'移料返回前室',gate_close_return:'淬火前关闭隔门'}
export function buildLineSimulation(devices,models,{process=true}={}){
    if(new Set(devices.map(d=>d.id)).size!==devices.length)throw Error('设备实例重复，请重新选择。')
    const rows=devices.map(d=>({...d,capabilities:simulationCapabilities(d,models)}))
    const carts=rows.filter(d=>d.capabilities.cart),stations=rows.filter(d=>!d.capabilities.cart)
    if(carts.length>1)throw Error('一次联动请选择一台料车。')
    if(!stations.length)throw Error('请至少选择一台作业设备。')
    const missing=rows.filter(d=>!d.capabilities.usable);if(missing.length)throw Error('设备缺少可加载模型：'+missing.map(d=>d.name||d.id).join('、'))
    const cart=carts[0],steps=[];let previous=null
    const push=(station,kind,label,duration=3)=>steps.push({id:`${station.id}:${kind}`,deviceId:station.id,name:station.name||station.id,kind,label,duration,from:previous,to:station.id,cartId:cart?.id||''})
    for(const station of stations){
        const c=station.capabilities
        if(!c.animated){push(station,'display','静态展示（未配置动作）',3);continue}
        if(cart&&process&&station.model_type==='cad_multipurpose_furnace_082000'){
            for(const step of MULTIPURPOSE_CYCLE)push(station,step.kind,step.label,step.duration)
            previous=station.id;continue
        }
        if(cart){push(station,'approach','料车定位',4);if(c.door)push(station,'open','开门');push(station,'feed','送料',4);push(station,'retract','退链');if(c.door)push(station,'close','关门')}
        if(process)for(const kind of c.process){
            const multi=station.model_type==='cad_multipurpose_furnace_082000'?MULTIPURPOSE_CYCLE.find(s=>s.kind===kind):null
            const cleanerLabels={lower:'料盘下降浸入碱液',immersion:'碱液浸洗',raise:'料盘升出碱水槽',spray:'喷清水'}
            const label=multi?.label||(station.model_type==='cad_cleaner_170700'?cleanerLabels[kind]:null)||(kind==='drip'?'沥水':LABELS[kind])
            push(station,kind,label,multi?.duration||(['immersion','spray','quench','fans','ultrasonic','heat_treat','tempering_heat','tempering_hold'].includes(kind)?6:4))
        }
        if(!cart&&c.door)push(station,'door_cycle','开关门演示',6)
        if(cart){if(c.door)push(station,'open_out','出料开门');push(station,'pickup_extend','取料伸链',2);push(station,'reclaim','物料回车',4);if(c.door)push(station,'close_out','出料关门');previous=station.id}
        else if(!c.process.length&&!c.door)push(station,'display','静态展示',3)
    }
    if(!steps.length)throw Error('所选设备没有可模拟工步。')
    let start=0;for(const step of steps){step.start=start;start+=step.duration;step.end=start}
    return {rows,stations,cart,steps,total:start}
}
const smooth=x=>x*x*(3-2*x)
export function sampleLineSimulation(plan,time){
    const elapsed=Math.max(0,Math.min(plan.total,Number(time)||0))
    const states=Object.fromEntries(plan.rows.map(d=>[d.id,{door:0,gate:0,chamber:0,basket:0,lift:0,level:['cad_water_cooling_tank_471000','cad_cleaner_170700'].includes(d.model_type)?1:0,runTime:0,circulationTime:0,stirTime:0,conveyTime:0,time:0,run:false,spray:false,blow:false,heat:false,ultrasonic:false,drip:false}]))
    const cart={from:null,to:null,progress:0,feed:0,runTime:0,segments:[]}
    let material={holder:plan.cart?.id||'',from:'',to:'',progress:0},index=plan.steps.length-1
    for(let i=0;i<plan.steps.length;i++){
        const step=plan.steps[i];if(elapsed<step.start){index=Math.max(0,i-1);break}
        const local=Math.min(step.duration,elapsed-step.start),p=local/step.duration,s=smooth(p),active=local<step.duration,state=states[step.deviceId]
        const tempering=plan.stations.find(device=>device.id===step.deviceId)?.model_type==='cad_tempering_furnace_091300'
        state.time=local
        switch(step.kind){
            case 'approach':Object.assign(cart,{from:step.from,to:step.to,progress:s});cart.segments.push({from:step.from,to:step.to,progress:s});break
            case 'open':case 'open_out':state.door=s;break
            case 'close':case 'close_out':state.door=1-s;break
            case 'door_cycle':state.door=Math.sin(Math.PI*p)**2;break
            case 'feed':cart.feed=s;cart.runTime+=local;if(tempering)state.conveyTime+=local;material={holder:p===1?step.deviceId:step.cartId,from:step.cartId,to:step.deviceId,progress:s};break
            case 'retract':cart.feed=1-s;break
            case 'pickup_extend':cart.feed=s;break
            case 'reclaim':cart.feed=1-s;cart.runTime+=local;if(tempering)state.conveyTime-=local;material={holder:p===1?step.cartId:step.deviceId,from:step.deviceId,to:step.cartId,progress:s};break
            case 'fill':state.level=p;break
            case 'drain':state.level=1-p;break
            case 'lower':state.basket=s;break
            case 'raise':state.basket=1-s;break
            case 'immersion':state.run=active;state.runTime+=local;break
            case 'lift':state.lift=Math.sin(Math.PI*p)**2;break
            case 'gate_open':case 'gate_open_return':state.gate=s;break
            case 'gate_close':case 'gate_close_return':state.gate=1-s;break
            case 'hot_feed':state.chamber=s;state.conveyTime+=local;break
            case 'hot_return':state.chamber=1-s;state.conveyTime-=local;break
            case 'heat_treat':state.heat=active;state.run=active;state.circulationTime+=local;break
            case 'tempering_heat':case 'tempering_hold':state.heat=active;state.run=active;state.circulationTime+=local;break
            case 'spray':case 'blow':case 'heat':case 'ultrasonic':case 'drip':state[step.kind]=active;state.run=active;state.runTime+=local;break
            case 'quench':state.stirTime+=local;state.run=active;state.runTime+=local;break
            case 'fans':case 'rollers':case 'run':state.run=active;state.runTime+=local;break
        }
        // Completed operations retain their final positions but never leave effects running.
        if(!active){state.run=false;for(const key of ['spray','blow','heat','ultrasonic','drip'])state[key]=false}
        if(active||i===plan.steps.length-1){index=i;break}
    }
    const step=plan.steps[index]
    return {elapsed,total:plan.total,complete:elapsed>=plan.total,index,step,progress:(elapsed-step.start)/step.duration,states,cart,material}
}
