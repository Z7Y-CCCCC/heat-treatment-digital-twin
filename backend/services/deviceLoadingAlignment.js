const { loadDeviceLoadingPorts } = require('./loadingPorts');
const { canonicalJson, exactJsonEquals, exactTextEquals } = require('./deviceInspection');
const { normalizeLineLayout } = require('../utils/spatialLayout');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'LOADING_ALIGNMENT_INVALID' });
const conflict = () => Object.assign(error('预览来源已更新，请重新预览后确认；未修改任何设备', 409), { code: 'LOADING_ALIGNMENT_CONFLICT' });
const numeric = ['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale'];
const text = ['model_type', 'model_file', 'line_id', 'coordinate_space'];
const expectedFields = [...numeric, ...text, 'instance_config'];
const modelFields = ['id', 'file_path', 'default_scale', 'metadata'];
function fields(value, allowed, label) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) throw error(`${label}字段无效或缺少来源快照`);
}
function id(value) { return typeof value === 'string' && value.length > 0 && value.length <= 120; }
function validateLoadingAlignment(body) {
    fields(body, ['mode', 'devices', 'expectedLine'], '对齐请求');
    if (!['faces', 'heights'].includes(body.mode)) throw error('对齐模式必须为 faces 或 heights');
    if (!Array.isArray(body.devices) || !body.devices.length || body.devices.length > 200) throw error('请选择 1–200 台设备');
    fields(body.expectedLine, ['id', 'workshop_id', 'layout_json'], '产线快照');
    if (!id(body.expectedLine.id) || !id(body.expectedLine.workshop_id)) throw error('产线来源 ID 无效');
    // Parse before normalization: malformed JSON must never become a default line.
    canonicalJson(body.expectedLine.layout_json);
    const ids = new Set();
    for (const row of body.devices) {
        fields(row, ['id', 'position', 'expected', 'expectedModel'], '设备对齐');
        if (!id(row.id) || ids.has(row.id)) throw error('设备 ID 无效或重复');
        ids.add(row.id);
        if (typeof row.position !== 'number' || !Number.isFinite(row.position) || Math.abs(row.position) > 100000) throw error('对齐位置必须为有限数字且绝对值不能超过 100000');
        fields(row.expected, expectedFields, '设备快照');
        if (numeric.some(key => typeof row.expected[key] !== 'number' || !Number.isFinite(row.expected[key])) || row.expected.scale <= 0) throw error('设备来源数值必须为有限数字');
        if (text.some(key => row.expected[key] !== null && typeof row.expected[key] !== 'string') || row.expected.coordinate_space !== 'line_local') throw error('只能对齐同产线本地坐标的设备');
        canonicalJson(row.expected.instance_config);
        fields(row.expectedModel, modelFields, '模型快照');
        if (!id(row.expectedModel.id) || typeof row.expectedModel.file_path !== 'string' || !row.expectedModel.file_path
            || typeof row.expectedModel.default_scale !== 'number' || !Number.isFinite(row.expectedModel.default_scale) || row.expectedModel.default_scale <= 0) throw error('模型来源快照无效');
        canonicalJson(row.expectedModel.metadata);
    }
}
async function saveLoadingAlignment(tx, body, factoryId, dialect) {
    validateLoadingAlignment(body);
    const line = await tx.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [body.expectedLine.id, factoryId]);
    if (!line) throw error('产线不存在或不属于当前工厂', 404);
    if (line.workshop_id !== body.expectedLine.workshop_id || canonicalJson(normalizeLineLayout(line.layout_json)) !== canonicalJson(normalizeLineLayout(body.expectedLine.layout_json))) throw conflict();
    const jsonParam = value => ['mysql', 'postgres'].includes(dialect) ? canonicalJson(value) : value ?? '';
    const loadedRows = [];
    for (const row of body.devices) {
        const loaded = await loadDeviceLoadingPorts(tx, row.id, factoryId);
        const device = loaded.device;
        if (device.coordinate_space !== 'line_local' || ![device.line_id, loaded.instance.railLineId, loaded.instance.laneLineId].includes(line.id)) throw error('设备不属于当前产线的同一本地坐标系');
        if (expectedFields.some(key => key === 'instance_config' ? canonicalJson(device[key]) !== canonicalJson(row.expected[key]) : device[key] !== row.expected[key])) throw conflict();
        if (loaded.model.id !== row.expectedModel.id || loaded.model.file_path !== row.expectedModel.file_path
            || Number(loaded.model.default_scale) !== row.expectedModel.default_scale || canonicalJson(loaded.model.metadata) !== canonicalJson(row.expectedModel.metadata)) throw conflict();
        loadedRows.push({ row, loaded });
    }
    const positionColumn = body.mode === 'faces' ? 'pos_z' : 'pos_y';
    for (const { row, loaded } of loadedRows) {
        const device = loaded.device;
        const predicates = text.map(column => exactTextEquals(column, dialect)).concat(exactJsonEquals('instance_config', dialect));
        const params = [row.position, row.id, ...text.map(column => device[column] ?? ''), jsonParam(device.instance_config)];
        for (const column of numeric) { predicates.push(`${column}=?`); params.push(device[column]); }
        predicates.push(`EXISTS (SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?
            AND ${exactTextEquals('l.workshop_id', dialect)} AND ${exactJsonEquals('l.layout_json', dialect)})`);
        params.push(line.id, factoryId, line.workshop_id, jsonParam(line.layout_json));
        if (loaded.record) {
            const record = loaded.record;
            predicates.push(`EXISTS (SELECT 1 FROM models WHERE id=? AND (factory_id IS NULL OR factory_id=?)
                AND ${exactTextEquals('file_path', dialect)} AND ${exactJsonEquals('metadata', dialect)}
                AND ${exactTextEquals('placement_level', dialect)} AND ${exactTextEquals('asset_type', dialect)}
                AND ${record.default_scale == null ? 'default_scale IS NULL' : 'default_scale=?'})`);
            params.push(record.id, factoryId, record.file_path ?? '', jsonParam(record.metadata), record.placement_level ?? '', record.asset_type ?? '');
            if (record.default_scale != null) params.push(record.default_scale);
        } else {
            predicates.push('NOT EXISTS (SELECT 1 FROM models WHERE id=? AND (factory_id IS NULL OR factory_id=?))');
            params.push(loaded.model.id, factoryId);
        }
        const result = await tx.run(`UPDATE devices SET ${positionColumn}=? WHERE id=? AND ${predicates.join(' AND ')}`, params);
        if (!result?.changes && !result?.affectedRows) throw conflict();
    }
    const devices = [];
    for (const { row } of loadedRows) devices.push(await tx.get('SELECT * FROM devices WHERE id=?', [row.id]));
    return devices;
}
module.exports = { validateLoadingAlignment, saveLoadingAlignment };
