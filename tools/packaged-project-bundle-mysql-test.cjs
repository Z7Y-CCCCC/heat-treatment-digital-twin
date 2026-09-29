const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRunDirectory, findFreePort } = require('../backend/scripts/integration-test-utils.cjs');
const mysql = require('../backend/node_modules/mysql2/promise');

const executable = path.resolve(process.argv[2] || '安装包/win-unpacked/热处理数字孪生大屏.exe');
const resources = path.join(path.dirname(executable), 'resources');
const packageBackend = path.join(resources, 'backend');
const directory = createRunDirectory('packaged-project-bundle-mysql');
const dataDir = path.join(directory, 'mysql-data');
const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-bundle-mysql-'));
const runtimeAlias = path.join(aliasRoot, 'runtime');
const dataAlias = path.join(aliasRoot, 'data');
const logFile = path.join(directory, 'mysqld.log');
const resultFile = path.join(directory, 'result.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, admin, closeDb;
const checks = {};

function launch(args) {
    const log = fs.openSync(logFile, 'a');
    const child = spawn(path.join(runtimeAlias, 'bin', 'mysqld.exe'), args, { cwd: aliasRoot, windowsHide: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    return child;
}

(async () => {
    assert.ok(fs.existsSync(executable));
    assert.ok(fs.existsSync(path.join(resources, 'mysql/bin/mysqld.exe')));
    fs.mkdirSync(dataDir);
    fs.symlinkSync(path.join(resources, 'mysql'), runtimeAlias, 'junction');
    fs.symlinkSync(dataDir, dataAlias, 'junction');
    // Load the exact shipped application modules with test-machine dependencies;
    // the packaged runtime itself normally extracts the same dependency archive.
    process.env.NODE_PATH = path.resolve(__dirname, '../backend/node_modules');
    require('node:module').Module._initPaths();
    for (const key of Object.keys(process.env)) if (/^(MYSQL_|DB_|SQLITE_|APP_DATA_DIR$|UPLOADS_DIR$)/i.test(key)) delete process.env[key];
    process.env.APP_DATA_DIR = path.join(directory, 'app-data');
    process.env.UPLOADS_DIR = path.join(directory, 'uploads');
    process.env.LICENSE_ENFORCE = 'false';
    const init = launch(['--no-defaults', '--initialize-insecure', `--basedir=${runtimeAlias}`, `--datadir=${dataAlias}`, '--console']);
    const initCode = await new Promise((resolve, reject) => { init.once('error', reject); init.once('exit', resolve); });
    assert.equal(initCode, 0, `Private MySQL initialization failed; ${logFile}`);
    const port = await findFreePort();
    server = launch(['--no-defaults', `--basedir=${runtimeAlias}`, `--datadir=${dataAlias}`, '--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=0', '--max-allowed-packet=64M', '--console']);
    const credentials = { host: '127.0.0.1', port, user: 'root', password: '' };
    for (let i = 0; i < 150; i++) {
        if (server.exitCode !== null) throw new Error(`Private mysqld exited; ${logFile}`);
        try { admin = await mysql.createConnection(credentials); break; } catch { await sleep(200); }
    }
    assert.ok(admin, 'Private MySQL must become ready');
    const [[identity]] = await admin.query('SELECT @@version AS version, @@datadir AS datadir, @@port AS port');
    assert.equal(fs.realpathSync(identity.datadir).replace(/[\\/]+$/, ''), fs.realpathSync(dataDir));
    assert.equal(Number(identity.port), port);
    checks.privateMysqlOwnership = true;
    const config = { ...credentials, type: 'mysql', database: 'bundle_isolation_test' };
    fs.mkdirSync(process.env.APP_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.APP_DATA_DIR, 'database-config.json'), JSON.stringify(config));
    process.env.DB_TYPE = 'mysql';
    const { seedMysql } = require(path.join(packageBackend, 'services/mysqlSeed'));
    await seedMysql({ connection: config, sourcePath: path.join(resources, 'templates/factory-template.db') });
    const databaseModule = require(path.join(packageBackend, 'db/database'));
    closeDb = databaseModule.closeDb;
    const db = await databaseModule.getDb();
    assert.equal(databaseModule.getDbStatus().type, 'mysql');
    const { exportBundle, inspectBundle, importBundle } = require(path.join(packageBackend, 'services/projectBundle'));
    const { createEmptyDocument } = require(path.join(packageBackend, 'utils/dashboardDocument'));
    const { saveDraft, publishDraft, loadPublishedDocument } = require(path.join(packageBackend, 'services/dashboardDocuments'));
    const source = 'mysql_bundle_source';
    await db.run('INSERT INTO factories (id, name) VALUES (?, ?)', [source, 'MySQL 源工厂']);
    await db.run('INSERT INTO workshops (id, factory_id, name) VALUES (?, ?, ?)', ['mysql_ws', source, '车间']);
    await db.run('INSERT INTO `lines` (id, workshop_id, name) VALUES (?, ?, ?)', ['mysql_line', 'mysql_ws', '产线']);
    await db.run('INSERT INTO devices (id, line_id, name, plc_enabled, plc_ip) VALUES (?, ?, ?, ?, ?)', ['mysql_device', 'mysql_line', '设备', 1, '192.168.255.254']);
    const point = await db.run('INSERT INTO data_points (device_id, name, label, plc_tag, access_type) VALUES (?, ?, ?, ?, ?)', ['mysql_device', 'temp', '温度', 'DB1.DBD0', 'READ']);
    assert.ok(point.insertId > 0);
    const project = { id: 'mysql_project', name: '项目' }, scene = { id: 'mysql_scene', name: '场景' };
    await db.run('INSERT INTO projects (id, factory_id, name, is_active) VALUES (?, ?, ?, ?)', [project.id, source, project.name, 1]);
    await db.run('INSERT INTO scenes (id, project_id, name, is_active) VALUES (?, ?, ?, ?)', [scene.id, project.id, scene.name, 1]);
    const document = createEmptyDocument({ project, scene });
    document.widgets.forEach(widget => { widget.id = `mysql_${widget.id}`; });
    document.widgets.push({ id: 'mysql_temperature_widget', type: 'value', title: '温度', frame: { x: 20, y: 100, width: 200, height: 80 }, data: { mode: 'plc', deviceId: 'mysql_device', pointId: String(point.insertId) } });
    await saveDraft(db, { sceneId: scene.id, factoryId: source, document, expectedRevision: 0 });
    await publishDraft(db, { sceneId: scene.id, factoryId: source, version: '1.0.0' });
    checks.sourceSavedAndPublished = true;
    fs.mkdirSync(path.join(process.env.UPLOADS_DIR, 'appearance'), { recursive: true });
    const imageName = `${'b'.repeat(32)}.png`;
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'appearance', imageName), 'mysql appearance evidence');
    await db.upsert('settings', { key: 'loading_experience_config', value: JSON.stringify({ title: 'MySQL 迁移画面', imageUrl: `/uploads/appearance/${imageName}` }) }, 'key');
    const archive = path.join(directory, 'mysql-project.zip');
    await exportBundle(source, archive);
    const checked = await inspectBundle(archive);
    assert.equal(checked.inspection.counts.devices, 1);
    assert.equal(checked.inspection.counts.releases, 1);
    const imported = await importBundle(archive, { name: 'MySQL 目标工厂', inspectedSha256: checked.sha256, applySharedAppearance: true });
    const importedProject = await db.get('SELECT * FROM projects WHERE factory_id = ?', [imported.factoryId]);
    const importedScene = await db.get('SELECT * FROM scenes WHERE project_id = ?', [importedProject.id]);
    const published = await loadPublishedDocument(db, importedProject, importedScene);
    const bound = published.document.widgets.find(widget => widget.type === 'value');
    assert.ok(bound);
    assert.notEqual(bound.data.deviceId, 'mysql_device');
    assert.notEqual(bound.data.pointId, String(point.insertId));
    const targetPoint = await db.get('SELECT * FROM data_points WHERE id = ?', [bound.data.pointId]);
    assert.equal(targetPoint.device_id, bound.data.deviceId);
    assert.equal(published.document.projectId, importedProject.id);
    assert.equal(published.document.sceneId, importedScene.id);
    assert.equal(published.release.id, importedScene.published_release_id);
    const targetDevice = await db.get('SELECT * FROM devices WHERE id = ?', [bound.data.deviceId]);
    assert.equal(Number(targetDevice.plc_enabled), 0); assert.equal(targetDevice.plc_ip, '');
    assert.equal(Number((await db.get('SELECT plc_enabled FROM devices WHERE id = ?', ['mysql_device'])).plc_enabled), 1);
    checks.importedPublishedReferencesAndIsolation = true;
    // Saving and publishing the imported document verifies the actual validator,
    // not merely that the stored JSON contains plausible replacement strings.
    await saveDraft(db, { sceneId: importedScene.id, factoryId: imported.factoryId, document: published.document, expectedRevision: importedScene.draft_revision });
    await publishDraft(db, { sceneId: importedScene.id, factoryId: imported.factoryId, version: '1.0.1' });
    checks.importedDraftCanRepublish = true;
    const loading = JSON.parse((await db.get('SELECT value FROM settings WHERE `key` = ?', ['loading_experience_config'])).value);
    assert.match(loading.imageUrl, /^\/uploads\/projects\//);
    assert.equal(fs.readFileSync(path.join(process.env.UPLOADS_DIR, loading.imageUrl.slice('/uploads/'.length)), 'utf8'), 'mysql appearance evidence');
    checks.sharedAppearanceAndAsset = true;
    const beforeCount = Number((await db.get('SELECT COUNT(*) AS n FROM factories')).n);
    const beforeFiles = fs.readdirSync(path.join(process.env.UPLOADS_DIR, 'projects')).sort();
    await assert.rejects(importBundle(archive, { inspectedSha256: checked.sha256, applySharedAppearance: true }, { beforeCommit: tx => tx.run('INSERT INTO factories (id, name) VALUES (?, ?)', [source, 'rollback duplicate']) }), /Duplicate entry/);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM factories')).n), beforeCount);
    assert.deepEqual(fs.readdirSync(path.join(process.env.UPLOADS_DIR, 'projects')).sort(), beforeFiles);
    assert.deepEqual(JSON.parse((await db.get('SELECT value FROM settings WHERE `key` = ?', ['loading_experience_config'])).value), loading);
    checks.mysqlTransactionAndAssetRollback = true;
    const report = { success: true, executable, module: path.join(packageBackend, 'services/projectBundle.js'), moduleSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(packageBackend, 'services/projectBundle.js'))).digest('hex'), mysqlVersion: identity.version, mysqlPort: port, directory, checks, importedFactoryId: imported.factoryId, importedSceneId: importedScene.id, sourcePointId: point.insertId, importedPointId: targetPoint.id };
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, resultFile }, null, 2));
})().catch(error => {
    fs.writeFileSync(resultFile, JSON.stringify({ success: false, checks, directory, error: error.stack }, null, 2));
    console.error(error.stack); console.error(`Evidence: ${resultFile}`); process.exitCode = 1;
}).finally(async () => {
    if (closeDb) await closeDb().catch(() => {});
    if (admin) { try { await admin.query('SHUTDOWN'); } catch {} try { await admin.end(); } catch {} }
    if (server && server.exitCode === null) { await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(10000)]); if (server.exitCode === null) server.kill(); }
});
