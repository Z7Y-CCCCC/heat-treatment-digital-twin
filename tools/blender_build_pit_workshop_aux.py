"""CAD elevation study: reusable mid-detail auxiliary assets, not manufacturing CAD.
Blender --background --factory-startup --python tools/blender_build_pit_workshop_aux.py
Exports editable procedural geometry as separate metre-scale GLBs. Original furnaces untouched.
"""
import bpy, math, json, os
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'backend/assets/models/pit_workshop_aux_v1'
OUT.mkdir(parents=True,exist_ok=True)
def mat(name,color,metal=.6,rough=.35):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=rough
 return m
STEEL=mat('galvanized structural steel',(.27,.34,.38));DARK=mat('recessed steel',(.065,.09,.11));PAINT=mat('painted equipment teal',(.14,.28,.29),.3);YELLOW=mat('safety ochre',(.84,.52,.09),.25);STOCK=mat('heat treated rings',(.32,.29,.25),.8);SILVER=mat('machined fasteners',(.55,.58,.59),.9)
def box(name,p,size,material=STEEL,bevel=.015):
 bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material)
 if bevel:mod=o.modifiers.new('edge machining','BEVEL');mod.width=bevel;mod.segments=2
 return o
def cyl(name,p,r,h,material=STEEL,axis='Z',vertices=24):
 bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=r,depth=h,location=p);o=bpy.context.object;o.name=name
 if axis=='Y':o.rotation_euler[0]=math.pi/2
 if axis=='X':o.rotation_euler[1]=math.pi/2
 o.data.materials.append(material)
 for f in o.data.polygons:f.use_smooth=len(f.vertices)==4
 return o
def beam(name,a,b,w=.065,material=STEEL):
 a,b=Vector(a),Vector(b);o=box(name,(a+b)/2,(w,w,(b-a).length),material,.008);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o
def ibeam(name,p,height):
 x,y,z=p
 box(name+'_web',(x,y,z+height/2),(.07,.13,height))
 for dx in [-.11,.11]:box(name+'_flange',(x+dx,y,z+height/2),(.05,.26,height))
 box(name+'_anchor_plate',(x,y,z+.045),(.42,.42,.09),DARK)
 for dx in [-.14,.14]:
  for dy in [-.14,.14]:cyl(name+'_anchor_bolt',(x+dx,y+dy,z+.11),.032,.06,SILVER,vertices=8)
def deck(w,d,h,rollers=False):
 for x in [-w/2,w/2]:box('deck_edge',(x,0,h),(.15,d+.2,.2))
 for y in [-d/2,d/2]:box('end_crossbeam',(0,y,h),(w,.15,.2))
 for i in range(12):
  x=-w/2+.16+(w-.32)*i/11
  if rollers:cyl('transfer_roller',(x,0,h+.14),.075,d-.12,SILVER,'Y',20)
  else:box('grating_bar',(x,0,h+.12),(.055,d-.12,.055),SILVER,.005)
 for y in [-d*.25,d*.25]:box('grating_support',(0,y,h+.07),(w,.045,.045),DARK,.005)
 for x in [-w*.4,w*.4]:box('replaceable_load_pad',(x,0,h+.2),(.26,.9,.09),DARK)
def tower(w=2.25,d=2.4,h=4.5,rollers=False):
 for x in [-w/2+.08,w/2-.08]:
  for y in [-d/2+.08,d/2-.08]:ibeam('column',(x,y,0),h)
 for z in [.45,h*.5,h-.1]:
  for y in [-d/2,d/2]:box('frame_tie',(0,y,z),(w,.12,.16))
 for x in [-w/2,w/2]:
  beam('diagonal_brace',(x,-d/2,.4),(x,d/2,h-.2))
  beam('cross_brace',(x,d/2,.4),(x,-d/2,h-.2))
 deck(w,d,h,rollers)
 for x in [-w/2,w/2]:box('yellow_edge_stop',(x,0,h+.19),(.12,.75,.11),YELLOW)
def base():
 for y in [-1.25,1.25]:box('longitudinal_skid',(0,y,.17),(8.7,.24,.32),DARK)
 for x in [-4,-2,0,2,4]:
  box('transverse_tie',(x,0,.23),(.18,2.7,.3))
  for y in [-1.25,1.25]:box('sole_plate',(x,y,.055),(.55,.55,.11))
 for x in [-3.6,-1.2,1.2,3.6]:cyl('drive_shaft',(x,0,.36),.09,2.35,SILVER,'Y')
def ring(name,p,outer,inner,length):
 verts=[];faces=[];n=48
 for yy in [-length/2,length/2]:
  for r in [outer,inner]:
   for i in range(n):verts.append((p[0]+r*math.cos(i*2*math.pi/n),p[1]+yy,p[2]+r*math.sin(i*2*math.pi/n)))
 for i in range(n):
  j=(i+1)%n
  faces.extend([(i,j,2*n+j,2*n+i),(n+i,3*n+i,3*n+j,n+j),(i,n+i,n+j,j),(2*n+i,2*n+j,3*n+j,3*n+i)])
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);mesh.materials.append(STOCK)
 for i,face in enumerate(mesh.polygons):face.use_smooth=(i%4)<2
