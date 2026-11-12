const crypto = require('node:crypto');
const { mergeBuiltinModels } = require('./builtinModels');
const { canonicalJson } = require('./deviceInspection');
const { buildCatalog, loadCatalogState, scopedDevices } = require('./dataCenter');
const { deviceLineId } = require('./deviceLineUnits');
const { buildTransferCapabilities, validateTransferSelection, publicTransferLink } = require('./transferLink');
const { modelPositionOwnership, assertMotionPositionOwnership } = require('./motionPositionOwnership');
const { listDataSets } = require('./dataSets');
const { isRetiredMotionAction } = require('../../shared/motionActionAvailability.mjs');
const groups = new Set(['analog', 'motors', 'doors', 'gas', 'mechanisms', 'status']);
const PUBLIC_BINDING_FIELDS = ['actionId','enabled','pointId','dataItemId','trigger','inputMin','inputMax','invert','speed','transitionSeconds','feedbackSmoothingMs'];
const retiredActionLabel = id => id === 'clip:process_cycle' ? '完整工艺循环' : '旧自定义动画';
function publicAnimationBinding(row) {
    const result = Object.fromEntries(PUBLIC_BINDING_FIELDS.filter(k => row[k] !== undefined).map(k => [k,row[k]]));
    if (row.trigger?.mode === 'endpoints') result.trigger = {mode:'endpoints', extended:{dataItemId:row.trigger.extended?.dataItemId || ''}, retracted:{dataItemId:row.trigger.retracted?.dataItemId || ''}};
    return result;
}
const comparisons = new Set(['eq','ne','gt','gte','lt','lte']);
const object = value => { try { const x = typeof value === 'string' ? JSON.parse(value || '{}') : value; return x && !Array.isArray(x) && typeof x === 'object' ? x : {}; } catch { return {}; } };
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sourceFingerprint = item => crypto.createHash('sha256').update(canonicalJson({ id:item.id, type:item.type,
    sourceType:item.sourceType, objectScope:item.objectScope, enabled:item.enabled, sourceReady:item.sourceReady,
    deviceId:item.deviceId, binding:item.binding, datasetRevision:item.datasetRevision })).digest('hex');
