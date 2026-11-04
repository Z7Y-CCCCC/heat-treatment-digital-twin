'use strict';
// A selective model/environment + motion asset package, NOT a database backup.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const archiver = require('archiver'), unzipper = require('unzipper');
const authoring = require('./motionAuthoring');
const { mergeBuiltinModels } = require('./builtinModels');
const { stringifyModelMetadata } = require('./modelAssetMetadata');
const FORMAT = 'digital-twin-model-asset', MAX_BYTES = 184 * 1024 * 1024;
const LIMITS = { 'manifest.json': 4 * 1024 * 1024, 'model.glb': 80 * 1024 * 1024, 'motion.glb': 80 * 1024 * 1024, 'motion.json': 16 * 1024 * 1024 };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
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
        archive.pipe(output); for (const [name, bytes] of entries) archive.append(bytes, { name }); archive.finalize();
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
    if (metadata.motionAuthoring) metadata.motionAuthoring = { version: 1, actions: metadata.motionAuthoring.actions || [] };
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
async function inspectAsset(filename) {
    const asset = await readAsset(filename);
    return { inspectedSha256: sha(fs.readFileSync(filename)), model: { id: asset.manifest.model.id, name: asset.manifest.model.name,
        assetType: asset.manifest.model.asset_type, placementLevel: asset.manifest.model.placement_level },
        actions: asset.actions, files: asset.manifest.files };
}
async function importAsset(db, filename, factoryId, inspectedSha256, authorize = () => {}) {
    if (!/^[a-f0-9]{64}$/.test(inspectedSha256 || '') || sha(fs.readFileSync(filename)) !== inspectedSha256) fail('请先检查模型动作包，文件变化后需重新检查');
    const asset = await readAsset(filename), m = asset.manifest.model;
    if (!await db.get('SELECT id FROM factories WHERE id = ?', [factoryId])) fail('请先创建并选择工厂');
    const token = crypto.randomBytes(16).toString('hex'), id = 'asset_' + token;
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')), parent = path.join(root, 'projects'), dest = path.join(parent, token);
    fs.mkdirSync(parent, { recursive: true });
    if (!fs.realpathSync(parent).startsWith(fs.realpathSync(root) + path.sep)) fail('模型导入目录不在上传目录内');
    const base = '/uploads/projects/' + token + '/', metadata = { ...m.metadata };
    if (metadata.motionAuthoring) metadata.motionAuthoring = { version: 1, actions: metadata.motionAuthoring.actions || [] };
    let motion;
    if (asset.data) {
        const bytes = Buffer.from(JSON.stringify({ ...asset.data, modelId: id })); asset.entries.set('motion.json', bytes);
        motion = { sourcePath: base + 'model.glb', sourceSha256: sha(asset.entries.get('model.glb')), rigPath: base + 'motion.glb', rigSha256: sha(asset.entries.get('motion.glb')),
            clipPath: base + 'motion.json', clipSha256: sha(bytes), actions: asset.actions };
        metadata.motionAuthoring = { version: 1, actions: metadata.motionAuthoring?.actions || [], bundle: motion };
    }
    const model = { id, name: m.name.trim(), file_path: base + 'model.glb', factory_id: factoryId, asset_type: m.asset_type,
        placement_level: m.asset_type === 'environment' ? 'factory' : m.placement_level, default_scale: m.default_scale,
        tags: JSON.stringify(m.tags.filter(v => v !== 'packaged')), thumbnail: null, metadata: stringifyModelMetadata(metadata, { name: m.name }) };
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
        });
        committed = true;
        return { model: { ...model, motion_package: motion || null, is_builtin: false } };
    } finally { if (owns && !committed) fs.rmSync(dest, { recursive: true, force: true }); }
}
module.exports = { FORMAT, MAX_BYTES, buildEntries, writeZip, exportAsset, inspectAsset, importAsset, readAsset, validateMotion };
