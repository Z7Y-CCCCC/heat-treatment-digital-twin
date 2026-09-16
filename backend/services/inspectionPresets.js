const { createInspectionDefaults, normalizeInspection } = require('../../shared/inspectionConfig.cjs');

// Asset-authored, editable examples. Renderers contain no equipment-specific logic.
// These are presentation arrangements, not verified maintenance/disassembly procedures.
const assetMetadata = {
    photo_multipurpose_furnace_v6: require('../assets/models/photo_multipurpose_furnace_v6_metadata.json'),
    photo_tempering_furnace_v6: require('../assets/models/photo_tempering_furnace_v6_metadata.json'),
    photo_transfer_cart_v6: require('../assets/models/photo_transfer_cart_v6_metadata.json'),
    photo_washing_machine_v7: require('../assets/models/photo_washing_machine_v7_metadata.json')
};

function part(id, name, nodes, offset, delay = 0, group = '外部总成', yaw, description = '') {
    return { id, name, node_names: nodes, explode_offset: offset, delay, duration: 1.1, group,
        label_offset: [0, .38, 0], description: description || '依据现有模型功能组编排的展示位置，不代表真实检修拆卸路径。',
        camera: yaw === undefined ? null : { yaw, pitch: 22, distance_scale: 1.12, target_offset: [0, 0, 0] } };
}

function preset(modelId, name, shellNames, parts, yaw) {
    const metadata = assetMetadata[modelId];
    const base = createInspectionDefaults();
    for (const item of parts) {
        const bindings = (metadata.partBindings || []).filter(binding => item.node_names.includes(binding.node_name));
        item.point_ids = [...new Set([...(item.point_ids || []), ...bindings.flatMap(binding => [binding.point_id, ...(binding.point_ids || [])]).filter(Boolean)])];
        item.point_keys = [...new Set([...(item.point_keys || []), ...bindings.filter(binding => binding.source_key).map(binding => `${binding.source_group || 'analog'}.${binding.source_key}`)])];
    }
    const inspection = normalizeInspection({ ...base, shell_duration: 1, animation_duration: 1.1, stagger: 0,
        shell: { ...base.shell, node_names: shellNames },
        solid: { ...base.solid, camera: { ...base.solid.camera, yaw, pitch: 22, distance_scale: 1.05 } },
        xray: { ...base.xray, camera: { ...base.xray.camera, yaw, pitch: 22, distance_scale: 1.05 } },
        exploded: { ...base.exploded, camera: { ...base.exploded.camera, yaw, pitch: 24, distance_scale: 1.05 } }, parts });
    return { id: `${modelId}_inspection_v2`, modelId, name, description: '可编辑的总成展示样板；不可见内部机构仅作示意，现场动作绑定需单独核定。', inspection };
}

const furnaceParts = [
    part('electrical_assembly', '控制柜与报警灯', ['control_cabinet', 'control_alarm_lamp'], [-1.2, 0, 1.15], 0, '外部配套', 315),
    part('service_platform', '检修平台', ['maintenance_platform'], [0, 0, -1.6], 0, '外部配套', 160),
    part('gas_instruments', '气氛仪表与管线', ['gas_instrument_bank'], [0, 0, -.85], .15, '外部配套', 170),
    part('drive_services', '驱动及操作侧配套', ['drive_housings', 'operator_side_services'], [0, .15, 1.7], .15, '外部配套', 35),
    part('exhaust_assembly', '排气罩', ['exhaust_hood'], [0, 1.3, 0], 1.1, '顶部机构'),
    part('chamber_reference', '炉口与可见腔体', ['mouth_frame', 'chamber_visible'], [0, 0, 0], 0, '结构参照', 85, '炉口及照片可见腔体作为装配参照；不推定不可见的内部结构。'),
    part('chassis_reference', '设备底座', ['chassis'], [0, 0, 0], 0, '结构参照'),
    part('front_door_open', '前炉门', ['door_front_lift'], [1.3, .25, .8], 1.1, '炉门机构', 85),
    part('middle_door_open', '中间炉门', ['door_middle_lift'], [.7, .2, -.7], 1.25, '炉门机构', 85),
    part('front_fan_speed', '前循环叶轮（示意）', ['fan_front_rotate'], [.5, 1.6, 0], 2.2, '内部示意'),
    part('rear_fan_speed', '后循环叶轮（示意）', ['fan_rear_rotate'], [-.65, 1.5, 0], 2.35, '内部示意'),
    ...[1, 2, 3, 4].map((index) => part(`oil_stir_${index}_speed`, `油槽搅拌叶轮 ${index}（示意）`, [`agitator_oil_0${index}_rotate`], [(index - 2.5) * .25, -.05, -2.1], 2.05 + index * .15, '内部示意', 145))
];
furnaceParts.find(item => item.id === 'front_door_open').label_offset = [.2, .4, .4];
furnaceParts.find(item => item.id === 'middle_door_open').label_offset = [.2, .4, -.4];

