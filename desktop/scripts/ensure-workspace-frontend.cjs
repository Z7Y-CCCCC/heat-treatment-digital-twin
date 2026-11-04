'use strict';
// Workspace launcher only. Distribution builds still use fresh staging output.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
function files(directory,exclude=[]) {
    const result=[];
    const walk=(current,ancestors=new Set())=>{
        if(!fs.existsSync(current))return;
        const real=fs.realpathSync(current);
        if(ancestors.has(real))throw new Error('Frontend source contains a directory link cycle');
        const next=new Set([...ancestors,real]);
        for(const name of fs.readdirSync(current).sort()){
            if(current===directory&&exclude.includes(name))continue;
            const file=path.join(current,name),stat=fs.statSync(file);
            if(stat.isDirectory())walk(file,next);else if(stat.isFile())result.push(file);
        }
    };
    walk(directory);return result;
}
function inputFingerprint(frontend,env=process.env) {
    const hash=crypto.createHash('sha256');
    hash.update('workspace-vite-v1\0'+process.version+'\0');
    for(const directory of [frontend,path.resolve(frontend,'../shared')])for(const file of files(directory,['node_modules','dist','.git'])){
        hash.update(path.relative(path.dirname(frontend),file)+'\0'+digest(file)+'\0');
    }
    for(const relative of ['node_modules/.package-lock.json','node_modules/vite/package.json','node_modules/vite/bin/vite.js']){
        const file=path.join(frontend,relative);hash.update(relative+'\0'+(fs.existsSync(file)?digest(file):'missing')+'\0');
    }
    const environment=Object.keys(env).filter(k=>/^(VITE_|NODE_ENV$|NODE_OPTIONS$)/.test(k)).sort().map(k=>[k,env[k]]);
    hash.update(JSON.stringify(environment));return hash.digest('hex');
}
function outputFile(dist,relative) {
    if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').includes('..'))throw new Error('Invalid frontend output path');
    return path.join(dist,relative);
}
function outputProof(frontend) {
    const dist=path.join(frontend,'dist'),manifest=JSON.parse(fs.readFileSync(path.join(dist,'.vite/manifest.json'),'utf8'));
    const names=new Set(['index.html','.vite/manifest.json']);
    for(const item of Object.values(manifest)){
        names.add(item.file);for(const name of [...(item.css||[]),...(item.assets||[])])names.add(name);
    }
    for(const file of files(path.join(frontend,'public')))names.add(path.relative(path.join(frontend,'public'),file).split(path.sep).join('/'));
    return [...names].sort().map(name=>({name,sha256:digest(outputFile(dist,name))}));
}
function cached(frontend,cacheFile,fingerprint) {
    try{
        const value=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
        if(value.fingerprint!==fingerprint||!Array.isArray(value.outputs)||!value.outputs.length)return false;
        const actual=outputProof(frontend);
        return JSON.stringify(actual)===JSON.stringify(value.outputs);
    }catch{return false;}
}
async function acquire(lock,timeout=60000) {
    const end=Date.now()+timeout;
    for(;;){
        try{
            const fd=fs.openSync(lock,'wx');
            try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));}finally{fs.closeSync(fd);}
            return;
        }catch(error){
            if(error.code!=='EEXIST')throw error;
            try{
                const before=fs.readFileSync(lock,'utf8'),owner=JSON.parse(before);
                if(Number.isSafeInteger(owner.pid)&&owner.pid>0){
                    try{process.kill(owner.pid,0);}catch(probe){
                        if(probe.code==='ESRCH'&&fs.readFileSync(lock,'utf8')===before){fs.unlinkSync(lock);continue;}
                    }
                }
            }catch{/* An owner may still be writing. Do not steal its lock. */}
            if(Date.now()>=end)throw new Error('另一个启动窗口仍在构建界面，请稍后重试');
            await sleep(150);
        }
    }
}
function buildFrontend(frontend) {
    return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(frontend,'node_modules/vite/bin/vite.js'),'build','--manifest'],{cwd:frontend,windowsHide:true,stdio:'inherit'});
        child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('界面构建失败（代码 '+code+'），不会启动旧界面')));
    });
}
async function ensureWorkspaceFrontend(frontend,{cacheFile=path.resolve(frontend,'../desktop/.cache/workspace-frontend.json'),force=false,build=buildFrontend,env=process.env}={}) {
    const beginning=performance.now();
    fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
    const lock=cacheFile+'.lock';await acquire(lock);
    try{
        const fingerprint=inputFingerprint(frontend,env);
        if(!force&&cached(frontend,cacheFile,fingerprint))return {reused:true,milliseconds:Math.round(performance.now()-beginning)};
        await build(frontend);
        if(inputFingerprint(frontend,env)!==fingerprint)throw new Error('构建期间源码发生变化，请重新启动以加载最新界面');
        const outputs=outputProof(frontend),temporary=cacheFile+'.'+process.pid+'.tmp';
        fs.writeFileSync(temporary,JSON.stringify({fingerprint,outputs}));fs.renameSync(temporary,cacheFile);
        return {reused:false,milliseconds:Math.round(performance.now()-beginning)};
    }finally{fs.unlinkSync(lock);}
}
if(require.main===module)ensureWorkspaceFrontend(path.resolve(__dirname,'../../frontend'),{force:process.argv.includes('--force')})
    .then(result=>console.log((result.reused?'界面未变化，已复用校验通过的构建':'最新界面已构建')+`（${result.milliseconds} ms）`))
    .catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={inputFingerprint,outputProof,ensureWorkspaceFrontend};
