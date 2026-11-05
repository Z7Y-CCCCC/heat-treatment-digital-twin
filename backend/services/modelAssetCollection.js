'use strict';
// One portable ZIP with one validated model+motion directory per selection.
// Binary payloads are processed one model at a time, never all held in memory.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const unzipper = require('unzipper'), single = require('./modelAssetBundle');
const { mergeBuiltinModels } = require('./builtinModels');
const FORMAT = 'digital-twin-model-collection', MAX_MODELS = 32;
const MAX_BYTES = 512 * 1024 * 1024, MAX_EXPANDED = 480 * 1024 * 1024, MAX_FILES = MAX_MODELS * 4 + 1;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
function selection(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_MODELS || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) fail('请选择 1–32 个不同模型');
    return ids;
}
async function exportCollection(db, ids, factoryId, filename) {
    selection(ids);
    const records = await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id = ?', [factoryId]);
    const models = new Map(mergeBuiltinModels(records).map(m => [m.id, m]));
    if (ids.some(id => !models.has(id))) fail('部分模型已不存在或不属于所选工厂，请重新选择');
    const stage = fs.mkdtempSync(path.join(path.dirname(filename), '.model-collection-'));
    try {
        const entries = new Map(), manifest = { format: FORMAT, version: 1, models: [] }; let total = 0;
        for (const [index, id] of ids.entries()) {
            const model = models.get(id), label = [...model.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')].slice(0, 40).join('').replace(/[. ]+$/, '') || id;
            const directory = `models/${String(index + 1).padStart(2, '0')}-${label}`;
            const files = single.buildEntries(model);
            total += [...files.values()].reduce((n, bytes) => n + bytes.length, 0);
            if (total > MAX_EXPANDED) fail('所选模型解压后超过 480 MB，请分批导出');
            manifest.models.push({ directory, id, name: model.name, manifestSha256: sha(files.get('manifest.json')) });
            const folder = path.join(stage, String(index)); fs.mkdirSync(folder);
            for (const [name, bytes] of files) {
                const file = path.join(folder, name); fs.writeFileSync(file, bytes, { flag: 'wx' }); entries.set(directory + '/' + name, { file });
            }
        }
        entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
        await single.writeZip(filename, entries);
        if (fs.statSync(filename).size > MAX_BYTES) fail('动作合集超过 512 MB，请分批导出');
        return manifest;
    } finally {
        if (path.dirname(stage) !== path.dirname(filename) || !path.basename(stage).startsWith('.model-collection-')) throw new Error('Invalid owned export staging path');
        fs.rmSync(stage, { recursive: true, force: true });
    }
}
async function openZip(filename) {
    const stat = fs.statSync(filename);
    if (stat.size > MAX_BYTES) fail('动作包超过 512 MB，请分批导入');
    // Bound the central directory before unzipper allocates its entries. Our
    // <=512 MB / 129-file format never needs ZIP64 or multi-volume archives.
    const fd = fs.openSync(filename, 'r'), tail = Buffer.alloc(Math.min(stat.size, 65557));
    try { fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length); } finally { fs.closeSync(fd); }
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    if (eocd < 0) fail('不是完整的动作包 ZIP');
    const count = tail.readUInt16LE(eocd + 10), size = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
    if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || tail.readUInt16LE(eocd + 8) !== count || count < 2 || count > MAX_FILES
        || size > 2 * 1024 * 1024 || offset + size !== stat.size - tail.length + eocd) fail('动作包文件数量、目录大小或分卷格式不受支持');
    const zip = await unzipper.Open.file(filename);
    if (zip.files.length !== count) fail('动作包目录不完整');
    const entries = new Map(); let expanded = 0;
    for (const entry of zip.files) {
        if (entry.type !== 'File' || entries.has(entry.path) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) fail('动作包含非法或重复文件');
        expanded += entry.uncompressedSize; if (expanded > MAX_EXPANDED) fail('动作包解压后超过 480 MB');
        entries.set(entry.path, entry);
    }
    const root = entries.get('manifest.json'); if (!root) fail('缺少动作包目录');
    const manifestBytes = await single.boundedRead(root, single.LIMITS['manifest.json']);
    const manifest = JSON.parse(manifestBytes);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('动作包目录格式无效');
    if (manifest.format === single.FORMAT) return { single: true };
    if (manifest.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.models) || !manifest.models.length || manifest.models.length > MAX_MODELS) fail('不支持的动作合集格式');
    const expected = new Set(['manifest.json']), ids = new Set(), directories = new Set();
    for (const m of manifest.models) {
        if (!m || typeof m.directory !== 'string' || !/^models\/[0-9]{2}-[^<>:"/\\|?*\x00-\x1f]{1,80}$/.test(m.directory)
            || m.directory.endsWith('.') || m.directory.endsWith(' ') || directories.has(m.directory) || !/^[\w-]{1,128}$/.test(m.id)
            || ids.has(m.id) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120 || !/^[a-f0-9]{64}$/.test(m.manifestSha256)) fail('动作合集模型目录无效或重复');
        ids.add(m.id); directories.add(m.directory);
        for (const name of Object.keys(single.LIMITS)) if (entries.has(m.directory + '/' + name)) expected.add(m.directory + '/' + name);
    }
    if (entries.size !== expected.size || [...entries.keys()].some(name => !expected.has(name))) fail('动作合集包含非法路径或多余文件');
    return { manifest, entries, manifestBytes: manifestBytes.length };
}
async function readModel(collection, descriptor, budget) {
    try {
        const files = new Map();
        for (const [name, limit] of Object.entries(single.LIMITS)) {
            const entry = collection.entries.get(descriptor.directory + '/' + name);
            if (entry) {
                const bytes = await single.boundedRead(entry, Math.min(limit, MAX_EXPANDED - budget.bytes));
                budget.bytes += bytes.length; files.set(name, bytes);
            }
        }
        if (!files.has('manifest.json') || sha(files.get('manifest.json')) !== descriptor.manifestSha256) fail('动作合集子目录清单校验失败');
        const asset = single.validateAssetEntries(files);
        if (asset.manifest.model.id !== descriptor.id || asset.manifest.model.name !== descriptor.name) fail('动作合集目录与模型不匹配');
        return asset;
    } catch (error) { error.message = descriptor.name + '：' + error.message; throw error; }
}
function summary(asset) {
    const m = asset.manifest.model;
    return { model: { id: m.id, name: m.name, assetType: m.asset_type, placementLevel: m.placement_level },
        actions: asset.actions.map(({ id, label, mode, duration }) => ({ id, label, mode, duration })), files: asset.manifest.files };
}
async function inspectPackage(filename) {
    const collection = await openZip(filename);
    if (collection.single) return { ...await single.inspectAsset(filename), isCollection: false };
    const models = [], budget = { bytes: collection.manifestBytes };
    for (const descriptor of collection.manifest.models) models.push(summary(await readModel(collection, descriptor, budget)));
    return { inspectedSha256: await single.fileSha(filename), isCollection: true, models };
}
async function importPackage(db, filename, factoryId, inspectedSha256, authorize = () => {}, requestId = '') {
    if (!/^[a-f0-9]{64}$/.test(inspectedSha256 || '') || await single.fileSha(filename) !== inspectedSha256) fail('请先检查动作包，文件变化后需重新检查');
    const collection = await openZip(filename);
    if (collection.single) return single.importValidatedAsset(db, await single.readAsset(filename), factoryId, inspectedSha256, authorize, requestId);
    if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail('导入请求标识无效');
    // Preflight the entire archive before creating any uploaded file or row.
    const preflight = { bytes: collection.manifestBytes };
    for (const descriptor of collection.manifest.models) await readModel(collection, descriptor, preflight);
    const models = [], created = [], batchId = requestId || crypto.randomUUID();
    try {
        await db.transaction(async tx => {
            const nested = Object.create(tx); nested.transaction = fn => fn(tx);
            const budget = { bytes: collection.manifestBytes };
            for (const [index, descriptor] of collection.manifest.models.entries()) {
                const itemId = sha(Buffer.from(batchId + '\0' + index));
                const asset = await readModel(collection, descriptor, budget);
                let result;
                try { result = await single.importValidatedAsset(nested, asset, factoryId, inspectedSha256, authorize, itemId); }
                catch (error) { error.message = descriptor.name + '：' + error.message; throw error; }
                models.push(result.model); if (!result.reused) created.push(result.model);
            }
        });
    } catch (error) {
        // On an uncertain database commit, retain assets rather than deleting
        // a possibly committed model. Clean only our known, rolled-back rows.
        for (const model of created) {
            let exists = true;
            try { exists = !!await db.get('SELECT id FROM models WHERE id = ? AND factory_id = ?', [model.id, factoryId]); } catch { /* keep files until database is available */ }
            if (exists) continue;
            const root = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../uploads'));
            const dest = path.join(root, 'projects', model.id.slice('asset_'.length));
            if (!/^asset_[a-f0-9]{32}$/.test(model.id) || path.dirname(dest) !== path.join(root, 'projects')) throw new Error('Invalid owned import directory');
            fs.rmSync(dest, { recursive: true, force: true });
        }
        throw error;
    }
    return { isCollection: true, models };
}
module.exports = { FORMAT, MAX_MODELS, MAX_BYTES, MAX_EXPANDED, exportCollection, inspectPackage, importPackage, openZip };
