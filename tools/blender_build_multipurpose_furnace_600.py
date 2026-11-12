"""08.20.00 / 600 ordinary multipurpose furnace, reconstructed from supplied DWG.

Isolated background process only. Prior seven assets and runtime project untouched.
"""
from pathlib import Path
import sys,math,json,hashlib
import bpy,bmesh
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
import blender_build_general_cad_20261103 as common
import blender_detail_general_cad_20261103 as detail

ROOT=Path(__file__).resolve().parents[1]
CAD=ROOT/'output/cad-multipurpose-600-20261103'
OUT=ROOT/'backend/assets/models/cad_multipurpose_furnace_600_20261103_v1'
KEY='multipurpose_furnace_600'
DIMENSIONS={'overall_length':6080,'overall_height':4663,'cold_tank_width':2770,'cold_base_inner_width':2640,
            'cold_tank_depth':1950,'hot_body_width':2372,'hot_body_depth':2570,'door_width':600,'door_height':650,
            'work_level_above_floor':1230,'floor_above_bottom':400,'working_level_from_bottom':1630,
            'charge_length':1100,'charge_station_gap':930,'rear_base_height':160}

def hw(a,p,axis='Z',r=.009,group='fasteners'):detail.hardware(a,p,axis,r,group)

def sector_shell(a,name,width,rise,top,thickness,y0,y1,group,mat='enamel',segments=32):
    # Closed thin curved vault. All eight strips have finite wall thickness.
    vertices=[]
    for y in [y0,y1]:
        for inner in [False,True]:
            for i in range(segments+1):
                x=-width/2+width*i/segments;z=top-rise*(2*x/width)**2-(thickness if inner else 0)
                vertices.append((x,y,z))
    n=segments+1;faces=[]
    for i in range(segments):
        faces += [(i,i+1,2*n+i+1,2*n+i),(n+i+1,n+i,3*n+i,3*n+i+1),
                  (i+1,i,n+i,n+i+1),(2*n+i,2*n+i+1,3*n+i+1,3*n+i)]
    faces += [(0,2*n,3*n,n),(n-1,2*n-1,4*n-1,3*n-1)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);a.scene.collection.objects.link(obj);a.finish(obj,name,mat,group)
    return obj

def crossframe(a,x0,x1,y,z0,z1,group='frame',mat='edge'):
    for x in [x0,x1]:a.box('frame_post',(x,y,(z0+z1)/2),(.065,.075,z1-z0),mat,group)
    for z in [z0,z1]:a.box('frame_crossbar',((x0+x1)/2,y,z),(x1-x0,.075,.065),mat,group)
    for x in [x0,x1]:
        for z in [z0+.06,z1-.06]:hw(a,(x,y-.043,z),'Y',.010,group)

def side_hatch(a,x,y,z,width,height,group):
    side=-1 if x<0 else 1
    a.box('side_hatch_gasket',(x,y,z),(.020,width+.018,height+.018),'gasket',group)
    a.box('side_hatch',(x+side*.015,y,z),(.024,width,height),'enamel',group)
    for yy in [y-width*.43,y+width*.43]:
        for zz in [z-height*.43,z+height*.43]:hw(a,(x+side*.035,yy,zz),'X',.007,group)
    for zz in [z-height*.30,z+height*.30]:a.cyl('side_hatch_hinge',(x+side*.03,y-width/2-.012,zz),.013,.06,'metal','Z',group,16)
    a.pipe('side_hatch_handle',[(x+side*.035,y+width*.28,z-.04),(x+side*.09,y+width*.28,z-.04),(x+side*.09,y+width*.28,z+.04),(x+side*.035,y+width*.28,z+.04)],.009,'metal',group,.02)

