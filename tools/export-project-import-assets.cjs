'use strict';
// SELECT-only export of the launcher's live asset references. No DB backups,
// passwords, PLC connections or runtime device state enter the import directory.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), out = path.join(root, '导入文件');
const parse = x => typeof x === 'string' ? JSON.parse(x || '{}') : x || {};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const walk = (v, refs) => {
    if (typeof v === 'string') { refs.add(v); if (/^\s*[\[{]/.test(v)) { try { walk(JSON.parse(v), refs); } catch {} } }
    else if (v && typeof v === 'object') for (const value of Object.values(v)) walk(value, refs);
};
async function main() {
    const user = path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop');
    process.env.UPLOADS_DIR = path.join(user, 'uploads');
    const config = parse(fs.readFileSync(path.join(user, 'data/database-config.json'), 'utf8'));
    if (config.type !== 'mysql' || config.host !== '127.0.0.1') throw Error('只读导出仅允许已保存的本地 MySQL');
    const db = await require('../backend/node_modules/mysql2/promise').createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const bundle = require('../backend/services/modelAssetBundle'), { mergeBuiltinModels } = require('../backend/services/builtinModels');
    const inventory = { format: 'project-import-asset-library', version: 1, exportedAt: new Date().toISOString(), readOnlyDatabase: true, projects: [], library: [], sources: [] };
    try {
        await db.query('SET SESSION TRANSACTION READ ONLY'); await db.beginTransaction();
        const query = async (sql, args = []) => (await db.query(sql, args))[0];
        const active = (await query("SELECT value FROM settings WHERE `key`='active_factory_id'"))[0]?.value;
        const factories = await query('SELECT id,name FROM factories');
        const registry = mergeBuiltinModels(await query('SELECT * FROM models'));
        const exportModel = async (model, dir) => {
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, model.id), zip = target + '.zip';
            const entries = bundle.buildEntries(model); fs.mkdirSync(target, { recursive: true });
            for (const [name, bytes] of entries) {
                const file = path.join(target, name);
                if (fs.existsSync(file) && hash(fs.readFileSync(file)) !== hash(bytes)) throw Error('导出目标已有不同版本，拒绝覆盖：' + file);
                fs.writeFileSync(file, bytes);
            }
            if (!fs.existsSync(zip)) await bundle.writeZip(zip, entries);
            const checked = await bundle.inspectAsset(zip);
            const metadata = parse(model.metadata);
            fs.writeFileSync(path.join(target, '模型动作配置.json'), JSON.stringify({ format: 'digital-twin-model-actions', version: 1, modelId: model.id,
                partBindings: metadata.partBindings || [], authoringActions: metadata.motionAuthoring?.actions || [], sampledActions: checked.actions,
                note: '选择完整模型资产 ZIP 导入；该文件为展开的动作编排/信号映射说明，不是数据库备份。' }, null, 2));
            return { id: model.id, name: model.name, originalPath: model.file_path, assetType: model.asset_type, zip: path.relative(out, zip),
                sha256: checked.inspectedSha256, actions: checked.actions.map(a => ({ id: a.id, label: a.label })), files: checked.files };
        };
        for (const factory of factories) {
            const refs = new Set();
            const devices = await query('SELECT d.id,d.name,d.model_type,d.model_file,d.instance_config FROM devices d JOIN `lines` l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=?', [factory.id]);
            const scenes = await query('SELECT s.draft_json,s.layout_json,s.camera_json FROM scenes s JOIN projects p ON p.id=s.project_id WHERE p.factory_id=?', [factory.id]);
            const releases = await query('SELECT r.snapshot_json FROM releases r JOIN projects p ON p.id=r.project_id WHERE p.factory_id=?', [factory.id]);
            const settings = await query('SELECT `key`,value FROM factory_settings WHERE factory_id=?', [factory.id]);
            walk([devices, scenes, releases, settings], refs);
            // Existing developer Unity also loads this hall from StreamingAssets.
            if (factory.id === active) refs.add('factory_hall_lowpoly');
            const models = registry.filter(m => refs.has(m.id) || refs.has(m.file_path) || m.factory_id === factory.id);
            const record = { id: factory.id, name: factory.name, active: factory.id === active, models: [] };
            for (const model of models) record.models.push(await exportModel(model, path.join(out, '项目资产', factory.id)));
            const projectDir = path.join(out, '项目资产', factory.id); fs.mkdirSync(projectDir, { recursive: true });
            fs.writeFileSync(path.join(projectDir, '设备动作绑定.json'), JSON.stringify({ format: 'digital-twin-device-actions', version: 1, factoryId: factory.id,
                devices: devices.map(d => { const config = parse(d.instance_config); return { id: d.id, name: d.name, modelId: d.model_type,
                    animationBindings: config.animationBindings || null, mobileMotion: config.mobileMotion || config.mobile_motion || null, transferSequence: config.transferSequence || null }; }),
                note: '原设备动作绑定单独导出供重新配置时参考；点位 ID 必须在目标项目重新选择，不能跨项目直接启用。' }, null, 2));
            inventory.projects.push(record);
        }
        // Later CAD deliverables are optional project inputs, never system defaults.
        for (const model of registry.filter(m => m.id.startsWith('cad_') || m.id === 'factory_hall_lowpoly')) inventory.library.push(await exportModel(model, path.join(out, '正式模型资产')));
        await db.rollback();
        for (const dir of ['cad_general_20261103_v1', 'cad_multipurpose_furnace_600_20261103_v1', 'factory_hall_study', 'pit_furnace_references_v1']) {
            const source = path.join(root, 'backend/assets/models', dir);
            const copy = (current, relative = '') => {
                for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                    const rel = path.join(relative, entry.name), full = path.join(current, entry.name);
                    if (entry.isDirectory()) { if (!entry.name.startsWith('backup-')) copy(full, rel); }
                    else if (/\.blend$|\.md$/.test(entry.name) && !/working\.blend$/.test(entry.name)) {
                        const target = path.join(out, '建模源工程', dir, rel); fs.mkdirSync(path.dirname(target), { recursive: true });
                        const bytes = fs.readFileSync(full); fs.writeFileSync(target, bytes);
                        if (hash(fs.readFileSync(target)) !== hash(bytes)) throw Error('源工程复制校验失败');
                        inventory.sources.push({ file: path.relative(out, target), sha256: hash(bytes), bytes: bytes.length });
                    }
                }
            };
            if (fs.existsSync(source)) copy(source);
        }
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, '资产清单.json'), JSON.stringify(inventory, null, 2));
        fs.writeFileSync(path.join(out, '使用说明.md'), '# 项目导入文件\n\n本目录不进入安装包，不是数据库备份。\n\n- 项目资产：当前启动器所保存的各工厂引用的模型，活动工厂见资产清单。\n- 正式模型资产：后续 CAD 设备和厂房的可选导入包。\n- 建模源工程：供后续修改的 Blender 文件；不是运行依赖。格式不能说明模型粗糙。\n- 每个模型有同名 ZIP 与展开目录。ZIP 可在后台模型管理/模型动画的“导入模型 / 厂房 / 动作包”中先检查再导入。展开目录有 model.glb，以及模型存在动作时的 motion.glb、motion.json。\n- 导入始终创建新模型，保留拆解、部位绑定、动作及配方。不自动绑定现有设备、不复制工厂/数据库/PLC/API凭据。\n- 单独 GLB 使用“导入模型”；要带动作请导入对应 ZIP，不能把 motion.glb 当作原始模型导入。\n- 源工程 ZIP 的旧重复分发件与厂房 backup-before-detail-v2 不进入本目录或新安装包。\n');
        console.log(JSON.stringify({ directory: out, projects: inventory.projects.map(p => ({ id: p.id, active: p.active, models: p.models.length })), formalAssets: inventory.library.length, sourceFiles: inventory.sources.filter(s => s.file.endsWith('.blend')).length }, null, 2));
    } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
