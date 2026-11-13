'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('history-policy'), data = path.join(directory, 'data');
Object.assign(process.env, { APP_DATA_DIR: data, DB_TYPE: 'sqlite', SQLITE_FILE: path.join(data,'factory.db'),
    UPLOADS_DIR: path.join(directory,'uploads'), LICENSE_ENFORCE:'false', INSTALL_CONTENT_POLICY:'empty-v1', ADMIN_API_TOKEN:'', MCP_API_TOKEN:'' });
for (const key of ['MYSQL_HOST','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
const { DEFAULT_POLICY, KEY, normalizePolicy, normalizePointPolicy, sampleRetention, selectSamples, readPolicy, DAY_MS } = require('../services/historyPolicy');
const { getDb, closeDb } = require('../db/database');
const { observedSamples, trendHistory, rawHistory } = require('../services/pointHistory');
const { AlarmOutbox, snapshotAlarmOutbox, verifyAlarmOutboxSnapshot } = require('../services/alarmOutbox');
const DataEngine = require('../services/dataEngine');
const express = require('express');
let server, engine, journal;
(async () => {
    await require('../services/historyPolicy').readHistoryPoints({all:async sql=>{assert.doesNotMatch(sql,/JOIN\s+lines\s/i,'MySQL reserved table identifiers must remain quoted');return [];}},'fixture');
    const now = Date.now(), HOUR = DAY_MS / 24;
    assert.deepEqual(normalizePolicy(), {version:1,recentEnabled:true,recentHours:24,metricMode:'finite',metricDays:90});
    assert.deepEqual(normalizePointPolicy(), {mode:'recent',days:30});
    for (const input of [null, [], {recentEnabled:'false'}, {recentHours:0}, {recentHours:721}, {recentHours:1.5}, {metricDays:0}, {metricMode:'all'}, {version:2}, {token:'not-allowed'}])
        assert.throws(() => normalizePolicy(input));
    for (const input of [null, [], {mode:'invalid'}, {days:0}, {days:'30'}, {mode:'recent',unknown:true}]) assert.throws(() => normalizePointPolicy(input));
    const recent = normalizePolicy({recentHours:2}), off = normalizePolicy({recentEnabled:false});
    assert.deepEqual(sampleRetention(recent, undefined, now), {record:true,retentionUntil:now+2*HOUR});
    assert.deepEqual(sampleRetention(off, undefined, now), {record:false,retentionUntil:null});
    assert.deepEqual(sampleRetention(recent, {mode:'off',days:30}, now), {record:false,retentionUntil:null});
    assert.deepEqual(sampleRetention(off, {mode:'finite',days:3}, now), {record:true,retentionUntil:now+3*DAY_MS});
    assert.equal(sampleRetention(normalizePolicy({recentHours:72}), {mode:'finite',days:1}, now).retentionUntil, now+3*DAY_MS);
    assert.deepEqual(sampleRetention(off, {mode:'permanent',days:30}, now), {record:true,retentionUntil:null});
    const scopeSample = {pointId:'1',deviceId:'a',sampledAt:now};
    assert.equal(selectSamples([scopeSample], off, new Map([['1',{deviceId:'b',mode:'permanent',days:30}]] )).length, 0, 'another device cannot enable permanent history');

    const db = await getDb();
    for (const f of ['a','b']) {
        await db.run('INSERT INTO factories(id,name) VALUES (?,?)', ['policy-'+f,'隔离工厂 '+f]);
        await db.run('INSERT INTO workshops(id,factory_id,name) VALUES (?,?,?)', ['work-'+f,'policy-'+f,'车间']);
        await db.run('INSERT INTO lines(id,workshop_id,name) VALUES (?,?,?)', ['line-'+f,'work-'+f,'产线']);
        await db.run('INSERT INTO devices(id,line_id,name) VALUES (?,?,?)', ['device-'+f,'line-'+f,'设备 '+f]);
        await db.run('INSERT INTO factory_settings(factory_id,`key`,value) VALUES (?,?,?)', ['policy-'+f,'data_mode','simulation']);
    }
    const ids=[];
    for (const [device, name] of [['a','temp'],['a','pressure'],['b','temp']]) {
        const result = await db.run('INSERT INTO data_points(device_id,name,label,plc_tag,data_type) VALUES (?,?,?,?,?)', ['device-'+device,name,name,'DB1.DBD0','REAL']);
        ids.push(String(result.insertId));
    }
    const workshopPoints = {};
    for (const [id, line, config] of [['workshop-a', null, {workshopId:'work-a'}], ['workshop-b', null, {workshop_id:'work-b'}], ['line-wins', 'line-b', {workshop_id:'work-a'}], ['broken-config', null, null]]) {
        await db.run('INSERT INTO devices(id,line_id,name,instance_config) VALUES (?,?,?,?)', [id,line,id,config ? JSON.stringify(config) : '{invalid']);
        const result = await db.run('INSERT INTO data_points(device_id,name,label,plc_tag,data_type) VALUES (?,?,?,?,?)', [id,'temp','温度','DB1.DBD0','REAL']);
        workshopPoints[id] = String(result.insertId);
    }
    const app = express();
    app.use('/api/admin-auth', express.json(), require('../routes/adminAuth')());
    app.use(express.json());
    app.use(require('../middleware/security').protectManagementWrites);
    app.use('/api/datapoints', require('../services/factoryContext').factoryContext, require('../routes/datapoints'));
    app.use('/api/settings', require('../services/factoryContext').factoryContext, require('../routes/settings')());
    server = await new Promise(resolve => { const listener=app.listen(0,'127.0.0.1',()=>resolve(listener)); });
    process.env.PORT = String(server.address().port);
    const origin = 'http://127.0.0.1:' + server.address().port;
    let checks=0;
    async function request(route, {method='GET', session, body, factoryId='policy-a', expected=200, noCsrf=false}={}) {
        const response=await fetch(origin+'/api'+route,{method,headers:{Origin:origin,'X-Admin-Request':'1','X-Factory-ID':factoryId,
            ...(session?{Cookie:session.cookie,...(!noCsrf?{'X-CSRF-Token':session.csrfToken}:{})}:{}),
            ...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
        const result=await response.json();
        assert.equal(response.status,expected,`${method} ${route}: ${JSON.stringify(result)}`);checks++;
        return {...result,cookie:response.headers.getSetCookie().map(v=>v.split(';',1)[0]).join('; ')||session?.cookie,csrfToken:result.csrfToken||session?.csrfToken,cache:response.headers.get('cache-control')};
    }
    const password=crypto.randomBytes(24).toString('base64url');
    const owner=await request('/admin-auth/setup',{method:'POST',body:{password}});
    async function user(username, pagePermissions) {
        await request('/admin-auth/users',{method:'POST',session:owner,expected:201,body:{username,password,role:'viewer',permissions:{view:false},pagePermissions}});
        return request('/admin-auth/login',{method:'POST',body:{username,password}});
    }
    const reader=await user('history_reader',{points:{view:true}}),editor=await user('history_editor',{points:{view:true,edit:true}});
    const alarmEditor=await user('history_alarm_editor',{'points.alarms':{view:true,edit:true}});
    await request('/datapoints/history-policy',{expected:401});
    const initial=await request('/datapoints/history-policy?device_id=device-a',{session:reader});
    assert.deepEqual(initial.policy, DEFAULT_POLICY);assert.equal(initial.points.length,2);assert.equal(initial.cache,'no-store');
    assert.ok(initial.points.every(point=>point.history_mode==='recent' && point.history_days===30));
    const workshop = await request('/datapoints/history-policy?device_id=workshop-a',{session:reader});
    assert.equal(workshop.points.length,1);assert.equal(String(workshop.points[0].id),workshopPoints['workshop-a']);
    assert.ok(!Object.hasOwn(workshop.points[0],'instance_config'),'device configuration is not disclosed by the policy API');
    const allPoints = await request('/datapoints/history-policy',{session:reader});
    assert.deepEqual(allPoints.points.map(p=>String(p.id)).sort(), [...ids.slice(0,2),workshopPoints['workshop-a']].sort());
    await request('/datapoints/history-policy?device_id=line-wins',{session:reader,expected:404});
    await request('/datapoints/history-policy?device_id=device-b',{session:reader,expected:404});
    const changed=normalizePolicy({recentHours:2,metricMode:'off'});
    for (const session of [reader,alarmEditor]) await request('/datapoints/history-policy',{method:'PUT',session,body:changed,expected:403});
    await request('/datapoints/history-policy',{method:'PUT',session:editor,body:changed,noCsrf:true,expected:403});
    await request('/datapoints/history-policy',{method:'PUT',session:editor,body:{...changed,recentHours:0},expected:400});
    await request('/datapoints/history-policy',{method:'PUT',session:editor,factoryId:'missing',body:changed,expected:404});
    const saved=await request('/datapoints/history-policy',{method:'PUT',session:editor,body:changed});
    assert.equal(saved.futureSamplesOnly,true);assert.deepEqual(saved.policy,changed);
    assert.deepEqual((await request('/datapoints/history-policy',{session:reader,factoryId:'policy-b'})).policy, DEFAULT_POLICY);
    for (const [id,mode,days] of [[ids[0],'finite',3],[ids[1],'off',30]]) {
        const value=await request('/datapoints/history-policy/points/'+id,{method:'PUT',session:editor,body:{mode,days}});
        assert.equal(value.pointId,id);assert.equal(value.futureSamplesOnly,true);
    }
    await request('/datapoints/history-policy/points/'+ids[2],{method:'PUT',session:editor,body:{mode:'permanent'},expected:404});
    await request('/datapoints/history-policy/points/'+ids[0],{method:'PUT',session:reader,body:{mode:'off'},expected:403});
    await request('/datapoints/history-policy/points/'+ids[0],{method:'PUT',session:editor,body:{mode:'finite',days:-1},expected:400});
    await request('/settings',{method:'PUT',session:editor,body:{[KEY]:JSON.stringify(changed)},expected:403});
    await request('/settings',{method:'PUT',session:owner,body:{[KEY]:JSON.stringify(changed)},expected:400});
    assert.deepEqual(await readPolicy(db,'policy-a'),changed);

    journal = new AlarmOutbox(path.join(data,'history-journal.db'));
    engine = new DataEngine({broadcastDeviceData(){},broadcastStatus(){}},{alarmOutbox:()=>journal});
    engine.activeFactoryId='policy-a';engine.currentMode='simulation';
    let reloads=0;
    const runningSimulator={devices:[{id:'device-a'},{id:'workshop-a'}],reloadConfiguration:async()=>{reloads++},stop(){}};
    engine.simulator=runningSimulator;
    await engine.reloadFactoryConfiguration('policy-a');
    assert.equal(engine.simulator,runningSimulator,'saving policy does not replace the running collector');
    assert.equal(reloads,1);assert.deepEqual(engine.historyPolicy,changed,'hot reload applies the saved factory policy without restart');
    assert.equal(engine.pointHistoryPolicies.get(ids[0]).mode,'finite');assert.equal(engine.pointHistoryPolicies.get(ids[1]).mode,'off');
    assert.ok(engine.pointHistoryPolicies.has(workshopPoints['workshop-a']));
    assert.ok(!engine.pointHistoryPolicies.has(workshopPoints['line-wins']));
    const device=(timestamp)=>({furnace_id:'device-a',timestamp,analog:{temp:850,pressure:20},quality:{analog:{temp:'good',pressure:'good'}},
        pointMeta:{'analog.temp':{id:ids[0],timestamp},'analog.pressure':{id:ids[1],timestamp}}});
    engine._publishRealtimeData([device(now)]);await engine.historyWritePending;
    let rows=await db.all('SELECT * FROM point_samples');
    assert.equal(rows.length,1);assert.equal(rows[0].point_id,ids[0]);assert.equal(rows[0].retention_until,now+3*DAY_MS);
    await engine._writeMetrics([device(now)]);
    assert.equal((await db.get('SELECT COUNT(*) n FROM metric_snapshots')).n,0,'metric off stops recording, not realtime summaries');
    assert.ok(engine.metricSummary);
    engine.historyPolicy=normalizePolicy({metricDays:2});engine.lastMetricSnapshotAt=0;
    await engine._writeMetrics([device(now)]);
    const metric=await db.get('SELECT * FROM metric_snapshots');assert.ok(metric.retention_until>=now+2*DAY_MS);
    engine.historyPolicy=normalizePolicy({recentEnabled:false,metricMode:'permanent'});
    engine.pointHistoryPolicies.set(ids[0],{deviceId:'device-a',mode:'permanent',days:30});
    engine._publishRealtimeData([device(now+1000)]);await engine.historyWritePending;
    engine.lastMetricSnapshotAt=0;await engine._writeMetrics([device(now)]);
    assert.equal((await db.get('SELECT COUNT(*) n FROM metric_snapshots WHERE retention_until IS NULL')).n,1);
    engine.pointHistoryPolicies.set(ids[0],{deviceId:'device-a',mode:'recent',days:30});
    engine._publishRealtimeData([device(now+2000)]);await engine.historyWritePending;
    rows=await db.all('SELECT * FROM point_samples ORDER BY sampled_at');
    assert.equal(rows.length,2,'recent disabled and point off stop new records');
    assert.equal(rows[0].retention_until,now+3*DAY_MS,'strategy changes never rewrite old deadlines');assert.equal(rows[1].retention_until,null);

    const sample=observedSamples('policy-a',[device(now-10000)],'simulation')[0];
    journal.recordSamples('policy-a',[{...sample,retentionUntil:now-1}]);await engine._flushPointSamples();
    const scope={factoryId:'policy-a',deviceId:'device-a',pointId:ids[0],sourceMode:'simulation'},range={from:now-20000,to:now+2000};
    assert.equal((await trendHistory(db,scope,range)).rows.length,2,'expired samples are not served before background cleanup');
    assert.equal((await rawHistory(db,scope,range)).rows.length,2);
    assert.equal((await db.get('SELECT COUNT(*) n FROM point_samples')).n,3,'read requests do not delete history');
    for (const endpoint of ['/datapoints/history','/datapoints/history/records']) {
        const query='?device_id=device-a&point_id='+ids[0]+'&from='+range.from+'&to='+range.to+'&source_mode=simulation';
        const result=await request(endpoint+query,{session:reader});assert.equal(result.rows.length,2);assert.equal(result.cache,'no-store');
        await request(endpoint+query,{session:reader,factoryId:'policy-b',expected:404});
    }
    const queued={...observedSamples('policy-a',[device(now+3000)],'simulation')[0],retentionUntil:now+3*DAY_MS};
    journal.recordSamples('policy-a',[queued]);
    const snapshot=path.join(directory,'snapshot.db');await snapshotAlarmOutbox(journal.database.name,snapshot);
    const Database=require('better-sqlite3'), broken=new Database(snapshot);
    broken.prepare('UPDATE pending_point_sample SET payload=?').run(JSON.stringify({...queued,retentionUntil:'invalid'}));broken.close();
    assert.throws(()=>verifyAlarmOutboxSnapshot(snapshot),/无效记录/);
    console.log(JSON.stringify({success:true,checks,recentDefault:true,perPointModes:true,metricModes:true,scopeIsolation:true,permissions:true,futureSamplesOnly:true,directory}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await engine?.stop();journal?.close();if(server)await new Promise(resolve=>server.close(resolve));await closeDb();
});
