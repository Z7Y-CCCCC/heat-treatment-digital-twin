'use strict';
// Audit actual CAD hierarchy membership; do not mistake a primary assembly for
// all of its sibling covers, seal plates and fasteners in the inspection group.
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'unity-client/Assets/Scripts/Rendering/ShellTransparencyTargets.cs'),'utf8');
const coverSource=source.match(/CoverNodes = [^{]+\{([\s\S]*?)\n        \};/)[1];
const covers=new Set([...coverSource.matchAll(/"(cad_[^"]+)"/g)].map(match=>match[1]));
const structuralGroupMembers=new Set(['cad_multipurpose_furnace_600_v1_canopy_frame']);
const cases=[
 ['cad_tempering_furnace_091300',['cad_temper_housing','cad_temper_lining','cad_temper_fan_cover','cad_temper_extraction','cad_temper_hatch']],
 ['cad_multipurpose_furnace_082000',['cad_multipurpose_furnace_082000_assembly_3','cad_multipurpose_furnace_082000_assembly_4','cad_multipurpose_furnace_082000_assembly_5','cad_multipurpose_furnace_082000_assembly_27','cad_multipurpose_furnace_082000_assembly_29']],
 ['cad_cleaner_170700',['cad_cleaner_170700_assembly_2','cad_cleaner_170700_assembly_3','cad_cleaner_170700_assembly_9','cad_cleaner_170700_assembly_16']],
 ['cad_water_cooling_tank_471000',['cad_water_cooling_tank_471000_assembly_3','cad_water_cooling_tank_471000_assembly_4','cad_water_cooling_tank_471000_assembly_16']],
 ['cad_air_cooling_table_115800ht',['cad_air_cooling_table_115800ht_assembly_3']]
];
for(const [id,partIds] of cases){
 const base=path.join(root,'backend/assets/models',id),meta=JSON.parse(fs.readFileSync(base+'_metadata.json')),buffer=fs.readFileSync(base+'.glb');
 const gltf=JSON.parse(buffer.toString('utf8',20,20+buffer.readUInt32LE(12))),nodes=gltf.nodes,parent=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(child=>parent.set(child,i)));
 for(const partId of partIds){const part=meta.inspection.parts.find(p=>p.id===partId);assert.ok(part,partId);for(const name of [part.node_name,...part.node_names].filter(Boolean)){
  if(structuralGroupMembers.has(name))assert.ok(!covers.has(name),`${id}: support structure must remain solid`);
  else assert.ok(covers.has(name),`${id}: uncovered cover-group member ${name}`);
 }}
 let count=0,meshes=0;for(let i=0;i<nodes.length;i++){if(nodes[i].mesh==null)continue;meshes++;let node=i,covered=false;while(node!=null){covered ||= covers.has(nodes[node].name);node=parent.get(node)}count+=covered}
 assert.ok(count>0);console.log(`PASS ${id}: ${count}/${meshes} meshes belong to explicitly selected cover assemblies`);
}
for(const name of ['cad_tempering_furnace_v1_internal_fan','cad_tempering_furnace_v1_internal_rollers','cad_tempering_furnace_v1_door_chains','cad_multipurpose_furnace_600_v1_intermediate_gate','cad_multipurpose_furnace_600_v1_agitators'])assert.ok(!covers.has(name),`Internal actuator became a cover: ${name}`);
console.log('PASS internal fans/rollers/chains/gate/agitators stay solid; nested cover tint is 2.5%');
for(const name of ['cad_tempering_furnace_v1_structure','cad_tempering_furnace_v1_door_guides','cad_tempering_furnace_v1_pipes','cad_multipurpose_furnace_600_v1_canopy_frame'])assert.ok(!covers.has(name),`Static reference became transparent: ${name}`);
console.log('PASS static base/guides/pipes/support frames remain solid too; not a moving-parts-only view');
