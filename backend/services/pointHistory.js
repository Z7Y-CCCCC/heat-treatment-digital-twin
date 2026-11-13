'use strict';
const {createHash} = require('node:crypto');
function observedSamples(factoryId, devices, mode) {
    const records=[];
    for(const device of devices || []) for(const [key,meta] of Object.entries(device.pointMeta || {})) {
        if(!meta.id || !device.furnace_id)continue; // No invented/unconfigured demo points.
        const [group,field]=key.split('.'), raw=device[group]?.[field], quality=device.quality?.[group]?.[field] || 'bad';
        const timestamp=Number(quality==='good' ? meta.timestamp || device.timestamp : device.timestamp);
        if(!Number.isSafeInteger(timestamp) || timestamp<=0 || !['good','bad','stale'].includes(quality))continue;
        const value=quality==='good' && ['number','string','boolean'].includes(typeof raw) && (typeof raw!=='number' || Number.isFinite(raw)) ? raw : null;
        const record={factoryId:String(factoryId),deviceId:String(device.furnace_id),pointId:String(meta.id),pointKey:key,
            pointName:String(meta.label || meta.name || key).slice(0,255),unit:String(meta.unit || '').slice(0,64),sourceMode:mode,
            sampledAt:timestamp,valueJson:JSON.stringify(value),valueNumber:value===null || value==='' || !Number.isFinite(Number(value)) ? null : Number(value),quality};
        record.sampleKey=createHash('sha256').update(JSON.stringify([record.factoryId,record.deviceId,record.pointId,mode,timestamp,quality])).digest('hex');
        records.push(record);
    }
    return records;
}
function queryRange(input) {
    const from=Number(input.from),to=Number(input.to),limit=Number(input.limit || 2000);
    if(!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from<0 || to<=from || to>8640000000000000)throw Error('历史时间范围无效');
    if(!Number.isInteger(limit) || limit<20 || limit>5000)throw Error('绘制点数须在 20～5000 之间');
    return {from,to,limit};
}
// Bucket representatives work on MySQL 5.7 too (no CTE/window functions).
// Both queries return bounded drawing data; full raw rows stay untouched.
async function trendHistory(db, scope, input) {
    const {from,to,limit}=queryRange(input),width=Math.max(1,Math.ceil((to-from)/(Math.floor(limit/5)-1)));
    const filter='factory_id=? AND device_id=? AND point_id=? AND source_mode=? AND sampled_at>=? AND sampled_at<=? AND (retention_until IS NULL OR retention_until>=?)';
    const params=[scope.factoryId,scope.deviceId,scope.pointId,scope.sourceMode,from,to,Date.now()];
    const representatives=await db.all(`SELECT
        MIN(CASE WHEN s.sampled_at=b.first_time THEN s.sample_key END) AS first_key,
        MIN(CASE WHEN s.sampled_at=b.last_time THEN s.sample_key END) AS last_key,
        MIN(CASE WHEN s.value_number=b.min_value THEN s.sample_key END) AS min_key,
        MIN(CASE WHEN s.value_number=b.max_value THEN s.sample_key END) AS max_key,
        MIN(CASE WHEN s.quality<>'good' AND s.sampled_at=b.fault_time THEN s.sample_key END) AS fault_key
      FROM (SELECT sample_key,sampled_at,value_number,quality,FLOOR((sampled_at-?)/?) AS bucket FROM point_samples WHERE ${filter}) s
      JOIN (SELECT FLOOR((sampled_at-?)/?) AS bucket,MIN(sampled_at) AS first_time,MAX(sampled_at) AS last_time,
        MIN(value_number) AS min_value,MAX(value_number) AS max_value,MIN(CASE WHEN quality<>'good' THEN sampled_at END) AS fault_time
        FROM point_samples WHERE ${filter} GROUP BY FLOOR((sampled_at-?)/?)) b ON s.bucket=b.bucket
      GROUP BY s.bucket`,[from,width,...params,from,width,...params,from,width]);
    const keys=[...new Set(representatives.flatMap(row=>['first_key','last_key','min_key','max_key','fault_key'].map(key=>row[key]).filter(Boolean)))];
    if(keys.length>limit)throw Error('历史抽样结果超过绘制上限');
    const rows=keys.length?await db.all(`SELECT sampled_at,value_number,quality,source_mode FROM point_samples
      WHERE sample_key IN (${keys.map(()=>'?').join(',')}) AND ${filter} ORDER BY sampled_at,sample_key`,[...keys,...params]):[];
    return {rows:rows.map(row=>({time:Number(row.sampled_at),timestamp:Number(row.sampled_at),value:row.quality==='good'?row.value_number:null,quality:row.quality,sourceMode:row.source_mode})),
        from,to,retention:'configured',drawingOnly:true,bucketMs:width};
}
async function rawHistory(db,scope,input){
    const {from,to,limit}=queryRange(input),afterTime=Number(input.after_time ?? from),afterKey=String(input.after_key || '');
    if(!Number.isSafeInteger(afterTime) || afterTime<from || afterTime>to || (afterKey && !/^[a-f0-9]{64}$/.test(afterKey)))throw Error('历史分页游标无效');
    const rows=await db.all(`SELECT * FROM point_samples WHERE factory_id=? AND device_id=? AND point_id=?
        AND sampled_at>=? AND sampled_at<=? AND (sampled_at>? OR (sampled_at=? AND sample_key>?))
        AND (retention_until IS NULL OR retention_until>=?)
        ORDER BY sampled_at,sample_key LIMIT ${limit+1}`,[scope.factoryId,scope.deviceId,scope.pointId,from,to,afterTime,afterTime,afterKey,Date.now()]);
    const more=rows.length>limit,kept=rows.slice(0,limit),last=kept.at(-1);
    return {rows:kept.map(row=>({...row,value:JSON.parse(row.value_json)})),retention:'configured',drawingOnly:false,
        next:more && last?{after_time:Number(last.sampled_at),after_key:last.sample_key}:null};
}
module.exports={observedSamples,queryRange,trendHistory,rawHistory};