def rack():
 for y in [-1,1]:box('forklift_pallet_runner',(0,y,.13),(2.8,.22,.26),DARK)
 for x in [-1.25,-.42,.42,1.25]:box('pallet_crossmember',(x,0,.26),(.14,2.35,.18))
 for row in range(3):
  for col in range(3):ring('stored_hollow_ring',(col*.81-.81,0,.75+row*.78),.365,.225,1.85)
 for x in [-1.35,1.35]:
  for y in [-1.08,1.08]:box('stacking_post',(x,y,1.45),(.1,.1,2.8),PAINT);box('post_guard',(x,y,.55),(.12,.12,.7),YELLOW)
 for y in [-1.08,1.08]:box('anti_roll_rail',(0,y,.4),(2.8,.08,.08),PAINT)
def tank():
 for y in [-.75,.75]:box('skid',(0,y,.09),(2.35,.15,.18),DARK)
 for z in [.22,2.18]:cyl('tank_flange',(-.45,0,z),.52,.1,SILVER)
 cyl('cylindrical_reservoir',(-.45,0,1.2),.46,1.95,PAINT,vertices=32)
 cyl('top_cap',(-.45,0,2.27),.43,.12,SILVER)
 for angle in range(0,360,45):
  a=math.radians(angle);cyl('flange_bolt',(-.45+.48*math.cos(a),.48*math.sin(a),2.26),.027,.09,DARK,vertices=8)
 cyl('pump_motor',(.65,0,.62),.25,.72,PAINT,'Y')
 for i in range(8):box('motor_fin',(.65+.23*math.cos(i*math.pi/4),0,.62+.23*math.sin(i*math.pi/4)),(.035,.75,.035),DARK,.004)
 beam('service_riser',(-.35,-.52,.5),(-.35,-.52,2.9),.07,SILVER)
 beam('pipe_to_tank',(-.35,-.52,2.9),(-.45,0,2.9),.07,SILVER)
 beam('pump_connection',(-.35,-.52,.5),(.65,-.52,.5),.07,SILVER)
 cyl('handwheel',(-.35,-.55,1.1),.13,.04,YELLOW,'Y')
def look(camera,target):camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
def studio():
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.use_denoising=True
 scene.render.resolution_x=900;scene.render.resolution_y=900;scene.render.resolution_percentage=100
 scene.world.color=(.22,.22,.22)
 for p,power,size in [((3,-4,8),1400,6),((-4,-1,5),1000,5),((1,5,7),1800,5)]:
  bpy.ops.object.light_add(type='AREA',location=p);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=size;look(o,(0,0,1.8))
 bpy.ops.object.camera_add(location=(8,-10,7));camera=bpy.context.object;camera.data.type='ORTHO';scene.camera=camera;return camera
def export(id,name,build):
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);build()
 objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
 for o in objects:
  bpy.context.view_layer.objects.active=o
  for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
 # Join static pieces by material to keep draw calls bounded without baking textures.
 for material in [STEEL,DARK,PAINT,YELLOW,STOCK,SILVER]:
  group=[o for o in bpy.context.scene.objects if o.type=="MESH" and o.data.materials and o.data.materials[0]==material]
  if not group:continue
  bpy.ops.object.select_all(action='DESELECT')
  for o in group:o.select_set(True)
  bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join();group[0].name=id+'_'+material.name.replace(' ','_')
 meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'];bpy.ops.object.select_all(action='DESELECT')
 for o in meshes:o.select_set(True)
 bpy.ops.export_scene.gltf(filepath=str(OUT/(id+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_animations=False)
 corners=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box];lo=Vector(tuple(min(v[k] for v in corners) for k in range(3)));hi=Vector(tuple(max(v[k] for v in corners) for k in range(3)))
 triangles=sum(len(p.vertices)-2 for o in meshes for p in o.data.polygons)
 metadata={'schema_version':1,'runtime':{'enableGenericBindings':False,'enableInspection':False},'partBindings':[],'inspection':{'enabled':False,'parts':[]},'assetSpec':{'unit':'m','device_family':'CAD车间辅助设施','delivery_status':'review','notes':'截图估算重建，不是制造模型。'},'bounds_m':list(hi-lo),'triangles':triangles,'meshCount':len(meshes)}
 (OUT/(id+'.json')).write_text(json.dumps({'id':id,'name':name,'metadata':metadata},ensure_ascii=False,indent=2),encoding='utf-8')
 camera=studio();center=(lo+hi)/2;camera.location=center+Vector((8,-10,7));look(camera,center);camera.data.ortho_scale=max(hi-lo)*1.65
 box('studio_floor',(center.x,center.y,lo.z-.08),(100,100,.1),mat('studio concrete',(.17,.19,.2),0,.8),0)
 bpy.context.scene.render.filepath=str(OUT/(id+'_preview.png'));bpy.ops.render.render(write_still=True)
 print('ASSET_RESULT',id,triangles,len(meshes),flush=True)
if __name__=='__main__':
 for id,name,fn in [('pit_cad_loading_tower_v1','CAD 工装料台',tower),('pit_cad_transfer_base_v1','CAD 料台移载底架',base),('pit_cad_cooling_bay_v1','CAD 冷却暂存料台',lambda:tower(2.9,2.4,4.5,True)),('pit_cad_stock_rack_v1','CAD 环件堆料架',rack),('pit_cad_service_tank_v1','CAD 炉旁循环罐与泵组',tank)]:
  if not os.environ.get('PIT_AUX_ONLY') or os.environ['PIT_AUX_ONLY']==id:export(id,name,fn)
