"""Regression: the delivered GLB must actually close the formerly empty lower bay.

Run in a separate background Blender process after building washing_machine.
Checks the old asset fails the bay-occlusion test and the new source/GLB pass.
"""
from pathlib import Path
import sys,json,hashlib,bpy,bmesh
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import validate_equipment_glb as structure
import audit_equipment_glb_geometry as geometry

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'backend/assets/models/cad_general_20261103_v1'
EVIDENCE=ROOT/'output/cleaner-cavity-review'
meta=json.loads((OUT/'metadata/washing_machine.json').read_text(encoding='utf8'))
file=OUT/meta['file'];source=OUT/'sources'/(file.stem+'.blend')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def rays():
    bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get()
    results=[]
    for x in [-.45,0,.45]:
        for z in [.30,.60,.90]:
            hit,loc,normal,index,obj,matrix=bpy.context.scene.ray_cast(deps,Vector((x,-3,z)),Vector((0,1,0)),distance=6)
            results.append({'x_m':x,'z_m':z,'hit':bool(hit),'object':obj.name if hit else None,
                            'central_lower_body':bool(hit and 'central_lower_body' in obj.parent.name),
                            'lower_assembly':bool(hit and any(group in obj.parent.name for group in ['central_lower_body','lower_collection']))})
    return results

def import_glb(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))

import_glb(EVIDENCE/'before'/meta['file']);before=rays()
assert all(not r['hit'] for r in before),'Baseline no longer reproduces the missing bay'
bpy.ops.wm.open_mainfile(filepath=str(source))
shell=bpy.data.objects['cad_washing_machine_v1_wash_lower_shell']
bpy.context.view_layer.update()
assert max(abs(v-e) for v,e in zip(shell.dimensions,(1.200,1.925,1.195)))<.0001,tuple(shell.dimensions)
collector=bpy.data.objects['cad_washing_machine_v1_wash_lower_collector_front']
assert abs(collector.dimensions.x-.836)<.0001
assert abs(collector.dimensions.z-.193)<.0001
assert abs(collector.location.z+collector.dimensions.z/2-1.038)<.0001
assert bpy.data.objects.get('cad_washing_machine_v1_wash_lower_drain_spout')
bm=bmesh.new();bm.from_mesh(shell.data)
manifold=all(e.is_manifold for e in bm.edges);bm.free()
assert manifold,'The restored sheet enclosure must have no open/nonmanifold edges'
source_rays=rays();assert all(r['lower_assembly'] for r in source_rays),source_rays
assert sum(r['central_lower_body'] for r in source_rays)>=8
import_glb(file);after=rays();assert all(r['lower_assembly'] for r in after),after

doc,size=structure.read_glb(file);structural=structure.validate(doc,size,meta['model_id']+'_root',meta)
doc,binary,size=geometry.read_glb(file);audit=geometry.audit(doc,binary,size)
assert structural['valid'],structural['errors']
assert audit['valid'],audit
assert sha(file)==meta['sha256']
others=[]
for row in json.loads((EVIDENCE/'seven-before-hashes.json').read_text(encoding='utf-8-sig')):
    if row['file']==file.name:continue
    unchanged=sha(OUT/row['file']).lower()==row['sha256'].lower()
    others.append({'file':row['file'],'unchanged':unchanged});assert unchanged
dwg=json.loads((EVIDENCE/'dwg-evidence.json').read_text(encoding='utf8'))
assert sha(Path(dwg['source']))==dwg['source_sha256'],'Original DWG changed'
report={'pass':True,'glb':str(file),'sha256':sha(file),'source_blend_sha256':sha(source),
        'source_closed_sheet_mesh':manifold,'before_rays':before,'source_rays':source_rays,'delivered_glb_rays':after,
        'structural':structural,'geometry':audit,'other_six_models':others,'original_dwg_unchanged':True}
(EVIDENCE/'regression.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print('CLEANER_LOWER_BODY_PASS '+json.dumps({'sha256':report['sha256'],'before_missing_rays':len(before),'after_closed_rays':len(after),'triangles':structural['stats']['triangles'],'other_models_unchanged':len(others)}),flush=True)
