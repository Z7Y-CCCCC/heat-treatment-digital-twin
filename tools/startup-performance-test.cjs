'use strict';
// Real desktop/backend/Unity/WebView startup to the login surface, with an
// owned SQLite profile. No installed profile, credentials, PLC or service edits.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { waitUntil, waitForExit, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..'), desktop = path.join(root, 'desktop');
const option = name => process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
const label = option('--label') || 'startup';
const count = Math.min(5,Math.max(1,Number(option('--runs')||2)));
const settingsDelayMs = Math.min(5000,Math.max(0,Number(option('--settings-delay-ms')||0)));
let child;
(async()=>{
    if(!Number.isInteger(count)||!Number.isFinite(settingsDelayMs))throw new Error('Invalid profiling run count or settings delay');
    const sandbox = await createSmokeSandbox('startup-performance-'+label.replace(/[^a-z0-9-]/gi,''));
    const profileOption=option('--profile');
    if(profileOption){
        const profile=path.resolve(profileOption);requireTestPath(profile);
        if(!path.basename(profile).startsWith('startup-performance-')||!fs.existsSync(path.join(profile,'source-main.cjs.txt')))throw new Error('Only a prior owned startup profile may be reused');
        sandbox.dataDir=path.join(profile,'data');sandbox.filename=path.join(sandbox.dataDir,'factory.db');
        Object.assign(sandbox.env,{APP_USER_DATA_DIR:profile,APP_DATA_DIR:sandbox.dataDir,UPLOADS_DIR:path.join(profile,'uploads'),SQLITE_FILE:sandbox.filename});
    }
    if(!fs.existsSync(path.join(sandbox.dataDir,'database-config.json')))fs.writeFileSync(path.join(sandbox.dataDir,'database-config.json'),JSON.stringify({type:'sqlite',filename:sandbox.filename}));
    const sourceOption=option('--source');
    if(sourceOption)requireTestPath(path.resolve(sourceOption));
    const source = fs.readFileSync(sourceOption||path.join(desktop,'main.cjs'),'utf8');
    fs.writeFileSync(path.join(sandbox.directory,'source-main.cjs.txt'),source);
    const mainSha256=crypto.createHash('sha256').update(source).digest('hex');
    const rows=[];
    for(let i=0;i<count;i++){
        const resultFile=path.join(sandbox.directory,`run-${i+1}.json`);
        const logFile=path.join(sandbox.directory,`run-${i+1}.log`);
        let measured=source;
        for(const signature of ['function updateStartupProgress(id, progress, title, detail = \'\') {','function completeStartupProgress() {','async function showStartupFailure(error) {']){
            if(!measured.includes(signature))throw new Error('Startup profiling hook no longer matches production code');
        }
        measured=measured.replace('function updateStartupProgress(id, progress, title, detail = \'\') {',"function updateStartupProgress(id, progress, title, detail = '') { __recordStartup(id);")
            .replace('function completeStartupProgress() {',"function completeStartupProgress() { __recordStartup('complete',true);")
            .replace('async function showStartupFailure(error) {',"async function showStartupFailure(error) { __recordStartup('failed',false,String(error.message));");
        if(settingsDelayMs)measured+=`\nconst __originalRuntimeSettings=readRuntimeSettings;let __delayFirstSettings=true;
            readRuntimeSettings=async(...args)=>{if(__delayFirstSettings){__delayFirstSettings=false;await delay(${settingsDelayMs});}return __originalRuntimeSettings(...args);};`;
        const bootstrap=path.join(sandbox.directory,`bootstrap-${i+1}.cjs`);
        const instrument=`const __startupBeginning=process.hrtime.bigint();const __startupStages=[];
            function __recordStartup(id,success,error){const ms=Number(process.hrtime.bigint()-__startupBeginning)/1e6;
            __startupStages.push({id,ms:Math.round(ms)});const file=${JSON.stringify(resultFile)},io=require('node:fs');
            io.appendFileSync(file+'.events',JSON.stringify({id,ms:Math.round(ms)})+'\\n');
            if(typeof success==='boolean')io.writeFileSync(file,JSON.stringify({success,ms:Math.round(ms),stages:__startupStages,...(error?{error}:{})}));}\n`;
        fs.writeFileSync(bootstrap,`const Module=require('node:module');const filename=${JSON.stringify(path.join(desktop,'main.cjs'))};
            const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(${JSON.stringify(desktop)});
            m._compile(${JSON.stringify(instrument+measured)},filename);`);
        const env={...sandbox.env,NATIVE_CLIENT_SMOKE_MODE:'true',DESKTOP_SMOKE_EXIT_AFTER_MS:'500'};
        delete env.ELECTRON_RUN_AS_NODE;
        const fd=fs.openSync(logFile,'w');
        try{child=spawn(path.join(desktop,'node_modules/electron/dist/electron.exe'),[bootstrap],{cwd:desktop,env,windowsHide:true,stdio:['ignore',fd,fd]});}
        finally{fs.closeSync(fd);}
        const exit=waitForExit(child,150000);exit.catch(()=>{});
        await waitUntil(()=>{
            if(!fs.existsSync(resultFile))return false;
            let r;try{r=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch(error){if(error instanceof SyntaxError)return false;throw error;}
            if(r.success===false)throw new Error(r.error||'Owned desktop startup failed');
            return r.success===true;
        },120000,'owned desktop login surface');
        const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));
        const finished=await exit;
        if((typeof finished==='number'?finished:finished.code)!==0)throw new Error('Owned desktop did not exit cleanly: '+JSON.stringify(finished));
        child=null;rows.push({kind:!profileOption&&i===0?'fresh-profile':'repeat-profile',...result});
        console.log(JSON.stringify({label,run:i+1,ms:result.ms,stages:result.stages}));
    }
    const report={success:true,label,mainSha256,profile:sandbox.env.APP_USER_DATA_DIR,evidence:sandbox.directory,database:'isolated SQLite; not field MySQL/PLC',injectedFirstSettingsDelayMs:settingsDelayMs,runs:rows};
    fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify(report,null,2));
    console.log('Evidence: '+sandbox.directory);
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;})
    .finally(async()=>{if(child)await stopOwnedSmokeProcess(child);});
