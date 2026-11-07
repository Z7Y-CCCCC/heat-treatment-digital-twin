'use strict';
// Reuse only assets with identical geometry AND effective configuration. A name
// match is never evidence; a foreign factory's private asset is never a candidate.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { normalizeModelMetadata } = require('./modelAssetMetadata');
const { canonicalJson } = require('./deviceInspection');
const { mergeBuiltinModels } = require('./builtinModels');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = new Map(), MAX_HASHES = 128, RECEIPT_LIMIT = 256;
const RECEIPT_KEY = 'model_asset_import_receipts_v1';
let importTail = Promise.resolve();
// Acquire BEFORE a database transaction, including the outer collection
// transaction. Taking this gate inside a nested import can deadlock SQLite.
async function withModelImportLock(operation) {
    const before = importTail; let release;
    importTail = new Promise(resolve => { release = resolve; });
    await before;
    try { return await operation(); } finally { release(); }
}
function localFile(url, limit = 100 * 1024 * 1024) {
    if (typeof url !== 'string' || !/^\/(assets\/(models|motions)|uploads\/(models|projects))\//.test(url)
        || /[\\\0%?#]/.test(url) || url.split('/').some(p => p === '.' || p === '..')) throw new Error('模型资产路径无效');
    const root = url.startsWith('/uploads/') ? path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads')) : path.resolve(__dirname, '../assets');
    const file = fs.realpathSync(path.resolve(root, url.replace(/^\/(assets|uploads)\//, ''))), stat = fs.statSync(file);
    if (!file.startsWith(fs.realpathSync(root) + path.sep) || !stat.isFile() || stat.size > limit) throw new Error('模型资产不在允许目录内或超过大小限制');
    return { file, stat };
}
async function fileHash(url, limit) {
    const { file, stat } = localFile(url, limit), key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (hashes.has(key)) return hashes.get(key);
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    const value = hash.digest('hex');
    hashes.set(key, value); if (hashes.size > MAX_HASHES) hashes.delete(hashes.keys().next().value);
    return value;
}
function parse(value, fallback = {}) { return typeof value === 'string' ? JSON.parse(value || JSON.stringify(fallback)) : value || fallback; }
function preserveExtensions(raw, normalized) {
    if (Array.isArray(raw) && Array.isArray(normalized)) return normalized.map((value, index) => preserveExtensions(raw[index], value));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    const result = { ...normalized };
    for (const [key, value] of Object.entries(raw)) result[key] = Object.hasOwn(normalized, key) ? preserveExtensions(value, normalized[key]) : value;
    return result;
}
function normalizeMetadata(model, motion, options = {}) {
    const metadata = normalizeModelMetadata(model.metadata, { name: model.name });
    const raw = parse(model.metadata);
    for (const key of ['acceptance', 'release', 'optimization', 'inspection']) if (raw[key]) metadata[key] = preserveExtensions(raw[key], metadata[key]);
    if (options.ignoreLoadingPorts) delete metadata.loadingPorts;
    // This normalizer derives a default family from the display name. Explicit
    // non-name families and every other configuration/extension field remain.
    if (metadata.assetSpec.device_family === model.name) metadata.assetSpec.device_family = '';
    if (metadata.assetImport && typeof metadata.assetImport === 'object') {
        const { requestId, packageSha256, sourceModelId, ...extensions } = metadata.assetImport;
        if (typeof requestId === 'string' && /^[a-f0-9]{64}$/.test(packageSha256 || '')) {
            // Valid import provenance is not an effective model setting.
            if (sourceModelId != null && !/^[\w-]{1,128}$/.test(sourceModelId)) extensions.sourceModelId = sourceModelId;
            if (Object.keys(extensions).length) metadata.assetImport = extensions; else delete metadata.assetImport;
        }
    }
    if (motion) {
        const current = metadata.motionAuthoring || { version: 1, actions: [] };
        metadata.motionAuthoring = { ...current, version: current.version ?? 1, actions: current.actions || [] };
        const bundle = current.bundle;
        if (bundle) {
            // Only verified relocation fields may be dropped. Unknown bundle
            // fields and action descriptions remain part of the fingerprint.
            const { sourcePath, sourceSha256, rigPath, rigSha256, clipPath, clipSha256, ...extensions } = bundle;
            metadata.motionAuthoring.bundle = { actions: motion.actions, ...extensions };
        } else metadata.motionAuthoring.bundle = { actions: motion.actions };
    } else if (metadata.motionAuthoring?.bundle) throw new Error('动作资产缺失，不能确认模型相同');
    return metadata;
}
async function fingerprintModel(model, asset = null, options = {}) {
    const sourceHash = asset ? sha(asset.entries.get('model.glb')) : await fileHash(model.file_path);
    const raw = parse(model.metadata), bundle = raw.motionAuthoring?.bundle;
    const descriptor = model.motion_package || bundle;
    let motion = null;
    if (asset?.data) {
        motion = { rigHash: sha(asset.entries.get('motion.glb')), data: asset.data, actions: asset.actions };
    } else if (descriptor) {
        if (descriptor.sourcePath !== model.file_path || descriptor.sourceSha256 !== sourceHash) throw new Error('动作来源不匹配');
        const rigHash = await fileHash(descriptor.rigPath, 80 * 1024 * 1024), clipHash = await fileHash(descriptor.clipPath, 16 * 1024 * 1024);
        if (rigHash !== descriptor.rigSha256 || clipHash !== descriptor.clipSha256) throw new Error('动作资产已改变');
        const data = JSON.parse(fs.readFileSync(localFile(descriptor.clipPath, 16 * 1024 * 1024).file, 'utf8'));
        motion = { rigHash, data, actions: descriptor.actions };
    }
    let motionIdentity = null;
    if (motion) {
        if (motion.data.schemaVersion !== 1 || motion.data.modelId !== model.id || motion.data.sourceSha256 !== sourceHash
            || motion.data.rigSha256 !== motion.rigHash || !Array.isArray(motion.data.nodes) || !Array.isArray(motion.data.clips) || !Array.isArray(motion.actions)) throw new Error('动作内容与模型不匹配');
        const { modelId, ...data } = motion.data;
        motionIdentity = { rigHash: motion.rigHash, data, actions: motion.actions };
    }
    return sha(canonicalJson({ sourceHash, assetType: model.asset_type || 'model',
        placementLevel: model.asset_type === 'environment' ? 'factory' : model.placement_level || 'device',
        defaultScale: Number(model.default_scale || 1),
        tags: parse(model.tags, []).filter(tag => tag !== 'packaged').sort(),
        metadata: normalizeMetadata(model, motion, options), motion: motionIdentity }));
}
async function findDuplicateModel(db, model, factoryId, asset = null) {
    // A package omitting optional ports may reuse an otherwise identical richer
    // canonical asset. Explicit empty/null/custom ports are NEVER discarded.
    const options = { ignoreLoadingPorts: !Object.hasOwn(parse(model.metadata), 'loadingPorts') };
    let fingerprint, sourceHash;
    try {
        sourceHash = asset ? sha(asset.entries.get('model.glb')) : await fileHash(model.file_path);
        fingerprint = await fingerprintModel(model, asset, options);
    } catch { return null; }
    const rows = await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id = ?', [factoryId]);
    const candidates = mergeBuiltinModels(rows).filter(candidate => candidate.factory_id == null || candidate.factory_id === factoryId);
    // Prefer an existing shared/builtin canonical asset, then stable private ID.
    candidates.sort((a, b) => Number(b.factory_id == null) - Number(a.factory_id == null) || String(a.id).localeCompare(String(b.id)));
    for (const candidate of candidates) {
        try {
            if (await fileHash(candidate.file_path) !== sourceHash) continue;
            if (await fingerprintModel(candidate, null, options) === fingerprint) return candidate;
        } catch { /* fail closed for missing/corrupt/untrusted assets */ }
    }
    return null;
}
async function readImportReceipt(db, factoryId, token, packageSha256) {
    const row = await db.get('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?', [factoryId, RECEIPT_KEY]);
    const receipts = row ? parse(row.value, []) : [];
    if (!Array.isArray(receipts)) throw new Error('模型导入重试记录无效');
    const receipt = receipts.find(item => item.token === token);
    if (receipt && receipt.packageSha256 !== packageSha256) throw Object.assign(new Error('导入请求对应的文件已改变，请重新选择'), { statusCode: 409 });
    return receipt || null;
}
async function saveImportReceipt(tx, factoryId, token, packageSha256, modelId) {
    const row = await tx.get('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?', [factoryId, RECEIPT_KEY]);
    const receipts = row ? parse(row.value, []) : [];
    if (!Array.isArray(receipts)) throw new Error('模型导入重试记录无效');
    const previous = receipts.find(item => item.token === token);
    if (previous && previous.packageSha256 !== packageSha256) throw Object.assign(new Error('导入请求对应的文件已改变，请重新选择'), { statusCode: 409 });
    const value = JSON.stringify([...receipts.filter(item => item.token !== token), { token, packageSha256, modelId }].slice(-RECEIPT_LIMIT));
    // factory_settings has a COMPOSITE key. Generic upsert(..., 'key') would
    // update another factory's row on some database adapters.
    if (row) await tx.run('UPDATE factory_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE factory_id = ? AND `key` = ?', [value, factoryId, RECEIPT_KEY]);
    else await tx.run('INSERT INTO factory_settings (factory_id, `key`, value) VALUES (?, ?, ?)', [factoryId, RECEIPT_KEY, value]);
}
module.exports = { withModelImportLock, fingerprintModel, findDuplicateModel, readImportReceipt, saveImportReceipt, fileHash, normalizeMetadata, preserveExtensions, RECEIPT_LIMIT, RECEIPT_KEY };
