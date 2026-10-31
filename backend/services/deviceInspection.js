const crypto = require('node:crypto');
const { mergeBuiltinModels } = require('./builtinModels');
const { normalizeInspection, validateInspection } = require('../../shared/inspectionConfig.cjs');

const MAX_LAYOUT_PARTS = 64;
const MAX_LAYOUT_COMPONENT = 100000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

function inspectionError(message, statusCode = 400, code = 'DEVICE_INSPECTION_INVALID') {
    return Object.assign(new Error(message), { statusCode, code });
}

function parseObject(value, label) {
    if (value === undefined || value === null || value === '') return {};
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); }
        catch { throw inspectionError(`${label} JSON 格式不正确，未修改原配置`); }
    }
    if (!isObject(parsed)) throw inspectionError(`${label}必须是对象，未修改原配置`);
    return clone(parsed);
}

// Matches Unity's JObject merge: nested objects merge, arrays replace, nulls
// never erase authored values. Keep extension metadata rather than serializing
// only the recognized inspection schema.
function mergeInspectionObjects(base, override) {
    const result = clone(base);
    for (const [key, value] of Object.entries(override)) {
        if (value === null || value === undefined) continue;
        const next = isObject(value) && isObject(result[key])
            ? mergeInspectionObjects(result[key], value) : clone(value);
        Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
    }
    return result;
}

function effectiveInspection(metadata, instance) {
    const modelInspection = isObject(metadata.inspection) ? metadata.inspection : {};
    const override = isObject(instance.inspection) ? instance.inspection : {};
    const raw = mergeInspectionObjects(modelInspection, override);
    const canonical = normalizeInspection(raw, metadata.partBindings || []);
    const inspection = mergeInspectionObjects(raw, canonical);
    // Arrays intentionally replace; merge part extension fields by ordinal only
    // because canonical parts preserve the authored ordering and identifiers.
    inspection.parts = canonical.parts.map((part, index) => mergeInspectionObjects(
        isObject(raw.parts?.[index]) ? raw.parts[index] : {}, part
    ));
    return { raw, inspection };
}

function legacyRevisionFor(device, model) {
    return crypto.createHash('sha256').update(JSON.stringify([
        device.id, device.line_id, device.model_type, device.model_file, device.instance_config,
        model.id, model.file_path, model.metadata
    ])).digest('hex');
}

