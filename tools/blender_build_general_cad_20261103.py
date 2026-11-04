"""Seven standalone equipment assets reconstructed from the supplied 2D DWGs.

Run in an isolated Blender background process, never in the operator's scene.
Dimensions are metres; Blender Z-up -> glTF Y-up. No PLC/project data is changed.
"""
from pathlib import Path
from collections import defaultdict
import bpy, bmesh, math, json, hashlib, sys, time
from mathutils import Vector, Quaternion

ROOT=Path(__file__).resolve().parents[1]
CAD=ROOT/'output/cad-general-20261103'
OUT=ROOT/'backend/assets/models/cad_general_20261103_v1'
OUT.mkdir(parents=True,exist_ok=True)
for name in ['sources','previews','metadata']:(OUT/name).mkdir(exist_ok=True)
if (CAD/'sources.json').exists():
    SOURCES={s['id']:s for s in json.loads((CAD/'sources.json').read_text(encoding='utf-8-sig'))}
else:
    # Fresh clones use the shared provenance; original private DWGs stay local.
    SOURCES={m['source']['id']:m['source'] for m in [json.loads(p.read_text(encoding='utf8')) for p in (OUT/'metadata').glob('*.json')]}
MATS={}

def palette():
    # Same linear PBR values as blender_equipment_v6_common.py, not CAD layer colours.
    values={
      'enamel':((.68,.70,.65),.06,.36),'edge':((.49,.53,.49),.08,.42),
      'stainless':((.54,.59,.59),.88,.32),'metal':((.39,.43,.44),.83,.40),
      'steel':((.043,.055,.056),.25,.46),'black':((.013,.017,.019),.08,.69),
      'gasket':((.019,.023,.022),0,.87),'safety':((.90,.28,.002),.04,.42),
      'teal':((.10,.22,.20),.28,.35),'blue':((.018,.105,.26),.25,.36),
      'green':((.025,.30,.075),.15,.38),'brass':((.48,.30,.065),.77,.32),
      'red':((.72,.024,.014),.06,.32),'screen':((.026,.23,.28),.1,.24),
      'water':((.035,.15,.17),.40,.20),'floor':((.11,.14,.16),0,.75)}
    for key,(color,metal,rough) in values.items():
        material=bpy.data.materials.get('CAD26_'+key) or bpy.data.materials.new('CAD26_'+key)
        material.use_nodes=True;material.diffuse_color=(*color,1)
        shader=material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value=(*color,1)
        shader.inputs['Metallic'].default_value=metal;shader.inputs['Roughness'].default_value=rough
        MATS[key]=material

