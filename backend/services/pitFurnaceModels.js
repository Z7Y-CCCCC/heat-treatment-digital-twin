// Editable defaults for the existing runtime inspection contract, not a new renderer.
const fs = require('node:fs');
const path = require('node:path');
const { createInspectionDefaults, normalizeInspection, validateInspection } = require('../../shared/inspectionConfig.cjs');

const ROOT = path.resolve(__dirname, '../assets/models/pit_furnace_references_v1');
const NOTE = 'CAD截图重建总成，细部完整性尚未验收；拆解仅用于大屏展示，不代表真实维修顺序。';

function readDocument(filename) {
    const file = fs.readFileSync(filename);
    if (file.toString('ascii', 0, 4) !== 'glTF' || file.readUInt32LE(4) !== 2 || file.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Invalid GLB: ${filename}`);
    return JSON.parse(file.toString('utf8', 20, 20 + file.readUInt32LE(12)));
}

function nodeRecords(document) {
    const result = [];
    function walk(index, ordinal, parentPath = '') {
        const node = document.nodes[index];
        const segment = `${(node.name || 'Object3D').replaceAll('/', '_')}#${ordinal}`;
        const nodePath = parentPath ? `${parentPath}/${segment}` : segment;
        result.push({ name: node.name, path: nodePath, parentPath, isMesh: node.mesh !== undefined });
        (node.children || []).forEach((child, i) => walk(child, i, nodePath));
    }
    document.scenes[document.scene || 0].nodes.forEach((index, ordinal) => walk(index, ordinal));
    return result;
}

function specifications(number) {
    if (number === 1 || number === 4) return {
        shell: ['external_cover_front'],
        parts: [
            ['chassis', '台车底架', ['mobile_chassis'], [0, 0, 0], '结构参照'],
            ['left_wheels', '左端轮组', ['wheel_00', 'wheel_02'], [-1.4, -.05, 0], '行走机构'],
            ['right_wheels', '右端轮组', ['wheel_01', 'wheel_03'], [1.4, -.05, 0], '行走机构'],
            ['transfer', '移载与传动总成', ['transfer_extension'], [number === 1 ? 2.7 : -2.7, .2, 0], '移载机构'],
            ['guards', '底部围护杆件', ['base_guardrails'], [0, .2, 2.4], '外部配套'],
            ['casing', '炉体外壳与吊耳', ['insulated_casing', 'lifting_lugs'], [0, .25, -3.1], '炉体结构'],
            ['lining', '保温炉衬', ['refractory_lining'], [-2.3, .25, -1.5], '炉体结构'],
            ...(number === 4 ? [['heaters', '加热构件组', ['electric_heater_banks'], [2.3, .3, -1.5], '炉内机构']] : []),
            ['fixture', '悬挂工装与连接杆', ['suspended_fixture', 'fixture_hangers'], [0, .3, 1.7], '悬挂机构'],
            ['lift_drive', '顶部升降驱动总成', ['top_lift_drive'], [0, 1.6, -.6], '顶部机构'],
            ['spring_bridge', '弹簧与横梁组件', ['upper_spring_bridge'], [1.8, 1, .8], '顶部机构'],
            ...(number === 1 ? [['services', '管路及阀件总成', ['gas_and_service_pipework'], [2.5, .2, -1.2], '管路配套']] : [])
        ]
    };
    if (number === 2) return {
        shell: ['external_cover_front', 'external_cover_hood'],
        parts: [
            ['well', '炉井与肩部腔体', ['well_structure', 'upper_shoulder_chamber'], [0, 0, 0], '结构参照'],
            ['hood', '顶部罩体', ['lid_hood_shell'], [0, 1.5, -.6], '顶部结构'],
            ['lift', '左侧提升支架', ['left_lid_lift_standard'], [-1.8, .2, -.5], '提升机构'],
            ['duct', '右上风道及端部组件', ['right_upper_air_duct'], [1.7, .3, -.5], '外部配套'],
            ['bridge', '上部导向与弹簧组件', ['upper_internal_support_bridge'], [0, 1, .8], '悬挂机构'],
            ['fixture', '悬挂工装（深度结构估算）', ['suspended_fixture'], [0, .2, 1.9], '悬挂机构'],
            ['fan', '底部循环组件（叶轮示意）', ['bottom_circulation_fan', 'bottom_circulation_impeller'], [1.6, .3, 1.5], '底部机构'],
            ['feed', '左侧服务管路', ['left_service_feed'], [-1.5, .2, 1.2], '管路配套']
        ]
    };
    if (number === 3) return {
        shell: ['external_cover_f3_front_shell', 'external_cover_f3_reservoir_front'],
        parts: [
            ['frame', '固定底座与支架', ['f3_fixed_base_and_tower_frame'], [0, 0, 0], '结构参照'],
            ['casing', '上宽下窄炉壳', ['f3_T_shoulder_enclosure'], [0, .2, -2.5], '炉体结构'],
            ['lining', '炉壁与内衬', ['f3_thick_section_walls_and_rear_lining'], [-2.1, .2, -1.1], '炉体结构'],
            ['fixture', '悬挂工装（深度结构估算）', ['f3_suspended_inner_workpiece_cage'], [0, .2, 1.9], '悬挂机构'],
            ['guide', '上部导向与弹簧组件', ['f3_upper_internal_guide'], [0, 1.2, 0], '顶部机构'],
            ['reservoir', '左下箱体与泵组', ['f3_low_left_reservoir_and_pump'], [-1.8, .1, .6], '泵组配套'],
            ['pump', '底部中央泵组', ['f3_lower_center_pump'], [1.4, .3, 1.4], '泵组配套'],
            ['pipes', '外露工艺管路', ['f3_exposed_process_pipework'], [-1.2, .4, 1.8], '管路配套'],
            ['gauges', '右上仪表与连接管', ['f3_upper_right_double_gauge'], [1.7, .8, -.5], '仪表配套']
        ]
    };
    return {
        shell: ['f5_opaque_solid_main_body'],
        parts: [
            ['base', '柜体承重底座', ['f5_cabinet_support_base'], [0, 0, 0], '结构参照'],
            ['cabinet', '完整厚柜体与保温层', ['f5_insulated_cabinet_shell'], [3.3, .1, -.9], '柜体结构'],
            ['frame', '正面立柱、横梁与紧固件', ['f5_two_column_panel_frame', 'f5_panel_fasteners'], [-2.7, .1, 0], '正面结构'],
            ['plate', '中央悬挂板组件', ['f5_suspended_solid_inner_plate'], [0, .3, 2.3], '悬挂机构'],
            ['guide', '顶部弹簧与滑轨总成', ['f5_exposed_upper_spring_and_slide'], [0, 1.4, -.8], '顶部机构']
        ]
    };
}

