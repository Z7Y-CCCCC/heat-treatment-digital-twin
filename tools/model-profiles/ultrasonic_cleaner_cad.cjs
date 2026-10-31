const { normalizeModelMetadata } = require('../../backend/services/modelAssetMetadata');
const { createInspectionDefaults, normalizeInspection } = require('../../shared/inspectionConfig.cjs');

// CAD assembly-local Z maps to the exported model's vertical Y. Keep the
// cylinder barrel, cylinder brackets and door rails fixed while lifting siblings.
const movingNodes = ['075_气缸轴','078_气缸接头','081_门框架','084_门滚轮','087_门滚轮','090_门滚轮','093_门滚轮',
    '096_门板轴销','099_门板轴销','102_门板轴销','105_门板轴销','108_炉门','112_门连板','115_门连板',
    '118_门连板','121_门连板','124_门框轴销','127_门框轴销','130_门框轴销','133_门框轴销'];
const fixedDoorNodes = ['066_气缸安装板','069_气缸安装','072_气缸','136_导向轮','139_门导轨'];
// The CAD export is partially raised, not the closed zero. Front aperture:
// world Y 1.199..1.995; door Y 1.814..2.752. Local Z is world vertical.
// Center the closed plate over the aperture; keep 39 mm clearance when open.
const doorTravel = { closed: -.686, open: .22 };
function calibrateDoorBindings(bindings = []) {
    return bindings.map(binding => String(binding.id).startsWith('ultrasonic_door_')
        ? { ...binding, output_min: doorTravel.closed, output_max: doorTravel.open }
        : { ...binding });
}
const groups = [
    ['door','升降门及随动机构',movingNodes,[0,1.2,-1.2],'门体、气缸轴和连接机构联动；按 CAD 门口几何标定关闭遮挡与打开让位，模型局部行程为 0.906。'],
    ['actuator','气缸本体与固定安装座',fixedDoorNodes,[1.3,.5,-.5],'运行时固定，仅在拆解展示中移出。'],
    ['frame','上下框架与辊座',['018_上框架','022_下框架','026_棍子座'],[-1.3,.3,0]],
    ['tank','水槽总成',['033_水槽'],[0,-.5,1.2]],
    ['fan','电机风扇总成',['030_电机风扇'],[0,1.5,0],'现有网格包含电机/外壳，暂不旋转整个总成；需拆分转子后再添加风扇运行动画。'],
    ['separator','油水分离与气液分离',['142_气液分离桶','203_油水分离架子','206_油水分离'],[1.5,.4,.5]],
    ['ultrasonic','超声波震板',['299_超声波震板','302_震板2'],[0,1.2,.8],'仅提供拆解分组，不用肉眼可见的大幅振动冒充实际超声振动。'],
    ['spray','喷淋管组',['227_喷淋支管','230_喷淋支管','233_喷淋支管','236_喷淋支管','239_喷淋支管','242_喷淋支管','245_喷淋支管','248_喷淋支管','251_喷淋支管','254_喷淋支管','257_喷淋主管'],[-1.4,.5,.8]],
    ['heaters','清洗室加热器',['260_加热器2','263_加热器2','266_加热器2','269_加热器2','272_加热器2','275_加热器2','278_加热器2','281_加热器2'],[1.4,1.1,.8]]
];
const shellNodes = ['002_后面板','006_前面板','145_护栏','152_排烟罩'];
function buildMetadata(input = {}) {
    const existing = typeof input === 'string' ? JSON.parse(input) : input;
    const bindings = movingNodes.map((node,index)=>({id:`ultrasonic_door_${index+1}`,name:`门体升降 · ${node.slice(4)}`,node_name:node,
        source_group:'doors',source_key:'front_door_open',action:'translate',axis:'z',input_min:0,input_max:1,
        output_min:doorTravel.closed,output_max:doorTravel.open,transition_duration:3}));
    const defaults = createInspectionDefaults();
    const inspection = normalizeInspection({...defaults,...existing.inspection,enabled:true,offset_space:'model',
        solid:{...defaults.solid,...existing.inspection?.solid,camera:{...defaults.solid.camera,yaw:238,pitch:20,distance_scale:.72,target_offset:[-1.7,0,-2.4]}},
        xray:{...defaults.xray,...existing.inspection?.xray,camera:{...defaults.xray.camera,yaw:238,pitch:20,distance_scale:.72,target_offset:[-1.7,0,-2.4]}},
        shell:{...defaults.shell,...existing.inspection?.shell,node_paths:[],node_names:shellNodes},
        parts:[...(existing.inspection?.parts||[]).filter(p=>!String(p.id).startsWith('ultrasonic_')),
            ...groups.map(([id,name,nodes,offset,description],index)=>({id:`ultrasonic_${id}`,name,node_names:nodes,
                explode_offset:offset,order:index,delay:index*.06,duration:1.2,group:'超声波清洗机总成',
                description:description||'CAD 总成展示分组，非实际检修拆卸规程。',
                point_keys:id==='door'?['doors.front_door_open']:[]}))]});
    return normalizeModelMetadata({...existing,inspection,
        optimization:{...existing.optimization,mergeStatic:false,preserveAnimated:true},
        runtime:{...existing.runtime,enableGenericBindings:true},
        partBindings:[...(existing.partBindings||[]).filter(b=>!String(b.id).startsWith('ultrasonic_door_')),...bindings],
        motionProfile:{id:'ultrasonic_cleaner_cad',version:2,demonstration:true,signal:'doors.front_door_open',doorTravel,
            note:'门体升降与气缸轴随动示意；全行程 3 秒，实际方向、行程及开门中/到位信号需现场确认。'}});
}
module.exports = {buildMetadata,calibrateDoorBindings,doorTravel,movingNodes,fixedDoorNodes,shellNodes,groups};
