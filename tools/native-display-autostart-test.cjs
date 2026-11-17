'use strict';
// Fresh isolated site + real Unity + real WebView2. No password/setup/login,
// no preseeded cookies, no physical PLC and no installed-service interaction.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { startDisplayGateway } = require('../desktop/displayGateway.cjs');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname,'..'), stage = path.resolve(process.argv[process.argv.indexOf('--stage')+1] || '');
assert.ok(process.argv.includes('--stage') && stage.startsWith(path.join(root,'output')+path.sep), 'Use an isolated compiled stage under output');
let backend, unity, gateway, browser, directory, outcome;
(async()=>{
    const sandbox=await createSmokeSandbox('native-display-autostart');directory=sandbox.directory;
    const configured=process.argv.includes('--configured');
    const accountFile=path.join(sandbox.dataDir,'admin-security.json');
    if(configured) await require('../backend/services/adminAuth').createAdminAuth({dataDir:sandbox.dataDir})
        .setup(require('node:crypto').randomBytes(32).toString('hex'),'isolated-existing-site');
    const originalAccount=fs.existsSync(accountFile)?fs.readFileSync(accountFile):null;
    const upstream=`http://127.0.0.1:${await findFreePort()}`,debugPort=await findFreePort();
    const delayed=process.argv.includes('--slow-startup'),outage=process.argv.includes('--startup-outage'),backendArgs=[];
    if(delayed){
        const preload=path.join(directory,'delayed-browser-session.cjs');
        fs.writeFileSync(preload,`const http=require('node:http'),emit=http.Server.prototype.emit;http.Server.prototype.emit=function(type,...args){const req=args[0];if(type==='request'&&['/api/admin-auth/session','/api/admin-auth/display-bootstrap'].includes(req.url)&&/Mozilla/.test(req.headers['user-agent']||'')){setTimeout(()=>emit.call(this,type,...args),8000);return true;}return emit.call(this,type,...args);};`);
        backendArgs.push('--require',preload);
    }
    if(outage){
        const preload=path.join(directory,'temporary-display-startup-outage.cjs');
        fs.writeFileSync(preload,`const http=require('node:http'),emit=http.Server.prototype.emit,until=Date.now()+12000;http.Server.prototype.emit=function(type,...args){const req=args[0];if(type==='request'&&req.url==='/api/admin-auth/display-bootstrap'&&Date.now()<until){console.log('STARTUP_BOOTSTRAP_UNAVAILABLE');args[1].writeHead(503,{'Content-Type':'application/json'});args[1].end(JSON.stringify({error:'isolated temporary startup outage'}));return true;}return emit.call(this,type,...args);};`);
        backendArgs.push('--require',preload);
    }
    backendArgs.push('server.js');
    backend=startLoggedProcess(process.execPath,backendArgs,{cwd:BACKEND_DIR,env:{...sandbox.env,PORT:new URL(upstream).port,HOST:'127.0.0.1'},logFile:path.join(directory,'backend.log')});
    await waitForHttp(upstream+'/api/health');
    require('../desktop/displayStartup.cjs').assertDisplayStartupSupported(await fetch(upstream+'/api/health').then(r=>r.json()));
    gateway=await startDisplayGateway({backendOrigin:upstream,frontendDir:path.join(stage,'frontend')});
    const origin=gateway.origin,logFile=path.join(directory,'unity.log');
    const player=path.join(stage,'player/HeatTreatmentDigitalTwin.exe'),host=path.join(stage,'AdminHost/HeatTreatmentAdminHost.exe');
    assert.ok(fs.existsSync(player)&&fs.existsSync(host));
    const log=()=>fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8'):'';
    unity=spawn(player,['-batchmode','-force-d3d11','-screen-fullscreen','0','-screen-width','1280','-screen-height','850','-logFile',logFile],{
        cwd:path.dirname(player),windowsHide:true,stdio:'ignore',env:{...sandbox.env,
            DIGITAL_TWIN_BACKEND_HTTP_URL:origin,DIGITAL_TWIN_BACKEND_WEBSOCKET_URL:origin.replace('http:','ws:')+'/ws',
            DIGITAL_TWIN_ADMIN_URL:origin+'/admin',DIGITAL_TWIN_ADMIN_HOST_PATH:host,DIGITAL_TWIN_MAXIMIZE_WINDOW:'false',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`,
            HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'}});
    fs.writeFileSync(path.join(directory,'target.json'),JSON.stringify({unityPid:unity.pid,backendPid:backend.pid,origin,debugPort}));
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`,90000);
    browser=await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context=browser.contexts()[0];
    // No addCookies(), login(), setup(), pipe injection or privileged API token.
    const admin=await waitUntil(()=>context.pages().find(page=>page.url().startsWith(origin+'/admin')),30000,'owned admin WebView');
    await waitUntil(()=>log().includes('[FactoryRuntime] Native factory ready:'),150000,'automatic read-only Unity scene');
    if(originalAccount) assert.deepEqual(fs.readFileSync(accountFile),originalAccount,'existing accounts must remain unchanged');
    else assert.equal(fs.existsSync(accountFile),false,'display must not silently create an owner or store a password');
    const state=await admin.evaluate(()=>fetch('/api/admin-auth/session').then(r=>r.json()));
    assert.equal(state.configured,configured);assert.equal(state.authenticated,false);assert.equal(state.displayOnly,true);
    assert.equal(state.permissions.edit,false);assert.equal(state.permissions.manageUsers,false);
    const display=await waitUntil(()=>context.pages().find(page=>page.url().startsWith(origin+'/group')||page.url().startsWith(origin+'/overlay')),30000,'automatic display surface');
    await waitUntil(()=>display.locator('#digital-twin-loading-root').count().then(n=>n===0),30000,'actual startup cover completion');
    assert.equal(await display.locator('input[type=password]').count(),0,'display never asks for password');
    await display.screenshot({path:path.join(directory,'01-direct-display.png')});
    const blocked=await admin.evaluate(async()=>{
        const state=await fetch('/api/admin-auth/session').then(r=>r.json());
        const response=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken},body:JSON.stringify({data_mode:'real'})});
        return response.status;
    });
    assert.equal(blocked,401,'read-only display cannot alter collection/configuration');
    await admin.evaluate(()=>window.chrome.webview.postMessage({type:'host_action',action:'show_admin'}));
    await admin.locator('#admin-unlock-password').waitFor({state:'visible'});
    await admin.screenshot({path:path.join(directory,'02-admin-still-requires-password.png')});
    assert.doesNotMatch(log(),/Shared dashboard login failed|Native dashboard authorization ended|NullReferenceException:/);
    outcome={success:true,directory,isolated:true,configured,adminAuthenticated:false,nativeSceneReady:true,
        automaticDisplay:true,passwordEntered:false,ownerAccountCreated:false,managementWriteStatus:blocked,adminPasswordStillRequired:true,slowStartup:delayed,temporaryStartupOutage:outage};
    if(outage) assert.match(fs.readFileSync(path.join(directory,'backend.log'),'utf8'),/STARTUP_BOOTSTRAP_UNAVAILABLE/,'test must exercise an initial failure and recover without credentials');
    if(delayed) assert.match(fs.readFileSync(path.join(directory,'logs/admin-host.log'),'utf8'),/展示启动确认超时/,'test must exercise the late auto-return, not just fast startup');
})().catch(error=>{console.error(error);if(directory)fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({success:false,error:error.message}));process.exitCode=1;})
    .finally(async()=>{
        const failures=[];
        for(const close of [()=>browser?.close(),()=>stopOwnedSmokeProcess(unity,{forceTimeoutMs:20000}),()=>gateway?.close(),()=>stopOwnedSmokeProcess(backend,{forceTimeoutMs:20000})])
            try{await close()}catch(error){failures.push(error.message)}
        if(failures.length){console.error(JSON.stringify({cleanupFailures:failures}));process.exitCode=1;}
        if(outcome&&!process.exitCode){outcome.ownedProcessesStopped=true;fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(outcome,null,2));console.log(JSON.stringify(outcome,null,2));}
    });
