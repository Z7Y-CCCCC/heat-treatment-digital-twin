'use strict';
// A selective model/environment + motion asset package, NOT a database backup.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const archiver = require('archiver'), unzipper = require('unzipper');
const authoring = require('./motionAuthoring');
const { mergeBuiltinModels } = require('./builtinModels');
const { stringifyModelMetadata } = require('./modelAssetMetadata');
const { withModelImportLock, readImportReceipt, saveImportReceipt, preserveExtensions } = require('./modelDuplicates');
const { decideImport, confirmDecision, visibleModels, saveActionUpdate } = require('./modelAssetImportPlan');
const FORMAT = 'digital-twin-model-asset', MAX_BYTES = 184 * 1024 * 1024;
const LIMITS = { 'manifest.json': 4 * 1024 * 1024, 'model.glb': 80 * 1024 * 1024, 'motion.glb': 80 * 1024 * 1024, 'motion.json': 16 * 1024 * 1024 };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fileSha(filename) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const parse = v => typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
function validateMotion(data, modelId, source, rig) {
    if (!object(data) || data.schemaVersion !== 1 || data.modelId !== modelId || data.sourceSha256 !== sha(source) || data.rigSha256 !== sha(rig)
        || !Array.isArray(data.nodes) || data.nodes.length > 20000 || !Array.isArray(data.clips) || data.clips.length > 128) fail('动作数据与模型/动作 GLB 不匹配');
    const names = new Set(authoring.glb(rig).document.nodes.map(n => n.name).filter(Boolean));
    const declared = new Set();
    for (const node of data.nodes) {
        if (!object(node) || !names.has(node.name) || declared.has(node.name)) fail('动作节点无效或重复');
        declared.add(node.name);
        for (const [key, values] of Object.entries(node)) {
            if (key === 'name') continue;
            const width = key === 'q' || /^[ce]\d+$/.test(key) ? 4 : key === 'v' ? 1 : ['p', 's'].includes(key) ? 3 : 0;
            if (!width || !Array.isArray(values) || values.length !== width || values.some(v => !Number.isFinite(v))) fail('动作节点变换无效');
        }
        if (['p', 'q', 's', 'v'].some(k => !Array.isArray(node[k]))) fail('动作节点缺少初始变换');
    }
    const ids = new Set();
    for (const clip of data.clips) {
        if (!object(clip) || typeof clip.id !== 'string' || !/^[\w-]{1,100}$/.test(clip.id) || ids.has(clip.id)
            || typeof clip.label !== 'string' || clip.label.length > 120 || !['position', 'running'].includes(clip.mode)
            || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 3600
            || !Number.isSafeInteger(clip.count) || clip.count < 2 || clip.count > 100000
            || !Array.isArray(clip.tracks) || clip.tracks.length > 20000) fail('动作片段无效');
        ids.add(clip.id); const channels = new Set();
        for (const track of clip.tracks) {
            const width = track.channel === 'q' || /^[ce]\d+$/.test(track.channel) ? 4 : track.channel === 'v' ? 1 : ['p','s'].includes(track.channel) ? 3 : 0;
            const key = track.node + ':' + track.channel;
            if (!declared.has(track.node) || !width || track.size !== width || channels.has(key)
                || !Array.isArray(track.values) || track.values.length !== clip.count * width
                || track.values.some(v => !Number.isFinite(v))) fail('动作轨道/采样数据无效');
            channels.add(key);
        }
    }
    return data.clips.map(clip => ({ id: clip.id, label: clip.label, mode: clip.mode, duration: clip.duration, channels: clip.tracks.map(t => t.node + ':' + t.channel) }));
}
async function writeZip(filename, entries) {
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filename, { flags: 'wx' }), archive = archiver('zip', { zlib: { level: 1 } });
        output.on('close', resolve); output.on('error', reject); archive.on('error', reject);
        archive.pipe(output);
        for (const [name, bytes] of entries) {
            if (bytes?.file) archive.file(bytes.file, { name });
            else archive.append(bytes, { name });
        }
        archive.finalize().catch(reject);
    });
}
function buildEntries(model) {
    const metadata = JSON.parse(JSON.stringify(parse(model.metadata))), source = fs.readFileSync(authoring.localFile(model.file_path));
    authoring.glb(source);
    const entries = new Map([['model.glb', source]]), motion = model.motion_package || require('./builtinModels').builtinMotionForModel(model);
    if (motion) {
        const rig = fs.readFileSync(authoring.localFile(motion.rigPath)), bytes = fs.readFileSync(authoring.localFile(motion.clipPath));
        if (sha(source) !== motion.sourceSha256 || sha(rig) !== motion.rigSha256 || sha(bytes) !== motion.clipSha256) fail('模型资产或动作文件已改变，请重新核对后导出');
        validateMotion(JSON.parse(bytes), model.id, source, rig);
        entries.set('motion.glb', rig); entries.set('motion.json', bytes);
    }
    // All runtime paths are relocated during import; never trust paths supplied
    // inside metadata. Part/inspection layout and authoring recipes are retained.
    if (metadata.motionAuthoring) {
        const { bundle, ...authoringMetadata } = metadata.motionAuthoring;
        metadata.motionAuthoring = { ...authoringMetadata, version: 1, actions: authoringMetadata.actions || [] };
        if (bundle) {
            const { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, actions, ...extensions } = bundle;
            if (Object.keys(extensions).length) metadata.motionAuthoring.bundle = extensions;
        }
    }
    const manifest = { format: FORMAT, version: 1, model: { id: model.id, name: model.name, asset_type: model.asset_type || 'model',
        placement_level: model.asset_type === 'environment' ? 'factory' : model.placement_level || 'device',
        default_scale: Number(model.default_scale || 1), tags: parse(model.tags || '[]'), metadata },
        files: [...entries].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) })) };
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    return entries;
}
async function exportAsset(db, id, factoryId, filename) {
    const records = await db.all('SELECT * FROM models WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)', [id, factoryId]);
    const model = mergeBuiltinModels(records).find(m => m.id === id);
    if (!model) throw Object.assign(new Error('模型不存在或不属于所选工厂'), { statusCode: 404 });
    const entries = buildEntries(model); await writeZip(filename, entries); return entries;
}
async function boundedRead(entry, limit) {
    if (entry.uncompressedSize > limit) fail('导入文件超过大小限制');
    const chunks = []; let total = 0;
    const stream = entry.stream();
    try { for await (const chunk of stream) { total += chunk.length; if (total > limit) fail('导入文件解压超过大小限制'); chunks.push(chunk); } }
    finally { stream.destroy(); }
    return Buffer.concat(chunks);
}
async function readAsset(filename) {
    if (fs.statSync(filename).size > MAX_BYTES) fail('模型动作包超过 184 MB');
    const zip = await unzipper.Open.file(filename), entries = new Map();
    if (zip.files.length < 2 || zip.files.length > 4) fail('模型动作包文件数量无效');
    for (const entry of zip.files) {
        if (entry.type !== 'File' || !Object.hasOwn(LIMITS, entry.path) || entries.has(entry.path)) fail('模型包含非法/重复路径或多余文件');
        entries.set(entry.path, await boundedRead(entry, LIMITS[entry.path]));
    }
    return validateAssetEntries(entries);
}
function validateAssetEntries(entries) {
    if (entries.size < 2 || entries.size > 4 || [...entries.keys()].some(name => !Object.hasOwn(LIMITS, name))) fail('模型包含非法路径或多余文件');
    if (!entries.has('manifest.json') || !entries.has('model.glb')) fail('请选择模型资产 ZIP，不是数据库备份或 Blender 工程 ZIP');
    const manifest = JSON.parse(entries.get('manifest.json'));
    if (!object(manifest) || manifest.format !== FORMAT || manifest.version !== 1 || !object(manifest.model) || !Array.isArray(manifest.files) || manifest.files.length !== entries.size - 1) fail('不支持的模型资产包格式');
    const listed = new Set();
    for (const f of manifest.files) {
        const bytes = entries.get(f.name);
        if (f.name === 'manifest.json' || !bytes || listed.has(f.name) || f.size !== bytes.length || f.sha256 !== sha(bytes)) fail('模型包文件大小/SHA256 不匹配');
        listed.add(f.name);
    }
    const m = manifest.model;
    if (!/^[\w-]{1,128}$/.test(m.id) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120
        || !['model','environment'].includes(m.asset_type) || !['device','line','workshop','factory'].includes(m.placement_level)
        || !Number.isFinite(m.default_scale) || m.default_scale <= 0 || m.default_scale > 1000 || !Array.isArray(m.tags) || m.tags.length > 100
        || m.tags.some(v => typeof v !== 'string' || v.length > 100) || !object(m.metadata)) fail('模型资产信息无效');
    authoring.glb(entries.get('model.glb'));
    const hasMotion = entries.has('motion.glb');
    if (hasMotion !== entries.has('motion.json')) fail('动作 GLB 与动作数据 JSON 必须成套');
    const data = hasMotion ? JSON.parse(entries.get('motion.json')) : null;
    const actions = hasMotion ? validateMotion(data, m.id, entries.get('model.glb'), entries.get('motion.glb')) : [];
    return { manifest, entries, data, actions };
}
async function inspectAsset(filename, db = null, factoryId = '') {
    const asset = await readAsset(filename);
    return { inspectedSha256: await fileSha(filename), model: { id: asset.manifest.model.id, name: asset.manifest.model.name,
        assetType: asset.manifest.model.asset_type, placementLevel: asset.manifest.model.placement_level },
        actions: asset.actions, files: asset.manifest.files,
        partBindingCount: require('./modelAssetMetadata').normalizeModelMetadata(asset.manifest.model.metadata).partBindings.length,
        ...(db ? { importDecision: (await decideImport(db, asset, factoryId)).decision } : {}) };
}
async function importAsset(db, filename, factoryId, inspectedSha256, authorize = () => {}, requestId = '', importDecision = null) {
    return withModelImportLock(async () => {
        if (!/^[a-f0-9]{64}$/.test(inspectedSha256 || '') || await fileSha(filename) !== inspectedSha256) fail('请先检查模型动作包，文件变化后需重新检查');
        return importValidatedAsset(db, await readAsset(filename), factoryId, inspectedSha256, authorize, requestId, importDecision);
    });
}
async function importValidatedAsset(db, asset, factoryId, inspectedSha256, authorize = () => {}, requestId = '', importDecision = null) {
    const m = asset.manifest.model;
    if (!await db.get('SELECT id FROM factories WHERE id = ?', [factoryId])) fail('请先创建并选择工厂');
    if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail('导入请求标识无效');
    const token = requestId ? sha(Buffer.from(factoryId + '\0' + requestId)).slice(0, 32) : crypto.randomBytes(16).toString('hex'), id = 'asset_' + token;
    // Replaying a receipt returns its current canonical target. Never reapply an
    // older package over edits made after a successful import.
    const receipt = requestId ? await readImportReceipt(db, factoryId, token, inspectedSha256) : null;
    if (receipt) {
        const previous = (await visibleModels(db, factoryId)).models.find(model => model.id === receipt.modelId);
        if (!previous) throw Object.assign(new Error('本次导入的目标模型已删除，请重新检查并使用新导入请求'), { statusCode: 409 });
        authorize(previous.metadata);
        return { model: previous, reused: true, outcome: 'reuse', replayed: true };
    }
    const previous = requestId ? await db.get('SELECT * FROM models WHERE id = ? AND factory_id = ?', [id, factoryId]) : null;
    if (previous) {
        const saved = parse(previous.metadata);
        if (saved.assetImport?.packageSha256 !== inspectedSha256) throw Object.assign(new Error('导入请求对应的文件已改变，请重新选择'), { statusCode: 409 });
        authorize(previous.metadata);
        return { model: { ...previous, motion_package: saved.motionAuthoring?.bundle || null, is_builtin: false }, reused: true, outcome: 'reuse', replayed: true };
    }
    // Authorize the incoming configuration even when its asset is reused. The
    // complete motion payload was checked by validateAssetEntries beforehand.
    authorize(stringifyModelMetadata(m.metadata, { name: m.name }));
    const plan = await decideImport(db, asset, factoryId);
    confirmDecision(plan.decision, importDecision);
    const duplicate = plan.decision.kind === 'reuse' ? plan.target : null;
    if (duplicate) {
        authorize(duplicate.metadata);
        // Reuse must not bypass the executable-recipe validation performed for
        // a new import, even for a malformed historical/raw-upload candidate.
        authoring.validateActions(m.metadata.motionAuthoring?.actions || [], authoring.prepare(duplicate));
        if (requestId) await db.transaction(tx => saveImportReceipt(tx, factoryId, token, inspectedSha256, duplicate.id));
        return { model: duplicate, reused: true, outcome: 'reuse' };
    }
    if (plan.decision.kind === 'update_actions') return updateModelActions(db, asset, plan, factoryId, inspectedSha256, authorize, requestId, token);
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')), parent = path.join(root, 'projects'), dest = path.join(parent, token);
    fs.mkdirSync(parent, { recursive: true });
    if (!fs.realpathSync(parent).startsWith(fs.realpathSync(root) + path.sep)) fail('模型导入目录不在上传目录内');
    const base = '/uploads/projects/' + token + '/', metadata = { ...m.metadata };
    metadata.assetImport = { requestId: requestId || token, packageSha256: inspectedSha256, sourceModelId: m.id };
    let motionExtensions = {};
    if (metadata.motionAuthoring) {
        const { bundle, ...authoringMetadata } = metadata.motionAuthoring;
        if (bundle) {
            const { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, actions, ...extensions } = bundle;
            motionExtensions = extensions;
        }
        metadata.motionAuthoring = { ...authoringMetadata, version: 1, actions: authoringMetadata.actions || [] };
    }
    let motion;
    if (asset.data) {
        const bytes = Buffer.from(JSON.stringify({ ...asset.data, modelId: id })); asset.entries.set('motion.json', bytes);
        motion = { sourcePath: base + 'model.glb', sourceSha256: sha(asset.entries.get('model.glb')), rigPath: base + 'motion.glb', rigSha256: sha(asset.entries.get('motion.glb')),
            clipPath: base + 'motion.json', clipSha256: sha(bytes), actions: asset.actions };
        motion = { ...motionExtensions, ...motion };
        metadata.motionAuthoring = { ...(metadata.motionAuthoring || {}), version: 1, actions: metadata.motionAuthoring?.actions || [], bundle: motion };
    }
    const validatedMetadata = JSON.parse(stringifyModelMetadata(metadata, { name: m.name }));
    for (const key of ['acceptance', 'release', 'optimization', 'inspection']) if (metadata[key]) validatedMetadata[key] = preserveExtensions(metadata[key], validatedMetadata[key]);
    const model = { id, name: m.name.trim(), file_path: base + 'model.glb', factory_id: factoryId, asset_type: m.asset_type,
        placement_level: m.asset_type === 'environment' ? 'factory' : m.placement_level, default_scale: m.default_scale,
        tags: JSON.stringify(m.tags.filter(v => v !== 'packaged')), thumbnail: null, metadata: JSON.stringify(validatedMetadata) };
    authorize(model.metadata);
    let committed = false, owns = false;
    try {
        fs.mkdirSync(dest); owns = true;
        for (const [name, bytes] of asset.entries) if (name !== 'manifest.json') fs.writeFileSync(path.join(dest, name), bytes, { flag: 'wx' });
        // Prepare verifies rig hierarchy and recipe references with actual files.
        const prepared = authoring.prepare({ ...model, motion_package: motion });
        authoring.validateActions(metadata.motionAuthoring?.actions || [], prepared);
        await db.transaction(async tx => {
            if (!await tx.get('SELECT id FROM factories WHERE id = ?', [factoryId])) fail('所选工厂已删除');
            const keys = Object.keys(model);
            await tx.run(`INSERT INTO models (${keys.map(k => '`' + k + '`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => model[k]));
            if (requestId) await saveImportReceipt(tx, factoryId, token, inspectedSha256, model.id);
        });
        committed = true;
        return attachOwnedImport({ model: { ...model, motion_package: motion || null, is_builtin: false }, outcome: 'create' }, dest, model);
    } catch (error) {
        if (owns && !committed) {
            const owned = attachOwnedImport({}, dest, { ...model, motion_package: motion }).ownedImport;
            if (db.assetCollectionTransaction) Object.defineProperty(error, 'ownedImport', { value: owned });
            else await cleanupOwnedImport(db, owned, factoryId);
        }
        throw error;
    }
}
function attachOwnedImport(result, directory, model) {
    Object.defineProperty(result, 'ownedImport', { value: { directory, id: model.id, source: model.file_path,
        rig: model.motion_package?.rigPath || null, clip: model.motion_package?.clipPath || null } });
    return result;
}
async function updateModelActions(db, asset, plan, factoryId, packageSha256, authorize, requestId, token) {
    const target = plan.target, incoming = asset.manifest.model, raw = parse(target.metadata);
    const normalized = require('./modelAssetMetadata').normalizeModelMetadata(incoming.metadata, { name: incoming.name });
    const metadata = { ...raw, partBindings: normalized.partBindings,
        runtime: { ...(raw.runtime || {}), enableGenericBindings: normalized.runtime.enableGenericBindings },
        assetImport: { ...(raw.assetImport || {}), requestId: requestId || token, packageSha256,
            sourceModelId: raw.assetImport?.sourceModelId || incoming.id } };
    // Missing compiled assets are not an instruction to discard existing clips.
    // An explicit recipe supplied by a package is still validated below.
    if (Object.hasOwn(incoming.metadata, 'motionAuthoring')) {
        const { bundle, ...recipe } = incoming.metadata.motionAuthoring || {};
        metadata.motionAuthoring = { ...(raw.motionAuthoring || {}), ...recipe, version: 1, actions: recipe.actions || [] };
    }
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')), parent = path.join(root, 'projects');
    // An update gets immutable action files only, never another model.glb.
    const folder = 'actions_' + token, dest = path.join(parent, folder), base = '/uploads/projects/' + folder + '/';
    let motion = target.motion_package || raw.motionAuthoring?.bundle || null, owns = false, committed = false;
    try {
        if (asset.data) {
            fs.mkdirSync(parent, { recursive: true });
            if (!fs.realpathSync(parent).startsWith(fs.realpathSync(root) + path.sep)) fail('动作导入目录不在上传目录内');
            fs.mkdirSync(dest); owns = true;
            const bytes = Buffer.from(JSON.stringify({ ...asset.data, modelId: target.id }));
            fs.writeFileSync(path.join(dest, 'motion.glb'), asset.entries.get('motion.glb'), { flag: 'wx' });
            fs.writeFileSync(path.join(dest, 'motion.json'), bytes, { flag: 'wx' });
            const bundle = incoming.metadata.motionAuthoring?.bundle || {};
            const { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, actions, ...extensions } = bundle;
            motion = { ...extensions, sourcePath: target.file_path, sourceSha256: sha(asset.entries.get('model.glb')),
                rigPath: base + 'motion.glb', rigSha256: sha(asset.entries.get('motion.glb')),
                clipPath: base + 'motion.json', clipSha256: sha(bytes), actions: asset.actions };
            metadata.motionAuthoring = { ...(metadata.motionAuthoring || {}), version: 1,
                actions: incoming.metadata.motionAuthoring?.actions || [], bundle: motion };
        }
        // A narrow action update must not normalize/drop historical independent
        // metadata (custom inspection/release/render extensions in particular).
        // Incoming bindings were normalized and the whole package validated;
        // all unrelated target fields stay byte-for-value in the JSON object.
        const model = { ...target, metadata: JSON.stringify(metadata), motion_package: motion };
        authorize(model.metadata);
        const prepared = authoring.prepare(model);
        if (prepared.sourceSha256 !== sha(asset.entries.get('model.glb'))) throw Object.assign(new Error('模型源文件在检查后已改变，请重新检查动作包'), { statusCode: 409, code: 'IMPORT_PLAN_STALE' });
        authoring.validateActions(metadata.motionAuthoring?.actions || [], prepared);
        await db.transaction(async tx => {
            if (!await tx.get('SELECT id FROM factories WHERE id = ?', [factoryId])) fail('所选工厂已删除');
            await saveActionUpdate(tx, target, plan.record, model.metadata, factoryId, db.dialect || require('../db/database').getDbStatus().type);
            if (requestId) await saveImportReceipt(tx, factoryId, token, packageSha256, target.id);
        });
        committed = true;
        const result = { model, reused: true, updatedActions: true, outcome: 'update_actions' };
        return owns ? attachOwnedImport(result, dest, model) : result;
    } catch (error) {
        if (owns && !committed) {
            const owned = attachOwnedImport({}, dest, { ...target, motion_package: motion }).ownedImport;
            if (db.assetCollectionTransaction) Object.defineProperty(error, 'ownedImport', { value: owned });
            else await cleanupOwnedImport(db, owned, factoryId);
        }
        throw error;
    }
}
async function cleanupOwnedImport(db, owned, factoryId) {
    if (!owned) return;
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')), dest = path.resolve(owned.directory);
    if (path.dirname(dest) !== path.join(root, 'projects') || !/^(?:actions_)?[a-f0-9]{32}$/.test(path.basename(dest))) throw new Error('Invalid owned import directory');
    try {
        const record = await db.get('SELECT * FROM models WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)', [owned.id, factoryId]);
        const bundle = record ? parse(record.metadata).motionAuthoring?.bundle : null;
        if (record && (record.file_path.startsWith('/uploads/projects/' + path.basename(dest) + '/')
            || bundle?.rigPath === owned.rig && owned.rig || bundle?.clipPath === owned.clip && owned.clip)) return;
    } catch { return; } // An uncertain commit is not grounds to delete live assets.
    fs.rmSync(dest, { recursive: true, force: true });
}
module.exports = { FORMAT, MAX_BYTES, LIMITS, fileSha, boundedRead, validateAssetEntries, buildEntries, writeZip, exportAsset, inspectAsset, importAsset, importValidatedAsset, readAsset, validateMotion, cleanupOwnedImport };