class Asset:
    def __init__(self,key,label,filename,dimensions,notes):
        self.key=key;self.id='cad_'+key+'_v1';self.label=label;self.filename=filename
        self.dimensions=dimensions;self.notes=notes;self.groups={}
        self.scene=bpy.data.scenes.new(self.id);bpy.context.window.scene=self.scene
        self.root=bpy.data.objects.new(self.id+'_root',None);self.scene.collection.objects.link(self.root)
        self.root['model_id']=self.id;self.root['source_dwg']=SOURCES[key]['source']
        self.root['source_sha256']=SOURCES[key]['sha256'];self.root['unit']='m'
        self.root['reference_dimensions_mm']=json.dumps(dimensions,ensure_ascii=False)
        self.root['accuracy']='Reconstructed visible and sectioned CAD features; dimensions absent from the drawing remain inferred'
    def group(self,key):
        if key not in self.groups:
            o=bpy.data.objects.new(self.id+'_'+key,None);self.scene.collection.objects.link(o);o.parent=self.root
            o['part']=key;self.groups[key]=o
        return self.groups[key]
    def finish(self,o,name,mat,group='structure',bevel=0):
        o.name=self.id+'_'+name;o.parent=self.group(group)
        o.data.materials.append(MATS[mat])
        if bevel:
            mod=o.modifiers.new('Machined edge','BEVEL');mod.width=bevel;mod.segments=2
        return o
    def box(self,name,p,size,mat='steel',group='structure',bevel=.006):
        bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.dimensions=size
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        return self.finish(o,name,mat,group,min(bevel,min(size)*.22))
    def cyl(self,name,p,r,h,mat='metal',axis='Z',group='structure',n=24):
        bpy.ops.mesh.primitive_cylinder_add(vertices=n,radius=r,depth=h,location=p);o=bpy.context.object
        if axis=='X':o.rotation_euler[1]=math.pi/2
        if axis=='Y':o.rotation_euler[0]=math.pi/2
        for face in o.data.polygons:face.use_smooth=len(face.vertices)==4
        return self.finish(o,name,mat,group)
    def beam(self,name,a,b,width=.06,depth=None,mat='steel',group='structure'):
        a,b=Vector(a),Vector(b);o=self.box(name,(a+b)/2,(width,depth or width,(b-a).length),mat,group,.003)
        o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o
    def pipe(self,name,points,r=.025,mat='green',group='pipes',corner=.08):
        points=[Vector(p) for p in points];route=[points[0]]
        for a,b,c in zip(points,points[1:],points[2:]):
            incoming=(b-a).normalized();outgoing=(c-b).normalized()
            turn=math.acos(max(-1,min(1,incoming.dot(outgoing))))
            normal=incoming.cross(outgoing)
            if turn<.001 or normal.length<.0001:
                route.append(b);continue
            # True tangent circular elbow. A quadratic shortcut pinched large
            # exhaust ducts below their own radius and inverted triangles.
            tangent=math.tan(turn/2)
            amount=min(max(corner,r*1.06*tangent),(a-b).length*.49,(c-b).length*.49)
            radius=amount/tangent
            assert radius>r,(name,'pipe bend tighter than pipe radius',radius,r)
            start=b-incoming*amount;end=b+outgoing*amount
            normal.normalize();center=start+normal.cross(incoming)*radius;radial=start-center
            route.append(start)
            for i in range(1,9):
                route.append(center+Quaternion(normal,turn*i/8)@radial)
        route.append(points[-1])
        curve=bpy.data.curves.new(self.id+'_'+name,'CURVE');curve.dimensions='3D';curve.resolution_u=1
        curve.bevel_depth=r;curve.bevel_resolution=2;curve.use_fill_caps=True
        spline=curve.splines.new('POLY');spline.points.add(len(route)-1)
        for point,value in zip(spline.points,route):point.co=(*value,1)
        o=bpy.data.objects.new(curve.name,curve);self.scene.collection.objects.link(o);o.parent=self.group(group);curve.materials.append(MATS[mat]);return o
    def ring(self,name,p,outer,inner,depth,mat='metal',axis='Z',group='structure',n=32):
        vertices=[];faces=[]
        for z in [-depth/2,depth/2]:
            for radius in [outer,inner]:
                vertices.extend([(radius*math.cos(i*2*math.pi/n),radius*math.sin(i*2*math.pi/n),z) for i in range(n)])
        for i in range(n):
            j=(i+1)%n
            faces.extend([(i,j,2*n+j,2*n+i),(n+j,n+i,3*n+i,3*n+j),(j,i,n+i,n+j),(2*n+i,2*n+j,3*n+j,3*n+i)])
        mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
        o=bpy.data.objects.new(name,mesh);self.scene.collection.objects.link(o);o.location=p
        if axis=='X':o.rotation_euler[1]=math.pi/2
        if axis=='Y':o.rotation_euler[0]=math.pi/2
        return self.finish(o,name,mat,group)
    def bolts(self,name,points,axis='Z',group='structure',r=.012):
        for i,p in enumerate(points):self.cyl(name+str(i),p,r,r*.7,'metal',axis,group,6)
    def foot(self,x,y,z=0):
        self.box('sole_plate',(x,y,z+.018),(.19,.17,.036),'metal')
        self.bolts('anchor',[(x+dx,y+dy,z+.044) for dx in [-.064,.064] for dy in [-.05,.05]])
    def channel(self,name,p,w,d,h,mat='steel',group='structure'):
        x,y,z=p
        thickness=.010
        if w>h: # Horizontal C-section, running along X.
            self.box(name+'_web',(x,y-d/2+thickness/2,z),(w,thickness,h),mat,group,.002)
            for s in [-1,1]:self.box(name+'_flange',(x,y,z+s*(h-thickness)/2),(w,d,thickness),mat,group,.002)
        else: # Vertical C100 leg: web and flanges must actually meet.
            self.box(name+'_web',(x-w/2+thickness/2,y,z),(thickness,d,h),mat,group,.002)
            for s in [-1,1]:self.box(name+'_flange',(x,y+s*(d-thickness)/2,z),(w,thickness,h),mat,group,.002)
    def motor(self,p,axis='Z',r=.095,length=.28,group='drive',mat='teal'):
        x,y,z=p;v=Vector((1,0,0) if axis=='X' else (0,1,0) if axis=='Y' else (0,0,1))
        self.cyl('motor_housing',p,r,length,mat,axis,group,32)
        for i in range(7):self.ring('cooling_fin',Vector(p)+v*((i-3)*length/10),r*1.09,r*.93,.014,mat,axis,group,24)
        self.cyl('motor_fan_cover',Vector(p)-v*(length*.57),r*1.02,.05,mat,axis,group)
        self.cyl('motor_shaft',Vector(p)+v*(length*.60),r*.26,.10,'stainless',axis,group)
        self.box('motor_terminal',(x+r*.9,y,z),(.10,.12,.10),mat,group)
    def bearing(self,x,y,z,group='roller_bed'):
        self.box('bearing_pedestal',(x,y,z),(.12,.07,.08),'teal',group,.012)
        self.cyl('bearing_cap',(x,y-.042,z),.035,.028,'metal','Y',group)
        self.bolts('bearing_bolt',[(x-.04,y,z+.045),(x+.04,y,z+.045)],group=group,r=.008)
    def roller_deck(self,length=1.71,width=.7,top=1.25,count=7,group='roller_bed',radius=.055,roller_length=.115,positions=None,axle_radius=.017):
        z=top-radius;bearing_span=width-.09
        for y in [-bearing_span/2,bearing_span/2]:self.box('bed_channel',(0,y,z-.075),(length,.065,.13),'steel',group)
        for x in [-length*.43,0,length*.43]:self.box('bed_cross_tie',(x,0,z-.11),(.08,width,.08),'steel',group)
        xs=positions if positions is not None else [-length*.43+length*.86*i/(count-1) for i in range(count)]
        for x in xs:
            for y in [-width*.29,width*.29]:self.cyl('load_roller',(x,y,z),radius,roller_length,'stainless','Y',group,28)
            self.cyl('roller_axle',(x,0,z),axle_radius,width,'metal','Y',group)
            for y in [-bearing_span/2,bearing_span/2]:self.bearing(x,y,z,group)
        for y in [-width*.46,width*.46]:self.box('load_guide',(0,y,top+.013),(length,.018,.032),'safety',group,.003)
        self.box('end_stop',(length*.47,0,top+.04),(.035,width*.76,.07),'steel',group)
    def panel(self,name,p,w,h,mat='enamel',group='housing'):
        x,y,z=p;self.box(name+'_gasket',(x,y+.006,z),(w+.018,.028,h+.018),'gasket',group)
        self.box(name,p,(w,.018,h),mat,group)
        self.bolts(name+'_fastener',[(x+sx*(w/2-.035),y-.016,z+sz*(h/2-.035)) for sx in [-1,1] for sz in [-1,1]],'Y',group,.008)
    def handwheel(self,p,r=.09,axis='Y',group='valves'):
        self.ring('handwheel',p,r,r-.012,.018,'safety',axis,group)
        x,y,z=p
        for angle in [0,2*math.pi/3,4*math.pi/3]:
            q=(x+r*.9*math.cos(angle),y,z+r*.9*math.sin(angle))
            self.beam('wheel_spoke',p,q,.012,mat='metal',group=group)
        self.cyl('valve_hub',p,.022,.05,'brass',axis,group)
    def flange(self,p,r=.09,axis='Z',group='pipes'):
        self.ring('pipe_flange',p,r,r*.60,.022,'stainless',axis,group)
        x,y,z=p;points=[]
        for i in range(8):
            a=i*math.pi/4;u,v=r*.8*math.cos(a),r*.8*math.sin(a)
            points.append((x+u,y+v,z+.016) if axis=='Z' else (x+u,y-.016,z+v) if axis=='Y' else (x+.016,y+u,z+v))
        self.bolts('flange_bolt',points,axis,group,.007)

