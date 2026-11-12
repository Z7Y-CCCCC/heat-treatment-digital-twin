'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs'), path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const WsServer = require('../services/wsServer');
const { startDisplayGateway } = require('../../desktop/displayGateway.cjs');
const { probeCollectorConnection } = require('../../desktop/connectionHealth.cjs');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    const end = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < end, 'Timed out waiting for WS state'); await sleep(10); }
}
async function fixture(t, gatewayEnabled = false) {
    const hub = new WsServer();
    // Only an isolated in-memory service; no database/PLC/service configuration.
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/api/health');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status:'ok', runtime:{role:'collector', owner:'windows-service', serviceName:'HeatTreatmentCollector'},
            db:{connected:true}, collectorHealth:{state:'simulation', label:'模拟演示运行中'}, components:{displayConnection:hub.connectionHealth()} }));
    });
    hub.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let gateway = null; const sockets = [];
    t.after(async () => {
        for (const socket of sockets) socket.terminate();
        await gateway?.close(); hub.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(hub.heartbeatTimer, null); assert.equal(hub.lastCommunicationByRole.size, 0);
    });
    if(gatewayEnabled) {
        const frontendDir = createRunDirectory('display-health-gateway');
        fs.writeFileSync(path.join(frontendDir,'index.html'),'isolated health test');
        gateway = await startDisplayGateway({backendOrigin:origin, frontendDir});
    }
    async function connect(role) {
        const socket = new WebSocket((gateway?.origin || origin).replace('http:', 'ws:') + '/ws'); sockets.push(socket);
        await once(socket, 'open');
        socket.send(JSON.stringify({type:'client_hello', role}));
        await until(() => [...hub.clients].some(peer => peer.clientRole === role));
        return socket;
    }
    return {hub, server, origin, gateway, connect};
}
test('HTTP probes and admin/web sockets are not display clients; native hello, scene loading and reconnect are independent', async t => {
    const f = await fixture(t), probe = () => probeCollectorConnection({mode:'client', backendOrigin:f.origin});
    assert.equal((await probe()).display.status, 'offline');
    const web = await f.connect('web'); await f.connect('admin');
    assert.equal((await probe()).display.connectedClients, 0);
    const native = await f.connect('unity');
    let health = (await probe()).display;
    assert.equal(health.status, 'online'); assert.equal(health.connectedClients, 1); assert.equal(health.sceneReadyClients, 0);
    native.send(JSON.stringify({type:'dashboard_context', payload:{sceneReady:true}}));
    await until(() => f.hub.connectionHealth().sceneReadyClients === 1);
    native.send(JSON.stringify({type:'dashboard_context', payload:{sceneReady:false}}));
    await until(() => f.hub.connectionHealth().sceneReadyClients === 0);
    assert.equal(f.hub.connectionHealth().status, 'online');
    native.close(); await once(native, 'close'); await until(() => f.hub.connectionHealth().clients === 0);
    health = (await probe()).display; assert.equal(health.status, 'offline'); assert.ok(health.ageMs >= 0);
    const again = await f.connect('unity');
    assert.equal(f.hub.connectionHealth().connectedClients, 1); assert.equal(f.hub.connectionHealth().sceneReadyClients, 0);
    again.send(JSON.stringify({type:'dashboard_context', payload:{sceneReady:true}}));
    await until(() => f.hub.connectionHealth().sceneReadyClients === 1);
    again.send(JSON.stringify({type:'client_hello', role:'web'}));
    await until(() => f.hub.connectionHealth().clients === 0);
    again.send(JSON.stringify({type:'client_hello', role:'unity'}));
    await until(() => f.hub.connectionHealth().clients === 1);
    assert.equal(f.hub.connectionHealth().sceneReadyClients, 0, 'changing roles cannot borrow old scene readiness');
    web.close();
});
test('standard control ping/pong crosses the actual display gateway without an application heartbeat or PLC changes', async t => {
    const f = await fixture(t, true); await f.connect('unity');
    const peer = [...f.hub.clients][0];
    peer.lastCommunicationAt = Date.now() - 10000;
    const before = peer.lastCommunicationAt;
    f.hub.checkHeartbeats();
    await until(() => peer.lastCommunicationAt > before);
    assert.equal(f.hub.connectionHealth().status, 'online');
    assert.ok(f.hub.heartbeatTimer);
});
test('15-second boundary, stale/multiple peers, termination and ping error cleanup do not depend on collector freshness', async t => {
    const f = await fixture(t); const socket = await f.connect('unity'); const peer = [...f.hub.clients][0];
    const at = peer.lastCommunicationAt;
    assert.equal(f.hub.connectionHealth('unity', at + 15000).status, 'online');
    assert.equal(f.hub.connectionHealth('unity', at + 15001).status, 'stale');
    await f.connect('unity'); await until(() => f.hub.connectionHealth().clients === 2);
    const peers = [...f.hub.clients]; peers[0].lastCommunicationAt = Date.now() - 20000;
    assert.equal(f.hub.connectionHealth().status, 'online'); assert.equal(f.hub.connectionHealth().connectedClients, 1);
    f.hub.checkHeartbeats(); await once(socket, 'close'); await until(() => f.hub.clients.size === 1);
    const remaining = [...f.hub.clients][0]; remaining.ping = () => { throw Error('fixture'); };
    f.hub.checkHeartbeats(); await until(() => !f.hub.clients.size);
    assert.equal(f.hub.connectionHealth().status, 'offline');
    assert.deepEqual(Object.keys(f.hub.connectionHealth()).sort(), ['status','clients','connectedClients','sceneReadyClients','lastCommunicationAt','ageMs','heartbeatIntervalMs','heartbeatTimeoutMs'].sort());
});

test('Windows .NET ClientWebSocket (native transport) automatically answers gateway control pings', {skip:process.platform!=='win32',timeout:20000}, async t => {
    const f = await fixture(t, true), directory = createRunDirectory('native-ws-heartbeat');
    const script = path.join(directory,'client.ps1');
    fs.writeFileSync(script, `param([string]$Endpoint)
$ErrorActionPreference='Stop'
$socket=[System.Net.WebSockets.ClientWebSocket]::new()
$cancel=[System.Threading.CancellationTokenSource]::new(); $cancel.CancelAfter(10000)
try {
    $socket.ConnectAsync([Uri]$Endpoint,$cancel.Token).GetAwaiter().GetResult()
    $hello=[System.Text.Encoding]::UTF8.GetBytes('{"type":"client_hello","role":"unity"}')
    $socket.SendAsync([ArraySegment[byte]]::new($hello),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$cancel.Token).GetAwaiter().GetResult()
    $buffer=New-Object byte[] 4096
    while($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $result=$socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cancel.Token).GetAwaiter().GetResult()
        if([System.Text.Encoding]::UTF8.GetString($buffer,0,$result.Count) -like '*fixture_done*'){break}
    }
} finally {$socket.Dispose(); $cancel.Dispose()}
`, 'utf8');
    const child = spawn('powershell.exe',['-NoProfile','-File',script,f.gateway.origin.replace('http:','ws:')+'/ws'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    const finished = once(child,'close');t.after(()=>{if(child.exitCode===null)child.kill();});
    await until(()=>f.hub.connectionHealth().clients===1);const peer=[...f.hub.clients][0];
    const pong = once(peer,'pong');f.hub.checkHeartbeats();
    let timeout;
    try { await Promise.race([pong,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Native control pong timed out')),5000);})]); }
    finally { clearTimeout(timeout); }
    f.hub.send(peer,{type:'fixture_done'});
    const [code] = await finished;assert.equal(code,0,output);
});
