'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const {createRunDirectory,findFreePort,waitUntil,sleep}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let host,parent,server,browser;
(async()=>{
 const directory=createRunDirectory('webview-crash'),seen={admin:0,overlay:0};
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/proof'){const name=url.searchParams.get('page');seen[name]=(seen[name]||0)+1;res.writeHead(204).end();return;}
  const name=url.pathname.includes('overlay')?'overlay':'admin';res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><title>Isolated WebView failure</title><script>fetch('/proof?page=${name}');window.chrome?.webview?.postMessage({type:'overlay_ready'})</script>`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 parent=spawn(process.execPath,['-e',"process.on('message',m=>{if(m==='stop')process.exit(0)});setTimeout(()=>process.exit(0),90000)"],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 const debugPort=await findFreePort(),executable=path.resolve(__dirname,'../unity-client/Builds/Windows/AdminHost/HeatTreatmentAdminHost.exe');
 host=spawn(executable,['--url',`http://127.0.0.1:${server.address().port}/admin?embedded=unity`,'--parent-pid',String(parent.pid),'--parent-hwnd','0','--user-data',path.join(directory,'webview2'),'--dashboard-mode'],{cwd:path.dirname(executable),windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`}});
 await waitUntil(()=>seen.admin>0&&seen.overlay>0,30000,'native admin and overlay loaded');
 browser=await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
 const context=browser.contexts()[0],page=context.pages().find(page=>page.url().includes('/admin'));
 assert.ok(page);const cdp=await context.newCDPSession(page),before=seen.admin;
 cdp.send('Page.crash').catch(()=>{});
 await waitUntil(()=>seen.admin>before,15000,'native renderer automatically reloaded');
 assert.equal(parent.exitCode,null);assert.equal(host.exitCode,null);
 const browserSession=await browser.newBrowserCDPSession();browserSession.send('Browser.crash').catch(()=>{});
 await waitUntil(()=>host.exitCode!==null,15000,'failed browser causes clean controller/host recreation');
 assert.equal(parent.exitCode,null);assert.equal(host.exitCode,0);
 const log=fs.readFileSync(path.join(directory,'logs','admin-host.log'),'utf8');assert.match(log,/WebView2 进程异常/);
 const result={success:true,rendererAutomaticallyReloaded:true,browserFailureRequestsHostRecreation:true,parentSurvived:true,noUnityOrBackendRestart:true,directory};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close().catch(()=>{});await stopOwnedSmokeProcess(host);await stopOwnedSmokeProcess(parent);server?.closeAllConnections();server?.close()});