def table(a,lifting=False):
    if lifting:
        for y in [-.30,.30]:
            a.channel('lift_base', (0,y,.075),1.71,.08,.11)
            a.box('lift_top_channel',(0,y,1.015),(1.71,.09,.06),'steel','lift')
            a.beam('scissor_arm_A',(-.65,y,.14),(.65,y,.95),.075,.025,'edge','lift')
            a.beam('scissor_arm_B',(.65,y+.035,.14),(-.65,y+.035,.95),.075,.025,'edge','lift')
            for x,z in [(-.65,.14),(.65,.14),(-.65,.95),(.65,.95),(0,.545)]:a.cyl('scissor_pin',(x,y-.018,z),.03,.09,'stainless','Y','lift')
        for x in [-.71,.71]:a.box('base_tie',(x,0,.075),(.09,.65,.08))
        for x in [-.72,.72]:
            for y in [-.265,.265]:a.foot(x,y)
        a.beam('hydraulic_barrel',(.48,0,.16),(.20,0,.59),.08,mat='teal',group='hydraulics')
        a.beam('hydraulic_piston',(.20,0,.59),(.03,0,.83),.034,mat='stainless',group='hydraulics')
        a.pipe('lift_pressure_hose',[(.5,.02,.23),(.65,.12,.22),(.66,.18,.08),(.30,.18,.08)],.012,'gasket','hydraulics',.035)
        a.box('pump_pack',(.28,0,.13),(.30,.25,.16),'teal','hydraulics')
        # 11.14.00: five paired Ø60 x 136 rollers, centres 320 mm apart.
        a.roller_deck(top=1.20,count=5,radius=.030,roller_length=.136,positions=[-.685,-.365,-.045,.275,.595],axle_radius=.010)
    else:
        for x in [-.755,.755]:
            for y in [-.265,.265]:
                a.foot(x,y);a.channel('leg',(x,y,.58),.100,.050,1.06)
                a.beam('corner_knee',(x,y,.93),(x-math.copysign(.24,x),y,1.115),.035)
        for y in [-.265,.265]:a.box('lower_long_tie',(0,y,.43),(1.52,.045,.065))
        for x in [-.755,.755]:a.box('lower_end_tie',(x,0,.43),(.045,.57,.065))
        # 11.22.00: six paired Ø60 x 167 rollers, centres 280 mm apart.
        a.roller_deck(top=1.25,count=6,radius=.030,roller_length=.167,positions=[-.805,-.525,-.245,.035,.315,.595],axle_radius=.010)
    a.box('manual_release_valve',(.86,0,1.10),(.065,.10,.09),'brass','hydraulics')
    a.pipe('release_handle',[(.875,0,1.10),(.97,0,1.10),(.97,0,.98)],.012,'metal','hydraulics',.02)

def air_cool(a):
    for x in [-.77,.77]:
        for y in [-.335,.335]:
            a.foot(x,y);a.box('stand_leg',(x,y,.58),(.07,.07,1.10))
    for y in [-.335,.335]:a.box('low_tie',(0,y,.44),(1.6,.04,.055))
    a.roller_deck(1.816,.75,1.25,6,radius=.030,roller_length=.136)
    # Twin downward axial fans are visible beneath the open roller bed.
    for x in [-.28,.28]:
        a.ring('fan_shroud',(x,0,.95),.225,.205,.34,'enamel','Z','fans')
        a.motor((x,0,.91),r=.085,length=.18,group='fans')
        for angle in range(4):
            o=a.box('fan_blade',(x+.095*math.cos(angle*math.pi/2),.095*math.sin(angle*math.pi/2),1.035),(.15,.055,.016),'metal','fans',.004);o.rotation_euler[2]=angle*math.pi/2+.4
    # Door is on the narrow end (862 mm elevation), never the 1816 mm side.
    for y in [-.394,.394]:a.box('hood_side',(0,y,1.70),(1.70,.024,.86),'enamel','hood')
    a.box('hood_rear',(.84,0,1.70),(.024,.79,.86),'enamel','hood')
    truncated_hood(a,(0,0,2.13),(1.70,.80),(.614,.614),.18,'hood')
    for s in [-1,1]:a.box('chimney_neck',(s*.307,0,2.313),(.014,.614,.12),'enamel','hood')
    for s in [-1,1]:a.box('chimney_neck',(0,s*.307,2.313),(.614,.014,.12),'enamel','hood')
    for s in [-1,1]:
        a.box('chimney_flange',(s*.32,0,2.370),(.03,.67,.006),'metal','hood')
        a.box('chimney_flange',(0,s*.32,2.370),(.61,.03,.006),'metal','hood')
    # Actual through-opening, not a black rectangle over a solid box.
    # Construct in XY then rotate the whole door group to the X-negative end.
    a.panel('raised_access_door',(0,-.880,2.53),.70,.73,'enamel','door')
    for y in [-.39,.39]:
        a.box('door_guide',(-.890,y,2.11),(.055,.045,1.82),'steel','door_guides')
        a.cyl('lift_pulley',(-.90,y,2.985),.05,.035,'metal','X','door_guides')
    a.group('door').rotation_euler.z=-math.pi/2
    a.box('gantry_top',(-.89,0,3.025),(.08,.862,.054),'steel','door_guides')
    a.motor((-.92,.30,2.92),'Y',.065,.18,'drive')
    for y in [-.36,.36]:a.pipe('door_lift_chain',[(-.925,y,2.57),(-.925,y,2.98)],.008,'black','door_guides',.01)
    a.box('junction_box',(.91,.2,1.16),(.11,.15,.12),'enamel','electrics')

