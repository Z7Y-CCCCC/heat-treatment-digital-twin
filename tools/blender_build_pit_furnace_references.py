"""Five independent CAD-image-derived pit-furnace studies, 2026-10-29.

Run Blender --background --factory-startup --python this_file.
The five CAD references define separate models; the later user correction for
furnace 5 defines a cabinet-depth furnace, not a freestanding door or open frame. No real scale or
plan dimensions were provided: depths and dimensions are explicitly estimates.
All exports are isolated from production models and the existing Factory scene.
"""
from __future__ import annotations
import importlib.util
import json
import math
import os
import shutil
from collections import defaultdict
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'backend/assets/models/pit_furnace_references_v1'
UNITY = ROOT / 'unity-client/Assets/Equipment/PitFurnaceReferences'
SOURCE_BLEND = ROOT / 'backend/assets/models/photo_equipment_models_v6_study.blend'
REFS = [
    'codex-clipboard-b823ec57-da7b-4cef-b295-90e2bc5899dd.png',
    'codex-clipboard-b0bac913-73be-4e15-80bb-2f45c8fc5a4e.png',
    'codex-clipboard-141f63ef-ad6c-4ffa-8de8-b2ddb70fbb21.png',
    'codex-clipboard-5d338336-824e-49eb-ae4a-bb72c9e60274.png',
    'codex-clipboard-3147396e-26e3-4f06-8b06-908810ca93e3.png',
]
REFERENCE_CORRECTIONS = {
    5: 'codex-clipboard-2c8fda05-bb20-44a6-a48f-6d2e85812a06.jpg',
}


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Asset:
    def __init__(self, number):
        self.number = number
        self.id = f'pit_furnace_{number}_v1'
        self.out = OUT / f'PitFurnace{number}'
        self.unity = UNITY / f'PitFurnace{number}'
        self.out.mkdir(parents=True, exist_ok=True)
        self.unity.mkdir(parents=True, exist_ok=True)
        self.base = module(ROOT / 'tools/blender_build_multipurpose_furnace_v6.py', f'_pit_geometry_{number}')
        self.base.PREFIX = f'pf{number}_'
        self.scene = bpy.data.scenes.new(f'井式炉{number}_EDIT')
        self.scene['asset_id'] = self.id
        self.scene['dimensional_accuracy'] = 'Image-derived visual estimate; no dimensioned CAD supplied'
        bpy.context.window.scene = self.scene
        self.scene.unit_settings.system = 'METRIC'
        self.scene.unit_settings.scale_length = 1.0
        self.base.ROOT = self.base.empty(self.id + '_editable_root')
        self.root = self.base.ROOT
        self.root['display_name'] = f'井式炉{number}'
        self.root['reference'] = REFS[number-1]
        if number in REFERENCE_CORRECTIONS:
            self.root['reference_correction'] = REFERENCE_CORRECTIONS[number]
            self.root['body_interpretation'] = 'Solid enclosed cabinet furnace; not a freestanding door or panel'
            self.root['cabinet_depth_m'] = 1.65
        self.root['depth_is_estimated'] = True
        self.groups = {}
        self.materials()
        # The old primitive source had some inward box face orders. Fix newly
        # generated meshes locally without touching old source or old assets.
        raw_mesh = self.base.mesh
        def oriented(*args, **kwargs):
            obj = raw_mesh(*args, **kwargs)
            bm = bmesh.new()
            try:
                bm.from_mesh(obj.data)
                if bm.edges and all(e.is_manifold for e in bm.edges):
                    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
                    bm.to_mesh(obj.data)
                    obj.data.update()
            finally:
                bm.free()
            return obj
        self.base.mesh = oriented

    def __getattr__(self, name):
        if name in {'box','mesh','cylinder','rod','tube','pipe','beam','empty','motor','gauge','bolts','handwheel','label'}:
            return getattr(self.base, name)
        raise AttributeError(name)

    def materials(self):
        if not bpy.data.materials.get('v6_enamel'):
            with bpy.data.libraries.load(str(SOURCE_BLEND), link=False) as (src, dst):
                dst.materials = [n for n in src.materials if n.startswith('v6_')]
        self.base.MATS = {m.name[3:]:m for m in bpy.data.materials if m.name.startswith('v6_')}
        needed = {'enamel','enamel_edge','stainless','brushed_metal','dark_structure','heat_black','gasket',
                  'safety_yellow','motor_teal','motor_blue','brass','red','dial','refractory','floor'}
        assert needed.issubset(self.base.MATS), needed - self.base.MATS.keys()

    def group(self, name, loc=(0,0,0), dynamic=False):
        assert name not in self.groups, name
        obj = self.base.empty(f'pf{self.number}_{name}', self.root, loc)
        obj['functional_group'] = name
        obj['preserve_animation'] = dynamic
        obj['removable_cover'] = name.startswith('external_cover')
        self.groups[name] = obj
        return obj

    def rounded_panel(self, name, loc, width, height, depth, radius, mat, parent):
        outline = []
        for cx,cz,start in [(width/2-radius,height/2-radius,0),(-width/2+radius,height/2-radius,90),
                            (-width/2+radius,-height/2+radius,180),(width/2-radius,-height/2+radius,270)]:
            for k in range(9):
                angle = math.radians(start+k*90/8)
                outline.append((cx+radius*math.cos(angle),cz+radius*math.sin(angle)))
        n = len(outline)
        verts = [(x,y,z) for y in (-depth/2,depth/2) for x,z in outline]
        faces = [tuple(reversed(range(n))),tuple(range(n,2*n))]
        faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        obj = self.mesh(name,verts,faces,mat,parent,min(.009,depth/4))
        obj.location = loc
        return obj

    def helix(self, name, x, y, z, radius, height, parent):
        pts = []
        for i in range(121):
            angle = i/120*math.tau*7
            pts.append((x+radius*math.cos(angle),y+radius*math.sin(angle),z+i/120*height))
        return self.pipe(name,pts,.008,'safety_yellow',parent,.001)