const temper = names => names.map(name => `temper_v6_node_${name}`);
const wash = names => names.map(name => `wash_v7_node_${name}`);
const cart = names => names.map(name => `cart_v6_node_cart_${name}`);
const PRESETS = [
    preset('photo_multipurpose_furnace_v6', '多用炉 · 外壳退场与分阶段总成展开', ['shell_front', 'shell_lower', 'shell_rear'], furnaceParts, 60),
    preset('photo_tempering_furnace_v6', '回火炉 · 炉门、循环与检修总成', temper(['thermal_shell']), [
        part('temper_chassis', '底座与可见炉腔', temper(['chassis', 'refractory_chamber']), [0, 0, 0], 0, '结构参照'),
        part('temper_controls', '电气柜', temper(['electrical_cabinet']), [-1.2, 0, 0], 0),
        part('temper_access', '检修平台与梯笼', temper(['ladder_cage', 'service_platform']), [1.2, 0, 0], .1),
        part('temper_services', '管线配套', temper(['pipe_services']), [0, 0, -1], .2),
        part('temper_exhaust', '顶部排气罩', temper(['sloped_exhaust_hood']), [0, 1.2, 0], .8),
        part('tempering_door_drive_speed', '炉门驱动与导向', temper(['door_drive_housing', 'door_drive_shaft_rotate', 'door_guides']), [0, .6, .9], 1.1),
        part('tempering_door_open', '前炉门', temper(['door_front_lift']), [0, .25, 1.7], 1.3),
        part('tempering_fan_speed', '循环风机总成（叶轮示意）', temper(['circulation_drive_housing', 'circulation_fan_rotate']), [0, 1.5, -.7], 1.6),
        part('temper_tray', '前端承接盘', temper(['front_shallow_tray']), [0, -.2, 1.2], .7)
    ], -35),
    preset('photo_washing_machine_v7', '清洗机 V7 · 泵组与后箱总成', wash(['tank_shell', 'upright_chamber_shell', 'rear_auxiliary_shell']), [
        part('wash_chassis', '机架与后箱支撑', wash(['chassis', 'rear_auxiliary_support', 'front_rear_connector']), [0, 0, 0], 0, '结构参照'),
        part('wash_chamber', '装料口与可见腔体', wash(['loading_mouth_frame', 'visible_chamber']), [0, 0, 0], 0, '结构参照'),
        part('wash_controls', '宽式控制柜', wash(['wide_control_cabinet']), [1, 0, .5], 0),
        part('wash_pump_assembly', '泵组与绿色主管（泵轴示意）', wash(['pump_housings', 'green_process_pipework', 'wash_pump_01_shaft_rotate', 'wash_pump_02_shaft_rotate', 'wash_pump_03_shaft_rotate', 'wash_pump_04_shaft_rotate']), [-1.3, .1, 0], .2, '泵组总成', -60, '泵壳为合并总成，四个小轴为动画示意；不将单轴当作完整水泵。'),
        part('wash_rear_services', '后箱外部管路', wash(['rear_external_services']), [0, 0, -1.2], .3),
        part('wash_covers', '后箱低顶盖', wash(['rear_low_top_covers']), [0, 1.2, -.3], 1.1),
        part('wash_hood', '黑色斜顶罩', wash(['black_sloping_hood']), [0, 1.3, 0], 1.2),
        part('wash_door_drive', '炉门驱动外壳', wash(['door_drive_housing']), [0, .8, .7], 1.3),
        part('wash_door_open', '清洗前门', wash(['wash_door_lift']), [0, .2, 1.3], 1.5)
    ], -40),
    preset('photo_transfer_cart_v6', '转运小车 · 同级机构分组展开', cart(['tall_head_frame']), [
        part('cart_rails', '参考轨道', cart(['reference_rails']), [0, 0, 0], 0, '结构参照'),
        { ...part('cart_travel_position', '开放底盘', cart(['open_chassis']), [0, 0, 0], 0, '结构参照'), point_keys: ['positions.cart_travel_position'] },
        part('cart_drive', '驱动与线缆', cart(['drive_and_cables']), [-1, .2, 0], 0),
        part('cart_console', '操作台与站台', cart(['operator_console', 'operator_platform']), [1.1, 0, 0], .1),
        part('cart_chain', '可见链条导向', cart(['visible_chain_guides']), [0, .4, -.9], .5),
        part('cart_feed_extension', '承料与送料总成', cart(['transfer_frame', 'feed_roller_1_rotate', 'feed_roller_2_rotate', 'feed_roller_3_rotate', 'feed_shuttle']), [0, 1.2, .7], .8),
        part('cart_axles', '行走双轮轴', cart(['wheel_axle_1_rotate', 'wheel_axle_2_rotate']), [0, -.25, -1], 1.3),
        part('cart_cable_reel_speed', '电缆卷盘', cart(['cable_reel_rotate']), [-.8, .4, -.4], 1.5)
    ], 38)
];

function getInspectionPresets() { return JSON.parse(JSON.stringify(PRESETS)); }
function presetMetadata(modelId) {
    const item = PRESETS.find(item => item.modelId === modelId);
    if (!item) return null;
    return JSON.parse(JSON.stringify({ ...assetMetadata[modelId], inspection: item.inspection }));
}

module.exports = { getInspectionPresets, presetMetadata };
