const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { getDb } = require('../db/database');
const { mergeBuiltinModels } = require('./builtinModels');
const { normalizeSettingValue } = require('../routes/settings');

const FORMAT = 'digital-twin-factory-bundle';
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SETTINGS = ['data_mode', 'simulation_interval_ms', 'realtime_stale_ms', 'native_quality_profile', 'native_environment_config', 'native_dashboard_config', 'site_scene_config'];
const SHARED_APPEARANCE = ['group_portal_config', 'loading_experience_config'];
// Explicit columns make the archive a portable configuration format, never an SQL dump.
const COLUMNS = Object.fromEntries(Object.entries({
    factories: 'id name location_json is_enabled sort_order',
    workshops: 'id factory_id name sort_order layout_json',
    lines: 'id name workshop_id layout_json sort_order',
    devices: 'id name line_id model_type model_file template_id instance_config pos_x pos_y pos_z rotation_y scale coordinate_space sort_order plc_enabled plc_protocol plc_ip plc_port plc_options plc_rack plc_slot plc_timeout plc_retry_interval plc_max_retries',
    data_points: 'id device_id name label plc_tag data_type category value_role quality scale offset expression display_format unit sample_interval_ms access_type db_number db_byte_offset bit_offset point_kind alarm_record_role alarm_text alarm_level alarm_condition voice_config alarm_high alarm_low',
    models: 'id name file_path factory_id placement_level asset_type tags thumbnail default_scale metadata',
    device_templates: 'id name model_type default_config',
    datapoint_templates: 'id device_template_id name label category value_role data_type unit scale offset expression display_format sort_order',
    projects: 'id factory_id name description is_active',
    scenes: 'id project_id name scene_type layout_json camera_json theme_json is_active sort_order draft_json draft_revision published_release_id',
    widgets: 'id scene_id widget_type title config_json binding_json x y w h sort_order visible',
    bindings: 'id widget_id source_type source_id path transform fallback',
    releases: 'id project_id version snapshot_json is_current scene_id notes schema_version draft_revision',
    factory_settings: 'factory_id key value'
}).map(([table, columns]) => [table, columns.split(' ')]));
const WARNINGS = ['现场 PLC 地址、连接选项及数据源凭据不迁移；导入设备采集已禁用，工厂以模拟模式启动。', '外部 API/数据库连接需在新工厂重新配置；远程资源仍依赖原远程服务。'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const roots = options => ({ uploads: path.resolve(options?.uploadsRoot || process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads')), assets: path.resolve(options?.assetsRoot || path.join(__dirname, '..', 'assets')) });

function walk(value, transform, key = '') {
    if (Array.isArray(value)) return value.map(item => walk(item, transform, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [transform(k, '__key'), walk(v, transform, k)]));
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { return transform(value, key); }
        return JSON.stringify(walk(parsed, transform, key));
    }
    return transform(value, key);
}

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
        key === 'plc_enabled' ? 0 : key === 'plc_options' ? '{}' :
            /password|passwd|secret|credential|authorization|api[_-]?key|token|cookie|^plc_ip$/i.test(key) ? '' : redact(val)]));
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
        try { return JSON.stringify(redact(JSON.parse(value))); } catch { /* ordinary text */ }
    }
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            url.username = ''; url.password = '';
            for (const key of [...url.searchParams.keys()]) if (/token|secret|password|api[_-]?key|credential/i.test(key)) url.searchParams.delete(key);
            return url.href;
        } catch { /* ordinary text */ }
    }
    return value;
}

function sanitize(rows) {
    const result = {};
    for (const [table, columns] of Object.entries(COLUMNS)) {
        result[table] = (rows[table] || []).map(row => redact(Object.fromEntries(columns.filter(key => row[key] !== undefined).map(key => [key, row[key]]))));
    }
    for (const device of result.devices) Object.assign(device, { plc_enabled: 0, plc_ip: '', plc_options: '{}' });
    result.factory_settings = result.factory_settings.filter(row => SETTINGS.includes(row.key));
    for (const row of result.factory_settings) if (row.key === 'data_mode') row.value = 'simulation';
    return result;
}

