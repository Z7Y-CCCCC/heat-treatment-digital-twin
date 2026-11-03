"""Focused read-only orthographic sheets: exclude borders and duplicate revisions."""
import sys,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/cad-general-20261103'
sys.path.insert(0,str(OUT/'python'))
import ezdxf
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import RenderContext,Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration,ColorPolicy
REGIONS={
 'transfer_cart':(46700,-5100,54500,1200),
 'fixed_staging_table':(13900,600,19700,4700),
 'lifting_staging_table':(-9500,1200,-4800,4600),
 'air_cooling_table':(35500,-21800,42400,-17000),
 'water_cooling_tank':(297000,-2300,307400,5400),
 'tempering_furnace':(27000,2000,37000,9500),
 'washing_machine':(17000,900,27000,9400),
}
for name,area in REGIONS.items():
 if sys.argv[1:] and name not in sys.argv[1:]:continue
 doc=ezdxf.readfile(OUT/(name+'.dxf'));x0,y0,x1,y1=area
 def within(v):return x0<=v[0]<=x1 and y0<=v[1]<=y1
 entities=[]
 for e in doc.modelspace():
  if e.dxftype()=='HATCH':continue
  attrs=e.dxf.all_existing_dxf_attribs()
  points=[attrs[k] for k in ['start','end','center','insert','defpoint','location'] if k in attrs]
  if e.dxftype()=='LWPOLYLINE':points+=list(e.get_points())
  if e.dxftype()!='INSERT' and not any(within(v) for v in points):continue
  entities.append(e)
 fig=plt.figure(figsize=(16,16*(y1-y0)/(x1-x0)),dpi=150);ax=fig.add_axes([0,0,1,1]);ax.set_aspect('equal');ax.axis('off')
 ctx=RenderContext(doc);ctx.set_current_layout(doc.modelspace());ctx.current_layout_properties.set_colors(bg='#ffffff',fg='#1a2630')
 out=MatplotlibBackend(ax);Frontend(ctx,out,config=Configuration(color_policy=ColorPolicy.BLACK,lineweight_scaling=.25)).draw_entities(entities);out.finalize()
 fig.set_size_inches(16,16*(y1-y0)/(x1-x0));ax.set_aspect('equal',adjustable='box');ax.set_xlim(x0,x1);ax.set_ylim(y0,y1);fig.savefig(OUT/(name+'-primary.png'),dpi=150,facecolor='white');plt.close(fig)
 print(name,len(entities),flush=True)
(OUT/'primary-regions.json').write_text(json.dumps(REGIONS,indent=2),encoding='utf8')