def tanks_and_base(a):
    a.box('cold_tank_base',(0,.975,.030),(2.770,1.950,.060),'steel','cold_base')
    a.box('cold_tank_inner_skid',(0,.975,.112),(2.640,1.950,.164),'edge','cold_base')
    a.box('quench_bath_bottom',(0,.975,.190),(2.64,1.82,.100),'enamel','quench_tank')
    for x in [-1.35,1.35]:a.box('outer_tank_side',(x,.975,.84),(.070,1.95,1.38),'enamel','quench_tank')
    for y in [.035,1.915]:a.box('tank_end_wall',(0,y,.84),(2.70,.070,1.38),'enamel','quench_tank')
    # User confirmed 2026-11-11: the lower vessel is one open connected oil bath.
    for x in [-1.005,1.005]:
        a.box('agitator_tank_lid',(x,.975,1.550),(.745,1.950,.045),'enamel','tank_lids')
        for y in [.10,1.85]:
            for xx in [x-.30,x+.30]:hw(a,(xx,y,1.582),'Z',.008,'tank_lids')
        a.box('side_lid_rim',(x,.975,1.516),(.77,1.96,.04),'edge','tank_lids')
    a.box('oil_surface',(0,.975,1.31),(2.60,1.78,.008),'water','quench_liquid')
    for x in [-1.005,1.005]:
        detail.hatch(a,(x,-.018,.81),.54,1.08,'cold_front_hatches')
        detail.hatch(a,(x,1.962,.81),.54,1.08,'cold_rear_hatches',facing=1)
    for x in [-1.33,-.66,.66,1.33]:
        for y in [.1,1.85]:a.box('cold_base_gusset',(x,y,.22),(.035,.12,.20),'edge','cold_base')

def agitation_and_services(a):
    for x in [-1.005,1.005]:
        a.ring('agitator_manhole',(x,1.03,1.590),.292,.215,.030,'metal','Z','agitator_lids',48)
        a.cyl('agitator_lid_disc',(x,1.03,1.605),.215,.018,'enamel','Z','agitator_lids',40)
        for i in range(12):
            t=i*math.pi/6;hw(a,(x+.257*math.cos(t),1.03+.257*math.sin(t),1.628),'Z',.008,'agitator_lids')
        # Motor, four-foot bridge, bearing pedestal, long shaft, and submerged impeller.
        for xx in [x-.14,x+.14]:a.box('agitator_bridge_leg',(xx,1.03,1.765),(.045,.30,.30),'edge','agitators')
        a.box('agitator_bridge',(x,1.03,1.92),(.40,.38,.045),'steel','agitators')
        a.cyl('agitator_coupling',(x,1.03,2.00),.070,.13,'metal','Z','agitators',32)
        a.motor((x,1.03,2.24),'Z',.125,.38,'agitators')
        a.box('agitator_motor_junction',(x+.115,1.03,2.24),(.12,.14,.14),'teal','agitators')
        a.cyl('agitator_long_shaft',(x,1.03,1.1525),.023,1.705,'stainless','Z','agitators',24)
        for z in [.40,1.54]:a.ring('agitator_guide_bush',(x,1.03,z),.043,.024,.09,'metal','Z','agitators',24)
        for i in range(3):
            t=i*2*math.pi/3;o=a.box('agitator_impeller',(x+.13*math.cos(t),1.03+.13*math.sin(t),.40),(.23,.05,.018),'stainless','agitator_impellers',.004);o.rotation_euler.z=t+.24
        a.pipe('tank_drain',[(x,.19,.28),(x,-.20,.28),(x,-.20,.48)],.026,'green','oil_pipes',.07)
        detail.valve(a,(x,-.20,.43),.025,group='oil_valves')
        a.pipe('agitator_return_pipe',[(x,1.58,.4),(x+math.copysign(.23,x),1.58,.4),(x+math.copysign(.23,x),1.58,1.55),(x,1.58,1.55)],.023,'green','oil_pipes',.065)
        a.flange((x+math.copysign(.23,x),1.58,.66),.06,group='oil_pipes')
        detail.gauge(a,(x+math.copysign(.23,x),1.48,1.25),.035,'oil_instruments')
    # The plan shows one bank of six heater/inspection plugs, not two copied banks.
    for x in [.865,1.10]:
        for y in [.18,.41,.64]:
            a.cyl('oil_heater_boss',(x,y,1.61),.045,.075,'metal','Z','oil_heater_ports',24)
            a.cyl('oil_heater_cap',(x,y,1.653),.040,.016,'metal','Z','oil_heater_ports',6)
    for x in [-1.27,1.27]:
        a.cyl('tank_level_boss',(x,.21,1.605),.026,.045,'brass','Z','tank_instruments',20)

