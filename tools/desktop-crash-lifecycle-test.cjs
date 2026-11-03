'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const {createSmokeSandbox,stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {waitUntil,sleep}=require('../backend/scripts/integration-test-utils.cjs');
let desktop;const owned=new Set();
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
function processes(){
 const ps="$ProgressPreference='SilentlyContinue';$env:PSModulePath=(Join-Path $PSHOME 'Modules');@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('HeatTreatmentDigitalTwin.exe','HeatTreatmentAdminHost.exe','node.exe')} | Select-Object ProcessId,ParentProcessId,Name,CommandLine)|ConvertTo-Json -Compress";
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000}));return Array.isArray(result)?result:[result];
}
(async()=>{
 const sandbox=await createSmokeSandbox('desktop-crash-lifecycle'),root=path.resolve(__dirname,'..');
 const Database=require('../backend/node_modules/better-sqlite3'),db=new Database(sandbox.filename);
 db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();db.close();
 desktop=spawn(path.join(root,'desktop/node_modules/electron/dist/electron.exe'),[path.join(root,'desktop/main.cjs')],{cwd:path.join(root,'desktop'),windowsHide:true,stdio:'ignore',env:{...sandbox.env,NATIVE_CLIENT_SMOKE_MODE:'true',DESKTOP_SMOKE_EXIT_AFTER_MS:'100000'}});
 let unity,api,host;
 await waitUntil(()=>{const rows=processes();unity=rows.find(p=>p.Name==='HeatTreatmentDigitalTwin.exe'&&p.ParentProcessId===desktop.pid);api=rows.find(p=>p.Name==='node.exe'&&p.ParentProcessId===desktop.pid&&p.CommandLine.includes('server.js'));host=unity&&rows.find(p=>p.Name==='HeatTreatmentAdminHost.exe'&&p.ParentProcessId===unity.ProcessId);return unity&&api&&host;},60000,'isolated Unity/API/native host',500);
 for(const p of [unity,api,host])owned.add(p.ProcessId);await sleep(5000);
 const oldHost=host.ProcessId;process.kill(oldHost,'SIGKILL');
 await waitUntil(()=>{host=processes().find(p=>p.Name==='HeatTreatmentAdminHost.exe'&&p.ProcessId!==oldHost&&p.CommandLine.includes(`--parent-pid ${unity.ProcessId}`));return host;},25000,'desktop automatically restores failed host',500);
 owned.add(host.ProcessId);assert.ok(alive(unity.ProcessId));assert.ok(alive(api.ProcessId));
 process.kill(desktop.pid,'SIGKILL');
 await waitUntil(()=>![unity.ProcessId,api.ProcessId,host.ProcessId].some(alive),20000,'no owned Unity/API/native host orphan after desktop crash',300);
 const result={success:true,hostAutomaticallyRestored:true,unityNotRestarted:true,apiNotRestarted:true,noOrphansAfterMainCrash:true,directory:sandbox.directory};
 fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
 await stopOwnedSmokeProcess(desktop);
 for(const pid of owned)if(alive(pid))try{execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}
});