// MySQL JSON columns are decoded as objects and normalize key ordering/spacing.
// Hash the JSON value, not a driver's object-vs-string representation.
function canonicalJson(value) {
    const parsed = parseObject(value, '拆解版本配置');
    const sort = item => Array.isArray(item) ? item.map(sort) : isObject(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
    return JSON.stringify(sort(parsed));
}
function revisionFor(device, model) {
    return legacyRevisionFor({ ...device, instance_config: canonicalJson(device.instance_config) },
        { ...model, metadata: canonicalJson(model.metadata) });
}

async function loadDeviceInspection(db, device, factoryId) {
    const records = await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id = ?', [factoryId]);
    const models = mergeBuiltinModels(records);
    const type = String(device.model_type || '').toLowerCase();
    const model = models.find(item => String(item.id).toLowerCase() === type)
        || models.find(item => device.model_file && item.file_path === device.model_file);
    if (!model || model.placement_level !== 'device' || model.asset_type === 'environment') {
        throw inspectionError('设备模型不存在或不是设备级模型', 404, 'DEVICE_INSPECTION_MODEL_NOT_FOUND');
    }
    const instance = parseObject(device.instance_config, '设备实例配置');
    const metadata = parseObject(model.metadata, '模型元数据');
    if (Object.hasOwn(instance, 'inspection') && instance.inspection !== null && !isObject(instance.inspection)) {
        throw inspectionError('设备拆解配置必须是对象，未修改原配置');
    }
    const { raw, inspection } = effectiveInspection(metadata, instance);
    return {
        instance, raw, inspection, model,
        record: records.find(item => item.id === model.id) || null,
        revision: revisionFor(device, model),
        // A currently open older frontend can finish its pending save safely.
        legacyRevision: legacyRevisionFor(device, model),
        assetRevision: crypto.createHash('sha256').update(JSON.stringify([model.id, device.model_file || model.file_path])).digest('hex'),
        source: isObject(instance.inspection) ? 'device' : 'model',
        modelId: model.id
    };
}

function publicInspection(loaded) {
    return {
        inspection: loaded.inspection,
        revision: loaded.revision,
        source: loaded.source,
        assetRevision: loaded.assetRevision,
        modelId: loaded.modelId
    };
}

function patchDeviceInspectionLayout(loaded, body) {
    if (!isObject(body)) throw inspectionError('拆解布局请求必须是对象');
    if (Object.keys(body).some(key => !['revision', 'parts', 'enabled'].includes(key))) {
        throw inspectionError('布局保存只允许 revision、parts、enabled，不可改变绑定或坐标系');
    }
    if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) {
        throw inspectionError('保存需要读取时的 revision', 428, 'DEVICE_INSPECTION_REVISION_REQUIRED');
    }
    if (body.revision !== loaded.revision && body.revision !== loaded.legacyRevision) {
        throw inspectionError('设备或模型配置已更新，请重新加载后保存', 409, 'DEVICE_INSPECTION_CONFLICT');
    }
    if (!Array.isArray(body.parts) || body.parts.length > MAX_LAYOUT_PARTS) {
        throw inspectionError(`parts 必须是数组且不能超过 ${MAX_LAYOUT_PARTS} 项`);
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw inspectionError('enabled 必须为布尔值');
    const validation = validateInspection(loaded.raw);
    if (!validation.valid) throw inspectionError(`原拆解配置不合法：${validation.errors.map(item => item.message).join('；')}`);
    const partsById = new Map(loaded.inspection.parts.map(part => [part.id, part]));
    const patches = new Map();
    for (const patch of body.parts) {
        if (!isObject(patch) || Object.keys(patch).some(key => !['id', 'explode_offset'].includes(key))) {
            throw inspectionError('部件布局只允许 id 和 explode_offset');
        }
        if (typeof patch.id !== 'string' || !partsById.has(patch.id)) throw inspectionError('布局引用了不存在的部件');
        if (patches.has(patch.id)) throw inspectionError(`部件重复：${patch.id}`);
        const vector = patch.explode_offset;
        if (!Array.isArray(vector) || vector.length !== 3 || vector.some(value => (
            typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_LAYOUT_COMPONENT
        ))) throw inspectionError(`部件 ${patch.id} 的 explode_offset 必须是三个有限数字，绝对值不能超过 ${MAX_LAYOUT_COMPONENT}`);
        patches.set(patch.id, [...vector]);
    }
    // Defaults/canonical aliases make a complete instance override, but retain
    // the originally authored (unchanged) scalar values and extension fields.
    // A drag must not normalize somebody else's timing, camera or rotation edit.
    const next = mergeInspectionObjects(loaded.inspection, loaded.raw);
    // Persist the COMPLETE parts array. Unity replaces instance parts instead of
    // merging by ID, so storing only dragged parts would silently delete others.
    next.parts = loaded.inspection.parts.map((part, index) => {
        const authored = mergeInspectionObjects(part, isObject(loaded.raw.parts?.[index]) ? loaded.raw.parts[index] : {});
        return patches.has(part.id) ? { ...authored, explode_offset: patches.get(part.id) } : authored;
    });
    if (body.enabled !== undefined) next.enabled = body.enabled;
    return { ...loaded.instance, inspection: next };
}

// MySQL's normal text collation can equate old/new JSON differing only by case;
// optimistic compare-and-swap must compare bytes, not collation-folded strings.
function exactTextEquals(column, dialect) {
    const value = `COALESCE(${column}, '')`;
    if (dialect === 'mysql') return `CAST(${value} AS BINARY) = CAST(? AS BINARY)`;
    if (dialect === 'sqlserver') return `CONVERT(varbinary(max), ${value}) = CONVERT(varbinary(max), ?)`;
    if (dialect === 'sqlite') return `${value} = ? COLLATE BINARY`;
    return `${value} = ?`;
}

function exactJsonEquals(column, dialect) {
    if (dialect === 'mysql') {
        // Native JSON equality preserves case and array order, but ignores
        // display whitespace/key order and equal numeric forms (1.0 vs 1).
        return `JSON_EXTRACT(COALESCE(NULLIF(NULLIF(CAST(${column} AS CHAR), ''), 'null'), '{}'), '$') = JSON_EXTRACT(?, '$')`;
    }
    if (dialect === 'postgres') return `COALESCE(NULLIF(${column}::jsonb, 'null'::jsonb), '{}'::jsonb) = CAST(? AS jsonb)`;
    return exactTextEquals(column, dialect);
}

async function saveDeviceInspectionLayout(tx, device, loaded, nextInstance, factoryId, dialect) {
    const serialized = JSON.stringify(nextInstance);
    const columns = ['instance_config', 'model_type', 'model_file', 'line_id'];
    const predicates = columns.map(column => column === 'instance_config' ? exactJsonEquals(column, dialect) : exactTextEquals(column, dialect));
    const jsonParameter = value => ['mysql', 'postgres'].includes(dialect) ? canonicalJson(value) : value ?? '';
    const params = [serialized, device.id, ...columns.map(column => column === 'instance_config' ? jsonParameter(device[column]) : device[column] ?? '')];
    if (loaded.record) {
        predicates.push(`EXISTS (SELECT 1 FROM models WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)
            AND ${exactJsonEquals('metadata', dialect)} AND ${exactTextEquals('file_path', dialect)})`);
        params.push(loaded.model.id, factoryId, jsonParameter(loaded.record.metadata), loaded.record.file_path ?? '');
    } else {
        predicates.push('NOT EXISTS (SELECT 1 FROM models WHERE id = ? AND (factory_id IS NULL OR factory_id = ?))');
        params.push(loaded.model.id, factoryId);
    }
    const result = await tx.run(`UPDATE devices SET instance_config = ? WHERE id = ? AND ${predicates.join(' AND ')}`, params);
    if (!result?.affectedRows && !result?.changes) {
        throw inspectionError('设备或模型配置已更新，请重新加载后保存', 409, 'DEVICE_INSPECTION_CONFLICT');
    }
    const inspection = effectiveInspection(parseObject(loaded.model.metadata, '模型元数据'), nextInstance).inspection;
    return { ...loaded, instance: nextInstance, inspection,
        revision: revisionFor({ ...device, instance_config: serialized }, loaded.model), source: 'device' };
}

module.exports = { loadDeviceInspection, publicInspection, patchDeviceInspectionLayout,
    saveDeviceInspectionLayout, effectiveInspection, exactTextEquals, exactJsonEquals, canonicalJson };
