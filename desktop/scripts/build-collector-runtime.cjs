'use strict';
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {prepareCollectorPlugin}=require('./prepare-collector-plugin.cjs');
const {publishDirectory}=require('../directoryPublish.cjs');
const project=path.resolve(__dirname,'../..');
function sourceFingerprint(){
    const hash=crypto.createHash('sha256');
    const walk=(root,prefix='')=>{for(const entry of fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        const relative=prefix+entry.name,file=path.join(root,entry.name);
        if(/^(node_modules|data|uploads|scripts|assets)(\/|$)/.test(relative))continue;
        if(entry.isDirectory())walk(file,relative+'/');else if(entry.isFile()){hash.update(relative+'\0');hash.update(fs.readFileSync(file));}
    }};
    walk(path.join(project,'backend'));walk(path.join(project,'shared'));
    hash.update('backend/scripts/generate-voice.ps1\0');
    hash.update(fs.readFileSync(path.join(project,'backend/scripts/generate-voice.ps1')));
    return hash.digest('hex');
}
async function buildCollectorRuntime({includeWorkspaceAssets=false}={}){
    for(const name of ['build-collector-service.cjs','build-collector-center.cjs']){
        const result=spawnSync(process.execPath,[path.join(__dirname,name)],{cwd:project,stdio:'inherit',windowsHide:true});
        if(result.status!==0)throw Error(`Independent collector build failed: ${name}`);
    }
    const fingerprint=sourceFingerprint(),stamp=`${process.pid}-${Date.now()}`,staging=path.join(project,`.collector-runtime.inputs.preparing-${stamp}`),input=path.join(staging,'inputs'),destination=path.join(project,`.collector-runtime.payload.preparing-${stamp}`);
    fs.mkdirSync(input,{recursive:true});
    for(const name of ['runtime','mysql','licensing','templates','ffmpeg','prerequisites','backend-dependencies.tar'])
        fs.cpSync(path.join(project,'desktop/resources',name),path.join(input,name),{recursive:true});
    fs.cpSync(path.join(project,'backend'),path.join(input,'backend'),{recursive:true,filter:file=>{
        const relative=path.relative(path.join(project,'backend'),file).split(path.sep).join('/');
        if(/^(node_modules|data|uploads|scripts)(\/|$)/.test(relative)||/\.log$/.test(relative))return false;
        return includeWorkspaceAssets||!/^assets\/(models|motions)(\/|$)/.test(relative);
    }});
    fs.mkdirSync(path.join(input,'shared'));
    for(const name of fs.readdirSync(path.join(project,'shared'))) if(/\.(mjs|cjs)$/.test(name)||name==='motionPackages.json')
        fs.copyFileSync(path.join(project,'shared',name),path.join(input,'shared',name));
    prepareCollectorPlugin(input,destination,project);
    if(sourceFingerprint()!==fingerprint)throw Error('Backend/shared sources changed during collector staging; previous runtime retained, please rebuild');
    for(const name of ['frontend','native-client','app.asar','electron.exe']) if(fs.existsSync(path.join(destination,'resources',name)))throw Error(`Collector must not include display resource ${name}`);
    const target=path.join(project,'collector-runtime');
    await publishDirectory(destination,target);
    console.log(`Independent collector runtime: ${target}`);
    return target;
}
if(require.main===module)buildCollectorRuntime({includeWorkspaceAssets:process.argv.includes('--include-workspace-assets')}).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={buildCollectorRuntime};
