// Development-only, isolated UI/WS verification. Does not touch the installed
// collector, site DB, deployment settings or PLCs; never builds a release.
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const {once}=require('node:events');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {WebSocket}=require('../backend/node_modules/ws');
const WsServer=require('../backend/services/wsServer');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const {probeCollectorConnection}=require('../desktop/connectionHealth.cjs');
const root=path.resolve(__dirname,'..'), directory=createRunDirectory('connection-health-ui');
let browser, native; const hub=new WsServer(), errors=[], checks=[];
let collectionState='simulation', label='模拟演示运行中', probes=0, saves=0;
const server=http.createServer((req,res)=>{
    if(req.url==='/api/health'){
        assert.equal(req.method,'GET');res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify({status:'ok',runtime:{role:'collector',owner:'windows-service',serviceName:'HeatTreatmentCollector'},
            db:{connected:true},engine:{mode:'simulation'},collectorHealth:{state:collectionState,label,lastSampleAgeMs:58},components:{displayConnection:hub.connectionHealth()}}));
    }
    const name={'/':'deployment.html','/deployment.js':'deployment.js'}[req.url];
    if(!name){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':'text/html');
    res.end(fs.readFileSync(path.join(root,'desktop/assets',name)));
});
(async()=>{
    hub.attach(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const page=await browser.newPage({viewport:{width:760,height:820}});page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('fixtureProbe',async raw=>{
        probes++;try{return await probeCollectorConnection(raw);}catch{return {state:'invalid',transport:'地址格式无效',collection:'未检测',display:null};}
    });
    await page.exposeFunction('fixtureSave',()=>{saves++;throw Error('Read-only fixture must not save');});
    await page.addInitScript(origin=>{window.deployment={load:async()=>({config:{mode:'client',backendOrigin:origin}}),probe:window.fixtureProbe,save:window.fixtureSave};},origin);
    await page.goto(origin);await page.locator('#transport').filter({hasText:'服务接口可达'}).waitFor();
    assert.equal(await page.locator('#displayLink').innerText(),'未连接大屏');assert.match(await page.locator('#healthNote').innerText(),/模拟演示.*不代表已连接现场 PLC/);
    await page.screenshot({path:path.join(directory,'display-no-peer.png'),fullPage:true});checks.push('reachable service with no native display is not shown as a healthy display link');
    native=new WebSocket(origin.replace('http:','ws:')+'/ws');await once(native,'open');
    native.send(JSON.stringify({type:'client_hello',role:'unity'}));native.send(JSON.stringify({type:'dashboard_context',payload:{sceneReady:true}}));
    await page.getByRole('button',{name:'重新检测'}).click();await page.locator('#displayLink').filter({hasText:'1 个在线 · 场景就绪'}).waitFor();
    await page.screenshot({path:path.join(directory,'display-connected.png'),fullPage:true});checks.push('real WS hello and scene-ready are reflected at display side without a settings write');
    await page.setViewportSize({width:700,height:730});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'minimum width must not scroll horizontally');
    await page.screenshot({path:path.join(directory,'display-minimum-width.png'),fullPage:true});
    await page.locator('#save').scrollIntoViewIfNeeded();assert.ok(await page.locator('#save').isVisible());
    checks.push('minimum-size window remains readable and save action remains accessible by vertical scrolling');
    await page.setViewportSize({width:760,height:820});
    clearInterval(hub.heartbeatTimer);hub.heartbeatTimer=null;[...hub.clients][0].lastCommunicationAt=Date.now()-20000;
    await page.getByRole('button',{name:'重新检测'}).click();await page.locator('#displayLink').filter({hasText:'通信超时'}).waitFor();
    await page.screenshot({path:path.join(directory,'display-stale.png'),fullPage:true});checks.push('expired native heartbeat is a timeout, not successful HTTP connectivity');
    native.close();await once(native,'close');collectionState='degraded';label='部分采集异常';
    await page.getByRole('button',{name:'重新检测'}).click();await page.locator('#collection').filter({hasText:label}).waitFor();
    assert.equal(await page.locator('#displayLink').innerText(),'未连接大屏');
    await page.screenshot({path:path.join(directory,'display-degraded.png'),fullPage:true});checks.push('collection degradation and native disconnect are separate diagnostics');
    await page.locator('#backendOrigin').fill('NOT_AN_ORIGIN');await page.locator('#connectionHealth[data-state="invalid"]').waitFor();
    assert.equal(await page.locator('#displayLink').innerText(),'状态未知');checks.push('editing an invalid address clears previously healthy telemetry');
    await page.locator('#mode').selectOption('display');await page.locator('#connectionHealth[data-state="independent"]').waitFor();
    assert.equal(await page.locator('#displayLink').innerText(),'不适用');assert.ok(!(await page.locator('#remote').isVisible()));
    assert.equal(saves,0);assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,fixtureOnly:true,checks,probes,saves,errors},null,2));
    console.log(JSON.stringify({success:true,checks,probes,saves,directory},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    native?.terminate();await browser?.close();hub.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
});
