// Parametric visual reconstruction from drawing 47.10.00, millimetres -> metres.
// Run with Node 22; uses the project's Three.js exporter, no CAD parser at runtime.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as T from '../frontend/node_modules/three/build/three.module.js';
import {GLTFExporter} from '../frontend/node_modules/three/examples/jsm/exporters/GLTFExporter.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizeModelMetadata}=require('../backend/services/modelAssetMetadata.js');
const {normalizeInspection}=require('../shared/inspectionConfig.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'backend/assets/models');
globalThis.FileReader=class {
 readAsArrayBuffer(blob){blob.arrayBuffer().then(v=>{this.result=v;this.onloadend?.();}).catch(e=>this.onerror?.(e));}
 readAsDataURL(blob){blob.arrayBuffer().then(v=>{this.result=`data:${blob.type};base64,${Buffer.from(v).toString('base64')}`;this.onloadend?.();}).catch(e=>this.onerror?.(e));}
};
const model=new T.Group();model.name='water_cooling_tank_471000';
const material=(name,color,metalness=.5,roughness=.4)=>new T.MeshStandardMaterial({name,color,metalness,roughness});
const steel=material('coated_tank_steel','#477879'),dark=material('drive_cast_iron','#273b43'),silver=material('machined_steel','#bac6c9',.8,.25),yellow=material('safety_yellow','#e8ad35',.3),black=material('rubber_and_recess','#18292e'),loadMat=material('reference_workpiece','#b88050',.6);
const waterMat=new T.MeshStandardMaterial({name:'water',color:'#32b6dc',transparent:true,opacity:.42,metalness:.15,roughness:.16,depthWrite:false,side:T.DoubleSide});
const groups={};
function group(name,p=[0,0,0],parent=model){const g=new T.Group();g.name=name;g.position.fromArray(p);parent.add(g);groups[name]=g;return g;}
function mesh(parent,name,geo,mat,p=[0,0,0]){const m=new T.Mesh(geo,mat);m.name=name;m.position.fromArray(p);parent.add(m);return m;}
function box(g,n,p,s,m=steel){return mesh(g,n,new T.BoxGeometry(...s),m,p);}
function cyl(g,n,p,r,h,m=silver,axis='y',segments=24){const o=mesh(g,n,new T.CylinderGeometry(r,r,h,segments),m,p);if(axis==='x')o.rotation.z=Math.PI/2;if(axis==='z')o.rotation.x=Math.PI/2;return o;}
function beam(g,n,a,b,w=.04,m=silver){const v=new T.Vector3(...a),q=new T.Vector3(...b);const o=box(g,n,v.clone().add(q).multiplyScalar(.5).toArray(),[w,v.distanceTo(q),w],m);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),q.sub(v).normalize());return o;}
function pipe(g,n,points,r=.035,m=silver){return mesh(g,n,new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),32,r,10,false),m);}
const tank=group('tank_shell');
box(tank,'tank_floor',[0,.12,0],[1.654,.12,1.35]);
box(tank,'tank_front',[0,.83,-.663],[1.654,1.36,.024]);box(tank,'tank_back',[0,.83,.663],[1.654,1.36,.024]);
for(const x of [-.815,.815])box(tank,'tank_end',[x,.83,0],[.024,1.36,1.35]);
const frame=group('base_and_stiffeners');
for(const x of [-.78,.78]){box(frame,'skid',[x,.035,0],[.10,.07,1.45],dark);for(const z of [-.64,.64]){box(frame,'anchor_plate',[x,.03,z],[.22,.035,.20],dark);cyl(frame,'anchor_bolt',[x,.075,z],.018,.06,silver);}}
for(const y of [.26,.82,1.42])for(const z of [-.69,.69])box(frame,'tank_stiffener',[0,y,z],[1.68,.065,.045],dark);
for(const x of [-.65,-.22,.22,.65])for(const z of [-.69,.69])box(frame,'vertical_rib',[x,.84,z],[.045,1.28,.04],steel);
const rim=group('work_deck');
for(const z of [-.72,.72])box(rim,'rim_long',[0,1.52,z],[1.8,.09,.14],silver);
for(const x of [-.87,.87])box(rim,'rim_end',[x,1.52,0],[.13,.09,1.35],silver);
const guides=group('lift_guides');
for(const x of [-.69,.69])for(const z of [-.50,.50]){box(guides,'guide_column',[x,1.57,z],[.075,2.886,.07],dark);box(guides,'guide_rail',[x+(x>0?-.055:.055),1.63,z],[.025,2.75,.035],silver);}
for(const z of [-.5,.5])box(guides,'top_crosshead',[0,2.973,z],[1.48,.08,.12],yellow);
const lift=group('lift_carriage',[0,1.633,0]);
for(const z of [-.44,.44])box(lift,'carrier_side',[0,-.055,z],[1.25,.11,.085],dark);
for(let i=0;i<9;i++)box(lift,'support_grating',[-.55+i*.1375,0,0],[.038,.045,.85],silver);
for(const x of [-.61,.61])for(const z of [-.45,.45]){box(lift,'slider',[x,.06,z],[.12,.20,.10],yellow);beam(lift,'lift_arm',[x,0,z],[x,.76,z],.035);}
for(const x of [-.61,.61]){beam(lift,'carrier_cross_brace',[x,0,-.45],[x,.76,.45],.025);beam(lift,'carrier_cross_brace',[x,0,.45],[x,.76,-.45],.025);}
const load=group('reference_load',[0,.345,0],lift);
for(const x of [-.55,.55])for(const z of [-.3,.3])box(load,'load_envelope_post',[x,0,z],[.018,.65,.018],loadMat);
for(const y of [-.325,.325])for(const z of [-.3,.3])box(load,'load_envelope_edge',[0,y,z],[1.1,.018,.018],loadMat);
for(let i=0;i<4;i++)cyl(load,'reference_ring',[-.39+i*.26,-.08,0],.22,.15,loadMat,'x');
const drive=group('lift_drive');
box(drive,'gearbox',[-.92,2.74,0],[.27,.28,.3],dark);
cyl(drive,'hoist_motor',[-1.16,2.74,0],.14,.32,steel,'x');
for(let i=0;i<8;i++)cyl(drive,'motor_cooling_fin',[-1.04-i*.035,2.74,0],.147,.012,dark,'x');
box(drive,'motor_terminal_box',[-1.16,2.91,0],[.13,.08,.14],black);
const shaft=group('hoist_shaft',[0,2.80,0]);cyl(shaft,'drive_shaft',[0,0,0],.034,1.6,silver,'x');
for(const x of [-.61,.61]){cyl(shaft,'chain_sprocket',[x,0,0],.115,.065,dark,'x');for(let i=0;i<8;i++){const a=i*Math.PI/4;box(shaft,'sprocket_tooth',[x,Math.cos(a)*.112,Math.sin(a)*.112],[.07,.032,.035],silver);}}
const chains=group('lift_chains');
for(const x of [-.61,.61])for(const z of [-.075,.075]){const c=group(`chain_${x>0?'r':'l'}_${z>0?'b':'f'}`,[x,2.8,z],chains);for(let i=0;i<24;i++)box(c,'chain_link',[0,-i*.046,0],[.022,.036,.014],dark);}
const sump=group('side_reservoir');
box(sump,'side_sump_floor',[0,.12,1.05],[1.4,.12,.894],steel);
for(const z of [.72,1.485])box(sump,'sump_wall',[0,.81,z],[1.40,1.38,.024],steel);
for(const x of [-.69,.69])box(sump,'sump_end',[x,.81,1.1],[.024,1.38,.77],steel);
box(sump,'service_cover',[0,1.51,1.1],[1.42,.065,.79],silver);
for(const x of [-.58,.58])for(const z of [.8,1.4])cyl(sump,'cover_fastener',[x,1.555,z],.016,.028,dark);
const stir=group('agitator_motor');cyl(stir,'mount_flange',[.05,1.59,1.08],.24,.06,dark);
cyl(stir,'vertical_motor',[.05,1.91,1.08],.145,.48,steel);box(stir,'motor_junction',[.24,1.92,1.08],[.12,.16,.18],black);
for(let i=0;i<10;i++){const a=i*Math.PI/5;box(stir,'stator_fin',[.05+Math.cos(a)*.14,1.91,1.08+Math.sin(a)*.14],[.025,.40,.025],dark);}
const rotor=group('agitator_rotor',[.05,.38,1.08]);cyl(rotor,'agitator_shaft',[0,.61,0],.023,1.22,silver);
for(let i=0;i<4;i++){const a=i*Math.PI/2;const b=box(rotor,'impeller_blade',[Math.cos(a)*.15,0,Math.sin(a)*.15],[.29,.045,.10],silver);b.rotation.y=-a;b.rotation.z=.22;}
const plumbing=group('circulation_piping');
pipe(plumbing,'sump_to_tank',[[.3,.35,1.05],[.3,.35,.35],[.3,.6,.1]],.045);
pipe(plumbing,'inlet_pipe',[[-.8,.55,1.2],[-1,.55,1.2],[-1,1.45,1.2],[-.6,1.45,1.2]],.025);
pipe(plumbing,'drain_pipe',[[.72,.21,0],[.92,.21,0],[.92,.21,1.30]],.032);
for(const [id,p] of [['inlet_valve',[-1,.80,1.2]],['drain_valve',[.92,.21,.75]]]){cyl(plumbing,id+'_body',p,.055,.12,steel,'z');const v=group(id,p);box(v,'lever',[0,.10,0],[.18,.025,.035],yellow);}
const hood=group('exhaust_hood');
box(hood,'hood_lower',[-1.45,1.28,0],[.965,1.80,1.20],steel);
const shape=new T.Shape();shape.moveTo(-1.932,2.18);shape.lineTo(-1.932,2.52);shape.lineTo(-1.38,3.81);shape.lineTo(-.827,3.81);shape.lineTo(-.827,2.18);shape.closePath();
mesh(hood,'hood_taper',new T.ExtrudeGeometry(shape,{depth:1.2,bevelEnabled:false}),steel,[0,0,-.6]);
const exhaust=group('exhaust_duct');
pipe(exhaust,'elbow_duct',[[-1.14,3.81,0],[-1.14,4.18,0],[-.81,4.18,0],[-.49,4.06,0],[-.49,3.55,0]],.11);
for(const y of [3.80,4.21])cyl(exhaust,'duct_flange',[-1.14,y,0],.145,.035,silver);
const liquid=group('water_level',[0,.16,0]);box(liquid,'cooling_water',[0,0,0],[1.57,.012,1.25],waterMat);
const bubbles=group('quench_bubbles');for(let i=0;i<32;i++){const a=i*2.399;mesh(bubbles,'bubble',new T.SphereGeometry(.012+(i%3)*.005,8,6),waterMat,[Math.cos(a)*.44,.45+(i%7)*.13,Math.sin(a)*.26]);}
// Keep effect geometry hidden at rest without relying on non-standard glTF visible flags.
bubbles.scale.setScalar(.00001);
const clips=[new T.AnimationClip('升降承料架_入水出水',12,[new T.VectorKeyframeTrack('lift_carriage.position',[0,5,7,12],[0,1.633,0,0,.583,0,0,.583,0,0,1.633,0])]),new T.AnimationClip('循环搅拌转子',2,[new T.NumberKeyframeTrack('agitator_rotor.rotation[y]',[0,2],[0,Math.PI*4])])];
const buffer=await new GLTFExporter().parseAsync(model,{binary:true,onlyVisible:false,animations:clips});
fs.writeFileSync(path.join(out,'water_cooling_tank_cad.glb'),Buffer.from(buffer));
const parts=[['tank_shell','主槽焊接壳体',[0,0,-1.6]],['base_and_stiffeners','底座与加强筋',[0,-.45,0]],['work_deck','槽口工作平台',[0,.7,0]],['lift_guides','升降导向架',[1.3,.4,0]],['lift_carriage','升降承料架（含示意工件）',[0,1.3,0]],['lift_drive','升降电机与减速机',[-1.2,.7,0]],['hoist_shaft','传动轴与链轮',[0,1.5,0]],['lift_chains','提升链条',[0,.5,-.8]],['side_reservoir','侧置循环槽',[0,0,1.35]],['agitator_motor','搅拌电机',[0,.9,1]],['agitator_rotor','搅拌轴与叶轮',[0,.4,1.5]],['circulation_piping','进水排水及循环管路',[1.3,0,1]],['exhaust_hood','侧置排烟罩',[-1.4,0,0]],['exhaust_duct','排烟弯管',[0,.8,0]]];
const binding=(id,name,node,action,axis,min,max,key)=>({id,name,node_name:node,action,axis,source_group:'water_cooling',source_key:key,input_min:0,input_max:1,output_min:min,output_max:max,transition_duration:5,speed_factor:Math.PI*2/60});
const metadata=normalizeModelMetadata({assetSpec:{device_family:'水冷槽',unit:'m',delivery_status:'review',notes:'47.10.00 三视总图视觉重建；标注尺寸用于外形/行程标定，未标注细节为示意。'},optimization:{mergeStatic:false,preserveAnimated:true},runtime:{enableGenericBindings:true},
 inspection:normalizeInspection({enabled:true,shell:{node_names:['tank_shell','side_reservoir','exhaust_hood'],opacity:.16},parts:parts.map(([id,name,offset],order)=>({id:'water_'+id,name,node_names:[id],explode_offset:offset,order,duration:1.2,group:'47.10.00 水冷槽',description:'按总图总成分组，用于结构展示。'}))}),
 partBindings:[binding('water_lift','承料架下降入水 / 升起沥水','lift_carriage','translate','y',0,-1.05,'lift_down'),binding('water_hoist','升降传动轴与链轮','hoist_shaft','rotate_speed','x',0,90,'hoist_rpm'),binding('water_stir','循环搅拌轴与叶轮','agitator_rotor','rotate_speed','y',0,180,'agitator_rpm'),binding('water_level','注水 / 排水液位变化','water_level','translate','y',0,1.20,'level_ratio'),binding('water_inlet','进水阀启闭','inlet_valve','rotate_angle','y',0,90,'inlet_open'),binding('water_drain','排水阀启闭','drain_valve','rotate_angle','y',0,90,'drain_open')],
 motionProfile:{id:'water_cooling_tank_cad',version:1,demonstration:true,stroke:1.05,sourceDrawing:'47.10.00',dimensionsMm:{length:2759,width:2172,height:4320,frameHeight:3013,workHeightAboveFloor:1250,baseBelowFloor:383,load:[1100,600,650]},note:'液位、转速和时长为演示参数；现场点位地址未映射。不写入 PLC。'}});
fs.writeFileSync(path.join(out,'water_cooling_tank_cad_metadata.json'),JSON.stringify(metadata,null,2)+'\n');
const bounds=new T.Box3().setFromObject(model);console.log(JSON.stringify({bytes:buffer.byteLength,nodes:(()=>{let n=0;model.traverse(()=>n++);return n;})(),bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},parts:parts.length,bindings:metadata.partBindings.length}));
