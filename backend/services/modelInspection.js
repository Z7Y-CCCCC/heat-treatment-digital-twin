const crypto = require('node:crypto');
const { mergeBuiltinModels } = require('./builtinModels');
const { effectiveInspection, canonicalJson, patchDeviceInspectionLayout, exactTextEquals, exactJsonEquals } = require('./deviceInspection');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => Object.assign(new Error('模型配置已更新，请重新读取后保存'), { statusCode: 409, code: 'MODEL_INSPECTION_CONFLICT' });

async function loadModelInspection(db, id, factoryId) {
    const records = await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id = ?', [factoryId]);
    const model = mergeBuiltinModels(records).find(item => item.id === id);
    if (!model || (model.placement_level || 'device') !== 'device' || model.asset_type === 'environment' || !model.file_path) {
        throw Object.assign(new Error('设备模型不存在'), { statusCode: 404, code: 'MODEL_INSPECTION_NOT_FOUND' });
    }
    const metadata = JSON.parse(canonicalJson(model.metadata));
    const { raw, inspection } = effectiveInspection(metadata, {});
    return { model, metadata, raw, inspection, instance: metadata, record: records.find(item => item.id === id) || null,
        revision: hash([id, model.file_path, model.placement_level, model.asset_type, model.factory_id, model.default_scale, canonicalJson(metadata)]),
        assetRevision: hash([id, model.file_path]), source: 'model', modelId: id };
}

function patchModelInspectionLayout(loaded, body) {
    try { return patchDeviceInspectionLayout(loaded, body); }
    catch (error) {
        if (error.code === 'DEVICE_INSPECTION_CONFLICT') throw conflict();
        if (error.code?.startsWith('DEVICE_INSPECTION_')) error.code = error.code.replace('DEVICE_', 'MODEL_');
        throw error;
    }
}

async function saveModelInspectionLayout(tx, loaded, metadata, factoryId, dialect) {
    const serialized = JSON.stringify(metadata);
    let result;
    if (loaded.record) {
        const original = loaded.record;
        const json = ['mysql', 'postgres'].includes(dialect) ? canonicalJson(original.metadata) : original.metadata ?? '';
        result = await tx.run(`UPDATE models SET metadata = ? WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)
            AND ${exactJsonEquals('metadata', dialect)} AND ${exactTextEquals('file_path', dialect)}
            AND ${exactTextEquals('placement_level', dialect)} AND ${exactTextEquals('asset_type', dialect)}
            AND ${original.default_scale == null ? 'default_scale IS NULL' : 'default_scale=?'}`,
        [serialized, loaded.model.id, factoryId, json, original.file_path ?? '', original.placement_level ?? '', original.asset_type ?? '',
            ...(original.default_scale == null ? [] : [original.default_scale])]);
    } else {
        const model = loaded.model;
        // Materialize only the packaged model being edited; never upsert over
        // another factory's row or replace a concurrent editor's metadata.
        result = await tx.insertIgnore('models', { id: model.id, name: model.name, file_path: model.file_path,
            factory_id: null, placement_level: 'device', asset_type: model.asset_type || 'model', tags: model.tags || '[]',
            thumbnail: model.thumbnail || null, default_scale: Number(model.default_scale || 1), metadata: serialized }, 'id');
    }
    if (!result?.affectedRows && !result?.changes) throw conflict();
    return loadModelInspection(tx, loaded.model.id, factoryId);
}

module.exports = { loadModelInspection, patchModelInspectionLayout, saveModelInspectionLayout };
