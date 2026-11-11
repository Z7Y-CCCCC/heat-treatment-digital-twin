'use strict';
// Real isolated HTTP + collector IPC and display-only engines. No real PLC/DB.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, waitUntil, testFetch, forceStop, sleep } = require('./integration-test-utils.cjs');
const { manualValue, automaticValue, pointPath } = require('../services/simulationPoints');
const directory = createRunDirectory('simulation-points'), checks = [];
const check = label => { checks.push(label); console.log('PASS ' + label); };
let child, sql;
(async () => {
  for (const [type, valid, invalid] of [['BOOL',false,'maybe'], ['WORD',65535,-1], ['BYTE',255,256], ['INT',-32768,32768], ['DWORD',4294967295,4294967296], ['DINT',-2147483648,-2147483649], ['REAL',1.25,Infinity], ['LREAL',2.125,''], ['CHAR','A','AB'], ['STRING','任意模拟文本',{}], ['DT','2026-11-11T12:00:00+08:00','not a date']]) {
    assert.notEqual(manualValue({ data_type:type }, valid), undefined);
    assert.throws(() => manualValue({ data_type:type }, invalid));
    assert.notEqual(automaticValue({ id:'p', data_type:type }, undefined, 10, Date.now()), null);
  }
  assert.equal(manualValue({ data_type:'WORD', scale:.1 }, '12.5'), 12.5, 'entered engineering value must not be scaled again');
  assert.throws(() => manualValue({ data_type:'BOOL', access_type:'WRITE' }, true));
  assert.throws(() => pointPath({ category:'__proto__', name:'polluted' }));
  assert.equal(automaticValue({ data_type:'REAL', expression:'x / 0' }, undefined, 2, Date.now()), null);
  check('typed values, numeric bounds, engineering values and invalid transforms are validated without executing expressions');

  for (const role of ['collector', 'display']) {
    const run = path.join(directory, role), dataDir = path.join(run, 'data');
    const filename = await createTestDatabase(path.join(dataDir, 'factory.db'));
    const Database = require('better-sqlite3'); sql = new Database(filename);
    sql.prepare("UPDATE settings SET value='100' WHERE `key`='simulation_interval_ms'").run();
    sql.prepare("UPDATE factory_settings SET value='100' WHERE `key`='simulation_interval_ms'").run();
    sql.prepare("INSERT OR REPLACE INTO factory_settings(factory_id,`key`,value) VALUES ('factory_default','simulation_interval_ms','100')").run();
    const device = sql.prepare('SELECT d.* FROM devices d JOIN lines l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1').get('factory_default');
    assert.ok(device);
    const foreign = sql.prepare('SELECT id FROM factories WHERE id<>? LIMIT 1').get('factory_default');
    if (!foreign) sql.prepare("INSERT INTO factories(id,name) VALUES ('simulation_foreign','Foreign')").run();
    const foreignId = foreign?.id || 'simulation_foreign';
    sql.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode' AND factory_id<>?").run('factory_default');
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    child = startLoggedProcess(process.execPath, ['server.js'], { cwd:BACKEND_DIR,
      env:{ ...process.env, APP_DATA_DIR:dataDir, PORT:new URL(origin).port, HOST:'127.0.0.1', APP_RUNTIME_ROLE:role }, logFile:path.join(run,'backend.log') });
    await waitForHttp(origin+'/api/health');
    async function request(route, method='GET', body, factory='factory_default') {
      const response = await testFetch(origin+route, { method, headers:{'Content-Type':'application/json','X-Factory-ID':factory}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
      return { status:response.status, data:await response.json() };
    }
    async function ok(...args) { const result=await request(...args); assert.ok(result.status<300,JSON.stringify(result)); return result.data; }
    const live = async () => (await ok('/api/plc/points/realtime?device_id='+device.id)).points;
    await waitUntil(async () => (await live()).some(point => point.quality==='good'),10000,'initial simulated frame');
    const create = async (name,type='WORD',access='READ',extra={}) => (await ok('/api/datapoints','POST',{device_id:device.id,name,label:name,plc_tag:type==='BOOL'?'DB8.DBX0.0':'DB8.DBD8',data_type:type,category:'analog',sample_interval_ms:100,access_type:access,...extra})).id;
    const ids = [];
    for (const [name,type,access] of [['last_station','WORD','READ'],['start_action','WORD','READ'],['start_position','REAL','READ_WRITE'],['end_position','INT','READ'],['new_flag','BOOL','READ'],['new_text','STRING','READ'],['new_date','DT','READ'],['write_only','WORD','WRITE']]) ids.push(await create(name,type,access));
    await waitUntil(async () => { const rows=await live(); return ids.slice(0,-1).every(id=>rows.find(p=>p.id===id)?.quality==='good'); },12000,role+' custom and newly created points');
    const rows=await live(); assert.equal(rows.find(p=>p.id===ids[4]).sourceMode,'simulation'); assert.equal(typeof rows.find(p=>p.id===ids[4]).value,'boolean');
    assert.equal(rows.find(p=>p.id===ids.at(-1)).value,null);
    check(role+': newly added WORD/REAL/INT/BOOL/STRING/date and READ_WRITE points automatically produce fresh typed simulation values; WRITE-only stays unread');
    const definitionBefore=sql.prepare('SELECT * FROM data_points WHERE id=?').get(ids[0]);
    await ok(`/api/datapoints/${ids[0]}/simulation`,'PUT',{value:123});
    await waitUntil(async()=>{const point=(await live()).find(p=>p.id===ids[0]);return point.value===123&&point.simulationManual;},5000,'manual override visible');
    const first=(await live()).find(p=>p.id===ids[0]); await sleep(650);
    const second=(await live()).find(p=>p.id===ids[0]); assert.equal(second.value,123); assert.ok(second.lastReadAt>first.lastReadAt); assert.equal(second.quality,'good');
    await create('point_added_after_override','REAL');
    await sleep(600); assert.equal((await live()).find(p=>p.id===ids[0]).value,123);
    assert.deepEqual(sql.prepare('SELECT * FROM data_points WHERE id=?').get(ids[0]),definitionBefore,'editing a simulated reading cannot change point configuration');
    check(role+': fixed simulation value survives multiple ticks, HTTP refreshes and a point configuration reload without changing stored point/PLC data');
    const beforeInvalid=(await live()).find(p=>p.id===ids[0]);
    assert.equal((await request(`/api/datapoints/${ids[0]}/simulation`,'PUT',{value:-1})).status,400);
    assert.equal((await request(`/api/datapoints/${ids.at(-1)}/simulation`,'PUT',{value:1})).status,400);
    assert.equal((await request(`/api/datapoints/${ids[0]}/simulation`,'PUT',{value:10},foreignId)).status,404);
    assert.equal((await live()).find(p=>p.id===ids[0]).value,beforeInvalid.value);
    await ok(`/api/datapoints/${ids[4]}/simulation`,'PUT',{value:false}); assert.equal((await live()).find(p=>p.id===ids[4]).value,false);
    await ok(`/api/datapoints/${ids[0]}/simulation`,'DELETE');
    await waitUntil(async()=>{const p=(await live()).find(p=>p.id===ids[0]);return !p.simulationManual&&p.value!==123;},5000,'resume automatic');
    check(role+': false/zero are valid values; invalid types, write-only and foreign-factory requests cannot mutate readings; reset resumes automatic generation');
    await ok(`/api/datapoints/${ids[0]}/simulation`,'PUT',{value:321});
    await ok('/api/collector/mode','PUT',{mode:'external',expectedMode:'simulation'});
    assert.equal((await request(`/api/datapoints/${ids[0]}/simulation`,'PUT',{value:1})).status,409);
    await ok('/api/collector/mode','PUT',{mode:'simulation',expectedMode:'external'});
    await waitUntil(async()=>{const p=(await live()).find(p=>p.id===ids[0]);return p.sourceMode==='simulation'&&p.quality==='good'&&!p.simulationManual&&p.value!==321;},10000,'new simulation session clears overrides');
    check(role+': non-simulation mode rejects edits and leaving/re-entering simulation clears the session-only override');
    await forceStop(child); child=null; sql.close(); sql=null;
  }
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({success:true,checks},null,2));
  console.log(JSON.stringify({success:true,checks:checks.length,directory}));
})().catch(error=>{console.error(error);fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,checks},null,2));process.exitCode=1;}).finally(async()=>{await forceStop(child);sql?.close();});
