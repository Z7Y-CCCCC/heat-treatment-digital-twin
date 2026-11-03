"""Validate the seven completed CAD-derived GLBs; package only after all pass."""
from pathlib import Path
import json,hashlib,zipfile,sys,shutil
import validate_equipment_glb as structure
import audit_equipment_glb_geometry as geometry

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'backend/assets/models/cad_general_20261103_v1'
EVIDENCE=ROOT/'output/cad-general-20261103'
SOURCE=Path('C:/Users/27323/OneDrive/xwechat_files/wxid_f106gyezhw4k22_764e/msg/file/2026-11')
sys.stdout.reconfigure(encoding='utf8')
source_checks=[]
for item in json.loads((EVIDENCE/'sources.json').read_text(encoding='utf-8-sig')):
    file=SOURCE/item['source']
    actual=hashlib.sha256(file.read_bytes()).hexdigest().upper()
    assert actual==item['sha256'].upper(),('Original DWG changed',file.name)
    source_checks.append({'file':file.name,'sha256':actual,'unchanged':True})
manifest=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
assert len(manifest['models'])==7,'All seven files must finish before packaging'
assert manifest.get('detail_pass') and all(m.get('detail_features') for m in manifest['models']),'All seven must finish the CAD detail pass'
assert len(list(OUT.glob('*.glb')))==7
measurements=json.loads((EVIDENCE/'final-review/measurements.json').read_text(encoding='utf8'))
assert measurements['pass'] and len(measurements['models'])==7,'Source measurements must pass for all seven'
measured={m['file']:m for m in measurements['models']}
renders=json.loads((EVIDENCE/'final-review/rendered-glb-evidence.json').read_text(encoding='utf8'))
rendered={m['file']:m for m in renders}
assert len(rendered)==7,'Every delivered GLB needs a freshly imported detail render'
results=[]
for item in manifest['models']:
    file=OUT/item['file'];document,size=structure.read_glb(file)
    structural=structure.validate(document,size,item['model_id']+'_root',item)
    d,binary,byte_count=geometry.read_glb(file);audit=geometry.audit(d,binary,byte_count)
    assert structural['valid'],(file.name,structural['errors'])
    assert audit['valid'],(file.name,audit['stats'],audit['errors'])
    assert hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256']
    assert measured[file.name]['sha256']==item['sha256'] and measured[file.name]['pass']
    assert measured[file.name]['source_blend_sha256']==hashlib.sha256((OUT/'sources'/(file.stem+'.blend')).read_bytes()).hexdigest()
    assert rendered[file.name]['sha256']==item['sha256'],'Do not reuse a render of an older model'
    for picture in rendered[file.name]['renders']:assert (EVIDENCE/'final-review'/picture).is_file()
    assert item['roundtrip_max_error_m']<.0001
    assert (OUT/'sources'/(file.stem+'.blend')).is_file()
    for view in ['preview','rear']:assert (OUT/'previews'/(file.stem+'_'+view+'.png')).is_file()
    assert not document.get('cameras') and not document.get('animations')
    assert not any('uri' in b for b in document.get('buffers',[]))
    assert not any('uri' in image for image in document.get('images',[]))
    result={'name':item['name'],'file':file.name,'valid':True,'bytes':size,'runtime':structural['stats'],
            'geometry':audit['stats'],'roundtrip_max_error_m':item['roundtrip_max_error_m']}
    results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
(EVIDENCE/'delivery-validation.json').write_text(json.dumps({'valid':True,'originals':source_checks,'models':results},ensure_ascii=False,indent=2),encoding='utf8')

lines=['# CAD 设备 GLB 模型','',
       '7 份独立 GLB，单位米、Y 轴向上，全部材质内置，无外部贴图依赖。材质沿用现有 V6 工业设备模型。',
       '按提供的二维总图、剖视图及标注尺寸重建，细节采用实体网格。图纸没有给出的尺寸按视图比例推定，不冒充实测数据；本文件不替代制造图。',
       '底部为放置原点；水冷槽的地坪高于模型底部 383 mm，清洗机总图底座有 150 mm 安装深度。',
       '模型保留门、传动、滚床、管路等功能分组，但没有虚构 PLC 绑定或动画。','',
       '| 模型 | 文件 | 三角形 | 文件大小 |','|---|---|---:|---:|']
