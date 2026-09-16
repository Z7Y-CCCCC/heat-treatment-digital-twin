"""Standalone low-poly cutaway factory study; preserves existing scenes."""
from pathlib import Path
import math
import bpy
from mathutils import Vector

OUT = Path(__file__).resolve().parents[1] / 'backend/assets/models/factory_hall_study'
OUT.mkdir(parents=True, exist_ok=True)
scene = bpy.data.scenes.new('Factory Hall Cutaway Study')
bpy.context.window.scene = scene
mats = {}
for name, color, metal, rough in [
    ('wall', (.30,.30,.30), .15,.65),
    ('trim', (.46,.46,.46), .35,.4),
    ('floor', (.50,.50,.50), .15,.38),
    ('glass', (.49,.49,.49), .1,.28),
    ('road', (.14,.14,.14), 0,.8),
    ('mark', (.68,.68,.68), 0,.7),
    ('steel', (.42,.42,.42), .6,.38),
]:
    mat = bpy.data.materials.new('Hall_' + name)
    mat.diffuse_color = (*color,1)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color,1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if name == 'glass':
        bsdf.inputs['Emission Color'].default_value = (.02,.02,.02,1)
        bsdf.inputs['Emission Strength'].default_value = .04
    mats[name] = mat

def box(name, pos, size, mat='wall', bevel=.035):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mats[mat])
    if bevel:
        mod = obj.modifiers.new('Edge highlights','BEVEL')
        mod.width = bevel
        mod.segments = 1
        obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return obj

# Metres; central production bay is deliberately empty for live equipment.
box('Foundation', (0,0,-.35), (100,80,.7),'trim')
box('Production floor', (0,0,.01), (84,62,.12),'floor')
box('Front service road', (0,-36,.025), (98,7,.1),'road')
# Keep the service road as a clean architectural surface. Small painted
# dashes alias into broken white lines in the Unity overview camera.

def facade(name, length, pos, angle=0, height=8):
    root = bpy.data.objects.new(name,None)
    scene.collection.objects.link(root)
    start = set(scene.objects)
    box(name+' sill',(0,0,1.5),(length,.55,3))
    box(name+' lintel',(0,0,height-.8),(length,.55,1.6))
    count = max(1,round(length/5))
    pitch = length/count
    for i in range(count):
        x = -length/2+(i+.5)*pitch
        box(name+' pier',(x-pitch/2,0,height/2),(.65,.7,height),'wall')
        box(name+' window',(x,0,4.7),(pitch-1.65,.2,2.6),'glass',0)
    box(name+' coping',(0,0,height+.05),(length+.3,.8,.18),'trim')
    for obj in set(scene.objects)-start:
        obj.parent = root
    root.location = pos
    root.rotation_euler.z = angle

facade('Rear facade',84,(0,31,0),height=10)
facade('East facade',62,(42,0,0),math.pi/2,height=8)
facade('West facade',62,(-42,0,0),math.pi/2,height=8)
# Split front elevation gives a genuine opening, not a painted-on door.
facade('Front left',34,(-25,-31,0),height=6.6)
facade('Front right',34,(25,-31,0),height=6.6)
box('Entrance header',(0,-31,6),(16,.6,1.2))
box('Loading canopy',(0,-33,4.5),(17,5,.2),'trim')
for x in (-7.5,7.5):
    box('Canopy support',(x,-35,2.25),(.18,.18,4.5),'steel')
box('Loading apron',(0,-32,.12),(16,4,.2),'floor')

# Rear utility rooms and mezzanine create depth without crowding the machinery.
box('Utility partition',(0,22,2),(83,.35,4))
for x in (-28,-10,12,28):
    box('Utility cross wall',(x,26.5,2),(.3,9,4))
box('Rear partial roof',(0,27,7.5),(84,8,.25),'trim')
for x in (-35,-21,-7,7,21,35):
    box('Structural column',(x,18,4.3),(.45,.45,8.6),'steel')
box('Crane runway',(0,18,8.3),(76,.5,.7),'steel')
for x in (-24,24):
    box('Crane bridge',(x,3,8.3),(.6,30,.6),'steel')
    box('Bridge end support',(x,-12,4.1),(.45,.45,8.2),'steel')
