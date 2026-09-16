const { presetMetadata } = require('./inspectionPresets');

const BUILTIN_MODELS = [
    ...[
        ['photo_multipurpose_furnace_v6', '多用炉 V6 · 可配置拆解样板', 'photo_multipurpose_furnace_v6_pipefix'],
        ['photo_tempering_furnace_v6', '回火炉 V6 · 可配置拆解样板'],
        ['photo_transfer_cart_v6', '转运小车 V6 · 可配置拆解样板'],
        ['photo_washing_machine_v7', '清洗机 V7 · 可配置拆解样板']
    ].map(([id, name, fileId = id]) => ({
        id, name, file_path: `/assets/models/${fileId}.glb`, asset_type: 'model',
        tags: JSON.stringify(['packaged', 'inspection_v2', 'assembly_demo']), thumbnail: `/assets/models/${id}_preview.png`,
        default_scale: 1, metadata: JSON.stringify(presetMetadata(id)), is_builtin: true
    })),
    {
        id: 'factory_hall_lowpoly',
        name: '厂房环境 · 开放式总览模型',
        file_path: '/assets/models/factory_hall_study/factory_hall_lowpoly.glb',
        asset_type: 'environment',
        tags: JSON.stringify(['packaged', 'environment', 'factory_overview']),
        thumbnail: '/assets/models/factory_hall_study/preview.png',
        default_scale: 1,
        metadata: JSON.stringify({
            schema_version: 1,
            assetRole: 'environment',
            environmentOnly: true,
            runtime: {
                environmentOnly: true,
                enableGenericBindings: false,
                enableInspection: false
            },
            inspection: { enabled: false, parts: [], shell: { node_paths: [], node_names: [] } },
            partBindings: [],
            assetSpec: {
                version: '1.0.0',
                device_family: '环境模型',
                unit: 'm',
                delivery_status: 'released',
                notes: '静态厂房环境资产，仅用于工厂总览'
            },
            optimization: {
                mode: 'off',
                mergeStatic: false,
                instanceRepeated: false,
                preserveAnimated: false,
                materialEnhancement: 'original',
                contactShadow: false,
                environmentIntensity: 1
            },
            delivery: { status: 'released', role: 'environment', note: '仅用于工厂总览展示，不参与设备拆解、点位绑定或 PLC 动画' }
        }),
        is_builtin: true
    }
];

function getBuiltinModels() {
    return BUILTIN_MODELS.map(model => ({ ...model }));
}

function mergeBuiltinModels(models = []) {
    const merged = new Map(getBuiltinModels().map(model => [model.id, model]));
    models.forEach(model => {
        const builtin = merged.get(model.id);
        merged.set(model.id, {
            ...(builtin || {}),
            ...model,
            is_builtin: !!builtin || !!model.is_builtin
        });
    });
    return Array.from(merged.values());
}

module.exports = {
    getBuiltinModels,
    mergeBuiltinModels
};
