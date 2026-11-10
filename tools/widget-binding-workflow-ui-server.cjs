// Private, collector:false SQLite fixture. All points, events, frames and
// prepared HTTP tables belong to this test. No commissioned backend or PLC.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForOwnedBackend, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { getBuiltinModels } = require('../backend/services/builtinModels');
let backend, source;
async function stop() { await stopOwnedSmokeProcess(backend); source?.closeAllConnections(); source?.close(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);

(async () => {
  const root = path.resolve(__dirname, '..'), sandbox = await createSmokeSandbox('widget-binding-workflow-fixture');
  sandbox.password = `WidgetBinding-${crypto.randomBytes(18).toString('hex')}!`;
  const db = new Database(sandbox.filename);
  const line = db.prepare('SELECT l.id,w.factory_id FROM lines l JOIN workshops w ON w.id=l.workshop_id ORDER BY l.id LIMIT 1').get();
  if (!line) throw new Error('Owned fixture requires a scoped line');
  const model = getBuiltinModels().find(row => row.id === 'pit_furnace_2_v1');
  if (!model) throw new Error('Owned fixture requires packaged model metadata');
  db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run(); db.prepare('DELETE FROM event_logs').run();
  db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)')
    .run('binding_fixture_model', '绑定验收炉型', model.file_path, model.metadata, 'device', 'model');
  const devices = [], readings = {}, points = {};
  for (const [index, letter] of ['A', 'B', 'C', 'D'].entries()) {
    const device = { id:`BindingFurnace${letter}`, name:`${index + 1}号绑定验收炉`, viewId:`device_binding_${letter.toLowerCase()}` };
    db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,instance_config,sort_order) VALUES(?,?,?,?,?,?,?)')
      .run(device.id, device.name, line.id, 'binding_fixture_model', 0, '{}', index);
    devices.push(device); points[device.id] = {};
    const keys = ['progress', 'hours', 'energy'];
    const values = [[0,12,101],[85,34,202],[53,56,303],[65,78,404]][index];
    const labels = ['实际工艺进度', '实际运行时长', '实际耗电量'];
    for (const [offset, key] of keys.entries()) {
      const tag = `DB${101 * (index + 1)}.DBD${index * 64 + offset * 8}`, role = `${key}_${letter.toLowerCase()}`, unit = ['%', 'h', 'kWh'][offset];
      const id = String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality,unit) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(device.id, `fixture_${key}_${letter}`, labels[offset], tag, 'REAL', 'analog', role, 250, 'READ', 'good', unit).lastInsertRowid);
      points[device.id][key] = { id, tag, role, key:`analog.${role}`, unit, label:labels[offset], value:values[offset] };
      readings[id] = { deviceId:device.id, value:values[offset], quality:'good', role, unit };
    }
  }
  const events = [
    { title:'A炉真实警告', message:'自有记录：A炉温度预警', level:'warning', source_id:devices[0].id },
    { title:'B炉真实严重报警', message:'自有记录：B炉联锁报警', level:'critical', source_id:devices[1].id },
    { title:'A炉真实提示', message:'自有记录：A炉工艺完成', level:'info', source_id:devices[0].id }
  ];
  for (const event of events) db.prepare('INSERT INTO event_logs(factory_id,event_type,level,source_id,title,message,quality) VALUES(?,?,?,?,?,?,?)')
    .run(line.factory_id, 'owned-fixture', event.level, event.source_id, event.title, event.message, 'good');
  db.prepare('INSERT INTO event_logs(factory_id,event_type,level,source_id,title,message,quality) VALUES(?,?,?,?,?,?,?)')
    .run('not_the_fixture_factory', 'owned-fixture', 'warning', devices[0].id, '外厂记录不得显示', '不属于当前工厂', 'good');
  db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
  db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
  db.close();

  const runtimeFile = requireTestPath(path.join(sandbox.directory, 'owned-readings.json'));
  fs.writeFileSync(runtimeFile, JSON.stringify({ factoryId:line.factory_id, devices, readings }));
  const requests = [];
  source = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); requests.push({ path:url.pathname, at:Date.now() });
    if (url.pathname === '/audit') { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({requests})); return; }
    if (url.pathname !== '/factory') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    response.end(JSON.stringify({ rows:[{ overallProgress:73, energy:456, hoursTotal:150 }] }));
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  if (new URL(sourceOrigin).port === '3001') throw new Error('Refusing the commissioned port');
  const serverDirectory = path.join(sandbox.directory, 'resources', 'backend'); fs.mkdirSync(serverDirectory, {recursive:true});
  const { COLLECTOR_FILES } = require('../desktop/scripts/prepare-display-distribution.cjs');
  for (const name of ['server.js','services','db','routes','utils','middleware']) fs.cpSync(path.join(BACKEND_DIR,name),path.join(serverDirectory,name),{recursive:true,filter:file=>!COLLECTOR_FILES.includes(path.basename(file))});
  fs.symlinkSync(path.join(BACKEND_DIR,'assets'),path.join(serverDirectory,'assets'),'junction');
  fs.cpSync(path.join(root,'shared'),path.join(sandbox.directory,'resources','shared'),{recursive:true});
  fs.copyFileSync(path.join(root,'release-manifest.json'),path.join(sandbox.directory,'resources','release-manifest.json'));
  fs.writeFileSync(path.join(serverDirectory,'distribution.json'),'{"collector":false}');
  const bootstrap = path.join(serverDirectory,'widget-binding-fixture-bootstrap.cjs');
  fs.writeFileSync(bootstrap, `
const fs=require('node:fs');require('./server.js');
const fixture=()=>JSON.parse(fs.readFileSync(${JSON.stringify(runtimeFile)},'utf8'));
const timer=setInterval(()=>{
 if(!global.dataEngine || !global.wsServer)return;
 global.dataEngine.getPointRuntimeValues=(deviceId,points=[],factoryId)=>{
  const state=fixture(),at=Date.now(),owned=state.devices.some(device=>device.id===deviceId) && (!factoryId || factoryId===state.factoryId);
  return {sourceMode:'owned-fixture-readonly',snapshotTimestamp:at,deviceStatus:{deviceId,quality:owned?'good':'bad',online:owned,lastReadAt:at},
   points:points.map(point=>{const sample=state.readings[String(point.id)],valid=owned && sample?.deviceId===deviceId;return {...point,id:String(point.id),device_id:deviceId,value:valid?sample.value:null,quality:valid?sample.quality:'bad',lastReadAt:at}})};
 };
 const state=fixture(),at=Date.now();
 global.wsServer.broadcastDeviceData(state.devices.map(device=>{
  const analog={},quality={},pointMeta={};for(const sample of Object.values(state.readings).filter(row=>row.deviceId===device.id)){analog[sample.role]=sample.value;quality[sample.role]=sample.quality;pointMeta['analog.'+sample.role]={lastReadAt:at,quality:sample.quality}};
  return {furnace_id:device.id,furnace_name:device.name,timestamp:at,status:{running:true,alarm:false},analog,quality:{device:'good',analog:quality},pointMeta};
 }));
},250);timer.unref();
`);
  const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
  if (port === 3001) throw new Error('Refusing the commissioned backend port');
  backend = startLoggedProcess(process.execPath,[bootstrap],{cwd:serverDirectory,env:{...sandbox.env,NODE_PATH:path.join(BACKEND_DIR,'node_modules'),PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST || path.join(root,'frontend','dist')},logFile:path.join(sandbox.directory,'backend.log')});
  await waitForOwnedBackend(origin,backend); await createSmokeSession(origin,sandbox);
  const info = {origin,sourceOrigin,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,factoryId:line.factory_id,devices,points,events,backendPid:backend.pid,collectorFalse:true,noPhysicalPLC:true,runtimeFile};
  const infoFile = requireTestPath(process.env.WIDGET_BINDING_UI_INFO_FILE || path.join(root,'output','widget-binding-workflow-ui-server.json'));
  fs.writeFileSync(infoFile,JSON.stringify(info,null,2)); console.log(JSON.stringify(info,null,2));
  backend.once('exit',code=>{console.error('Owned backend exited',code);source.closeAllConnections();source.close();process.exit(code || 1)});
})().catch(async error=>{console.error(error);await stopOwnedSmokeProcess(backend);source?.closeAllConnections();source?.close();process.exit(1)});
