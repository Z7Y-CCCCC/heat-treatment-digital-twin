'use strict';
// Explicit, scoped asset changes. Legacy whole-package import is deliberately
// separate: an omitted section is never an instruction to erase existing work.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const single = require('./modelAssetBundle'), collection = require('./modelAssetCollection');
const authoring = require('./motionAuthoring');
const { visibleModels, revision, saveActionUpdate } = require('./modelAssetImportPlan');
const { withModelImportLock, readImportReceipt, saveImportReceipt } = require('./modelDuplicates');
const { normalizeModelMetadata, stringifyModelMetadata } = require('./modelAssetMetadata');
const MODULES = ['model', 'inspection', 'actions'], HISTORY_KEY = 'assetVersionHistory', HISTORY_LIMIT = 40;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonicalJson = value => JSON.stringify((function sort(item) { return Array.isArray(item) ? item.map(sort) : object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item; })(value));
const fail = (message, code = 'ASSET_UPDATE_INVALID', statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
function ids(value, name) {
    if (!Array.isArray(value) || value.length > 512 || value.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) || new Set(value).size !== value.length) fail(name + '无效');
    return value;
}
function options(input, needsTarget = true) {
    if (!object(input) || Object.keys(input).some(key => !['targetId', 'modules', 'actionIds', 'replaceActionIds'].includes(key))) fail('补充更新选项无效');
    const modules = ids(input.modules, '更新模块');
    if (!modules.length || modules.some(module => !MODULES.includes(module))) fail('请选择模型、拆解布局或动作模块');
    if (needsTarget && (typeof input.targetId !== 'string' || !/^[\w-]{1,128}$/.test(input.targetId))) fail('请选择已有模型作为补充目标');
    if (!modules.includes('actions') && (input.actionIds !== undefined || input.replaceActionIds !== undefined)) fail('动作选择只能用于动作模块');
    return { ...(needsTarget ? { targetId: input.targetId } : {}), modules: MODULES.filter(module => modules.includes(module)),
        ...(input.actionIds === undefined ? {} : { actionIds: ids(input.actionIds, '动作选择') }),
        ...(input.replaceActionIds === undefined ? {} : { replaceActionIds: ids(input.replaceActionIds, '替换动作选择') }) };
}
async function targetModel(db, id, factoryId) {
    if (!await db.get('SELECT id FROM factories WHERE id = ?', [factoryId])) fail('请先创建并选择工厂');
    const visible = await visibleModels(db, factoryId), model = visible.models.find(item => item.id === id);
    if (!model) fail('目标模型不存在或不属于当前工厂', 'ASSET_TARGET_NOT_FOUND', 404);
    return { model, record: visible.records.find(item => item.id === id) || null };
}
function assetFiles(model) {
    const source = fs.readFileSync(authoring.localFile(model.file_path)); authoring.glb(source);
    const raw = parse(model.metadata), motion = model.motion_package || raw.motionAuthoring?.bundle || require('./builtinModels').builtinMotionForModel(model);
    if (!motion) return { source, motion: null, data: null, rig: null };
    const rig = fs.readFileSync(authoring.localFile(motion.rigPath)), bytes = fs.readFileSync(authoring.localFile(motion.clipPath));
    if (motion.sourceSha256 !== sha(source) || motion.rigSha256 !== sha(rig) || motion.clipSha256 !== sha(bytes)) fail('现有模型或动作资产已改变，请先修复或重新核对', 'ASSET_SOURCE_CHANGED', 409);
    const data = JSON.parse(bytes); single.validateMotion(data, model.id, source, rig);
    return { source, motion, data, rig };
}
function contentRevision(model, files = assetFiles(model)) {
    return sha(Buffer.from(canonicalJson({ revision: revision(model), source: sha(files.source), rig: files.rig ? sha(files.rig) : null, data: files.data ? sha(Buffer.from(canonicalJson(files.data))) : null })));
}
async function readSingle(filename) {
    const archive = await collection.openZip(filename);
    if (!archive.single) fail('补充更新请逐个模型导入，不能把合集自动匹配到一个模型', 'ASSET_UPDATE_COLLECTION');
    return single.readAsset(filename);
}
function actionCatalog(asset) {
    const raw = asset.manifest.model.metadata, normalized = normalizeModelMetadata(raw);
    const clips = asset.data?.clips || [], recipes = raw.motionAuthoring?.actions || [], bindings = Object.hasOwn(raw, 'partBindings') ? normalized.partBindings : [];
    const catalog = new Map();
    for (const [module, rows] of [['clip', clips], ['recipe', recipes], ['binding', bindings]]) {
        const seen = new Set();
        for (const row of rows) {
            if (typeof row.id !== 'string' || !/^[\w-]{1,128}$/.test(row.id) || seen.has(row.id)) fail('动作或部件动作标识无效/重复');
            seen.add(row.id); const previous = catalog.get(row.id);
            catalog.set(row.id, { id: row.id, label: row.label || row.name || row.id, modules: [...(previous?.modules || []), module] });
        }
    }
    return { catalog, clips, recipes, bindings };
}
function mergeRows(oldRows, incomingRows, selected, replacements, module, differences, conflicts) {
    const result = oldRows.map(clone), positions = new Map(result.map((row, index) => [row.id, index]));
    for (const row of incomingRows.filter(row => selected.has(row.id))) {
        const index = positions.get(row.id), previous = index === undefined ? null : result[index];
        const kind = previous == null ? 'add' : eq(previous, row) ? 'same' : 'replace';
        const entry = differences.get(row.id) || { id: row.id, label: row.label || row.name || row.id, kind, modules: [] };
        if (kind === 'replace' || entry.kind === 'same') entry.kind = kind;
        entry.modules.push(module); differences.set(row.id, entry);
        if (kind === 'replace' && !replacements.has(row.id)) conflicts.add(row.id);
        if (index === undefined) { positions.set(row.id, result.length); result.push(clone(row)); }
        else result[index] = clone(row);
    }
    return result;
}
function mergeInspection(base, incoming) {
    const merge = (previous, patch) => {
        const result = object(previous) ? clone(previous) : {};
        for (const [key, value] of Object.entries(patch || {})) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('拆解布局含非法字段');
            if (['explode_offset', 'explode_rotation', 'label_offset'].includes(key) && (!Array.isArray(value) || value.length !== 3 || value.some(component => typeof component !== 'number' || !Number.isFinite(component) || Math.abs(component) > 100000))) fail('拆解位移/转角必须是三个有限数字');
            if (key === 'parts') {
                if (!Array.isArray(value)) fail('拆解部件列表无效');
                const rows = (Array.isArray(result.parts) ? result.parts : []).map(clone), positions = new Map(rows.map((part, index) => [part.id, index])), seen = new Set();
                for (const part of value) {
                    if (!object(part) || typeof part.id !== 'string' || !part.id || seen.has(part.id)) fail('拆解部件必须提供唯一稳定 ID');
                    seen.add(part.id); const index = positions.get(part.id);
                    if (index === undefined) { positions.set(part.id, rows.length); rows.push(merge({}, part)); }
                    else rows[index] = merge(rows[index], part);
                }
                result.parts = rows;
            } else result[key] = object(value) ? merge(result[key], value) : clone(value);
        }
        return result;
    };
    return merge(base, incoming);
}
function nodeIndex(bytes) {
    const document = authoring.glb(bytes).document, names = new Map(), paths = new Set(), reachable = new Set(), visiting = new Set();
    const roots = document.scenes?.[document.scene ?? 0]?.nodes;
    if (!Array.isArray(roots) || !roots.length) fail('模型没有可显示的主场景');
    function visit(index, parent = '') {
        if (!Number.isInteger(index) || !document.nodes[index] || visiting.has(index)) fail('模型节点层级无效');
        const node = document.nodes[index], name = node.name || '', current = parent ? parent + '/' + name : name;
        paths.add(current); paths.add(current.replace(/^\//, ''));
        if (!reachable.has(index)) { names.set(name, (names.get(name) || 0) + 1); reachable.add(index); }
        visiting.add(index); for (const child of node.children || []) visit(child, current); visiting.delete(index);
    }
    roots.forEach(index => visit(index));
    return { document, names, paths, reachable };
}
function validateReferences(model, metadata, source, rig, oldSource = null) {
    const sourceIndex = nodeIndex(source), rigIndex = nodeIndex(rig || source);
    const assertName = (name, label) => { if (name && sourceIndex.names.get(name) !== 1 && rigIndex.names.get(name) !== 1) fail(label + '引用的节点不存在或名称不唯一：' + name, 'ASSET_NODE_INCOMPATIBLE'); };
    const assertPath = (value, label) => {
        if (!value) return;
        // Both persisted root-inclusive and root-relative paths are accepted,
        // but never a fuzzy substring/name guess.
        const normalized = String(value).replace(/^\//, '');
        if (![...sourceIndex.paths, ...rigIndex.paths].some(p => p === normalized || p.split('/').slice(1).join('/') === normalized)) fail(label + '引用的节点路径不存在：' + value, 'ASSET_NODE_INCOMPATIBLE');
    };
    for (const binding of metadata.partBindings || []) { assertName(binding.node_name || binding.nodeName, '部件动作'); assertPath(binding.node_path, '部件动作'); }
    for (const part of metadata.inspection?.parts || []) {
        for (const name of [part.node_name, ...(part.node_names || [])]) assertName(name, '拆解布局');
        for (const nodePath of [part.node_path, ...(part.node_paths || [])]) assertPath(nodePath, '拆解布局');
    }
    for (const name of metadata.inspection?.shell?.node_names || []) assertName(name, '外壳设置');
    for (const nodePath of metadata.inspection?.shell?.node_paths || []) assertPath(nodePath, '外壳设置');
    for (const port of [metadata.loadingPorts?.inlet, metadata.loadingPorts?.outlet]) assertName(port?.nodeName, '进出料口');
    if (oldSource) {
        const oldIndex = nodeIndex(oldSource);
        for (const recipe of metadata.motionAuthoring?.actions || []) for (const track of recipe.tracks || []) {
            const index = Number(track.nodeId), oldNode = oldIndex.document.nodes[index], newNode = rigIndex.document.nodes[index];
            if (!oldNode || !newNode || oldNode.name !== newNode.name) fail('模型替换会使已有动作节点编号失配，请先提供兼容的动作包', 'ASSET_NODE_INCOMPATIBLE');
        }
    }
    if (model.asset_type === 'environment' && (metadata.partBindings?.length || metadata.motionAuthoring?.actions?.length)) fail('环境模型不能接收设备部件动作');
}
async function prepareUpdate(db, asset, input, factoryId) {
    const opt = options(input), { model: target, record } = await targetModel(db, opt.targetId, factoryId), raw = parse(target.metadata), old = assetFiles(target);
    const incoming = asset.manifest.model, next = { ...target }, metadata = clone(raw), sourceMatches = sha(old.source) === sha(asset.entries.get('model.glb'));
    if (incoming.metadata.assetSupplement) {
        const declared = incoming.metadata.assetSupplement;
        if (declared.version !== 1 || !Array.isArray(declared.modules) || opt.modules.some(module => !declared.modules.includes(module))) fail('补充包未提供所选模块，不能把用于校验的源文件当作模型替换内容', 'ASSET_MODULE_MISSING');
    }
    if (!sourceMatches && !opt.modules.includes('model')) fail('补充包模型源文件与目标不同；只补动作/布局不能替换模型', 'ASSET_SOURCE_MISMATCH', 409);
    if (incoming.asset_type !== target.asset_type && incoming.asset_type !== (target.asset_type || 'model')) fail('不能通过补充更新改变设备/环境模型类型');
    if (incoming.placement_level !== (target.placement_level || 'device')) fail('不能通过补充更新改变模型所属层级');
    const differences = new Map(), conflicts = new Set(), selected = new Set(), replacements = new Set(opt.replaceActionIds || []);
    let data = old.data ? clone(old.data) : null, rig = old.rig, source = old.source;
    if (opt.modules.includes('actions')) {
        const catalog = actionCatalog(asset); for (const id of opt.actionIds || [...catalog.catalog.keys()]) selected.add(id);
        for (const id of selected) if (!catalog.catalog.has(id)) fail('补充包中没有所选动作：' + id);
        for (const id of replacements) if (!selected.has(id)) fail('替换确认包含未选择的动作：' + id);
        metadata.partBindings = mergeRows(raw.partBindings || [], catalog.bindings, selected, replacements, 'binding', differences, conflicts);
        const recipes = mergeRows(raw.motionAuthoring?.actions || [], catalog.recipes, selected, replacements, 'recipe', differences, conflicts);
        if (catalog.recipes.some(recipe => selected.has(recipe.id) && !asset.data?.clips.some(clip => clip.id === recipe.id))) fail('动作配方缺少同 ID 的配套编译动作，请导出完整动作资源');
        if (raw.motionAuthoring || recipes.length || asset.data) metadata.motionAuthoring = { ...(raw.motionAuthoring || {}), version: 1, actions: recipes };
        if (!Object.hasOwn(raw.runtime || {}, 'enableGenericBindings') && metadata.partBindings.length) metadata.runtime = { ...(raw.runtime || {}), enableGenericBindings: true };
        if (asset.data) {
            const retained = (old.data?.clips || []).filter(clip => !selected.has(clip.id));
            if (retained.length && (sha(old.rig) !== sha(asset.entries.get('motion.glb')) || !eq(old.data.nodes, asset.data.nodes))) fail('新动作骨架/基准姿态不同，不能与保留动作混用；请提供兼容包或明确替换全部动作', 'ASSET_RIG_INCOMPATIBLE');
            const clips = mergeRows(old.data?.clips || [], catalog.clips, selected, replacements, 'clip', differences, conflicts);
            if (!sourceMatches && retained.length) fail('替换模型时需明确提供全部已有动作的兼容替换版本', 'ASSET_RIG_INCOMPATIBLE');
            const sameBase = old.data && sha(old.rig) === sha(asset.entries.get('motion.glb')) && eq(old.data.nodes, asset.data.nodes);
            // Incremental clips cannot silently rewrite an old package's base
            // convention/extensions (especially a legacy door endpoint).
            rig = asset.entries.get('motion.glb'); data = { ...clone(sameBase ? old.data : asset.data), modelId: target.id, clips };
        }
    }
    if (opt.modules.includes('inspection')) {
        if (!Object.hasOwn(incoming.metadata, 'inspection')) fail('包内未提供拆解布局；缺失内容不能清空已有布局');
        if (!object(incoming.metadata.inspection)) fail('拆解布局补充必须为对象，不能用 null 清空已有配置');
        metadata.inspection = mergeInspection(raw.inspection, incoming.metadata.inspection);
        stringifyModelMetadata({ inspection: metadata.inspection });
        if (Object.hasOwn(incoming.metadata, 'disassemblyLayout')) metadata.disassemblyLayout = clone(incoming.metadata.disassemblyLayout);
        else metadata.disassemblyLayout = { version: 1, configured: true };
    }
    if (opt.modules.includes('model')) {
        source = asset.entries.get('model.glb'); next.default_scale = incoming.default_scale; next.name = incoming.name.trim(); next.tags = JSON.stringify(incoming.tags.filter(tag => tag !== 'packaged'));
        for (const key of ['assetSpec', 'optimization']) if (Object.hasOwn(incoming.metadata, key)) metadata[key] = clone(incoming.metadata[key]);
        if (!sourceMatches && old.data && !opt.modules.includes('actions')) fail('模型已有动作，替换模型必须同时提供兼容动作资源', 'ASSET_RIG_INCOMPATIBLE');
        if (!sourceMatches && data && data.sourceSha256 !== sha(source)) fail('替换模型缺少与新模型匹配的动作资源', 'ASSET_RIG_INCOMPATIBLE');
    }
    validateReferences(next, metadata, source, rig, !sourceMatches ? old.source : null);
    const recipeIndex = nodeIndex(rig || source);
    authoring.validateActions(metadata.motionAuthoring?.actions || [], { nodes: [...recipeIndex.reachable].map(index => {
        const node = recipeIndex.document.nodes[index]; return { id: String(index), name: node.name, ...(data?.nodes.find(rest => rest.name === node.name) || {}) };
    }) });
    if (data) { data.sourceSha256 = sha(source); data.rigSha256 = sha(rig); single.validateMotion(data, target.id, source, rig); }
    const affected = await db.get('SELECT COUNT(*) AS n FROM devices WHERE model_type = ?', [target.id]);
    const inspectionChanged = opt.modules.includes('inspection') && (!eq(raw.inspection, metadata.inspection) || !eq(raw.disassemblyLayout, metadata.disassemblyLayout));
    const modelChanged = opt.modules.includes('model') && (!sourceMatches || target.default_scale !== next.default_scale || target.name !== next.name || !eq(parse(target.tags || '[]'), incoming.tags) || !eq(raw.assetSpec, metadata.assetSpec) || !eq(raw.optimization, metadata.optimization));
    const actions = [...differences.values()], changes = actions.some(action => action.kind !== 'same') || inspectionChanged || modelChanged;
    const updatePlan = { targetId: target.id, targetName: target.name, revision: contentRevision(target, old), modules: opt.modules, sourceMatches,
        sourceSha256: sha(old.source), incomingSourceSha256: sha(asset.entries.get('model.glb')), shared: target.factory_id == null, affectedDeviceCount: Number(affected?.n || 0),
        actions, conflicts: [...conflicts], canImport: conflicts.size === 0, hasInspection: Object.hasOwn(incoming.metadata, 'inspection'), inspectionChanged, modelChanged, changes };
    updatePlan.planHash = sha(Buffer.from(canonicalJson({ updatePlan, options: opt, incoming: asset.manifest, selectedData: data })));
    return { opt, target, record, old, next, metadata, source, rig, data, updatePlan };
}
async function inspectUpdate(filename, db, factoryId, input) {
    const asset = await readSingle(filename), prepared = await prepareUpdate(db, asset, input, factoryId);
    return { inspectedSha256: await single.fileSha(filename), isCollection: false, model: { id: asset.manifest.model.id, name: asset.manifest.model.name,
        assetType: asset.manifest.model.asset_type, placementLevel: asset.manifest.model.placement_level }, actions: asset.actions, files: asset.manifest.files,
        partBindingCount: normalizeModelMetadata(asset.manifest.model.metadata).partBindings.length, hasInspection: single.assetCapabilities(asset).inspection,
        contentCapabilities: single.assetCapabilities(asset), updatePlan: prepared.updatePlan };
}
function ownedDirectory(prefix) {
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')), parent = path.join(root, 'projects'); fs.mkdirSync(parent, { recursive: true });
    if (!fs.realpathSync(parent).startsWith(fs.realpathSync(root) + path.sep)) fail('资产更新目录不在上传目录内');
    const name = prefix + crypto.randomBytes(16).toString('hex'), directory = path.join(parent, name); fs.mkdirSync(directory);
    return { directory, root, base: '/uploads/projects/' + name + '/' };
}
function removeOwned(owned) {
    if (!owned) return;
    const resolved = path.resolve(owned.directory), parent = path.join(owned.root, 'projects');
    if (path.dirname(resolved) !== parent || !/^(?:update_|history_)[a-f0-9]{32}$/.test(path.basename(resolved))) throw new Error('Invalid owned asset update directory');
    if (fs.existsSync(resolved) && !fs.realpathSync(resolved).startsWith(fs.realpathSync(parent) + path.sep)) throw new Error('Owned asset directory escaped its root');
    fs.rmSync(resolved, { recursive: true, force: true });
}
async function cleanupUnreferenced(db, id, factoryId, owned) {
    if (!owned) return;
    try {
        const record = await db.get('SELECT file_path,metadata FROM models WHERE id=? AND (factory_id IS NULL OR factory_id=?)', [id, factoryId]);
        if (record && (record.file_path?.startsWith(owned.base) || JSON.stringify(parse(record.metadata)).includes(owned.base))) return;
    } catch { return; } // An uncertain commit must never remove potentially live assets.
    removeOwned(owned);
}
function writeMotion(model, metadata, files, owned) {
    let motion = null;
    if (files.data) {
        const bytes = Buffer.from(JSON.stringify({ ...files.data, modelId: model.id, sourceSha256: sha(files.source), rigSha256: sha(files.rig) }));
        fs.writeFileSync(path.join(owned.directory, 'motion.glb'), files.rig, { flag: 'wx' }); fs.writeFileSync(path.join(owned.directory, 'motion.json'), bytes, { flag: 'wx' });
        const existing = metadata.motionAuthoring?.bundle || {}, { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, actions, ...extensions } = existing;
        motion = { ...extensions, sourcePath: model.file_path, sourceSha256: sha(files.source), rigPath: owned.base + 'motion.glb', rigSha256: sha(files.rig), clipPath: owned.base + 'motion.json', clipSha256: sha(bytes),
            actions: files.data.clips.map(({ id, label, mode, duration, tracks }) => ({ id, label, mode, duration, channels: tracks.map(track => track.node + ':' + track.channel) })) };
        metadata.motionAuthoring = { ...(metadata.motionAuthoring || {}), version: 1, actions: metadata.motionAuthoring?.actions || [], bundle: motion };
    }
    return motion;
}
function snapshot(target, files, modules, label) {
    const owned = ownedDirectory('history_'), raw = parse(target.metadata), metadata = {}, descriptor = { id: target.id };
    try {
        if (modules.includes('actions')) {
            for (const key of ['partBindings', 'motionAuthoring']) if (Object.hasOwn(raw, key)) metadata[key] = clone(raw[key]);
            metadata.runtime = { ...(Object.hasOwn(raw.runtime || {}, 'enableGenericBindings') ? { enableGenericBindings: raw.runtime.enableGenericBindings } : {}) };
            if (files.data) { descriptor.file_path = target.file_path; writeMotion(descriptor, metadata, files, owned); }
        }
        if (modules.includes('inspection')) for (const key of ['inspection', 'disassemblyLayout']) if (Object.hasOwn(raw, key)) metadata[key] = clone(raw[key]);
        if (modules.includes('model')) {
            fs.writeFileSync(path.join(owned.directory, 'model.glb'), files.source, { flag: 'wx' });
            Object.assign(descriptor, { file_path: owned.base + 'model.glb', name: target.name, default_scale: target.default_scale, tags: target.tags });
            for (const key of ['assetSpec', 'optimization']) if (Object.hasOwn(raw, key)) metadata[key] = clone(raw[key]);
            // A model snapshot always includes its matching old motion. Restore
            // must not reconnect a new source file to old-incompatible clips.
            if (files.data && !modules.includes('actions')) { metadata.motionAuthoring = clone(raw.motionAuthoring || {}); writeMotion(descriptor, metadata, files, owned); }
            if (metadata.motionAuthoring?.bundle) metadata.motionAuthoring.bundle.sourcePath = descriptor.file_path;
        }
        const bytes = Buffer.from(JSON.stringify({ version: 1, model: descriptor, metadata, modules })); fs.writeFileSync(path.join(owned.directory, 'snapshot.json'), bytes, { flag: 'wx' });
        const versionId = path.basename(owned.directory).slice('history_'.length);
        return { owned, entry: { id: versionId, versionId, createdAt: new Date().toISOString(), modules, label, summary: label, snapshotPath: owned.base + 'snapshot.json', snapshotSha256: sha(bytes) } };
    } catch (error) { removeOwned(owned); throw error; }
}
async function persist(tx, prepared, model, factoryId) {
    if (model.file_path === prepared.target.file_path && model.name === prepared.target.name && model.default_scale === prepared.target.default_scale && model.tags === prepared.target.tags)
        return saveActionUpdate(tx, prepared.target, prepared.record, model.metadata, factoryId, tx.dialect || require('../db/database').getDbStatus().type);
    // Use the existing optimistic compare-and-save first, then update only the
    // explicitly selected model fields in the same transaction/row.
    await saveActionUpdate(tx, prepared.target, prepared.record, model.metadata, factoryId, tx.dialect || require('../db/database').getDbStatus().type);
    const result = await tx.run('UPDATE models SET file_path=?, name=?, default_scale=?, tags=? WHERE id=? AND (factory_id IS NULL OR factory_id=?)', [model.file_path, model.name, model.default_scale, model.tags, model.id, factoryId]);
    if (!result?.changes && !result?.affectedRows) fail('模型在更新时已改变', 'IMPORT_PLAN_STALE', 409);
}
async function importUpdate(db, filename, factoryId, inspectedSha256, input, confirmation, authorize = () => {}, requestId = '') {
    return withModelImportLock(async () => {
        if (!/^[a-f0-9]{64}$/.test(inspectedSha256 || '') || await single.fileSha(filename) !== inspectedSha256) fail('请先检查资产包，文件改变后需重新检查');
        const opt = options(input), signature = sha(Buffer.from(inspectedSha256 + canonicalJson(opt)));
        if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail('导入请求标识无效');
        const token = requestId ? sha(Buffer.from(factoryId + '\0' + requestId)).slice(0, 32) : crypto.randomBytes(16).toString('hex');
        const receipt = requestId ? await readImportReceipt(db, factoryId, token, signature) : null;
        if (receipt) { const { model } = await targetModel(db, receipt.modelId, factoryId); authorize(model.metadata, model.metadata, opt.modules); return { model, reused: true, replayed: true, outcome: 'reuse' }; }
        const asset = await readSingle(filename), prepared = await prepareUpdate(db, asset, opt, factoryId), plan = prepared.updatePlan;
        if (!object(confirmation) || confirmation.planHash !== plan.planHash || confirmation.revision !== plan.revision || confirmation.targetId !== plan.targetId) fail('目标模型或更新选择在检查后已改变，请重新检查', 'IMPORT_PLAN_STALE', 409);
        if (!plan.canImport) fail('已有同 ID 动作将被替换，请明确选择替换并重新检查', 'ASSET_ACTION_CONFIRMATION_REQUIRED', 409);
        authorize(prepared.target.metadata, JSON.stringify(prepared.metadata), opt.modules);
        if (!plan.changes) { if (requestId) await db.transaction(tx => saveImportReceipt(tx, factoryId, token, signature, prepared.target.id)); return { model: prepared.target, reused: true, outcome: 'reuse', updatePlan: plan }; }
        const history = snapshot(prepared.target, prepared.old, opt.modules, '补充更新前的资产版本'), update = ownedDirectory('update_'); let committed = false;
        try {
            const model = { ...prepared.next }, metadata = clone(prepared.metadata);
            if (opt.modules.includes('model') && !plan.sourceMatches) { fs.writeFileSync(path.join(update.directory, 'model.glb'), prepared.source, { flag: 'wx' }); model.file_path = update.base + 'model.glb'; }
            let motion = prepared.old.motion;
            if (opt.modules.includes('actions') && prepared.data || opt.modules.includes('model') && !plan.sourceMatches && prepared.data) motion = writeMotion(model, metadata, prepared, update);
            metadata[HISTORY_KEY] = [...(parse(prepared.target.metadata)[HISTORY_KEY] || []), history.entry].slice(-HISTORY_LIMIT);
            model.metadata = JSON.stringify(metadata); model.motion_package = motion;
            if (motion) authoring.validateActions(metadata.motionAuthoring?.actions || [], authoring.prepare(model));
            authorize(prepared.target.metadata, model.metadata, opt.modules);
            await db.transaction(async tx => { await persist(tx, prepared, model, factoryId); if (requestId) await saveImportReceipt(tx, factoryId, token, signature, model.id); });
            committed = true; return { model, reused: true, outcome: 'update_asset', updatedModules: opt.modules, updatePlan: plan, version: history.entry };
        } finally { if (!committed) { await cleanupUnreferenced(db, prepared.target.id, factoryId, update); await cleanupUnreferenced(db, prepared.target.id, factoryId, history.owned); } }
    });
}
async function history(db, id, factoryId) {
    const { model } = await targetModel(db, id, factoryId), raw = parse(model.metadata), files = assetFiles(model);
    return { revision: contentRevision(model, files), shared: model.factory_id == null,
        versions: (raw[HISTORY_KEY] || []).slice().reverse().map(({ snapshotPath, snapshotSha256, ...entry }) => entry) };
}
function readSnapshot(entry) {
    const id = entry.id || entry.versionId;
    if (!/^[a-f0-9]{32}$/.test(id || '') || typeof entry.snapshotPath !== 'string' || !entry.snapshotPath.endsWith('/history_' + id + '/snapshot.json')) fail('历史资产记录无效');
    const bytes = fs.readFileSync(authoring.localFile(entry.snapshotPath));
    if (sha(bytes) !== entry.snapshotSha256) fail('历史资产快照已改变，不能恢复', 'ASSET_HISTORY_CHANGED', 409);
    const saved = JSON.parse(bytes); if (saved.version !== 1 || !object(saved.metadata) || !object(saved.model) || !Array.isArray(saved.modules)) fail('历史资产快照无效');
    return saved;
}
async function restore(db, id, versionId, factoryId, confirmedRevision, authorize = () => {}) {
    return withModelImportLock(async () => {
        const { model: target, record } = await targetModel(db, id, factoryId), old = assetFiles(target), raw = parse(target.metadata);
        if (confirmedRevision !== contentRevision(target, old)) fail('模型在读取历史后已改变，请重新读取', 'IMPORT_PLAN_STALE', 409);
        const entry = (raw[HISTORY_KEY] || []).find(item => (item.id || item.versionId) === versionId); if (!entry) fail('资产历史版本不存在', 'ASSET_HISTORY_NOT_FOUND', 404);
        const saved = readSnapshot(entry), modules = saved.modules; if (saved.model.id !== target.id) fail('历史快照不属于当前模型');
        const metadata = clone(raw), next = { ...target };
        for (const module of modules) for (const key of module === 'actions' ? ['partBindings', 'motionAuthoring'] : module === 'inspection' ? ['inspection', 'disassemblyLayout'] : ['assetSpec', 'optimization']) {
            if (Object.hasOwn(saved.metadata, key)) metadata[key] = clone(saved.metadata[key]); else delete metadata[key];
        }
        if (modules.includes('actions')) {
            metadata.runtime = { ...(raw.runtime || {}) };
            if (Object.hasOwn(saved.metadata.runtime || {}, 'enableGenericBindings')) metadata.runtime.enableGenericBindings = saved.metadata.runtime.enableGenericBindings; else delete metadata.runtime.enableGenericBindings;
        }
        if (modules.includes('model')) {
            for (const key of ['file_path', 'name', 'default_scale', 'tags']) next[key] = saved.model[key];
            if (!modules.includes('actions') && saved.metadata.motionAuthoring) metadata.motionAuthoring = clone(saved.metadata.motionAuthoring);
        }
        next.metadata = JSON.stringify(metadata); next.motion_package = metadata.motionAuthoring?.bundle || null;
        const files = assetFiles(next); validateReferences(next, metadata, files.source, files.rig, modules.includes('model') ? old.source : null);
        if (next.motion_package) authoring.validateActions(metadata.motionAuthoring?.actions || [], authoring.prepare(next));
        authorize(target.metadata, next.metadata, modules);
        const before = snapshot(target, old, modules, '恢复历史版本前的资产版本'); let committed = false;
        try {
            metadata[HISTORY_KEY] = [...(raw[HISTORY_KEY] || []), before.entry].slice(-HISTORY_LIMIT); next.metadata = JSON.stringify(metadata);
            await db.transaction(tx => persist(tx, { target, record }, next, factoryId)); committed = true;
            return { model: next, restoredVersionId: versionId, updatedModules: modules, outcome: 'restore_asset' };
        } finally { if (!committed) await cleanupUnreferenced(db, target.id, factoryId, before.owned); }
    });
}
async function exportSupplement(db, modelIds, factoryId, filename, input) {
    ids(modelIds, '模型选择'); if (modelIds.length !== 1) fail('补充包请一次选择一个模型；完整资产包可选择多个模型');
    const opt = options(input, false), { model } = await targetModel(db, modelIds[0], factoryId), entries = single.buildEntries(model), manifest = JSON.parse(entries.get('manifest.json'));
    const raw = manifest.model.metadata, metadata = { assetSupplement: { version: 1, modules: opt.modules, sourceModelId: model.id, sourceSha256: sha(entries.get('model.glb')) } };
    for (const module of opt.modules) for (const key of module === 'actions' ? ['partBindings', 'motionAuthoring', 'runtime'] : module === 'inspection' ? ['inspection', 'disassemblyLayout'] : ['assetSpec', 'optimization']) if (Object.hasOwn(raw, key)) metadata[key] = clone(raw[key]);
    if (opt.modules.includes('actions')) {
        const asset = single.validateAssetEntries(entries), catalog = actionCatalog(asset), selected = new Set(opt.actionIds || [...catalog.catalog.keys()]);
        for (const id of selected) if (!catalog.catalog.has(id)) fail('模型中没有所选动作：' + id);
        if (metadata.partBindings) metadata.partBindings = metadata.partBindings.filter(row => selected.has(row.id));
        if (metadata.motionAuthoring?.actions) metadata.motionAuthoring.actions = metadata.motionAuthoring.actions.filter(row => selected.has(row.id));
        if (asset.data) { const data = { ...asset.data, clips: asset.data.clips.filter(row => selected.has(row.id)) }; entries.set('motion.json', Buffer.from(JSON.stringify(data))); }
        metadata.assetSupplement.actionIds = [...selected];
    } else { entries.delete('motion.glb'); entries.delete('motion.json'); }
    manifest.model.metadata = metadata;
    manifest.files = [...entries].filter(([name]) => name !== 'manifest.json').map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) }));
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))); single.validateAssetEntries(entries);
    await single.writeZip(filename, entries); return manifest;
}
module.exports = { inspectUpdate, importUpdate, history, restore, exportSupplement, options, contentRevision, prepareUpdate, HISTORY_KEY };