def cold_chamber_and_elevator(a):
    common.chamber(a,1.280,1.685,1.527,3.140,0,(.600,.650,1.630),'cold_housing')
    common.lift_door(a,0,1.630,.600,.650,3.130)
    detail.door_details(a,0,1.630,.600,.650,3.130)
    # The work basket is one moving assembly. Dashed lower position is not a second basket.
    a.roller_deck(1.100,.600,1.630,6,'elevator_basket',radius=.038,roller_length=.136)
    a.group('elevator_basket').rotation_euler.z=math.pi/2;a.group('elevator_basket').location.y=.985
    for x in [-.48,.48]:
        for y in [.31,1.60]:
            a.cyl('elevator_guide_shaft',(x,y,1.49),.022,2.65,'stainless','Z','basket_guides')
            for z in [.44,1.63]:a.ring('elevator_guide_bush',(x,y,z),.039,.023,.09,'metal','Z','basket_guides',24)
    for y in [.435,1.535]:
        a.beam('basket_suspension',(-.27,y,1.60),(0,.985,2.47),.025,mat='metal',group='basket_hoist')
        a.beam('basket_suspension',(.27,y,1.60),(0,.985,2.47),.025,mat='metal',group='basket_hoist')
    a.cyl('basket_lift_rod',(0,.985,1.35),.025,2.30,'stainless','Z','basket_hoist')
    a.cyl('basket_lift_cylinder',(0,.985,2.70),.075,.53,'teal','Z','basket_hoist')
    a.box('basket_cylinder_head',(0,.985,3.00),(.22,.24,.08),'metal','basket_hoist')
    for x in [-.075,.075]:
        for y in [.90,1.07]:hw(a,(x,y,3.052),'Z',.010,'basket_hoist')
    # Cross shaft and reducer: transverse across the front, not along the load path.
    a.cyl('front_hoist_cross_shaft',(0,-.13,2.93),.027,2.05,'stainless','X','front_transmission')
    for x in [-.70,.70]:
        a.box('cross_shaft_bearing',(x,-.13,2.93),(.13,.14,.14),'teal','front_transmission')
        for z in [2.89,2.97]:hw(a,(x,-.21,z),'Y',.009,'front_transmission')
    a.box('front_hoist_reducer',(-.88,-.08,2.94),(.21,.24,.23),'teal','front_transmission')
    a.motor((-.96,.08,2.94),'Y',.10,.28,'front_transmission')
    detail.grooved_pulley(a,(-.74,-.03,3.60),.20,.045)
    a.cyl('upper_balance_shaft',(-.74,-.03,3.60),.021,.18,'stainless','X','counterbalance')
    for x in [-.94,.94]:
        a.box('canopy_front_support',(x,-.01,3.34),(.045,.055,1.12),'steel','canopy_frame')
    a.box('canopy_front_header',(0,-.01,3.86),(1.94,.055,.055),'steel','canopy_frame')
    for x in [-.69,.69]:
        detail.chain(a,[(x,-.15,2.28),(x,-.15,3.02)],.065,.020,'front_lift_chains')
    # Front side feed-return assembly, seen clearly in the longitudinal section.
    plate=a.box('side_return_chain_plate',(-.718,.35,2.17),(.025,.66,1.30),'steel','side_feed_return')
    for x in [-.741,-.760]:
        a.pipe('side_chain_guide',detail.oval_route(x,.35,1.78,2.58,.245,plane='YZ'),.009,'metal','side_feed_return',.008)
    detail.chain(a,detail.oval_route(-.780,.35,1.78,2.58,.215,plane='YZ'),.065,.022,'side_feed_return',pin_axis='X')
    detail.grooved_pulley(a,(-.795,.35,2.16),.22,.045)
    a.motor((-.90,.43,2.81),'Z',.085,.28,'side_feed_motor')
    a.box('side_feed_reducer',(-.82,.43,2.58),(.18,.22,.17),'teal','side_feed_motor')
    for z in [1.60,2.10,2.72]:
        for y in [.055,.645]:hw(a,(-.755,y,z),'X',.008,'side_feed_return')
    # Safety switches and a counterweight lever are distinct objects.
    a.box('front_door_limit_switch',(.55,-.18,2.37),(.055,.060,.09),'teal','safety_interlocks')
    a.beam('counterbalance_lever',(.72,-.12,3.04),(1.17,-.12,2.63),.035,mat='metal',group='counterbalance')
    a.cyl('counterweight',(1.15,-.12,2.66),.070,.20,'steel','Y','counterbalance')
    detail.maker_plate(a,(0,-.142,3.055),.55,.09)