def truncated_hood(a,p,bottom,top,height,group='hood',mat='enamel'):
    x,y,z=p;vertices=[]
    for zz,(w,d) in [(z,bottom),(z+height,top)]:vertices.extend([(x-w/2,y-d/2,zz),(x+w/2,y-d/2,zz),(x+w/2,y+d/2,zz),(x-w/2,y+d/2,zz)])
    mesh=bpy.data.meshes.new('folded_hood');mesh.from_pydata(vertices,[],[(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);mesh.update()
    obj=bpy.data.objects.new('hood',mesh);a.scene.collection.objects.link(obj);a.finish(obj,'folded_hood',mat,group)
    mod=obj.modifiers.new('Sheet thickness','SOLIDIFY');mod.thickness=.014

def side_canopy(a,name,width,profile,group='extraction'):
    vertices=[(x,y,z) for x in [-width/2,width/2] for y,z in profile];n=len(profile)
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh);a.scene.collection.objects.link(o);return a.finish(o,name,'enamel',group,.008)

def cart(a):
    # 600 kg arrangement, drawing 10.13.00, not the 1.2 T revision elsewhere in the file.
    for y in [-.49,.49]:a.box('underframe_side',(0,y,.22),(1.679,.12,.15))
    for x in [-.7125,.7125]:
        a.box('underframe_end',(x,0,.22),(.12,1.10,.15))
        for y in [-.525,.525]:
            a.cyl('flanged_travel_wheel',(x,y,.148),.13,.085,'metal','Y','travel_wheels',32)
            a.cyl('wheel_flange',(x,y+.046,.148),.148,.014,'steel','Y','travel_wheels')
            a.box('wheel_bearing',(x,y,.26),(.20,.12,.13),'teal','travel_wheels')
            a.box('upright',(x,y,.70),(.08,.08,.90))
    for y in [-.49,.49]:a.beam('frame_diagonal',(-.69,y,.40),(.69,y,1.10),.065,.04)
    a.roller_deck(1.61,.77,1.25,7)
    a.box('operator_platform',(0,-1.08,.26),(1.675,1.07,.06))
    for x in [-.80,0,.80]:a.box('platform_stringer',(x,-.99,.20),(.065,1.30,.10))
    for i in range(18):a.box('anti_slip_grating',(0,-1.58+i*.057,.294),(1.62,.014,.012),'metal','platform')
    for x in [-.80,.80]:
        for y in [-1.60,-.55]:a.pipe('safety_post',[(x,y,.29),(x,y,1.36)],.019,'safety','guard')
        a.pipe('side_handrail',[(x,-1.60,1.36),(x,-.55,1.36)],.019,'safety','guard')
        a.pipe('side_midrail',[(x,-1.60,.84),(x,-.55,.84)],.014,'safety','guard')
    for z in [.84,1.36]:a.pipe('outer_handrail',[(-.80,-1.6,z),(.80,-1.6,z)],.019,'safety','guard')
    a.box('control_cabinet',(.52,-1.16,.83),(.47,.36,1.04),'enamel','electrics')
    a.panel('cabinet_door',(.52,-1.35,.82),.425,.85,'enamel','electrics')
    a.box('operator_keypad',(.52,-1.17,1.39),(.48,.38,.065),'enamel','electrics')
    for x in [.39,.52,.65]:
        for y in [-1.28,-1.14]:a.cyl('pushbutton',(x,y,1.435),.018,.022,'red' if x==.65 else 'green','Z','electrics',16)
    for y in [-.28,.28]:
        a.box('chain_backplate',(.81,y,1.70),(.055,.21,.94),'steel','feed_drive')
        # Raised loop, with individually modelled chain links and return lane.
        points=[]
        for angle in range(13):
            t=angle*math.pi/12;points.append((.85,y+.075*math.cos(t),2.07+.075*math.sin(t)))
        for angle in range(13):
            t=math.pi+angle*math.pi/12;points.append((.85,y+.075*math.cos(t),1.34+.075*math.sin(t)))
        points.append(points[0]);a.pipe('chain_guide',points,.013,'metal','feed_drive',.01)
        for z in [1.36+i*.041 for i in range(18)]:
            for yy in [y-.074,y+.074]:a.box('feed_chain_link',(.874,yy,z),(.025,.028,.031),'stainless','feed_drive',.003)
        a.cyl('feed_sprocket',(.84,y,1.32),.09,.07,'steel','X','feed_drive',20)
    a.motor((.87,.03,1.28),'X',.10,.27,'feed_drive')
    a.motor((.34,.17,.46),'Y',.09,.27,'travel_drive')
    a.box('travel_gearbox',(.34,.36,.45),(.19,.18,.20),'teal','travel_drive')
    a.pipe('power_conduit',[(.50,-1.02,.42),(.76,-.68,.42),(.76,-.30,.52)],.018,'gasket','electrics')

def chamber(a,width,depth,z0,z1,front_y,opening,group='housing'):
    # Build wall segments around a genuine opening, including inner lining.
    ow,oh,oz=opening;back=front_y+depth
    for x in [-width/2+.06,width/2-.06]:a.box('cabinet_side',(x,(front_y+back)/2,(z0+z1)/2),(.12,depth,z1-z0),'enamel',group)
    a.box('cabinet_back',(0,back-.05,(z0+z1)/2),(width-.18,.10,z1-z0),'enamel',group)
    for z in [z0+.07,z1-.07]:a.box('cabinet_top_bottom',(0,(front_y+back)/2,z),(width,depth,.14),'enamel',group)
    for s in [-1,1]:a.box('front_jamb',(s*(ow/2+(width-ow)/4),front_y+.09,(z0+z1)/2),((width-ow)/2,.18,z1-z0),'enamel',group)
    for lo,hi in [(z0,oz),(oz+oh,z1)]:
        if hi>lo:a.box('front_spandrel',(0,front_y+.09,(hi+lo)/2),(ow,.18,hi-lo),'enamel',group)
    a.box('chamber_floor',(0,front_y+depth*.48,oz-.03),(ow,depth*.78,.06),'black','lining')
    for x in [-ow/2,ow/2]:a.box('inner_jamb',(x,front_y+depth*.35,oz+oh/2),(.025,depth*.65,oh),'black','lining')

def lift_door(a,front_y,bottom,width=.6,height=.65,top=2.59):
    a.panel('lift_door',(0,front_y-.065,bottom+height/2),width+.15,height+.15,'black','door')
    for x in [-width*.5-.11,width*.5+.11]:
        a.box('door_track',(x,front_y-.09,(bottom+top)/2),(.055,.065,top-bottom+.1),'metal','door_guides')
        a.pipe('door_chain',[(x,front_y-.13,bottom+height),(x,front_y-.13,top)],.009,'steel','door_guides',.01)
    a.box('door_header',(0,front_y-.08,top),(width+.38,.13,.12),'steel','door_guides')
    a.motor((width*.5+.18,front_y-.02,top+.06),'Y',.075,.19,'door_drive')
    a.pipe('door_handle',[(-.13,front_y-.15,bottom+.12),(-.13,front_y-.23,bottom+.12),(.13,front_y-.23,bottom+.12),(.13,front_y-.15,bottom+.12)],.014,'stainless','door',.025)

def temper(a):
    w,d=1.798,1.930;front=-d/2
    for x in [-.77,.77]:
        for y in [-.80,.80]:a.foot(x,y);a.box('base_leg',(x,y,.39),(.11,.11,.70),'edge')
    for y in [-.84,.84]:a.box('base_skid',(0,y,.11),(1.88,.12,.14),'steel')
    a.box('underbody',(0,.03,.61),(1.76,1.80,.35),'enamel','housing')
    chamber(a,w,d,.81,2.322,front,(.600,.650,1.230))
    lift_door(a,front,1.230,.600,.650,2.591)
    for x in [-.921,.921]:
        for y in [-.6,0,.65]:a.box('side_stiffener',(x,y,1.55),(.075,.045,1.40),'edge','housing')
    for x in [-.55,.55]:a.box('rear_roof_rib',(x,.1,2.34),(.06,1.65,.06),'edge','housing')
    # Front extraction canopy projects 1.2 m from the body; top chimney datum 4.024 m.
    side_canopy(a,'sloping_extraction_canopy',1.32,[(front-1.20,2.32),(front-1.20,2.64),(front-.48,3.77),(front+.02,3.77),(front+.02,2.32)])
    a.pipe('exhaust_duct',[(0,front-.40,3.58),(0,front-.40,3.92),(0,front+.11,3.92),(0,front+.11,3.62)],.135,'metal','extraction',.14)
    a.flange((0,front-.40,3.58),.17,'Z','extraction')
    a.ring('open_flue',(0,front-.40,3.982),.15,.127,.084,'metal','Z','extraction')
    a.motor((-.18,.24,2.81),'X',.13,.38,'circulation_fan')
    a.box('roof_fan_seat',(0,.24,2.36),(.45,.45,.09),'enamel','circulation_fan')
    a.cyl('roof_fan_vertical_shaft',(0,.24,2.55),.028,.38,'stainless','Z','circulation_fan')
    a.box('right_angle_fan_drive',(0,.24,2.79),(.17,.18,.17),'teal','circulation_fan')
    for x in [-.25,.10]:a.box('roof_motor_stand',(x,.24,2.59),(.045,.34,.39),'edge','circulation_fan')
    a.box('door_lift_guard',(0,front-.08,2.26),(1.406,.045,.66),'enamel','door_guides')
    for x in [-.65,-.32,0,.32,.65]:a.box('guard_rib',(x,front-.12,2.26),(.018,.018,.66),'edge','door_guides')
    a.pipe('service_line',[(.86,.64,.30),(.98,.64,.30),(.98,.64,2.40),(.3,.64,2.40)],.025,'green','pipes')
    a.handwheel((1.03,.64,1.0))
    a.box('controller',(-.66,front-.08,1.12),(.17,.16,.50),'enamel','electrics')
    a.box('temperature_display',(-.66,front-.168,1.26),(.12,.012,.075),'screen','electrics')
    for z in [.98,1.08]:a.cyl('control_button',(-.66,front-.18,z),.016,.02,'red' if z<1 else 'green','Y','electrics',16)

def wash_lower_body(a):
    """Restore the lower enclosure visible in both 17.07.00 K and side views.

    This is sheet enclosure geometry, NOT an invented solid process tank or an
    exposed X-braced frame. The drawing's diagonal panel lines are represented
    as shallow pressed facets; sheet gauge and fold relief are display-scale
    assumptions, not manufacturing dimensions. Keep the chamber/door opening.
    """
    # K-view LINE 282E6 spans 1200 mm; its elevation is 1121 mm above
    # drawing datum 4964.3063. The existing model's base covers the first
    # 100 mm. Keep the original chamber depth/alignment, rather than moving
    # the whole machine during a local omission repair.
    width,depth=1.200,1.922
    front,bottom,fold_top,top=-.960,.100,1.121,1.295
    back=front+depth;half=width/2;middle=(bottom+fold_top)/2
    vertices=[(x,front,z) for z in [bottom,fold_top,top] for x in [-half,0,half]]
    vertices += [(-half/2,front-.003,middle),(half/2,front-.003,middle)]
    vertices += [(x,back,z) for z in [bottom,fold_top,top] for x in [-half,0,half]]
    # Two continuous folded front panels, closed sides, rear, top and bottom.
    faces=[(0,1,9),(1,4,9),(4,3,9),(3,0,9),
           (1,2,10),(2,5,10),(5,4,10),(4,1,10),
           (3,4,7,6),(4,5,8,7),
           (0,3,14,11),(3,6,17,14),(2,13,16,5),(5,16,19,8),
           (6,7,18,17),(7,8,19,18),
           (0,11,12,1),(1,12,13,2),
           (11,14,15,12),(12,15,16,13),(14,17,18,15),(15,18,19,16)]
    mesh=bpy.data.meshes.new('wash_lower_sheet_enclosure')
    mesh.from_pydata(vertices,[],faces);mesh.update()
    bm=bmesh.new();bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
    obj=bpy.data.objects.new('wash_lower_shell',mesh);a.scene.collection.objects.link(obj)
    a.finish(obj,'wash_lower_shell','enamel','central_lower_body')
    solid=obj.modifiers.new('Inferred 6 mm display sheet','SOLIDIFY')
    solid.thickness=.006;solid.offset=-1;solid.use_even_offset=True
    obj['cad_evidence']='17.07.00 K elevation lower centre enclosure and matching side-view walls'
    obj['inferred_details']='6 mm sheet gauge; 3 mm pressed-panel relief; not manufacturing data'
    obj['cad_panel_width_mm']=1200
    obj['cad_panel_top_elevation_mm']=1121
    for x in [-half,half]:
        a.box('wash_lower_top_rail',(x,(front+back)/2,top-.018),(.040,depth,.036),'edge','central_lower_body',.002)
    wash_lower_collector(a,front)


def wash_lower_collector(a,front=-.960):
    """K-view rectangular lower attachment (49758..4976E) and drain.

    Width 836 and elevations 795/845/1038 are measured drawing geometry.
    Projection depth and sheet gauge are inferred; do not claim tank capacity.
    """
    group='lower_collection';w,d,t=.836,.130,.006
    y=front-d/2
    a.box('wash_lower_collector_back',(0,front-t/2,.9165),(w,t,.243),'enamel',group,.001)
    a.box('wash_lower_collector_front',(0,front-d+t/2,.9415),(w,t,.193),'enamel',group,.001)
    a.box('wash_lower_collector_bottom',(0,y,.798),(w,d,t),'enamel',group,.001)
    for x in [-w/2+t/2,w/2-t/2]:
        a.box('wash_lower_collector_end',(x,y,.9165),(t,d,.243),'enamel',group,.001)
    for x in [-.435,.435]:
        a.box('wash_lower_collector_mount',(x,front-d,.985),(.035,.018,.050),'metal',group,.001)
        a.cyl('wash_lower_mount_bolt',(x,front-d-.013,.985),.008,.012,'metal','Y',group,6)
    a.cyl('wash_lower_drain_spout',(.390,y,.752),.016,.092,'metal','Z',group,20)
    a.cyl('wash_lower_drain_valve',(.390,y,.720),.025,.044,'brass','Z',group,20)
    a.beam('wash_lower_drain_handle',(.415,y,.725),(.465,y,.670),.009,mat='steel',group=group)


def wash(a):
    # Twin side-tank arrangement in 17.07.00, not the photo-derived V7 rear extension.
    w,d=2.650,2.442
    a.box('continuous_base',(0,0,.05),(w,d,.10),'steel')
    wash_lower_body(a)
    for x in [-1.02,1.02]:
        a.box('wash_side_tank',(x,0,.69),(.56,2.08,1.18),'enamel','tanks')
        a.panel('tank_inspection_cover',(x,-1.06,.68),.43,.78,'enamel','tanks')
        for z in [.23,1.22]:a.box('tank_rim',(x,0,z),(.62,2.12,.055),'edge','tanks')
        # Paired threaded heater/inspection ports on the two tank tops.
        for y in [.28,.55,.82]:
            for xx in [x-.13,x+.13]:a.cyl('heater_boss',(xx,y,1.31),.048,.075,'stainless','Z','tanks',20)
        a.cyl('recirculation_volute',(x,-.48,1.92),.19,.12,'teal','Y','blowers',32)
        a.motor((x,-.39,1.92),'Y',.105,.24,'blowers')
        a.box('coil_heat_exchanger',(x,-.48,1.59),(.39,.21,.37),'steel','blowers')
        for z in [1.47,1.54,1.61,1.68]:a.pipe('coil_loop',[(x-.15,-.60,z),(x+.15,-.60,z),(x+.15,-.60,z+.035),(x-.15,-.60,z+.035)],.013,'metal','blowers',.025)
    chamber(a,1.24,1.922,1.295,3.37,-.96,(.600,.650,1.295))
    lift_door(a,-.96,1.295,.600,.650,3.78)
    a.motor((-.22,.74,3.86),'X',.12,.38,'door_drive')
    a.cyl('roof_service_riser',(.26,.38,3.69),.11,.834,'metal','Z','roof_equipment')
    a.flange((.26,.38,3.34),.145,'Z','roof_equipment')
    for x in [-.644,.644]:
        for y in [-.8,-.2,.4,.88]:a.box('chamber_stiffener',(x,y,2.33),(.075,.04,2.05),'edge','housing')
    a.ring('side_service_flange',(-.65,.46,2.96),.24,.15,.05,'metal','X','roof_equipment')
    a.bolts('side_flange_bolt',[(-.69,.46+.205*math.cos(i*math.pi/4),2.96+.205*math.sin(i*math.pi/4)) for i in range(8)],'X','roof_equipment')
    for x in [-.98,.98]:
        a.motor((x,1.12,.45),'Z',.12,.34,'pumps',mat='blue')
        a.cyl('pump_volute',(x,1.12,.22),.15,.18,'blue','Z','pumps')
        a.pipe('spray_riser',[(x,1.12,.27),(x,1.32,.27),(x,1.32,2.82),(x*.48,1.32,2.82),(x*.48,.68,2.82)],.035,'green','pipes',.10)
        for z in [.50,1.0,1.5,2.0,2.5]:a.box('pipe_clamp',(x,1.29,z),(.12,.08,.028),'metal','pipes')
        a.flange((x,1.32,.8),.075)
    a.box('side_control_panel',(1.41,-.22,1.48),(.14,.45,.56),'enamel','electrics')
    a.box('control_screen',(1.41,-.455,1.60),(.11,.015,.14),'screen','electrics')
    a.pipe('rear_drain',[(-1.1,.9,.25),(-1.47,.9,.25),(-1.47,.9,.55)],.03,'metal','pipes')
    a.handwheel((-1.47,.87,.58))

def water_tank(a):
    # Front width 2172, side depth 1654; the extra 1105 is the rear extraction hood.
    w,d=2.172,1.654
    a.box('continuous_base',(0,0,.04),(w,d,.08),'steel')
    a.box('quench_bath_bottom',(-.32,0,.10),(1.45,d,.12),'enamel','tank')
    for x in [-1.01,.37]:a.box('bath_side',(x,0,.82),(.07,d,1.44),'enamel','tank')
    for y in [-.79,.79]:a.box('bath_end',(-.32,y,.82),(1.45,.07,1.44),'enamel','tank')
    for x in [-1.01,.37]:a.box('top_tank_rim',(x,0,1.57),(.10,d,.10),'metal','tank')
    a.box('water_surface',(-.32,0,1.32),(1.30,d-.17,.008),'water','tank')
    # Auxiliary stirring chamber on the right is part of the tank, not an outside pump skid.
    a.box('mixing_tank',(.75,0,.83),(.65,d,1.50),'enamel','tank')
    a.ring('agitator_lid',(.75,0,1.615),.25,.20,.04,'metal','agitator')
    a.box('agitator_support',(.75,0,1.93),(.40,.38,.09),'steel','agitator')
    for x in [.58,.92]:a.box('agitator_column',(x,0,1.78),(.035,.27,.30),'edge','agitator')
    a.motor((.75,0,2.11),'Z',.105,.26,'agitator')
    a.cyl('agitator_shaft',(.75,0,.99),.024,1.60,'stainless','Z','agitator')
    # The upper enclosed lifting chamber and sloping extraction canopy dominate the CAD silhouette.
    upper=a.group('upper_housing')
    chamber(a,1.45,d,1.633,3.013,-d/2,(.60,.65,1.633),'upper_housing')
    # All upper chamber pieces are centred over the left quench bath.
    upper.location.x=-.32
    a.group('lining').location.x=-.32
    lift_door(a,-d/2,1.633,.60,.65,2.99)
    for group in ['door','door_guides','door_drive']:a.group(group).location.x=-.32
    for x in [-.98,.34]:
        for y in [-.73,.73]:a.box('lift_column',(x,y,1.55),(.065,.065,2.96),'edge','hoist_frame')
    a.roller_deck(1.10,.60,1.633,6,'basket');a.group('basket').rotation_euler.z=math.pi/2;a.group('basket').location.x=-.32
    for y in [-.45,.45]:a.beam('basket_lifting_strut',(-.32,y,1.61),(-.32,.05,2.40),.035,mat='metal',group='hoist')
    a.cyl('lifting_ram',(-.32,.05,2.65),.055,.50,'metal','Z','hoist')
    a.motor((-.79,.36,3.16),'X',.11,.30,'hoist_drive')
    a.box('hoist_reducer',(-.48,.36,3.08),(.25,.22,.20),'teal','hoist_drive')
    canopy=side_canopy(a,'rear_extraction_canopy',1.32,[(.79,1.57),(1.932,1.57),(1.932,2.88),(1.38,3.83),(.79,3.83)]);canopy.location.x=-.32
    a.pipe('extraction_duct',[(-.32,.35,3.00),(-.32,.35,3.99),(-.32,1.2,3.99),(-.32,1.2,4.22)],.105,'metal','extraction',.14)
    a.ring('open_flue',(-.32,1.2,4.275),.13,.105,.09,'metal','Z','extraction')
    a.pipe('tank_drain',[(.87,-.48,.20),(1.17,-.48,.20),(1.17,-.48,.44)],.033,'green','pipes',.08)
    a.handwheel((1.17,-.52,.48))
    a.panel('lower_access_cover',(-.32,-.844,.74),.64,.95,'enamel','tank')
    a.box('controls',(.50,-.91,1.72),(.20,.14,.35),'enamel','electrics')
    a.box('controls_display',(.50,-.986,1.78),(.14,.012,.09),'screen','electrics')

def bounds(objects):
    corners=[o.matrix_world@v.co for o in objects if o.type=='MESH' for v in o.data.vertices]
    return [min(v[i] for v in corners) for i in range(3)]+[max(v[i] for v in corners) for i in range(3)]

def look(o,target):o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()

def studio(a,box):
    scene=a.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=16;scene.cycles.use_denoising=True
    scene.render.threads_mode='FIXED';scene.render.threads=4
    scene.render.resolution_x=1000;scene.render.resolution_y=900;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    scene.world=bpy.data.worlds.new(a.id+'_studio_world');scene.world.use_nodes=True
    scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.22,.27,.31,1)
    scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.35
    center=Vector(tuple((box[i]+box[i+3])/2 for i in range(3)));span=max(box[i+3]-box[i] for i in range(3))
    floor=a.box('review_floor',(center.x,center.y,-.04),(200,200,.08),'floor','review',0)
    floor.parent=None
    for loc,power,size in [((2,-4,7),1700,5),((-5,-1,4),1100,4),((3,5,7),2200,4)]:
        bpy.ops.object.light_add(type='AREA',location=center+Vector(loc)*max(1,span/3));light=bpy.context.object;light.data.energy=power*max(1,span/3)**2;light.data.shape='DISK';light.data.size=size*max(1,span/3);look(light,center)
    bpy.ops.object.camera_add(location=center+Vector((5,-7,4.5))*max(1,span/3));camera=bpy.context.object;scene.camera=camera;camera.data.type='ORTHO';camera.data.ortho_scale=span*1.48;look(camera,center)
    return camera,center,span