function pointType(point) {
    return String(point?.data_type || '').toUpperCase() === 'BOOL' ? 'boolean'
        : ['STRING','CHAR','DT','DTZ','DTL','DTLZ'].includes(String(point?.data_type || '').toUpperCase()) ? 'string' : 'number';
}
function validateTrigger(input, valueType, required = false) {
    if (input == null && !required) return undefined; // Old pointId rows retain the original 0–1 protocol.
    const trigger = input ?? { mode:'range' };
    if (!trigger || Array.isArray(trigger) || typeof trigger !== 'object'
        || Object.keys(trigger).some(k => !['mode','operator','value','hysteresis'].includes(k))) throw error('动作触发设置无效');
    if (trigger.mode === 'range') {
        if (valueType !== 'number') throw error('范围跟随只能选择数值数据，请使用满足条件触发');
        if (trigger.operator != null && !comparisons.has(trigger.operator) || trigger.hysteresis != null && trigger.hysteresis !== 0) throw error('范围跟随不使用条件回差');
        return { mode:'range' };
    }
    if (trigger.mode !== 'condition' || !comparisons.has(trigger.operator) || typeof trigger.value !== valueType
        || valueType === 'number' && (!Number.isFinite(trigger.value) || Math.abs(trigger.value) > 1e12)
        || valueType === 'string' && (trigger.value.length > 160 || /[\u0000-\u001f\u007f]/.test(trigger.value))) throw error('触发值必须与所选数据类型一致');
    const numericComparison = !['eq','ne'].includes(trigger.operator);
    if (numericComparison && valueType !== 'number') throw error('大小比较只能选择数值数据');
    const hysteresis = trigger.hysteresis ?? 0;
    if (typeof hysteresis !== 'number' || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 1e12
        || !numericComparison && hysteresis !== 0) throw error('回差仅用于数值大小比较，且必须为非负数');
    return { mode:'condition', operator:trigger.operator, value:trigger.value, hysteresis };
}
function validateCatalogItem(item, deviceId) {
    if (!item || item.enabled === false || item.sourceReady === false) throw error(item?.sourceError || '数据项不存在、已停用或来源尚未配置');
    if (!['number','boolean','string'].includes(item.type) || !['runtime','plc','dataset'].includes(item.binding?.mode)) throw error('该数据项不能用来驱动部件动作');
    if (item.objectScope === 'part') throw error('部件资料需要悬停部件上下文，不能用作设备动作触发源');
    if (item.deviceId && String(item.deviceId) !== String(deviceId) || item.binding.mode === 'plc' && String(item.binding.deviceId) !== String(deviceId)) throw error('请选择本设备的数据项');
    if (item.binding.mode === 'runtime' && !['deviceInfo.name','deviceInfo.id','deviceInfo.modelName','deviceInfo.workshopName','deviceInfo.lineName','deviceInfo.dataStatus'].includes(item.binding.path)) throw error('设备资料字段不支持动作触发');
    return item;
}
function validateMotionSource(loaded, item) {
    validateCatalogItem(item, loaded.device.id);
    if (item.binding.mode === 'dataset') {
        const definition = loaded.datasets?.find(d => d.id === item.binding.datasetId);
        const contextKeys = new Set(['deviceId','lineId','workshopId']);
        if (!definition || definition.match && !contextKeys.has(definition.match.contextKey)
            || (definition.request?.parameters || []).some(parameter => parameter.required !== false
                && (parameter.source === 'parameter' || parameter.source === 'context' && !contextKeys.has(parameter.key)))) throw error('该数据表需要大屏参数或视角上下文，请先整理成按设备、产线或车间匹配的数据表');
        if (!deviceLineId(loaded.device, loaded.instance || object(loaded.device.instance_config)) && (definition.match?.contextKey === 'lineId'
            || (definition.request?.parameters || []).some(parameter => parameter.required !== false && parameter.source === 'context' && parameter.key === 'lineId'))) throw error('当前设备没有所属产线，不能使用要求产线参数的数据表');
    }
    if (item.binding.mode === 'plc') {
        const point = loaded.points.find(point => String(point.id) === String(item.binding.pointId));
        if (!point || String(point.access_type || 'READ').toUpperCase() !== 'READ') throw error('请选择本设备的只读采集点位');
        if (!groups.has(point.category) || !String(point.value_role || point.name || '').trim()) throw error('请先在点位映射中设置有效的点位分组和字段');
    }
    return item;
}
function endpointSourceIdentity(item, loaded) {
    const binding = item?.binding || {};
    if (binding.mode === 'plc') {
        const point = loaded?.points.find(point => String(point.id) === String(binding.pointId));
        return `plc:${binding.deviceId}:${String(point?.plc_tag || binding.pointId).trim().toLowerCase()}`;
    }
    if (binding.mode === 'dataset') {
        const definition = loaded?.datasets?.find(dataset => dataset.id === binding.datasetId), column = definition?.columns?.find(column => column.name === binding.datasetField);
        if (!definition || !column) return `dataset:${binding.datasetId}:${binding.datasetField || ''}`;
        return `dataset:${crypto.createHash('sha256').update(canonicalJson({ connection:definition.connectionId, source:definition.source,
            request:definition.request, root:definition.rootPath, database:definition.database, match:definition.match, path:column.path })).digest('hex')}`;
    }
    return '';
}
function validateEndpointSource(loaded, item) {
    validateMotionSource(loaded,item);
    if (item.type !== 'boolean' || !['plc','dataset'].includes(item.binding.mode)) throw error('到位反馈只能选择本设备的只读开关量');
    if (item.binding.mode === 'plc') {
        const point = loaded.points.find(point => String(point.id) === String(item.binding.pointId));
        if (!point || pointType(point) !== 'boolean') throw error('到位采集点位必须是 BOOL 开关量');
    } else {
        const definition = loaded.datasets?.find(dataset => dataset.id === item.binding.datasetId);
        if (definition?.match?.contextKey !== 'deviceId' && !(definition?.request?.parameters || []).some(parameter => parameter.source === 'context' && parameter.key === 'deviceId')) throw error('到位数据表必须明确按当前设备匹配或查询，不能用工厂、产线或车间的总状态');
    }
    return item;
}
function validateEndpointTrigger(loaded, trigger, enabled) {
    if (!trigger || Array.isArray(trigger) || typeof trigger !== 'object'
        || Object.keys(trigger).some(key => !['mode','extended','retracted'].includes(key)) || trigger.mode !== 'endpoints') throw error('双到位反馈设置无效');
    const values = {};
    for (const name of ['extended','retracted']) {
        const endpoint = trigger[name];
        if (!endpoint || Array.isArray(endpoint) || typeof endpoint !== 'object'
            || Object.keys(endpoint).some(key => key !== 'dataItemId') || typeof endpoint.dataItemId !== 'string' || endpoint.dataItemId.length > 100) throw error('请从数据中心选择两个到位反馈');
        values[name] = endpoint.dataItemId;
    }
    if (!enabled && !values.extended && !values.retracted) return { mode:'endpoints', extended:{dataItemId:''}, retracted:{dataItemId:''} };
    if (!values.extended || !values.retracted) throw error('推料到位和退回到位必须同时选择');
    const result = { mode:'endpoints' }, identities = [];
    for (const name of ['extended','retracted']) {
        const item = validateEndpointSource(loaded, loaded.catalog?.items.find(item => item.id === values[name]));
        const point = item.binding.mode === 'plc' ? loaded.points.find(point => String(point.id) === String(item.binding.pointId)) : null;
        identities.push(endpointSourceIdentity(item,loaded));
        result[name] = { dataItemId:item.id, sourceFingerprint:sourceFingerprint(item),
            pointId:point ? String(point.id) : '', sourceGroup:point?.category || '', sourceKey:point?.value_role || point?.name || '' };
    }
    if (identities[0] === identities[1]) throw error('两个到位反馈必须选择不同的数据源，不能重复使用同一个点位或字段');
    return result;
}
function actionsForModel(model) {
    const metadata = object(model?.metadata), bundle = model?.motion_package;
    const packaged = bundle ? bundle.actions.map(a => ({ ...a, id: `clip:${a.id}`, kind: 'clip', channels: a.channels })) : [];
    return [...packaged, ...(metadata.partBindings || []).map((binding, i) => {
        const node = binding.node_name || (binding.node_path || '').split('/').pop().replace(/#\d+$/, '');
        const channel = { rotate_speed: 'q', rotate_angle: 'q', translate: 'p', visibility: 'v', color: 'c' }[binding.action];
        return { id: `part:${binding.id || i}`, kind: 'part', label: binding.name || binding.node_name || binding.id || `部件 ${i + 1}`, mode: binding.action === 'rotate_speed' ? 'running' : 'position', binding, channels: [`${node}:${channel}`] };
    })];
}
async function loadDeviceAnimations(db, id, factoryId, options = {}) {
    const device = await db.get('SELECT * FROM devices WHERE id=?', [id]);
    if (!device) throw error('设备不存在', 404);
    const instance = object(device.instance_config);
    const lineId = deviceLineId(device, instance);
    const owner = lineId
        ? await db.get('SELECT 1 FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [lineId, factoryId])
        : await db.get('SELECT 1 FROM workshops WHERE id=? AND factory_id=?', [instance.workshop_id || instance.workshopId || '', factoryId]);
    if (!owner) throw error('设备不属于当前工厂', 404);
    const models = mergeBuiltinModels(await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id=?', [factoryId]));
    const model = models.find(m => m.id === device.model_type);
    if (!model || model.asset_type === 'environment') throw error('设备模型不可用', 404);
    const points = await db.all('SELECT * FROM data_points WHERE device_id=? ORDER BY id', [id]);
    // Reuse the transaction's connection. Catalog previews/values must never
    // enter the CAS fingerprint or turn saved sample values into live readings.
    const catalog = await buildCatalog(factoryId, String(id), await loadCatalogState(factoryId, db), '', { runtimePreview:false });
    const datasets = await listDataSets(factoryId, db);
    // Existing model-level assignments remain visible on first entry. Match only
    // a unique, owned point with the exact authored group/key; never guess a PLC tag.
    const inherited = actionsForModel(model).filter(a => a.kind === 'part').flatMap(action => {
        const b = action.binding, group = b.source_group || 'analog';
        const matches = points.filter(p => p.category === group && (p.value_role || p.name) === b.source_key && String(p.access_type || 'READ').toUpperCase() === 'READ');
        if (matches.length !== 1) return [];
        return [{ actionId: action.id, enabled: true, pointId: String(matches[0].id), inputMin: b.input_min ?? 0,
            inputMax: b.input_max ?? 100, speed: 1, transitionSeconds: b.transition_duration ?? 0,
            invert: ['visibility','color'].includes(b.action) && !!b.invert }];
    });
    const config = instance.animationBindings || { version: 1, staleMs: 5000, bindings: inherited };
    const loaded = { device, instance, model, points, config, factoryId, catalog, datasets, actions: actionsForModel(model), motionPackage: model.motion_package };
    if (options.includePositionOwnership === true || options.includeTransferTargets !== false || instance.movement?.enabled === true) loaded.positionOwnership = await modelPositionOwnership(model);
    // Catalog polling does not need another full hierarchy query. Interactive
    // reads/CAS saves include owned target geometry in their authoring revision.
    if (options.includeTransferTargets !== false) {
        const targets = (await scopedDevices(db, factoryId)).map(target => ({ ...target,
            model: models.find(asset => asset.id === target.model_type), movementEnabled: object(target.instance_config).movement?.enabled === true }));
        const targetIds=targets.map(target=>target.id);
        const targetPoints=targetIds.length?await db.all('SELECT id,device_id,name,label,data_type,access_type,category,value_role FROM data_points WHERE device_id IN ('+targetIds.map(()=>'?').join(',')+')',targetIds):[];
        for(const target of targets)target.presencePoints=targetPoints.filter(point=>String(point.device_id)===String(target.id)&&String(point.data_type).toUpperCase()==='BOOL'&&String(point.access_type||'READ').toUpperCase()==='READ');
        const lines = await db.all('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=?', [factoryId]);
        const workshops = await db.all('SELECT * FROM workshops WHERE factory_id=?', [factoryId]);
        loaded.transferCapabilities = buildTransferCapabilities(loaded, targets, { lines, workshops });
    }
    const revision = crypto.createHash('sha256').update(canonicalJson({model:device.model_type,path:model.file_path,metadata:object(model.metadata),motion:model.motion_package?.clipSha256,
        config, instance, points:points.map(p => [p.id,p.category,p.value_role,p.name,p.access_type,p.data_type,p.plc_tag,p.sample_interval_ms]),
        catalogRevision:catalog.revision, sources:catalog.items.map(sourceFingerprint), datasets, transferCapabilities:loaded.transferCapabilities, positionOwnership:loaded.positionOwnership })).digest('hex');
    return { ...loaded, revision };
}
function validateDeviceAnimations(loaded, body) {
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !['revision', 'config'].includes(k))) throw error('仅可保存动画联动配置');
    if (body.revision !== loaded.revision) throw error('配置或点位已更新，请重新读取后保存', 409);
    const config = body.config;
    if (!config || config.version !== 1 || Object.keys(config).some(k => !['version','staleMs','bindings','transferLink','diagnosticLogging','diagnosticIntervalSeconds'].includes(k)) || !Number.isInteger(config.staleMs) || config.staleMs < 1000 || config.staleMs > 60000 || !Array.isArray(config.bindings) || config.bindings.length > 100) throw error('动画配置格式无效');
    if (config.diagnosticLogging !== undefined && typeof config.diagnosticLogging !== 'boolean'
        || config.diagnosticIntervalSeconds !== undefined && (typeof config.diagnosticIntervalSeconds !== 'number' || !Number.isFinite(config.diagnosticIntervalSeconds) || config.diagnosticIntervalSeconds < 1 || config.diagnosticIntervalSeconds > 60)) throw error('动画诊断开关或采样间隔无效');
    // Retired custom clips and the complete process remain readable for history.
    // A save can only disable an existing binding, never edit or activate it.
    const retiredOriginals = new Map((loaded.config?.bindings || []).filter(binding => {
        const action = loaded.actions.find(action => action.id === binding.actionId);
        // Early public-shaped snapshots lack kind. Only an existing orphaned
        // retired clip history row may use its namespace as the fallback;
        // a known current/archived part action is never treated as retired.
        return action ? isRetiredMotionAction(action)
            : isRetiredMotionAction({id:binding.actionId,kind:binding.kind ?? 'clip'});
    }).map(binding => [binding.actionId,binding]));
    const ids = new Set(), occupied = new Map();
    const bindings = config.bindings.map(row => {
        if (!row || Array.isArray(row) || Object.keys(row).some(k => !PUBLIC_BINDING_FIELDS.includes(k)) || typeof row.enabled !== 'boolean' || typeof row.invert !== 'boolean'
            || typeof row.actionId !== 'string' || typeof (row.pointId ?? '') !== 'string' || typeof (row.dataItemId ?? '') !== 'string'
            || (row.dataItemId || '').length > 100 || ids.has(row.actionId)) throw error('动作配置无效或重复');
        ids.add(row.actionId);
        const action = loaded.actions.find(a => a.id === row.actionId);
        if (isRetiredMotionAction(action) || retiredOriginals.has(row.actionId)) {
            if (row.enabled) throw error(`${retiredActionLabel(row.actionId)}已从部件动作中移除，不能再启用；请停用后保存`);
            const original = retiredOriginals.get(row.actionId);
            if (!original) return null; // UI-only disabled defaults never create a retired binding.
            const expected = publicAnimationBinding({ ...original, enabled:false });
            if (canonicalJson(row) !== canonicalJson(expected)) throw error(`${retiredActionLabel(row.actionId)}只允许停用，不能修改历史绑定字段`);
            // Do not resolve a removed source or recompile its trigger. Retain
            // its full stored definition/fingerprint, with only enabled changed.
            return { ...JSON.parse(JSON.stringify(original)), enabled:false };
        }
        if (!action) throw error('模型动作不存在，请重新读取');
        const endpoints = row.trigger?.mode === 'endpoints';
        if (endpoints && action.mode !== 'position') throw error('双到位反馈只适用于位移或角度等行程动作，不用于连续运行动作');
        if (endpoints && (row.dataItemId || row.pointId)) throw error('双到位反馈不能同时使用普通驱动数据，请重新选择驱动方式');
        const dataItemId = row.dataItemId || '';
        const item = dataItemId ? validateMotionSource(loaded, loaded.catalog?.items.find(i => i.id === dataItemId)) : null;
        const pointId = item?.binding.mode === 'plc' ? item.binding.pointId : row.pointId;
        const point = loaded.points.find(p => String(p.id) === String(pointId));
        if (item && row.pointId && String(row.pointId) !== String(item.binding.pointId || '')) throw error('数据项与采集点位不一致，请重新选择数据项');
        if (!endpoints && (!item || item.binding.mode === 'plc')) {
            if ((row.enabled || item) && (!point || String(point.access_type || 'READ').toUpperCase() !== 'READ')) throw error('请选择本设备的只读采集点位');
            if ((row.enabled || item) && (!groups.has(point?.category) || !String(point?.value_role || point?.name || '').trim())) throw error('请先在点位映射中设置有效的点位分组和字段');
        }
        const trigger = endpoints ? validateEndpointTrigger(loaded, row.trigger, row.enabled) : validateTrigger(row.trigger, item?.type || pointType(point), !!item);
        if (['inputMin','inputMax','speed','transitionSeconds'].some(k => typeof row[k] !== 'number' || !Number.isFinite(row[k])) || row.inputMin >= row.inputMax || Math.max(Math.abs(row.inputMin),Math.abs(row.inputMax)) > 1e12 || row.speed < .05 || row.speed > 10 || row.transitionSeconds < 0 || row.transitionSeconds > 60) throw error('输入范围、速度或过渡时间无效');
        const feedbackSmoothingMs = row.feedbackSmoothingMs === undefined ? 0 : row.feedbackSmoothingMs;
        if (typeof feedbackSmoothingMs !== 'number' || !Number.isFinite(feedbackSmoothingMs) || feedbackSmoothingMs < 0 || feedbackSmoothingMs > 1000)
            throw error('数值反馈平滑必须是 0～1000 毫秒的有效数值');
        // Independent actuators may share housing/material tint. A shared c/cN
        // display channel is not an exclusive mechanical movement channel.
        // Position/rotation/scale/visibility and other authored channels still
        // participate in the original conflict protection.
        if (row.enabled) for (const channel of new Set(action.channels.filter(c => !/:c\d*$/.test(c)))) {
            if (occupied.has(channel)) throw error(`“${action.label}”与“${occupied.get(channel)}”控制同一部件，请保留一个`);
            occupied.set(channel, action.label);
        }
        const sourceGroup = groups.has(point?.category) ? point.category : 'analog';
        return { ...row, feedbackSmoothingMs, ...(endpoints ? {dataItemId:''} : {}), ...(dataItemId ? {dataItemId, sourceFingerprint:sourceFingerprint(item)} : {}), ...(trigger ? {trigger} : {}),
            pointId: point && (!item || item.binding.mode === 'plc') ? String(point.id) : '', kind: action.kind, mode: action.mode,
            clipId: action.kind === 'clip' ? row.actionId.slice(5) : '', partId: action.kind === 'part' ? row.actionId.slice(5) : '',
            sourceGroup, sourceKey: !item || item.binding.mode === 'plc' ? point?.value_role || point?.name || '' : '' };
    }).filter(Boolean);
    for (const [actionId,original] of retiredOriginals) {
        if (ids.has(actionId)) continue;
        if (original.enabled) throw error(`仍有已启用的${retiredActionLabel(actionId)}，请显式停用后保存`);
        // Omitting disabled history cannot silently delete its definition.
        bindings.push(JSON.parse(JSON.stringify(original)));
    }
    if (bindings.length > 100) throw error('动画配置格式无效：动作绑定最多保留 100 项');
    assertMotionPositionOwnership(loaded, bindings);
    const result = { version: 1, staleMs: config.staleMs, bindings };
    if (Object.hasOwn(config, 'transferLink')) {
        // Compatibility for explicit legacy API clients, not the part-binding UI.
        const transfer = validateTransferSelection(loaded, config.transferLink, bindings, validateEndpointSource, sourceFingerprint);
        if (transfer !== undefined) result.transferLink = transfer;
    } else if (loaded.config.transferLink !== undefined) {
        // Saving ordinary actuator bindings must neither edit nor revalidate a
        // removed inter-device form's stale action/node/port selections.
        result.transferLink = JSON.parse(JSON.stringify(loaded.config.transferLink));
    }
    for (const field of ['diagnosticLogging','diagnosticIntervalSeconds']) {
        const value = config[field] ?? loaded.config[field];
        if (value !== undefined) result[field] = value;
    }
    return result;
}
function publicDeviceAnimations(loaded) {
    const config = { ...loaded.config, bindings: (loaded.config.bindings || []).map(publicAnimationBinding) };
    if (config.transferLink !== undefined) config.transferLink = publicTransferLink(config.transferLink);
    const dataItems = (loaded.catalog?.items || []).map(item => {
        try {
            validateMotionSource(loaded, item);
            try { validateEndpointSource(loaded,item); return { ...item, motionReady:true, motionError:'', endpointReady:true, endpointError:'' }; }
            catch (error) { return { ...item, motionReady:true, motionError:'', endpointReady:false, endpointError:error.message }; }
        }
        catch (error) { return { ...item, motionReady:false, motionError:error.message }; }
    });
    return { deviceId: loaded.device.id, modelId: loaded.model.id, revision: loaded.revision, config, catalogRevision:loaded.catalog?.revision,
        dataItems, actions: loaded.actions.map(({ channels, binding, ...a }) => ({ ...a, wholeModelTranslation:(channels || []).some(channel => /:p\d*$/.test(channel) && loaded.positionOwnership?.translationRootNodes.includes(channel.replace(/:p\d*$/,''))) })), motionPackage: loaded.motionPackage,
        transferCapabilities: loaded.transferCapabilities };
}
module.exports = { loadDeviceAnimations, validateDeviceAnimations, publicDeviceAnimations, actionsForModel, isRetiredMotionAction, validateTrigger, validateCatalogItem, validateMotionSource, sourceFingerprint, pointType, validateEndpointTrigger, validateEndpointSource, endpointSourceIdentity };
