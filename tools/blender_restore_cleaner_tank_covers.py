"""Apply the cover-only repair to the existing editable CAD, in a private batch.

Avoid regenerating unrelated mechanisms. The full builder uses the same cover
function, while this path preserves every existing prepared mesh and node.
"""
from pathlib import Path
import os,sys,json
import bpy,bmesh
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as base

if not bpy.app.background:
    raise RuntimeError('Use an isolated background Blender process')
source_dir=base.OUT
item=json.loads((source_dir/'metadata/washing_machine.json').read_text(encoding='utf8'))
output=Path(os.environ['CLEANER_COVER_OUTPUT']).resolve()
if not str(output).startswith(str(base.ROOT/'output')+os.sep):
    raise RuntimeError('An owned staging directory under output is required')
for name in ['sources','previews','metadata']:(output/name).mkdir(parents=True,exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(source_dir/'sources'/(Path(item['file']).stem+'.blend')))
a=object.__new__(base.Asset)
a.key='washing_machine';a.id=item['model_id'];a.label=item['name'];a.filename=Path(item['file']).stem
a.dimensions=item['reference_dimensions_mm']
a.notes=['17.07.00 MAX 4107: connected lower bath with normally closed solid top covers; no internal partitions.']
a.root=bpy.data.objects[a.id+'_root'];a.scene=a.root.users_scene[0]
a.groups={o.get('part'):o for o in a.root.children if o.get('part')}
base.MATS={m.name.removeprefix('CAD26_'):m for m in bpy.data.materials if m.name.startswith('CAD26_')}
assert 'enamel' in base.MATS
owned={a.root,*a.root.children_recursive}
for obj in list(a.scene.objects):
    if obj not in owned:bpy.data.objects.remove(obj,do_unlink=True)
assert not any(o.name.startswith(a.id+'_wash_lower_side_cover') for o in a.root.children_recursive),'Covers already present'
before=set(a.root.children_recursive)
base.wash_lower_covers(a)
added=set(a.root.children_recursive)-before
assert len(added)==4 and all(o.parent==a.group('central_lower_body') for o in added)
for obj in added:
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    for mod in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    mesh=bmesh.new();mesh.from_mesh(obj.data);bmesh.ops.recalc_face_normals(mesh,faces=mesh.faces);mesh.to_mesh(obj.data);mesh.free();obj.data.update()
a.prepared_geometry=True
features=json.loads(a.root.get('cad_detail_contract','{}'))
features.update(wash_lower_side_cover=2,wash_lower_end_cover=2)
a.root['cad_detail_contract']=json.dumps(features)
a.root['cad_geometry_checks']=json.dumps(['connected lower bath; no internal partitions','four opaque top covers with a central chamber opening'])
base.OUT=output
result=base.export(a)
result['detail_features']=features
result['mechanism_checks']=json.loads(a.root['cad_geometry_checks'])
(output/'metadata/washing_machine.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print('CLEANER_COVERS_DONE '+json.dumps({'added_cover_sheets':len(added),'preserved_prepared_objects':len(before),'output':str(output)}),flush=True)
