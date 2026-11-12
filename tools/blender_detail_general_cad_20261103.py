"""CAD detail pass. Preserve drawing-specific mechanisms; do not substitute generic boxes.

Uses the same isolated, metre-scale export/reimport pipeline as the base builder.
The CAD feature list is checked against actual editable geometry before export.
"""
from pathlib import Path
import sys,math,json
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as base
import bpy,bmesh
from mathutils import Vector

def delete_group(a,key):
    group=a.groups.pop(key,None)
    if group:
        for obj in list(group.children_recursive):bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.objects.remove(group,do_unlink=True)

def remove(a,*names):
    for obj in list(a.root.children_recursive):
        if any(obj.name==a.id+'_'+n or obj.name.startswith(a.id+'_'+n+'.') for n in names):bpy.data.objects.remove(obj,do_unlink=True)

def cylinder_between(a,name,start,end,r,mat='metal',group='details',n=24):
    start,end=Vector(start),Vector(end)
    obj=a.cyl(name,(start+end)/2,r,(end-start).length,mat,'Z',group,n)
    obj.rotation_euler=(end-start).to_track_quat('Z','Y').to_euler();return obj

def hardware(a,point,axis='Z',radius=.012,group='fasteners'):
    x,y,z=point;v=Vector((1,0,0) if axis=='X' else (0,1,0) if axis=='Y' else (0,0,1))
    a.ring('bolt_washer',point,radius*1.55,radius*.57,radius*.27,'metal',axis,group,16)
    a.cyl('hex_nut',Vector(point)+v*(radius*.52),radius,radius*.78,'metal',axis,group,6)
    a.cyl('thread_end',Vector(point)+v*radius,radius*.54,radius*.42,'stainless',axis,group,16)

def sprocket(a,point,radius=.12,teeth=8,width=.024,axis='Y',group='drive_detail'):
    # Actual annular toothed contour, not a cylinder carrying a painted cog symbol.
    segments=teeth*6;vertices=[];faces=[]
    for z in [-width/2,width/2]:
        for inner in [False,True]:
            for i in range(segments):
                angle=i*2*math.pi/segments
                r=radius*.20 if inner else radius*([.77,.85,1,1,.85,.77][i%6])
                vertices.append((r*math.cos(angle),r*math.sin(angle),z))
    n=segments
    for i in range(n):
        j=(i+1)%n;faces += [(i,j,2*n+j,2*n+i),(n+j,n+i,3*n+i,3*n+j),(j,i,n+i,n+j),(2*n+i,2*n+j,3*n+j,3*n+i)]
    mesh=bpy.data.meshes.new('toothed_sprocket');mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new('sprocket',mesh);a.scene.collection.objects.link(obj);obj.location=point
    if axis=='Y':obj.rotation_euler[0]=math.pi/2
    elif axis=='X':obj.rotation_euler[1]=math.pi/2
    a.finish(obj,'toothed_sprocket','metal',group,.0012)
    a.ring('sprocket_hub',point,radius*.39,radius*.20,width*1.8,'steel',axis,group)
    return obj

