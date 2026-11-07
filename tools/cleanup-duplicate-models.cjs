'use strict';
// One-off, audited cleanup for Ethan's local library. Default: READ ONLY.
// No database initializer, model-file deletion, PLC write, Unity or restart.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const PAIRS = Object.freeze([
  ['asset_2d98e9803232e5d59bc568887d77859b', 'cad_water_cooling_tank_471000'],
  ['asset_3864568e4302f27d1560811e3e61b4a1', 'cad_multipurpose_furnace_082000'],
  ['asset_6cd23da88c9a91154170901f2aae2e3b', 'cad_transfer_cart_101300'],
  ['asset_7b19b7d8672f374236e633456b04610c', 'cad_fixed_load_table_112200'],
  ['asset_88b8154de87bba1f17e62c32f1580d11', 'cad_tempering_furnace_091300'],
  ['asset_8d15e2b71052602c948aecc6fe06e0bb', 'cad_cleaner_170700'],
  ['asset_c62e9a3f23f989771fb7b89d10bcace9', 'cad_lifting_load_table_111400']
]);
const EXPECTED_DEVICES = Object.freeze({ '111': PAIRS[2][0], qxj: PAIRS[5][0] });
const VARIANT = 'asset_ca187cc57e96af04eeba56055c8b1223', VARIANT_SOURCE = 'cad_air_cooling_table_115800ht';
const VARIANT_NAME = '风冷台 · 11.58.00HT CAD', RENAMED_VARIANT = VARIANT_NAME + ' · 独立进出料口配置';
// Fingerprints of the independently captured 2026-11-07 read-only audit.
const EXPECTED_ROWS = Object.freeze({
  asset_2d98e9803232e5d59bc568887d77859b: '9b0540aa4ba80712d33ed533c99a4193ca3c05e0bd303d3e8a6ebd99224cfa63',
  asset_3864568e4302f27d1560811e3e61b4a1: 'bca90fdb8d00b60f66ed8ee27bd2cdc75f68636e81ad72465bfbcb382efe6626',
  asset_6cd23da88c9a91154170901f2aae2e3b: 'b257ed2dfdd8ba62acbb25d89b498f464fd08d9bba541a29727c19329e7854d5',
  asset_7b19b7d8672f374236e633456b04610c: '9fdd9e33923c587b13e6b72f3b446834f1fe05619f7be9faa6cdab50b02c7afa',
  asset_88b8154de87bba1f17e62c32f1580d11: '8a5b09f3ef417546ff32b689267c27f457d99a55a2be91afd027f6c03c72c3b7',
  asset_8d15e2b71052602c948aecc6fe06e0bb: '645bed3154e496fecf74148addcf705dad4994e6c8c8f28538d2251fa5a9cb44',
  asset_c62e9a3f23f989771fb7b89d10bcace9: '948055d8ddf7bf98ecaf09ad28913870fa390fc48483dd7c1b5f8cda762db3ac',
  asset_ca187cc57e96af04eeba56055c8b1223: 'b29c0f323e046481c601a93644bb23f198bec797fe9a5b5811b809324acab357',
  cad_air_cooling_table_115800ht: '02123b2bb90ef04df86ff2027176ca41177d4974044dba5ad3eb2c6634f5d914',
  cad_cleaner_170700: 'bdf2ff9887362e920f85736605ab07b52edc15736daa5442df421b3490ed545b',
  cad_fixed_load_table_112200: '3d0c7fe4304b0d57d126edfc4780b4f898cd768966bcb1c7d615d2a96c54c4fa',
  cad_lifting_load_table_111400: '1c25ae8313585f54a35eb5aff78d12a4977ab103ac8f5474e9d94fa3abe2bf6a',
  cad_multipurpose_furnace_082000: '337f9b29c42ee06cc8677c4698d7c9003fed1c49b4d29b585c4c1c3d2a93a7b5',
  cad_tempering_furnace_091300: '1811236f15e5a1026040aba7a0f87047501a1009ad774c22be2f7a59b5d0de9e',
  cad_transfer_cart_101300: '5ff6d294ff7528f0ecbd56f2e835743ccb237db3b456ea89a5974a083c364dad',
  cad_water_cooling_tank_471000: '8af7ce31467a715b4942d89b2b19bb2495f267cbf3efc3a2416771c08c695514'
});
const EXPECTED_SCHEMA = '12f64f682f08ebcc01f5d8aeb4fd43de5daf7045afe4ebbf9e30e22d86460a49';
const CONFIG_TABLES = Object.freeze(['bindings', 'data_points', 'datapoint_templates', 'device_templates', 'devices', 'factories', 'factory_settings', 'lines', 'models', 'projects', 'releases', 'scenes', 'settings', 'widgets', 'workshops']);
const HISTORICAL_TABLES = Object.freeze(['event_logs', 'metric_snapshots']);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const stable = value => JSON.stringify(normalize(value));
const digest = value => sha(stable(value));
const parse = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
const fail = message => { throw new Error(message); };
const equal = (a, b, description) => { if (stable(a) !== stable(b)) fail(description); };
function resolveAsset(url, roots) {
  if (typeof url !== 'string' || !/^\/(assets|uploads)\//.test(url)) fail('非本地受保护资产路径');
  const prefix = url.startsWith('/assets/') ? '/assets/' : '/uploads/';
  const root = fs.realpathSync(prefix === '/assets/' ? roots.assets : roots.uploads);
  let suffix; try { suffix = decodeURIComponent(url.slice(prefix.length)); } catch { fail('资产路径编码无效'); }
  const filename = path.resolve(root, suffix);
  if (!filename.startsWith(root + path.sep)) fail('资产路径越界');
  const real = fs.realpathSync(filename);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) fail('资产路径或符号链接越界');
  return real;
}
function verifyFile(url, expected, roots, evidence) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) fail('缺少可验证文件指纹');
  const filename = resolveAsset(url, roots), bytes = fs.readFileSync(filename), actual = sha(bytes);
  if (actual !== expected) fail('资产文件已变化：' + url);
  evidence.push({ url, filename, bytes: bytes.length, sha256: actual });
  return bytes;
}
function semanticMetadata(metadata, original) {
  const value = parse(metadata);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('模型 metadata 无效');
  if (!original) {
    if (Object.hasOwn(value, 'loadingPorts') || Object.hasOwn(value, 'loading_ports')) fail('副本已有独立进出料口，禁止合并');
    const transport = value.assetImport;
    if (!transport || stable(Object.keys(transport).sort()) !== stable(['packageSha256', 'requestId'])
      || !/^[a-f0-9]{64}$/.test(transport.packageSha256 || '') || !/^[a-zA-Z0-9-]{16,80}$/.test(transport.requestId || '')) fail('未经核对的导入元数据');
    delete value.assetImport;
    const authoring = value.motionAuthoring;
    if (!authoring || authoring.version !== 1 || !Array.isArray(authoring.actions) || authoring.actions.length
      || Object.keys(authoring).some(key => !['version', 'actions', 'bundle'].includes(key))) fail('副本存在作者动作或未知配置');
    delete value.motionAuthoring; // The verified bundle is compared separately, byte-for-byte.
  } else {
    if (Object.hasOwn(value, 'assetImport') || Object.hasOwn(value, 'motionAuthoring')) fail('原件已有导入或作者动作，需重新核查');
    if (!value.loadingPorts || Object.hasOwn(value, 'loading_ports')) fail('原件默认进出料口缺失或结构改变');
    delete value.loadingPorts; // Only omission in the older copy is allowed; source is never edited.
  }
  return value;
}
function verifyPair(original, copy, builtinMotion, roots) {
  const evidence = [];
  if (!original || !copy) fail('原件或副本不存在');
  if (original.factory_id !== null || copy.factory_id !== 'factory_default') fail('模型工厂作用域改变');
  equal({ name: original.name, type: original.asset_type, level: original.placement_level, scale: original.default_scale },
    { name: copy.name, type: copy.asset_type, level: copy.placement_level, scale: copy.default_scale }, '模型名称、缩放或适用层级不同');
  equal(parse(original.tags).filter(tag => tag !== 'packaged'), parse(copy.tags), '模型标签存在非运输差异');
  const originalMeta = parse(original.metadata), copyMeta = parse(copy.metadata), motion = copyMeta.motionAuthoring?.bundle;
  equal(semanticMetadata(original.metadata, true), semanticMetadata(copy.metadata, false), '拆解、绑定或其他模型配置不同');
  if (!motion || !builtinMotion || builtinMotion.sourcePath !== original.file_path || motion.sourcePath !== copy.file_path) fail('模型动作路径不匹配');
  equal(Object.keys(motion).sort(), ['actions', 'clipPath', 'clipSha256', 'rigPath', 'rigSha256', 'sourcePath', 'sourceSha256'], '动作包存在未知字段');
  equal(motion.sourceSha256, builtinMotion.sourceSha256, '模型内容不同');
  equal(motion.rigSha256, builtinMotion.rigSha256, '动作 rig 不同');
  equal(motion.actions, builtinMotion.actions, '动作目录不同');
  equal(originalMeta.sourceAsset?.sha256, builtinMotion.sourceSha256, '原件 sourceAsset 指纹不同');
  equal(copyMeta.sourceAsset?.sha256, builtinMotion.sourceSha256, '副本 sourceAsset 指纹不同');
  const originalSource = verifyFile(original.file_path, builtinMotion.sourceSha256, roots, evidence);
  const copySource = verifyFile(copy.file_path, motion.sourceSha256, roots, evidence);
  equal(sha(originalSource), sha(copySource), '模型文件不同');
  verifyFile(builtinMotion.rigPath, builtinMotion.rigSha256, roots, evidence);
  verifyFile(motion.rigPath, motion.rigSha256, roots, evidence);
  const a = JSON.parse(verifyFile(builtinMotion.clipPath, builtinMotion.clipSha256, roots, evidence));
  const b = JSON.parse(verifyFile(motion.clipPath, motion.clipSha256, roots, evidence));
  if (a.modelId !== original.id || b.modelId !== copy.id) fail('动作数据 modelId 不匹配');
  equal({ ...a, modelId: '__same_model__' }, { ...b, modelId: '__same_model__' }, '动作采样数据不同（不只 modelId）');
  return { copy: copy.id, original: original.id, name: original.name, sourcePortsRetained: true, fileEvidence: evidence };
}
function findReferences(rowsByTable, columns, pairs = PAIRS) {
  const identities = new Map(pairs.map(([copy]) => [copy, [copy, '/uploads/projects/' + copy.slice(6) + '/', copy.slice(6)]]));
  const refs = [];
  function visit(value, location, depth = 0) {
    if (depth > 80) fail('配置 JSON 嵌套过深');
    if (typeof value === 'string') {
      let decoded; try { decoded = JSON.parse(value); } catch { /* literal string */ }
      if (decoded && typeof decoded === 'object') return visit(decoded, location, depth + 1);
      for (const [copy, tokens] of identities) if (tokens.some(token => value.includes(token))) refs.push({ copy, ...location });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, { ...location, path: location.path + '[' + index + ']' }, depth + 1));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      visit(key, { ...location, path: location.path + '.<key>' }, depth + 1);
      visit(item, { ...location, path: location.path ? location.path + '.' + key : key }, depth + 1);
    }
  }
  for (const [table, rows] of Object.entries(rowsByTable)) {
    const text = columns.filter(column => column.TABLE_NAME === table && /^(?:json|varchar|char|text|mediumtext|longtext|tinytext)$/.test(column.DATA_TYPE));
    for (const row of rows) for (const column of text) visit(row[column.COLUMN_NAME], { table, id: row.id ?? row.key ?? row.factory_id, column: column.COLUMN_NAME, path: '' });
  }
  return refs;
}
function assertReferences(refs) {
  for (const ref of refs) {
    if (ref.table === 'models' && ref.id === ref.copy && (['id', 'file_path'].includes(ref.column)
      || ref.column === 'metadata' && /^motionAuthoring\.bundle\.(sourcePath|rigPath|clipPath)$/.test(ref.path))) continue;
    if (ref.table === 'devices' && EXPECTED_DEVICES[ref.id] === ref.copy && ['model_type', 'model_file'].includes(ref.column) && !ref.path) continue;
    fail('存在计划外模型引用：' + stable(ref));
  }
  for (const [id, copy] of Object.entries(EXPECTED_DEVICES)) {
    if (refs.filter(ref => ref.table === 'devices' && ref.id === id && ref.copy === copy && ref.column === 'model_type').length !== 1) fail('设备引用已变化：' + id);
  }
}
function expectedAfter(rowsByTable) {
  const after = structuredClone(rowsByTable), originals = new Map(after.models.map(model => [model.id, model]));
  const map = new Map(PAIRS);
  for (const device of after.devices) if (Object.hasOwn(EXPECTED_DEVICES, device.id)) {
    const old = originals.get(device.model_type), target = originals.get(map.get(device.model_type));
    if (!old || !target || EXPECTED_DEVICES[device.id] !== device.model_type || device.line_id !== 'line_a'
      || device.model_file !== null && device.model_file !== old.file_path) fail('设备绑定或作用域已变化：' + device.id);
    device.model_type = target.id;
    if (device.model_file !== null) device.model_file = target.file_path;
  }
  after.models = after.models.filter(model => !map.has(model.id));
  const variant = after.models.find(model => model.id === VARIANT);
  if (!variant || variant.name !== VARIANT_NAME) fail('独立配置模型名称已变化');
  variant.name = RENAMED_VARIANT;
  return after;
}
function writeVerifiedJson(filename, value) {
  const bytes = Buffer.from(JSON.stringify(normalize(value), null, 2));
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (sha(fs.readFileSync(filename)) !== sha(bytes)) fail('备份写入核验失败');
  return sha(bytes);
}
function verifyAuditRows(models) {
  const byId = new Map(models.map(model => [model.id, model]));
  for (const [id, expected] of Object.entries(EXPECTED_ROWS)) {
    if (!byId.has(id) || digest(byId.get(id)) !== expected) fail('模型已偏离独立审计快照：' + id);
  }
}
async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log('node tools/cleanup-duplicate-models.cjs [--apply] [--report-dir ABSOLUTE_PATH]\nDefault is read-only. Exactly 7 audited clones and 2 known device model bindings. Files retained.'); return; }
  let apply = false, reportDirectory;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--apply' && !apply) apply = true;
    else if (argv[index] === '--report-dir' && argv[index + 1]) reportDirectory = path.resolve(argv[++index]);
    else fail('未知或重复参数');
  }
  const userRoot = path.join(process.env.APPDATA || fail('APPDATA 缺失'), 'heat-treatment-digital-twin-desktop');
  const configFile = path.join(userRoot, 'data', 'database-config.json'), config = JSON.parse(fs.readFileSync(configFile));
  if (config.type !== 'mysql' || config.host !== '127.0.0.1' || Number(config.port) !== 3307 || config.database !== 'dongtai_daping') fail('实际数据库不匹配已核实的本机数据库');
  const roots = { assets: path.join(ROOT, 'backend', 'assets'), uploads: path.join(userRoot, 'uploads') };
  const mysql = require(path.join(ROOT, 'backend', 'node_modules', 'mysql2', 'promise'));
  const connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, connectTimeout: 5000 });
  let transaction = false, report, committed = false;
  try {
    if (apply) await connection.query('SET SESSION innodb_lock_wait_timeout=5');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query(apply ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY'); transaction = true;
    const [columns] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION', [config.database]);
    if (digest(columns) !== EXPECTED_SCHEMA) fail('数据库表结构已变化，需要重新审计');
    const [tables] = await connection.query('SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=?', [config.database]);
    equal(tables.map(table => table.TABLE_NAME).sort(), [...CONFIG_TABLES, ...HISTORICAL_TABLES].sort(), '配置表集合改变');
    if (tables.some(table => table.ENGINE !== 'InnoDB')) fail('存在不支持事务锁的配置表');
    const [foreign] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?', [config.database, 'models']);
    if (foreign.length) fail('存在未审计的外键引用');
    const rowsByTable = {};
    for (const table of CONFIG_TABLES) {
      // Full-table range locks also fence new configuration references during apply.
      const [rows] = await connection.query('SELECT * FROM `' + table + '`' + (apply ? ' FOR UPDATE' : ''));
      if (rows.length > 10000) fail('配置表超出已审计范围：' + table);
      rowsByTable[table] = rows;
    }
    verifyAuditRows(rowsByTable.models);
    const byId = new Map(rowsByTable.models.map(model => [model.id, model]));
    const motions = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'motionPackages.json'))).models;
    const verified = PAIRS.map(([copy, original]) => verifyPair(byId.get(original), byId.get(copy), motions[original], roots));
    const variant = byId.get(VARIANT), sourceVariant = byId.get(VARIANT_SOURCE);
    if (!variant || !sourceVariant || stable(parse(variant.metadata).loadingPorts) === stable(parse(sourceVariant.metadata).loadingPorts)) fail('独立进出料口差异已变化');
    const refs = findReferences(rowsByTable, columns); assertReferences(refs);
    // Logs are not runtime configuration and never locked/written. Still reject
    // any existing copy references instead of silently rewriting historical data.
    const historicalReferences = [];
    const tokens = PAIRS.flatMap(([copy]) => [copy, copy.slice(6)]);
    for (const table of HISTORICAL_TABLES) {
      const text = columns.filter(column => column.TABLE_NAME === table && /^(?:json|varchar|char|text|mediumtext|longtext|tinytext)$/.test(column.DATA_TYPE));
      if (!text.length) continue;
      const predicate = text.flatMap(column => tokens.map(() => 'CAST(`' + column.COLUMN_NAME + '` AS CHAR) LIKE ?')).join(' OR ');
      const values = text.flatMap(() => tokens.map(token => '%' + token + '%'));
      const [[count]] = await connection.query('SELECT COUNT(*) AS count FROM `' + table + '` WHERE ' + predicate, values);
      historicalReferences.push({ table, count: Number(count.count) });
      if (Number(count.count)) fail('历史记录已有副本引用，需要重新审计：' + table);
    }
    const after = expectedAfter(rowsByTable), files = verified.flatMap(pair => pair.fileEvidence);
    const tableDigests = Object.fromEntries(CONFIG_TABLES.map(table => [table, { rows: rowsByTable[table].length, sha256: digest(rowsByTable[table]) }]));
    report = { format: 'digital-twin-audited-model-cleanup', version: 1, apply, committed: false, at: new Date().toISOString(),
      database: { host: config.host, port: config.port, database: config.database, configFile },
      plan: verified, referencesBefore: refs, historicalReferences, tableDigests,
      before: { models: rowsByTable.models.length, devices: rowsByTable.devices.length },
      expectedAfter: { models: after.models.length, devices: after.devices.length, removed: PAIRS.map(pair => pair[0]), migratedDevices: Object.keys(EXPECTED_DEVICES), retainedVariant: VARIANT, variantName: RENAMED_VARIANT },
      rollback: { models: rowsByTable.models.filter(model => Object.hasOwn(EXPECTED_ROWS, model.id)), devices: rowsByTable.devices.filter(device => Object.hasOwn(EXPECTED_DEVICES, device.id)),
        note: 'Restore the 7 removed rows and the original variant name, then only the two device model_type/model_file columns in one transaction. First verify current state matches this report.expectedRowsAfter. Never overwrite device instance_config, PLC settings, animation bindings or layout.' },
      expectedRowsAfter: { models: after.models.filter(model => Object.hasOwn(EXPECTED_ROWS, model.id)), devices: after.devices.filter(device => Object.hasOwn(EXPECTED_DEVICES, device.id)) },
      retainedFiles: files, physicalFilesDeleted: 0, configurationSync: 'No API/PLC/Unity actions. Models are read from the database by the next library/configuration read.' };
    reportDirectory ||= path.join(ROOT, 'output', 'model-cleanup-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + process.pid);
    if (fs.existsSync(reportDirectory)) fail('报告目录已存在；请指定新的目录');
    fs.mkdirSync(reportDirectory, { recursive: true });
    const backupFile = path.join(reportDirectory, 'before-and-rollback.json'), backupSha256 = writeVerifiedJson(backupFile, report);
    writeVerifiedJson(path.join(reportDirectory, 'backup-sha256.json'), { filename: backupFile, sha256: backupSha256 });
    if (apply) {
      // Config/asset bytes are rechecked after durable backup and before mutation.
      verifyAuditRows((await connection.query('SELECT * FROM models FOR UPDATE'))[0]);
      for (const file of files) if (sha(fs.readFileSync(file.filename)) !== file.sha256) fail('备份后资产文件发生变化');
      for (const id of Object.keys(EXPECTED_DEVICES)) {
        const before = rowsByTable.devices.find(device => device.id === id), next = after.devices.find(device => device.id === id);
        const [result] = await connection.query('UPDATE devices SET model_type=?,model_file=? WHERE id=? AND model_type=? AND model_file <=> ?', [next.model_type, next.model_file, id, before.model_type, before.model_file]);
        if (result.affectedRows !== 1) fail('设备条件更新未命中：' + id);
      }
      for (const [copy] of PAIRS) {
        const before = byId.get(copy);
        const [result] = await connection.query('DELETE FROM models WHERE id=? AND factory_id=? AND file_path=?', [copy, before.factory_id, before.file_path]);
        if (result.affectedRows !== 1) fail('模型条件删除未命中：' + copy);
      }
      const [renamed] = await connection.query('UPDATE models SET name=? WHERE id=? AND name=?', [RENAMED_VARIANT, VARIANT, VARIANT_NAME]);
      if (renamed.affectedRows !== 1) fail('独立配置名称条件更新未命中');
      for (const table of CONFIG_TABLES) {
        const [actual] = await connection.query('SELECT * FROM `' + table + '` FOR UPDATE');
        // SQL has no guaranteed ordering; compare by stable complete row, not row index.
        equal(actual.map(stable).sort(), after[table].map(stable).sort(), '事务中出现未计划字段或配置变动：' + table);
      }
      const currentRows = { ...rowsByTable, models: (await connection.query('SELECT * FROM models FOR UPDATE'))[0], devices: (await connection.query('SELECT * FROM devices FOR UPDATE'))[0] };
      const remaining = findReferences(currentRows, columns);
      if (remaining.length) fail('事务中仍有副本引用');
      report.referencesAfter = remaining;
      // Durable expected post-state exists even if a commit response is lost.
      writeVerifiedJson(path.join(reportDirectory, 'validated-before-commit.json'), { ...report, backupFile, backupSha256 });
      await connection.commit(); transaction = false; committed = true;
    } else { await connection.rollback(); transaction = false; }
    writeVerifiedJson(path.join(reportDirectory, 'result.json'), { ...report, committed, backupFile, backupSha256 });
    console.log(JSON.stringify({ success: true, apply, committed, before: report.before, after: apply ? report.expectedAfter : null, planned: report.expectedAfter, backupFile, backupSha256, reportDirectory, filesDeleted: 0 }, null, 2));
  } catch (error) {
    if (transaction) await connection.rollback().catch(() => {});
    // Avoid echoing driver/configuration error messages that may include credentials.
    if (error.sql || error.sqlMessage) throw new Error('数据库操作失败；事务已请求回滚。代码：' + (error.code || 'UNKNOWN'));
    throw error;
  } finally { await connection.end(); }
}
module.exports = { PAIRS, EXPECTED_DEVICES, VARIANT, VARIANT_NAME, RENAMED_VARIANT, stable, digest, resolveAsset, verifyPair, semanticMetadata, findReferences, assertReferences, expectedAfter, verifyAuditRows, writeVerifiedJson, main };
if (require.main === module) main().catch(error => { console.error('ABORT: ' + error.message); process.exitCode = 1; });