for x in (-35,-21,-7,7,21,35):
    box('Utility cabinet',(x,27,1.4),(2,1.2,2.8),'trim')
# Architectural detail stays at the perimeter: the live production equipment
# owns the central bay, and must not be duplicated or covered by scenery.
for x in (-32,-16,0,16,32):
    box('Rooflight curb',(x,27,7.73),(6,2.6,.18),'steel')
    box('Rooflight glazing',(x,27,7.85),(5.7,2.3,.08),'glass',0)
for x in (-40,40):
    box('Side eave',(x,0,8.15),(3.6,62,.22),'trim')
    for y in range(-26,27,13):
        box('Portal column',(x,y,4),(.5,.65,8),'steel')
        box('Column foot',(x,y,.23),(.95,1.1,.4),'trim')
        box('Wall luminaire',(x*.97,y,6.8),(.24,1.5,.12),'glass')

def beam_between(name, start, end, width=.12):
    a, b = Vector(start), Vector(end)
    obj = box(name,(a+b)/2,(width,width,(b-a).length),'steel',0)
    obj.rotation_euler = (b-a).to_track_quat('Z','Y').to_euler()
    return obj

# Restore the authored cutaway roof structure, retaining the open equipment bay.
for y in (18,):
    box('Truss bottom chord',(0,y,9),(80,.24,.24),'steel')
    box('Truss top chord',(0,y,10.4),(80,.24,.24),'steel')
    for x in range(-40,40,5):
        beam_between('Truss diagonal',(x,y,9),(x+5,y,10.4))
        beam_between('Truss vertical',(x,y,9),(x,y,10.4))

# Compact service fittings on the exterior, no additional buildings.
for x in (-34,-22,22,34):
    box('Ventilation housing',(x,-31.7,2.1),(2.4,1.1,1.5),'trim')
    for z in (1.6,1.85,2.1,2.35,2.6):
        box('Vent grille',(x,-32.28,z),(2.05,.05,.06),'steel',0)
for x in (-40,-12,12,40):
    box('Rainwater downpipe',(x,-31.55,3.2),(.13,.13,6.4),'steel')
# The hall is intentionally kept clean in the overview; pipe racks belong in
# a detailed production-line view, not in this architectural backdrop.

# Rear storage shelves and pallets give scale without inventing extra machines.
for x in (-34,-20,20,34):
    for dx in (-2.6,2.6):
        for y in (24,26):
            box('Storage upright',(x+dx,y,1.7),(.12,.12,3.4),'steel')
    for z in (.25,1.7,3.15):
        box('Storage shelf',(x,25,z),(5.5,2.3,.12),'trim')
    for dx in (-1.5,1.5):
        box('Stored pallet',(x+dx,25,.5),(2.2,1.7,.25),'steel')
        box('Stored material',(x+dx,25,1),(2,1.5,.7),'trim')
# No pedestrian or entrance dash markings in the clean overview asset.

# Export only architecture, excluding presentation camera and lighting.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(OUT/'factory_hall_lowpoly.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True)
world = bpy.data.worlds.new('Hall studio world')
world.use_nodes = True
background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
background.inputs[0].default_value = (.16,.16,.16,1)
background.inputs[1].default_value = .5
scene.world = world
def aim(obj,target):
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
for name,pos,power,size,color in [
    ('Key',(-25,-15,65),85000,50,(1,1,1)),
    ('Fill',(45,15,40),45000,35,(.92,.92,.92)),
    ('Rim',(-35,45,35),50000,30,(.90,.90,.90)),
]:
    data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.shape='DISK'; data.size=size; data.color=color
    obj=bpy.data.objects.new(name,data); scene.collection.objects.link(obj); obj.location=pos; aim(obj,(0,0,0))
data=bpy.data.cameras.new('Study camera'); camera=bpy.data.objects.new('Study camera',data)
scene.collection.objects.link(camera); camera.location=(105,-135,105); aim(camera,(0,0,1))
data.type='ORTHO'; data.ortho_scale=139; scene.camera=camera
scene.render.engine='CYCLES'; scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.resolution_x=1500; scene.render.resolution_y=1050; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath=str(OUT/'preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'factory_hall_study.blend'),copy=True)
bpy.ops.render.render(write_still=True)
print('Factory hall exported to',OUT)
