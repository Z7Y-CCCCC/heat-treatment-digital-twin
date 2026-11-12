import test from 'node:test'
import assert from 'node:assert/strict'
import {createPointHistoryClient} from '../src/runtime/pointHistoryClient.js'
import {compactTrendRows,appendTrendSample} from '../src/runtime/trendChart.js'
test('one-hour raw history can be bounded for drawing without dropping the time range, spikes or gaps',()=>{
  const start=Date.now()-3600000,rows=Array.from({length:3601},(_,i)=>({timestamp:start+i*1000,time:start+i*1000,value:i===1200?10000:i===1400?null:i%20}));
  const result=compactTrendRows(rows,600);assert.ok(result.length<=600);assert.equal(result[0].timestamp,start);assert.equal(result.at(-1).timestamp,start+3600000);
  assert.ok(result.some(row=>row.value===10000));assert.ok(result.some(row=>row.value===null));assert.equal(rows.length,3601);
  let live=[];for(const row of rows)live=appendTrendSample(live,{timestamp:row.timestamp,value:row.value,quality:row.value===null?'bad':'good'},{limit:3600,windowSeconds:3600});
  assert.equal(live[0].timestamp,start);assert.equal(live.at(-1).timestamp,start+3600000);
})
test('history client queries the current factory/device, rejects cross-scope responses and discards late answers',async()=>{
  const calls=[],now=Date.now(),scope={factoryId:'f',deviceId:'a',pointId:'1',sourceMode:'simulation'};
  const client=createPointHistoryClient((url,options)=>new Promise(resolve=>calls.push({url,options,resolve})));
  const result=(device='a')=>({ok:true,json:async()=>({factoryId:'f',deviceId:device,pointId:'1',rows:[{timestamp:now-3500000,value:0,quality:'good'}]})});
  try{
    const old=client.read(scope,{windowSeconds:3600,now});const current=client.read({...scope,deviceId:'b'},{windowSeconds:3600,now});
    assert.equal(calls[0].options.signal.aborted,true);assert.equal(calls[1].options.headers['X-Factory-Id'],'f');assert.match(calls[1].url,/device_id=b/);
    assert.equal(Number(new URL(calls[1].url,'http://fixture').searchParams.get('from')),now-3600000);
    calls[1].resolve(result('b'));assert.equal((await current).rows[0].value,0);
    calls[0].resolve(result());assert.equal(await old,null);
    const wrong=client.read(scope,{now});calls[2].resolve(result('OTHER'));await assert.rejects(wrong,/范围无效/);
  }finally{client.dispose();}
})
