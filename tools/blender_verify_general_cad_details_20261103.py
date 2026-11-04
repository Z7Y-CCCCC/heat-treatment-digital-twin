"""Independent source-part measurement and exported-GLB detail inspection.

Run only in a new Blender --background process. Never saves/edits source files.
Evidence is kept outside the model delivery folder.
"""
import bpy,json,sys,hashlib,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'backend/assets/models/cad_general_20261103_v1'
EVIDENCE=ROOT/'output/cad-general-20261103/final-review';EVIDENCE.mkdir(parents=True,exist_ok=True)
manifest=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
results=[]

def review(item):
    key=item['source']['id'];bpy.ops.wm.open_mainfile(filepath=str(OUT/'sources'/(Path(item['file']).stem+'.blend')))
    root=bpy.data.objects[item['model_id']+'_root'];children=list(root.children_recursive)
    def parts(name):return [o for o in children if o.name==item['model_id']+'_'+name or o.name.startswith(item['model_id']+'_'+name+'.')]
    def spread(name,axis):
        values=[o.matrix_world.translation[axis] for o in parts(name)]
        return max(values)-min(values)
    tests=[]
    def measure(label,value,expected,tolerance=.0001):
        tests.append({'check':label,'actual_m':round(value,7),'expected_m':expected,'pass':abs(value-expected)<=tolerance})
    def count(name,expected):tests.append({'check':name+' count','actual':len(parts(name)),'expected':expected,'pass':len(parts(name))==expected})
    bpy.context.view_layer.update()
    if key=='transfer_cart':
        count('flanged_travel_wheel',4);count('central_return_chain_plate',1)
        measure('travel wheelbase',spread('flanged_travel_wheel',0),1.425)
        measure('travel wheel track',spread('flanged_travel_wheel',1),1.050)
        for o in parts('underframe_side'):measure('frame length',o.dimensions.x,1.679)
        measure('roller working level',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('load_roller')),1.250)
    if key in ['lifting_staging_table','fixed_staging_table']:
        lifting=key=='lifting_staging_table';count('load_roller',10 if lifting else 12)
        for o in parts('load_roller'):
            measure('roller diameter',o.dimensions.z,.060)
            measure('roller length',o.dimensions.y,.136 if lifting else .167)
        for o in parts('roller_axle'):measure('axle diameter',o.dimensions.z,.020)
        measure('roller working level',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('load_roller')),1.200 if lifting else 1.250)
        xs=sorted(set(round(o.matrix_world.translation.x,6) for o in parts('load_roller')))
        for first,last in zip(xs,xs[1:]):measure('roller pitch',last-first,.320 if lifting else .280)
        if lifting:
            count('lift_base_web',2);count('lift_base_flange',4)
            for o in parts('lift_base_web'):measure('horizontal channel web thickness',o.dimensions.y,.010)
            for o in parts('lift_base_flange'):measure('horizontal channel flange thickness',o.dimensions.z,.010)
        else:
            count('leg_web',4);count('leg_flange',8)
            for o in parts('leg_web'):
                measure('vertical C100 web thickness',o.dimensions.x,.010);measure('vertical C100 section depth',o.dimensions.y,.050)
            for o in parts('leg_flange'):measure('vertical C100 flange width',o.dimensions.x,.100)
    if key=='air_cooling_table':
        count('load_roller',12);count('fan_shroud',2);count('fan_blade',8);count('hood_clip_pin',6)
        measure('door gantry height',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('gantry_top')),3.052)
        measure('working level',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('load_roller')),1.250)
    if key=='water_cooling_tank':
        count('agitator_impeller_blade',3);count('basket_guide_shaft',2)
        measure('flue height',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('open_flue')),4.320)
        basket=[o for o in parts('load_roller') if 'basket' in o.parent.name]
        measure('basket working level',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in basket),1.633)
    if key=='tempering_furnace':
        count('process_instrument',3);count('heater_porcelain_terminal',12);count('internal_load_roller',7);count('door_safety_switch',1)
        measure('flue height',max(o.matrix_world.translation.z+o.dimensions.z/2 for o in parts('open_flue')),4.024)
        for o in parts('cabinet_side'):measure('cabinet depth',o.dimensions.y,1.930)
    if key=='washing_machine':
        count('process_instrument',3);count('heater_boss',12);count('spray_nozzle',10);count('rear_filter_tank',1);count('chamber_return_tube',4)
        count('grooved_pulley',2);count('tangent_drive_belt',2);count('pulley_motor_shaft',1);count('driven_side_shaft',1)
        for o in parts('continuous_base'):
            measure('base width',o.dimensions.x,2.650);measure('base depth',o.dimensions.y,2.442)
        for o in parts('rear_filter_tank'):
            for axis,expected in enumerate([.836,.733,.700]):measure('filter tank '+str(axis),o.dimensions[axis],expected)
        count('wash_lower_shell',1);count('wash_lower_collector_front',1);count('wash_lower_drain_spout',1)
        for o in parts('wash_lower_shell'):
            measure('central lower enclosure width',o.dimensions.x,1.200)
            measure('central lower enclosure top',max((o.matrix_world@v.co).z for v in o.data.vertices),1.295)
        for o in parts('wash_lower_collector_front'):
            measure('lower attachment width',o.dimensions.x,.836)
            measure('lower attachment top',o.location.z+o.dimensions.z/2,1.038)
    record={'name':item['name'],'file':item['file'],'sha256':hashlib.sha256((OUT/item['file']).read_bytes()).hexdigest(),
            'source_blend_sha256':hashlib.sha256((OUT/'sources'/(Path(item['file']).stem+'.blend')).read_bytes()).hexdigest(),
            'tests':tests,'pass':all(t['pass'] for t in tests),'part_inventory':{name:sum(o.type=='MESH' for o in group.children_recursive) for name,group in [(o.get('part'),o) for o in root.children if o.type=='EMPTY'] if name and name!='review'}}
    results.append(record)
    print('MEASUREMENT '+json.dumps({k:v for k,v in record.items() if k!='part_inventory'},ensure_ascii=False),flush=True)

for item in manifest['models']:review(item)
report={'scope':'measured source geometry; not a claim of complete manufacturing reconstruction','pass':all(r['pass'] for r in results),'models':results}
(EVIDENCE/'measurements.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
if not report['pass']:sys.exit(1)