def grooved_pulley(a,point,radius,width=.050):
    """Machined belt wheel: relieved disc, four through-holes and two grooves."""
    x,y,z=point;group='belt_drive'
    disc=a.cyl('pulley_web',point,radius*.82,width*.38,'metal','X',group,64)
    bpy.context.view_layer.objects.active=disc;disc.select_set(True)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    # Four round lightening holes are visible in the CAD wheel face.
    for i in range(4):
        theta=i*math.pi/2;hole=a.cyl('pulley_hole_tool',(x,y+radius*.49*math.cos(theta),z+radius*.49*math.sin(theta)),radius*.16,width*3,'metal','X','temporary',24)
        mod=disc.modifiers.new('Through hole','BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=hole
        bpy.context.view_layer.objects.active=disc;bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(hole,do_unlink=True)
    a.ring('grooved_pulley',point,radius-.005,radius*.78,width*.88,'metal','X',group,64)
    for dx in [-width/2,0,width/2]:a.ring('pulley_groove_flange',(x+dx,y,z),radius+.003,radius*.78,.005,'metal','X',group,64)
    a.ring('pulley_hub',point,radius*.25,radius*.10,width*1.4,'steel','X',group,40)
    for i in range(4):
        theta=i*math.pi/2;hardware(a,(x-width*.72,y+radius*.18*math.cos(theta),z+radius*.18*math.sin(theta)),'X',.006,group)

def open_belt(a,large,small,large_radius,small_radius):
    """Two real tangent runs and circular wraps, rather than a trapezoid."""
    c1=Vector(large);c2=Vector(small);direction=(c2-c1).normalized()
    perpendicular=Vector((0,-direction.z,direction.y));distance=(c2-c1).length
    theta=math.acos((large_radius-small_radius)/distance)
    def radial(t):return direction*math.cos(t)+perpendicular*math.sin(t)
    for dx in [-.0125,.0125]:
        offset=Vector((dx,0,0))
        points=[c1+radial(theta)*large_radius+offset,c2+radial(theta)*small_radius+offset]
        points += [c2+radial(theta-2*theta*i/24)*small_radius+offset for i in range(1,25)]
        points += [c1+radial(-theta)*large_radius+offset]
        points += [c1+radial(-theta-(2*math.pi-2*theta)*i/32)*large_radius+offset for i in range(1,33)]
        a.pipe('tangent_drive_belt',points,.006,'gasket','belt_drive',.003)

def oval_route(cx,cy,zlow,zhigh,radius,plane='XZ',steps=18):
    points=[]
    for center,start in [(zhigh,0),(zlow,math.pi)]:
        for i in range(steps+1):
            t=start+i*math.pi/steps
            u,v=radius*math.cos(t),center+radius*math.sin(t)
            points.append((cx+u,cy,v) if plane=='XZ' else (cx,cy+u,v))
    points.append(points[0]);return points

def chain(a,points,pitch=.045,width=.025,group='chain',pin_axis='Y'):
    # Capsule plates, roller barrels, cross pins and alternate side plates.
    points=[Vector(v) for v in points];segments=list(zip(points,points[1:]));lengths=[(b-a).length for a,b in segments]
    total=sum(lengths);count=max(4,math.ceil(total/pitch));distance=0;segment=0
    for i in range(count):
        at=i*total/count
        while segment<len(segments)-1 and at>distance+lengths[segment]:distance+=lengths[segment];segment+=1
        first,last=segments[segment];direction=(last-first).normalized();p=first+direction*(at-distance)
        axle=Vector((0,1,0) if pin_axis=='Y' else (1,0,0))
        for side in [-1,1]:
            offset=axle*width*side*.66
            a.beam('chain_side_plate',p+offset-direction*pitch*.35,p+offset+direction*pitch*.35,.014,.007,'steel' if i%2 else 'metal',group)
        a.cyl('chain_roller',p,.011,width,'stainless',pin_axis,group,12)
        a.cyl('chain_rivet',p,.006,width*1.8,'metal',pin_axis,group,10)

def louver_bank(a,center,width,height,count=7,group='ventilation'):
    x,y,z=center;a.box('vent_recess',(x,y,z),(width,.014,height),'black',group,.002)
    for i in range(count):
        o=a.box('pressed_louver',(x,y-.012,z-height*.43+i*height*.86/(count-1)),(width*.93,.026,height/(count*2.4)),'edge',group,.002);o.rotation_euler.x=.35

def gauge(a,point,r=.043,group='instrumentation'):
    x,y,z=point;a.cyl('pressure_gauge_body',(x,y+.012,z),r,.035,'metal','Y',group,32)
    a.cyl('gauge_dial',(x,y-.010,z),r*.85,.005,'enamel','Y',group,32)
    for i in range(9):
        angle=math.pi*.17+i*math.pi*1.65/8
        p=(x+r*.66*math.cos(angle),y-.015,z+r*.66*math.sin(angle))
        q=(x+r*.80*math.cos(angle),y-.015,z+r*.80*math.sin(angle));a.beam('gauge_tick',p,q,.002,mat='black',group=group)
    a.beam('gauge_pointer',(x,y-.018,z),(x+r*.57,y-.018,z+r*.14),.0025,mat='red',group=group)

def valve(a,point,r=.028,axis='Z',group='valve_detail'):
    x,y,z=point;a.cyl('valve_body',point,r*1.7,.10,'brass',axis,group)
    a.cyl('valve_bonnet',(x,y-.04,z),r*.75,.10,'metal','Y',group)
    a.handwheel((x,y-.11,z),r*2.5,'Y',group)
    a.flange((x,y,z-.08),r*2.2,axis,group);a.flange((x,y,z+.08),r*2.2,axis,group)

def hatch(a,point,width,height,group='access_detail',facing=-1):
    x,y,z=point
    a.box('service_hatch_gasket',(x,y-facing*.006,z),(width+.018,.028,height+.018),'gasket',group)
    a.box('service_hatch',point,(width,.018,height),'enamel',group)
    a.bolts('hatch_cover_screw',[(x+sx*(width/2-.035),y+facing*.016,z+sz*(height/2-.035)) for sx in [-1,1] for sz in [-1,1]],'Y',group,.008)
    for zz in [z-height*.30,z+height*.30]:
        a.cyl('hatch_hinge',(x-width/2-.016,y,zz),.015,.07,'metal','Z',group,16)
    a.pipe('hatch_pull',[(x+width*.28,y+facing*.02,z-.045),(x+width*.28,y+facing*.07,z-.045),(x+width*.28,y+facing*.07,z+.045),(x+width*.28,y+facing*.02,z+.045)],.009,'metal',group,.015)

def maker_plate(a,p,width=.52,height=.11):
    x,y,z=p;a.box('manufacturer_plaque',p,(width,.012,height),'metal','nameplates',.004)
    bpy.ops.object.text_add(location=(x-width*.44,y-.008,z-height*.30),rotation=(math.pi/2,0,0))
    text=bpy.context.object;text.name=a.id+'_maker_mark';text.parent=a.group('nameplates')
    text.data.body='KINGKIND';text.data.align_x='LEFT';text.data.size=height*.70;text.data.extrude=.0006;text.data.materials.append(base.MATS['enamel'])
    for xx in [x-width*.46,x+width*.46]:a.cyl('plaque_rivet',(xx,y-.010,z),.003,.006,'stainless','Y','nameplates',10)

def instrument_stack(a,x,front,bottom):
    # The front elevations show three separate instruments, not one generic box.
    for i in range(3):
        z=bottom+i*.18
        a.box('process_instrument',(x,front-.07,z),(.16,.12,.15),'enamel','process_instruments',.006)
        a.box('instrument_bezel',(x,front-.133,z+.020),(.126,.008,.070),'black','process_instruments',.002)
        a.box('instrument_glass',(x,front-.139,z+.020),(.108,.005,.050),'screen','process_instruments',.001)
        for dx in [-.045,0,.045]:a.cyl('instrument_key',(x+dx,front-.137,z-.047),.007,.008,'metal','Y','process_instruments',12)
        a.cyl('instrument_power_led',(x+.060,front-.138,z+.054),.004,.007,'green','Y','process_instruments',12)

def detailed_cart(a):
    base.cart(a);delete_group(a,'feed_drive');remove(a,'wheel_bearing')
    # One central XZ return-chain plate is shown in 10.13.00. Not two YZ masts.
    a.box('central_return_chain_plate',(.806,0,1.72),(.462,.020,.90),'steel','return_chain')
    for side in [-1,1]:
        for r in [.122,.150,.183]:a.pipe('oval_chain_race',oval_route(.806,side*.021,1.46,1.99,r),.008,'metal','return_chain',.005)
    chain(a,oval_route(.806,-.038,1.46,1.99,.150),pitch=.048,width=.027,group='return_chain')
    for x in [.597,1.015]:
        for z in [1.33,1.63,2.12]:hardware(a,(x,-.031,z),'Y',.009,'return_chain')
    sprocket(a,(.806,-.018,1.16),.135,8,.03,'Y','feed_sprocket')
    a.cyl('feed_drive_shaft',(.806,0,1.16),.025,.24,'stainless','Y','feed_sprocket')
    a.motor((.76,.17,1.43),'Z',.09,.24,'feed_motor')
    a.box('feed_reduction_case',(.806,.10,1.275),(.18,.21,.16),'teal','feed_motor')
    a.ring('motor_output_flange',(.806,-.025,1.28),.073,.033,.02,'metal','Y','feed_motor')
    a.box('central_push_guide',(0,0,1.273),(1.315,.234,.035),'metal','pusher')
    a.box('pusher_shuttle',(-.06,0,1.312),(.23,.17,.045),'steel','pusher')
    for x in [-.64,0,.64]:
        for y in [-.075,.075]:hardware(a,(x,y,1.301),'Z',.010,'pusher')
    for x in [.90,.98,1.06]:
        a.cyl('chain_entry_guide_roller',(x,0,1.288),.021,.20,'stainless','Y','pusher',20)
    a.box('spring_latch_bracket',(.53,-.15,1.325),(.14,.08,.012),'metal','feed_interlock')
    a.beam('toggle_latch_lever',(.53,-.17,1.34),(.47,-.17,1.45),.025,.015,'steel','feed_interlock')
    a.cyl('latch_pin',(.53,-.16,1.34),.015,.09,'metal','Y','feed_interlock')
    a.box('limit_switch',(.49,-.16,1.40),(.06,.055,.08),'teal','feed_interlock')
    for z in [1.35,1.37,1.39]:a.ring('latch_return_spring',(.53,-.20,z),.013,.009,.006,'metal','Z','feed_interlock',16)
    # Wheelbase 1425 is longitudinal; each axle crosses the 1050-wide track.
    for x in [-.7125,.7125]:
        a.cyl('full_width_drive_axle',(x,0,.148),.025,1.22,'stainless','Y','travel_wheels')
        for y in [-.525,.525]:
            a.box('split_axle_bearing',(x,y,.24),(.18,.13,.13),'teal','axle_detail')
            for dx in [-.058,.058]:hardware(a,(x+dx,y,.31),'Z',.011,'axle_detail')
            a.ring('axle_retaining_washer',(x,y+.065,.148),.047,.025,.012,'metal','Y','axle_detail')
            a.cyl('axle_retaining_nut',(x,y+.08,.148),.036,.025,'metal','Y','axle_detail',6)
    sprocket(a,(.34,.41,.44),.062,12,.018,'Y','travel_chain')
    sprocket(a,(.66,.41,.17),.080,16,.018,'Y','travel_chain')
    chain(a,[(.30,.42,.49),(.73,.42,.22),(.71,.42,.10),(.27,.42,.39),(.30,.42,.49)],.035,.018,'travel_chain')
    for x in [-.7125,.7125]:
        for y in [-.525,.525]:
            a.box('anti_lift_keeper',(x,y+.09,.095),(.13,.025,.045),'steel','axle_detail')
            hardware(a,(x,y+.09,.121),'Z',.009,'axle_detail')
    for left,right in [(-.79,-.27),(-.27,.27),(.27,.79)]:
        for y in [-1.56,-.64]:a.box('walkway_underside_tie',((left+right)/2,y,.207),(right-left,.045,.06),'steel','platform')
        a.beam('walkway_cross_brace',(left,-1.56,.21),(right,-.64,.21),.025,.013,'metal','platform')
        a.beam('walkway_cross_brace',(right,-1.56,.21),(left,-.64,.21),.025,.013,'metal','platform')
    louver_bank(a,(.52,-1.371,1.11),.32,.18,5,'cabinet_details')
    hatch(a,(.52,-1.371,.75),.415,.58,'cabinet_details')
    a.cyl('cabinet_cam_lock',(.66,-1.404,.76),.014,.012,'metal','Y','cabinet_details',16)

def detailed_table(a,lifting):
    base.table(a,lifting)
    positions=[-.685,-.365,-.045,.275,.595] if lifting else [-.805,-.525,-.245,.035,.315,.595]
    for y in [-.305,.305]:
        for x in positions:
            a.ring('roller_axle_spacer',(x,y,1.170 if lifting else 1.220),.023,.018,.009,'metal','Y','roller_details',20)
    if lifting:
        remove(a,'hydraulic_barrel','hydraulic_piston','pump_pack')
        first,mid,last=(.48,0,.16),(.20,0,.59),(.03,0,.83)
        cylinder_between(a,'hydraulic_cylinder_barrel',first,mid,.043,'teal','hydraulics',32)
        cylinder_between(a,'hard_chrome_piston',mid,last,.019,'stainless','hydraulics',32)
        for p in [first,last]:
            a.ring('cylinder_mount_eye',p,.04,.019,.065,'metal','Y','hydraulics',24)
            hardware(a,Vector(p)+Vector((0,-.04,0)),'Y',.015,'pivot_detail')
        a.box('hydraulic_reservoir',(.30,0,.13),(.29,.25,.16),'teal','hydraulic_pack')
        a.cyl('oil_filler_cap',(.27,.035,.23),.022,.035,'black','Z','hydraulic_pack',16)
        a.motor((.49,0,.14),'X',.050,.14,'hydraulic_pack')
        for p in [(0,-.35,.545),(0,.35,.545)]:
            hardware(a,p,'Y',.028,'pivot_detail');a.cyl('pivot_cross_pin',p,.023,.16,'metal','Y','pivot_detail')
        for y in [-.31,.31]:
            for x in [-.65,.65]:
                a.cyl('scissor_travel_roller',(x,y,.145),.033,.055,'metal','Y','slide_detail',24)
                a.box('slider_retainer',(x,y-.04,.14),(.09,.016,.055),'steel','slide_detail')
        for p in [(.45,.04,.20),(.28,0,.51)]:a.cyl('hydraulic_hose_union',p,.017,.042,'brass','Z','hydraulics',6)
    else:
        for x in [-.755,.755]:
            for y in [-.265,.265]:
                a.cyl('levelling_thread',(x,y,.075),.013,.10,'stainless','Z','levelling',20)
                hardware(a,(x,y,.087),'Z',.022,'levelling')
                hardware(a,(x,y,.112),'Z',.022,'levelling')
                a.box('welded_foot_bracket',(x+.032,y,.11),(.095,.075,.015),'steel','levelling')
    # Guide plate, roller-release linkage and mechanical end-stop clamp.
    a.box('fork_stop_bracket',(.81,0,1.25 if not lifting else 1.20),(.045,.30,.04),'metal','stop_detail')
    for y in [-.10,.10]:hardware(a,(.81,y,1.275 if not lifting else 1.225),'Z',.010,'stop_detail')
    a.cyl('release_link_pin',(.88,.045,1.10),.012,.13,'metal','Y','stop_detail')

def door_details(a,front,bottom,width,height,top,offset=0):
    for s in [-1,1]:
        x=offset+s*(width/2+.11)
        for z in [bottom+.09,bottom+height-.08]:
            a.cyl('door_carriage_roller',(x,front-.13,z),.027,.027,'metal','Y','door_carriages',24)
            hardware(a,(x,front-.15,z),'Y',.012,'door_carriages')
        chain(a,[(x,front-.145,bottom+height),(x,front-.145,top)],.045,.017,'door_chains')
        a.cyl('upper_chain_pulley',(x,front-.13,top-.02),.052,.035,'metal','Y','door_chains',28)
        a.box('chain_tensioner',(x,front-.16,bottom+height+.12),(.045,.04,.08),'metal','door_chains')
        for z in [bottom-.035,bottom+height+.035]:a.box('door_sealing_strip',(offset,front-.112,z),(width+.13,.014,.021),'gasket','door_seals')
    for x in [offset-width*.42,offset+width*.42]:
        a.cyl('door_lug_pin',(x,front-.13,bottom+.10),.012,.08,'metal','Y','door_safety')
    a.box('door_safety_switch',(offset+width/2+.17,front-.12,bottom+height-.03),(.055,.055,.09),'teal','door_safety')

def furnace_internals(a,front,door_bottom,depth,offset=0):
    for i in range(7):
        y=front+.16+i*(depth-.35)/6
        a.cyl('internal_load_roller',(offset,y,door_bottom-.045),.047,.53,'stainless','X','internal_rollers',24)
        for x in [offset-.29,offset+.29]:a.box('internal_roller_bearing',(x,y,door_bottom-.055),(.055,.08,.07),'metal','internal_rollers')
    for side in [-1,1]:
        x=offset+side*.32
        for z in [door_bottom+.12,door_bottom+.32,door_bottom+.52]:
            a.pipe('internal_heater_element',[(x,front+.22,z),(x,front+depth-.2,z),(x,front+depth-.2,z+.055),(x,front+.22,z+.055)],.008,'black','heating_elements',.03)
    a.cyl('circulation_impeller_shaft',(offset,front+depth*.58,door_bottom+.72),.025,.42,'stainless','Z','internal_fan')
    for i in range(8):
        angle=i*math.pi/4
        obj=a.box('circulation_impeller_blade',(offset+.13*math.cos(angle),front+depth*.58+.13*math.sin(angle),door_bottom+.73),(.18,.045,.018),'metal','internal_fan',.003);obj.rotation_euler.z=angle+.40

def detailed_temper(a):
    base.temper(a);front=-.965
    remove(a,'controller','temperature_display','control_button')
    instrument_stack(a,.71,front,1.28)
    door_details(a,front,1.23,.6,.65,2.591);furnace_internals(a,front,1.23,1.93)
    # The roof plan shows two banks of six terminals, not four per bank.
    for y in [-.70,-.42,-.14,.14,.42,.70]:
        for x in [-.66,.66]:
            a.cyl('heater_porcelain_terminal',(x,y,2.376),.026,.075,'enamel','Z','heater_terminals',20)
            a.cyl('terminal_contact',(x,y,2.43),.008,.035,'brass','Z','heater_terminals',16)
    a.ring('roof_circulation_cover',(0,.24,2.387),.27,.11,.020,'metal','Z','circulation_cover',40)
    for i in range(12):
        angle=i*math.pi/6;hardware(a,(.235*math.cos(angle),.24+.235*math.sin(angle),2.405),'Z',.008,'circulation_cover')
    for x in [-.72,.72]:
        for z in [1.04,1.50,1.98]:hardware(a,(x,front-.025,z),'Y',.010,'panel_fasteners')
    a.pipe('bottom_service_return',[(.88,.64,.32),(.88,-.48,.32),(.88,-.48,.64)],.024,'green','process_pipes')
    valve(a,(.98,.64,1.01),.024)
    gauge(a,(.99,.56,1.54))
    hatch(a,(0,.978,1.53),1.37,.98,'rear_service_hatch',facing=1)
    maker_plate(a,(0,front-1.211,2.49),.58,.105)
    for y in [-.70,.70]:
        for x in [-.72,.72]:a.ring('lifting_eye',(x,y,2.39),.047,.024,.026,'metal','Y','lifting_eyes')
    a.pipe('thermocouple_entry',[(.35,.60,2.43),(.35,.60,2.56),(.55,.60,2.56)],.010,'metal','instrumentation',.035)

def detailed_air(a):
    base.air_cool(a)
    for x in [-.28,.28]:
        for radius in [.10,.14,.18,.212]:a.ring('fan_safety_grille',(x,0,.785),radius,max(.002,radius-.004),.005,'metal','Z','fan_guards',40)
        for i in range(8):
            t=i*math.pi/4;a.beam('fan_grille_spoke',(x,0,.782),(x+.215*math.cos(t),.215*math.sin(t),.782),.005,mat='metal',group='fan_guards')
        for y in [-.29,.29]:hardware(a,(x,y,1.18),'Z',.011,'fan_mounts')
    for y in [-.36,.36]:
        chain(a,[(-.93,y,2.55),(-.93,y,2.98)],.043,.018,'door_lift_chain',pin_axis='X')
        for z in [2.29,2.76]:a.cyl('door_running_roller',(-.92,y,z),.025,.035,'metal','X','door_carriages')
    for y in [-.39,.39]:
        for z in [1.40,1.73,2.03]:
            a.box('hinged_hood_clip',(.86,y,z),(.025,.045,.08),'metal','hood_latches')
            a.cyl('hood_clip_pin',(.88,y,z),.009,.04,'metal','X','hood_latches',12)
    for x in [-.29,0,.29]:
        for y in [-.32,.32]:hardware(a,(x,y,2.377),'Z',.009,'duct_flange_bolts')
    for y in [-.27,0,.27]:
        for x in [-.32,.32]:hardware(a,(x,y,2.377),'Z',.009,'duct_flange_bolts')
    a.pipe('motor_power_conduit',[(.28,.1,.9),(.28,.41,.9),(.90,.41,.9),(.90,.2,1.15)],.013,'gasket','electrics')

def detailed_wash(a):
    base.wash(a);delete_group(a,'blowers') # Those fans belong to the other lower-height revision.
    instrument_stack(a,.53,-.96,1.80)
    door_details(a,-.96,1.295,.60,.65,3.78);furnace_internals(a,-.96,1.295,1.922)
    # Washer heat is supplied from the side-tank elements. No furnace-like
    # serpentine heaters or low-mounted circulation fan in the spray chamber.
    delete_group(a,'heating_elements');delete_group(a,'internal_fan')
    # Paired exposed return tubes and support clips are drawn on both chamber sides.
    for x in [-.692,.692]:
        for y in [-.49,.49]:
            a.pipe('chamber_return_tube',[(x,y-.065,1.39),(x,y-.065,2.91),(x,y+.065,2.91),(x,y+.065,1.39)],.014,'stainless','chamber_tubes',.06)
            for z in [1.52,2.08,2.63]:
                a.box('tube_support_clip',(x,y,z),(.065,.19,.023),'metal','chamber_tubes',.003)
                for yy in [y-.075,y+.075]:hardware(a,(x,yy,z+.018),'Z',.006,'chamber_tubes')
    a.ring('washer_roof_shaft_flange',(-.20,.49,3.392),.20,.08,.020,'metal','Z','roof_equipment',32)
    for i in range(8):
        angle=i*math.pi/4;hardware(a,(-.20+.17*math.cos(angle),.49+.17*math.sin(angle),3.409),'Z',.008,'roof_equipment')
    # Dedicated filter tank and strainer follow the detail on the supplied sheet.
    a.box('rear_filter_tank',(-.88,1.314,1.77),(.836,.733,.700),'enamel','filter_tank')
    a.box('filter_top_lid',(-.88,1.314,2.132),(.87,.76,.024),'edge','filter_tank')
    for x in [-1.16,-.60]:
        for y in [1.05,1.58]:hardware(a,(x,y,2.15),'Z',.009,'filter_tank')
    for x in [-1.08,-.68]:a.pipe('filter_lid_handle',[(x,1.28,2.15),(x,1.28,2.22),(x+.10,1.28,2.22),(x+.10,1.28,2.15)],.009,'metal','filter_tank',.02)
    for x in [-1.16,-.60]:
        a.pipe('filter_connection',[(x,1.60,1.92),(x,1.70,1.92),(x,1.70,1.40)],.022,'green','filter_connections',.06)
        a.flange((x,1.70,1.65),.05)
    for x in [-.44,.44]:
        a.pipe('internal_spray_header',[(x,-.60,1.43),(x,-.60,2.95),(x,.63,2.95)],.018,'stainless','spray_headers',.06)
        for z in [1.6,1.9,2.2,2.5,2.8]:a.cyl('spray_nozzle',(x-math.copysign(.018,x),-.60,z),.010,.035,'brass','X','spray_headers',12)
    grooved_pulley(a,(-.710,.49,2.96),.23)
    grooved_pulley(a,(-.710,.04,3.50),.13)
    open_belt(a,(-.710,.49,2.96),(-.710,.04,3.50),.23,.13)
    a.motor((-.40,.04,3.50),'X',.09,.40,'belt_motor')
    for y in [-.025,.105]:a.box('belt_motor_foot',(-.40,y,3.391),(.35,.035,.045),'metal','belt_motor')
    a.cyl('pulley_motor_shaft',(-.66,.04,3.50),.023,.18,'stainless','X','belt_motor')
    a.cyl('driven_side_shaft',(-.42,.49,2.96),.025,.62,'stainless','X','belt_drive')
    delete_group(a,'temporary')
    for x in [-.98,.98]:
        valve(a,(x,1.32,1.18),.026)
        gauge(a,(x,1.23,1.60))
        a.flange((x,1.32,2.36),.07)
        for y in [-.66,.1,.65]:
            a.cyl('heater_flange',(x,y,1.32),.065,.024,'metal','Z','heater_flanges',24)
            for angle in range(6):
                t=angle*math.pi/3;hardware(a,(x+.05*math.cos(t),y+.05*math.sin(t),1.338),'Z',.006,'heater_flanges')
    hatch(a,(.0,.983,2.30),.94,1.35,'rear_inspection',facing=1)
    for x in [-.6,.6]:a.ring('chamber_lifting_lug',(x,.65,3.42),.048,.025,.026,'metal','Y','lifting_eyes')

def detailed_water(a):
    base.water_tank(a)
    a.group('hoist_drive').location.y=-1.01
    a.cyl('hoist_cross_shaft',(-.32,-.92,2.78),.025,1.62,'stainless','X','hoist_transmission')
    for x in [-1.02,.38]:
        a.box('hoist_shaft_pedestal',(x,-.92,2.78),(.10,.14,.13),'teal','hoist_transmission')
        for z in [2.73,2.83]:hardware(a,(x,-.998,z),'Y',.010,'hoist_transmission')
    a.box('hoist_right_angle_reducer',(-.99,-.79,2.99),(.17,.25,.28),'teal','hoist_transmission')
    a.cyl('hoist_shaft_coupling',(-.98,-.92,2.78),.057,.12,'metal','X','hoist_transmission')
    door_details(a,-.827,1.633,.60,.65,2.99,offset=-.32)
    for i in range(3):
        angle=i*2*math.pi/3
        o=a.box('agitator_impeller_blade',(.75+.13*math.cos(angle),.13*math.sin(angle),.72),(.22,.052,.018),'stainless','agitator',.004);o.rotation_euler.z=angle+.30
    for i in range(10):
        t=i*2*math.pi/10;hardware(a,(.75+.23*math.cos(t),.23*math.sin(t),1.65),'Z',.010,'agitator_flange')
    for y in [-.35,.35]:
        a.cyl('basket_guide_shaft',(-.32,y,1.67),.024,2.20,'stainless','Z','basket_guides')
        for z in [.58,1.633]:
            a.ring('basket_guide_bush',(-.32,y,z),.038,.025,.10,'metal','Z','basket_guides',24)
    a.pipe('mixing_return_pipe',[(.75,.55,.37),(.96,.55,.37),(.96,.55,1.56),(.38,.55,1.56)],.027,'green','coolant_pipes',.08)
    valve(a,(.96,.55,1.03),.024)
    gauge(a,(.96,.43,1.36))
    for p in [(.96,.55,.62),(.96,.55,1.40)]:a.flange(p,.064)
    hatch(a,(-.32,.845,.78),1.18,1.04,'rear_tank_hatch',facing=1)
    maker_plate(a,(-.32,-.925,2.86),.80,.13)
    for y in [-.61,.61]:
        for x in [-.96,.31]:a.ring('water_chamber_lifting_lug',(x,y,3.055),.044,.023,.025,'metal','Y','lifting_eyes')
    for z in [1.0,1.5,2.0,2.5]:
        for x in [-.99,.35]:hardware(a,(x,-.85,z),'Y',.010,'frame_fixings')

CONTRACT={
 'transfer_cart':{'central_return_chain_plate':1,'chain_rivet':30,'toothed_sprocket':3,'full_width_drive_axle':2,'hex_nut':24,'walkway_cross_brace':6,'pressed_louver':5,'central_push_guide':1,'limit_switch':1},
 'lifting_staging_table':{'load_roller':10,'roller_axle_spacer':10,'hydraulic_cylinder_barrel':1,'hard_chrome_piston':1,'cylinder_mount_eye':2,'scissor_travel_roller':4,'hydraulic_hose_union':2,'hex_nut':6},
 'fixed_staging_table':{'load_roller':12,'levelling_thread':4,'hex_nut':8,'roller_axle_spacer':12,'fork_stop_bracket':1},
 'air_cooling_table':{'load_roller':12,'fan_safety_grille':8,'fan_grille_spoke':16,'hood_clip_pin':6,'chain_rivet':15,'hex_nut':12},
 'water_cooling_tank':{'agitator_impeller_blade':3,'basket_guide_shaft':2,'basket_guide_bush':4,'service_hatch':1,'hex_nut':20,'gauge_dial':1},
 'tempering_furnace':{'process_instrument':3,'internal_load_roller':7,'internal_heater_element':6,'circulation_impeller_blade':8,'heater_porcelain_terminal':12,'chain_rivet':15,'door_safety_switch':1},
 'washing_machine':{'process_instrument':3,'chamber_return_tube':4,'tube_support_clip':12,'rear_filter_tank':1,'filter_lid_handle':2,'spray_nozzle':10,'grooved_pulley':2,'tangent_drive_belt':2,'heater_flange':6,'hex_nut':40,'internal_load_roller':7,'wash_lower_shell':1,'wash_lower_top_rail':2,'wash_lower_collector_front':1,'wash_lower_drain_spout':1},
}
BUILDERS={'transfer_cart':detailed_cart,'lifting_staging_table':lambda a:detailed_table(a,True),'fixed_staging_table':lambda a:detailed_table(a,False),
 'air_cooling_table':detailed_air,'water_cooling_tank':detailed_water,'tempering_furnace':detailed_temper,'washing_machine':detailed_wash}

def check_mechanisms(a,key):
    """Check actual geometry against the count/axis/dimensions read from CAD."""
    bpy.context.view_layer.update()
    def objects(name):
        return [o for o in a.root.children_recursive if o.name==a.id+'_'+name or o.name.startswith(a.id+'_'+name+'.')]
    def axis_y(obj):
        axis=(obj.matrix_world.to_3x3()@Vector((0,0,1))).normalized()
        assert abs(axis.y)>.999,(key,obj.name,tuple(axis))
    checked=[]
    if key in ['lifting_staging_table','fixed_staging_table','air_cooling_table']:
        count,length=(10,.136) if key=='lifting_staging_table' else (12,.167) if key=='fixed_staging_table' else (12,.136)
        rollers=objects('load_roller');assert len(rollers)==count,(key,'roller count',len(rollers),count)
        for obj in rollers:
            axis_y(obj)
            sizes=sorted(obj.dimensions)
            assert abs(sizes[0]-.060)<.0001 and abs(sizes[2]-length)<.0001,(key,'roller dimensions',tuple(obj.dimensions))
        if key!='air_cooling_table':
            for obj in objects('roller_axle'):assert abs(min(obj.dimensions)-.020)<.0001
        checked.append('paired roller count, diameter, length and shaft direction')
    if key=='air_cooling_table':
        guides=objects('door_guide');assert len(guides)==2
        assert all(o.matrix_world.translation.x<-.8 for o in guides)
        assert abs(guides[0].matrix_world.translation.y-guides[1].matrix_world.translation.y)>.7
        checked.append('door and gantry on narrow X-negative end')
    if key=='transfer_cart':
        wheels=objects('flanged_travel_wheel');axles=objects('full_width_drive_axle')
        assert len(wheels)==4 and len(axles)==2
        for obj in wheels+axles:axis_y(obj)
        assert abs(abs(axles[0].location.x-axles[1].location.x)-1.425)<.0001
        assert abs(max(o.location.x for o in wheels)-min(o.location.x for o in wheels)-1.425)<.0001
        assert abs(max(o.location.y for o in wheels)-min(o.location.y for o in wheels)-1.050)<.0001
        checked.append('four travel wheels, two transverse axles, 1425 mm wheelbase and 1050 mm track')
    if key=='water_cooling_tank':
        assert abs(a.group('basket').rotation_euler.z-math.pi/2)<.0001
        checked.append('1100 mm basket depth aligned with tank depth')
    if key=='washing_machine':
        assert 'blowers' not in a.groups and 'heating_elements' not in a.groups and 'internal_fan' not in a.groups
        checked.append('MAX 4107 revision without lower-revision blowers/furnace internals')
        lower=objects('wash_lower_shell');assert len(lower)==1
        shell=lower[0]
        assert shell.parent==a.group('central_lower_body')
        assert abs(shell.dimensions.x-2.600)<.0001
        assert abs(min(v.co.z for v in shell.data.vertices)-.100)<.0001
        assert abs(max(v.co.z for v in shell.data.vertices)-1.280)<.0001
        assert len(shell.data.polygons)==5,'Only four perimeter walls and the tank bottom are allowed'
        evaluated=shell.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh()
        bm=bmesh.new();bm.from_mesh(mesh)
        assert bm.edges and all(edge.is_manifold for edge in bm.edges)
        bm.free();evaluated.to_mesh_clear()
        assert not objects('wash_side_tank'),'Former left/right tanks must not leave internal dividing walls'
        assert len(objects('wash_lower_side_cover'))==2
        assert len(objects('wash_lower_end_cover'))==2
        assert all(o.parent==a.group('central_lower_body') for o in objects('wash_lower_side_cover')+objects('wash_lower_end_cover'))
        checked.append('one continuous lower bath without internal dividing walls; four solid top covers leave only the central chamber opening')
    a.root['cad_geometry_checks']=json.dumps(checked)
    return checked

def main():
    if not bpy.app.background:raise RuntimeError('Isolated Blender background process required')
    only=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    audits=[]
    for key,label,filename,dimensions,notes,_ in base.JOBS:
        if only and key not in only:continue
        bpy.ops.wm.read_factory_settings(use_empty=True);base.palette()
        a=base.Asset(key,label,filename,dimensions,notes);BUILDERS[key](a)
        counts={name:sum(o.name==a.id+'_'+name or o.name.startswith(a.id+'_'+name+'.') for o in a.root.children_recursive) for name in CONTRACT[key]}
        for name,minimum in CONTRACT[key].items():assert counts[name]>=minimum,(key,name,counts[name],minimum)
        a.root['cad_detail_contract']=json.dumps(counts)
        checks=check_mechanisms(a,key)
        result=base.export(a);result['detail_features']=counts;result['mechanism_checks']=checks
        (base.OUT/'metadata'/(key+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');audits.append(result)
    models=[json.loads(p.read_text(encoding='utf8')) for p in (base.OUT/'metadata').glob('*.json')]
    (base.OUT/'manifest.json').write_text(json.dumps({'version':1,'detail_pass':True,'models':models},ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
