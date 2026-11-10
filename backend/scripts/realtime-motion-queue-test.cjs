'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {WsOutboundQueue}=require('../utils/wsOutboundQueue');
const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'../../shared/realtime-motion-queue-fixtures.json'),'utf8'));
class HeldSocket{
 constructor(){this.readyState=1;this.bufferedAmount=0;this.sent=[];this.callbacks=[];}
 send(text,callback){this.sent.push(JSON.parse(text));this.callbacks.push(callback);}
 close(code){this.readyState=2;this.closeCode=code;}
 terminate(){this.readyState=3;}
 flush(){this.callbacks.shift()?.();}
}
for(const fixture of fixtures.cases){
 const socket=new HeldSocket(),queue=new WsOutboundQueue(socket);
 try{
  assert.ok(queue.enqueue({type:'welcome'}));
  for(const message of fixture.messages)assert.ok(queue.enqueue(message),fixture.name);
  while(socket.callbacks.length)socket.flush();
  const actual=socket.sent.slice(1);
  if(fixture.expected)assert.deepEqual(actual,fixture.expected,fixture.name);
  if(fixture.expectedValues)assert.deepEqual(actual.map(x=>x.payload.devices[0].motionInputs.feed.value),fixture.expectedValues,fixture.name);
  if(fixture.expectedStages)assert.deepEqual(actual.map(x=>x.payload.devices[0].motionInputs.feed.stage),fixture.expectedStages,fixture.name);
  if(fixture.expectedDataItemIds)assert.deepEqual(actual.map(x=>x.payload.devices[0].motionInputs.feed.dataItemId),fixture.expectedDataItemIds,fixture.name);
  if(fixture.expectedStatus)assert.deepEqual(actual.map(x=>x.payload.devices[0].status.start_feed),fixture.expectedStatus,fixture.name);
  assert.equal(queue.bytes,0);
  console.log('PASS '+fixture.name);
 }finally{queue.dispose();}
}
const source=(value,timestamp)=>({type:'realtime_frame',payload:{timestamp,devices:[{furnace_id:'cart',motionInputOnly:true,timestamp,motionInputs:{feed:{dataItemId:'point:feed',value,quality:'good',timestamp,staleMs:5000}}}]}});
{
 const socket=new HeldSocket(),queue=new WsOutboundQueue(socket),start=performance.now();
 try{
  queue.enqueue({type:'welcome'});
  for(let i=0;i<5000;i++)assert.ok(queue.enqueue(source(i/5000,1000+i)));
  assert.equal(queue.queue.length,1,'numeric samples must not introduce replay backlog');
  assert.equal(queue.queue[0].message.payload.devices[0].motionInputs.feed.timestamp,5999);
  assert.equal(queue.queue[0].message.payload.devices[0].motionInputs.feed.value,4999/5000);
  assert.ok(queue.bytes+queue.inflightBytes<queue.options.maxBytes);
  console.log('PASS 5000 numeric samples remain one exact latest snapshot ('+Math.round(performance.now()-start)+' ms fixture processing, not PLC latency)');
 }finally{queue.dispose();}
}
{
 const socket=new HeldSocket(),queue=new WsOutboundQueue(socket,{maxMessages:32});
 try{
  queue.enqueue({type:'welcome'});
  for(let i=0;i<100;i++){if(!queue.enqueue(source(i%2===0,1000+i)))break;}
  assert.ok(queue.closed,'discrete edge overload must stop/resync rather than grow an unbounded delayed replay');
  assert.equal(socket.closeCode,1013);assert.equal(queue.queue.length,0);
  console.log('PASS mechanical edge overload is bounded and explicitly requests resync');
 }finally{queue.dispose();}
}
console.log('PASS '+fixtures.cases.length+' shared queue cases + 2 bounded-load checks');