for item in manifest['models']:lines.append(f"| {item['name']} | `{item['file']}` | {item['triangles']:,} | {item['bytes']/1024/1024:.2f} MB |")
lines+=['','## 版本选择','']
for item in manifest['models']:lines.append('- '+item['name']+'：'+' '.join(item['notes']))
lines+=['','`sources/`：独立可编辑 Blender 工程；`previews/`：正反面渲染；`metadata/`：图纸哈希、标注尺寸、分组、回读校验。',
        '原始 DWG 的 SHA-256 全部复核未变，也没有写入当前运行工程或替换旧模型。',
        '', '## 细节复核', '',
        '| 设备 | 本轮复核项 |','|---|---|',
        '| 料车 | 单中央回链板、链节销轴、八齿链轮、1425 mm 轴距、1050 mm 轮距、横向车轴、滚轮、轴承、平台交叉撑、电柜百叶与锁 |',
        '| 升降备料台 | 5 对 Ø60×136 滚轮、Ø20 轴、剪叉枢轴、行走导轮、液压缸与活塞杆、油管接头 |',
        '| 固定备料台 | 6 对 Ø60×167 滚轮、Ø20 轴、槽钢腿、撑板、可调底脚、双锁紧螺母、挡料机构 |',
        '| HT 风冷台 | 窄端升降门架、6 对滚轮、两台四叶轴流风机、安全网、提升链、夹扣、方形排风口法兰 |',
        '| 水冷槽 | 下槽与上室、右侧搅拌槽、叶轮与轴、吊篮深度朝向、提升横轴、链条导轨、后抽风罩、阀门法兰与检修盖 |',
        '| 回火炉 | 三联仪表、升降门链与安全开关、炉内滚道、加热元件、水平循环风机及立轴、两排各 6 接线端、斜面抽风罩、管路与检修门 |',
        '| 清洗机 | 三联仪表、双侧水箱、12 加热口、外露回流管及支夹、喷淋管嘴、带槽轮盘及减重孔、双皮带相切包络、电机与传动轴、过滤箱盖与提手、泵和阀门 |',
        '', '机械数量与方向检查只覆盖已列出的关键项目，不把网格校验等同于每条 CAD 线都已完成实物复刻。']
(OUT/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf8')

review=OUT/'review';review.mkdir(exist_ok=True)
for name in ['measurements.json','rendered-glb-evidence.json']:
    shutil.copy2(EVIDENCE/'final-review'/name,review/name)
shutil.copy2(EVIDENCE/'delivery-validation.json',review/'export-validation.json')
for model in rendered.values():
    for picture in model['renders']:shutil.copy2(EVIDENCE/'final-review'/picture,review/picture)
checks=sum(len(m['tests']) for m in measurements['models'])
notes=['# 最终核验记录','',
       f'7 台逐台对照 CAD 主图及剖视图；{checks} 项尺寸／数量检查通过，7 个 GLB 结构与几何检查通过。',
       '逐个重新导入交付 GLB 渲染特写；回火炉、水冷槽、清洗机另做去壳检查，只在核验场景中隐藏外壳，没有从交付模型删除部件。','',
       '## 本次发现并修正','',
       '- 料车：轴距从 1420 改为 1425 mm，轮距从 960 改为 1050 mm，车轴、轴承与轮组对齐。',
       '- 备料台：复查滚轮数量、Ø60 外径、Ø20 轴径、320／280 mm 节距；槽钢改为连通的实际 C 形截面。',
       '- HT 风冷台：确认窄端门架、3052 mm 总高；风机按图改为每台四叶。',
       '- 清洗机：带轮改为带槽轮盘、四个减重通孔、双皮带相切包络，补齐电机连接轴与从动轴。',
       '- 回火炉与清洗机：按正视图配置三联仪表；回火炉铭牌移到抽风罩正面，避免被罩体遮住。',
       '- 排风管：修复小半径弯头造成的翻面，使用圆弧弯管，重新导出核查。','',
       '## 核查范围','',
       '详见 README 的逐台机构清单、review/measurements.json、review/export-validation.json 和 review/ 特写。',
       '总图没有标注的零件尺寸仍按视图比例推定；本次是展示模型外观与关键机构核验，不将其宣称为逐零件制造公差验收。',
       '原始 7 份 DWG 哈希未变；未覆盖旧模型、未修改当前运行工程或采集配置。']
(OUT/'核验记录.md').write_text('\n'.join(notes)+'\n',encoding='utf8')

# A small, self-contained delivery archive. Do not include source DWGs or runtime data.
archive=OUT/'七套CAD设备_GLB.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for file in [*sorted(OUT.glob('*.glb')),OUT/'README.md',OUT/'核验记录.md',OUT/'manifest.json',*sorted((OUT/'metadata').glob('*.json')),*sorted(review.glob('*'))]:z.write(file,file.relative_to(OUT))
    overview=OUT/'七套设备总览.png'
    if overview.exists():z.write(overview,overview.name)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None and sum(name.endswith('.glb') for name in z.namelist())==7
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'models':len(results),'valid':True},ensure_ascii=False))
sources=OUT/'七套CAD设备_Blender源工程.zip'
with zipfile.ZipFile(sources,'w',zipfile.ZIP_DEFLATED) as z:
    for file in sorted((OUT/'sources').glob('*.blend')):z.write(file,Path('sources')/file.name)
    z.write(OUT/'README.md','README.md')
with zipfile.ZipFile(sources) as z:assert z.testzip() is None and sum(n.endswith('.blend') for n in z.namelist())==7
