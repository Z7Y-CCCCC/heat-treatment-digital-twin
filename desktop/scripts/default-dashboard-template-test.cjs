'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyDefaultDashboardTemplate, createDefaultDashboardDocument, initializeDefaultDashboard, FILE, INFO, VIEW_IDS } = require('../../backend/services/defaultDashboardTemplate');
const { validateDocument } = require('../../backend/utils/dashboardDocument');
const { verifyPackagedDefaultTemplate } = require('./verify-default-dashboard-template.cjs');
const { verify: verifyEmptyInstall } = require('./verify-empty-install.cjs');

test('frozen presentation has seven factory views, 35 widgets and no site data', () => {
    const { template } = verifyDefaultDashboardTemplate();
    assert.deepEqual(template.views.map(v => v.id), VIEW_IDS);
    assert.equal(template.widgets.length, 35);
    assert.deepEqual(template.canvas, { width:1920, height:1080, gridSize:10, safeArea:24, background:'transparent', legacyGrid:{rows:12,columns:24} });
    assert.ok(template.widgets.every(w => w.frame && w.style && !w.data.pointId && !w.data.deviceId));
    assert.ok(template.widgets.some(w => w.visible === false && w.type === 'return_button'));
    assert.doesNotMatch(JSON.stringify(template), /Furnace_01|factory_default|ws_1|line_a|C:\\|deviceDataMap\.|https?:\/\/|126\.8|84\.6|plcProject|configuredAt|configurationPointIds/);
    assert.equal(template.metadata, undefined); assert.equal(template.parameters, undefined);
    assert.ok(template.views.every(v => v.targetId === ''));
});

test('new scenes receive independent valid copies without mutating the baseline', () => {
    const before = fs.readFileSync(FILE);
    const a = createDefaultDashboardDocument({projectId:'new-project-a',sceneId:'new-scene-a',name:'新工厂总览'});
    const b = createDefaultDashboardDocument({projectId:'new-project-b',sceneId:'new-scene-b',name:'另一工厂总览'});
    assert.deepEqual(validateDocument(a), []); assert.deepEqual(validateDocument(b), []);
    assert.equal(a.widgets.length, INFO.widgetCount);
    assert.equal(a.projectId,'new-project-a'); assert.equal(a.sceneId,'new-scene-a'); assert.deepEqual(a.parameters, []);
    assert.equal(a.metadata.defaultTemplate.sha256, INFO.sha256);
    assert.ok(a.widgets.every(w => !b.widgets.some(other => other.id === w.id)));
    for (const view of a.scene.views) for (const id of [...view.componentState.show,...view.componentState.hide]) assert.ok(a.widgets.some(w=>w.id===id));
    a.widgets[0].frame.x = 999; a.scene.views[0].name = '现场自定义';
    assert.notEqual(b.widgets[0].frame.x,999); assert.deepEqual(fs.readFileSync(FILE), before);
});

test('explicit new-factory initialization persists a draft and initial release in the caller transaction', async () => {
    const calls=[];
    await initializeDefaultDashboard({run:async(sql,args)=>calls.push({sql,args})},{projectId:'p',sceneId:'s',name:'新工厂'});
    assert.equal(calls.length,2); assert.match(calls[0].sql,/UPDATE scenes/); assert.equal(calls[0].args[2],'s');
    assert.match(calls[1].sql,/INSERT INTO releases/); assert.equal(calls[0].args[0],calls[1].args[3]);
    assert.equal(JSON.parse(calls[0].args[0]).metadata.source,'builtin-default');
});