async function children(db, table, key, parents) {
    if (!parents.length) return [];
    const rows = [];
    for (let i = 0; i < parents.length; i += 300) {
        const batch = parents.slice(i, i + 300);
        rows.push(...await db.all(`SELECT * FROM \`${table}\` WHERE \`${key}\` IN (${batch.map(() => '?').join(',')})`, batch));
    }
    return rows;
}

async function snapshot(db, factoryId) {
    const factory = await db.get('SELECT * FROM factories WHERE id = ?', [factoryId]);
    if (!factory) throw new Error('工厂不存在');
    const rows = { factories: [factory] };
    rows.workshops = await children(db, 'workshops', 'factory_id', [factoryId]);
    rows.lines = await children(db, 'lines', 'workshop_id', rows.workshops.map(r => r.id));
    rows.devices = await children(db, 'devices', 'line_id', rows.lines.map(r => r.id));
    rows.data_points = await children(db, 'data_points', 'device_id', rows.devices.map(r => r.id));
    rows.projects = await children(db, 'projects', 'factory_id', [factoryId]);
    rows.scenes = await children(db, 'scenes', 'project_id', rows.projects.map(r => r.id));
    rows.widgets = await children(db, 'widgets', 'scene_id', rows.scenes.map(r => r.id));
    rows.bindings = await children(db, 'bindings', 'widget_id', rows.widgets.map(r => r.id));
    rows.releases = await children(db, 'releases', 'project_id', rows.projects.map(r => r.id));
    rows.device_templates = await children(db, 'device_templates', 'id', [...new Set(rows.devices.map(r => r.template_id).filter(Boolean))]);
    rows.datapoint_templates = await children(db, 'datapoint_templates', 'device_template_id', rows.device_templates.map(r => r.id));
    const independent = await children(db, 'factory_settings', 'factory_id', [factoryId]);
    const defaults = await children(db, 'settings', 'key', SETTINGS);
    rows.factory_settings = SETTINGS.map(key => ({ factory_id: factoryId, key, value: independent.find(r => r.key === key)?.value ?? defaults.find(r => r.key === key)?.value ?? (key === 'data_mode' ? 'simulation' : '') }));
    const references = new Set();
    walk(rows, value => { if (typeof value === 'string') references.add(value); return value; });
    rows.models = mergeBuiltinModels(await db.all('SELECT * FROM models')).filter(row => row.factory_id === factoryId || references.has(row.id) || (row.file_path && references.has(row.file_path)));
    const sharedAppearance = (await children(db, 'settings', 'key', SHARED_APPEARANCE))
        .map(row => ({ key: row.key, value: normalizeSettingValue(row.key, redact(row.value)) }));
    return { tables: sanitize(rows), sharedAppearance };
}