def export(a):
    bpy.context.window.scene=a.scene
    # Resuming a saved source must not accumulate empty studio groups in GLB.
    for obj in list(a.root.children):
        if obj.get('part')=='review':bpy.data.objects.remove(obj,do_unlink=True)
    a.groups.pop('review',None)
    for o in list(a.root.children_recursive):
        if o.type not in ['MESH','CURVE','FONT']:continue
        if getattr(a,'prepared_geometry',False):
            # A resumed editable source was saved after this exact preparation.
            # Assert its baked state; final exported geometry is still audited.
            assert o.type=='MESH' and not o.modifiers,o.name
            assert max(abs(v) for v in o.rotation_euler)<1e-6 and max(abs(v-1) for v in o.scale)<1e-6,o.name
            continue
        bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
        if o.type in ['CURVE','FONT']:bpy.ops.object.convert(target='MESH')
        for mod in list(o.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
        mesh=bmesh.new();mesh.from_mesh(o.data);bmesh.ops.recalc_face_normals(mesh,faces=mesh.faces);mesh.to_mesh(o.data);mesh.free();o.data.update()
    bpy.context.view_layer.update();meshes=[o for o in a.root.children_recursive if o.type=='MESH'];box=bounds(meshes)
    # No environment geometry, lights, cameras or text in a GLB.
    assert box[2]>=-.001,box
    edit_objects=len(meshes)
    camera,center,span=studio(a,box)
    review=a.groups.pop('review',None)
    if review:bpy.data.objects.remove(review,do_unlink=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'sources'/(a.filename+'.blend')),compress=True)
    by_group_material=defaultdict(list)
    for o in meshes:by_group_material[(o.parent.name,o.data.materials[0].name)].append(o)
    for (group,material),objects in by_group_material.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        if len(objects)>1:bpy.ops.object.join()
        objects[0].name=group+'_'+material.removeprefix('CAD26_')
    meshes=[o for o in a.root.children_recursive if o.type=='MESH']
    bpy.ops.object.select_all(action='DESELECT');a.root.select_set(True)
    for o in a.root.children_recursive:o.select_set(True)
    file=OUT/(a.filename+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(file),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True,export_apply=True,export_extras=True,export_animations=False,export_lights=False,export_cameras=False)
    triangles=sum(len(p.vertices)-2 for o in meshes for p in o.data.polygons)
    assert triangles<getattr(a,'triangle_budget',150000),(a.id,triangles)
    for suffix,direction in [('preview',(5,-7,4.5)),('rear',(-5,7,4))]:
        camera.location=center+Vector(direction)*max(1,span/3);look(camera,center)
        picture=OUT/'previews'/(a.filename+'_'+suffix+'.png')
        # OneDrive/preview readers can briefly hold the existing PNG open.
        # Render a fresh file, then promote it instead of truncating that file.
        temporary=picture.with_name(picture.stem+'.rendering.png')
        a.scene.render.filepath=str(temporary);bpy.ops.render.render(write_still=True)
        for attempt in range(20):
            try:temporary.replace(picture);break
            except PermissionError:
                if attempt==19:raise
                time.sleep(.25)
    # Round trip every exported GLB in an isolated scene; unit/transform drift is a failure.
    check_scene=bpy.data.scenes.new(a.id+'_roundtrip');bpy.context.window.scene=check_scene
    bpy.ops.import_scene.gltf(filepath=str(file));check_meshes=[o for o in check_scene.objects if o.type=='MESH'];bpy.context.view_layer.update();back=bounds(check_meshes)
    error=max(abs(x-y) for x,y in zip(box,back));assert error<1e-4,(a.id,box,back,error)
    metadata={'model_id':a.id,'name':a.label,'file':file.name,'source':SOURCES[a.key],
       'unit':'m','up_axis':'Y','floor_origin':'bottom; installation datums retained separately',
       'reference_dimensions_mm':a.dimensions,'notes':a.notes,'bounds_blender_m':box,
       'size_gltf_m':[box[3]-box[0],box[5]-box[2],box[4]-box[1]],
       'editable_meshes':edit_objects,'runtime_meshes':len(meshes),'triangles':triangles,'bytes':file.stat().st_size,
       'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'roundtrip_max_error_m':error,
       'functional_groups':[k for k in a.groups if k!='review'],
       'runtime':{'enableGenericBindings':False,'enableInspection':False},'partBindings':[]}
    (OUT/'metadata'/(a.key+'.json')).write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf8')
    print('CAD_ASSET_DONE '+json.dumps({k:metadata[k] for k in ['name','file','triangles','runtime_meshes','bytes','roundtrip_max_error_m']},ensure_ascii=False),flush=True)
    return metadata

