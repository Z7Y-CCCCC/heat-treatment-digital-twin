'use strict';
// Self-owned display-only fixture. Frames are injected directly into this test
// process's WebSocket server; no collector, PLC, installed service or site data.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const Database = require('../backend/node_modules/better-sqlite3');
const { createSmokeSandbox, createSmokeSession } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, waitForHttp, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
(async () => {
    const sandbox = await createSmokeSandbox('motion-authoring-ui'); sandbox.password = 'MotionAuthor-Isolated-20261104!';
    const db = new Database(sandbox.filename), line = db.prepare('SELECT id FROM lines LIMIT 1').get().id;
    db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run();
    db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run(); db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    const modelId = 'motion_authoring_fixture';
    db.prepare('INSERT INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run(modelId,'备料台 · 自定义动作','/assets/models/cad_fixed_load_table_112200.glb','{"inspection":{"enabled":false},"preserve":"fixture"}','device','model');
    for (const id of ['author_device', 'author_peer']) db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,instance_config) VALUES(?,?,?,?,?,?)').run(id,id==='author_device'?'备料台 · 动作验收':'备料台 · 独立实例',line,modelId,0,'{"inspection":{"enabled":false}}');
    const pointId = String(db.prepare("INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)").run('author_device','stroke','行程反馈','DB1.DBD0','REAL','analog','stroke',100,'READ','good').lastInsertRowid); db.close();
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env,sandbox.env,{PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:path.resolve(__dirname,'../frontend/dist')});
    require('../backend/server.js'); await waitForHttp(origin+'/api/health'); const session = await createSmokeSession(origin,sandbox);
    let value = 0, offline = false, paused = false;
    const control = http.createServer((req,res) => { let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{try{const body=JSON.parse(raw||'{}');if(body.value!==undefined)value=Number(body.value);if(body.offline!==undefined)offline=!!body.offline;if(body.paused!==undefined)paused=!!body.paused;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value,offline,paused}))}catch{res.statusCode=400;res.end()}}) });
    await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
    setInterval(()=>{if(!paused)global.wsServer?.broadcastDeviceData([{furnace_id:'author_device',timestamp:Date.now(),status:{online:!offline,quality:offline?'bad':'good'},quality:{overall:offline?'bad':'good'},analog:{stroke:value},pointMeta:{'analog.stroke':{id:pointId}}}])},100);
    const info={origin,control:`http://127.0.0.1:${control.address().port}`,modelId,deviceId:'author_device',pointId,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,session,env:sandbox.env};
    fs.writeFileSync(requireTestPath(process.env.MOTION_AUTHORING_INFO_FILE),JSON.stringify(info,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