function localReference(value) {
    if (typeof value !== 'string') return null;
    if (!/^\/(?:uploads|assets)\//.test(value)) return null;
    const clean = value.split(/[?#]/)[0];
    let decoded;
    try { decoded = decodeURIComponent(clean); } catch { throw new Error('资产 URL 编码无效'); }
    if (/[\\\0:]/.test(decoded) || decoded.slice(1).split('/').some(part => !part || part === '.' || part === '..')) throw new Error('资产路径不安全');
    if (!/\.(glb|gltf|bin|png|jpe?g|webp|gif|ktx2?|dds|mp3|wav|ogg|m4a|aac|flac)$/i.test(decoded)) throw new Error('迁移包引用了不支持的资产类型');
    return decoded;
}

function sourceFile(url, dirs) {
    const root = url.startsWith('/uploads/') ? dirs.uploads : dirs.assets;
    const relative = url.replace(/^\/(uploads|assets)\//, '');
    const file = path.resolve(root, relative);
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    if (!realFile.startsWith(realRoot + path.sep) || !fs.statSync(realFile).isFile()) throw new Error('引用资产不在允许目录内');
    return realFile;
}

async function writeZip(filename, entries) {
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filename, { flags: 'wx' });
        const archive = archiver('zip', { zlib: { level: 1 } });
        output.on('close', resolve); output.on('error', reject); archive.on('error', reject);
        archive.pipe(output);
        for (const [name, bytes] of entries) archive.append(bytes, { name });
        archive.finalize();
    });
}

async function exportBundle(factoryId, filename, options = {}) {
    const db = options.db || await getDb();
    const configData = await db.transaction(tx => snapshot(tx, factoryId));
    const rows = configData.tables;
    const dirs = roots(options);
    const references = new Set();
    walk(configData, value => { const local = localReference(value); if (local) references.add(local); return value; });
    const assets = [];
    const entries = [];
    let total = 0;
    // Preserve relative dependency directories for .gltf buffers/textures.
    const pending = [...references];
    for (let i = 0; i < pending.length; i++) {
        if (pending.length > MAX_ENTRIES - 2) throw new Error('项目引用资产过多');
        const url = pending[i];
        let file;
        try { file = sourceFile(url, dirs); } catch (error) { throw new Error(`引用资产缺失或不可读：${url} (${error.message})`); }
        const stat = fs.statSync(file);
        if (stat.size > MAX_BYTES || total + stat.size > MAX_BYTES) throw new Error('迁移资产总量不能超过 512 MiB');
        const bytes = fs.readFileSync(file); total += bytes.length;
        if (/\.gltf$/i.test(url)) {
            const gltf = JSON.parse(bytes.toString('utf8'));
            for (const item of [...(gltf.buffers || []), ...(gltf.images || [])]) {
                if (!item.uri || item.uri.startsWith('data:')) continue;
                if (/^[a-z]+:|^\/|\\|[?#]/i.test(item.uri)) throw new Error(`模型必须使用内嵌或本地相对依赖：${url}`);
                const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(url), decodeURIComponent(item.uri)));
                if (!localReference(dependency)) throw new Error('模型依赖越出资产目录');
                if (!references.has(dependency)) { references.add(dependency); pending.push(dependency); }
            }
        }
        const archivePath = `assets${url}`;
        assets.push({ url, path: archivePath, size: bytes.length, sha256: hash(bytes) });
        entries.push([archivePath, bytes]);
    }
    const config = Buffer.from(JSON.stringify(configData));
    if (config.length > MAX_JSON) throw new Error('项目配置超过 16 MiB');
    const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), factoryName: rows.factories[0].name, config: { path: 'config.json', size: config.length, sha256: hash(config) }, assets, warnings: WARNINGS };
    entries.push(['config.json', config], ['manifest.json', Buffer.from(JSON.stringify(manifest))]);
    await writeZip(filename, entries);
    return manifest;
}

async function boundedRead(entry, limit) {
    const parts = []; let size = 0;
    for await (const part of entry.stream()) {
        size += part.length;
        if (size > limit) throw new Error('ZIP 解压内容超过限制');
        parts.push(part);
    }
    return Buffer.concat(parts);
}

