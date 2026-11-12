const { normalizeInspection } = require('../../shared/inspectionConfig.cjs');
// Names below are authored sibling assemblies in the supplied GLBs, never material meshes.
const PROFILES = {
    cad_multipurpose_furnace_082000: ['cad_multipurpose_furnace_600_v1_', [
        ['冷热室底座', ['cold_base','hot_base'], [0,0,0]],
        ['热室框架', ['hot_frame'], [1.8,.3,-.5]],
        ['前室外壳', ['cold_housing'], [-2,1,0]],
        ['热室外壳与端盖', ['hot_housing','hot_roof_end_caps'], [2.3,1,-.8]],
        ['炉衬与拱顶砖', ['lining','refractory','vault_bricks'], [-2.4,.4,-1.2]],
        ['前门及滑架密封', ['door','door_carriages','door_seals'], [0,.3,1.6]],
        ['前门导向与联锁', ['door_guides','door_safety','safety_interlocks'], [1.6,.7,1.2]],
        ['前门驱动与链条', ['door_drive','door_chains','counterbalance'], [-1.7,1.6,.5]],
        ['隔热门及导轨', ['intermediate_gate','intermediate_gate_guides'], [1.6,.9,-.2]],
        ['隔门龙门架与提升链', ['gate_gantry','gate_lift_chain','gate_hydraulics'], [0,2,-1.3]],
        ['冷热室隔板', ['partition_shell','partition_lining'], [-1.8,.2,-1]],
        ['前室升降承料架', ['elevator_basket'], [0,1.3,1]],
        ['承料架导向', ['basket_guides'], [1.7,.3,.6]],
        ['前室提升与传动', ['basket_hoist','front_lift_chains','front_transmission'], [-1.8,1.3,0]],
        ['整体淬火油槽', ['quench_tank'], [0,-.5,1.6]],
        ['淬火液示意层', ['quench_liquid'], [0,.8,1.8]],
        ['淬火搅拌驱动与盖板', ['agitators','agitator_lids'], [2,.6,1]],
        ['淬火搅拌叶轮', ['agitator_impellers'], [-2,-.1,1.1]],
        ['槽盖与仪表', ['tank_lids','tank_instruments','oil_instruments'], [1.9,1.6,1.3]],
        ['油路与阀门', ['oil_pipes','oil_valves'], [2.7,.2,.5]],
        ['油槽加热器接口', ['oil_heater_ports'], [-2.4,.2,.8]],
        ['热室承料辊道', ['hot_rollers'], [0,.8,-2]],
        ['辐射加热管', ['radiant_tubes'], [2.1,.9,-1.7]],
        ['炉顶循环驱动', ['roof_fan','belt_drive'], [0,1.9,-1.7]],
        ['循环叶轮与轴', ['circulation_impeller'], [-1.8,1.2,-2]],
        ['后部移料及侧驱动', ['rear_transfer','side_feed_motor','side_feed_return'], [0,.2,-2.3]],
        ['排烟罩与烟管', ['extraction','exhaust_duct','hood_fittings','canopy_frame'], [0,1.9,1.5]],
        ['前室检修口与管路', ['cold_front_hatches','cold_rear_hatches','cold_roof_pipes'], [-2.2,.2,0]],
        ['热室检修盖板', ['hot_access_panels','hot_rear_hatch','upper_service_panels'], [2.3,.3,-2]],
        ['后部工艺管路与阀门', ['rear_process_pipes','rear_process_valves'], [-2.4,.8,-2.1]],
        ['热电偶与工艺仪表', ['thermocouples','process_instruments'], [2.2,1.8,-1]],
        ['电气附件与铭牌', ['electrics','nameplates'], [2.4,.1,.5]],
        ['检修平台、爬梯及护栏', ['rear_platform','service_ladder','platform_guard','upper_guards'], [-2.7,.3,-1.5]],
        ['吊耳与临时参考件', ['lifting_eyes','temporary'], [0,2.2,0]]
    ]],
    cad_transfer_cart_101300: ['cad_transfer_cart_v1_', [
        ['底盘结构', ['structure'], [0,0,0]],
        ['行走轮组与车轴', ['travel_wheels','axle_detail'], [0,-.55,0]],
        ['行走驱动及链条', ['travel_drive','travel_chain'], [-1.15,.1,0]],
        ['操作平台与护栏', ['platform','guard'], [1.35,0,0]],
        ['电气柜与柜体附件', ['electrics','cabinet_details'], [1.35,.75,.3]],
        ['承料辊道', ['roller_bed'], [0,1.2,0]],
        ['送料电机与链轮', ['feed_motor','feed_sprocket'], [-1.2,1.0,0]],
        ['推料机构', ['pusher'], [0,.45,1.4]],
        ['回链导向机构', ['return_chain'], [0,.4,-1.4]],
        ['送料联锁附件', ['feed_interlock'], [0,1.2,1.0]]
    ]],
    cad_lifting_load_table_111400: ['cad_lifting_staging_table_v1_', [
        ['固定底座', ['structure'], [0,0,0]],
        ['剪叉升降机构', ['lift'], [0,.65,0]],
        ['液压缸及连接管件', ['hydraulics'], [-1.1,.4,0]],
        ['液压动力单元', ['hydraulic_pack'], [1.15,0,0]],
        ['升降轴销附件', ['pivot_detail'], [0,.25,-1]],
        ['辊道承料平台', ['roller_bed','roller_details'], [0,1.45,0]],
        ['滑块导向附件', ['slide_detail'], [0,.6,1]],
        ['端部挡料机构', ['stop_detail'], [1.1,.95,0]]
    ]],
    cad_fixed_load_table_112200: ['cad_fixed_staging_table_v1_', [
        ['固定支承框架', ['structure'], [0,0,0]],
        ['承料辊道', ['roller_bed'], [0,.9,0]],
        ['辊轴连接附件', ['roller_details'], [0,.45,-.8]],
        ['调平地脚总成', ['levelling'], [0,-.4,0]],
        ['端部挡料附件', ['stop_detail'], [1.15,.6,0]],
        ['端部管接附件', ['hydraulics'], [-1.1,.3,0]]
    ]],
    cad_air_cooling_table_115800ht: ['cad_air_cooling_table_v1_', [
        ['设备支承框架', ['structure'], [0,0,0]],
        ['承料辊道', ['roller_bed'], [0,.85,0]],
        ['风冷罩壳与锁扣', ['hood','hood_latches'], [-1.3,.6,0]],
        ['风机总成', ['fans'], [0,1.6,0]],
        ['风机支座与防护网', ['fan_mounts','fan_guards'], [0,1.0,-1.0]],
        ['风管法兰连接件', ['duct_flange_bolts'], [.9,1.35,0]],
        ['升降门与滑架', ['door','door_carriages'], [0,.35,1.3]],
        ['炉门导向及提升链', ['door_guides','door_lift_chain.002'], [1.1,.7,0]],
        ['驱动总成', ['drive'], [-1.1,1.35,0]],
        ['电气附件', ['electrics'], [1.2,.1,.7]]
    ]],
    cad_cleaner_170700: ['cad_washing_machine_v1_', [
        ['设备机架', ['structure'], [0,0,0]],
        ['外罩与吊耳', ['housing','lifting_eyes'], [-1.9,.8,0]],
        ['清洗腔内衬', ['lining'], [-1.4,.3,-1.3]],
        ['清洗门与密封', ['door','door_carriages','door_seals'], [0,.25,1.8]],
        ['门导轨与安全附件', ['door_guides','door_safety'], [1.7,.65,1]],
        ['门驱动与链条', ['door_drive','door_chains'], [0,1.6,1]],
        ['传动带与电机', ['belt_drive','belt_motor'], [-1.5,1.5,0]],
        ['内部承料辊道', ['internal_rollers'], [0,.65,1.2]],
        ['水箱与中央下部壳体', ['tanks','central_lower_body','lower_collection'], [0,-.6,-1.5]],
        ['过滤槽与接管', ['filter_tank','filter_connections'], [1.8,.25,-.8]],
        ['泵组', ['pumps'], [1.8,.1,.9]],
        ['喷淋总管与腔内管组', ['spray_headers','chamber_tubes'], [0,1.5,-1.25]],
        ['工艺管路及阀门', ['pipes','valves','valve_detail'], [2.1,.8,0]],
        ['工艺仪表', ['instrumentation','process_instruments'], [1.5,1.8,-.7]],
        ['电气附件', ['electrics'], [-1.9,.15,1.1]],
        ['检修盖与加热器法兰', ['rear_inspection','heater_flanges'], [0,.6,-2.0]],
        ['顶部设备', ['roof_equipment'], [0,2.1,0]]
    ]],
    cad_water_cooling_tank_471000: ['cad_water_cooling_tank_v1_', [
        ['底座与紧固件', ['structure','frame_fixings'], [0,0,0]],
        ['水槽总成', ['tank'], [-1.7,-.25,0]],
        ['上部罩壳与吊耳', ['upper_housing','lifting_eyes'], [-1.8,1.1,0]],
        ['内衬', ['lining'], [0,.2,-1.8]],
        ['承料篮及导向', ['basket','basket_guides'], [0,1.45,.7]],
        ['提升框架', ['hoist_frame'], [1.6,.8,0]],
        ['提升机构与传动', ['hoist','hoist_drive','hoist_transmission'], [0,2.0,0]],
        ['前门及密封滑架', ['door','door_carriages','door_seals'], [0,.3,1.7]],
        ['门导向及安全附件', ['door_guides','door_safety'], [1.6,.7,1.0]],
        ['门驱动与链条', ['door_drive','door_chains'], [0,1.7,1.2]],
        ['搅拌总成及安装法兰', ['agitator','agitator_flange'], [1.7,.6,-.8]],
        ['排烟抽气总成', ['extraction'], [0,1.5,-1.5]],
        ['循环管路与阀门', ['coolant_pipes','pipes','valves','valve_detail'], [2,.25,0]],
        ['电气附件', ['electrics'], [-1.6,.1,1.4]],
        ['仪表与铭牌', ['instrumentation','nameplates'], [1.7,1.5,-.5]],
        ['后槽检修盖', ['rear_tank_hatch'], [0,.6,-2.0]]
    ]]
};
function buildCadInspection(id, gltf) {
    const profile=PROFILES[id]; if(!profile)throw Error(`Unknown CAD model: ${id}`);
    const [prefix,groups]=profile,roots=gltf.scenes[gltf.scene||0].nodes;
    if(roots.length!==1)throw Error('Expected one authored CAD assembly root');
    const children=gltf.nodes[roots[0]].children.map(i=>gltf.nodes[i].name),claimed=new Set();
    const parts=groups.map(([name,suffixes,offset],order)=>{
        const names=suffixes.map(s=>prefix+s);
        for(const n of names){if(!children.includes(n)||claimed.has(n))throw Error(`Missing or duplicate assembly ${n}`);claimed.add(n)}
        return {id:`${id}_assembly_${order+1}`,name,node_names:names,explode_offset:offset,order,duration:1.3,
            group:id,description:'原 GLB 总成拆解展示；保留节点内部相对位置，不代表实际检修顺序。'};
    });
    const remaining=children.filter(n=>!claimed.has(n));
    if(remaining.some(n=>!n.endsWith('_review')))throw Error(`Unclassified assemblies: ${remaining.join(', ')}`);
    if(remaining.length)parts.push({id:`${id}_reference`,name:'模型参考标记',node_names:remaining,explode_offset:[0,0,0],group:'参考',order:parts.length});
    return normalizeInspection({version:2,enabled:true,offset_space:'model',animation_duration:1.3,shell_duration:.2,stagger:.12,
        shell:{node_names:[],node_paths:[]},parts,
        solid:{camera:{yaw:38,pitch:22,distance_scale:1.12}},
        exploded:{camera:{yaw:38,pitch:25,distance_scale:1.15}},labels:{enabled:true,leader_lines:true}});
}
module.exports={buildCadInspection};
