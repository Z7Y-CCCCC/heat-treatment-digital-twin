// Owned SQLite/HTTP fixture. No operator database, model or PLC is touched.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Database = require('better-sqlite3');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, forceStop } = require('./integration-test-utils.cjs');
const { getBuiltinModels } = require('../services/builtinModels');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const { normalizePagePermissions, allowsRequirement } = require('../../shared/pagePermissions.cjs');
const { saveDockingCalibration } = require('../services/dockingCalibration');
const checks = [], pass = name => { checks.push(name); console.log('PASS ' + name); };
let backend, database;
(async () => {
  const directory = createRunDirectory('docking-calibration'), file = path.join(directory, 'data', 'factory.db');
  await createTestDatabase(file); database = new Database(file);
  const template = getBuiltinModels().find(m => m.placement_level === 'device' && m.file_path);
  const metadata = JSON.parse(template.metadata || '{}'); metadata.loadingPorts = {version:1,inlet:{position:[0,1,1],direction:[0,0,1],nodeName:''},outlet:{position:[0,1,-1],direction:[0,0,-1],nodeName:''}};
  database.prepare('INSERT INTO models (id,name,file_path,default_scale,metadata,placement_level,asset_type) VALUES (?,?,?,?,?,?,?)').run('dock_model','校准模型',template.file_path,1,JSON.stringify(metadata),'device','model');
  const layout = JSON.stringify({version:1,lanes:[{id:'lane',offsetZ:-4,length:60}],rails:[{id:'rail',offsetZ:0,length:60},{id:'far',offsetZ:30,length:60}]});
  database.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(layout,'line_a');
  const insert = database.prepare('INSERT INTO devices (id,name,model_type,line_id,coordinate_space,pos_x,pos_y,pos_z,rotation_y,scale,instance_config,plc_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('dock_target','校准工位','dock_model','line_a','line_local',10,.2,-4,0,1,JSON.stringify({laneId:'lane',laneLineId:'line_a',stationNumber:1,preserve:{Case:'ABC'}}),0);
  insert.run('dock_cart','校准小车','dock_model','line_a','line_local',2,0,0,0,1,JSON.stringify({railId:'rail',railLineId:'line_a',role:'auxiliary',preserve:{Case:'CART'}}),0);
  insert.run('dock_far','另一导轨小车','dock_model','line_a','line_local',2,0,30,0,1,JSON.stringify({railId:'far',railLineId:'line_a',role:'auxiliary'}),0);
  const factoryId=database.prepare('SELECT factory_id FROM workshops WHERE id=?').get('ws_1').factory_id;
  const origin=`http://127.0.0.1:${await findFreePort()}`;
  backend=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...process.env,APP_DATA_DIR:path.dirname(file),HOST:'127.0.0.1',PORT:origin.split(':').pop()},logFile:path.join(directory,'backend.log')});
  await waitForHttp(origin+'/api/health');
  async function api(route,method='GET',body,factory=factoryId) { const r=await testFetch(origin+route,{method,headers:{'Content-Type':'application/json','X-Factory-ID':factory},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,payload:await r.json()}; }
  async function payload(cartId='dock_cart') {
    const [device,cart]=await Promise.all([api('/api/devices/dock_target/loading-ports'),api(`/api/devices/${cartId}/loading-ports`)]);
    assert.equal(device.status,200);assert.equal(cart.status,200);
    const line=database.prepare('SELECT * FROM lines WHERE id=?').get('line_a');
    return {deviceId:'dock_target',cartId,deviceRevision:device.payload.revision,cartRevision:cart.payload.revision,expectedLine:{id:line.id,workshop_id:line.workshop_id,layout_json:line.layout_json},position:{x:device.payload.device.pos_x+.05,y:device.payload.device.pos_y+.01}};
  }
  const before=database.prepare('SELECT * FROM devices WHERE id=?').get('dock_target'),cartBefore=database.prepare('SELECT * FROM devices WHERE id=?').get('dock_cart'),modelBefore=database.prepare('SELECT * FROM models WHERE id=?').get('dock_model');
  let body=await payload(),result=await api('/api/devices/docking-calibration','PUT',body);
  assert.equal(result.status,200,JSON.stringify(result.payload));assert.equal(result.payload.success,true);assert.equal(result.payload.devices.length,1);
  const after=database.prepare('SELECT * FROM devices WHERE id=?').get('dock_target');
  for(const key of Object.keys(before)) if(!['pos_x','pos_y'].includes(key))assert.deepEqual(after[key],before[key],key);
  assert.equal(after.pos_x,body.position.x);assert.equal(after.pos_y,body.position.y);
  assert.deepEqual(database.prepare('SELECT * FROM devices WHERE id=?').get('dock_cart'),cartBefore);assert.deepEqual(database.prepare('SELECT * FROM models WHERE id=?').get('dock_model'),modelBefore);
  pass('real HTTP save changes only the selected physical X/Y; cart/ports/model/PLC/peer remain unchanged');
  assert.equal((await api('/api/devices/docking-calibration','PUT',body)).status,409);pass('stale target snapshot is rejected');
  body=await payload();database.prepare('UPDATE devices SET pos_x=pos_x+.1 WHERE id=?').run('dock_cart');assert.equal((await api('/api/devices/docking-calibration','PUT',body)).status,409);pass('read-only cart pose change invalidates preview');
  body=await payload();database.prepare('UPDATE models SET default_scale=1.2 WHERE id=?').run('dock_model');assert.equal((await api('/api/devices/docking-calibration','PUT',body)).status,409);pass('model asset scale change invalidates preview');
  body=await payload();database.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(layout),flowDirection:'left'}),'line_a');assert.equal((await api('/api/devices/docking-calibration','PUT',body)).status,409);pass('line context change invalidates preview');
  body=await payload();const pair=await Promise.all([api('/api/devices/docking-calibration','PUT',body),api('/api/devices/docking-calibration','PUT',{...body,position:{x:body.position.x+.1,y:body.position.y}})]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);pass('concurrent calibration confirmations have exactly one committed writer');
  body=await payload();assert.equal((await api('/api/devices/docking-calibration','PUT',{...body,position:{x:'1',y:1}})).status,400);assert.equal((await api('/api/devices/docking-calibration','PUT',{...body,plc_ip:'not-allowed'})).status,400);assert.equal((await api('/api/devices/docking-calibration','PUT',{...body,deviceRevision:''})).status,428);assert.equal((await api('/api/devices/docking-calibration','PUT',body,'factory_missing')).status,404);pass('malformed/missing snapshot, unknown fields and cross-factory requests fail closed');
  assert.equal((await api('/api/devices/docking-calibration','PUT',await payload('dock_far'))).status,400);pass('a same-line cart on another rail cannot be used as the physical reference');
  database.prepare('UPDATE devices SET pos_x=90000 WHERE id=?').run('dock_target');body=await payload();body.position.x=90000.00001;assert.equal((await api('/api/devices/docking-calibration','PUT',body)).status,400);pass('sub-float32 nonzero motion cannot claim a successful native placement');
  database.prepare('UPDATE models SET default_scale=NULL WHERE id=?').run('dock_model');body=await payload();const nullable=await api('/api/devices/docking-calibration','PUT',body);assert.equal(nullable.status,200,JSON.stringify(nullable.payload));pass('legacy nullable model scale is guarded without false conflict');
  const context=page=>({active:true,owner:false,permissions:{view:false},pagePermissions:normalizePagePermissions({[page]:{view:true,edit:true}})});
  for(const page of ['models','devices','lines','composer','model-animations'])assert.equal(allowsRequirement(apiPermission('/api/devices/docking-calibration','PUT'),context(page)),['lines','composer'].includes(page));pass('authoring requires placement permission, not model-only or device-only grants');
  body=await payload();let captured;
  const tx={get:async(sql,args)=>database.prepare(sql).get(...args),all:async(sql,args)=>database.prepare(sql).all(...(args||[])),run:async(sql,args)=>{captured={sql,args};return {affectedRows:1}}};
  await saveDockingCalibration(tx,body,factoryId,'mysql');assert.match(captured.sql,/FROM \(SELECT \* FROM devices WHERE id=\? LIMIT 1\) c/);assert.match(captured.sql,/m\.default_scale IS NULL/);assert.match(captured.sql,/m\.placement_level/);assert.match(captured.sql,/m\.asset_type/);assert.equal((captured.sql.match(/\?/g)||[]).length,captured.args.length);pass('MySQL SQL uses non-mergeable read-reference and complete asset CAS, including nullable scale');
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await forceStop(backend);database?.close()});
