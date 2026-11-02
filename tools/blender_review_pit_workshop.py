"""Render the exact editable layout and shared runtime ground mesh; no image generation.
PIT_CAD_REVIEW_DATA points to apply-pit-cad-layout output directory.
"""
import bpy,json,math,os
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
DATA=Path(os.environ['PIT_CAD_REVIEW_DATA']);OUT=DATA/'review';OUT.mkdir(exist_ok=True)
profile=json.loads((ROOT/'tools/model-profiles/pit-workshop-cad-layout.json').read_text(encoding='utf-8'))
meshdata=json.loads((DATA/'ground-mesh.json').read_text(encoding='utf-8'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def material(name,color,metal=0,rough=.7):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=(*color,1);b.inputs['Metallic'].default_value=metal;b.inputs['Roughness'].default_value=rough;return m
concrete=material('industrial concrete',(.22,.25,.26));cutmat=material('section concrete',(.18,.21,.22));yellow=material('floor datum ochre',(.9,.56,.14));ink=material('number labels',(.04,.065,.08));white=material('label face',(.85,.88,.87))
def look(camera,target):camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
def ground_object(name,section=False):
 raw=meshdata['mesh'];p=raw['positions'];verts=[(p[i],-p[i+2],p[i+1]) for i in range(0,len(p),3)];faces=[]
 for i in range(0,len(raw['indices']),3):
  face=raw['indices'][i:i+3]
  if section and sum(verts[j][1] for j in face)/3<1.3:continue
  faces.append(face)
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);o.data.materials.append(concrete);return o
full=ground_object('runtime_ground_mesh');section=ground_object('review_only_front_cutaway',True);section.hide_render=True;section.hide_viewport=True
labels=[]
for d in profile['devices']:
 id=d['model_type'];file=ROOT/('backend/assets/models/pit_furnace_references_v1/PitFurnace'+id.split('_')[2]+'/'+id+'.glb') if id.startswith('pit_furnace_') else ROOT/'backend/assets/models/pit_workshop_aux_v1'/f'{id}.glb'
 before=set(bpy.context.scene.objects);bpy.ops.import_scene.gltf(filepath=str(file));new=list(set(bpy.context.scene.objects)-before)
 meshes=[o for o in new if o.type=='MESH'];corners=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box];lo=Vector(tuple(min(v[k] for v in corners) for k in range(3)));hi=Vector(tuple(max(v[k] for v in corners) for k in range(3)))
 root=bpy.data.objects.new(f"CAD_{d['number']:02}_{d['id']}",None);bpy.context.collection.objects.link(root)
 # Same X/Z-centering and min-Y anchoring as ModelFactory / native GLB loader.
 roots=[o for o in new if o.parent not in new]
 for o in roots:o.parent=root;o.location-=Vector(((lo.x+hi.x)/2,(lo.y+hi.y)/2,lo.z))
 root.location=(d['pos_x'],-d['pos_z'],d['pos_y']);root.rotation_euler.z=d['rotation_y']
 z=7.35 if d['number'] in [1,2] else (-4.1 if d['number']==13 else (-1.4 if d['number']==16 else .95))
 text=bpy.data.curves.new('number','FONT');text.body=str(d['number']);text.size=.6;text.align_x='CENTER';text.extrude=.004
 obj=bpy.data.objects.new('CAD_label_'+str(d['number']),text);bpy.context.collection.objects.link(obj);obj.location=(d['pos_x'],-2.8,z);obj.rotation_euler.x=math.pi/2;obj.data.materials.append(yellow);labels.append(obj)
def box(name,p,size,mat):
 bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat);return o
datum=box('floor_level_zero',(0,-1.8,.025),(61,.025,.025),yellow)
# Neutral studio beneath the site, not a replacement for the runtime floor.
box('section_base',(0,0,-5.12),(67,19,.2),cutmat)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
scene.render.resolution_x=2400;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.world.color=(.2,.22,.24)
for pos,power,size in [((0,-15,28),12000,30),((-27,-5,14),7000,20),((20,16,18),16000,25)]:
 bpy.ops.object.light_add(type='AREA',location=pos);lamp=bpy.context.object;lamp.data.energy=power;lamp.data.shape='DISK';lamp.data.size=size;look(lamp,(0,0,0))
bpy.ops.object.camera_add(location=(27,-44,34));camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=66;look(camera,(0,0,-.5));scene.camera=camera
for o in labels:o.hide_render=True
datum.hide_render=True;scene.render.filepath=str(OUT/'01-industrial-pits-overview.png');bpy.ops.render.render(write_still=True)
full.hide_render=True;section.hide_render=False
for o in labels:o.hide_render=False
datum.hide_render=False;camera.location=(0,-75,8);look(camera,(0,0,.3));camera.data.ortho_scale=63
scene.render.filepath=str(OUT/'02-cad-section-numbered.png');bpy.ops.render.render(write_still=True)
full.hide_render=False;section.hide_render=True;camera.location=(27,-44,34);look(camera,(0,0,-.5));camera.data.ortho_scale=66
for o in labels:o.hide_render=True
datum.hide_render=True
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'pit-workshop-editable-review.blend'))
print('CAD_REVIEW_RESULT',OUT,flush=True)
