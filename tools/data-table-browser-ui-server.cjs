// Private collector:false browser fixture. All data, HTTP records and runtime
// frames below belong to this test; no physical PLC, Unity or installed DB.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForOwnedBackend, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { getBuiltinModels } = require('../backend/services/builtinModels');
let backend, source;
async function stop() { await stopOwnedSmokeProcess(backend); source?.close(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
(async () => {
  const root = path.resolve(__dirname, '..'), sandbox = await createSmokeSandbox('data-table-browser-ui');
  sandbox.password = `DataBrowse-${crypto.randomBytes(18).toString('hex')}!`;
  const db = new Database(sandbox.filename), firstLine = db.prepare('SELECT l.id,l.name,w.name workshopName,w.factory_id FROM lines l JOIN workshops w ON w.id=l.workshop_id ORDER BY l.id LIMIT 1').get();
  if (!firstLine) throw new Error('Private fixture requires an owned line');
  const model = getBuiltinModels().find(m => m.id === 'pit_furnace_2_v1');
  if (!model) throw new Error('Private fixture requires packaged part metadata');
  db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run();
  db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run('browse_fixture_model', '数据浏览炉型', model.file_path, model.metadata, 'device', 'model');
  const devices = [];
  for (let index = 1; index <= 27; index++) {
    const id = `BrowseDevice${String(index).padStart(2, '0')}`, name = `${String(index).padStart(2, '0')}# 浏览验收炉`;
    db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,instance_config,sort_order) VALUES(?,?,?,?,?,?,?)').run(id, name, firstLine.id, 'browse_fixture_model', 0, '{}', index); devices.push({ id, name });
  }
  const points = {};
  for (const [key, label, type, tag, access] of [['temp','炉内温度','REAL','DB1.DBD0','READ'],['ready','推料到位','BOOL','DB1.DBX4.0','READ'],['bad','无效现场读数','REAL','DB1.DBD8','READ'],['write','写入控制','REAL','DB1.DBD12','WRITE']]) {
    points[key] = String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)').run(devices[0].id, key, label, tag, type, key === 'ready' ? 'status' : 'analog', key, 1000, access, 'good').lastInsertRowid);
  }
  db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run(); db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run(); db.close();
  const runtimeFile = requireTestPath(path.join(sandbox.directory, 'runtime-frame-control.json'));
  const state = { pointOffset: 0, valueOffset: 0, delayMs: 0, fail: false };
  fs.writeFileSync(runtimeFile, JSON.stringify({ points, state }));
  const historyBase = Date.now() - 3600000;
  const storedRows = Array.from({ length: 37 }, (_, index) => ({ batch: `批次${String(index + 1).padStart(2,'0')}`, amount: 700 + index, ready: index % 2 === 0, time: new Date(historyBase - (36 - index) * 3600000).toISOString() }));
  source = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/controls' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { Object.assign(state, JSON.parse(body || '{}')); fs.writeFileSync(runtimeFile, JSON.stringify({ points, state })); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ success:true, state })); }); return;
    }
    const reply = () => {
      if (url.pathname === '/failure' || state.fail) { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Owned test source is unavailable'})); return; }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ records: url.pathname === '/empty' ? [] : storedRows.map(row => ({ ...row, amount:row.amount + state.valueOffset })) }));
    };
    state.delayMs && url.pathname === '/records' ? setTimeout(reply, state.delayMs) : reply();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  const serverDirectory = path.join(sandbox.directory, 'resources', 'backend'); fs.mkdirSync(serverDirectory, { recursive:true });
  const { COLLECTOR_FILES } = require('../desktop/scripts/prepare-display-distribution.cjs');
  for (const name of ['server.js','services','db','routes','utils','middleware']) fs.cpSync(path.join(BACKEND_DIR,name),path.join(serverDirectory,name),{recursive:true,filter:file=>!COLLECTOR_FILES.includes(path.basename(file))});
  fs.symlinkSync(path.join(BACKEND_DIR,'assets'),path.join(serverDirectory,'assets'),'junction');
  fs.cpSync(path.join(root,'shared'),path.join(sandbox.directory,'resources','shared'),{recursive:true});
  fs.copyFileSync(path.join(root,'release-manifest.json'),path.join(sandbox.directory,'resources','release-manifest.json'));
  fs.writeFileSync(path.join(serverDirectory,'distribution.json'),' {"collector":false}');
  const bootstrap = path.join(serverDirectory,'browse-fixture-bootstrap.cjs');
  fs.writeFileSync(bootstrap, `const fs=require('node:fs');require('./server.js');const timer=setInterval(()=>{if(!global.dataEngine)return;global.dataEngine.getPointRuntimeValues=(deviceId,points,factoryId)=>{const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(runtimeFile)},'utf8')),at=Date.now();return {sourceMode:'owned-fixture-readonly',snapshotTimestamp:at,deviceStatus:{quality:'good',online:true,lastReadAt:at},points:points.map(point=>({...point,id:String(point.id),device_id:deviceId,value:String(point.id)===fixture.points.temp?501+fixture.state.pointOffset:String(point.id)===fixture.points.ready?false:80808,quality:String(point.id)===fixture.points.bad?'bad':'good',lastReadAt:at}))}};clearInterval(timer);},10);timer.unref();`);
  const port = await findFreePort(), origin=`http://127.0.0.1:${port}`;
  backend=startLoggedProcess(process.execPath,[bootstrap],{cwd:serverDirectory,env:{...sandbox.env,NODE_PATH:path.join(BACKEND_DIR,'node_modules'),PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST||path.join(root,'frontend','dist')},logFile:path.join(sandbox.directory,'backend.log')});
  await waitForOwnedBackend(origin,backend); await createSmokeSession(origin,sandbox);
  const info={origin,sourceOrigin,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,factoryId:firstLine.factory_id,devices,points,historyStart:new Date(historyBase-36*3600000).toISOString(),historyEnd:new Date(historyBase+3600000).toISOString(),backendPid:backend.pid,runtimeFile,sourcePid:process.pid,collectorFalse:true};
  const infoFile=requireTestPath(process.env.DATA_BROWSER_UI_INFO_FILE||path.join(root,'output','data-browser-ui-server.json'));fs.writeFileSync(infoFile,JSON.stringify(info,null,2));console.log(JSON.stringify(info,null,2));
  backend.once('exit',code=>{console.error('Owned backend exited',code);source.close();process.exit(code||1)});
})().catch(async error=>{console.error(error);await stopOwnedSmokeProcess(backend);source?.close();process.exit(1)});
