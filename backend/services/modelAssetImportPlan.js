'use strict';
// Import decisions are re-derived on the server. A client can confirm an update,
// never choose an unchecked target or bypass the non-action identity checks.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { normalizeModelMetadata } = require('./modelAssetMetadata');
const { canonicalJson, exactTextEquals, exactJsonEquals } = require('./deviceInspection');
const { normalizeInspection } = require('../../shared/inspectionConfig.cjs');
const { mergeBuiltinModels } = require('./builtinModels');
const { findDuplicateModel, fileHash, normalizeMetadata } = require('./modelDuplicates');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
const conflict = message => Object.assign(new Error(message), { statusCode: 409, code: 'IMPORT_PLAN_STALE' });
function revision(model) {
    return sha(canonicalJson({ id: model.id, name: model.name, factoryId: model.factory_id ?? null, file: model.file_path,
        scale: model.default_scale, type: model.asset_type, level: model.placement_level, tags: model.tags,
        thumbnail: model.thumbnail, metadata: parse(model.metadata) }));
}
function nonActionIdentity(model, options = {}) {
    const raw = parse(model.metadata), metadata = normalizeMetadata({ ...model, metadata: { ...raw, motionAuthoring: undefined } }, null, options);
    // Automatically generated zero-offset inspection parts only mirror bindings;
    // an independent hand-authored layout is always part of model identity.
    if (!raw.inspection || canonicalJson(metadata.inspection) === canonicalJson(normalizeInspection({}, normalizeModelMetadata(raw).partBindings)))
        metadata.inspection = normalizeInspection({});
    delete metadata.partBindings; delete metadata.motionAuthoring;
    delete metadata.runtime.enableGenericBindings;
    const authoring = raw.motionAuthoring;
    if (authoring) {
        const { version, actions, bundle, ...extensions } = authoring;
        if (bundle) {
            const { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, actions: compiledActions, ...extra } = bundle;
            if (Object.keys(extra).length) extensions.bundle = extra;
        }
        if (Object.keys(extensions).length) metadata.motionAuthoring = extensions;
    }
    const tags = typeof model.tags === 'string' ? JSON.parse(model.tags || '[]') : model.tags || [];
    return canonicalJson({ type: model.asset_type || 'model', level: model.asset_type === 'environment' ? 'factory' : model.placement_level || 'device',
        scale: Number(model.default_scale || 1), tags: tags.filter(tag => tag !== 'packaged').sort(), metadata });
}
async function visibleModels(db, factoryId) {
    const records = await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id = ?', [factoryId]);
    return { records, models: mergeBuiltinModels(records).filter(model => model.factory_id == null || model.factory_id === factoryId) };
}
function bindingIdentity(model) {
    const metadata = normalizeModelMetadata(model.metadata, { name: model.name });
    return canonicalJson({ bindings: metadata.partBindings, enabled: metadata.runtime.enableGenericBindings });
}
async function sameIncomingActions(model, asset) {
    if (bindingIdentity(model) !== bindingIdentity(asset.manifest.model)) return false;
    const raw = parse(model.metadata), incoming = asset.manifest.model.metadata;
    if ((asset.data || Object.hasOwn(incoming, 'motionAuthoring')) && canonicalJson({ actions: raw.motionAuthoring?.actions || [] }) !== canonicalJson({ actions: incoming.motionAuthoring?.actions || [] })) return false;
    // Omitted compiled clips preserve the current model's existing clip assets.
    if (!asset.data) return true;
    const motion = model.motion_package || raw.motionAuthoring?.bundle;
    if (!motion || motion.rigSha256 !== sha(asset.entries.get('motion.glb'))) return false;
    const oldData = JSON.parse(fs.readFileSync(require('./motionAuthoring').localFile(motion.clipPath)));
    const { modelId: oldId, ...oldContent } = oldData, { modelId: incomingId, ...newContent } = asset.data;
    return canonicalJson(oldContent) === canonicalJson(newContent);
}
async function decideImport(db, asset, factoryId) {
    const incoming = asset.manifest.model, duplicate = await findDuplicateModel(db, incoming, factoryId, asset);
    if (duplicate) return { decision: { kind: 'reuse', targetId: duplicate.id, targetName: duplicate.name, revision: revision(duplicate) }, target: duplicate };
    const { records, models } = await visibleModels(db, factoryId), sourceHash = sha(asset.entries.get('model.glb'));
    const options = { ignoreLoadingPorts: !Object.hasOwn(incoming.metadata, 'loadingPorts') }, identity = nonActionIdentity(incoming, options), candidates = [];
    for (const model of models) {
        try {
            if (await fileHash(model.file_path) !== sourceHash || nonActionIdentity(model, options) !== identity) continue;
            const motion = model.motion_package || parse(model.metadata).motionAuthoring?.bundle;
            if (motion) {
                // Check the complete old asset before offering to update it.
                await require('./modelDuplicates').fingerprintModel(model);
                if (asset.data && motion.rigSha256 !== sha(asset.entries.get('motion.glb'))) continue;
            }
            candidates.push(model);
        } catch { /* Missing/corrupt assets are never update candidates. */ }
    }
    const lineage = candidates.filter(model => model.id === incoming.id || parse(model.metadata).assetImport?.sourceModelId === incoming.id);
    const exactId = lineage.find(model => model.id === incoming.id);
    const eligible = exactId ? [exactId] : lineage.length ? lineage : candidates;
    if (eligible.length > 1) throw Object.assign(new Error('发现多个同源模型，无法安全确定动作更新对象；请先在模型库核对后重新导出'), { statusCode: 409, code: 'IMPORT_TARGET_AMBIGUOUS' });
    if (!eligible.length) return { decision: { kind: 'create' } };
    const target = eligible[0], record = records.find(row => row.id === target.id) || null;
    if (await sameIncomingActions(target, asset)) return { decision: { kind: 'reuse', targetId: target.id, targetName: target.name, revision: revision(target) }, target };
    if (!asset.data && Object.hasOwn(incoming.metadata, 'motionAuthoring')
        && canonicalJson({ actions: parse(target.metadata).motionAuthoring?.actions || [] }) !== canonicalJson({ actions: incoming.metadata.motionAuthoring?.actions || [] }))
        throw Object.assign(new Error('动作配方变更缺少配套动作文件，请重新导出完整动作包'), { statusCode: 400 });
    return { decision: { kind: 'update_actions', targetId: target.id, targetName: target.name, revision: revision(target),
        shared: target.factory_id == null, bindingCount: normalizeModelMetadata(incoming.metadata).partBindings.length }, target, record };
}
function confirmDecision(actual, confirmed) {
    if (!confirmed) {
        if (actual.kind === 'update_actions') throw Object.assign(new Error('同源模型已存在，请先检查并确认更新其部件动作，不会再新建重复模型'), { statusCode: 409, code: 'IMPORT_CONFIRMATION_REQUIRED' });
        return;
    }
    if (!['create', 'reuse', 'update_actions'].includes(confirmed.kind) || confirmed.kind !== actual.kind
        || (actual.kind !== 'create' && (confirmed.targetId !== actual.targetId || confirmed.revision !== actual.revision)))
        throw conflict('模型在检查后已改变，请重新检查动作包再确认导入');
}
async function saveActionUpdate(tx, target, record, metadata, factoryId, dialect) {
    let result;
    if (record) {
        const originalMetadata = ['mysql', 'postgres'].includes(dialect) ? canonicalJson(record.metadata) : record.metadata ?? '';
        result = await tx.run(`UPDATE models SET metadata = ? WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)
            AND ${record.factory_id == null ? 'factory_id IS NULL' : exactTextEquals('factory_id', dialect)}
            AND ${exactJsonEquals('metadata', dialect)} AND ${exactTextEquals('file_path', dialect)}
            AND ${exactTextEquals('name', dialect)} AND ${exactTextEquals('tags', dialect)}
            AND ${record.thumbnail == null ? 'thumbnail IS NULL' : exactTextEquals('thumbnail', dialect)}
            AND ${exactTextEquals('placement_level', dialect)} AND ${exactTextEquals('asset_type', dialect)}
            AND ${record.default_scale == null ? 'default_scale IS NULL' : 'default_scale = ?'}`,
        [metadata, target.id, factoryId, ...(record.factory_id == null ? [] : [record.factory_id]), originalMetadata, record.file_path ?? '', record.name ?? '',
            record.tags ?? '', ...(record.thumbnail == null ? [] : [record.thumbnail]), record.placement_level ?? '', record.asset_type ?? '', ...(record.default_scale == null ? [] : [record.default_scale])]);
    } else {
        // A packaged/shared model is materialized once under its original ID.
        result = await tx.insertIgnore('models', { id: target.id, name: target.name, file_path: target.file_path, factory_id: null,
            asset_type: target.asset_type || 'model', placement_level: target.placement_level || 'device', tags: target.tags || '[]',
            thumbnail: target.thumbnail || null, default_scale: Number(target.default_scale || 1), metadata }, 'id');
    }
    if (!result?.affectedRows && !result?.changes) throw conflict('模型已被其他编辑修改，请重新检查动作包');
}
module.exports = { decideImport, confirmDecision, visibleModels, revision, saveActionUpdate, nonActionIdentity };
