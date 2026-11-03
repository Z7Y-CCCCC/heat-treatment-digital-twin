"""Read converted DXF without modifying it; render sheets and extract dimensions."""
from pathlib import Path
import argparse, collections, json, sys

parser=argparse.ArgumentParser()
parser.add_argument('directory',type=Path)
args=parser.parse_args()
deps=args.directory/'python'
if deps.exists():sys.path.insert(0,str(deps.resolve()))
import ezdxf
from ezdxf import bbox
from ezdxf.addons.drawing.matplotlib import qsave
from ezdxf.addons.drawing.config import Configuration, ColorPolicy, LineweightPolicy

report=[]
for file in sorted(args.directory.glob('*.dxf')):
    doc=ezdxf.readfile(file);space=doc.modelspace()
    texts=[];dimensions=[]
    for e in space:
        kind=e.dxftype()
        if kind in ('TEXT','MTEXT'):
            text=e.plain_text() if kind=='MTEXT' else e.dxf.text
            if text.strip():texts.append({'text':text,'at':list(e.dxf.insert),'height':e.dxf.get('height',0) if kind=='TEXT' else e.dxf.get('char_height',0)})
        if kind=='DIMENSION':
            try:value=e.get_measurement()
            except Exception:value=None
            dimensions.append({'value':value,'text':e.dxf.get('text',''),'at':list(e.dxf.defpoint),'type':e.dxf.dimtype,
                'p2':list(e.dxf.get('defpoint2',(0,0,0))),'p3':list(e.dxf.get('defpoint3',(0,0,0)))})
    ext=bbox.extents(space,fast=True)
    item={'id':file.stem,'units':doc.units,'entities':dict(collections.Counter(e.dxftype() for e in space)),
          'extents':[list(ext.extmin),list(ext.extmax)],'texts':texts,'dimensions':dimensions,
          'layers':[{ 'name':l.dxf.name,'color':l.dxf.color} for l in doc.layers]}
    (args.directory/(file.stem+'-drawing.json')).write_text(json.dumps(item,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
    image=args.directory/(file.stem+'-sheet.png')
    if not image.exists() or image.stat().st_mtime<file.stat().st_mtime:
        qsave(space,str(image),bg='#ffffff',fg='#202832',dpi=150,size_inches=(24,0),
              config=Configuration(color_policy=ColorPolicy.BLACK,lineweight_policy=LineweightPolicy.RELATIVE,lineweight_scaling=.35))
    report.append({'id':file.stem,'entities':len(space),'bounds':item['extents'],'dimensions':len(dimensions),'texts':len(texts),'image':str(image)})
    print(json.dumps(report[-1],ensure_ascii=False),flush=True)
(args.directory/'drawing-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
