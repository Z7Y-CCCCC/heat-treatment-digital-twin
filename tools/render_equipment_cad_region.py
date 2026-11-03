"""Read-only, fixed-scale drawing-region render for CAD detail review."""
import sys,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'output/cad-general-20261103/python'))
import ezdxf,matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import RenderContext,Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration,ColorPolicy
p=argparse.ArgumentParser();p.add_argument('dxf',type=Path);p.add_argument('output',type=Path);p.add_argument('--bounds',type=float,nargs=4,required=True);p.add_argument('--width',type=int,default=3200);args=p.parse_args()
doc=ezdxf.readfile(args.dxf);x0,y0,x1,y1=args.bounds
def within(v):return x0<=v[0]<=x1 and y0<=v[1]<=y1
entities=[]
for e in doc.modelspace():
    if e.dxftype()=='HATCH':continue
    attrs=e.dxf.all_existing_dxf_attribs();points=[attrs[k] for k in ['start','end','center','insert','defpoint','location'] if k in attrs]
    if e.dxftype()=='LWPOLYLINE':points+=list(e.get_points())
    if e.dxftype()!='INSERT' and not any(within(v) for v in points):continue
    entities.append(e)
fig=plt.figure(figsize=(16,16*(y1-y0)/(x1-x0)),dpi=args.width/16);ax=fig.add_axes([0,0,1,1]);ax.axis('off')
ctx=RenderContext(doc);ctx.set_current_layout(doc.modelspace());ctx.current_layout_properties.set_colors(bg='#ffffff',fg='#1a2630')
out=MatplotlibBackend(ax);Frontend(ctx,out,config=Configuration(color_policy=ColorPolicy.BLACK,lineweight_scaling=.25)).draw_entities(entities);out.finalize()
fig.set_size_inches(16,16*(y1-y0)/(x1-x0));ax.set_aspect('equal',adjustable='box');ax.set_xlim(x0,x1);ax.set_ylim(y0,y1);fig.savefig(args.output,dpi=args.width/16,facecolor='white');plt.close(fig)
print(str(args.output),flush=True)
