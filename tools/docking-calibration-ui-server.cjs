const fs=require('node:fs'),path=require('node:path'),Database=require('../backend/node_modules/better-sqlite3');
const {getBuiltinModels}=require('../backend/services/builtinModels');
const {createSmokeSandbox,createSmokeSession,stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {BACKEND_DIR,findFreePort,startLoggedProcess,waitForOwnedBackend,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
let backend;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await stopOwnedSmokeProcess(backend);process.exit(0)});
(async()=>{
 const root=path.resolve(__dirname,'..'),sandbox=await createSmokeSandbox('docking-calibration-ui');sandbox.password='Docking-'+require('node:crypto').randomBytes(16).toString('hex')+'!';
 const d=new Database(sandbox.filename),definitions=[['docking_fixed','cad_air_cooling_table_115800ht','固定设备'],['docking_cart','cad_transfer_cart_101300','转运小车']];
 for(const [id,source,name] of definitions){const model=getBuiltinModels().find(m=>m.id===source),metadata=JSON.parse(model.metadata||'{}');metadata.loadingPorts={version:1,inlet:{position:[0,1,1],direction:[0,0,1],nodeName:''},outlet:{position:[0,.8,-1],direction:[0,0,-1],nodeName:''}};d.prepare('INSERT INTO models (id,name,file_path,default_scale,metadata,placement_level,asset_type) VALUES (?,?,?,?,?,?,?)').run(id,name,model.file_path,model.default_scale||1,JSON.stringify(metadata),'device','model')}
 d.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify({version:1,sceneUnitsPerMeter:1,lanes:[{id:'dock_lane',offsetZ:-8,length:60}],rails:[{id:'dock_rail',offsetZ:0,length:60}]}),'line_a');
 const insert=d.prepare('INSERT INTO devices (id,name,model_type,line_id,coordinate_space,pos_x,pos_y,pos_z,rotation_y,scale,instance_config,plc_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
 insert.run('docking_ui_target','校准工位设备','docking_fixed','line_a','line_local',10,0,-8,0,1,JSON.stringify({laneId:'dock_lane',laneLineId:'line_a',stationNumber:1,preserve:{test:true}}),0);
 insert.run('docking_ui_cart','校准转运小车','docking_cart','line_a','line_local',2,0,0,0,1,JSON.stringify({railId:'dock_rail',railLineId:'line_a',role:'auxiliary',preserve:{cart:true}}),0);
 d.close();const port=await findFreePort(),origin=`http://127.0.0.1:${port}`;
 backend=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...sandbox.env,HOST:'127.0.0.1',PORT:String(port),FRONTEND_DIST:process.env.UI_FRONTEND_DIST||path.join(root,'frontend/dist')},logFile:path.join(sandbox.directory,'backend.log')});
 await waitForOwnedBackend(origin,backend);await createSmokeSession(origin,sandbox);
 const info={origin,username:'admin',password:sandbox.password,database:sandbox.filename,backendPid:backend.pid,deviceId:'docking_ui_target',cartId:'docking_ui_cart',modelId:'docking_fixed',directory:sandbox.directory};fs.writeFileSync(requireTestPath(process.env.DOCKING_UI_INFO_FILE),JSON.stringify(info,null,2));console.log(JSON.stringify({origin,directory:sandbox.directory}));backend.once('exit',code=>process.exit(code||1))
})().catch(async error=>{console.error(error);await stopOwnedSmokeProcess(backend);process.exit(1)});