def slotted_bridge(a,g,name,z,y,width=1.6):
    # A manufactured open-web beam with actual rectangular holes.
    for zz in (z-.043,z+.043):
        a.box(name+'_flange',(0,y,zz),(width,.13,.025),'stainless',g,.002)
    for i in range(19):
        x=-width/2+i*width/18
        a.box(name+'_web',(x,y,z),(.024,.055,.065),'brushed_metal',g,.002)


def suspended_fixture(a,z0,z1,width=.96,y=-.08):
    g=a.group('suspended_fixture',dynamic=True)
    for x in (-width/2,width/2):
        a.box('fixture_side_flat',(x,y,(z0+z1)/2),(.025,.09,z1-z0),'stainless',g,.002)
    for z in (z0,z1):
        a.box('fixture_end_plate',(0,y,z),(width,.10,.034),'brushed_metal',g,.003)
    for x in (-width/6,width/6):
        a.rod('suspension_tie',(x,y,z0),(x,y,z1),.009,'stainless',g)
    a.bolts('fixture_lifting_eye',[(-width/2,y-.06,z1),(0,y-.06,z1),(width/2,y-.06,z1)],g,'Y',.019)
    return g


def top_drive(a,top,front_y):
    g=a.group('top_lift_drive')
    for x in (-.38,.38):
        for y in (front_y-.06,front_y+.34):
            a.rod('lift_support_post',(x,y,top),(x,y,top+.55),.024,'stainless',g)
            for z in (top+.04,top+.48):
                a.box('support_bearing',(x,y,z),(.12,.12,.055),'enamel_edge',g,.006)
                a.cylinder('bearing_collar',(x,y,z+.035),.044,.028,'brushed_metal',g)
    a.box('drive_crossbeam',(0,front_y+.14,top+.53),(1.03,.51,.075),'enamel_edge',g,.008)
    a.box('drive_gearcase',(0,front_y+.14,top+.78),(.40,.40,.40),'motor_teal',g,.03)
    a.cylinder('gearcase_round_inspection',(0,front_y-.075,top+.78),.105,.035,'brushed_metal',g,'Y',40)
    a.cylinder('gearcase_cap',(0,front_y-.095,top+.78),.083,.012,'motor_teal',g,'Y',32)
    for i in range(6):
        t=i*math.tau/6
        a.bolts('gearcap_bolt',[(.091*math.cos(t),front_y-.118,top+.78+.091*math.sin(t))],g,'Y',.009)
    a.motor('lift_motor',(.30,front_y+.14,top+.79),.59,'X',g)
    for x in (-.23,.23):
        a.beam('gear_support_strap',(x,front_y-.03,top+.55),(x,front_y-.03,top+.97),.031,'brushed_metal',g)
    a.box('gearcase_roof',(0,front_y+.14,top+1.015),(.5,.51,.05),'enamel_edge',g,.007)
    for x in (-.060,.060):
        for y in (front_y+.08,front_y+.20):
            a.rod('spindle_guard_stay',(x,y,top+1.03),(x,y,top+1.37),.008,'brushed_metal',g)
    for z in (top+1.04,top+1.37):
        a.box('spindle_guard_cap',(0,front_y+.14,z),(.145,.16,.025),'enamel_edge',g,.004)
    a.rod('drive_central_shaft',(0,front_y+.14,top-.46),(0,front_y+.14,top+1.30),.022,'stainless',g)
    for z,r,h in [(top-.37,.072,.075),(top-.05,.060,.045),(top+.14,.081,.13),(top+.26,.060,.035)]:
        a.cylinder('spindle_coupling',(0,front_y+.14,z),r,h,'brushed_metal',g,sides=24)
    for j in range(7):
        a.cylinder('spindle_bellows',(0,front_y+.14,top+.10+j*.021),.066,.010,'gasket',g)
    a.rod('hand_adjust_shaft',(.13,front_y+.14,top+.25),(.27,front_y+.14,top+.25),.012,'stainless',g)
    a.handwheel('spindle_lock',(.27,front_y+.10,top+.25),g,.039)
    g=a.group('upper_spring_bridge')
    slotted_bridge(a,g,'pierced_crosshead',top-.49,front_y+.14)
    for x in (-.21,0,.21):
        a.rod('spring_guide',(x,front_y+.14,top-.48),(x,front_y+.14,top-.15),.013,'stainless',g)
        a.helix('counterbalance_spring',x,front_y+.14,top-.44,.035,.22,g)
        for z in (top-.455,top-.20):
            a.cylinder('spring_seat',(x,front_y+.14,z),.048,.023,'brushed_metal',g)
    a.box('spring_top_yoke',(0,front_y+.14,top-.165),(.55,.15,.047),'enamel_edge',g)
    for x in (-.34,.34):
        a.rod('fixture_guide',(x,front_y+.14,top-.86),(x,front_y+.14,top-.39),.013,'stainless',g)


