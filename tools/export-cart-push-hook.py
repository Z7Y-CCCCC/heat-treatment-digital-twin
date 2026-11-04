"""Export one push-hook station from the supplied trial STEP, in metres/Y-up.
Usage: python tools/export-cart-push-hook.py <08050105 STEP file>
Requires CadQuery. The full 880 mm cross-member is not a cart-centre attachment.
"""
from pathlib import Path
import sys,json,struct,hashlib
import cadquery as cq

source=Path(sys.argv[1]);root=Path(__file__).resolve().parents[1]
out=root/'backend/assets/models/attachments/push_pull_hook_08050105.glb';out.parent.mkdir(parents=True,exist_ok=True)
assembly=cq.Assembly.importStep(str(source));parts=[]
for name,item in assembly.objects.items():
    prefix=name.split('_')[0]
    station=name.rsplit('_',2)[-2] if prefix in ['06','07','11','14'] else name.rsplit('_',1)[-1]
    if prefix in ['06','07','10','11','12','13','14','15','16'] and station=='1':
        shape=item.obj.moved(item.loc).translate((180,0,0))
        parts.append((name,shape,prefix in ['06','10','12','13','14','15','16']))
assert len(parts)==13,len(parts)
parts.append(('pivot_shaft_D25_L110',cq.Workplane('YZ').circle(12.5).extrude(55,both=True).val(),False))
parts.append(('mount_adapter',cq.Workplane('XY').box(120,180,8).translate((0,0,-64)).val(),False))
doc={'asset':{'version':'2.0','generator':'DWG push-head trial / CadQuery'},'scene':0,'scenes':[{'nodes':[0]}],
 'nodes':[{'name':'push_pull_hook_08050105_root','children':[1,2]}, {'name':'hook_fixed','children':[]}, {'name':'hook_latch','children':[]}],
 'meshes':[],'materials':[
 {'name':'hook_steel','pbrMetallicRoughness':{'baseColorFactor':[.38,.44,.49,1],'metallicFactor':.65,'roughnessFactor':.36}},
 {'name':'hook_pin','pbrMetallicRoughness':{'baseColorFactor':[.72,.76,.8,1],'metallicFactor':.8,'roughnessFactor':.24}},
 {'name':'hook_bronze','pbrMetallicRoughness':{'baseColorFactor':[.64,.47,.23,1],'metallicFactor':.7,'roughnessFactor':.32}}],
 'buffers':[{'byteLength':0}],'bufferViews':[],'accessors':[]}
binary=bytearray();solid_count=0
def append(data,target):
    while len(binary)%4:binary.append(0)
    offset=len(binary);binary.extend(data);index=len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(data),'target':target});return index
for name,shape,moving in parts:
    assert shape.isValid(),name
    vertices,triangles=shape.tessellate(.6,.45)
    # STEP X is transverse, Y is feed, Z is up. Face the hook towards cart +X.
    positions=[(-v.y*.001,v.z*.001,-v.x*.001) for v in vertices]
    position_view=append(struct.pack('<'+'f'*len(positions)*3,*[v for p in positions for v in p]),34962)
    positions_accessor=len(doc['accessors']);doc['accessors'].append({'bufferView':position_view,'componentType':5126,'count':len(positions),'type':'VEC3','min':[min(p[i] for p in positions) for i in range(3)],'max':[max(p[i] for p in positions) for i in range(3)]})
    index_view=append(struct.pack('<'+'I'*len(triangles)*3,*[v for t in triangles for v in t]),34963)
    indices_accessor=len(doc['accessors']);doc['accessors'].append({'bufferView':index_view,'componentType':5125,'count':len(triangles)*3,'type':'SCALAR'})
    material=2 if name.startswith(('07','11','15','16')) else 1 if name.startswith(('12','13','14','pivot')) else 0
    mesh=len(doc['meshes']);doc['meshes'].append({'name':name,'primitives':[{'attributes':{'POSITION':positions_accessor},'indices':indices_accessor,'material':material}]})
    node=len(doc['nodes']);doc['nodes'].append({'name':name,'mesh':mesh});doc['nodes'][2 if moving else 1]['children'].append(node);solid_count+=len(shape.Solids())
doc['buffers'][0]['byteLength']=len(binary)
while len(binary)%4:binary.append(0)
payload=json.dumps(doc,separators=(',',':')).encode();payload+=b' '*((-len(payload))%4)
data=struct.pack('<III',0x46546c67,2,28+len(payload)+len(binary))+struct.pack('<II',len(payload),0x4e4f534a)+payload+struct.pack('<II',len(binary),0x004e4942)+binary
out.write_bytes(data)
metadata={'sourceStepFilename':source.name,'sourceStepSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
 'sourceDwgSha256':'55cf019e503953268fad17add654e7677335995439869d3f178468acce07803c',
 'description':'One trial push-hook station rebased from the DWG/STEP assembly; 880 mm cross-member excluded.',
 'unit':'m','solidCount':solid_count,'partNames':[n for n,_,_ in parts],
 'limitations':'Trial assembly; inferred mount adapter and latch demonstration angle, not a manufacturing or PLC commissioning model.'}
out.with_suffix('.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'file':str(out),'parts':len(parts),'bytes':len(data)},ensure_ascii=False))
