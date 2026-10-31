// Isolated simulation only. Closing this Unity window stops its own backend.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const Database = require('../backend/node_modules/better-sqlite3');
const WebSocket = require('../backend/node_modules/ws');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..');
const checking = process.argv.includes('--check');
const requestedModel = process.argv.find(arg=>arg.startsWith('--model-id='))?.slice('--model-id='.length);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let backend, unity, socket, origin, shutdownToken;
let stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    socket?.terminate();
    if (unity && unity.exitCode === null) await stopOwnedSmokeProcess(unity);
    if (origin && shutdownToken) {
        try { await fetch(origin + '/api/internal/shutdown', { method:'POST', headers:{'x-shutdown-token':shutdownToken}, signal:AbortSignal.timeout(5000) }); } catch { }
    }
    if (backend && backend.exitCode === null) {
        await Promise.race([new Promise(resolve => backend.once('exit',resolve)),sleep(5000)]);
        if (backend.exitCode === null) await stopOwnedSmokeProcess(backend);
    }
}
async function main() {
    const sandbox = await createSmokeSandbox(requestedModel ? 'cad-motion-demo' : 'multipurpose-motion-demo');
    const db = new Database(sandbox.filename);
    db.prepare("UPDATE settings SET value='300' WHERE `key`='simulation_interval_ms'").run();
    db.prepare("UPDATE factory_settings SET value='300' WHERE `key`='simulation_interval_ms'").run();
    db.prepare("UPDATE factories SET name='多用炉动作演示（模拟数据）'").run();
    const firstDevice = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 1').get().id;
    if (requestedModel) {
        let model;
        const localDb=path.join(root,'backend/data/dev-local/factory.db');
        if(!process.argv.includes('--packaged-model') && fs.existsSync(localDb)) {
            const sourceDb=new Database(localDb,{readonly:true});
            try { model=sourceDb.prepare('SELECT * FROM models WHERE id=?').get(requestedModel); }
            finally { sourceDb.close(); }
        }
        model ||= require('../backend/services/builtinModels').getBuiltinModels().find(item=>item.id===requestedModel);
        if(!model || !model.file_path || !/^\/(uploads|assets)\/models\//.test(model.file_path)) throw new Error('CAD model not found');
        const source=fs.realpathSync(path.resolve(root,'backend','.'+model.file_path));
        const allowedRoots=['uploads/models','assets/models'].map(folder=>path.resolve(root,'backend',folder)+path.sep);
        if(!allowedRoots.some(folder=>source.startsWith(folder))) throw new Error('Invalid model asset path');
        const target=path.join(sandbox.uploadsDir,'models','cad-motion.glb');fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
        db.prepare('INSERT INTO models (id,name,file_path,metadata,default_scale,asset_type,placement_level) VALUES (?,?,?,?,?,?,?)')
            .run(model.id,model.name,'/uploads/models/cad-motion.glb',model.metadata,model.default_scale||1,'model','device');
        db.prepare('DELETE FROM data_points WHERE device_id<>?').run(firstDevice);
        db.prepare('DELETE FROM devices WHERE id<>?').run(firstDevice);
        db.prepare("UPDATE devices SET model_type=?,model_file=NULL,name=?,scale=1,rotation_y=0,instance_config='{}' WHERE id=?")
            .run(model.id,'超声波清洗机 · 动作演示',firstDevice);
    }
    db.close();
    origin = `http://127.0.0.1:${await findFreePort()}`;
    shutdownToken = require('node:crypto').randomBytes(32).toString('hex');
    const backendLog = fs.openSync(path.join(sandbox.directory,'backend.log'),'a');
    backend = spawn(process.execPath,['server.js'],{cwd:path.join(root,'backend'),windowsHide:true,stdio:['ignore',backendLog,backendLog],env:{...sandbox.env, HOST:'127.0.0.1', PORT:new URL(origin).port, DESKTOP_SHUTDOWN_TOKEN:shutdownToken, FRONTEND_DIST:path.join(root,'frontend/dist')}});
    fs.closeSync(backendLog);
    const deadline=Date.now()+120000;
    while(true) {
        if(backend.exitCode!==null) throw new Error('Demo backend exited; inspect '+sandbox.directory);
        try { if((await fetch(origin+'/api/health',{signal:AbortSignal.timeout(2000)})).ok) break; } catch { }
        if(Date.now()>deadline) throw new Error('Demo backend readiness timeout: '+sandbox.directory);
        await sleep(250);
    }
    const session = await createSmokeSession(origin,sandbox);
    const signals = {front:new Set(),middle:new Set()};
    socket = new WebSocket(origin.replace('http:','ws:')+'/ws',{headers:{Cookie:session.cookie}});
    socket.on('message',raw=>{
        const message=JSON.parse(String(raw));
        if(message.type!=='realtime_frame') return;
        const frame=message.payload?.devices?.find(d=>d.furnace_id===firstDevice);
        if(typeof frame?.doors?.front_door_open==='boolean') signals.front.add(frame.doors.front_door_open);
        if(typeof frame?.doors?.middle_door_open==='boolean') signals.middle.add(frame.doors.middle_door_open);
    });
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
    socket.send(JSON.stringify({type:'client_hello',role:'web'}));
    const exe=path.join(root,'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    const log=path.join(sandbox.directory,'unity.log');
    unity=spawn(exe,[...(checking?['-batchmode']:[]),'-force-d3d11','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',log],{cwd:path.dirname(exe),windowsHide:checking,stdio:'ignore',env:{...sandbox.env,DIGITAL_TWIN_BACKEND_HTTP_URL:origin,DIGITAL_TWIN_BACKEND_WEBSOCKET_URL:origin.replace('http:','ws:')+'/ws',DIGITAL_TWIN_ADMIN_URL:origin+'/admin',DIGITAL_TWIN_APPLICATION_CHROME:'false',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'}});
    await authorizeSmokeUnity(origin,unity,session);
    const sceneDeadline=Date.now()+120000;
    while(!fs.existsSync(log)||!fs.readFileSync(log,'utf8').includes('[FactoryRuntime] Native factory ready:')) {
        if(unity.exitCode!==null||Date.now()>sceneDeadline) throw new Error('Demo scene readiness failed: '+log);
        await sleep(300);
    }
    const focused=await fetch(origin+'/api/native-preview/navigate',{method:'POST',headers:{'content-type':'application/json','x-admin-token':sandbox.env.ADMIN_API_TOKEN},body:JSON.stringify({action:'focus',focus:{mode:'device',deviceId:firstDevice}})});
    if(!focused.ok) throw new Error('Demo focus failed: '+focused.status);
    const signalDeadline=Date.now()+25000;
    while(signals.front.size<2||signals.middle.size<2) {
        if(Date.now()>signalDeadline) throw new Error('Simulation did not exercise both door states');
        await sleep(300);
    }
    if (checking) {
        const readLog = () => fs.readFileSync(log, 'utf8');
        const waitForLog = async predicate => {
            const deadline = Date.now() + 45000;
            while (!predicate(readLog())) {
                if (unity.exitCode !== null || Date.now() > deadline) throw new Error('Auth regression timeout: ' + log);
                await sleep(150);
            }
        };
        const sendTicket = ticket => new Promise((resolve, reject) => {
            const pipe = net.createConnection(`\\\\.\\pipe\\HeatTreatmentUnityAuth_${unity.pid}`);
            pipe.setTimeout(3000, () => pipe.destroy(new Error('Auth pipe timeout')));
            pipe.once('error', reject);
            pipe.once('connect', () => pipe.end(JSON.stringify({action:'sync_unity_session',ticket})+'\n'));
            pipe.once('close', hadError => { if (!hadError) resolve(); });
        });
        const headers = {'content-type':'application/json',Origin:origin,'x-admin-request':'1',Cookie:session.cookie,'x-csrf-token':session.csrfToken};
        const ticketReply = await fetch(origin+'/api/admin-auth/native-ticket',{method:'POST',headers,body:'{}'});
        if (!ticketReply.ok) throw new Error('Cannot create regression handoff ticket');
        const {ticket} = await ticketReply.json();
        const before = (readLog().match(/Native factory ready:/g)||[]).length;
        await sendTicket(ticket);
        await waitForLog(text => (text.match(/Native factory ready:/g)||[]).length > before);
        await sendTicket(ticket);
        await waitForLog(text => text.includes('Ignored duplicate native session handoff.'));
        await sendTicket('a'.repeat(64));
        await waitForLog(text => text.includes('Ignored stale handoff; active display session verified.'));
        if (readLog().includes('Shared dashboard login failed:')) throw new Error('Stale ticket interrupted a valid display session');
        // A revoked real session must still fail closed, even after the stale-ticket fix.
        const locked = await fetch(origin+'/api/admin-auth/accounts/logout',{method:'POST',headers,body:'{}'});
        if (!locked.ok) throw new Error('Cannot revoke regression session');
        await sendTicket('b'.repeat(64));
        await waitForLog(text => text.includes('Shared dashboard login failed:'));
    }
    const text=fs.readFileSync(log,'utf8');
    if(/fallback=[1-9]|Exception:|Node not found:/.test(text)) throw new Error('Demo model/bindings reported a runtime problem: '+log);
    const report={success:true,simulation:true,model:requestedModel||'photo_multipurpose_furnace_v6',authReplayChecked:checking,device:firstDevice,frontDoorStates:[...signals.front],middleDoorStates:[...signals.middle],log,directory:sandbox.directory};
    fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    if(checking) await stop();
    else { unity.once('exit',()=>stop()); process.on('SIGINT',()=>stop()); }
}
main().catch(async error=>{console.error(error.stack||error);process.exitCode=1;await stop()});
