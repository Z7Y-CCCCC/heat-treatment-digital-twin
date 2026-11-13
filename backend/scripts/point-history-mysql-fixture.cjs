'use strict';
// Explicitly supplied connection; every query is rewritten to a connection-local
// TEMPORARY fixture table. Never changes or deletes production history.
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
module.exports=async function verifyLegacyMysqlHistory(connection){
    const name='temp_point_history_'+process.pid,table='`'+name+'`',copy='`'+name+'_copy`';
    await connection.query(`CREATE TEMPORARY TABLE ${table}(sample_key VARCHAR(64) PRIMARY KEY,factory_id VARCHAR(128),device_id VARCHAR(128),point_id VARCHAR(128),source_mode VARCHAR(32),sampled_at DOUBLE,value_number DOUBLE,value_json TEXT,quality VARCHAR(32),retention_until DOUBLE NULL,INDEX scope_time(factory_id,device_id,point_id,sampled_at))`);
    const from=Date.now()-7200000;
    try{
        for(let start=0;start<=3600;start+=200){const records=[];for(let i=start;i<=Math.min(3600,start+199);i++){const value=i===1800?999:i===1700?null:i%100;records.push([createHash('sha256').update(String(i)).digest('hex'),'fixture','device','1','integrated_plc',from+i*1000,value,JSON.stringify(value),i===1700?'bad':'good',null]);}
            await connection.query(`INSERT INTO ${table}(sample_key,factory_id,device_id,point_id,source_mode,sampled_at,value_number,value_json,quality,retention_until) VALUES ?`,[records]);}
        // MySQL cannot reference the SAME temporary table twice in a join;
        // production uses an ordinary table. Mirror it into two temporary
        // tables so this fixture remains completely connection-local.
        await connection.query(`CREATE TEMPORARY TABLE ${copy} LIKE ${table}`);await connection.query(`INSERT INTO ${copy} SELECT * FROM ${table}`);
        const db={all:async(sql,params)=>{assert.ok(/\bpoint_samples\b/.test(sql));assert.doesNotMatch(sql,/ROW_NUMBER|\bWITH\s/i);let occurrence=0;return (await connection.query(sql.replace(/\bpoint_samples\b/g,()=>occurrence++?copy:table),params))[0];}};
        const scope={factoryId:'fixture',deviceId:'device',pointId:'1',sourceMode:'integrated_plc'};
        const started=Date.now();const curve=await require('../services/pointHistory').trendHistory(db,scope,{from,to:from+3600000,limit:2000});
        assert.ok(curve.rows.length<=2000);assert.equal(curve.rows[0].timestamp,from);assert.equal(curve.rows.at(-1).timestamp,from+3600000);
        assert.ok(curve.rows.some(row=>row.value===999));assert.ok(curve.rows.some(row=>row.value===null));assert.ok(curve.rows.some(row=>row.value===0));
        assert.equal((await require('../services/pointHistory').trendHistory(db,{...scope,factoryId:'other'},{from,to:from+3600000,limit:2000})).rows.length,0);
        const [count]=await connection.query(`SELECT COUNT(*) n FROM ${table}`);assert.equal(Number(count[0].n),3601);
        return {success:true,temporaryTableOnly:true,rawSamples:3601,drawingPoints:curve.rows.length,durationMs:Date.now()-started,extremaAndGapsPreserved:true};
    }finally{await connection.query(`DROP TEMPORARY TABLE IF EXISTS ${table},${copy}`);}
};