def intermediate_gate(a):
    # Firebrick partition is visible at the 930 mm gap between charge stations.
    for x in [-.91,.91]:a.box('partition_cheek',(x,1.84,2.02),(.53,.30,2.02),'edge','partition_shell')
    a.box('partition_sill',(0,1.84,1.27),(1.30,.30,.49),'edge','partition_shell')
    a.box('partition_lintel',(0,1.84,2.78),(1.30,.30,.68),'edge','partition_shell')
    for x in [-.40,.40]:a.box('refractory_gate_jamb',(x,1.84,1.98),(.20,.33,.75),'black','partition_lining')
    a.panel('intermediate_gate',(0,1.66,1.955),.70,.75,'black','intermediate_gate')
    for x in [-.44,.44]:a.box('intermediate_gate_guide',(x,1.64,2.57),(.045,.065,1.95),'metal','intermediate_gate_guides')
    for x in [-.20,.20]:a.box('intermediate_hoist_post',(x,1.84,3.44),(.055,.070,1.20),'steel','gate_gantry')
    a.box('intermediate_gantry_head',(0,1.84,4.03),(.49,.18,.075),'steel','gate_gantry')
    a.cyl('intermediate_hoist_cylinder',(0,1.84,3.40),.085,.78,'teal','Z','gate_gantry')
    a.cyl('intermediate_chrome_rod',(0,1.84,2.83),.030,.52,'stainless','Z','gate_gantry')
    for z in [3.02,3.79]:
        a.box('cylinder_end_cap',(0,1.84,z),(.20,.22,.055),'metal','gate_gantry')
        for x in [-.074,.074]:
            for y in [1.765,1.915]:hw(a,(x,y,z+.035),'Z',.008,'gate_gantry')
    detail.chain(a,[(0,1.72,2.34),(0,1.72,3.99)],.070,.024,'gate_lift_chain')
    a.cyl('gate_chain_pulley',(0,1.72,3.95),.065,.044,'metal','Y','gate_lift_chain')
    a.pipe('gate_hydraulic_hose',[(.08,1.84,3.57),(.31,1.84,3.57),(.31,1.84,2.90),(.54,1.84,2.90)],.013,'gasket','gate_hydraulics',.065)

