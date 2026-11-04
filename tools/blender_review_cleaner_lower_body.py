"""Reimport the delivered washer GLB and render the formerly missing lower bay."""
from pathlib import Path
import json,sys,hashlib
import bpy
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as base

if not bpy.app.background:
    raise RuntimeError('Run in an isolated background Blender process')
evidence=base.ROOT/'output/cleaner-cavity-review'
item=json.loads((base.OUT/'metadata/washing_machine.json').read_text(encoding='utf8'))
renders=[]
for label,file in [('before',evidence/'before'/item['file']),('after',base.OUT/item['file'])]:
    if '--after-only' in sys.argv and label=='before':continue
    bpy.ops.wm.read_factory_settings(use_empty=True);base.palette()
    a=base.Asset('washing_machine',item['name'],file.stem,item['reference_dimensions_mm'],[])
    bpy.data.objects.remove(a.root,do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=str(file))
    a.root=bpy.data.objects[item['model_id']+'_root'];bpy.context.view_layer.update()
    box=base.bounds(list(a.root.children_recursive));camera,center,span=base.studio(a,box)
    a.scene.cycles.samples=12
    for view,target,direction,scale in [
        ('front',(0,-.35,2.02),(4,-12,3),4.95),
        ('lower-detail',(0,-.58,.91),(2.3,-8,2.5),2.88),
    ]:
        target=Vector(target);camera.location=target+Vector(direction)
        camera.data.ortho_scale=scale;base.look(camera,target)
        out=evidence/(label+'-'+view+'.png');a.scene.render.filepath=str(out)
        bpy.ops.render.render(write_still=True)
        renders.append({'version':label,'file':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'render':out.name})
(evidence/'comparison-renders.json').write_text(json.dumps(renders,ensure_ascii=False,indent=2),encoding='utf8')