def cart_base(a,extension_right):
    sign=1 if extension_right else -1
    g=a.group('mobile_chassis')
    for y in (-.85,.85):
        for z in (.27,.45):
            a.box('chassis_flange',(0,y,z),(3.63,.24,.046),'dark_structure',g)
        a.box('chassis_web',(0,y,.36),(3.63,.10,.17),'brushed_metal',g)
    for x in (-1.58,-.65,.65,1.58):
        a.box('crossmember',(x,0,.36),(.13,1.78,.18),'dark_structure',g)
    for x in (-1.40,0,1.40):
        for y in (-.83,.83):
            a.box('support_foot',(x,y,.49),(.26,.26,.036),'enamel_edge',g)
            a.box('support_upright',(x,y,.74),(.095,.13,.48),'enamel_edge',g)
            for dx in (-.11,.11):
                a.beam('post_gusset',(x+dx,y,.5),(x,y,.70),.035,'brushed_metal',g)
            a.bolts('chassis_anchor',[(x-.084,y,.52),(x+.084,y,.52)],g,'Z',.015)
    for i,(x,y) in enumerate([(-1.62,-.84),(1.62,-.84),(-1.62,.84),(1.62,.84)]):
        w=a.group('wheel_%02d'%i,(x,y,.16),True)
        a.cylinder('wheel_tread',(0,0,0),.15,.125,'dark_structure',w,'Y',40)
        for yy in (-.073,.073):
            a.cylinder('wheel_rim',(0,yy,0),.122,.019,'stainless',w,'Y',32)
            a.cylinder('wheel_hub',(0,yy*1.20,0),.055,.023,'brushed_metal',w,'Y',24)
            a.cylinder('axle_bolt',(0,yy*1.45,0),.027,.024,'stainless',w,'Y',6)
            a.box('wheel_cheek',(0,yy,.095),(.21,.023,.23),'enamel_edge',w,.02)
        a.box('wheel_top_bracket',(0,0,.20),(.26,.23,.045),'dark_structure',w)
    g=a.group('transfer_extension')
    x0,x1=sorted((sign*-1.30,sign*3.59))
    for y in (-.69,.69):
        a.box('transfer_beam',((x0+x1)/2,y,.91),(x1-x0,.095,.14),'brushed_metal',g)
        a.box('track_wear_strip',((x0+x1)/2,y,.995),(x1-x0,.10,.035),'stainless',g,.002)
    for i in range(18):
        x=x0+.12+i*(x1-x0-.24)/17
        a.cylinder('transfer_roller',(x,0,1.025),.038,1.19,'brushed_metal',g,'Y',16)
        for y in (-.655,.655):
            a.box('roller_bearing',(x,y,1.03),(.087,.069,.075),'motor_teal',g,.007)
            a.cylinder('bearing_hex_cap',(x,y*1.066,1.03),.019,.011,'stainless',g,'Y',6)
    for y in (-.76,.76):
        a.box('extension_folded_guard',(sign*2.25,y,.965),(2.73,.035,.38),'enamel',g,.006)
        a.box('guard_top_return',(sign*2.25,y,1.16),(2.73,.08,.025),'enamel_edge',g,.002)
    a.box('extension_end_guard',(sign*3.62,0,.995),(.04,1.56,.40),'enamel_edge',g,.006)
    # Slope on the outer shield matches the CAD transfer hood silhouette.
    for y in (-.765,.765):
        vertices=[(sign*x,yy,z) for yy in (y-.012,y+.012) for x,z in ((1.24,1.17),(2.85,1.17),(1.24,1.36))]
        a.mesh('sloped_transfer_shield',vertices,[(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)],'enamel',g,.002)
    a.box('extension_upper_table',(sign*2.05,0,1.17),(1.66,1.40,.045),'enamel',g)
    for y in (-.51,.51):
        a.rod('drive_parallel_shaft',(x0,y,.79),(x1,y,.79),.018,'stainless',g)
    a.motor('transfer_gearmotor',(sign*.96,-.54,.75),.62,'Y',g)
    if extension_right:
        # CAD1 also shows a short, open through-transfer rail to the left.
        # This is absent from CAD4 and must not be mirrored onto that unit.
        for y in (-.69,.69):
            for z in (.87,1.12):
                a.box('left_short_through_rail',(-1.77,y,z),(.98,.045,.041),'brushed_metal',g,.002)
            for x in (-2.25,3.65):
                a.box('transfer_vertical_end_stop',(x,y,1.025),(.035,.070,.64),'dark_structure',g,.003)
                a.box('end_stop_safety_cap',(x,y,1.357),(.058,.082,.028),'safety_yellow',g,.004)
            for x in (-2.20,-1.85,-1.5):
                a.box('short_rail_web',(x,y,.995),(.027,.044,.22),'enamel_edge',g,.001)
    g=a.group('base_guardrails')
    # Low guards around carriage, not full-height walkways invented from CAD.
    for y in (-.91,.91):
        for x in (-1.32,-.02,1.32):
            a.rod('guard_stanchion',(x,y,.48),(x,y,1.47),.014,'stainless',g)
        for z in (1.11,1.47):
            a.rod('low_guard_rail',(-1.34,y,z),(1.34,y,z),.014,'stainless',g)
    for x in (-1.36,1.36):
        for z in (1.11,1.47):
            a.rod('end_guard',(x,-.91,z),(x,.91,z),.014,'stainless',g)