function validateTables(tables) {
    if (!tables || typeof tables !== 'object' || Object.keys(tables).some(key => !COLUMNS[key])) throw new Error('迁移配置表无效');
    for (const [table, columns] of Object.entries(COLUMNS)) {
        if (!Array.isArray(tables[table]) || tables[table].length > 50000) throw new Error(`迁移配置 ${table} 无效或过大`);
        const seen = new Set();
        for (const row of tables[table]) {
            if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !columns.includes(key))) throw new Error(`迁移配置 ${table} 字段无效`);
            if (table !== 'factory_settings') {
                if (!['string', 'number'].includes(typeof row.id) || !String(row.id) || String(row.id).length > 128 || seen.has(String(row.id))) throw new Error(`迁移配置 ${table} ID 无效或重复`);
                seen.add(String(row.id));
            }
        }
    }
    if (tables.factories.length !== 1 || !String(tables.factories[0].name || '').trim()) throw new Error('迁移包必须包含一个工厂');
    const relations = { workshops: ['factory_id', 'factories'], lines: ['workshop_id', 'workshops'], devices: ['line_id', 'lines'], data_points: ['device_id', 'devices'], projects: ['factory_id', 'factories'], scenes: ['project_id', 'projects'], widgets: ['scene_id', 'scenes'], bindings: ['widget_id', 'widgets'], releases: ['project_id', 'projects'], datapoint_templates: ['device_template_id', 'device_templates'], factory_settings: ['factory_id', 'factories'] };
    for (const [table, [key, parent]] of Object.entries(relations)) {
        const ids = new Set(tables[parent].map(row => String(row.id)));
        if (tables[table].some(row => !ids.has(String(row[key])))) throw new Error(`迁移包 ${table} 引用了包外配置`);
    }
    for (const scene of tables.scenes) {
        if (scene.published_release_id && !tables.releases.some(row => row.id === scene.published_release_id && row.project_id === scene.project_id && (!row.scene_id || row.scene_id === scene.id))) throw new Error('场景发布引用不属于迁移项目');
    }
    for (const release of tables.releases) {
        if (release.scene_id && !tables.scenes.some(row => row.id === release.scene_id && row.project_id === release.project_id)) throw new Error('发布场景引用不属于迁移项目');
    }
    const settings = new Set();
    for (const row of tables.factory_settings) {
        if (!SETTINGS.includes(row.key) || settings.has(row.key)) throw new Error('工厂设置无效或重复');
        settings.add(row.key);
    }
}

async function readBundle(filename) {
    if (fs.statSync(filename).size > MAX_BYTES + MAX_JSON) throw new Error('ZIP 文件过大');
    const zip = await unzipper.Open.file(filename);
    if (zip.files.length > MAX_ENTRIES) throw new Error('ZIP 条目过多');
    const entries = new Map();
    for (const entry of zip.files) {
        if (entry.type === 'Directory') continue;
        if (entries.has(entry.path) || !/^(manifest\.json|config\.json|assets\/(uploads|assets)\/[\w.\-/ %\u0080-\uffff]+)$/.test(entry.path) || entry.path.split('/').some(part => part === '.' || part === '..' || !part) || entry.uncompressedSize > MAX_BYTES) throw new Error('ZIP 含非法或重复路径');
        entries.set(entry.path, entry);
    }
    if (!entries.has('manifest.json') || !entries.has('config.json')) throw new Error('ZIP 缺少迁移清单');
    const manifest = JSON.parse((await boundedRead(entries.get('manifest.json'), MAX_JSON)).toString('utf8'));
    if (manifest.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.config?.path !== 'config.json') throw new Error('不支持的项目迁移格式');
    if (manifest.assets.length + 2 !== entries.size) throw new Error('ZIP 清单与文件不一致');
    const content = new Map(); let total = 0; const urls = new Set();
    for (const descriptor of [manifest.config, ...manifest.assets]) {
        if (!descriptor || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptor.size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) throw new Error('ZIP 文件校验描述无效');
        if (descriptor !== manifest.config) {
            const local = localReference(descriptor.url);
            if (!local || local !== descriptor.url || descriptor.path !== `assets${local}` || urls.has(local)) throw new Error('ZIP 资产映射无效');
            urls.add(local);
        }
        const entry = entries.get(descriptor.path);
        if (!entry || content.has(descriptor.path)) throw new Error('ZIP 清单缺少资产或重复');
        const bytes = await boundedRead(entry, Math.min(descriptor.size, descriptor === manifest.config ? MAX_JSON : MAX_BYTES));
        total += bytes.length;
        if (total > MAX_BYTES + MAX_JSON || bytes.length !== descriptor.size || hash(bytes) !== descriptor.sha256) throw new Error('ZIP 资产大小或 SHA256 校验失败');
        content.set(descriptor.path, bytes);
    }
    const parsed = JSON.parse(content.get('config.json').toString('utf8'));
    const sharedAppearance = parsed.sharedAppearance || [];
    if (!Array.isArray(sharedAppearance) || sharedAppearance.length > SHARED_APPEARANCE.length) throw new Error('共享外观配置无效');
    const sharedKeys = new Set();
    for (const row of sharedAppearance) {
        if (!row || !SHARED_APPEARANCE.includes(row.key) || sharedKeys.has(row.key) || Object.keys(row).some(key => !['key', 'value'].includes(key))) throw new Error('共享外观只允许集团首页和加载画面设置');
        sharedKeys.add(row.key);
        row.value = normalizeSettingValue(row.key, redact(row.value));
    }
    for (const asset of manifest.assets.filter(item => /\.gltf$/i.test(item.url))) {
        const gltf = JSON.parse(content.get(asset.path).toString('utf8'));
        for (const item of [...(gltf.buffers || []), ...(gltf.images || [])]) {
            if (!item.uri || item.uri.startsWith('data:')) continue;
            if (/^[a-z]+:|^\/|\\|[?#]/i.test(item.uri)) throw new Error('模型依赖必须使用本地相对路径');
            const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(asset.url), decodeURIComponent(item.uri)));
            if (!urls.has(dependency)) throw new Error(`迁移包缺少模型依赖：${dependency}`);
        }
    }
    validateTables(parsed.tables);
    walk({ tables: parsed.tables, sharedAppearance }, value => { const local = localReference(value); if (local && !urls.has(local)) throw new Error(`迁移包缺少引用资产：${local}`); return value; });
    const tables = sanitize(parsed.tables);
    return { manifest, tables, content, sharedAppearance };
}

