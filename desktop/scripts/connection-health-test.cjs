'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {probeCollectorConnection, summarizeCollectorConnection} = require('../connectionHealth.cjs');
function health(extra = {}) {
    return {status:'ok', runtime:{role:'collector', owner:'windows-service', serviceName:'HeatTreatmentCollector'}, db:{connected:true},
        collectorHealth:{state:'healthy', label:'采集正常', lastSampleAgeMs:20},
        components:{displayConnection:{status:'online',clients:1,connectedClients:1,sceneReadyClients:1,ageMs:50}}, ...extra};
}
async function serve(t, handler) {
    const requests = [], server = http.createServer((req, res) => {requests.push({method:req.method, url:req.url, headers:req.headers}); handler(req, res);});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
    const address = `http://127.0.0.1:${server.address().port}`;
    return {requests, address, probe:options => probeCollectorConnection({mode:'client', backendOrigin:address}, options)};
}
test('GET-only real HTTP probe uses typed address and returns compact independent health without credentials', async t => {
    const f = await serve(t, (req, res) => res.end(JSON.stringify(health({db:{connected:true,password:'PRIVATE_FIXTURE'}, version:{license:{enforce:false,privateValue:'PRIVATE_FIXTURE'}}}))));
    const result = await f.probe();
    assert.equal(result.state, 'online'); assert.equal(result.address, f.address); assert.ok(result.latencyMs >= 0); assert.ok(result.checkedAt > 0);
    assert.equal(result.display.status, 'online'); assert.equal(result.collection, '采集正常');
    assert.deepEqual(f.requests.map(req => [req.method,req.url]), [['GET','/api/health']]);
    assert.equal(f.requests[0].headers.authorization, undefined); assert.equal(f.requests[0].headers.cookie, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|privateValue|password/);
});
test('display/local modes do not contact any service or start collection', async t => {
    const f = await serve(t, () => {throw Error('unexpected network');});
    for(const mode of ['display','local']) {
        const result = await probeCollectorConnection({mode,backendOrigin:f.address});
        assert.equal(result.state,'independent'); assert.equal(result.display,null); assert.match(result.message,/不进行 PLC 采集/);
    }
    assert.equal(f.requests.length, 0);
});
test('collector identity is mandatory, independent of an HTTP 200 or simulated data', () => {
    for(const runtime of [null,{role:'display'},{role:'collector',owner:'standalone'},{role:'collector',owner:'windows-service',serviceName:'Other'}])
        assert.equal(summarizeCollectorConnection(health({runtime})).state,'wrong-service');
    assert.equal(summarizeCollectorConnection({status:'ok'}).state,'wrong-service');
});
test('simulation, degraded collection, database failure and license are distinct from transport/display health', () => {
    const simulation = summarizeCollectorConnection(health({collectorHealth:{state:'simulation',label:'模拟演示运行中'}}));
    assert.equal(simulation.state,'simulation'); assert.match(simulation.message,/不代表已连接现场 PLC/);
    const degraded = summarizeCollectorConnection(health({collectorHealth:{state:'degraded',label:'部分采集异常'},collectorFactories:[{mode:'simulation'},{mode:'integrated_plc'}]}));
    assert.equal(degraded.state,'degraded'); assert.match(degraded.message,/模拟演示/); assert.equal(degraded.display.status,'online');
    const database = summarizeCollectorConnection(health({db:{connected:false}})); assert.equal(database.collection,'数据库异常'); assert.equal(database.state,'degraded');
    const license = summarizeCollectorConnection(health({version:{license:{enforce:true,valid:false}}})); assert.equal(license.collection,'等待正式激活'); assert.equal(license.display.status,'online');
    const noDisplay = summarizeCollectorConnection(health({components:{displayConnection:{status:'offline',connectedClients:0,ageMs:null}}}));
    assert.equal(noDisplay.state,'online'); assert.equal(noDisplay.display.status,'offline', 'closing display cannot stop a healthy collector');
    assert.equal(summarizeCollectorConnection(health({components:{}})).display,null);
});
test('malformed/newer telemetry cannot copy arbitrary objects or fake an online peer', () => {
    const result = summarizeCollectorConnection(health({collectorHealth:{state:'healthy',label:{secret:'PRIVATE_FIXTURE'},lastSampleAgeMs:{secret:'PRIVATE_FIXTURE'}},
        components:{displayConnection:{status:{secret:'PRIVATE_FIXTURE'},clients:-1,connectedClients:Infinity,sceneReadyClients:999,ageMs:-3}}}));
    assert.equal(result.collection,'采集状态未知'); assert.equal(result.lastSampleAgeMs,null);
    assert.deepEqual(result.display,{status:'unknown',clients:0,connectedClients:0,sceneReadyClients:0,ageMs:null});
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE/);
    assert.equal(summarizeCollectorConnection(health({components:{displayConnection:{status:'online',connectedClients:0}}})).display.status,'unknown');
});
test('invalid origins reject before networking; no credentials or paths accepted', async () => {
    for(const backendOrigin of ['ftp://localhost','http://USER:TOKEN@localhost','http://localhost/api','http://localhost?token=TOKEN','NOT_URL'])
        await assert.rejects(probeCollectorConnection({mode:'client',backendOrigin}));
});
test('timeout includes response body; old online status is never used after failure', async t => {
    const f = await serve(t, (req, res) => {res.writeHead(200); res.write('{');});
    const start = Date.now(), result = await f.probe({timeoutMs:40});
    assert.equal(result.state,'offline'); assert.equal(result.display,null); assert.equal(result.latencyMs,null); assert.match(result.message,/超时/);
    assert.ok(Date.now() - start < 1500);
});
test('HTTP errors, redirect, invalid JSON, oversized and aborted health responses remain offline', async t => {
    for(const kind of ['http','redirect','json','size','abort']) await t.test(kind, async t => {
        const f = await serve(t, (req, res) => {
            if(kind==='http') {res.writeHead(503);res.end();}
            if(kind==='redirect') {res.writeHead(302,{location:'/other'});res.end();}
            if(kind==='json') res.end('{broken');
            if(kind==='size') res.end('x'.repeat(1024*1024+1));
            if(kind==='abort') {res.writeHead(200);res.write('{');setImmediate(()=>res.destroy());}
        });
        const result = await f.probe(); assert.equal(result.state,'offline'); assert.equal(result.display,null);
        assert.equal(f.requests.length,1,'redirect cannot contact another target');
    });
});
