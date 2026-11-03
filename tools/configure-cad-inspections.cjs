const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {CATALOG}=require('../backend/services/cadEquipmentModels');
const {buildCadInspection}=require('./model-profiles/imported-cad-inspection.cjs');
const {validateInspection}=require('../shared/inspectionConfig.cjs');
for(const {id} of CATALOG){
    const asset=path.join(__dirname,'../backend/assets/models',id),bytes=fs.readFileSync(asset+'.glb');
    const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
    const metadata=JSON.parse(fs.readFileSync(asset+'_metadata.json'));
    const inspection=buildCadInspection(id,gltf),result=validateInspection(inspection);
    assert.ok(result.valid,JSON.stringify(result.errors));
    if(process.argv.includes('--check'))assert.deepEqual(metadata.inspection,inspection,id);
    else fs.writeFileSync(asset+'_metadata.json',JSON.stringify({...metadata,inspection},null,2)+'\n');
    console.log(JSON.stringify({id,assemblies:inspection.parts.length,targets:inspection.parts.flatMap(p=>[p.node_name,...p.node_names]).filter(Boolean).length,valid:result.valid}));
}
