'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { once } = require('node:events');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort,
    startLoggedProcess, requestJson, waitForHttp, waitUntil, waitForExit, forceStop, sleep } = require('./integration-test-utils.cjs');

(async () => {
    const directory = createRunDirectory('collector-process-http');
    const data = path.join(directory, 'data');
    fs.mkdirSync(data);
    const filename = await createTestDatabase(path.join(data, 'factory.db'));
    const Database = require('better-sqlite3');
    const seed = new Database(filename);
    seed.prepare("UPDATE settings SET value = 'simulation' WHERE `key` = 'data_mode'").run();
    seed.prepare("UPDATE factory_settings SET value = 'simulation' WHERE `key` = 'data_mode'").run();
    seed.close();
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    const shutdown = crypto.randomBytes(32).toString('hex');
    const env = { ...process.env, APP_DATA_DIR: data, DB_TYPE: 'sqlite', SQLITE_FILE: filename,
        PORT: String(port), HOST: '127.0.0.1', UPLOADS_DIR: path.join(directory, 'uploads'),
        ADMIN_API_TOKEN: crypto.randomBytes(32).toString('hex'), MCP_API_TOKEN: '',
        LICENSE_ENFORCE: 'false', LICENSE_FILE: path.join(data, 'license.json'),
        DESKTOP_SHUTDOWN_TOKEN: shutdown, DB_BACKUP_DIR: path.join(data, 'backups'),
        DB_RECOVERY_DIR: path.join(data, 'recovery'), COLLECTOR_DATABASE_CONNECT_ONLY: 'false' };
    const backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, env, logFile: path.join(directory, 'backend.log')
    });
    let ws, collectorPid;
    const health = () => requestJson(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
    try {
        await waitForHttp(`${origin}/api/health`);
        const initial = await waitUntil(async () => {
            const value = await health();
            return value.engine?.process?.status === 'running' && value.engine?.collectorStatus?.frames > 0 && value;
        }, 30000, 'independent simulation collector');
        assert.notEqual(initial.engine.process.pid, backend.pid);
        collectorPid = initial.engine.process.pid;
        assert.ok(Array.isArray(initial.collectorFactories) && initial.collectorFactories.length > 0,
            'health includes multi-factory operations telemetry');
        assert.equal(initial.components.displayConnection.status, 'offline', 'health polling is not a connected display');
        for (const factory of initial.collectorFactories) {
            assert.ok(Array.isArray(factory.devices));
            assert.equal(factory.mode, 'simulation');
            assert.ok(!Object.hasOwn(factory, 'databaseConfig'));
        }
        ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`);
        await once(ws, 'open');
        ws.send(JSON.stringify({ type:'client_hello', role:'unity' }));
        ws.send(JSON.stringify({ type:'dashboard_context', payload:{sceneReady:true} }));
        const linked = await waitUntil(async () => {
            const value = await health();
            return value.components.displayConnection.sceneReadyClients === 1 && value;
        }, 5000, 'native display health in real backend');
        assert.equal(linked.components.displayConnection.status, 'online');
        assert.equal(linked.components.displayConnection.connectedClients, 1);
        ws.close();
        await once(ws, 'close');
        ws = null;
        await waitUntil(async () => (await health()).components.displayConnection.status === 'offline', 5000, 'display disconnect without collector stop');
        const firstFrame = initial.engine.collectorStatus.frames;
        await waitUntil(async () => (await health()).engine.collectorStatus.frames > firstFrame + 1, 5000, 'collection without UI');
        const sampleDb=new Database(filename,{readonly:true});
        let storedPoint;
        try{storedPoint=await waitUntil(()=>sampleDb.prepare('SELECT * FROM point_samples ORDER BY sampled_at DESC LIMIT 1').get(),5000,'raw point history without display');}finally{sampleDb.close();}
        const historyQuery=new URLSearchParams({device_id:storedPoint.device_id,point_id:storedPoint.point_id,source_mode:storedPoint.source_mode,from:String(Math.max(0,storedPoint.sampled_at-3600000)),to:String(Math.ceil(Date.now()))});
        const history=await requestJson(`${origin}/api/datapoints/history?${historyQuery}`,{headers:{'X-Factory-Id':storedPoint.factory_id}});
        assert.equal(history.retention,'configured');assert.equal(history.factoryId,storedPoint.factory_id);assert.ok(history.rows.length>0);
        assert.equal(history.retentionPolicy.recentEnabled,true);assert.equal(history.retentionPolicy.recentHours,24);
        assert.equal(history.pointPolicy.mode,'recent');assert.equal(storedPoint.retention_until,storedPoint.sampled_at+24*3600000);
        const wrongScope=await fetch(`${origin}/api/datapoints/history?${new URLSearchParams({...Object.fromEntries(historyQuery),device_id:'NOT_THIS_DEVICE'})}`,{headers:{'X-Factory-Id':storedPoint.factory_id,'X-Admin-Token':env.ADMIN_API_TOKEN}});
        assert.equal(wrongScope.status,404);
        const policyHeaders={'X-Factory-Id':storedPoint.factory_id,'X-Admin-Token':env.ADMIN_API_TOKEN};
        const liveSamples=new Database(filename,{readonly:true});
        try {
            await requestJson(`${origin}/api/datapoints/history-policy`,{method:'PUT',headers:policyHeaders,body:JSON.stringify({...history.retentionPolicy,recentHours:2})});
            await waitUntil(()=>liveSamples.prepare('SELECT sample_key FROM point_samples WHERE factory_id=? AND retention_until-sampled_at=? LIMIT 1').get(storedPoint.factory_id,2*3600000),10000,'factory retention hot reload over real collector IPC');
            await requestJson(`${origin}/api/datapoints/history-policy/points/${storedPoint.point_id}`,{method:'PUT',headers:policyHeaders,body:JSON.stringify({mode:'finite',days:3})});
            await waitUntil(()=>liveSamples.prepare('SELECT sample_key FROM point_samples WHERE factory_id=? AND device_id=? AND point_id=? AND retention_until-sampled_at=? LIMIT 1').get(storedPoint.factory_id,storedPoint.device_id,storedPoint.point_id,3*24*3600000),10000,'point retention hot reload over real collector IPC');
            assert.equal(liveSamples.prepare('SELECT retention_until FROM point_samples WHERE sample_key=?').get(storedPoint.sample_key).retention_until,storedPoint.retention_until,'hot reload never rewrites old sample deadlines');
            assert.equal((await health()).engine.process.pid,collectorPid,'policy saves do not restart the collector process');
        } finally {liveSamples.close();}
        process.kill(collectorPid, 'SIGKILL');
        const unavailable = await waitUntil(async () => {
            const value = await health();
            return value.engine.process.status !== 'running' && value;
        }, 2000, 'degraded collection with available API');
        assert.equal(unavailable.status, 'ok');
        assert.equal(unavailable.components.backend.status, 'healthy');
        assert.equal(unavailable.components.dataEngine.fresh, false);
        assert.equal(backend.exitCode, null);
        const config = await requestJson(`${origin}/api/config`);
        assert.ok(config.workshops.length, 'configuration API survives collector failure');
        const recovered = await waitUntil(async () => {
            const value = await health();
            return value.engine.process.status === 'running' && value.engine.process.pid !== collectorPid
                && value.engine.collectorStatus.frames > 0 && value;
        }, 15000, 'real collector restart');
        collectorPid = recovered.engine.process.pid;
        assert.ok(recovered.engine.process.restartCount >= 1);
        const points = await requestJson(`${origin}/api/plc/points/realtime`);
        assert.ok(Array.isArray(points.points), 'point monitor works over private IPC');
        await requestJson(`${origin}/api/engine/restart`, { method: 'POST' });
        const restarted = await health();
        assert.notEqual(restarted.engine.process.pid, collectorPid);
        collectorPid = restarted.engine.process.pid;
        await requestJson(`${origin}/api/internal/shutdown`, { method: 'POST', headers: { 'X-Shutdown-Token': shutdown } });
        assert.equal(await waitForExit(backend, 15000), 0);
        await waitUntil(() => { try { process.kill(collectorPid, 0); return false; } catch { return true; } }, 5000, 'collector shutdown');
        const db = new Database(filename, { readonly: true });
        assert.ok(db.prepare('SELECT COUNT(*) AS count FROM metric_snapshots').get().count > 0);
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
        db.close();
    } finally {
        ws?.terminate();
        await forceStop(backend);
        if (collectorPid) await sleep(200);
    }
    console.log(JSON.stringify({ success: true, apiSurvivesCollectorCrash: true, collectionWithoutUi: true,
        automaticRecovery: true, ipcPointMonitoring: true, historyPolicyHotReload:true, independentManualRestart: true,
        gracefulDatabaseShutdown: true, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
