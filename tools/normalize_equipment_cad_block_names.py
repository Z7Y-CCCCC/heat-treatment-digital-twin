"""Repair unnamed block metadata in a derived DXF, preserving all geometry."""
from pathlib import Path
import sys,json,hashlib
source=Path(sys.argv[1]);destination=Path(sys.argv[2]);destination.parent.mkdir(parents=True,exist_ok=True)
lines=source.read_text(encoding='utf8').splitlines();records=[];record=[]
for i in range(0,len(lines)-1,2):
    tag=(int(lines[i]),lines[i+1])
    if tag[0]==0 and record:records.append(record);record=[]
    record.append(tag)
if record:records.append(record)
repaired={};changes=[]
for record in records:
    if record[0][1]=='BLOCK_RECORD' and not any(c==2 and value.strip() for c,value in record):
        handle=next(value for c,value in record if c==5);name='CAD_UNNAMED_'+handle
        record[:]=[(c,v) for c,v in record if c!=2];record.append((2,name));repaired[handle]=name
        changes.append({'type':'BLOCK_RECORD','handle':handle,'synthetic_name':name})
for record in records:
    if record[0][1]=='BLOCK':
        owner=next((v for c,v in record if c==330),None)
        if owner in repaired:
            record[:]=[(c,repaired[owner] if c in (2,3) else v) for c,v in record]
    if record[0][1]=='INSERT' and any(c==2 and not v.strip() for c,v in record):
        assert len(repaired)==1,'Ambiguous unnamed block reference'
        record[:]=[(c,next(iter(repaired.values())) if c==2 else v) for c,v in record]
        changes.append({'type':'INSERT','handle':next(v for c,v in record if c==5),'synthetic_name':next(iter(repaired.values()))})
destination.write_text(''.join(f'{c:3d}\n{v}\n' for record in records for c,v in record),encoding='utf8',newline='\n')
report={'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'normalized_sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),
        'records_preserved':len(records),'changes':changes,'geometry_removed':0}
destination.with_suffix('.normalization.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report),flush=True)
