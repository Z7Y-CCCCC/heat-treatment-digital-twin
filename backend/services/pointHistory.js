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
// Window functions retain actual timestamps/values, first/last samples, extrema
// and outage gaps. Only the returned drawing is reduced; raw rows are untouched.
async function trendHistory(db, scope, input) {
    const {from,to,limit}=queryRange(input),width=Math.max(1,Math.ceil((to-from)/(Math.floor(limit/5)-1)));
    const rows=await db.all(`WITH samples AS (
        SELECT sampled_at, value_number, quality, source_mode, sample_key,
            FLOOR((sampled_at - ?) / ?) AS bucket FROM point_samples
        WHERE factory_id=? AND device_id=? AND point_id=? AND source_mode=? AND sampled_at>=? AND sampled_at<=?
            AND (retention_until IS NULL OR retention_until>=?)
    ), ranked AS (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY sampled_at, sample_key) AS first_row,
            ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY sampled_at DESC, sample_key) AS last_row,
            ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY CASE WHEN value_number IS NULL THEN 1 ELSE 0 END, value_number, sampled_at) AS min_row,
            ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY CASE WHEN value_number IS NULL THEN 1 ELSE 0 END, value_number DESC, sampled_at) AS max_row,
            ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY CASE WHEN quality='good' THEN 1 ELSE 0 END, sampled_at) AS fault_row
        FROM samples
    ) SELECT sampled_at, value_number, quality, source_mode FROM ranked
      WHERE first_row=1 OR last_row=1 OR min_row=1 OR max_row=1 OR (fault_row=1 AND quality<>'good')
      ORDER BY sampled_at`,[from,width,scope.factoryId,scope.deviceId,scope.pointId,scope.sourceMode,from,to,Date.now()]);
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