def mobile_furnace(a,electric=False):
    # Images 1 and 4 are independent variants, not mirror exports: #1 has
    # right transfer and long gas services; #4 has left transfer/heater lining.
    cart_base(a,not electric)
    bottom,top=1.15,5.40
    depth=1.72 if electric else 1.82
    fy=-depth/2
    g=a.group('insulated_casing')
    for x in (-1.095,1.095):
        a.box('outer_side_wall',(x,0,(bottom+top)/2),(.085,depth,top-bottom),'enamel',g,.014)
        for z in (bottom+.08,2.45,3.83,top-.08):
            a.box('casing_cross_rail',(x*1.022,0,z),(.049,depth+.045,.048),'enamel_edge',g,.003)
        for y in (fy+.03,-fy-.03):
            a.box('corner_post',(x,y,(bottom+top)/2),(.115,.075,top-bottom),'enamel_edge',g,.008)
    for z in (bottom,top):
        a.box('insulated_end_plate',(0,0,z),(2.22,depth,.09),'enamel_edge',g,.01)
    for i in range(3):
        a.box('rear_cladding_plate',(0,depth/2,1.88+i*1.37),(2.09,.05,1.365),'enamel',g,.005)
    # Cover is a removable object, not a solid cube which fills the cavity.
    g=a.group('external_cover_front')
    a.rounded_panel('front_seal',(0,fy-.028,(top+bottom)/2),2.205,top-bottom,.035,.145,'gasket',g)
    a.rounded_panel('rounded_front_cover',(0,fy-.07,(top+bottom)/2),2.18,top-bottom-.02,.082,.14,'enamel',g)
    for x in (-.98,.98):
        for z in (bottom+.13,top-.13):
            a.cylinder('cover_washer',(x,fy-.117,z),.044,.014,'brushed_metal',g,'Y',32)
            a.cylinder('cover_fastener',(x,fy-.130,z),.023,.019,'stainless',g,'Y',6)
    for x in (-1.025,1.025):
        for z in (2.13,3.31,4.49):
            a.box('clamp_strap',(x,fy-.11,z),(.24,.045,.081),'enamel_edge',g,.009)
            a.box('clamp_tongue',(x*.955,fy-.14,z),(.065,.021,.041),'brushed_metal',g,.003)
    g=a.group('lifting_lugs')
    for x in (-1.16,1.16):
        for z in (2.18,5.32):
            lug=a.tube('lifting_eye',(x,fy+.02,z),.075,.037,.027,'brushed_metal',g,24)
            lug.rotation_euler.x=math.pi/2
            a.box('lifting_lug_foot',(x*.956,fy+.02,z-.038),(.10,.045,.09),'enamel_edge',g,.012)
    g=a.group('refractory_lining')
    for x in (-.945,.945):
        for j in range(18):
            z=bottom+.14+j*(top-bottom-.2)/18
            a.box('lining_course',(x,0,z),(.18,depth-.16,.22),'refractory',g,.005)
    a.box('lining_roof',(0,0,top-.10),(1.76,depth-.18,.14),'refractory',g)
    a.box('lining_back',(0,depth/2-.09,(top+bottom)/2),(1.78,.10,top-bottom-.16),'refractory',g)
    if electric:
        g=a.group('electric_heater_banks')
        for x in (-.83,.83):
            for j in range(16):
                z=1.4+j*.24
                # Recessed support blocks and U elements in each wall course.
                for y in (-.55,.55):
                    a.box('ceramic_element_support',(x,y,z),(.07,.10,.06),'dial',g,.005)
                a.pipe('resistance_element',[(x,-.56,z),(x,.58,z),(x,.63,z+.07),(x,-.55,z+.07)],.009,'heat_black',g,.05)
        for x in (-1.0,1.0):
            for z in (2.13,3.31,4.49):
                a.box('heater_termination_box',(x,depth/2+.08,z),(.18,.16,.12),'enamel_edge',g)
    top_drive(a,top,fy-.19)
    suspended_fixture(a,1.49,4.48,.99,y=-.06)
    g=a.group('fixture_hangers')
    for x in (-.34,.34):
        a.pipe('suspension_reach',[(x,fy-.05,4.61),(x,fy-.05,4.49),(x,-.06,4.49)],.014,'stainless',g)
    if not electric:
        g=a.group('gas_and_service_pipework')
        a.pipe('long_external_riser',[(-1.40,fy-.08,1.43),(-1.40,fy-.08,6.18),(-1.26,fy-.08,6.39),(-.78,fy-.08,6.39),(-.18,fy-.08,6.39)],.033,'brushed_metal',g,.20)
        for z in (2.6,3.68,4.8):
            a.box('riser_wall_bracket',(-1.26,fy-.08,z),(.35,.05,.036),'enamel_edge',g)
            a.cylinder('riser_clamp',(-1.4,fy-.08,z),.047,.035,'brushed_metal',g)
        for sign in (-1,1):
            a.pipe('upper_branch',[(sign*.55,fy-.19,4.59),(sign*.55,fy-.19,5.14),(sign*.84,fy-.19,5.14),(sign*.84,fy-.19,5.25),(sign*1.03,fy-.19,5.25),(sign*1.03,fy-.19,5.14),(sign*1.28,fy-.19,5.14),(sign*1.28,fy-.19,4.61),(sign*1.15,fy-.19,4.61)],.013,'brass',g,.055)
            a.rod('branch_cross_tube',(sign*.58,fy-.19,5.04),(sign*1.1,fy-.19,5.04),.018,'brushed_metal',g)
            a.box('upper_valve_bracket',(sign*.38,fy+.17,5.50),(.18,.20,.065),'enamel_edge',g)
            a.cylinder('upper_gas_cylinder',(sign*.38,fy+.17,5.62),.046,.20,'stainless',g)
            a.handwheel('upper_isolator',(sign*.38,fy+.085,5.54),g,.037)
        a.pipe('horizontal_feed',[(-1.02,fy-.16,4.21),(1.02,fy-.16,4.21)],.018,'brushed_metal',g)
        a.pipe('valve_drop',[(-.66,fy-.16,4.21),(-.66,fy-.16,1.40)],.012,'brass',g)
        a.gauge('service_gauge',-.66,fy-.21,2.89,g,.067)
        a.handwheel('service_shutoff',(-.66,fy-.22,2.60),g,.035)
        a.pipe('gauge_bypass',[(-.66,fy-.16,2.74),(-.86,fy-.16,2.74),(-.86,fy-.16,3.06),(-.66,fy-.16,3.06)],.011,'brushed_metal',g)


