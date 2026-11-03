// Owned isolated fixture for production-line selection and coordinated motion checks.
const fs=require('node:fs'),path=require('node:path');
const Database=require('../backend/node_modules/better-sqlite3');
const {CATALOG}=require('../backend/services/cadEquipmentModels');
const {createSmokeSandbox,createSmokeSession,stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {BACKEND_DIR,findFreePort,startLoggedProcess,waitForHttp,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
let backend;
async function stop(){await stopOwnedSmokeProcess(backend);process.exit(0)}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
(async()=>{
 const sandbox=await createSmokeSandbox('line-simulation-ui');sandbox.password='Line-Simulation-Isolated-Only-20261103!';
 const db=new Database(sandbox.filename),ws=db.prepare('SELECT id FROM workshops ORDER BY id LIMIT 1').get();
 const layout=JSON.stringify({version:2,transform:{x:0,y:0,z:0,rotationY:0},placementPending:false});
 for(const [id,name] of [['simulation_line_a','模拟验证产线 A'],['simulation_line_b','模拟验证产线 B']])db.prepare('INSERT INTO lines (id,name,workshop_id,layout_json) VALUES (?,?,?,?)').run(id,name,ws.id,layout);
 const insert=db.prepare('INSERT INTO devices (id,name,line_id,model_type,pos_x,pos_y,pos_z,rotation_y,scale,coordinate_space,instance_config,plc_enabled,sort_order) VALUES (?,?,?,?,?,0,?,0,1,?,?,0,?)');
 CATALOG.forEach((model,index)=>insert.run('sim_'+index,model.family+'实例 A','simulation_line_a',model.id,index*6,index%2*3,'line_local','{}',index));
 insert.run('sim_cleaner_peer','清洗机实例 B','simulation_line_a','cad_cleaner_170700',42,0,'line_local','{}',7);
 insert.run('sim_other_cart','备用料车实例','simulation_line_a','cad_transfer_cart_101300',-6,0,'line_local','{}',8);
 insert.run('sim_b_cleaner','B 线清洗机','simulation_line_b','cad_cleaner_170700',0,0,'line_local','{}',0);
 insert.run('sim_temper','回火炉实例','simulation_line_a','cad_tempering_furnace_091300',48,0,'line_local','{}',9);
 insert.run('sim_legacy','原清洗机实例','simulation_line_b','ultrasonic_cleaner_cad',10,0,'line_local','{}',1);
 db.close();
 const port=await findFreePort(3958),origin=`http://127.0.0.1:${port}`;
 backend=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...sandbox.env,PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:path.resolve(__dirname,'../frontend/dist')},logFile:path.join(sandbox.directory,'backend.log')});
 await waitForHttp(origin+'/api/health');await createSmokeSession(origin,sandbox);
 const info={origin,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,backendPid:backend.pid,supervisorPid:process.pid};
 const filename=requireTestPath(process.env.LINE_SIMULATION_UI_INFO_FILE||path.resolve(__dirname,'../output/line-simulation-server.json'));fs.writeFileSync(filename,JSON.stringify(info,null,2));
 console.log(JSON.stringify({origin,directory:sandbox.directory,backendPid:backend.pid,supervisorPid:process.pid}));backend.once('exit',code=>process.exit(code||1));
})().catch(async e=>{console.error(e);await stopOwnedSmokeProcess(backend);process.exitCode=1});
