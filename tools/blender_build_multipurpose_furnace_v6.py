"""Photo-led V6 study. Run inside Blender via blender_mcp_client.py.

Never modifies V4/V5 objects or production configuration. The editable study,
runtime export, and review renders are separate scenes in a new .blend file.
Dimensions are an estimated visual scale, NOT engineering measurements.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector

WORKSPACE = Path(__file__).resolve().parents[1]
OUT = WORKSPACE / "backend" / "assets" / "models"
MODEL_ID = "photo_multipurpose_furnace_v6"
BLEND = OUT / "photo_equipment_models_v6_study.blend"
EDIT_SCENE = "V6_PHOTO_STUDY"
EXPORT_SCENE = "V6_RUNTIME_EXPORT"
PREFIX = "multi_v6_"
MATS = {}
GROUPS = {}
ROOT = None


def material(key, color, metallic=0.0, roughness=0.45, emission=0.0):
    name = "v6_" + key
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*color, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    MATS[key] = mat
    return mat


def materials():
    material("enamel", (0.68, 0.70, 0.65), 0.06, 0.36)
    material("enamel_edge", (0.49, 0.53, 0.49), 0.08, 0.42)
    material("stainless", (0.54, 0.59, 0.59), 0.88, 0.32)
    material("brushed_metal", (0.39, 0.43, 0.44), 0.83, 0.4)
    material("dark_structure", (0.065, 0.083, 0.082), 0.35, 0.48)
    material("heat_black", (0.013, 0.017, 0.019), 0.08, 0.69)
    material("gasket", (0.019, 0.023, 0.022), 0.0, 0.87)
    material("safety_yellow", (0.9, 0.28, 0.002), 0.04, 0.42)
    material("gas_yellow", (0.9, 0.28, 0.002), 0.10, 0.38)
    material("air_cyan", (0.07, 0.58, 0.60), 0.1, 0.34)
    material("motor_teal", (0.10, 0.22, 0.20), 0.28, 0.35)
    material("motor_blue", (0.018, 0.20, 0.31), 0.25, 0.36)
    material("brass", (0.48, 0.30, 0.065), 0.77, 0.32)
    material("red", (0.72, 0.024, 0.014), 0.06, 0.32)
    material("dial", (0.87, 0.88, 0.79), 0.0, 0.43)
    material("screen", (0.026, 0.23, 0.28), 0.1, 0.24, 0.35)
    material("screen_light", (0.18, 0.76, 0.73), 0.0, 0.42, 0.5)
    material("green", (0.014, 0.65, 0.085), 0.0, 0.25, 0.2)
    material("refractory", (0.20, 0.17, 0.13), 0.0, 0.92)
    material("floor", (0.115, 0.145, 0.16), 0.0, 0.74)


def link(obj, parent=None):
    bpy.context.scene.collection.objects.link(obj)
    obj["v6_generated"] = True
    if parent:
        obj.parent = parent
    return obj


def empty(name, parent=None, loc=(0, 0, 0)):
    obj = link(bpy.data.objects.new(name, None), parent)
    obj.location = loc
    obj.empty_display_size = 0.12
    return obj


def group(name, loc=(0, 0, 0), dynamic=False):
    obj = empty(PREFIX + name, ROOT, loc)
    obj["functional_group"] = name
    obj["preserve_animation"] = dynamic
    GROUPS[name] = obj
    return obj


def mesh(name, vertices, faces, mat, parent, bevel=0.0):
    data = bpy.data.meshes.new(PREFIX + name + "_mesh")
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = link(bpy.data.objects.new(PREFIX + name, data), parent)
    data.materials.append(MATS[mat])
    if bevel:
        mod = obj.modifiers.new("manufactured_edge", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.affect = "EDGES"
        mod = obj.modifiers.new("face_weighted_normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
        mod.weight = 40
    return obj


def box(name, loc, size, mat, parent, bevel=0.006):
    x, y, z = (s / 2 for s in size)
    vertices = [(-x,-y,-z),(-x,-y,z),(-x,y,-z),(-x,y,z),
                (x,-y,-z),(x,-y,z),(x,y,-z),(x,y,z)]
    faces = [(0,4,6,2),(1,3,7,5),(0,1,5,4),(2,6,7,3),(0,2,3,1),(4,5,7,6)]
    obj = mesh(name, vertices, faces, mat, parent, min(bevel, min(size) / 3))
    obj.location = loc
    return obj


def cylinder(name, loc, radius, depth, mat, parent, axis="Z", sides=24):
    verts = []
    for z in (-depth / 2, depth / 2):
        verts.extend((radius*math.cos(a*math.tau/sides),radius*math.sin(a*math.tau/sides),z) for a in range(sides))
    faces = [tuple(reversed(range(sides))), tuple(range(sides, sides*2))]
    faces.extend((i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides))
    obj = mesh(name, verts, faces, mat, parent)
    obj.location = loc
    if axis == "Y":
        obj.rotation_euler[0] = math.pi / 2
    elif axis == "X":
        obj.rotation_euler[1] = math.pi / 2
    for poly in obj.data.polygons:
        poly.use_smooth = len(poly.vertices) == 4
    return obj


def rod(name, start, end, radius, mat, parent, sides=12):
    start, end = Vector(start), Vector(end)
    direction = end - start
    obj = cylinder(name, (start+end)/2, radius, direction.length, mat, parent, sides=sides)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def tube(name, loc, outer, inner, depth, mat, parent, sides=48):
    verts=[]
    for z,r in [(-depth/2,outer),(depth/2,outer),(-depth/2,inner),(depth/2,inner)]:
        verts.extend((r*math.cos(i*math.tau/sides),r*math.sin(i*math.tau/sides),z) for i in range(sides))
    faces=[]
    for i in range(sides):
        j=(i+1)%sides
        faces.extend([(i,j,j+sides,i+sides),
                      (i+2*sides,i+3*sides,j+3*sides,j+2*sides),
                      (i+sides,j+sides,j+3*sides,i+3*sides),
                      (i,i+2*sides,j+2*sides,j)])
    obj=mesh(name,verts,faces,mat,parent)
    obj.location=loc
    for i,p in enumerate(obj.data.polygons):
        p.use_smooth=i%4<2
    return obj


def perforated_guard(parent):
    """Actual punched openings in a rolled thin sheet, not black dots."""
    verts,faces=[],[]
    radius=.253
    cols,rows=40,4
    dz=.22/rows
    du=math.tau/cols
    hole=.013
    square=[(-.5,-.5),(0,-.5),(.5,-.5),(.5,0),(.5,.5),(0,.5),(-.5,.5),(-.5,0)]
    for row in range(rows):
        for col in range(cols):
            center_a=(col+.5)*du
            center_z=1.1+(row+.5)*dz
            offset=len(verts)
            for u,v in square:
                a=center_a+u*du
                verts.append((-1.27+radius*math.cos(a),-1.23+radius*math.sin(a),center_z+v*dz))
            for i in range(8):
                a=-3*math.pi/4+i*math.tau/8
                angle=center_a+hole*math.cos(a)/radius
                verts.append((-1.27+radius*math.cos(angle),-1.23+radius*math.sin(angle),center_z+hole*math.sin(a)))
            for i in range(8):
                j=(i+1)%8
                faces.append((offset+i,offset+j,offset+8+j,offset+8+i))
    obj=mesh("punched_sheet_coupling_guard",verts,faces,"safety_yellow",parent)
    obj.modifiers.new("guard_sheet_thickness","SOLIDIFY").thickness=.003
    return obj


def beam(name, start, end, width, mat, parent):
    start, end = Vector(start), Vector(end)
    direction = end - start
    obj = box(name, (start+end)/2, (width,width,direction.length), mat, parent, 0.003)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def pipe(name, points, radius, mat, parent, bend=0.055):
    """Continuous tubular mesh with rounded elbows, no disconnected bead joints."""
    points = [Vector(p) for p in points]
    path = [points[0]]
    for i in range(1, len(points)-1):
        a,b,c = points[i-1:i+2]
        r = min(bend,(b-a).length*.3,(c-b).length*.3)
        p = b+(a-b).normalized()*r
        q = b+(c-b).normalized()*r
        path.append(p)
        for j in range(1,6):
            t=j/5
            path.append((1-t)**2*p + 2*(1-t)*t*b + t*t*q)
    path.append(points[-1])
    verts=[]
    n=10 if radius<0.02 else 14
    previous=None
    for i,p in enumerate(path):
        tangent=(path[min(i+1,len(path)-1)]-path[max(i-1,0)]).normalized()
        if previous is None:
            ref=Vector((0,0,1)) if abs(tangent.z)<.9 else Vector((0,1,0))
            u=tangent.cross(ref).normalized()
        else:
            u=(previous-tangent*previous.dot(tangent)).normalized()
        v=tangent.cross(u).normalized()
        previous=u
        verts.extend(tuple(p+radius*(u*math.cos(j*math.tau/n)+v*math.sin(j*math.tau/n))) for j in range(n))
    faces=[]
    for i in range(len(path)-1):
        faces.extend((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j) for j in range(n))
    faces.extend([tuple(reversed(range(n))),tuple(range((len(path)-1)*n,len(path)*n))])
    obj=mesh(name,verts,faces,mat,parent)
    for face in obj.data.polygons:
        face.use_smooth=len(face.vertices)==4
    return obj


def label(name, body, loc, size, mat, parent, front="Y"):
    data=bpy.data.curves.new(PREFIX+name+"_type", "FONT")
    data.body=body
    data.align_x="CENTER"
    data.align_y="CENTER"
    data.size=size
    data.extrude=0
    obj=link(bpy.data.objects.new(PREFIX+name,data),parent)
    obj.location=loc
    obj.rotation_euler=(math.pi/2,0,0) if front=="Y" else (math.pi/2,0,math.pi/2)
    data.materials.append(MATS[mat])
    return obj


def bolts(name, points, parent, axis="Y", radius=.014):
    for i,p in enumerate(points):
        cylinder(f"{name}_{i:02d}",p,radius,.012,"stainless",parent,axis,6)


def chassis_and_shell():
    g=group("chassis")
    for y in (-.90,.90):
        box("skid_flange",(0,y,.12),(5.42,.22,.09),"brushed_metal",g)
        box("skid_web",(0,y,.27),(5.42,.075,.25),"brushed_metal",g)
        box("skid_upper_flange",(0,y,.40),(5.42,.22,.08),"stainless",g)
    for x in (-2.5,-1.2,.1,1.4,2.5):
        box("skid_crossmember",(x,0,.26),(.13,1.9,.18),"dark_structure",g)
        for y in (-.90,.90):
            box("anchor_plate",(x,y,.055),(.24,.29,.045),"brushed_metal",g)
            bolts("anchor",[(x,y-.08,.085),(x,y+.08,.085)],g,"Z",.018)
    for y in (-.66,.66):
        box("front_transfer_track",(3.0,y,.17),(1.3,.065,.055),"stainless",g,.003)
    g=group("shell_lower")
    # Individual cladding plates leave real narrow seams rather than black grids.
    box("oil_tank_mass",(-.05,0,.75),(4.95,1.82,.66),"enamel_edge",g,.014)
    for y in (-.935,.935):
        for i,x in enumerate((-1.86,-.62,.62,1.86)):
            box(f"tank_cladding_{i}",(x,y,.77),(1.232,.034,.63),"enamel",g,.003)
        box("tank_top_rolled_lip",(0,y,1.10),(5.10,.12,.075),"stainless",g)
    g=group("shell_rear")
    # A hollow casing: do not leave a solid cube behind the furnace aperture.
    for y in (-.885,.885):
        for i,x in enumerate((-1.72,-.50,.72)):
            box(f"rear_outer_panel_{i}",(x,y,1.91),(1.212,.055,1.53),"enamel",g,.006)
        for x in (-2.35,-1.1,.12,1.35):
            box("wall_stiffener",(x,y*1.04,1.95),(.075,.055,1.60),"enamel_edge",g,.003)
        for z in (1.2,2.64):
            box("casing_horizontal_frame",(-.50,y*1.04,z),(3.84,.065,.085),"enamel_edge",g)
    box("rear_wall",(-2.36,0,1.90),(.09,1.80,1.60),"enamel",g)
    box("roof_panel",(-.50,0,2.73),(3.86,1.87,.105),"enamel",g,.01)
    g=group("shell_front")
    for y in (-.91,.91):
        box("antechamber_side",(1.76,y,1.9),(.73,.065,1.61),"enamel",g)
        box("front_lift_column",(2.1,y,2.01),(.14,.15,1.94),"enamel_edge",g)
    # Two lift-door slots connect to the hollow collection hood above. Do not
    # draw an unbroken roof slab through the moving door panels.
    for y in (-.87,.87):
        box("antechamber_roof_side_return",(1.78,y,2.77),(.9,.18,.12),"enamel",g)
    for x,width in ((1.40,.12),(1.71,.18),(2.16,.22)):
        box("antechamber_roof_between_slots",(x,0,2.77),(width,1.56,.12),"enamel",g)


def mouth_and_hood():
    g=group("mouth_frame")
    # Build an aperture, not an opaque black box over a stack of door panels.
    for y in (-.875,.875):
        box("mouth_black_column",(2.31,y,1.98),(.33,.18,1.89),"heat_black",g)
        box("door_channel",(2.51,y*.92,1.91),(.075,.07,1.87),"stainless",g,.003)
        bolts("channel_fixing",[(2.556,y*.92,z) for z in (1.14,1.50,1.9,2.3,2.67)],g,"X",.014)
    for z in (1.08,2.78):
        box("mouth_black_header",(2.3,0,z),(.35,1.83,.17),"heat_black",g)
    for y in (-.737,.737):
        box("mouth_refractory_jamb",(2.25,y,1.88),(.44,.115,1.48),"refractory",g,.012)
        box("mouth_stainless_jamb",(2.535,y,1.88),(.055,.075,1.56),"stainless",g,.007)
    for z in (1.135,2.64):
        box("mouth_inner_header",(2.30,0,z),(.40,1.48,.095),"refractory",g)
        box("mouth_frame_header",(2.54,0,z),(.055,1.55,.075),"stainless",g)
    box("sill_loading_lip",(2.69,0,1.06),(.38,1.62,.075),"brushed_metal",g)
    g=group("chamber_visible")
    for y in (-.68,.68):
        box("visible_reveal",(1.92,y,1.85),(.55,.055,1.42),"heat_black",g)
    box("chamber_dark_back",(1.25,0,1.86),(.05,1.44,1.46),"heat_black",g)
    box("hearth",(1.9,0,1.18),(1.0,1.37,.10),"refractory",g)
    for y in (-.46,.46):
        box("hearth_guide",(1.94,y,1.26),(1.03,.075,.095),"brushed_metal",g)
    for x in (1.52,1.78,2.04,2.3):
        cylinder("mouth_roller",(x,0,1.32),.036,1.1,"dark_structure",g,"Y",16)
    # Door's local origin is at closed position; preview uses a partial lift.
    g=group("front_door_lift",(1.90,0,1.88),True)
    box("single_insulated_door",(0,0,0),(.105,1.40,1.42),"heat_black",g,.014)
    for y in (-.645,.645):
        box("door_edge",(.06,y,0),(.036,.045,1.36),"brushed_metal",g)
    box("door_lift_crossbar",(.075,0,.54),(.075,1.31,.065),"dark_structure",g)
    g["preview_lift"]=.62
    # Retain a separate internal-door target without inventing detailed internals.
    g=group("middle_door_lift",(1.54,0,1.89),True)
    box("internal_separator",(0,0,0),(.07,1.40,1.40),"heat_black",g)

    g=group("exhaust_hood")
    profile=[(1.36,2.83),(2.99,2.83),(2.99,3.48),(1.58,4.39),(1.36,4.23)]
    verts=[(x,y,z) for y in (-1.04,1.04) for x,z in profile]
    n=len(profile)
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    # Continuous side/roof sheet, open underneath like a real extraction hood.
    faces.extend((i,(i+1)%n,(i+1)%n+n,i+n) for i in range(1,n))
    hood=mesh("closed_sloping_hood",verts,faces,"stainless",g,.009)
    sheet=hood.modifiers.new("hood_sheet_thickness","SOLIDIFY")
    sheet.thickness=.004
    sheet.offset=-1
    box("hood_lower_dark_fascia",(3.016,0,2.93),(.075,2.12,.30),"heat_black",g)
    for y in (-1.057,1.057):
        box("hood_folded_bottom_return",(2.16,y,2.855),(1.64,.033,.085),"brushed_metal",g,.003)
    box("hood_nameplate",(3.058,0,2.947),(.013,.91,.13),"heat_black",g,.002)
    label("hood_type","HEAT TREATMENT",(3.069,0,2.95),.067,"dial",g,"X")
    tube("exhaust_neck",(1.73,0,4.45),.19,.174,.77,"heat_black",g)
    tube("stack_top_rolled_rim",(1.73,0,4.839),.212,.174,.029,"dark_structure",g)


def platform():
    g=group("maintenance_platform")
    x0,x1=-2.52,.62
    y0,y1=.94,1.91
    deck=2.79
    for y in (y0,y1):
        box("platform_long_channel",((x0+x1)/2,y,deck-.04),(x1-x0+.08,.105,.15),"safety_yellow",g)
        box("platform_toeboard",((x0+x1)/2,y,deck+.09),(x1-x0+.06,.033,.17),"safety_yellow",g,.002)
    for x in (x0,-1.48,-.43,x1):
        box("platform_cross_channel",(x,(y0+y1)/2,deck-.045),(.105,y1-y0,.15),"safety_yellow",g)
        beam("load_bearing_triangle",(x,.94,deck-.68),(x,1.88,deck-.1),.095,"safety_yellow",g)
        box("platform_wall_bracket",(x,.95,deck-.54),(.18,.08,.37),"safety_yellow",g)
        bolts("platform_mount",[(x, .895,deck-.68),(x,.895,deck-.39)],g,"Y",.018)
        for y in (y0,y1):
            box("square_guard_post",(x,y,deck+.64),(.044,.044,1.26),"safety_yellow",g,.004)
    for y in (y0,y1):
        for z in (deck+.61,deck+1.25):
            box("guardrail_horizontal",((x0+x1)/2,y,z),(x1-x0+.05,.045,.045),"safety_yellow",g,.004)
    for x in (x0,x1):
        for z in (deck+.61,deck+1.25):
            box("guardrail_end",(x,(y0+y1)/2,z),(.044,y1-y0,.044),"safety_yellow",g,.004)
    # Open steel grating; elongated bars read correctly from both viewpoints.
    for i in range(32):
        x=x0+.065+i*(x1-x0-.13)/31
        box("deck_grating",(x,(y0+y1)/2,deck+.037),(.019,y1-y0-.11,.028),"brushed_metal",g,.001)
    for y in (1.15,1.43,1.70):
        box("grating_cross_tie",((x0+x1)/2,y,deck+.018),(x1-x0-.08,.016,.016),"brushed_metal",g,.001)
    # One accessible ladder at the far rear, attached to the deck and casing.
    for y in (1.19,1.70):
        box("ladder_stringer",(-2.62,y,1.62),(.045,.045,2.78),"safety_yellow",g)
        for z in (.5,1.5,2.6):
            beam("ladder_standoff",(-2.63,y,z),(-2.37,y,z),.035,"safety_yellow",g)
    for i in range(10):
        rod("ladder_non_slip_rung",(-2.64,1.19,.34+i*.272),(-2.64,1.70,.34+i*.272),.017,"brushed_metal",g)


def gauge(name, x, y, z, parent, radius=.073):
    cylinder(name+"_case",(x,y,z),radius,.052,"gasket",parent,"Y",32)
    cylinder(name+"_rim",(x,y-.030,z),radius*.94,.014,"stainless",parent,"Y",32)
    cylinder(name+"_dial",(x,y-.040,z),radius*.84,.012,"dial",parent,"Y",32)
    for i in range(9):
        a=math.radians(-130+i*32.5)
        a0=(x+math.sin(a)*radius*.59,y-.048,z+math.cos(a)*radius*.59)
        a1=(x+math.sin(a)*radius*.75,y-.048,z+math.cos(a)*radius*.75)
        rod(name+"_graduation",a0,a1,.002,"gasket",parent,6)
    rod(name+"_needle",(x,y-.052,z),(x-radius*.40,y-.052,z+radius*.43),.003,"red",parent,8)
    cylinder(name+"_hub",(x,y-.055,z),.008,.004,"gasket",parent,"Y",12)
    rod(name+"_stem",(x,y,z-radius),(x,y,z-radius-.065),.012,"brass",parent)


def handwheel(name, loc, parent, radius=.047):
    x,y,z=loc
    points=[(x+radius*math.cos(i*math.tau/24),y,z+radius*math.sin(i*math.tau/24)) for i in range(25)]
    pipe(name+"_ring",points,.009,"red",parent,.002)
    for a in (0,math.tau/3,2*math.tau/3):
        rod(name+"_spoke",loc,(x+radius*math.cos(a),y,z+radius*math.sin(a)),.006,"red",parent,8)
    cylinder(name+"_hub",loc,.017,.025,"brass",parent,"Y",12)


def motor(name, loc, scale, axis, parent, color="motor_teal"):
    assembly=empty(PREFIX+name,parent,loc)
    if axis=="Y": assembly.rotation_euler[0]=math.pi/2
    if axis=="X": assembly.rotation_euler[1]=math.pi/2
    r=.17*scale
    cylinder(name+"_body",(0,0,0),r,.43*scale,color,assembly,sides=32)
    for z in (-.225,.225):
        cylinder(name+"_endbell",(0,0,z*scale),r*1.08,.047*scale,color,assembly,sides=32)
    cylinder(name+"_fan_cover",(0,0,.29*scale),r*.99,.095*scale,color,assembly,sides=32)
    cylinder(name+"_end_disc",(0,0,.343*scale),r*.8,.006*scale,"dark_structure",assembly,sides=24)
    for i in range(-3,4):
        yy=i*r*.185
        half=math.sqrt((r*.75)**2-yy**2)
        box(name+"_fan_grille",(0,yy,.350*scale),(half*2,.012*scale,.009*scale),color,assembly,.002)
    cylinder(name+"_end_cap_center",(0,0,.356*scale),r*.20,.014*scale,color,assembly,sides=20)
    for i in range(18):
        a=i*math.tau/18
        fin=box(name+"_cooling_fin",((r+.012*scale)*math.cos(a),(r+.012*scale)*math.sin(a),-.005*scale),(.025*scale,.014*scale,.36*scale),color,assembly,.002)
        fin.rotation_euler[2]=a
    box(name+"_terminal_box",(r*.86,-r*.48,.03*scale),(.16*scale,.15*scale,.17*scale),color,assembly,.008)
    cylinder(name+"_mount_flange",(0,0,-.28*scale),r*1.25,.065*scale,"brushed_metal",assembly,sides=32)
    cylinder(name+"_gear_housing",(0,0,-.4*scale),r*.95,.20*scale,color,assembly,sides=32)
    box(name+"_gear_rib",(0,0,-.39*scale),(.3*scale,.29*scale,.17*scale),color,assembly,.015)
    cylinder(name+"_output_bearing",(0,-.17*scale,-.39*scale),.10*scale,.045*scale,"stainless",assembly,"Y",24)
    for a in [i*math.tau/6 for i in range(6)]:
        cylinder(name+"_flange_bolt",(r*1.06*math.cos(a),r*1.06*math.sin(a),-.32*scale),.011*scale,.026*scale,"stainless",assembly,sides=6)
    return assembly


def motors_and_services():
    g=group("drive_housings")
    # Distinct horizontal reducer, upright door motor, and lower blue pump.
    motor("rear_horizontal_drive",(-.90,-1.05,2.38),1.17,"Y",g)
    motor("front_vertical_lift_drive",(1.18,-1.03,2.40),.75,"Z",g)
    motor("lower_reducer",(.55,-1.10,1.83),.9,"Z",g)
    motor("oil_pump_blue",(-1.27,-1.23,1.52),1.06,"Z",g,"motor_blue")
    box("pump_service_shelf",(-.7,-1.1,1.05),(2.14,.7,.12),"stainless",g)
    for x in (-1.55,.17):
        beam("pump_shelf_gusset",(x,-.93,.73),(x,-1.42,1.00),.085,"enamel_edge",g)
    # Rolled punched sheet with open holes, as visible in the reference.
    for z in (1.10,1.32):
        tube("coupling_guard_ring",(-1.27,-1.23,z),.257,.247,.024,"safety_yellow",g,40)
    perforated_guard(g)
    for x,z in [(-.9,2.4),(1.18,2.47),(.55,1.92),(-1.27,1.55)]:
        pipe("drive_power_flex",[(x+.16,-1.20,z),(x+.26,-1.43,z-.14),(x+.21,-1.44,z-.43),(x-.1,-1.35,z-.47),(x-.15,-.98,z-.35)],.018,"gasket",g,.14)
        box("drive_mount_plate",(x,-.96,z-.39),(.37,.08,.35),"enamel_edge",g)
    # Roof motors are static; only shafts / impellers are dynamic targets.
    for i,x in enumerate((-1.52,.23),1):
        cylinder("roof_motor_plinth",(x,0,2.83),.30,.14,"enamel_edge",g,sides=32)
        motor(f"roof_fan_motor_{i}",(x,0,3.06),.53,"Z",g)
        rotor=group(f"roof_fan_{i:02d}_rotate",(x,0,2.59),True)
        cylinder("fan_rotor_shaft",(0,0,0),.025,.44,"stainless",rotor,sides=16)
        cylinder("fan_rotor_hub",(0,0,-.15),.078,.05,"dark_structure",rotor,sides=20)
        for j in range(6):
            a=j*math.tau/6
            blade=box("fan_impeller_blade",(.17*math.cos(a),.17*math.sin(a),-.15),(.27,.064,.018),"brushed_metal",rotor,.002)
            blade.rotation_euler[2]=a
    for i,x in enumerate((-1.5,-.65,.2,1.05),1):
        rotor=group(f"oil_agitator_{i:02d}_rotate",(x,0,.74),True)
        cylinder("oil_shaft",(0,0,0),.022,.46,"stainless",rotor,sides=16)
        for a in (0,math.pi/2):
            blade=box("oil_impeller",(0,0,-.16),(.31,.055,.019),"brushed_metal",rotor,.002)
            blade.rotation_euler[2]=a


def instrument_bank():
    g=group("gas_instrument_bank")
    # Dense instrument bank belongs to one side; it is not repeated on every wall.
    y=1.055
    for z in (.60,1.18,1.91,2.40):
        box("instrument_support_rail",(-.62,y,z),(3.33,.065,.049),"stainless",g,.003)
    # Back-side services, gauges face +Y. Build in a reflected local coordinate frame.
    bank=empty(PREFIX+"instrument_panel_side",g)
    bank.scale.y=-1
    yy=-1.12
    pipe("gas_main_supply",[(-2.18,yy,.53),(1.09,yy,.53),(1.09,yy,1.15)],.031,"gas_yellow",bank)
    pipe("air_main_supply",[(-2.19,yy-.015,.82),(.86,yy-.015,.82),(.86,yy-.015,1.90)],.023,"air_cyan",bank)
    for i,x in enumerate((-1.95,-1.39,-.83,-.27,.29,.85),1):
        pipe(f"meter_feed_{i}",[(x,yy,.53),(x,yy,1.16),(x+.12,yy,1.16),(x+.12,yy,1.99),(x+.17,yy,1.99),(x+.17,-.96,2.47)],.012,"stainless",bank)
        for z in (.65,1.09,1.86):
            cylinder(f"meter_union_{i}",(x,yy,z),.026,.058,"brass",bank,sides=12)
        box(f"flowmeter_mount_{i}",(x+.12,yy-.007,1.54),(.093,.035,.54),"brushed_metal",bank,.004)
        # Opaque recessed glass-like face keeps the GLB predictable in real time.
        box(f"flowmeter_window_{i}",(x+.12,yy-.035,1.56),(.048,.012,.40),"screen",bank,.002)
        for j in range(7):
            box(f"flowmeter_scale_{i}_{j}",(x+.11,yy-.043,1.39+j*.05),(.032,.003,.005),"dial",bank,0)
        for z in (1.26,1.82):
            box(f"flowmeter_end_{i}",(x+.12,yy-.02,z),(.097,.075,.075),"enamel_edge",bank,.006)
        gauge(f"pressure_{i}",x,yy-.09,1.0,bank,.066)
        handwheel(f"manual_gas_valve_{i}",(x,yy-.10,1.20),bank)
        box(f"solenoid_{i}",(x,yy-.025,.72),(.09,.10,.10),"gasket",bank,.006)
        pipe(f"solenoid_lead_{i}",[(x,yy-.075,.73),(x-.08,yy-.13,.78),(x-.14,yy-.13,1.12),(x-.14,-.98,1.2)],.007,"gasket",bank,.06)
        pipe(f"cyan_meter_drop_{i}",[(x-.16,yy,.82),(x-.16,yy,2.22),(x+.05,yy,2.22),(x+.05,-.95,2.22)],.009,"air_cyan",bank)
        box(f"loop_tag_{i}",(x,yy-.055,2.05),(.14,.012,.078),"dial",bank,.002)
        # Compensate the reflected side frame so tags read from the service side.
        label(f"loop_id_{i}",f"F-{i:02d}",(x,yy-.064,2.05),.034,"gasket",bank).scale.x=-1
    for x in (-2.29,1.17):
        pipe("vertical_steel_riser",[(x,-1.25,.38),(x,-1.25,2.58),(x,-.87,2.58)],.022,"stainless",bank)
        for z in (.45,1.1,1.89,2.45):
            box("riser_clamp",(x,-1.23,z),(.085,.04,.029),"brushed_metal",bank)

    g=group("operator_side_services")
    pipe("visible_gas_trunk",[(-2.3,-1.04,.48),(1.65,-1.04,.48),(1.65,-1.04,.81),(2.10,-1.04,.81),(2.10,-1.04,1.03),(2.10,-.91,1.03)],.027,"gas_yellow",g)
    cylinder("burner_supply_end_union",(2.10,-.954,1.03),.044,.09,"brass",g,"Y",12)
    pipe("visible_air_trunk",[(-2.3,-1.07,.73),(.53,-1.07,.73),(.53,-1.07,1.08)],.022,"air_cyan",g)
    for i,(x,z) in enumerate(((-.28,.62),(-.28,.88))):
        gauge("operator_pressure_"+str(i),x,-1.18,z,g,.076)
    for x in (-.84,.28,.98):
        cylinder("gas_thread_union",(x,-1.04,.48),.043,.075,"brass",g,"X",12)
        box("front_solenoid_body",(x,-1.11,.51),(.12,.11,.09),"gasket",g)
        handwheel("front_isolator",(x,-1.20,.57),g,.033)
        pipe("front_flex_lead",[(x,-1.16,.51),(x,-1.23,.29),(x-.13,-1.0,.27)],.009,"gasket",g,.06)
    for z in (.38,.91,2.54):
        pipe("small_signal_tube",[(-2.22,-.97,z),(1.62,-.97,z),(1.62,-.97,z+.13)],.008,"stainless",g)
    for x in (-1.95,-.56,.85,1.6):
        for z in (.48,.73):
            box("service_pipe_clamp",(x,-1.073,z),(.045,.07,.065),"brushed_metal",g,.003)
    box("front_cable_tray",(.24,-1.06,1.08),(2.45,.20,.09),"brushed_metal",g)
    for x in (-.8,-.2,.4,1.0):
        box("junction_box",(x,-1.03,1.19),(.18,.12,.14),"enamel_edge",g)
        pipe("junction_cable",[(x,-1.1,1.16),(x,-1.18,1.05),(x+.08,-1.19,.95)],.013,"gasket",g)


def cabinet():
    g=group("control_cabinet")
    x,y=-2.85,-1.11
    box("cabinet_plinth",(x,y,.17),(1.06,.76,.23),"brushed_metal",g)
    box("full_depth_cabinet",(x,y,1.39),(1.035,.70,2.25),"enamel_edge",g,.013)
    front=y-.368
    box("cabinet_door_gasket",(x,front,1.40),(.96,.025,2.15),"gasket",g,.007)
    box("cabinet_door_panel",(x,front-.022,1.40),(.942,.034,2.128),"enamel",g,.008)
    for z in (.68,1.3,2.08):
        box("cabinet_hinge",(x-.47,front-.044,z),(.039,.05,.14),"enamel_edge",g)
    box("cabinet_handle",(x+.378,front-.062,1.20),(.028,.055,.18),"gasket",g)
    box("hmi_bezel",(x,front-.05,1.86),(.68,.045,.45),"brushed_metal",g)
    box("hmi_inner_seal",(x-.043,front-.077,1.86),(.525,.019,.341),"gasket",g,.004)
    box("hmi_display",(x-.043,front-.089,1.86),(.49,.008,.31),"screen",g,.003)
    # Deliberately schematic UI, not invented live process readings.
    for i in range(3):
        box("hmi_flow_block",(x-.18+i*.14,front-.095,1.88),(.09,.003,.09),"screen_light",g,.002)
    for i in range(4):
        box("hmi_status_line",(x-.07,front-.095,1.78+i*.018),(.34,.003,.003),"screen_light",g,0)
    for i in range(4):
        cylinder("hmi_side_key",(x+.28,front-.086,1.76+i*.058),.01,.004,"gasket",g,"Y",12)
    label("hmi_caption","PROCESS CONTROL",(x,front-.078,2.115),.038,"gasket",g)
    cylinder("estop_yellow_base",(x,front-.068,1.50),.05,.022,"safety_yellow",g,"Y",24)
    cylinder("estop_red_mushroom",(x,front-.091,1.50),.032,.039,"red",g,"Y",24)
    for row in range(3):
        for col in range(4 if row<2 else 2):
            xx=x-.28+col*.185+(0 if row<2 else .185)
            zz=1.32-row*.16
            cylinder("pushbutton_chrome",(xx,front-.051,zz),.03,.013,"stainless",g,"Y",20)
            cylinder("pushbutton_black",(xx,front-.067,zz),.022,.021,"gasket",g,"Y",20)
            box("button_caption",(xx,front-.047,zz+.052),(.065,.004,.012),"enamel_edge",g,.001)
    box("warning_sticker",(x,front-.045,.77),(.29,.006,.135),"dial",g,.002)
    box("warning_stripe",(x,front-.05,.807),(.288,.003,.041),"safety_yellow",g,.001)
    label("warning_label","CAUTION",(x,front-.054,.806),.036,"gasket",g)
    label("electrical_label","ELECTRICAL",(x,front-.054,.76),.025,"gasket",g)
    box("filter_frame",(x+.27,front-.05,.46),(.16,.018,.17),"brushed_metal",g)
    for i in range(6):
        box("filter_louver",(x+.27,front-.064,.397+i*.022),(.127,.01,.009),"gasket",g,.001)
    for z in (1.4,2.0):
        box("cabinet_side_vent",(x-.527,y,z),(.013,.37,.22),"brushed_metal",g)
        for i in range(7):
            box("side_vent_louver",(x-.537,y,z-.084+i*.028),(.012,.33,.011),"gasket",g,.001)
    cylinder("beacon_socket",(x+.29,y,2.56),.072,.08,"enamel",g,sides=24)
    beacon=group("control_alarm_lamp",(x+.29,y,2.68),True)
    cylinder("alarm_red_lens",(0,0,0),.063,.17,"red",beacon,sides=32)
    cylinder("alarm_top_cap",(0,0,.092),.065,.014,"gasket",g,sides=24).location=(x+.29,y,2.772)


def look_at(camera,target):
    camera.rotation_euler=(Vector(target)-camera.location).to_track_quat("-Z","Y").to_euler()


def studio(scene):
    world=bpy.data.worlds.get("V6_NEUTRAL_STUDIO") or bpy.data.worlds.new("V6_NEUTRAL_STUDIO")
    scene.world=world
    world.use_nodes=True
    bg=next(n for n in world.node_tree.nodes if n.type=="BACKGROUND")
    bg.inputs["Color"].default_value=(.22,.27,.31,1)
    bg.inputs["Strength"].default_value=.28
    box("review_floor",(0,0,-.038),(200,200,.05),"floor",None,.0)
    for name,loc,power,size,color in [
        ("key",(1,-5,8),1000,5.0,(1,.94,.85)),
        ("fill",(-4,-1,5),650,4.0,(.80,.9,1)),
        ("rim",(3,5,7),1400,4.5,(.90,.95,1)),
    ]:
        data=bpy.data.lights.new("v6_studio_"+name,"AREA")
        data.energy=power
        data.shape="DISK"
        data.size=size
        data.color=color
        obj=link(bpy.data.objects.new(data.name,data))
        obj.location=loc
        look_at(obj,(0,0,1.7))
    data=bpy.data.cameras.new("v6_review_camera")
    cam=link(bpy.data.objects.new(data.name,data))
    data.type="ORTHO"
    data.ortho_scale=8.65
    cam.location=(9,-12,7.0)
    look_at(cam,(-.08,.1,2.32))
    scene.camera=cam
    scene.render.engine="BLENDER_EEVEE"
    if hasattr(scene,"eevee") and hasattr(scene.eevee,"taa_render_samples"):
        scene.eevee.taa_render_samples=96
    scene.render.resolution_x=1800
    scene.render.resolution_y=1400
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format="PNG"
    scene.render.film_transparent=False
    scene.view_settings.view_transform="AgX"
    scene.view_settings.look="AgX - Medium High Contrast"
    scene.unit_settings.system="METRIC"
    scene.unit_settings.scale_length=1.0


def build():
    global ROOT
    OUT.mkdir(parents=True,exist_ok=True)
    # Replace only this script's own previously generated study scene.
    old=bpy.data.scenes.get(EDIT_SCENE)
    if old:
        if not old.get("v6_generated"):
            raise RuntimeError("Refusing to replace a scene not marked as this script's output")
        for obj in list(old.objects):
            if obj.get("v6_generated"):
                bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.scenes.remove(old)
    scene=bpy.data.scenes.new(EDIT_SCENE)
    scene["v6_generated"]=True
    bpy.context.window.scene=scene
    materials()
    ROOT=empty(MODEL_ID+"_editable_root")
    ROOT["model_id"]=MODEL_ID
    ROOT["reference_photos"]="多用炉/mmexport1783325193551.jpg;多用炉/mmexport1783325195041.jpg"
    ROOT["dimensional_accuracy"]="visual estimate; no measured drawings supplied"
    ROOT["status"]="photo-led review draft, not production replacement"
    chassis_and_shell()
    mouth_and_hood()
    platform()
    motors_and_services()
    instrument_bank()
    cabinet()
    studio(scene)
    # Use closed position in saved editable scene; the render step controls pose.
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    ROOT.select_set(True)
    bpy.context.view_layer.objects.active=ROOT
    for area in bpy.context.screen.areas:
        if area.type=="VIEW_3D":
            area.spaces.active.region_3d.view_perspective="CAMERA"
            area.spaces.active.shading.type="MATERIAL"
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print(json.dumps({"study":str(BLEND),"scene":scene.name,"editable_objects":len(ROOT.children_recursive)},ensure_ascii=False))
    return ROOT


RUNTIME_NAMES={
    "front_door_lift":"door_front_lift",
    "middle_door_lift":"door_middle_lift",
    "roof_fan_01_rotate":"fan_rear_rotate",
    "roof_fan_02_rotate":"fan_front_rotate",
    **{f"oil_agitator_{i:02d}_rotate":f"agitator_oil_{i:02d}_rotate" for i in range(1,5)},
}


def make_metadata():
    bindings=[]
    for name,key,travel in [("door_front_lift","front_door_open",1.50),("door_middle_lift","middle_door_open",1.38)]:
        bindings.append({"id":key,"name":key,"node_name":name,"node_path":"",
                         "source_group":"doors","source_key":key,"action":"translate","axis":"y",
                         "input_min":0,"input_max":1,"output_min":0,"output_max":travel,"invert":False})
    for name,key in [("fan_rear_rotate","rear_fan_speed"),("fan_front_rotate","front_fan_speed")]+[
        (f"agitator_oil_{i:02d}_rotate",f"oil_stir_{i}_speed") for i in range(1,5)
    ]:
        bindings.append({"id":key,"name":key,"node_name":name,"node_path":"",
                         "source_group":"motors","source_key":key,"action":"rotate_speed","axis":"y",
                         "input_min":0,"input_max":100,"output_min":0,"output_max":360,
                         "speed_factor":math.tau/60,"invert":False})
    return {
        "schema_version":1,"model_id":MODEL_ID,"version":"v6","source":"photo_reference_geometry_study",
        "batchable":True,
        "optimization":{"mode":"auto","mergeStatic":False,"instanceRepeated":True,
                        "preserveAnimated":True,"materialEnhancement":"original","contactShadow":True},
        "runtime":{"enableGenericBindings":True,"showStatusLight":True},
        "assetSpec":{"version":"6.0.0","device_family":"箱式气氛多用炉 / 照片参考 V6 样板",
                     "unit":"m","axis_rule":"Y-up; furnace mouth +X; operator side +Z",
                     "max_triangles":200000,"max_nodes":800,"max_texture_size":2048,
                     "lod_policy":"LOD0 visual review draft","delivery_status":"review",
                     "notes":"尺寸为照片估算。炉内、后方连接及运动行程为示意，须实测确认。未替换生产V5资产。"},
        "partBindings":bindings,
        "inspection":{"enabled":True,"shell":{"node_names":["shell_lower","shell_rear","shell_front"],
            "node_paths":[],"opacity":.16,"wireframe":False},
            "animation_duration":.72,
            "parts":[{"id":b["id"],"name":b["name"],"node_name":b["node_name"],
                      "explode_offset":[0,.4,0],"point_keys":[b["source_group"]+"."+b["source_key"]]} for b in bindings]},
        "reference":{"photos":["多用炉/mmexport1783325193551.jpg","多用炉/mmexport1783325195041.jpg"],
                     "dimensional_accuracy":"visual_estimate_not_measured","unseen_internals":"illustrative_only"},
        "release":{"version":"6.0.0","status":"draft","published_at":"","history":[]},
    }


def export_runtime():
    """Bake into function/material groups; keep the editable scene untouched."""
    import runpy
    study=bpy.data.scenes[EDIT_SCENE]
    bpy.context.window.scene=study
    source_root=bpy.data.objects[MODEL_ID+"_editable_root"]
    bpy.context.view_layer.update()
    depsgraph=bpy.context.evaluated_depsgraph_get()
    # Read evaluated geometry before switching away from its scene.
    baked=[]
    for part in source_root.children:
        semantic=part["functional_group"]
        coordinate=part.matrix_world.copy()
        if semantic=="front_door_lift":
            coordinate.translation.z=1.88  # always export the closed reference pose
        records=[]
        for obj in part.children_recursive:
            if obj.type not in {"MESH","FONT","CURVE"}:
                continue
            evaluated=obj.evaluated_get(depsgraph)
            data=bpy.data.meshes.new_from_object(evaluated,depsgraph=depsgraph)
            transform=part.matrix_world.inverted() @ obj.matrix_world
            data.transform(transform)
            if transform.to_3x3().determinant()<0:
                data.flip_normals()
            data.update()
            mat=data.materials[0] if data.materials else None
            records.append((data,mat))
        baked.append((semantic,coordinate,part.get("preserve_animation",False),records))
    old=bpy.data.scenes.get(EXPORT_SCENE)
    if old:
        if not old.get("v6_generated"):
            raise RuntimeError("Refusing to replace a non-generated export scene")
        for obj in list(old.objects):
            if obj.get("v6_generated"):
                bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.scenes.remove(old)
    scene=bpy.data.scenes.new(EXPORT_SCENE)
    scene["v6_generated"]=True
    bpy.context.window.scene=scene
    root=empty(MODEL_ID+"_root")
    root["model_id"]=MODEL_ID
    root["dimensional_accuracy"]="estimated visual study, not measured"
    root["delivery_status"]="review"
    for semantic,coordinate,dynamic,records in baked:
        name=RUNTIME_NAMES.get(semantic,semantic)
        assembly=empty(name,root)
        assembly.matrix_local=coordinate
        assembly["functional_group"]=semantic
        assembly["preserve_animation"]=dynamic
        buckets=defaultdict(list)
        for data,mat in records:
            obj=link(bpy.data.objects.new("v6_baked_fragment",data),assembly)
            buckets[mat].append(obj)
        for mat,objects in buckets.items():
            bpy.ops.object.select_all(action="DESELECT")
            for obj in objects: obj.select_set(True)
            active=objects[0]
            bpy.context.view_layer.objects.active=active
            if len(objects)>1: bpy.ops.object.join()
            active.name=name+"_"+(mat.name.removeprefix("v6_") if mat else "unassigned")
            active.data.name=active.name+"_mesh"
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root,*root.children_recursive]: obj.select_set(True)
    bpy.context.view_layer.objects.active=root
    bpy.context.view_layer.update()
    output=OUT/(MODEL_ID+".glb")
    bpy.ops.export_scene.gltf(filepath=str(output),export_format="GLB",use_selection=True,
                             use_active_scene=True,export_yup=True,export_apply=True,
                             export_extras=True,export_animations=False,export_cameras=False,
                             export_lights=False,export_materials="EXPORT")
    metadata=make_metadata()
    validator=runpy.run_path(str(WORKSPACE/"tools"/"validate_equipment_glb.py"))
    document,file_bytes=validator["read_glb"](output)
    report=validator["validate"](document,file_bytes,MODEL_ID+"_root",metadata)
    # Blender's Y-up export may use a coordinate-conversion quaternion on empty
    # parents. Convert the intended Blender-local Z axis to each exported local
    # frame before declaring the runtime binding axis.
    names={n.get("name"):n for n in document["nodes"]}
    from mathutils import Quaternion
    for binding in metadata["partBindings"]:
        node=names[binding["node_name"]]
        rotation=node.get("rotation",[0,0,0,1])
        quat=Quaternion((rotation[3],rotation[0],rotation[1],rotation[2]))
        # Translation is in the parent's frame; rotation uses the node's frame.
        local_up=Vector((0,1,0)) if binding["action"]=="translate" else quat.inverted() @ Vector((0,1,0))
        index=max(range(3),key=lambda i:abs(local_up[i]))
        if abs(local_up[index])<.999:
            raise RuntimeError("Binding local up does not align with a cardinal axis")
        binding["axis"]="xyz"[index]
        if local_up[index]<0:
            if binding["action"]=="translate": binding["output_max"] *= -1
            else: binding["speed_factor"] *= -1
    report["binding_axis_audit"]=[{"node":b["node_name"],"axis":b["axis"],"rotation":names[b["node_name"]].get("rotation",[0,0,0,1])} for b in metadata["partBindings"]]
    report["model_id"]=MODEL_ID
    report["scope"]="standalone photo-led review; production V5 unchanged"
    report["editable_objects"]=len(source_root.children_recursive)
    report["geometry_pipeline"]="evaluated mesh; functional-group + material merge; dynamic pivots preserved"
    report["original_assets_modified"]=False
    metadata["acceptance"]={"status":"review" if report["valid"] else "failed", "stats":report["stats"],
                            "checks":["GLB structural validation","unique binding targets","only equipment root exported"],
                            "production_runtime_tested":False}
    (OUT/(MODEL_ID+"_metadata.json")).write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
    (OUT/(MODEL_ID+"_report.json")).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    bpy.context.window.scene=study
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print(json.dumps(report,ensure_ascii=False))
    if not report["valid"]:
        raise RuntimeError("V6 export did not pass structural validation")
    return report


def render_views():
    scene=bpy.data.scenes[EDIT_SCENE]
    bpy.context.window.scene=scene
    camera=scene.camera
    door=bpy.data.objects[PREFIX+"front_door_lift"]
    door.location.z=2.50
    scene.render.resolution_x=1800
    scene.render.resolution_y=1400
    for suffix,loc,target,scale in [
        ("preview",(9,-12,7),(-.08,.1,2.32),8.65),
        ("instrument_side",(-9,12,6.4),(-.10,.18,2.28),8.4),
    ]:
        camera.location=loc
        camera.data.ortho_scale=scale
        look_at(camera,target)
        scene.render.filepath=str(OUT/(MODEL_ID+"_"+suffix+".png"))
        bpy.ops.render.render(write_still=True)
    camera.location=(9,-12,7)
    camera.data.ortho_scale=8.65
    look_at(camera,(-.08,.1,2.32))
    scene.render.filepath=str(OUT/(MODEL_ID+"_preview.png"))
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    print("V6 operator and instrument-side review views complete")


if __name__=="__main__":
    build()
    export_runtime()
    render_views()