test('missing or changed packaged baseline fails instead of falling back to live data', t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-dashboard-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target=path.join(dir,'backend/defaults');fs.mkdirSync(target,{recursive:true});
    assert.throws(()=>verifyPackagedDefaultTemplate(dir), /ENOENT/);
    fs.mkdirSync(path.join(dir,'shared'));
    fs.copyFileSync(path.resolve(__dirname,'../../shared/defaultDashboardTemplate.mjs'),path.join(dir,'shared/defaultDashboardTemplate.mjs'));
    assert.throws(()=>verifyPackagedDefaultTemplate(dir), /ENOENT/);
    fs.copyFileSync(FILE,path.join(target,path.basename(FILE)));
    assert.equal(verifyPackagedDefaultTemplate(dir).sha256,INFO.sha256);
    fs.appendFileSync(path.join(target,path.basename(FILE)),' ');
    assert.throws(()=>verifyPackagedDefaultTemplate(dir), /默认模板校验失败/);
    fs.copyFileSync(FILE,path.join(target,path.basename(FILE)));
    fs.appendFileSync(path.join(dir,'shared/defaultDashboardTemplate.mjs'),'\n// changed identity\n');
    assert.throws(()=>verifyPackagedDefaultTemplate(dir), /身份文件与仓库不一致/);
});

test('main and collector empty-resource gates reject contamination without rewriting the fixture', t => {
    // Synthetic resources only: no release build, source database or native binaries.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-dashboard-empty-gates-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const Database = require('../../backend/node_modules/better-sqlite3');
    for (const product of ['display', 'collector-plugin']) {
        const resources = path.join(dir, product);
        for (const relative of ['backend/defaults', 'shared', 'templates']) fs.mkdirSync(path.join(resources, relative), { recursive: true });
        fs.copyFileSync(FILE, path.join(resources, 'backend/defaults/factory-dashboard.v1.json'));
        fs.copyFileSync(path.resolve(__dirname, '../../shared/defaultDashboardTemplate.mjs'), path.join(resources, 'shared/defaultDashboardTemplate.mjs'));
        fs.writeFileSync(path.join(resources, 'shared/motionPackages.json'), JSON.stringify({ models: {} }));
        fs.writeFileSync(path.join(resources, 'backend/distribution.json'), JSON.stringify({ product, contentPolicy: 'empty-v1' }));
        const filename = path.join(resources, 'templates/factory-template.db');
        const db = new Database(filename);
        db.exec("CREATE TABLE settings (`key` TEXT PRIMARY KEY, value TEXT); CREATE TABLE future_business (id TEXT); INSERT INTO settings VALUES ('install_content_policy', 'empty-v1'), ('active_factory_id', '')");
        db.close();
        const result = verifyEmptyInstall(resources);
        assert.equal(result.defaultTemplate.sha256, INFO.sha256);
        assert.equal(result.counts.future_business, 0);
        const withMotions = path.join(dir, `${product}-motions`);
        fs.cpSync(resources, withMotions, { recursive: true });
        const registry = path.join(withMotions, 'shared/motionPackages.json');
        fs.writeFileSync(registry, JSON.stringify({ models: { fixture: { actions: [] } } }));
        const registryBefore = fs.readFileSync(registry);
        assert.throws(() => verifyEmptyInstall(withMotions), { code: 'ERR_ASSERTION' });
        assert.deepEqual(fs.readFileSync(registry), registryBefore);
        const contaminated = new Database(filename);
        contaminated.prepare('INSERT INTO future_business VALUES (?)').run('isolated-site-data');
        contaminated.close();
        const before = fs.readFileSync(filename);
        assert.throws(() => verifyEmptyInstall(resources), /business table must be empty: future_business/);
        assert.deepEqual(fs.readFileSync(filename), before, 'a failed gate must not erase data to pass');
    }
});

test('source and both package gates enforce the fixed baseline without changing empty data policy', () => {
    const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
    assert.match(read('desktop/scripts/prepare-resources.cjs'), /verifyDefaultDashboardTemplate\(\)/);
    assert.match(read('desktop/scripts/verify-empty-install.cjs'), /verifyPackagedDefaultTemplate\(resources\)/);
    assert.match(read('生成安装包.ps1'), /verify-empty-install\.cjs'\), \(Join-Path \$pluginDirectory 'resources'\)/);
    assert.match(read('tools/ci/check-release.cjs'), /verifyDefaultDashboardTemplate\(\)/);
    assert.match(read('AGENTS.md'), /打包必看\.md/); assert.match(read('打包必看.md'), /本机.*现有库/);
});