def hot_body(a):
    start,end=1.685,4.255;mid=(start+end)/2;width=2.372
    # Rear chamber stands 400 mm above the bottom of the below-floor quench tank.
    for x in [-.88,.88]:
        a.box('hot_foundation_skid',(x,mid,.480),(.29,2.15,.160),'steel','hot_base')
        for y in [2.17,3.93]:
            a.box('hot_support_leg',(x,y,.78),(.13,.14,.48),'edge','hot_base')
            for dx in [-.07,.07]:hw(a,(x+dx,y,.565),'Z',.014,'hot_base')
    for y in [1.84,4.11]:a.box('hot_base_end_tie',(0,y,.96),(width,.14,.16),'steel','hot_base')
    for x in [-1.17,1.17]:a.box('hot_side_rail',(x,mid,1.04),(.12,end-start,.16),'steel','hot_frame')
    for x in [-1.126,1.126]:a.box('hot_outer_wall',(x,mid,1.93),(.12,end-start,1.87),'enamel','hot_housing')
    a.box('hot_bottom_casing',(0,mid,1.05),(width,end-start,.12),'enamel','hot_housing')
    sector_shell(a,'arched_outer_roof',width,.23,3.170,.045,start,end,'hot_housing')
    for x in [-1.206,1.206]:
        for y in [1.82,2.50,3.22,4.12]:a.box('hot_external_stiffener',(x,y,1.97),(.045,.055,1.92),'edge','hot_frame')
        for y in [2.25,3.14,3.91]:side_hatch(a,x,y,1.98,.60,1.33,'hot_access_panels')
    # Back end has a real 600x650 opening closed by a bolted service door.
    for x in [-.83,.83]:a.box('rear_end_jamb',(x,4.22,1.94),(.69,.07,1.83),'enamel','hot_housing')
    a.box('rear_end_sill',(0,4.22,1.31),(.97,.07,.58),'enamel','hot_housing')
    a.box('rear_end_lintel',(0,4.22,2.68),(.97,.07,.73),'enamel','hot_housing')
    detail.hatch(a,(0,4.275,1.98),.72,.80,'hot_rear_hatch',facing=1)
    # Vault and brick joints are separate meshes, not a texture or black billboard.
    for x in [-.69,.69]:a.box('inner_refractory_wall',(x,3.00,2.07),(.22,1.95,1.18),'black','refractory')
    a.box('refractory_hearth',(0,3.00,1.53),(1.48,1.95,.16),'edge','refractory')
    sector_shell(a,'inner_brick_vault',1.48,.22,2.87,.13,2.00,4.02,'refractory','edge',24)
    for y in [2.04,3.95]:
        for i in range(13):
            x=-.72+i*.12;z=2.87-.22*(2*x/1.48)**2
            brick=a.box('vault_keystone',(x,y,z),(.112,.11,.12),'enamel','vault_bricks',.002)
            brick.rotation_euler.y=math.atan(8*.22*x/1.48**2)
    # Roller hearth is aligned along the longitudinal load path.
    for i in range(7):
        y=2.30+i*.25
        a.cyl('hot_hearth_roller',(0,y,1.591),.039,.75,'stainless','X','hot_rollers',24)
        for x in [-.43,.43]:a.box('hot_roller_bearing',(x,y,1.59),(.08,.09,.075),'metal','hot_rollers')
    # Side radiant tubes and ceramic entries visible in section.
    for x in [-.59,.59]:
        for z in [1.85,2.19,2.52]:
            a.pipe('radiant_u_tube',[(x,4.27,z),(x,2.27,z),(x,2.27,z+.13),(x,4.27,z+.13)],.024,'black','radiant_tubes',.065)
            for zz in [z,z+.13]:a.cyl('radiant_tube_collar',(x,4.265,zz),.048,.07,'enamel','Y','radiant_tubes',20)

