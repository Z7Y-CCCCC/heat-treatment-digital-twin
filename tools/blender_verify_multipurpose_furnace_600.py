"""Measure editable parts; reimport the delivered GLB and render evidence."""
from pathlib import Path
import sys,json,hashlib,math
import bpy
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as common
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'backend/assets/models/cad_multipurpose_furnace_600_20261103_v1';REVIEW=OUT/'review';REVIEW.mkdir(exist_ok=True)
item=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))['models'][0]
file=OUT/item['file'];source=OUT/'sources'/(file.stem+'.blend');sha=hashlib.sha256(file.read_bytes()).hexdigest()
assert sha==item['sha256']
bpy.ops.wm.open_mainfile(filepath=str(source));root=bpy.data.objects[item['model_id']+'_root'];bpy.context.view_layer.update()
parts=list(root.children_recursive)
def named(name):return [o for o in parts if o.name==item['model_id']+'_'+name or o.name.startswith(item['model_id']+'_'+name+'.')]
tests=[]
def check(label,actual,expected,tolerance=.0001):tests.append({'check':label,'actual':round(actual,7),'expected':expected,'pass':abs(actual-expected)<=tolerance})
for name,expected in item['detail_features'].items():check(name+' count',len(named(name)),expected,0)
box=common.bounds(parts)
check('overall longitudinal envelope',box[4]-box[1],6.080)
check('overall height from bottom',box[5]-box[2],4.663)
check('bottom datum',box[2],0)
for o in named('cold_tank_base'):
    check('tank base width',o.dimensions.x,2.770);check('tank depth',o.dimensions.y,1.950)
for o in named('cold_tank_inner_skid'):check('inner base width',o.dimensions.x,2.640)
for o in named('hot_foundation_skid'):
    check('hot skid bottom / floor datum',o.location.z-o.dimensions.z/2,.400)
    check('hot skid height',o.dimensions.z,.160)
for o in named('arched_outer_roof'):check('hot roof width',o.dimensions.x,2.372)
basket=[o for o in named('load_roller') if 'elevator_basket' in o.parent.name]
check('basket working level',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in basket),1.630)
jambs=sorted(named('front_jamb'),key=lambda o:o.location.x)
check('door clear jamb spacing',jambs[1].location.x-jambs[1].dimensions.x/2-(jambs[0].location.x+jambs[0].dimensions.x/2),.600)
for o in named('inner_jamb'):check('door clear height',o.dimensions.z,.650)
normalization=json.loads((ROOT/'output/cad-multipurpose-600-20261103/readable/multipurpose_furnace_600.normalization.json').read_text(encoding='utf8'))
report={'file':file.name,'sha256':sha,'source_blend_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'tests':tests,'pass':all(t['pass'] for t in tests),'normalization':normalization}
(REVIEW/'measurements.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print('MEASUREMENTS '+json.dumps(report,ensure_ascii=False),flush=True)
assert report['pass'],[t for t in tests if not t['pass']]

# Freshly imported GLB, with unchanged file hash, for all following views.
bpy.ops.wm.read_factory_settings(use_empty=True);common.palette();common.SOURCES[item['source']['id']]=item['source']
a=common.Asset(item['source']['id'],item['name'],file.stem,item['reference_dimensions_mm'],item['notes'])
bpy.data.objects.remove(a.root,do_unlink=True);bpy.ops.import_scene.gltf(filepath=str(file));a.root=bpy.data.objects[item['model_id']+'_root'];bpy.context.view_layer.update()
camera,center,span=common.studio(a,common.bounds(list(a.root.children_recursive)));a.scene.cycles.samples=12
a.scene.render.resolution_x=1600;a.scene.render.resolution_y=1000
shots=[('overall',Vector((0,1.75,2.18)),Vector((7,-9,6)),7.5),
       ('transmission',Vector((-.71,.40,2.28)),Vector((-5,2,1.5)),3.0),
       ('rear',Vector((0,2.7,2.28)),Vector((-7,9,5)),7.1)]
def fit_visible(target):
    bpy.context.view_layer.update();inv=camera.matrix_world.inverted()
    points=[inv@(obj.matrix_world@v.co) for obj in a.root.children_recursive if obj.type=='MESH' and not obj.hide_render for v in obj.data.vertices]
    lo=[min(p[i] for p in points) for i in [0,1]];hi=[max(p[i] for p in points) for i in [0,1]]
    shift=camera.matrix_world.to_3x3()@Vector(((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,0))
    camera.location+=shift;common.look(camera,target+shift)
    camera.data.ortho_scale=max(hi[0]-lo[0],(hi[1]-lo[1])*a.scene.render.resolution_x/a.scene.render.resolution_y)*1.10
renders=[]
for name,target,direction,scale in shots:
    camera.location=target+direction;camera.data.ortho_scale=scale;common.look(camera,target)
    hidden=[]
    if name=='transmission':
        for group in a.root.children:
            if group.get('part') in ['extraction','hood_fittings','electrics']:
                for obj in group.children_recursive:hidden.append((obj,obj.hide_render));obj.hide_render=True
    else:fit_visible(target)
    picture=REVIEW/(name+'.png');a.scene.render.filepath=str(picture);bpy.ops.render.render(write_still=True);renders.append(picture.name)
    for obj,hidden_state in hidden:obj.hide_render=hidden_state
for group in a.root.children:
    if group.get('part') in ['hot_housing','hot_roof_end_caps','cold_housing','lining','quench_tank','tank_lids','quench_liquid','extraction','partition_shell','refractory','side_feed_return','hot_access_panels','hot_rear_hatch','cold_front_hatches','cold_rear_hatches','upper_service_panels','door']:
        for obj in group.children_recursive:obj.hide_render=True
target=Vector((0,1.97,1.94));camera.location=target+Vector((6,-8,5));camera.data.ortho_scale=6.8;common.look(camera,target)
fit_visible(target)
picture=REVIEW/'cutaway.png';a.scene.render.filepath=str(picture);bpy.ops.render.render(write_still=True);renders.append(picture.name)
assert sha==hashlib.sha256(file.read_bytes()).hexdigest()
(REVIEW/'rendered-glb-evidence.json').write_text(json.dumps({'file':file.name,'sha256':sha,'renders':renders},ensure_ascii=False,indent=2),encoding='utf8')
print('GLB_REVIEW_DONE '+json.dumps({'file':file.name,'checks':len(tests),'renders':renders}),flush=True)