def bake(a):
    bpy.context.window.scene=a.scene
    bpy.context.view_layer.update()
    depsgraph=bpy.context.evaluated_depsgraph_get()
    records=[]
    for semantic,part in a.groups.items():
        pieces=[]
        for obj in part.children_recursive:
            if obj.type not in {'MESH','FONT','CURVE'}: continue
            data=bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),depsgraph=depsgraph)
            transform=part.matrix_world.inverted() @ obj.matrix_world
            data.transform(transform)
            if transform.to_3x3().determinant()<0: data.flip_normals()
            pieces.append((data,data.materials[0]))
        records.append((semantic,part.matrix_world.copy(),bool(part.get('preserve_animation')),pieces))
    a.runtime=bpy.data.scenes.new(f'井式炉{a.number}_RUNTIME')
    bpy.context.window.scene=a.runtime
    rtroot=a.base.empty(a.id+'_root')
    rtroot['display_name']=f'井式炉{a.number}'
    rtroot['depth_is_estimated']=True
    rtroot['reference_image']=REFS[a.number-1]
    if a.number in REFERENCE_CORRECTIONS:
        rtroot['reference_correction']=REFERENCE_CORRECTIONS[a.number]
        rtroot['body_interpretation']='Solid enclosed cabinet furnace; not a freestanding door or panel'
        rtroot['cabinet_depth_m']=1.65
    for semantic,matrix,dynamic,pieces in records:
        part=a.base.empty(f'pf{a.number}_{semantic}',rtroot)
        part.matrix_local=matrix
        part['functional_group']=semantic
        part['preserve_animation']=dynamic
        part['removable_cover']=semantic.startswith('external_cover')
        buckets=defaultdict(list)
        for data,mat in pieces:
            obj=a.base.link(bpy.data.objects.new('baked_piece',data),part)
            buckets[mat].append(obj)
        for mat,objects in buckets.items():
            bpy.ops.object.select_all(action='DESELECT')
            for obj in objects: obj.select_set(True)
            bpy.context.view_layer.objects.active=objects[0]
            if len(objects)>1: bpy.ops.object.join()
            objects[0].name=f'pf{a.number}_{semantic}_{mat.name}'
            objects[0].data.name=objects[0].name+'_mesh'
    a.rtroot=rtroot
    bpy.context.view_layer.update()
    points=[o.matrix_world@Vector(c) for o in rtroot.children_recursive if o.type=='MESH' for c in o.bound_box]
    lo=Vector(tuple(min(p[k] for p in points) for k in range(3)))
    hi=Vector(tuple(max(p[k] for p in points) for k in range(3)))
    a.bounds=(lo,hi)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [rtroot,*rtroot.children_recursive]: obj.select_set(True)
    bpy.context.view_layer.objects.active=rtroot
    glb=a.out/(a.id+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',use_selection=True,use_active_scene=True,
        export_yup=True,export_apply=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False)
    fbx=a.unity/(a.id+'.fbx')
    bpy.ops.export_scene.fbx(filepath=str(fbx),use_selection=True,object_types={'EMPTY','MESH'},
        global_scale=1.0,apply_unit_scale=True,apply_scale_options='FBX_SCALE_UNITS',axis_forward='-Z',axis_up='Y',
        use_mesh_modifiers=True,mesh_smooth_type='FACE',use_custom_props=True,add_leaf_bones=False,bake_anim=False)
    shutil.copy2(fbx,a.out/fbx.name)
    used={mat for o in rtroot.children_recursive if o.type=='MESH' for mat in o.data.materials}
    palette=[]
    for mat in sorted(used,key=lambda m:m.name):
        p=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
        palette.append({'name':mat.name,'color':list(p.inputs['Base Color'].default_value),
            'metallic':p.inputs['Metallic'].default_value,'roughness':p.inputs['Roughness'].default_value,
            'emission':p.inputs['Emission Strength'].default_value})
    for path in (a.out/'palette.json',a.unity/'palette.json'):
        path.write_text(json.dumps({'source':str(SOURCE_BLEND),'materials':palette},indent=2),encoding='utf-8')
    metadata={'model_id':a.id,'display_name':f'井式炉{a.number}','reference':REFS[a.number-1],
        'reference_priority':'latest five original CAD screenshots only',
        'estimated_size_m_blender_xyz':list(hi-lo),'dimensional_accuracy':'visual reconstruction, not dimensioned manufacturing CAD',
        'depth_is_estimated':True,'partBindings':[], 'groups':[r[0] for r in records],
        'cover_visibility':'Hide external_cover groups to expose the explicitly modelled chamber and suspended fixture.',
        'material_source':str(SOURCE_BLEND),'original_assets_modified':False}
    if a.number in REFERENCE_CORRECTIONS:
        metadata.update({
            'reference_correction':REFERENCE_CORRECTIONS[a.number],
            'reference_priority':'Latest verbal correction requires a cabinet-depth furnace; the colored reference defines its front elevation only',
            'body_interpretation':'Solid enclosed cabinet furnace with insulated side/rear/top/bottom walls and reference-derived front assembly',
            'latest_user_correction':'Cabinet-depth furnace body, not a freestanding door/panel',
            'cabinet_depth_m':1.65,
            'cabinet_depth_basis':'Estimated proportional depth; no measured side or plan CAD supplied',
            'cover_visibility':'The complete cabinet remains visible in both inspection views; the second view is a rear-side inspection, not a cutaway.',
        })
    (a.out/'metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    validator=module(ROOT/'tools/validate_equipment_glb.py',f'_validate_{a.number}')
    doc,size=validator.read_glb(glb)
    report=validator.validate(doc,size,a.id+'_root',metadata)
    report['editable_meshes']=sum(o.type=='MESH' for o in a.root.children_recursive)
    (a.out/'geometry-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    assert report['valid'],report
    print('GEOMETRY_OK',a.id,report['stats'],flush=True)


def look(obj,target):
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def studio(a):
    scene=a.scene
    bpy.context.window.scene=scene
    world=bpy.data.worlds.new(f'Pit{a.number}_StudioWorld')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.27,.32,.36,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.35
    scene.world=world
    a.box('review_floor',(0,0,-.045),(200,200,.08),'floor',None,0)
    for name,loc,power,size,color in [('Key',(-4,-6,10),2200,5,(1,.95,.88)),
            ('Fill',(6,-3,7),1700,5,(.78,.87,1)),('Rim',(2,6,10),2500,4,(.92,.96,1))]:
        data=bpy.data.lights.new(f'Pit{a.number}_{name}','AREA')
        data.energy=power;data.shape='DISK';data.size=size;data.color=color
        obj=bpy.data.objects.new(data.name,data);scene.collection.objects.link(obj);obj.location=loc
        look(obj,(0,0,2.7))
    data=bpy.data.cameras.new(f'Pit{a.number}_ReviewCamera');data.type='ORTHO'
    camera=bpy.data.objects.new(data.name,data);scene.collection.objects.link(camera);scene.camera=camera
    lo,hi=a.bounds
    target=(lo+hi)/2
    exterior_offset=Vector((11,-13,7)) if a.number==5 else Vector((8,-13,7))
    camera.location=target+exterior_offset
    look(camera,target)
    scene.render.engine=os.environ.get('PIT_ENGINE','CYCLES');scene.cycles.samples=int(os.environ.get('PIT_SAMPLES','40'))
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1500;scene.render.resolution_y=1500;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.view_settings.view_transform='AgX'
    scene.render.film_transparent=False
    bpy.context.view_layer.update()
    corners=[Vector((x,y,z)) for x in (lo.x,hi.x) for y in (lo.y,hi.y) for z in (lo.z,hi.z)]
    local=[camera.matrix_world.inverted()@c for c in corners]
    data.ortho_scale=2*max(max(abs(v.x),abs(v.y)) for v in local)*1.1
    scene.render.filepath=str(a.out/'preview.png')
    if os.environ.get('PIT_RENDER','1')=='1': bpy.ops.render.render(write_still=True)
    saved=[]
    for name,g in a.groups.items():
        if name.startswith('external_cover'):
            for obj in g.children_recursive:
                saved.append((obj,obj.hide_render));obj.hide_render=True
    camera.location=target+(Vector((11,13,6)) if a.number==5 else Vector((2,-16,4)))
    look(camera,target)
    bpy.context.view_layer.update()
    local=[camera.matrix_world.inverted()@c for c in corners]
    data.ortho_scale=2*max(max(abs(v.x),abs(v.y)) for v in local)*1.08
    scene.render.filepath=str(a.out/'cutaway.png')
    if os.environ.get('PIT_RENDER','1')=='1': bpy.ops.render.render(write_still=True)
    for obj,value in saved:obj.hide_render=value
    camera.location=target+exterior_offset;look(camera,target)
    bpy.context.view_layer.update()
    local=[camera.matrix_world.inverted()@c for c in corners]
    data.ortho_scale=2*max(max(abs(v.x),abs(v.y)) for v in local)*1.1
    # Save an intuitive solid/material camera inspection on opening the blend.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.region_3d.view_perspective='CAMERA'
                area.spaces.active.shading.type='MATERIAL'
    scene.render.filepath=str(a.out/'preview.png')


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    # --factory-startup is required: only clear its known starter scene.
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    requested=[int(x) for x in os.environ.get('PIT_MODELS','1,2,3,4,5').split(',')]
    others=module(ROOT/'tools/blender_build_pit_furnaces_23.py','_pit_35') if any(i in requested for i in (3,5)) else None
    second=module(ROOT/'tools/blender_build_pit_furnace_2.py','_pit_2') if 2 in requested else None
    built=[]
    for number in requested:
        print('BEGIN_ASSET',number,flush=True)
        a=Asset(number)
        if number in (1,4): mobile_furnace(a,electric=number==4)
        elif number==2: second.build_two(a)
        elif number==3: others.build_three(a)
        else: others.build_five(a)
        ref=Path(os.environ['TEMP'])/REFS[number-1]
        if ref.is_file(): shutil.copy2(ref,a.out/'reference.png')
        if number in REFERENCE_CORRECTIONS:
            correction=Path(os.environ['TEMP'])/REFERENCE_CORRECTIONS[number]
            if correction.is_file(): shutil.copy2(correction,a.out/'reference_correction.jpg')
        bake(a)
        studio(a)
        bpy.context.window.scene=a.scene
        bpy.data.libraries.write(str(a.out/(a.id+'.blend')),{a.scene,a.runtime},fake_user=True,compress=True)
        built.append(a)
        print('ASSET_COMPLETE',a.id,flush=True)
    bpy.context.window.scene=built[0].scene
    bundle='pit_furnaces_1_to_5_editable.blend' if len(requested)==5 else 'pit_furnaces_'+''.join(map(str,requested))+'_working.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/bundle),compress=True)
    print('ALL_REQUESTED_ASSETS_COMPLETE',requested,flush=True)


if __name__=='__main__':main()