def roof_fan_and_ports(a):
    cy=3.015
    a.ring('circulation_roof_flange',(0,cy,3.19),.31,.16,.045,'metal','Z','roof_fan',48)
    for i in range(12):
        t=i*math.pi/6;hw(a,(.27*math.cos(t),cy+.27*math.sin(t),3.224),'Z',.010,'roof_fan')
    for x in [-.24,.24]:a.box('fan_bridge_post',(x,cy,3.36),(.055,.39,.34),'edge','roof_fan')
    a.box('fan_bridge_top',(0,cy,3.53),(.60,.52,.07),'enamel','roof_fan')
    a.motor((0,cy,3.71),'Z',.14,.31,'roof_fan')
    a.cyl('fan_spindle',(0,cy,3.11),.030,1.03,'stainless','Z','circulation_impeller')
    a.cyl('fan_impeller_hub',(0,cy,2.56),.09,.11,'metal','Z','circulation_impeller')
    for i in range(8):
        t=i*math.pi/4;o=a.box('circulation_blade',(.16*math.cos(t),cy+.16*math.sin(t),2.565),(.24,.062,.022),'metal','circulation_impeller',.004);o.rotation_euler.z=t+.35
    a.ring('internal_fan_shroud',(0,cy,2.61),.29,.26,.19,'metal','Z','circulation_impeller',40)
    for x in [-.86,.86]:
        a.pipe('thermocouple_probe',[(x,3.80,2.87),(x,3.80,3.37),(x,3.93,3.37)],.011,'metal','thermocouples',.045)
        a.cyl('thermocouple_head',(x,3.93,3.37),.034,.055,'teal','Y','thermocouples',20)
    # Rear transfer rod, guides, limit dogs and valve terminals; end datum gives 6080 overall.
    a.cyl('rear_transfer_pushrod',(0,4.40,1.670),.022,.944,'stainless','Y','rear_transfer')
    for y in [4.24,4.49,4.72]:
        a.box('pushrod_guide',(0,y,1.67),(.095,.08,.08),'metal','rear_transfer')
        for x in [-.035,.035]:hw(a,(x,y,1.72),'Z',.007,'rear_transfer')
    a.box('pushrod_end_stop',(0,4.852,1.67),(.11,.040,.09),'steel','rear_transfer')
    for x,z in [(-.47,2.43),(.47,1.62)]:
        a.pipe('rear_service_line',[(x,3.80,z),(x,4.54,z),(x,4.54,z-.11)],.017,'green','rear_process_pipes',.055)
        a.flange((x,4.35,z),.045,'Y','rear_process_pipes')
        detail.valve(a,(x,4.50,z-.07),.018,group='rear_process_valves')
    for y in [2.19,3.83]:
        for x in [-1.04,1.04]:a.ring('hot_lifting_eye',(x,y,3.05),.048,.026,.03,'metal','Y','lifting_eyes',24)

def exhaust_hood(a):
    common.side_canopy(a,'front_sloping_extraction_hood',1.90,[(-1.208,2.60),(-1.208,2.90),(-.41,4.15),(.60,4.15),(.60,2.60)],'extraction')
    # A vertical open neck and a return elbow, not a solid capped chimney.
    a.ring('main_open_flue',(0,-.15,4.445),.145,.122,.436,'metal','Z','extraction',48)
    a.pipe('exhaust_return_elbow',[(0,-.15,4.46),(0,.29,4.46),(0,.29,4.06)],.112,'metal','exhaust_duct',.135)
    a.flange((0,.29,4.12),.15,'Z','exhaust_duct')
    for x in [-.55,.55]:a.ring('hood_lifting_eye',(x,.25,4.18),.04,.021,.025,'metal','Y','hood_fittings',24)
    a.box('hood_inspection_flap',(-.957,-.45,3.12),(.018,.30,.23),'edge','hood_fittings')
    for y in [-.57,-.33]:hw(a,(-.975,y,3.12),'X',.008,'hood_fittings')

def upper_guards_and_ladder(a):
    # Upper service panels and ladder shown on the rear elevation.
    for x in [-1.25,1.25]:
        for y in [2.10,3.13,4.16]:a.box('upper_guard_post',(x,y,3.70),(.035,.035,1.12),'steel','upper_guards')
        for z in [3.16,3.69,4.24]:a.box('upper_guard_rail',(x,3.13,z),(.035,2.10,.035),'steel','upper_guards')
        for y in [2.61,3.65]:
            a.box('upper_service_panel',(x,y,3.70),(.018,.96,1.03),'edge','upper_service_panels')
            for z in [3.43,3.95]:a.box('service_panel_stiffener',(x+math.copysign(.016,x),y,z),(.02,.96,.025),'metal','upper_service_panels')
    # Rear platform is narrow and outboard of the furnace, with a rung ladder.
    a.box('rear_service_platform',(1.43,3.84,3.16),(.49,.78,.045),'metal','rear_platform')
    for x in [1.23,1.63]:
        a.box('ladder_stile',(x,4.25,1.97),(.035,.045,2.88),'steel','service_ladder')
    for i in range(9):a.cyl('ladder_rung',(1.43,4.25,.73+i*.285),.013,.40,'metal','X','service_ladder',16)
    for y in [3.47,4.21]:
        for x in [1.20,1.66]:a.box('platform_guard_post',(x,y,3.68),(.030,.030,1.02),'safety','platform_guard')
        for z in [3.68,4.19]:a.box('platform_guard_rail',(1.43,y,z),(.49,.030,.030),'safety','platform_guard')

