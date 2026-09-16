/**
 * Reusable heat-treatment display packs.
 *
 * These are configuration blueprints, not production-control recipes. They
 * describe how the digital-twin should display a device and its read-only PLC
 * points. Applying a pack still requires an explicit site change/approval.
 */
const COMMON_ALARMS = [
    { id: 'device_offline', label: '设备离线', source: 'device', level: 'critical', displayOnly: true },
    { id: 'actual_temp_high', label: '实际温度超上限', sourceGroup: 'analog', sourceKey: 'actual_temp', condition: '>', threshold: 950, unit: '°C', level: 'error', displayOnly: true },
    { id: 'actual_temp_low', label: '实际温度低于下限', sourceGroup: 'analog', sourceKey: 'actual_temp', condition: '<', threshold: 650, unit: '°C', level: 'warning', displayOnly: true }
];

const MULTIPURPOSE_PART_BINDINGS = [
    { partId: 'front_door_open', name: '前门组件', sourceGroup: 'doors', sourceKey: 'front_door_open', action: 'translate', axis: 'y' },
    { partId: 'middle_door_open', name: '中门组件', sourceGroup: 'doors', sourceKey: 'middle_door_open', action: 'translate', axis: 'y' },
    { partId: 'rear_fan_rotate', name: '后室循环风扇', sourceGroup: 'motors', sourceKey: 'rear_fan_speed', action: 'rotate_speed', axis: 'z' },
    { partId: 'front_fan_rotate', name: '前室循环风扇', sourceGroup: 'motors', sourceKey: 'front_fan_speed', action: 'rotate_speed', axis: 'z' },
    { partId: 'oil_stir_1_rotate', name: '淬火搅拌轴 1', sourceGroup: 'motors', sourceKey: 'oil_stir_1_speed', action: 'rotate_speed', axis: 'z' },
    { partId: 'oil_stir_2_rotate', name: '淬火搅拌轴 2', sourceGroup: 'motors', sourceKey: 'oil_stir_2_speed', action: 'rotate_speed', axis: 'z' }
];

const HEAT_TREATMENT_TEMPLATE_PACKS = Object.freeze([
    {
        id: 'heat_multipurpose_furnace_v1',
        name: '多用炉 · 数字孪生标准包',
        version: '1.0.0',
        category: 'furnace',
        modelType: 'photo_multipurpose_furnace_v6',
        description: '适用于箱式气氛多用炉的实体、透视、拆解和部件详情展示。',
        pointPack: [
            { key: 'actual_temp', label: '实际温度', category: 'analog', valueRole: 'actual_temp', dataType: 'WORD', unit: '°C', accessType: 'READ' },
            { key: 'setpoint_temp', label: '设定温度', category: 'analog', valueRole: 'setpoint_temp', dataType: 'WORD', unit: '°C', accessType: 'READ' },
            { key: 'actual_carbon', label: '实际碳势', category: 'analog', valueRole: 'actual_carbon', dataType: 'REAL', unit: '%', accessType: 'READ' },
            { key: 'front_door_open', label: '前门状态', category: 'doors', valueRole: 'front_door_open', dataType: 'BOOL', unit: '', accessType: 'READ' },
            { key: 'middle_door_open', label: '中门状态', category: 'doors', valueRole: 'middle_door_open', dataType: 'BOOL', unit: '', accessType: 'READ' },
            { key: 'rear_fan_speed', label: '后室风扇转速', category: 'motors', valueRole: 'rear_fan_speed', dataType: 'WORD', unit: 'rpm', accessType: 'READ' },
            { key: 'front_fan_speed', label: '前室风扇转速', category: 'motors', valueRole: 'front_fan_speed', dataType: 'WORD', unit: 'rpm', accessType: 'READ' },
            { key: 'alarm', label: '设备报警', category: 'status', valueRole: 'alarm', dataType: 'BOOL', unit: '', accessType: 'READ', pointKind: 'alarm' }
        ],
        alarmRules: [...COMMON_ALARMS, { id: 'actual_carbon_high', label: '碳势超上限', sourceGroup: 'analog', sourceKey: 'actual_carbon', condition: '>', threshold: 1.2, unit: '%', level: 'error', displayOnly: true }],
        partBindings: MULTIPURPOSE_PART_BINDINGS,
        views: ['device_detail', 'device_xray', 'device_exploded', 'device_part'],
        externalData: ['batches', 'compliance', 'oee']
    },
    {
        id: 'heat_tempering_furnace_v1',
        name: '回火炉 · 数字孪生标准包',
        version: '1.0.0',
        category: 'furnace',
        modelType: 'photo_tempering_furnace_v6',
        description: '适用于回火炉，保留设备状态和温度曲线展示，不虚构碳势数据。',
        pointPack: [
            { key: 'actual_temp', label: '实际温度', category: 'analog', valueRole: 'actual_temp', dataType: 'WORD', unit: '°C', accessType: 'READ' },
            { key: 'setpoint_temp', label: '设定温度', category: 'analog', valueRole: 'setpoint_temp', dataType: 'WORD', unit: '°C', accessType: 'READ' },
            { key: 'running', label: '运行状态', category: 'status', valueRole: 'running', dataType: 'BOOL', unit: '', accessType: 'READ' },
            { key: 'alarm', label: '设备报警', category: 'status', valueRole: 'alarm', dataType: 'BOOL', unit: '', accessType: 'READ', pointKind: 'alarm' },
            { key: 'fan_speed', label: '循环风机转速', category: 'motors', valueRole: 'fan_speed', dataType: 'WORD', unit: 'rpm', accessType: 'READ' }
        ],
        alarmRules: COMMON_ALARMS,
        partBindings: [{ partId: 'fan_rotate', name: '循环风机', sourceGroup: 'motors', sourceKey: 'fan_speed', action: 'rotate_speed', axis: 'z' }],
        views: ['device_detail', 'device_xray', 'device_exploded', 'device_part'],
        externalData: ['batches', 'compliance', 'oee']
    },
    {
        id: 'heat_washer_v1',
        name: '清洗机 · 数字孪生标准包',
        version: '1.0.0',
        category: 'washer',
        modelType: 'photo_washing_machine_v7',
        description: '适用于清洗机的温度、运行、报警和设备状态展示。',
        pointPack: [
            { key: 'actual_temp', label: '清洗槽温度', category: 'analog', valueRole: 'actual_temp', dataType: 'WORD', unit: '°C', accessType: 'READ' },
            { key: 'running', label: '运行状态', category: 'status', valueRole: 'running', dataType: 'BOOL', unit: '', accessType: 'READ' },
            { key: 'alarm', label: '设备报警', category: 'status', valueRole: 'alarm', dataType: 'BOOL', unit: '', accessType: 'READ', pointKind: 'alarm' }
        ],
        alarmRules: COMMON_ALARMS,
        partBindings: [],
        views: ['device_detail'],
        externalData: ['batches', 'oee', 'maintenance']
    }
]);

function getHeatTreatmentTemplatePacks() {
    return HEAT_TREATMENT_TEMPLATE_PACKS.map(pack => ({
        ...pack,
        pointPack: pack.pointPack.map(point => ({ ...point })),
        alarmRules: pack.alarmRules.map(rule => ({ ...rule })),
        partBindings: pack.partBindings.map(binding => ({ ...binding })),
        views: [...pack.views],
        externalData: [...pack.externalData]
    }));
}

module.exports = { getHeatTreatmentTemplatePacks };
