let catalogue;
function legacyCatalogue() {
if (catalogue) return catalogue;
const { presetMetadata } = require('./inspectionPresets');
const { getPitFurnaceModels } = require('./pitFurnaceModels');
const { getCadEquipmentModels } = require('./cadEquipmentModels');
const cleanerMetadata = require('../assets/models/ultrasonic_cleaner_cad_metadata.json');
const temperingCadMetadata = require('../assets/models/cad_tempering_furnace_091300_metadata.json');

catalogue = [
    ...[
        ['photo_multipurpose_furnace_v6', '多用炉 V6 · 可配置拆解样板', 'photo_multipurpose_furnace_v6_pipefix'],
        ['photo_tempering_furnace_v6', '回火炉 V6 · 可配置拆解样板'],
        ['photo_transfer_cart_v6', '转运小车 V6 · 可配置拆解样板'],
        ['photo_washing_machine_v7', '清洗机 V7 · 可配置拆解样板']
    ].map(([id, name, fileId = id]) => ({
        id, name, file_path: `/assets/models/${fileId}.glb`, asset_type: 'model', placement_level: 'device', factory_id: null,
        tags: JSON.stringify(['packaged', 'inspection_v2', 'assembly_demo']), thumbnail: `/assets/models/${id}_preview.png`,
        default_scale: 1, metadata: JSON.stringify(presetMetadata(id)), is_builtin: true
    })),
    {
        id: 'ultrasonic_cleaner_cad', name: 'ultrasonic_cleaner_cad',
        file_path: '/assets/models/ultrasonic_cleaner_cad.glb', asset_type: 'model', placement_level: 'device', factory_id: null,
        tags: JSON.stringify(['packaged', 'cad', 'assembly_demo']), thumbnail: null, default_scale: 1,
        metadata: JSON.stringify(cleanerMetadata), is_builtin: true
    },
    ...getPitFurnaceModels(),
    {
        id: 'cad_tempering_furnace_091300', name: '回火炉 · 09.13.00 CAD',
        file_path: '/assets/models/cad_tempering_furnace_091300.glb', asset_type: 'model', placement_level: 'device', factory_id: null,
        tags: JSON.stringify(['packaged', 'cad', 'tempering_furnace']), thumbnail: null, default_scale: 1,
        metadata: JSON.stringify(temperingCadMetadata), is_builtin: true
    },
    ...getCadEquipmentModels(),
    {
        id: 'factory_hall_lowpoly',
        name: '厂房环境 · 开放式总览模型',
        file_path: '/assets/models/factory_hall_study/factory_hall_lowpoly.glb',
        asset_type: 'environment',
        placement_level: 'factory',
        factory_id: null,
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
return catalogue;
}

function getBuiltinModels() {
    if (require('./installContentPolicy').emptyInstallation()) return [];
    return legacyCatalogue().map(model => withMotionPackage({ ...model }));
}

function builtinMotionForModel(model) {
    // Empty installs must not seed the legacy model catalogue. They must still
    // resolve actions for an existing/imported CAD with the exact managed source
    // path and hash. Otherwise the part preview and device binding disagree.
    const motion = require('../../shared/motionPackages.json').models[model.id];
    let valid = false;
    if (motion && model.file_path === motion.sourcePath) {
        try {
            const fs = require('node:fs'), path = require('node:path');
            const file = path.resolve(__dirname, '..', '.' + motion.sourcePath), stat = fs.statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
            if (!motionHashCache.has(key)) motionHashCache.set(key, require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
            valid = motionHashCache.get(key) === motion.sourceSha256;
        } catch { /* missing/replaced CAD never receives a mismatched rig */ }
    }
    // Never attach a rig to a replacement upload merely sharing an old model ID.
    return valid ? motion : null;
}
const motionHashCache = new Map();

function withMotionPackage(model) {
    const builtin = builtinMotionForModel(model);
    let authored;
    try { authored = (typeof model.metadata === 'string' ? JSON.parse(model.metadata || '{}') : model.metadata)?.motionAuthoring?.bundle; } catch { /* invalid legacy metadata */ }
    if (authored && authored.sourcePath === model.file_path && Array.isArray(authored.actions)
        && /^[a-f0-9]{64}$/.test(authored.sourceSha256) && /^[a-f0-9]{64}$/.test(authored.rigSha256) && /^[a-f0-9]{64}$/.test(authored.clipSha256)
        && /^\/uploads\/(models\/motions|projects)\/[a-zA-Z0-9_./-]+\.glb$/.test(authored.rigPath)
        && /^\/uploads\/(models\/motions|projects)\/[a-zA-Z0-9_./-]+\.json$/.test(authored.clipPath)) {
        try {
            const fs = require('node:fs'), file = require('./motionAuthoring').localFile(model.file_path), stat = fs.statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
            if (!motionHashCache.has(key)) motionHashCache.set(key, require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
            if (motionHashCache.get(key) === authored.sourceSha256) return { ...model, motion_package: authored };
        } catch { /* replacement/missing source must not receive an old rig */ }
    }
    return { ...model, motion_package: builtin };
}

function mergeBuiltinModels(models = []) {
    const merged = new Map(getBuiltinModels().map(model => [model.id, model]));
    models.forEach(model => {
        const builtin = merged.get(model.id);
        merged.set(model.id, {
            ...(builtin || {}),
            ...model,
            placement_level: (model.asset_type || builtin?.asset_type) === 'environment' ? 'factory' : (model.placement_level || builtin?.placement_level || 'device'),
            is_builtin: !!builtin || !!model.is_builtin
        });
    });
    return Array.from(merged.values()).map(withMissingInspectionDefaults).map(withMotionPackage);
}

// Upgrade only the known, previously empty CAD preset at read time. No database
// rewrite: authored layouts, PLC bindings and replacement uploads remain intact.
function withMissingInspectionDefaults(model) {
    if (model.id !== 'cad_tempering_furnace_091300') return model;
    const builtin = getBuiltinModels().find(item => item.id === model.id);
    if (!builtin || model.file_path !== builtin.file_path || !builtinMotionForModel(model)) return model;
    try {
        const metadata = typeof model.metadata === 'string' ? JSON.parse(model.metadata) : model.metadata;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return model;
        const inspection = metadata.inspection;
        if (inspection != null && (typeof inspection !== 'object' || Array.isArray(inspection))) return model;
        if (inspection?.parts !== undefined && (!Array.isArray(inspection.parts) || inspection.parts.length)) return model;
        const defaults = JSON.parse(builtin.metadata);
        if (metadata.sourceAsset?.sha256 && metadata.sourceAsset.sha256 !== defaults.sourceAsset.sha256) return model;
        const shell = inspection?.shell;
        const hasShell = shell && ['node_path', 'node_name', 'node_paths', 'node_names'].some(key => shell[key]?.length);
        if (hasShell) return model; // A shell-only authored document is not the old empty preset.
        const next = { ...metadata, inspection: { ...defaults.inspection, ...inspection,
            offset_space: 'model', parts: defaults.inspection.parts,
            shell: hasShell ? shell : { ...defaults.inspection.shell, ...shell, node_names: defaults.inspection.shell.node_names } } };
        return { ...model, metadata: typeof model.metadata === 'string' ? JSON.stringify(next) : next };
    } catch { return model; }
}

module.exports = {
    builtinMotionForModel,
    getBuiltinModels,
    mergeBuiltinModels
};