def instrumentation(a):
    for x in [-.60,.60]:
        a.box('safety_position_switch',(x,-.14,1.73),(.05,.07,.09),'teal','safety_interlocks')
    detail.instrument_stack(a,.54,-.16,2.02)
    a.box('main_electric_cabinet',(-1.10,.12,2.33),(.34,.26,.55),'enamel','electrics')
    a.box('cabinet_display',(-1.10,-.017,2.43),(.23,.012,.11),'screen','electrics')
    for x in [-1.20,-1.10,-1.00]:a.cyl('cabinet_operator_button',(x,-.026,2.18),.014,.012,'red' if x< -1.15 else 'green','Y','electrics',16)
    a.pipe('cabinet_conduit',[(-1.05,.22,2.08),(-1.05,.22,1.71),(-.75,.22,1.71)],.013,'gasket','electrics',.045)
    for y in [.15,1.52]:detail.gauge(a,(.78,y,2.85),.037,'process_instruments')
    for y in [.40,1.35]:
        a.pipe('cold_roof_service_tube',[(.50,y,3.14),(.50,y,3.36),(.34,y,3.36)],.012,'metal','cold_roof_pipes',.05)

def close_vault_end_caps(a):
    if any(o.name.startswith(a.id+'_hot_roof_end_cap') for o in a.root.children_recursive):return
    # Close the crescent above the flat service panels; it is not an open vent.
    profile=[(-1.186,2.82),(1.186,2.82)]
    for i in range(33):
        x=1.186-2.372*i/32;profile.append((x,3.170-.23*(2*x/2.372)**2))
    for y in [1.685,4.255]:
        vertices=[(x,yy,z) for yy in [y-.018,y+.018] for x,z in profile];n=len(profile)
        faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
        faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        mesh=bpy.data.meshes.new('vault_end_cap');mesh.from_pydata(vertices,[],faces);mesh.update()
        bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free()
        obj=bpy.data.objects.new('vault_end_cap',mesh);a.scene.collection.objects.link(obj);a.finish(obj,'hot_roof_end_cap','enamel','hot_roof_end_caps')

CONTRACT={'oil_heater_boss':6,'agitator_impeller':6,'agitator_long_shaft':2,'elevator_guide_shaft':4,'hot_hearth_roller':7,
          'radiant_u_tube':6,'vault_keystone':26,'circulation_blade':8,'oil_heater_cap':6,'ladder_rung':9,'process_instrument':3,
          'grooved_pulley':2,'side_return_chain_plate':1,'front_hoist_cross_shaft':1,'main_open_flue':1,'intermediate_hoist_cylinder':1,'hot_roof_end_cap':2}

def update_saved_oil_bath(a):
    """Apply this local correction without rebuilding unrelated CAD assemblies."""
    detail.delete_group(a,'tank_baffles')
    for obj in a.root.children_recursive:
        if obj.type!='MESH':continue
        if obj.name==a.id+'_oil_surface':
            width=max(v.co.x for v in obj.data.vertices)-min(v.co.x for v in obj.data.vertices)
            for vertex in obj.data.vertices:vertex.co.x*=2.60/width
        if obj.name==a.id+'_agitator_long_shaft' or obj.name.startswith(a.id+'_agitator_long_shaft.'):
            low=min(v.co.z for v in obj.data.vertices);high=max(v.co.z for v in obj.data.vertices)
            for vertex in obj.data.vertices:
                world_z=.300+(vertex.co.z-low)/(high-low)*1.705
                vertex.co.z=world_z-obj.location.z
        obj.data.update()
    a.root['continuous_oil_bath']='User confirmed 2026-11-11: one connected lower oil bath, no internal partitions'

