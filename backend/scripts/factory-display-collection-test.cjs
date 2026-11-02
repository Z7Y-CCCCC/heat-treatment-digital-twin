'use strict';
// Only an owned SQLite database/child backend; never connect to site services.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, waitUntil, sleep } = require('./integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('factory-display-collection');
let server, database;
(async () => {
    const dataDir = path.join(directory, 'data'), filename = path.join(dataDir, 'factory.db');
    await createTestDatabase(filename);
    database = new Database(filename);
    // Exercise the additive migration of a pre-feature DB with a hidden factory.
    database.exec('ALTER TABLE factories DROP COLUMN collection_enabled');
    database.prepare('UPDATE factories SET is_enabled=0 WHERE id=?').run('factory_default');
    for (const id of ['factory_b', 'factory_c']) {
        database.prepare('INSERT INTO factories(id,name) VALUES(?,?)').run(id, id);
        database.prepare('INSERT INTO workshops(id,factory_id,name) VALUES(?,?,?)').run(id+'_ws', id, id);
        database.prepare('INSERT INTO lines(id,workshop_id,name) VALUES(?,?,?)').run(id+'_line', id+'_ws', id);
        database.prepare('INSERT INTO devices(id,line_id,name,model_type,plc_enabled) VALUES(?,?,?,?,0)').run(id+'_device', id+'_line', id, 'builtin_furnace');
        database.prepare("INSERT INTO factory_settings(factory_id,`key`,value) VALUES(?,'data_mode','simulation')").run(id);
    }
    database.prepare("UPDATE settings SET value='100' WHERE `key`='simulation_interval_ms'").run();
    database.prepare("UPDATE factory_settings SET value='100' WHERE `key`='simulation_interval_ms'").run();
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`, token = crypto.randomBytes(32).toString('hex');
    const start = async () => {
        server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
            env: { ...process.env, APP_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), ADMIN_API_TOKEN: token }, logFile: path.join(directory, `backend-${Date.now()}.log`) });
        await waitForHttp(origin+'/api/health');
    };
    const api = async (route, method='GET', body, factoryId='factory_default', expected=200) => {
        const response = await fetch(origin+'/api'+route, { method, headers: { 'Content-Type':'application/json', 'X-Admin-Token':token, 'X-Factory-ID':factoryId },
            ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
    };
    const metric = id => Number(database.prepare('SELECT COALESCE(MAX(id),0) AS n FROM metric_snapshots WHERE factory_id=?').get(id).n);
    const status = () => api('/engine/status');
    const collect = (id, enabled) => api(`/factories/${id}/collection`, 'PUT', { enabled });
    await start();
    await api('/factories'); // liveness is available before asynchronous DB migration
    assert.ok(database.prepare('PRAGMA table_info(factories)').all().some(column => column.name==='collection_enabled'));
    assert.equal(database.prepare('SELECT collection_enabled FROM factories WHERE id=?').get('factory_default').collection_enabled,1);
    await waitUntil(() => ['factory_default','factory_b','factory_c'].every(id => metric(id)>0), 20000, 'all factories collect regardless of display visibility');
    const initial = await status(), pid = initial.process.pid;
    assert.ok(pid);
    assert.equal((await api('/factories')).factories.find(f=>f.id==='factory_default').enabled,false);
    for (const id of ['factory_default','factory_b','factory_c']) await api(`/factories/${id}`, 'PUT', { enabled:false });
    const before = new Map(['factory_default','factory_b','factory_c'].map(id=>[id,metric(id)]));
    await waitUntil(() => [...before].every(([id,n])=>metric(id)>n), 16000, 'hiding every factory does not stop any collector');
    assert.equal((await status()).process.pid,pid);
    assert.equal((await api('/factories/live-summaries')).summaries.length,0);
    const collectionRows = (await api('/factories/collection-status')).factories;
    assert.equal(collectionRows.length,3,'hidden factories remain in acquisition summaries');
    const secondarySummary = collectionRows.find(row=>row.factoryId==='factory_b');
    assert.equal(secondarySummary.normalDevices,1); assert.equal(secondarySummary.abnormalDevices,0); assert.ok(secondarySummary.lastReadAt>0);
    for (const route of ['/config','/settings','/workshops','/lines','/devices','/datapoints']) await api(route);
    await api('/settings', 'PUT', { factory_name:'隐藏后仍可编辑' });
    assert.equal((await api('/config')).settings.factory_name,'隐藏后仍可编辑');
    await api('/factories/factory_default', 'PUT', { enabled:false,collectionEnabled:false }, 'factory_default', 400);
    await api('/factories/factory_b/collection', 'PUT', { enabled:'false' }, 'factory_default', 400);
    assert.equal((await collect('factory_b',false)).runtimeApplied,true);
    await sleep(1200);
    const stoppedB=metric('factory_b'), otherC=metric('factory_c');
    await waitUntil(()=>metric('factory_c')>otherC,16000,'unrelated factory continues');
    assert.equal(metric('factory_b'),stoppedB,'secondary factory must actually stop collecting');
    assert.equal((await status()).process.pid,pid,'factory switches must not restart the collector process');
    assert.equal((await collect('factory_default',false)).runtimeApplied,true);
    await waitUntil(async ()=>(await status()).collectorStatus.status==='stopped',5000,'primary factory stops');
    const stoppedA=metric('factory_default'), otherC2=metric('factory_c');
    await waitUntil(()=>metric('factory_c')>otherC2,16000,'primary pause does not stop other factories');
    assert.equal(metric('factory_default'),stoppedA);
    // Showing a factory is not permission to resume its acquisition.
    await api('/factories/factory_b','PUT',{enabled:true});
    assert.equal((await api('/factories')).factories.find(f=>f.id==='factory_b').collectionEnabled,false);
    await collect('factory_default',true);
    await waitUntil(async ()=>(await status()).collectorStatus.status==='connected',5000,'hidden factory collection resumes');
    assert.equal((await api('/factories')).factories.find(f=>f.id==='factory_default').enabled,false);
    await stopOwnedSmokeProcess(server); server=null;
    await start();
    await waitUntil(async ()=>(await status()).collectorStatus.status==='connected',10000,'restart retains hidden selected factory');
    const after=(await api('/factories'));
    assert.equal(after.activeFactoryId,'factory_default');
    assert.equal(after.factories.find(f=>f.id==='factory_b').collectionEnabled,false);
    await sleep(1300);assert.equal(metric('factory_b'),stoppedB,'disabled acquisition stays off after restart');
    await collect('factory_b',true);
    await waitUntil(()=>metric('factory_b')>stoppedB,10000,'explicit collection switch resumes after restart');
    console.log(JSON.stringify({success:true,directory,checks:['additive migration defaults collection on even when hidden','all factories may be hidden','hidden factories remain editable','visibility never interrupts acquisition','independent primary/secondary acquisition switches','no unrelated reader/process restart','display and collection flags persist independently across service restart']},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{database?.close();await stopOwnedSmokeProcess(server);});
