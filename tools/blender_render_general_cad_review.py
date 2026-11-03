"""Render detail evidence from delivered GLBs, not the authoring scene.

Cutaway views hide casings in memory only; GLBs and .blend sources are untouched.
"""
import sys,json,hashlib
from pathlib import Path
import bpy
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as base

EVIDENCE=base.CAD/'final-review';EVIDENCE.mkdir(parents=True,exist_ok=True)
SHOTS={
 'transfer_cart':((.78,-.02,1.62),(3,-5,2),1.30),
 'lifting_staging_table':((.18,0,.51),(3,-5,3),1.20),
 'fixed_staging_table':((.755,-.265,.18),(3,-5,2),.51),
 'air_cooling_table':((.12,0,.94),(2,-3,-.5),1.36),
 'water_cooling_tank':((-.32,-.88,2.87),(3,-5,2),1.75),
 'tempering_furnace':((0,.18,2.65),(-4,3,3),1.95),
 'washing_machine':((-.72,.30,3.22),(-5,3,2),1.52),
}
CUT={
 'water_cooling_tank':['tank','upper_housing','lining','door','extraction','rear_tank_hatch'],
 'tempering_furnace':['housing','lining','door','extraction','rear_service_hatch'],
 'washing_machine':['housing','lining','door','rear_inspection'],
}
only=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
evidence=[]
for item in json.loads((base.OUT/'manifest.json').read_text(encoding='utf8'))['models']:
    key=item['source']['id']
    if only and key not in only:continue
    file=base.OUT/item['file'];sha=hashlib.sha256(file.read_bytes()).hexdigest()
    assert sha==item['sha256'],('Changing file during review',file.name)
    bpy.ops.wm.read_factory_settings(use_empty=True);base.palette()
    a=base.Asset(key,item['name'],file.stem,item['reference_dimensions_mm'],item['notes'])
    bpy.data.objects.remove(a.root,do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=str(file))
    a.root=bpy.data.objects[item['model_id']+'_root'];bpy.context.view_layer.update()
    box=base.bounds(list(a.root.children_recursive));camera,center,span=base.studio(a,box)
    a.scene.cycles.samples=10;a.scene.render.resolution_x=1000;a.scene.render.resolution_y=900
    target,direction,scale=SHOTS[key];target=Vector(target)
    camera.location=target+Vector(direction);camera.data.ortho_scale=scale;base.look(camera,target)
    output=EVIDENCE/(key+'-detail.png');a.scene.render.filepath=str(output);bpy.ops.render.render(write_still=True)
    outputs=[output.name]
    if key in CUT:
        for group in a.root.children:
            if group.get('part') in CUT[key]:
                for obj in group.children_recursive:obj.hide_render=True
        center=Vector((-.32,0,1.65) if key=='water_cooling_tank' else (0,0,1.65) if key=='tempering_furnace' else (0,0,2.1))
        camera.location=center+Vector((4,-6,3));camera.data.ortho_scale=3.4 if key!='washing_machine' else 4.5;base.look(camera,center)
        output=EVIDENCE/(key+'-cutaway.png');a.scene.render.filepath=str(output);bpy.ops.render.render(write_still=True);outputs.append(output.name)
    assert sha==hashlib.sha256(file.read_bytes()).hexdigest()
    evidence.append({'name':item['name'],'file':file.name,'sha256':sha,'renders':outputs})
    print('GLB_REVIEW_RENDERED '+json.dumps(evidence[-1],ensure_ascii=False),flush=True)
report=EVIDENCE/'rendered-glb-evidence.json'
existing=json.loads(report.read_text(encoding='utf8')) if report.exists() else []
merged={row['file']:row for row in existing}
merged.update({row['file']:row for row in evidence})
report.write_text(json.dumps(list(merged.values()),ensure_ascii=False,indent=2),encoding='utf8')
