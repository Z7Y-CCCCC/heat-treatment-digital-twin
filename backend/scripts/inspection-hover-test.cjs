const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const WebSocket = require('ws');
const WsServer = require('../services/wsServer');
const { normalizeInspectionHover } = require('../utils/inspectionHover');
const { WsOutboundQueue } = require('../utils/wsOutboundQueue');
const context = { factoryId:'pit',deviceId:'one',viewId:'device_detail',viewMode:'device',sceneReady:true,
    inspectionEnabled:true,inspectionStage:'solid',inspectionParts:[{id:'shell',anchor:{x:.5,y:.5,visible:true}}] };
const hover = { factoryId:'pit',deviceId:'one',viewId:'device_detail',inspectionStage:'solid',inspectionHoveredPartId:'shell',inspectionHoverPointer:{x:.4,y:.3,visible:true} };
async function until(predicate) {
    const deadline=Date.now()+5000;
    while(!predicate()){assert.ok(Date.now()<deadline,'hover relay timed out');await new Promise(resolve=>setTimeout(resolve,5));}
}
async function main() {
    for(const key of ['factoryId','deviceId','viewId','inspectionStage'])assert.equal(normalizeInspectionHover({...hover,[key]:'old'},context),null);
    assert.equal(normalizeInspectionHover({...hover,inspectionHoveredPartId:'missing'},context),null);
    assert.equal(normalizeInspectionHover(hover,{...context,sceneReady:false}),null);
    assert.equal(normalizeInspectionHover({...hover,inspectionHoverPointer:{x:NaN,y:.5,visible:true}},context).inspectionHoveredPartId,'');
    class HeldSocket extends EventEmitter {
        readyState=1;bufferedAmount=0;sent=[];callbacks=[];
        send(text,callback){this.sent.push(JSON.parse(text));this.callbacks.push(callback)}
        close(){this.readyState=2}terminate(){this.readyState=3}
    }
    const held=new HeldSocket(),queue=new WsOutboundQueue(held);
    queue.enqueue({type:'welcome'});
    for(let i=0;i<100;i++)queue.enqueue({type:'inspection_hover_changed',payload:{index:i}});
    assert.equal(queue.queue.length,1);
    assert.equal(queue.queue[0].message.payload.index,99);
    queue.enqueue({type:'dashboard_context_changed',payload:{viewId:'device_xray'}});
    queue.enqueue({type:'inspection_hover_changed',payload:{index:100}});
    assert.equal(queue.queue.length,3,'view changes must remain barriers between latest-only hover samples');
    while(held.callbacks.length)held.callbacks.shift()();
    assert.deepEqual(held.sent.map(m=>m.type),['welcome','inspection_hover_changed','dashboard_context_changed','inspection_hover_changed']);
    queue.dispose();
    console.log('PASS stale scope rejection, latest-only hover queue and navigation barriers');
    const server=http.createServer(),hub=new WsServer();hub.attach(server);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`ws://127.0.0.1:${server.address().port}/ws`;
    let native,web;
    try {
        native=new WebSocket(url);web=new WebSocket(url);
        const events=[];web.on('message',raw=>events.push(JSON.parse(String(raw))));
        await Promise.all([once(native,'open'),once(web,'open')]);
        native.send(JSON.stringify({type:'client_hello',role:'unity'}));
        web.send(JSON.stringify({type:'client_hello',role:'web'}));
        native.send(JSON.stringify({type:'dashboard_context',payload:context}));
        await until(()=>events.some(e=>e.type==='dashboard_context_changed'));
        for(let i=0;i<60;i++)native.send(JSON.stringify({type:'inspection_hover',payload:{...hover,inspectionHoverPointer:{x:i/100,y:.3,visible:true}}}));
        await until(()=>events.some(e=>e.type==='inspection_hover_changed'&&e.payload.inspectionHoverPointer.x===.59));
        const delivered=events.filter(e=>e.type==='inspection_hover_changed');
        assert.ok(Buffer.byteLength(JSON.stringify(delivered.at(-1)))<600,'hover must not resend the full part metadata');
        const count=delivered.length;
        web.send(JSON.stringify({type:'inspection_hover',payload:hover}));
        native.send(JSON.stringify({type:'inspection_hover',payload:{...hover,deviceId:'old'}}));
        await new Promise(resolve=>setTimeout(resolve,60));
        assert.equal(events.filter(e=>e.type==='inspection_hover_changed').length,count);
        native.send(JSON.stringify({type:'inspection_hover',payload:{...hover,inspectionHoveredPartId:'',inspectionHoverPointer:{x:0,y:0,visible:false}}}));
        await until(()=>events.some(e=>e.type==='inspection_hover_changed'&&e.payload.inspectionHoveredPartId===''));
        console.log('PASS real websocket hover sweep, compact payload, immediate leave and invalid-source rejection');
    } finally {native?.terminate();web?.terminate();hub.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1});
