'use strict';
// Durable preferences, not browser cache. Only owned backends/databases are restarted.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('better-sqlite3');
const {createSmokeSandbox,stopOwnedSmokeProcess}=require('../../desktop/scripts/smoke-sandbox.cjs');
const {BACKEND_DIR,findFreePort,startLoggedProcess,waitForHttp,waitForExit,waitUntil}=require('./integration-test-utils.cjs');
let server;
(async()=>{
  const sandbox=await createSmokeSandbox('collector-mode-persistence'),db=new Database(sandbox.filename);
  db.prepare('UPDATE devices SET plc_enabled=0').run(); // Never contact any PLC endpoint.
  db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
  db.prepare('INSERT INTO factories(id,name) VALUES(?,?)').run('mode_factory_b','独立工厂');
  db.prepare('INSERT INTO factory_settings(factory_id,`key`,value) VALUES(?,?,?)').run('mode_factory_b','data_mode','external');
  const globalMode=db.prepare("SELECT value FROM settings WHERE `key`='data_mode'").get().value;db.close();
  const port=await findFreePort(),origin=`http://127.0.0.1:${port}`,shutdown=crypto.randomBytes(32).toString('hex');let launches=0;
  const api=async(route,method='GET',body,factoryId='factory_default',expected=200)=>{
    const response=await fetch(origin+'/api'+route,{method,headers:{'Content-Type':'application/json','X-Admin-Token':sandbox.env.ADMIN_API_TOKEN,'X-Factory-ID':factoryId},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
  };
  const status=(id='factory_default')=>api('/collector/status','GET',undefined,id);
  async function start(){server=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...sandbox.env,PORT:String(port),HOST:'127.0.0.1',DESKTOP_SHUTDOWN_TOKEN:shutdown},logFile:path.join(sandbox.directory,`backend-${++launches}.log`)});await waitForHttp(origin+'/api/health');await waitUntil(async()=>{const s=await status();return s.processRunning&&s.factories[0]?.mode===s.configuredMode},30000,'collector restored from persisted preference')}
  async function stop(){const response=await fetch(origin+'/api/internal/shutdown',{method:'POST',headers:{'X-Shutdown-Token':shutdown}});assert.equal(response.status,202);assert.equal(await waitForExit(server,15000),0);server=null}
  async function choose(mode,id='factory_default'){
    const previous=(await status(id)).configuredMode;
    const saved=await api('/collector/mode','PUT',{mode,expectedMode:previous},id);assert.equal(saved.success,true);assert.equal(saved.mode,mode);
    await waitUntil(async()=>{const result=await status(id);return result.configuredMode===mode&&result.factories[0]?.mode===mode},10000,'persisted preference applied by worker');
  }
  await start();await choose('simulation','mode_factory_b');
  const verified=[];
  for(const mode of ['simulation','external','integrated_plc']){
    await choose(mode);await stop();
    const disk=new Database(sandbox.filename,{readonly:true});
    assert.equal(disk.prepare('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?').get('factory_default','data_mode').value,mode);
    assert.equal(disk.prepare('SELECT value FROM settings WHERE `key`=?').get('data_mode').value,globalMode);assert.equal(disk.pragma('quick_check',{simple:true}),'ok');disk.close();
    await start();const restored=await status();assert.equal(restored.configuredMode,mode);assert.equal(restored.factories[0].mode,mode);
    const other=await waitUntil(async()=>{const s=await status('mode_factory_b');return s.factories[0]?.mode==='simulation'&&s},10000,'other factory restored');assert.equal(other.configuredMode,'simulation');assert.equal(other.factories[0].mode,'simulation');
    verified.push(mode);console.log(`PASS ${mode}: saved, service closed, same database reopened, UI preference and worker mode restored`);
  }
  await api('/collector/mode','PUT',{mode:'external',expectedMode:'simulation'},'factory_default',409);
  assert.equal((await status()).configuredMode,'integrated_plc','stale choices never overwrite persisted mode');await stop();
  fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify({success:true,verified,launches,perFactory:true,globalUntouched:true,noPlcConnections:true},null,2));console.log(sandbox.directory);
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await stopOwnedSmokeProcess(server)});
