"""Contact sheet from the actual Blender renders, never substitute concept art."""
from pathlib import Path
import json
from PIL import Image,ImageOps,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'backend/assets/models/cad_general_20261103_v1'
manifest=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
order=['transfer_cart','lifting_staging_table','fixed_staging_table','air_cooling_table',
       'water_cooling_tank','tempering_furnace','washing_machine']
models={m['source']['id']:m for m in manifest['models']}
font_path='C:/Windows/Fonts/msyh.ttc'
font=ImageFont.truetype(font_path,26);small=ImageFont.truetype(font_path,19)
title=ImageFont.truetype(font_path,34)
canvas=Image.new('RGB',(2140,1192),'#edf1f5');draw=ImageDraw.Draw(canvas)
draw.text((30,22),'CAD 设备 · GLB 模型',font=title,fill='#1e2b37')
for i,key in enumerate(order):
    m=models[key];x=24+(i%4)*530+(265 if i>=4 else 0);y=85+(i//4)*546
    draw.rounded_rectangle((x,y,x+506,y+524),12,fill='white')
    view='rear' if key=='air_cooling_table' else 'preview'
    source=Image.open(OUT/'previews'/(Path(m['file']).stem+'_'+view+'.png')).convert('RGB')
    source=ImageOps.fit(source,(506,455),method=Image.Resampling.LANCZOS)
    canvas.paste(source,(x,y))
    draw.text((x+16,y+464),m['name'],font=font,fill='#1e2b37')
    draw.text((x+16,y+497),Path(m['file']).stem.split('_')[0],font=small,fill='#6b7988')
canvas.save(OUT/'七套设备总览.png')
print(OUT/'七套设备总览.png')
