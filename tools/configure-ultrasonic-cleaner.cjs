const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {buildMetadata,calibrateDoorBindings,doorTravel,movingNodes,fixedDoorNodes,shellNodes,groups}=require('./model-profiles/ultrasonic_cleaner_cad.cjs');
const {validateInspection}=require('../shared/inspectionConfig.cjs');
async function main(){
    const root=path.resolve(__dirname,'..'),origin=process.env.MODEL_PROFILE_ORIGIN||'http://127.0.0.1:3001';
    if(new URL(origin).hostname!=='127.0.0.1') throw Error('Profile authoring requires a local backend');
    const login=await fetch(origin+'/api/admin-auth/login',{method:'POST',headers:{'content-type':'application/json',Origin:origin,'X-Admin-Request':'1'},body:JSON.stringify({username:'admin',password:process.env.MODEL_PROFILE_PASSWORD})});
    const auth=await login.json();if(!login.ok||!auth.permissions?.edit) throw Error('Model authoring login failed');
    const headers={Cookie:login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),'X-CSRF-Token':auth.csrfToken,'content-type':'application/json'};
    const models=await fetch(origin+'/api/models',{headers}).then(r=>r.json());
    const model=models.find(m=>m.id==='ultrasonic_cleaner_cad');if(!model) throw Error('Model not found');
    if(process.argv.includes('--calibrate-door')) {
        const original=typeof model.metadata==='string'?JSON.parse(model.metadata):model.metadata;
        const expectedBindings=original.partBindings||[];
        const owned=expectedBindings.filter(binding=>String(binding.id).startsWith('ultrasonic_door_'));
        if(owned.length!==movingNodes.length)throw Error('Expected all 20 cleaner door bindings before calibration');
        const backup=path.join(root,'output','ultrasonic-door-calibration-'+Date.now());fs.mkdirSync(backup,{recursive:true});
        fs.writeFileSync(path.join(backup,'model-before.json'),JSON.stringify(model,null,2));
        const response=await fetch(origin+'/api/models/'+encodeURIComponent(model.id)+'/bindings',{method:'PUT',headers,
            body:JSON.stringify({expectedBindings,partBindings:calibrateDoorBindings(expectedBindings)})});
        const result=await response.json();if(!response.ok||!result.success)throw Error(JSON.stringify(result));
        const stored=typeof result.model.metadata==='string'?JSON.parse(result.model.metadata):result.model.metadata;
        assert.deepEqual(stored.inspection,original.inspection,'Inspection layout unexpectedly changed');
        fs.writeFileSync(path.join(backup,'model-after.json'),JSON.stringify(result.model,null,2));
        console.log(JSON.stringify({success:true,origin,movingNodes:owned.length,doorTravel,inspectionPreserved:true,backup},null,2));
        return;
    }
    const binary=Buffer.from(await fetch(new URL(model.file_path,origin),{headers}).then(r=>r.arrayBuffer()));
    const gltf=JSON.parse(binary.toString('utf8',20,20+binary.readUInt32LE(12)));
    const names=new Set(gltf.nodes.map(n=>n.name));
    for(const name of [...movingNodes,...fixedDoorNodes,...shellNodes,...groups.flatMap(g=>g[2])]) if(!names.has(name)) throw Error('CAD node missing: '+name);
    const metadata=buildMetadata(model.metadata);
    const validation=validateInspection(metadata.inspection);
    if(!validation.valid) throw Error(JSON.stringify(validation.errors));
    const backup=path.join(root,'output','ultrasonic-profile-'+Date.now());fs.mkdirSync(backup,{recursive:true});
    fs.writeFileSync(path.join(backup,'model-before.json'),JSON.stringify(model,null,2));
    const saved=await fetch(origin+'/api/models/'+encodeURIComponent(model.id),{method:'PUT',headers,body:JSON.stringify({metadata})});
    const result=await saved.json();if(!saved.ok) throw Error(JSON.stringify(result));
    fs.writeFileSync(path.join(backup,'metadata-after.json'),JSON.stringify(metadata,null,2));
    console.log(JSON.stringify({success:true,model:model.id,movingNodes:movingNodes.length,inspectionGroups:groups.length,signal:'doors.front_door_open',backup},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
