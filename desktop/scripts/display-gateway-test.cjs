'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WebSocket,WebSocketServer}=require('../../backend/node_modules/ws');
const {startDisplayGateway,gatewayListenError}=require('../displayGateway.cjs');
const {collectorCenterExecutable}=require('../collectorLocation.cjs');
async function fixture(t,{useWorkspaceAssets=false,backendHostname='127.0.0.1',overrideResponse=()=>null}={}){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'display-gateway-'));fs.writeFileSync(path.join(root,'index.html'),'DISPLAY_OWN_UI');fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','app.js'),'DISPLAY_JS');
    const sourceAssets=path.join(root,'workspace-assets');fs.mkdirSync(path.join(sourceAssets,'models'),{recursive:true});fs.mkdirSync(path.join(sourceAssets,'motions'));
    const seen=[],server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push({url:req.url,headers:req.headers,body});
        const response=overrideResponse(req);
        if(response){res.writeHead(response.status,{'content-type':'text/plain'});res.end(response.body);return;}
        res.setHeader('content-type','application/json');res.setHeader('set-cookie','dt_fixture=VALUE; Path=/api; Domain=service.example; Secure; HttpOnly; SameSite=Strict');res.end(JSON.stringify({ok:true,path:req.url,body}));});});
    const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{seen.push({url:req.url,headers:req.headers});ws.on('message',data=>ws.send(data));}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const upstream=`http://${backendHostname}:${server.address().port}`;
    const gateway=await startDisplayGateway({backendOrigin:upstream,frontendDir:root,workspaceAssetRoot:useWorkspaceAssets?sourceAssets:undefined});
    t.after(async()=>{await gateway.close();for(const c of wss.clients)c.terminate();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
    return {root,seen,server,gateway,upstream,sourceAssets};
}
test('display owns static UI; only API/model/upload data reaches the configured collector',async t=>{
    const f=await fixture(t);
    for(const route of ['/','/admin','/overlay','/assets/app.js']){const res=await fetch(f.gateway.origin+route);assert.equal(res.status,200);assert.match(await res.text(),/DISPLAY_/);}
    assert.equal(f.seen.length,0,'collector never serves admin/display UI');
    for(const route of ['/api/health','/uploads/models/a.glb','/assets/models/a.glb','/assets/motions/a.glb']){assert.equal((await fetch(f.gateway.origin+route)).status,200);assert.equal(f.seen.at(-1).url,route);}
    assert.equal(fs.existsSync(path.join(f.root,'data')),false);assert.equal(fs.existsSync(path.join(f.root,'mysql')),false);
});
test('the workspace launcher can read source GLB, previews and motion assets when the local collector returns 404',async t=>{
    const f=await fixture(t,{useWorkspaceAssets:true,overrideResponse:()=>({status:404,body:'COLLECTOR_MISSING'})});
    const model='cad_multipurpose_furnace_082000.glb',glb=Buffer.from('glTF\x02\x00\x00\x00');
    fs.writeFileSync(path.join(f.sourceAssets,'models',model),glb);
    fs.mkdirSync(path.join(f.sourceAssets,'models','预览'));
    fs.writeFileSync(path.join(f.sourceAssets,'models','预览','设备.png'),'PNG_FIXTURE');
    fs.writeFileSync(path.join(f.sourceAssets,'motions','cad.json'),'{"motion":true}');
    const resource=f.gateway.origin+'/assets/models/'+model;
    const res=await fetch(resource+'?v=current');
    assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'model/gltf-binary');assert.equal(res.headers.get('cache-control'),'no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()),glb);
    const head=await fetch(resource,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),glb.length);assert.equal(await head.text(),'');
    assert.equal(await (await fetch(f.gateway.origin+'/assets/models/'+encodeURIComponent('预览')+'/'+encodeURIComponent('设备.png'))).text(),'PNG_FIXTURE');
    assert.deepEqual(await (await fetch(f.gateway.origin+'/assets/motions/cad.json')).json(),{motion:true});
    assert.equal(f.seen.length,4,'every asset first checks the authoritative service');
});
test('local fallback never replaces upstream content, uploads, service errors, private assets or writes',async t=>{
    const f=await fixture(t,{useWorkspaceAssets:true,overrideResponse:req=>{
        if(req.url.endsWith('/present.glb')) return {status:200,body:'UPSTREAM_BYTES'};
        if(req.url.endsWith('/service-error.glb')) return {status:503,body:'UPSTREAM_OFFLINE'};
        if(req.url.endsWith('/forbidden.glb')) return {status:403,body:'UPSTREAM_FORBIDDEN'};
        return {status:404,body:'COLLECTOR_MISSING'};
    }});
    for(const filename of ['present.glb','service-error.glb','forbidden.glb','local.glb','working.blend'])
        fs.writeFileSync(path.join(f.sourceAssets,'models',filename),'WORKSPACE_BYTES');
    fs.writeFileSync(path.join(f.root,'outside.glb'),'OUTSIDE');
    fs.symlinkSync(f.root,path.join(f.sourceAssets,'models','escape'),process.platform==='win32'?'junction':'dir');
    const requests=[
        ['/assets/models/present.glb',200,'UPSTREAM_BYTES'],
        ['/assets/models/service-error.glb',503,'UPSTREAM_OFFLINE'],
        ['/assets/models/forbidden.glb',403,'UPSTREAM_FORBIDDEN'],
        ['/uploads/models/local.glb',404,'COLLECTOR_MISSING'],
        ['/assets/models/missing.glb',404,'COLLECTOR_MISSING'],
        ['/assets/models/working.blend',404,'COLLECTOR_MISSING'],
        ['/assets/models/escape/outside.glb',404,'COLLECTOR_MISSING'],
        ['/assets/models/local.glb',404,'COLLECTOR_MISSING',{method:'POST'}]
    ];
    for(const [route,status,body,options] of requests){const response=await fetch(f.gateway.origin+route,options);assert.equal(response.status,status,route);assert.equal(await response.text(),body,route);}
    assert.equal((await fetch(f.gateway.origin+'/assets/models/local.glb',{headers:{Origin:'http://unrelated.example'}})).status,403);
});
test('without explicit workspace assets a model 404 stays a 404; no implicit release or packaged fallback',async t=>{
    const f=await fixture(t,{overrideResponse:()=>({status:404,body:'COLLECTOR_MISSING'})});
    fs.writeFileSync(path.join(f.sourceAssets,'models','local.glb'),'WORKSPACE');
    const response=await fetch(f.gateway.origin+'/assets/models/local.glb');
    assert.equal(response.status,404);assert.equal(await response.text(),'COLLECTOR_MISSING');
});
test('a configured remote collector stays authoritative even in workspace mode',async t=>{
    const request=http.request;
    // Keep the remote-host policy realistic without contacting an external host.
    t.mock.method(http,'request',(url,options,callback)=>{
        assert.equal(url.hostname,'collector.example');
        return request(url,{...options,lookup:(hostname,hints,done)=>{
            assert.equal(hostname,'collector.example');
            if(hints.all) done(null,[{address:'127.0.0.1',family:4}]);
            else done(null,'127.0.0.1',4);
        }},callback);
    });
    const f=await fixture(t,{useWorkspaceAssets:true,backendHostname:'collector.example',
        overrideResponse:()=>({status:404,body:'REMOTE_MISSING'})});
    fs.writeFileSync(path.join(f.sourceAssets,'models','local.glb'),'WORKSPACE');
    const response=await fetch(f.gateway.origin+'/assets/models/local.glb');
    assert.equal(response.status,404);assert.equal(await response.text(),'REMOTE_MISSING');
    assert.equal(f.seen[0].headers.host,new URL(f.upstream).host);
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


async function configFixture(t) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'display-port-recovery-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(path.join(root,'index.html'),'DISPLAY_OWN_UI');
    const portFile=path.join(root,'ui-gateway.json');
    return {root,portFile,start:()=>startDisplayGateway({backendOrigin:'http://127.0.0.1:3001',frontendDir:root,portFile})};
}
test('stable saved UI port is reused; occupied port switches but gates UI/WS until state recovery',async t=>{
    const f=await configFixture(t),first=await f.start(),origin=first.origin;await first.close();
    const second=await f.start();t.after(()=>second.close());assert.equal(second.origin,origin);
    const recovered=await f.start();t.after(()=>recovered.close());assert.notEqual(recovered.origin,origin);
    assert.deepEqual(recovered.originMigration,{fromOrigin:origin,toOrigin:recovered.origin});
    assert.equal((await fetch(recovered.origin+'/admin')).status,503);
    assert.equal((await fetch(recovered.origin+'/api/health')).status,503);
    const ws=new WebSocket(recovered.origin.replace('http:','ws:')+'/ws');
    await new Promise(resolve=>ws.once('error',resolve));assert.notEqual(ws.readyState,WebSocket.OPEN);
    assert.equal((await fetch(origin+'/admin')).status,200,'old owner stays alive');
    const pending=JSON.parse(fs.readFileSync(f.portFile));assert.equal(pending.pendingOriginMigration.fromPort,Number(new URL(origin).port));
    assert.equal(fs.readdirSync(path.join(f.root,'recovery')).length,1);
    await recovered.completeOriginMigration();assert.equal((await fetch(recovered.origin+'/admin')).status,200);
    assert.equal(JSON.parse(fs.readFileSync(f.portFile)).pendingOriginMigration,undefined);
    const nextOrigin=recovered.origin;await recovered.close();const restart=await f.start();t.after(()=>restart.close());assert.equal(restart.origin,nextOrigin);
});
test('saved EACCES retries by binding port zero directly; original config backed up',async t=>{
    const f=await configFixture(t),saved=JSON.stringify({version:1,port:64974});fs.writeFileSync(f.portFile,saved);
    const server=http.createServer(),original=server.listen,baselineListening=server.listenerCount('listening');let attempts=0;
    t.mock.method(server,'listen',function(port,host){
        assert.equal(host,'127.0.0.1');attempts++;
        if(attempts===1){assert.equal(port,64974);process.nextTick(()=>this.emit('error',Object.assign(new Error('denied'),{code:'EACCES'})));return this;}
        assert.equal(port,0);return original.call(this,port,host);
    });
    t.mock.method(http,'createServer',()=>server);
    const gateway=await f.start();t.after(()=>gateway.close());assert.equal(attempts,2);
    assert.equal(server.listenerCount('listening'),baselineListening,'failed listen has no stale callback');
    assert.equal(gateway.originMigration.fromOrigin,'http://127.0.0.1:64974');
    assert.equal(fs.readFileSync(path.join(f.root,'recovery',fs.readdirSync(path.join(f.root,'recovery'))[0]),'utf8'),saved);
    await gateway.completeOriginMigration();assert.equal(JSON.parse(fs.readFileSync(f.portFile)).port,Number(new URL(gateway.origin).port));
});
test('pending recovery survives restart and repeated collision retains ORIGINAL draft source',async t=>{
    const f=await configFixture(t),owner=await f.start();t.after(()=>owner.close());
    const first=await f.start(),migration=first.originMigration;await first.close();
    const resumed=await f.start();assert.deepEqual(resumed.originMigration,migration);await resumed.close();
    const blocker=http.createServer((req,res)=>res.end('unrelated'));await new Promise(r=>blocker.listen(Number(new URL(migration.toOrigin).port),'127.0.0.1',r));t.after(()=>new Promise(r=>blocker.close(r)));
    const retry=await f.start();t.after(()=>retry.close());assert.equal(retry.originMigration.fromOrigin,owner.origin);
    assert.notEqual(retry.origin,migration.toOrigin);assert.equal((await fetch(retry.origin)).status,503);
});
test('config corruption and malformed pending records fail without overwriting',async t=>{
    const f=await configFixture(t);
    for(const invalid of ['malformed',JSON.stringify({version:1,port:12000,pendingOriginMigration:null}),
        JSON.stringify({version:1,port:12000,pendingOriginMigration:{fromPort:12001,toPort:12002}}),
        JSON.stringify({version:1,port:12000,pendingOriginMigration:false})]){
        fs.writeFileSync(f.portFile,invalid);await assert.rejects(f.start());assert.equal(fs.readFileSync(f.portFile,'utf8'),invalid);
    }
});
test('migration acknowledgement refuses a concurrently changed config and keeps business UI gated',async t=>{
    const f=await configFixture(t),owner=await f.start();t.after(()=>owner.close());
    const gateway=await f.start();t.after(()=>gateway.close());const changed='{"version":1,"port":18082}';fs.writeFileSync(f.portFile,changed);
    await assert.rejects(gateway.completeOriginMigration(),/其他操作/);assert.equal(fs.readFileSync(f.portFile,'utf8'),changed);
    assert.equal((await fetch(gateway.origin)).status,503);
});
test('unknown listen error does not fallback or change original config; exhausted fallback is bounded',async t=>{
    const f=await configFixture(t),saved=JSON.stringify({version:1,port:64974});fs.writeFileSync(f.portFile,saved);
    const server=http.createServer(),baselineListening=server.listenerCount('listening'),baselineErrors=server.listenerCount('error');let attempts=0,code='EIO';
    t.mock.method(server,'listen',function(){attempts++;process.nextTick(()=>this.emit('error',Object.assign(new Error(code),{code})));return this;});
    t.mock.method(http,'createServer',()=>server);
    await assert.rejects(f.start(),{code:'EIO'});assert.equal(attempts,1);assert.equal(fs.readFileSync(f.portFile,'utf8'),saved);
    code='EACCES';attempts=0;await assert.rejects(f.start(),{code:'DISPLAY_UI_PORT_DENIED'});
    assert.equal(attempts,4);assert.equal(server.listenerCount('listening'),baselineListening);assert.equal(server.listenerCount('error'),baselineErrors);
    assert.equal(fs.readFileSync(f.portFile,'utf8'),saved);
    const denied=Object.assign(new Error('denied'),{code:'EACCES'});assert.equal(gatewayListenError(denied,64974).cause,denied);
});
