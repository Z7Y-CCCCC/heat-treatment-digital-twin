'use strict';
// Fresh output/ fixture only. This suite never starts the installed application,
// touches a production database, PLC, Unity process or a real user draft.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [], pass = label => { checks.push(label); console.log('PASS ' + label); };
const rule = id => ({ source: 'context', path: 'deviceId', operator: '==', value: id });
const widget = (id, extra = {}) => ({ id, type: 'text', title: id, visible: true, locked: true, zIndex: 7,
    frame: { x: 21, y: 43, width: 301, height: 71, rotation: 0 },
    style: { color: '#eef7ff', background: '#101527', borderRadius: 18, fontSize: 21, padding: 8 },
    content: { text: '原始静态标题' }, data: { mode: 'static', readOnly: true },
    visibility: { viewIds: [], viewModes: [], rules: [], ruleMode: 'all', matchBoundDevice: false }, ...extra });

async function main() {
    const directory = createRunDirectory('dashboard-device-deletion');
    const filename = await createTestDatabase(path.join(directory, 'factory.db'));
    Object.assign(process.env, { NODE_ENV: 'test', APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: filename,
        DB_BACKUP_DIR: path.join(directory, 'backups'), DB_RECOVERY_DIR: path.join(directory, 'recovery'), DATA_SOURCE_BACKUP_DIR: path.join(directory, 'source-backups') });
    for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
    fs.writeFileSync(path.join(directory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }));
    const database = require('../db/database'), documents = require('../services/dashboardDocuments');
    const lifecycle = require('../services/dashboardDeviceDeletion');
    const { cleanupDeletedDeviceContent } = require('../../shared/dashboardDeviceDeletion.mjs');
    let server;
    const broadcasts = [];
    global.wsServer = { broadcast: (type, payload) => broadcasts.push({ type, payload }) };
    try {
        const db = await database.getDb(), initial = await documents.loadDesignerState(db);
        const factoryId = initial.project.factory_id, sceneId = initial.scene.id;
        const homeLine = await db.get('SELECT l.id,l.workshop_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1', [factoryId]);
        let revision = initial.revision;
        const base = clone(initial.document); base.widgets = [];
        for (const template of base.tooltipTemplates.templates) template.widgets = [];
        async function device(id, lineId = homeLine.id, config = {}) {
            await db.run('INSERT INTO devices(id,name,line_id,instance_config) VALUES(?,?,?,?)', [id, id, lineId, JSON.stringify(config)]);
            await db.run('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,access_type) VALUES(?,?,?,?,?,?)', [id, 'temp', '温度', 'DB1.DBD0', 'REAL', 'READ']);
            return String((await db.get('SELECT id FROM data_points WHERE device_id=?', [id])).id);
        }
        async function save(document, options = {}) {
            const saved = await documents.saveDraft(db, { sceneId, document, expectedRevision: revision, factoryId, ...options });
            revision = saved.revision; return saved;
        }
        function privateDocument(id, pointId, prefix = id) {
            const doc = clone(base), sharedId = doc.scene.views.find(v => v.mode === 'device')?.id || 'device_detail';
            const privateId = prefix + '_private_view';
            doc.scene.views.push({ ...clone(doc.scene.views.find(v => v.id === sharedId) || doc.scene.views[0]), id: privateId,
                name: '设备独有视角', mode: 'device', targetType: 'device', targetId: id, parentViewId: sharedId, returnViewId: sharedId,
                componentState: { show: [], hide: [] }, metadata: { tooltipTemplates: { device: prefix + '_private_tip' } } });
            doc.widgets = [
                widget(prefix + '_caption', { visibility: { rules: [rule(id)], ruleMode: 'all', viewIds: [sharedId] } }),
                widget(prefix + '_runtime', { data: { mode: 'runtime', deviceScope: 'current', path: 'device.name', readOnly: true }, visibility: { rules: [rule(id)], ruleMode: 'all', viewIds: [sharedId] } }),
                widget(prefix + '_view_caption', { visibility: { viewIds: [privateId], rules: [] } }),
                widget(prefix + '_shared_fixed', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: id, pointId, readOnly: true }, content: { text: '{value}' } }),
                widget(prefix + '_shared_any', { visibility: { viewIds: [sharedId], rules: [rule(id), rule('life_alive')], ruleMode: 'any' } }),
                widget(prefix + '_shared_rotation', { data: { mode: 'plc', deviceScope: 'rotation', deviceId: '', rotationDeviceIds: [id, 'life_alive'], pointId, pointKey: 'temp', readOnly: true } }),
                widget(prefix + '_public', { content: { text: '全厂公共标题' } })
            ];
            doc.tooltipTemplates.templates[0].widgets = [widget(prefix + '_nested_private', { visibility: { rules: [rule(id)], ruleMode: 'all' } }), widget(prefix + '_nested_shared')];
            doc.tooltipTemplates.templates.push({ ...clone(doc.tooltipTemplates.templates[0]), id: prefix + '_private_tip', name: '设备独有悬停', widgets: [widget(prefix + '_tip_caption')] });
            return doc;
        }
        async function bindings(prefix) {
            for (const suffix of ['caption', 'runtime', 'view_caption', 'shared_fixed'])
                await db.run('INSERT INTO bindings(id,widget_id,source_type,source_id,path) VALUES(?,?,?,?,?)', [prefix + '_binding_' + suffix, prefix + '_' + suffix, 'plc', prefix, 'temp']);
        }
        async function snapshot() {
            return { scenes: await db.all('SELECT * FROM scenes ORDER BY id'), widgets: await db.all('SELECT * FROM widgets ORDER BY id'),
                bindings: await db.all('SELECT * FROM bindings ORDER BY id'), devices: await db.all('SELECT * FROM devices ORDER BY id'),
                points: await db.all('SELECT * FROM data_points ORDER BY id'), settings: await db.all('SELECT * FROM factory_settings ORDER BY factory_id,`key`'),
                lines: await db.all('SELECT * FROM `lines` ORDER BY id'), workshops: await db.all('SELECT * FROM workshops ORDER BY id') };
        }
        // Routes get the same private fixture facade so fault injection reaches
        // the actual HTTP transaction rather than another freshly made facade.
        database.getDb = async () => db;
        const express = require('express'), app = express(); app.use(express.json({ limit: '4mb' }));
        app.use((req, res, next) => { req.factoryId = req.headers['x-test-factory'] || factoryId; next(); });
        for (const route of ['devices','lines','workshops','factories']) app.use('/api/' + route, require('../routes/' + route));
        app.use('/api/settings', require('../routes/settings')());
        server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        async function request(url, method = 'GET', body, factory = factoryId) {
            const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', 'x-test-factory': factory }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: response.status, body: await response.json() };
        }
        await device('life_alive'); const deadPoint = await device('life_dead');
        const original = (await save(privateDocument('life_dead', deadPoint))).document;
        await bindings('life_dead');
        await documents.publishDraft(db, { sceneId, factoryId });
        const releasesBefore = await db.all('SELECT * FROM releases ORDER BY id');
        const foreignSceneId = 'life_foreign_scene';
        await db.run('INSERT INTO factories(id,name) VALUES(?,?)', ['life_foreign_factory','另一工厂']);
        await db.run('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)', ['life_foreign_ws','另一车间','life_foreign_factory']);
        await db.run('INSERT INTO `lines`(id,name,workshop_id) VALUES(?,?,?)', ['life_foreign_line','另一产线','life_foreign_ws']);
        await db.run('INSERT INTO projects(id,name,factory_id) VALUES(?,?,?)', ['life_foreign_project','另一项目','life_foreign_factory']);
        await db.run('INSERT INTO scenes(id,name,project_id,draft_json,draft_revision) VALUES(?,?,?,?,?)', [foreignSceneId,'另一场景','life_foreign_project',JSON.stringify(original),77]);
        const foreignBefore = await db.get('SELECT * FROM scenes WHERE id=?', [foreignSceneId]);
        const pointersBefore = await db.all('SELECT id,published_release_id FROM scenes ORDER BY id');
        const impactBefore = await snapshot();
        const impact = await request('/api/devices/life_dead/deletion-impact');
        assert.equal(impact.status, 200); assert.equal(impact.body.associations.find(a => a.key === 'dashboardWidgets').count, 3);
        assert.equal(impact.body.associations.find(a => a.key === 'dashboardBindings').count, 3);
        assert.deepEqual(await snapshot(), impactBefore); pass('deletion-impact accurately counts private widgets and bindings without writing');
        assert.equal((await request('/api/devices/life_dead','DELETE',{ confirmationName:'错误名称' })).status,409);
        assert.deepEqual(await snapshot(), impactBefore); assert.equal(broadcasts.length,0);
        pass('wrong confirmation atomically preserves device, points, draft, mirrors, bindings and history');
        const deleted = await request('/api/devices/life_dead','DELETE',{ confirmationName:'life_dead' });
        assert.equal(deleted.status,200); const plan = deleted.body.dashboardCleanup;
        assert.equal(plan.factoryId,factoryId); assert.ok(plan.remainingDeviceIds.includes('life_alive')); assert.ok(!plan.remainingDeviceIds.includes('life_dead'));
        assert.equal(plan.scenes.length,1); revision = plan.scenes[0].revision;
        const raw = JSON.parse((await db.get('SELECT draft_json FROM scenes WHERE id=?',[sceneId])).draft_json);
        const expected = cleanupDeletedDeviceContent(original,{ deviceIds:['life_dead'],pointIds:[deadPoint],existingDeviceIds:plan.remainingDeviceIds }).document;
        assert.deepEqual(raw.widgets,expected.widgets); assert.deepEqual(raw.scene,expected.scene); assert.deepEqual(raw.tooltipTemplates,expected.tooltipTemplates);
        for (const suffix of ['caption','runtime','view_caption']) {
            assert.equal(await db.get('SELECT id FROM widgets WHERE id=?',['life_dead_'+suffix]),null);
            assert.equal(await db.get('SELECT id FROM bindings WHERE widget_id=?',['life_dead_'+suffix]),null);
        }
        assert.ok(await db.get('SELECT id FROM bindings WHERE widget_id=?',['life_dead_shared_fixed']));
        for (const suffix of ['shared_fixed','public']) assert.deepEqual(raw.widgets.find(w=>w.id==='life_dead_'+suffix),original.widgets.find(w=>w.id==='life_dead_'+suffix));
        assert.equal(await db.get('SELECT id FROM devices WHERE id=?',['life_dead']),null); assert.equal(await db.get('SELECT id FROM data_points WHERE id=?',[deadPoint]),null);
        assert.deepEqual(await db.get('SELECT * FROM scenes WHERE id=?',[foreignSceneId]),foreignBefore);
        assert.deepEqual(await db.all('SELECT * FROM releases ORDER BY id'),releasesBefore); assert.deepEqual(await db.all('SELECT id,published_release_id FROM scenes ORDER BY id'),pointersBefore);
        assert.equal(broadcasts.length,1); assert.deepEqual(broadcasts[0].payload.dashboardCleanup,plan);
        pass('device DELETE removes static/runtime/private-view/private-tooltip ownership and bindings, not shared layouts, other factories or releases');
        const reopened = await documents.loadDesignerState(db,sceneId,factoryId);
        assert.deepEqual(reopened.dashboardCleanupHistory,[plan]);
        assert.deepEqual((await documents.loadDesignerState(db,foreignSceneId,'life_foreign_factory')).dashboardCleanupHistory,[]);
        pass('authoritative factory-scoped history survives reload and does not trust imported document fields');
        const savedOld = await save(original); assert.ok(!savedOld.document.widgets.some(w=>w.id==='life_dead_caption'));
        assert.ok(savedOld.document.widgets.some(w=>w.id==='life_dead_shared_fixed')); assert.ok(savedOld.warnings.some(w=>w.includes('life_dead')));
        await assert.rejects(save(original,{expectedRevision:1}),error=>error.code==='DRAFT_CONFLICT');
        pass('old cached/imported/undo private contents cannot be saved back after confirmed deletion; shared stale sources retain warnings and CAS stays strict');
        const project = await db.get('SELECT * FROM projects WHERE id=?',[initial.project.id]), scene = await db.get('SELECT * FROM scenes WHERE id=?',[sceneId]);
        const projected = await documents.loadPublishedDocument(db,project,scene);
        assert.ok(!projected.document.widgets.some(w=>w.id==='life_dead_caption'));
        assert.ok(projected.document.widgets.some(w=>w.id==='life_dead_shared_fixed'));
        assert.deepEqual(await db.all('SELECT * FROM releases ORDER BY id'),releasesBefore);
        pass('published runtime hides deleted private content by read-only projection, without rewriting historical releases or current pointers');
        const newPoint = await device('life_dead');
        const rebuilt = await save(privateDocument('life_dead',newPoint,'rebuilt'));
        assert.ok(rebuilt.document.widgets.some(w=>w.id==='rebuilt_caption'));
        const oldAfterReuse = await documents.loadPublishedDocument(db,project,await db.get('SELECT * FROM scenes WHERE id=?',[sceneId]));
        assert.ok(!oldAfterReuse.document.widgets.some(w=>w.id==='life_dead_caption'));
        await documents.publishDraft(db,{sceneId,factoryId});
        const newAfterReuse = await documents.loadPublishedDocument(db,project,await db.get('SELECT * FROM scenes WHERE id=?',[sceneId]));
        assert.ok(newAfterReuse.document.widgets.some(w=>w.id==='rebuilt_caption'));
        pass('same-ID recreation permits newly authored private content but cannot resurrect the pre-deletion release; a later release stays visible');

        for (const kind of ['line','workshop']) {
            const prefix='life_'+kind, workshopId=prefix+'_ws', lineId=prefix+'_line';
            await db.run('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)',[workshopId,workshopId,factoryId]);
            await db.run('INSERT INTO `lines`(id,name,workshop_id) VALUES(?,?,?)',[lineId,lineId,workshopId]);
            const pointId=await device(prefix,lineId);
            if(kind==='workshop') {
                await device(prefix+'_aux',null,{workshop_id:workshopId,role:'auxiliary'});
                await device('life_foreign_owned','life_foreign_line',{workshop_id:workshopId});
            }
            await save(privateDocument(prefix,pointId)); await bindings(prefix);
            const url='/api/'+(kind==='line'?'lines':'workshops')+'/'+(kind==='line'?lineId:workshopId);
            const response=await request(url,'DELETE',{confirmationName:kind==='line'?lineId:workshopId});
            assert.equal(response.status,200,JSON.stringify(response.body)); revision=response.body.dashboardCleanup.scenes[0].revision;
            assert.equal(await db.get('SELECT id FROM devices WHERE id=?',[prefix]),null);
            assert.equal(await db.get('SELECT id FROM widgets WHERE id=?',[prefix+'_caption']),null);
            assert.equal(await db.get('SELECT id FROM bindings WHERE widget_id=?',[prefix+'_caption']),null);
            if(kind==='workshop') {
                assert.ok(response.body.dashboardCleanup.deletedDeviceIds.includes(prefix+'_aux'));
                assert.ok(!response.body.dashboardCleanup.deletedDeviceIds.includes('life_foreign_owned'));
                assert.ok(await db.get('SELECT id FROM devices WHERE id=?',['life_foreign_owned']));
            }
            pass(kind+' DELETE includes complete owned devices and atomically clears their private dashboard content');
        }
        const rollbackPoint=await device('life_rollback'); await save(privateDocument('life_rollback',rollbackPoint)); await bindings('life_rollback');
        const originalTransaction=db.transaction.bind(db);
        async function failDeletion(label,runHook) {
            const before=await snapshot(), broadcastCount=broadcasts.length;
            db.transaction=callback=>originalTransaction(tx=>callback(new Proxy(tx,{get(target,key){
                if(key==='run') return (sql,params)=>runHook(sql,params,()=>target.run(sql,params));
                return target[key];
            }})));
            let response;
            try { response=await request('/api/devices/life_rollback','DELETE',{confirmationName:'life_rollback'}); }
            finally { db.transaction=originalTransaction; }
            assert.ok(response.status>=400,JSON.stringify(response)); assert.deepEqual(await snapshot(),before); assert.equal(broadcasts.length,broadcastCount); pass(label);
        }
        await failDeletion('ledger write failure rolls back draft, mirror, binding, point and device deletes before any broadcast',(sql,params,next)=>{
            if(sql.startsWith('UPDATE factory_settings')&&params.includes(lifecycle.KEY)) throw new Error('fixture ledger failure'); return next();
        });
        await failDeletion('draft CAS failure rolls back the entire device deletion',(sql,params,next)=>sql.startsWith('UPDATE scenes SET draft_json=')?{changes:0}:next());
        await failDeletion('physical device delete failure rolls back earlier dashboard and ledger cleanup',(sql,params,next)=>{
            if(sql.startsWith('DELETE FROM devices')) throw new Error('fixture device failure'); return next();
        });
        const ledgerBefore=(await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?',[factoryId,lifecycle.KEY])).value;
        await db.run('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=?',['broken',factoryId,lifecycle.KEY]);
        const corruptBefore=await snapshot(); assert.ok((await request('/api/devices/life_rollback','DELETE',{confirmationName:'life_rollback'})).status>=400); assert.deepEqual(await snapshot(),corruptBefore);
        await db.run('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=?',[ledgerBefore,factoryId,lifecycle.KEY]);
        pass('corrupt trusted history refuses deletion instead of dropping confirmations or partially pruning');
        const untouched=await snapshot(); assert.equal((await request('/api/settings','PUT',{[lifecycle.KEY]:'fake'})).status,400); assert.deepEqual(await snapshot(),untouched);
        await db.run('INSERT INTO settings(`key`,value) VALUES(?,?)',[lifecycle.KEY,'fake-global']);
        assert.ok(!Object.hasOwn((await request('/api/settings')).body,lifecycle.KEY));
        const factoryCreated=await request('/api/factories','POST',{name:'没有删除历史的新厂'}); assert.equal(factoryCreated.status,201);
        const newFactory=factoryCreated.body.factory.id;
        assert.deepEqual(await lifecycle.readDashboardCleanupHistory(db,newFactory),[]);
        const emptyState=await documents.loadDesignerState(db,'',newFactory), newWs='life_empty_ws', newLine='life_empty_line';
        await db.run('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)',[newWs,newWs,newFactory]);
        await db.run('INSERT INTO `lines`(id,name,workshop_id) VALUES(?,?,?)',[newLine,newLine,newWs]); await device('life_empty',newLine);
        const emptyBefore=await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?',[emptyState.scene.id]);
        assert.equal((await request('/api/devices/life_empty','DELETE',{confirmationName:'life_empty'},newFactory)).status,200);
        assert.deepEqual(await db.get('SELECT draft_json,draft_revision FROM scenes WHERE id=?',[emptyState.scene.id]),emptyBefore);
        pass('internal history key cannot be forged/read in settings or inherited by new factories; truly empty new scenes do not block deletion');

        const rawWidget=widget('raw_reference',{visibility:{rules:[rule('life_dead'),rule('life_alive')],ruleMode:'any'}}); delete rawWidget.visible;
        const patchedWidget=cleanupDeletedDeviceContent({widgets:[rawWidget],scene:{views:[]}}, {deviceIds:['life_dead'],existingDeviceIds:['life_alive']}).document.widgets[0];
        const mirror=lifecycle.mirrorPatch({config_json:{custom:'保留',style:{color:'保留'},__designer:{frame:{x:99}}},binding_json:{custom:'保留'},visible:0},rawWidget,patchedWidget);
        assert.equal(mirror.visible,0); assert.equal(mirror.config.custom,'保留'); assert.deepEqual(mirror.config.__designer,{frame:{x:99}});
        assert.throws(()=>lifecycle.mirrorPatch({config_json:'broken',binding_json:'{}'},rawWidget,patchedWidget),/损坏/);
        pass('native JSON mirror patches preserve untouched visibility, authoring metadata and custom keys; damaged JSON is never replaced with empty defaults');

        const orphanPoint=await device('life_orphan'); await save(privateDocument('life_orphan',orphanPoint)); await bindings('life_orphan');
        await db.run('DELETE FROM widgets WHERE id=?',['life_orphan_caption']);
        await db.run('UPDATE widgets SET scene_id=? WHERE id=?',[foreignSceneId,'life_orphan_runtime']);
        const foreignMirror=await db.get('SELECT * FROM widgets WHERE id=?',['life_orphan_runtime']);
        const orphanDelete=await request('/api/devices/life_orphan','DELETE',{confirmationName:'life_orphan'});
        assert.equal(orphanDelete.status,200); revision=orphanDelete.body.dashboardCleanup.scenes[0].revision;
        assert.equal(await db.get('SELECT id FROM bindings WHERE widget_id=?',['life_orphan_caption']),null);
        assert.deepEqual(await db.get('SELECT * FROM widgets WHERE id=?',['life_orphan_runtime']),foreignMirror);
        assert.ok(await db.get('SELECT id FROM bindings WHERE widget_id=?',['life_orphan_runtime']));
        pass('orphan private bindings are removed even without a mirror, but a same-ID mirror owned by another scene and its bindings stay untouched');

        const damagedPoint=await device('life_damaged'); await save(privateDocument('life_damaged',damagedPoint));
        const damagedScene='life_damaged_scene';
        await db.run('INSERT INTO scenes(id,name,project_id,draft_json) VALUES(?,?,?,?)',[damagedScene,'损坏的独立草稿',project.id,'not-json']);
        const damagedBefore=await snapshot(), broadcastBefore=broadcasts.length;
        assert.ok((await request('/api/devices/life_damaged','DELETE',{confirmationName:'life_damaged'})).status>=400);
        assert.deepEqual(await snapshot(),damagedBefore); assert.equal(broadcasts.length,broadcastBefore);
        await db.run('DELETE FROM scenes WHERE id=?',[damagedScene]);
        pass('nonempty malformed drafts abort deletion safely instead of full normalization or partial cleanup');

        const noReadFallback=new Proxy(db,{get(target,key){if(key==='all')return async()=>{throw new Error('fixture registry unavailable');};return target[key];}});
        await assert.rejects(lifecycle.projectPublishedDeviceDeletion(noReadFallback,original,{factoryId}),/registry unavailable/);
        const originalFrozen=JSON.stringify(original);
        assert.equal(JSON.stringify(original),originalFrozen);
        pass('runtime registry failures propagate instead of treating an unavailable catalog as an empty factory');

        const numericPoint=await device('1'); await device('01'); await save(privateDocument('1',numericPoint,'numeric'));
        const mysqlReads=[];
        db.transaction=callback=>originalTransaction(tx=>callback(new Proxy(tx,{get(target,key){
            if(key==='dialect')return 'mysql';
            if(key==='all'||key==='get')return (sql,params)=>{
                mysqlReads.push(sql); return target[key](sql.replace(/ FOR UPDATE$/,''),params);
            };
            return target[key];
        }})));
        let numericDelete;
        try { numericDelete=await request('/api/devices/1','DELETE',{confirmationName:'1'}); }
        finally { db.transaction=originalTransaction; }
        assert.equal(numericDelete.status,200,JSON.stringify(numericDelete.body));
        assert.ok(numericDelete.body.dashboardCleanup.remainingDeviceIds.includes('01'));
        const numericRaw=JSON.parse((await db.get('SELECT draft_json FROM scenes WHERE id=?',[sceneId])).draft_json);
        assert.ok(numericRaw.widgets.some(w=>w.id==='numeric_caption'));
        assert.ok(!numericRaw.widgets.some(w=>w.id==='numeric_view_caption'));
        assert.ok(await db.get('SELECT id FROM devices WHERE id=?',['01']));
        pass('complete backend registry protects numeric alias 01 when deleting 1, while truly explicit device-owned views still disappear');
        for(const fragment of ['FROM scenes','FROM widgets','FROM factory_settings','FROM devices d'])
            assert.ok(mysqlReads.some(sql=>sql.includes(fragment)&&sql.endsWith(' FOR UPDATE')),fragment);
        pass('MySQL lifecycle and maintenance facade use current locking reads for drafts, mirror widgets, complete registry and trusted ledger');

        const oldId='life_trimmed_private';
        await db.transaction(async tx=>{
            for(let i=0;i<=lifecycle.MAX_EVENTS;i++) await lifecycle.recordDashboardCleanup(tx,{
                id:'fixture_trim_'+i,factoryId,deletedDeviceIds:[i===0?oldId:'fixture_trimmed_'+i],deletedPointIds:[],
                remainingDeviceIds:[],deletedAt:new Date(Date.now()+i).toISOString(),reason:'maintenance',scenes:[]
            });
        });
        const ledgerTrimmed=await lifecycle.readDashboardCleanupLedger(db,factoryId);
        assert.equal(ledgerTrimmed.events.length,lifecycle.MAX_EVENTS);
        assert.ok(ledgerTrimmed.deletionAtByDeviceId[oldId]);
        assert.ok(!ledgerTrimmed.events.some(event=>event.deletedDeviceIds.includes(oldId)));
        const historyTrimmed=(await documents.loadDesignerState(db,sceneId,factoryId)).dashboardCleanupHistory;
        const snapshotPlan=historyTrimmed.find(event=>event.reason==='history_snapshot');
        assert.ok(snapshotPlan.deletedDeviceIds.includes(oldId));
        assert.ok(!snapshotPlan.deletedDeviceIds.includes('life_dead')); // ID was recreated.
        assert.deepEqual(snapshotPlan.scenes,[]); assert.ok(snapshotPlan.remainingDeviceIds.includes('life_dead'));
        assert.equal((await lifecycle.readDashboardCleanupHistory(db,factoryId)).at(-1).id,snapshotPlan.id);
        const oldOffline=clone(base);oldOffline.widgets=[widget('trimmed_private',{visibility:{rules:[rule(oldId)],ruleMode:'all'}}),widget('offline_shared')];
        const reconciled=cleanupDeletedDeviceContent(oldOffline,{deviceIds:snapshotPlan.deletedDeviceIds,existingDeviceIds:snapshotPlan.remainingDeviceIds});
        assert.deepEqual(reconciled.removedWidgetIds,['trimmed_private']);assert.ok(reconciled.document.widgets.some(w=>w.id==='offline_shared'));
        await device('life_new_catalog_entry');
        assert.notEqual((await lifecycle.readDashboardCleanupHistory(db,factoryId)).at(-1).id,snapshotPlan.id);
        pass('trimmed event details retain tombstones and synthesize a stable trusted missing-device snapshot for old offline caches, excluding recreated IDs and not advancing CAS');
        fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,directory},null,2));
        console.log(JSON.stringify({success:true,checks:checks.length,directory},null,2));
    } finally {
        delete global.wsServer;
        if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        await database.closeDb();
    }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