function makeModel(number) {
    const id = `pit_furnace_${number}_v1`;
    const folder = `PitFurnace${number}`;
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, folder, 'metadata.json'), 'utf8'));
    const document = readDocument(path.join(ROOT, folder, `${id}.glb`));
    const groups = new Map();
    for (const node of document.nodes) {
        const semantic = node.extras?.functional_group;
        if (!semantic) continue;
        if (groups.has(semantic)) throw new Error(`${id}: ambiguous group ${semantic}`);
        groups.set(semantic, node.name);
    }
    const names = semantics => semantics.map(semantic => {
        if (!groups.has(semantic)) throw new Error(`${id}: missing authored group ${semantic}`);
        return groups.get(semantic);
    });
    const spec = specifications(number);
    const claimed = [...spec.shell, ...spec.parts.flatMap(item => item[2])];
    if (new Set(claimed).size !== claimed.length || claimed.length !== groups.size || claimed.some(group => !groups.has(group))) throw new Error(`${id}: every functional group must belong to exactly one shell or assembly`);
    const defaults = createInspectionDefaults();
    const camera = { yaw: 38, pitch: 20, distance_scale: 1.12, target_offset: [0, 0, 0] };
    const inspection = normalizeInspection({
        ...defaults, enabled: true, offset_space: 'model', shell_duration: .8, animation_duration: 1.2, stagger: .07,
        shell: { ...defaults.shell, node_names: names(spec.shell), transition: 'clip', axis: 'y', direction: 1, opacity: .18 },
        solid: { ...defaults.solid, camera }, xray: { ...defaults.xray, camera },
        exploded: { ...defaults.exploded, camera: { ...camera, pitch: 25, distance_scale: 1.18 } },
        parts: spec.parts.map(([partId, name, targets, offset, group]) => ({
            id: `pf${number}_${partId}`, name, group, node_names: names(targets), explode_offset: offset,
            explode_rotation: [0, 0, 0], label_offset: [0, .3, 0], duration: 1.2,
            description: `${name}。${NOTE}`, point_ids: [], point_keys: [], camera: null
        }))
    });
    const validation = validateInspection(inspection, nodeRecords(document));
    if (!validation.valid) throw new Error(`${id}: invalid inspection: ${JSON.stringify(validation.errors)}`);
    const fullMetadata = {
        ...metadata, schema_version: 1, inspection,
        partBindings: [], // Do not invent PLC addresses or actuate unverified mechanisms.
        runtime: { enableInspection: true, enableGenericBindings: false },
        batchable: false,
        optimization: { mode: 'off', mergeStatic: false, instanceRepeated: false, preserveAnimated: true, materialEnhancement: 'original', contactShadow: true, environmentIntensity: .85 },
        assetSpec: { version: '1.1.0', device_family: `井式炉${number}`, unit: 'm', axis_rule: 'Y-up / Z-forward', delivery_status: 'review', notes: NOTE },
        acceptance: { status: 'review', checks: [{ id: 'cad_component_completeness', passed: false, note: '仍有部件简化和截图未确认项，未作为精细CAD版验收。' }] },
        release: { status: 'review', version: '1.1.0' },
        integration: { version: 1, inspectionContract: 2, scope: 'existing_dashboard', plcStatus: 'not_bound', note: '点击、透视、拆解、部件选择/隔离和复原沿用既有运行时；现场PLC点位需单独配置。' }
    };
    return {
        id, name: `井式炉${number}`, file_path: `/assets/models/pit_furnace_references_v1/${folder}/${id}.glb`,
        thumbnail: `/assets/models/pit_furnace_references_v1/${folder}/preview.png`,
        asset_type: 'model', placement_level: 'device', factory_id: null, default_scale: 1,
        tags: JSON.stringify(['packaged', 'inspection_v2', 'pit_furnace', 'cad_review']),
        metadata: JSON.stringify(fullMetadata), is_builtin: true
    };
}

const MODELS = [1, 2, 3, 4, 5].map(makeModel);
function getPitFurnaceModels() { return MODELS.map(model => ({ ...model })); }
function getPitInspectionPresets() {
    return MODELS.map(model => ({ id: `${model.id}_inspection_v2`, modelId: model.id, name: `${model.name} · 总成拆解`, description: NOTE, inspection: JSON.parse(model.metadata).inspection }));
}
module.exports = { getPitFurnaceModels, getPitInspectionPresets, nodeRecords };
