'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WebSocket,WebSocketServer}=require('../../backend/node_modules/ws');
const {startDisplayGateway}=require('../displayGateway.cjs');
const {collectorCenterExecutable}=require('../collectorLocation.cjs');
async function fixture(t){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'display-gateway-'));fs.writeFileSync(path.join(root,'index.html'),'DISPLAY_OWN_UI');fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','app.js'),'DISPLAY_JS');
    const seen=[],server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push({url:req.url,headers:req.headers,body});res.setHeader('content-type','application/json');res.setHeader('set-cookie','dt_fixture=VALUE; Path=/api; Domain=service.example; Secure; HttpOnly; SameSite=Strict');res.end(JSON.stringify({ok:true,path:req.url,body}));});});
    const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{seen.push({url:req.url,headers:req.headers});ws.on('message',data=>ws.send(data));}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const upstream=`http://127.0.0.1:${server.address().port}`;
    const gateway=await startDisplayGateway({backendOrigin:upstream,frontendDir:root});
    t.after(async()=>{await gateway.close();for(const c of wss.clients)c.terminate();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
    return {root,seen,server,gateway,upstream};
}
test('display owns static UI; only API/model/upload data reaches the configured collector',async t=>{
    const f=await fixture(t);
    for(const route of ['/','/admin','/overlay','/assets/app.js']){const res=await fetch(f.gateway.origin+route);assert.equal(res.status,200);assert.match(await res.text(),/DISPLAY_/);}
    assert.equal(f.seen.length,0,'collector never serves admin/display UI');
    for(const route of ['/api/health','/uploads/models/a.glb','/assets/models/a.glb','/assets/motions/a.glb']){assert.equal((await fetch(f.gateway.origin+route)).status,200);assert.equal(f.seen.at(-1).url,route);}
    assert.equal(fs.existsSync(path.join(f.root,'data')),false);assert.equal(fs.existsSync(path.join(f.root,'mysql')),false);
});
test('API forwarding preserves body/CSRF/cookies, rejects foreign Origin and Host, and cannot control service shutdown',async t=>{
    const f=await fixture(t),url=f.gateway.origin+'/api/example';
    let res=await fetch(url,{method:'POST',headers:{Origin:f.gateway.origin,'x-csrf-token':'FIXTURE_CSRF',Cookie:'dt_fixture=VALUE','content-type':'application/json'},body:'{"same":true}'});
    assert.equal(res.status,200);assert.equal(f.seen[0].headers.origin,f.upstream);assert.equal(f.seen[0].headers['x-csrf-token'],'FIXTURE_CSRF');assert.equal(f.seen[0].headers.cookie,'dt_fixture=VALUE');assert.equal(f.seen[0].body,'{"same":true}');
    const cookie=res.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/Domain=|; Secure/);
    res=await fetch(url,{method:'POST',headers:{Origin:'http://malicious.example'}});assert.equal(res.status,403);assert.equal(f.seen.length,1);
    const wrongHost=await new Promise((resolve,reject)=>{const req=http.get(url,{headers:{Host:'malicious.example'}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);});assert.equal(wrongHost,403);
    res=await fetch(f.gateway.origin+'/api/internal/shutdown',{method:'POST'});assert.equal(res.status,403);assert.equal(f.seen.length,1);
});
test('real WebSocket frames/auth reach only collector; closing display gateway does not stop collector',async t=>{
    const f=await fixture(t),socket=new WebSocket(f.gateway.origin.replace('http:','ws:')+'/ws',{origin:f.gateway.origin,headers:{Cookie:'dt_fixture=VALUE'}});
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    const message=new Promise(resolve=>socket.once('message',data=>resolve(data.toString())));socket.send('FRAME');assert.equal(await message,'FRAME');
    assert.equal(f.seen[0].headers.origin,f.upstream);assert.equal(f.seen[0].headers.cookie,'dt_fixture=VALUE');
    await f.gateway.close();assert.equal((await fetch(f.upstream+'/api/health')).status,200);
});
test('collector outage stays offline instead of opening another DB or creating simulated values',async t=>{
    const f=await fixture(t);await new Promise(resolve=>f.server.close(resolve));
    const res=await fetch(f.gateway.origin+'/api/health');assert.equal(res.status,503);assert.match((await res.json()).error,/未切换/);
    assert.equal((await fetch(f.gateway.origin+'/admin')).status,200);assert.equal(fs.existsSync(path.join(f.root,'data')),false);
});
test('center discovery ignores the display cache; machine config is authoritative even when installed service files are missing',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'collector-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const env={ProgramData:path.join(root,'machine'),ProgramFiles:path.join(root,'programs')};
    const legacy=path.join(root,'desktop/.cache/collector-center');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'HeatTreatmentCollectorCenter.exe'),'cache');
    assert.throws(()=>collectorCenterExecutable({projectRoot:root,env}),/独立/);
    const runtime=path.join(root,'collector-runtime');fs.mkdirSync(path.join(runtime,'resources/collector-center'),{recursive:true});fs.writeFileSync(path.join(runtime,'resources/collector-center/HeatTreatmentCollectorCenter.exe'),'standalone');fs.writeFileSync(path.join(runtime,'plugin-manifest.json'),'{"product":"collector-plugin"}');
    assert.equal(collectorCenterExecutable({projectRoot:root,env}),path.join(runtime,'resources/collector-center/HeatTreatmentCollectorCenter.exe'));
    const machine=path.join(env.ProgramData,'HeatTreatmentDigitalTwin');fs.mkdirSync(machine,{recursive:true});fs.writeFileSync(path.join(machine,'collector-service.json'),JSON.stringify({resourcesRoot:path.join(root,'missing/resources')}));
    assert.throws(()=>collectorCenterExecutable({projectRoot:root,env}),/独立/,'never fall back to a second runtime');
});

test('display UI origin survives restart; a busy saved port fails visibly instead of losing origin-scoped drafts',async t=>{
    const f=await fixture(t),portFile=path.join(f.root,'profile/ui-gateway.json');
    const first=await startDisplayGateway({backendOrigin:f.upstream,frontendDir:f.root,portFile}),origin=first.origin;await first.close();
    const second=await startDisplayGateway({backendOrigin:f.upstream,frontendDir:f.root,portFile});assert.equal(second.origin,origin);
    await assert.rejects(startDisplayGateway({backendOrigin:f.upstream,frontendDir:f.root,portFile}),/已被占用/);
    await second.close();assert.equal(JSON.parse(fs.readFileSync(portFile)).port,Number(new URL(origin).port));
    fs.writeFileSync(portFile,'malformed');await assert.rejects(startDisplayGateway({backendOrigin:f.upstream,frontendDir:f.root,portFile}));assert.equal(fs.readFileSync(portFile,'utf8'),'malformed');
});
