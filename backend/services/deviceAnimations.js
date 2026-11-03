const crypto = require('node:crypto');
const { mergeBuiltinModels } = require('./builtinModels');
const { canonicalJson } = require('./deviceInspection');
const groups = new Set(['analog', 'motors', 'doors', 'gas', 'mechanisms', 'status']);
const object = value => { try { const x = typeof value === 'string' ? JSON.parse(value || '{}') : value; return x && !Array.isArray(x) && typeof x === 'object' ? x : {}; } catch { return {}; } };
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function actionsForModel(model) {
    const metadata = object(model?.metadata), bundle = model?.motion_package;
    const packaged = bundle ? bundle.actions.map(a => ({ ...a, id: `clip:${a.id}`, kind: 'clip', channels: a.channels })) : [];
    return [...packaged, ...(metadata.partBindings || []).map((binding, i) => {
        const node = binding.node_name || (binding.node_path || '').split('/').pop().replace(/#\d+$/, '');
        const channel = { rotate_speed: 'q', rotate_angle: 'q', translate: 'p', visibility: 'v', color: 'c' }[binding.action];
        return { id: `part:${binding.id || i}`, kind: 'part', label: binding.name || binding.node_name || binding.id || `部件 ${i + 1}`, mode: binding.action === 'rotate_speed' ? 'running' : 'position', binding, channels: [`${node}:${channel}`] };
    })];
}
async function loadDeviceAnimations(db, id, factoryId) {
    const device = await db.get('SELECT * FROM devices WHERE id=?', [id]);
    if (!device) throw error('设备不存在', 404);
    const instance = object(device.instance_config);
    const owner = device.line_id
        ? await db.get('SELECT 1 FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [device.line_id, factoryId])
        : await db.get('SELECT 1 FROM workshops WHERE id=? AND factory_id=?', [instance.workshop_id || instance.workshopId || '', factoryId]);
    if (!owner) throw error('设备不属于当前工厂', 404);
    const models = mergeBuiltinModels(await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id=?', [factoryId]));
    const model = models.find(m => m.id === device.model_type);
    if (!model || model.asset_type === 'environment') throw error('设备模型不可用', 404);
    const points = await db.all('SELECT * FROM data_points WHERE device_id=? ORDER BY id', [id]);
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
    const revision = crypto.createHash('sha256').update(canonicalJson({model:device.model_type,path:model.file_path,metadata:object(model.metadata),config,points:points.map(p => [p.id,p.category,p.value_role,p.name,p.access_type])})).digest('hex');
    return { device, instance, model, points, config, revision, actions: actionsForModel(model), motionPackage: model.motion_package };
}
function validateDeviceAnimations(loaded, body) {
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !['revision', 'config'].includes(k))) throw error('仅可保存动画联动配置');
    if (body.revision !== loaded.revision) throw error('配置或点位已更新，请重新读取后保存', 409);
    const config = body.config;
    if (!config || config.version !== 1 || Object.keys(config).some(k => !['version','staleMs','bindings'].includes(k)) || !Number.isInteger(config.staleMs) || config.staleMs < 1000 || config.staleMs > 60000 || !Array.isArray(config.bindings) || config.bindings.length > 100) throw error('动画配置格式无效');
    const ids = new Set(), occupied = new Map();
    const bindings = config.bindings.map(row => {
        if (!row || Object.keys(row).some(k => !['actionId','enabled','pointId','inputMin','inputMax','invert','speed','transitionSeconds'].includes(k)) || typeof row.enabled !== 'boolean' || typeof row.invert !== 'boolean' || ids.has(row.actionId)) throw error('动作配置无效或重复');
        ids.add(row.actionId);
        const action = loaded.actions.find(a => a.id === row.actionId);
        if (!action) throw error('模型动作不存在，请重新读取');
        const point = loaded.points.find(p => String(p.id) === String(row.pointId));
        if (row.enabled && (!point || String(point.access_type || 'READ').toUpperCase() !== 'READ')) throw error('请选择本设备的只读采集点位');
        if (row.enabled && (!groups.has(point.category) || !String(point.value_role || point.name || '').trim())) throw error('请先在点位映射中设置有效的点位分组和字段');
        if (['inputMin','inputMax','speed','transitionSeconds'].some(k => typeof row[k] !== 'number' || !Number.isFinite(row[k])) || row.inputMin >= row.inputMax || Math.max(Math.abs(row.inputMin),Math.abs(row.inputMax)) > 1e12 || row.speed < .05 || row.speed > 10 || row.transitionSeconds < 0 || row.transitionSeconds > 60) throw error('输入范围、速度或过渡时间无效');
        if (row.enabled) for (let channel of action.channels) {
            channel = channel.replace(/:c\d+$/, ':c'); // generic color owns every material slot on that node
            if (occupied.has(channel)) throw error(`“${action.label}”与“${occupied.get(channel)}”控制同一部件，请保留一个`);
            occupied.set(channel, action.label);
        }
        const sourceGroup = groups.has(point?.category) ? point.category : 'analog';
        return { ...row, pointId: point ? String(point.id) : '', kind: action.kind, mode: action.mode, clipId: action.kind === 'clip' ? row.actionId.slice(5) : '', partId: action.kind === 'part' ? row.actionId.slice(5) : '', sourceGroup, sourceKey: point?.value_role || point?.name || '' };
    });
    return { version: 1, staleMs: config.staleMs, bindings };
}
function publicDeviceAnimations(loaded) {
    const config = { ...loaded.config, bindings: (loaded.config.bindings || []).map(row => Object.fromEntries(['actionId','enabled','pointId','inputMin','inputMax','invert','speed','transitionSeconds'].map(k => [k,row[k]]))) };
    return { deviceId: loaded.device.id, modelId: loaded.model.id, revision: loaded.revision, config, actions: loaded.actions.map(({ channels, binding, ...a }) => a), motionPackage: loaded.motionPackage };
}
module.exports = { loadDeviceAnimations, validateDeviceAnimations, publicDeviceAnimations, actionsForModel };