function inspectionOf(bundle) {
    return { format: FORMAT, version: 1, factoryName: bundle.tables.factories[0].name, counts: Object.fromEntries(Object.entries(bundle.tables).map(([key, rows]) => [key, rows.length])), assetCount: bundle.manifest.assets.length, assetBytes: bundle.manifest.assets.reduce((sum, item) => sum + item.size, 0), sharedAppearance: { available: bundle.sharedAppearance.length > 0, keys: bundle.sharedAppearance.map(row => row.key), affectsAllFactories: true }, warnings: [...WARNINGS, ...(bundle.sharedAppearance.length ? ['包内含集团首页与加载画面外观；默认不覆盖，勾选应用将影响本机所有工厂。'] : [])] };
}
async function sha256File(filename) {
    const digest = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(filename)) digest.update(bytes);
    return digest.digest('hex');
}
async function inspectBundle(filename) {
    const bundle = await readBundle(filename);
    return { inspection: inspectionOf(bundle), sha256: await sha256File(filename) };
}

async function insert(db, table, row) {
    const keys = Object.keys(row);
    return db.run(`INSERT INTO \`${table}\` (${keys.map(key => `\`${key}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]));
}

async function importBundle(filename, input = {}, options = {}) {
    if (input.applySharedAppearance !== undefined && ![true, false, 'true', 'false'].includes(input.applySharedAppearance)) throw new Error('共享外观应用选项无效');
    const applySharedAppearance = input.applySharedAppearance === true || input.applySharedAppearance === 'true';
    if (!/^[a-f0-9]{64}$/.test(input.inspectedSha256 || '') || await sha256File(filename) !== input.inspectedSha256) throw new Error('请先检查迁移包，文件已变化时需重新检查');
    const bundle = await readBundle(filename);
    const name = String(input.name || `${bundle.tables.factories[0].name}（导入）`).trim();
    if (!name || name.length > 120) throw new Error('新工厂名称须为 1-120 个字符');
    const db = options.db || await getDb();
    const token = crypto.randomBytes(12).toString('hex');
    const factoryId = `factory_${token}`;
    const dirs = roots(options);
    const destination = path.join(dirs.uploads, 'projects', token);
    const mappings = new Map(); const pointMappings = new Map();
    for (const [table, rows] of Object.entries(bundle.tables)) {
        if (table === 'data_points' || table === 'factory_settings') continue;
        for (const row of rows) {
            if (mappings.has(String(row.id))) throw new Error('迁移包跨表 ID 冲突，无法安全重绑定');
            mappings.set(String(row.id), table === 'factories' ? factoryId : `${table.slice(0, 10)}_${crypto.randomBytes(12).toString('hex')}`);
        }
    }
    const assetMap = new Map(bundle.manifest.assets.map(item => [item.url, `/uploads/projects/${token}${item.url}`]));
    const rewrite = (value, key) => {
        if (/^(pointId|point_id|dataPointId|data_point_id)$/.test(key) && pointMappings.has(String(value))) return typeof value === 'number' ? pointMappings.get(String(value)) : String(pointMappings.get(String(value)));
        if (typeof value !== 'string') return value;
        if (/^(connectionId|connection_id|sourceConnectionId)$/.test(key) && value) return `unconfigured_${token}_${hash(Buffer.from(value)).slice(0, 12)}`;
        const local = localReference(value);
        if (local && assetMap.has(local)) return assetMap.get(local) + value.slice(value.split(/[?#]/)[0].length);
        return mappings.get(value) || value;
    };
    let committed = false; let ownsDestination = false;
    const sharedAppearanceSettings = {};
    try {
        // All validation has completed before touching the destination. Files live
        // under a fresh random namespace; rollback never removes existing assets.
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (!fs.realpathSync(path.dirname(destination)).startsWith(fs.realpathSync(dirs.uploads) + path.sep)) throw new Error('资产目标目录不能链接到上传目录之外');
        fs.mkdirSync(destination);
        ownsDestination = true;
        for (const item of bundle.manifest.assets) {
            const output = path.join(destination, item.url.slice(1));
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, bundle.content.get(item.path), { flag: 'wx' });
        }
        await db.transaction(async tx => {
            for (const table of ['factories', 'workshops', 'lines', 'device_templates', 'datapoint_templates', 'models', 'devices', 'data_points', 'projects', 'scenes', 'widgets', 'bindings', 'releases', 'factory_settings']) {
                for (const original of bundle.tables[table]) {
                    const row = walk(original, rewrite);
                    if (table === 'factories') Object.assign(row, { name, is_enabled: 1 });
                    if (table === 'models') row.factory_id = factoryId;
                    if (table === 'data_points') delete row.id;
                    const result = await insert(tx, table, row);
                    if (table === 'data_points') {
                        // Drivers without insertId can resolve the freshly inserted
                        // row by the new, unique device namespace in this transaction.
                        const id = result.insertId || result.lastInsertRowid || (await tx.get('SELECT MAX(id) AS id FROM data_points WHERE device_id = ?', [row.device_id])).id;
                        pointMappings.set(String(original.id), Number(id));
                    }
                }
            }
            // Point IDs are database-generated. Repair earlier JSON payloads only
            // after all points exist, including numeric point references.
            for (const table of ['workshops', 'lines', 'device_templates', 'datapoint_templates', 'models', 'devices', 'data_points']) {
                for (const original of bundle.tables[table]) {
                    const row = walk(original, rewrite);
                    const fields = Object.keys(row).filter(key => key !== 'id' && row[key] !== original[key]);
                    if (!fields.length) continue;
                    const id = table === 'data_points' ? pointMappings.get(String(original.id)) : mappings.get(String(original.id));
                    await tx.run(`UPDATE \`${table}\` SET ${fields.map(key => `\`${key}\` = ?`).join(',')} WHERE id = ?`, [...fields.map(key => row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]), id]);
                }
            }
            if (!bundle.tables.factory_settings.some(row => row.key === 'data_mode')) await insert(tx, 'factory_settings', { factory_id: factoryId, key: 'data_mode', value: 'simulation' });
            if (applySharedAppearance) for (const original of bundle.sharedAppearance) {
                const row = walk(original, rewrite);
                const value = normalizeSettingValue(row.key, row.value);
                await tx.upsert('settings', { key: row.key, value }, 'key');
                sharedAppearanceSettings[row.key] = value;
            }
            if (options.beforeCommit) await options.beforeCommit(tx);
        });
        committed = true;
    } finally {
        if (!committed && ownsDestination && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    }
    return { factoryId, name, counts: inspectionOf(bundle).counts, warnings: inspectionOf(bundle).warnings, appliedSharedAppearance: applySharedAppearance && bundle.sharedAppearance.length > 0, sharedAppearanceSettings };
}

module.exports = { exportBundle, inspectBundle, importBundle, FORMAT, MAX_BYTES };