JOBS=[
 ('transfer_cart','料车','10.13.00_料车',{'bed_length':1610,'main_frame_length':1679,'operator_side_envelope':2343,'bed_level':1250,'wheelbase':1425,'wheel_track':1050},['选用 600 料车／10.13.00；不采用同文件中 1.2T／10.02.00 版本。未标注链架细节按视图比例重建。'],cart),
 ('lifting_staging_table','升降备料台','11.14.00_升降备料台',{'deck_length':1710,'deck_width':700,'lift_table_level':1045,'working_level':1200,'roller_diameter':60,'roller_length':136,'axle_diameter':20},['以总图明确文字 1045 mm 为升降台面标高，滚轮组件到工作高度 1200 mm；不采用采购页旧注 1050。5 对滚轮，轴距 320 mm。'],lambda a:table(a,True)),
 ('fixed_staging_table','固定备料台','11.22.00_固定备料台',{'length':1710,'width':700,'working_level':1250,'roller_diameter':60,'roller_length':167,'axle_diameter':20},['两份重复布置是同一台设备，不合并成双台。6 对滚轮，轴距 280 mm。'],lambda a:table(a,False)),
 ('air_cooling_table','风冷台','11.58.00HT_风冷台',{'length':1816,'width':862,'hood_height':2373,'gantry_height':3052,'working_level':1250},['选用 HT 升降门版本；不是同文件中的 XQ 简版。'],air_cool),
 ('water_cooling_tank','水冷槽','47.10.00_水冷槽',{'tank_length':1654,'tank_width':2172,'overall_height':4320,'working_level_above_floor':1250,'below_floor':383},['完整显示下部槽体；安装时地坪基准比模型底部高 383 mm。液面为静态可移除组件。'],water_tank),
 ('tempering_furnace','回火炉','09.13.00_回火炉',{'body_width':1798,'body_depth':1930,'overall_height':4024,'door_width':600,'door_height':650,'door_sill':1230},['选用 600KG／09.13.00 原总图；不混用 4424 mm 加高或 XQ 版本。炉内滚道、加热元件和循环机构依剖视图重建，未标注零件尺寸按视图比例推定。'],temper),
 ('washing_machine','清洗机','17.07.00_清洗机',{'base_width':2650,'body_depth':2442,'service_envelope_depth':2900,'max_height':4107,'door_width':600,'door_height':650,'installation_depth':150},['选用 17.07.00 高提升版本（MAX 4107），保留双侧水箱、循环管路及驱动；不是照片 V7 外形。'],wash),
]

def main():
    if not bpy.app.background:raise RuntimeError('Use a separate --background --factory-startup Blender process')
    results=[];only=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    for key,label,filename,dimensions,notes,builder in JOBS:
        if only and key not in only:continue
        bpy.ops.wm.read_factory_settings(use_empty=True);palette()
        a=Asset(key,label,filename,dimensions,notes);builder(a);results.append(export(a))
    existing=[]
    for path in (OUT/'metadata').glob('*.json'):existing.append(json.loads(path.read_text(encoding='utf8')))
    (OUT/'manifest.json').write_text(json.dumps({'version':1,'source':'seven supplied DWG general arrangements','models':existing},ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