def main():
    if not bpy.app.background:raise RuntimeError('Separate background Blender required')
    source=(json.loads((CAD/'sources.json').read_text(encoding='utf-8-sig'))[0] if (CAD/'sources.json').exists()
            else json.loads((OUT/'metadata'/(KEY+'.json')).read_text(encoding='utf8'))['source'])
    if source.get('source_path') and Path(source['source_path']).is_file():
        assert hashlib.sha256(Path(source['source_path']).read_bytes()).hexdigest().upper()==source['sha256']
    OUT.mkdir(parents=True,exist_ok=True)
    for name in ['sources','previews','metadata']:(OUT/name).mkdir(exist_ok=True)
    common.OUT=OUT;common.CAD=CAD;common.SOURCES[KEY]=source
    bpy.ops.wm.read_factory_settings(use_empty=True);common.palette()
    a=common.Asset(KEY,'600普通多用炉','08.20.00_600普通多用炉',DIMENSIONS,
      ['按 600多用炉总图.DWG／08.20.00 建模；单台前室＋淬火槽＋后加热室，不复制虚线表示的第二篮位置。',
       '图示地坪比淬火槽底高 400 mm；1230 mm 工作标高对应模型底部起 1630 mm。',
       '总图未给出零件完整尺寸的部位按三视图比例重建；本 GLB 不替代制造图。',
       '2026-11-11 用户确认下部为整体贯通油池，无中间隔断；两侧搅拌叶轮浸在同一油池内。'])
    if '--resume-source' in sys.argv:
        bpy.ops.wm.open_mainfile(filepath=str(OUT/'sources'/(a.filename+'.blend')))
        common.palette()
        a.scene=bpy.context.scene;a.root=bpy.data.objects[a.id+'_root']
        a.prepared_geometry=True
        a.groups={o['part']:o for o in a.root.children if o.type=='EMPTY' and o.get('part')}
        keep={a.root,*a.root.children_recursive}
        for obj in list(a.scene.objects):
            if obj not in keep:bpy.data.objects.remove(obj,do_unlink=True)
        if '--update-oil-bath' in sys.argv:update_saved_oil_bath(a)
    else:
        for builder in [tanks_and_base,agitation_and_services,cold_chamber_and_elevator,intermediate_gate,hot_body,roof_fan_and_ports,exhaust_hood,upper_guards_and_ladder,instrumentation]:
            builder(a);print('BUILT '+builder.__name__,flush=True)
    close_vault_end_caps(a)
    oil_material=common.MATS['water'];oil_material.diffuse_color=(.26,.10,.028,1)
    oil_material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.26,.10,.028,1)
    bpy.context.view_layer.update()
    counts={name:sum(o.name==a.id+'_'+name or o.name.startswith(a.id+'_'+name+'.') for o in a.root.children_recursive) for name in CONTRACT}
    assert counts==CONTRACT,(counts,CONTRACT)
    a.root['cad_detail_contract']=json.dumps(counts);a.root['installation_floor_z_m']=.400;a.root['drawing_number']='08.20.00'
    # Larger combined furnace, not a small single table: preserve the CAD mechanisms.
    # Limit remains below the repository's 200k delivery ceiling; old assets keep 150k.
    a.triangle_budget=180000;a.root['triangle_budget']=a.triangle_budget
    result=common.export(a);result['detail_features']=counts
    (OUT/'metadata'/(KEY+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    (OUT/'manifest.json').write_text(json.dumps({'version':1,'detail_pass':True,'models':[result]},ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
