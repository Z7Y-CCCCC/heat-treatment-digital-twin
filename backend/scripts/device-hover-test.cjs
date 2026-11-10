const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const WebSocket = require('ws');
const WsServer = require('../services/wsServer');
const { normalizeDeviceHover } = require('../utils/deviceHover');
const { WsOutboundQueue } = require('../utils/wsOutboundQueue');
const context = { factoryId:'pit',viewId:'workshop_overview',viewMode:'workshop',sceneReady:true,workshopId:'w' };
const hover = { factoryId:'pit',viewId:'workshop_overview',hoveredDeviceId:'one',deviceHoverPointer:{x:.4,y:.3,visible:true} };
async function until(predicate) {
    const deadline=Date.now()+5000;
    while(!predicate()){assert.ok(Date.now()<deadline,'hover relay timed out');await new Promise(resolve=>setTimeout(resolve,5));}
}
async function main() {
    for(const key of ['factoryId','viewId'])assert.equal(normalizeDeviceHover({...hover,[key]:'old'},context),null);
    assert.equal(normalizeDeviceHover(hover,{...context,viewMode:'device'}),null);
    assert.equal(normalizeDeviceHover({...hover,hoveredDeviceId:'x'.repeat(129)},context),null);
    assert.equal(normalizeDeviceHover(hover,{...context,sceneReady:false}),null);
    assert.equal(normalizeDeviceHover({...hover,deviceHoverPointer:{x:NaN,y:.5,visible:true}},context).hoveredDeviceId,'');
    class HeldSocket extends EventEmitter {
        readyState=1;bufferedAmount=0;sent=[];callbacks=[];
        send(text,callback){this.sent.push(JSON.parse(text));this.callbacks.push(callback)}
        close(){this.readyState=2}terminate(){this.readyState=3}
    }
    const held=new HeldSocket(),queue=new WsOutboundQueue(held);
    queue.enqueue({type:'welcome'});
    for(let i=0;i<100;i++)queue.enqueue({type:'device_hover_changed',payload:{index:i}});
    assert.equal(queue.queue.length,1);
    assert.equal(queue.queue[0].message.payload.index,99);
    queue.enqueue({type:'dashboard_context_changed',payload:{viewId:'device_xray'}});
    queue.enqueue({type:'device_hover_changed',payload:{index:100}});
    assert.equal(queue.queue.length,3,'view changes must remain barriers between latest-only hover samples');
    while(held.callbacks.length)held.callbacks.shift()();
    assert.deepEqual(held.sent.map(m=>m.type),['welcome','device_hover_changed','dashboard_context_changed','device_hover_changed']);
    queue.dispose();
    console.log('PASS stale scope rejection, latest-only hover queue and navigation barriers');
    {
        const socket=new HeldSocket(),outbound=new WsOutboundQueue(socket,{maxMessages:8});
        outbound.enqueue({type:'welcome'});
        for(let index=0;index<120;index++){
            assert.equal(outbound.enqueue({type:'scene_projection',payload:{seq:index}}),true);
            assert.equal(outbound.enqueue({type:'device_hover_changed',payload:{index}}),true);
            assert.equal(outbound.enqueue({type:'inspection_hover_changed',payload:{index}}),true);
        }
        assert.equal(outbound.queue.length,3,'interleaved snapshots stay bounded, not a cursor-history backlog');
        assert.equal(outbound.queue.filter(entry=>entry.kind==='device-hover').length,1);
        assert.equal(outbound.queue.filter(entry=>entry.kind==='hover').length,1);
        assert.equal(outbound.bytes,outbound.queue.reduce((total,entry)=>total+entry.size,0),'discarded cursor byte accounting is exact');
        while(socket.callbacks.length)socket.callbacks.shift()();
        assert.deepEqual(socket.sent.map(message=>message.type),['welcome','scene_projection','device_hover_changed','inspection_hover_changed']);
        assert.equal(socket.sent.at(-1).payload.index,119);
        outbound.dispose();
    }
    {
        const socket=new HeldSocket(),outbound=new WsOutboundQueue(socket);
        outbound.enqueue({type:'welcome'});
        const frame=index=>({type:'realtime_frame',payload:{devices:[{furnace_id:'one',status:{door:index%2===0},analog:{position:index}}]}});
        for(let index=0;index<60;index++){
            outbound.enqueue(frame(index));
            outbound.enqueue({type:'device_hover_changed',payload:{index}});
        }
        assert.equal(outbound.queue.filter(entry=>entry.kind==='device-hover').length,1);
        assert.equal(outbound.queue.filter(entry=>entry.kind==='realtime').length,60,'coalescing cursor snapshots must not drop reliable motion edges');
        outbound.enqueue({type:'dashboard_context_changed',payload:{viewId:'device_xray'}});
        outbound.enqueue({type:'device_hover_changed',payload:{index:60}});
        outbound.enqueue({type:'realtime_frame',payload:{devices:[{furnace_id:'one',quality:{status:{door:'bad'}}}]}});
        outbound.enqueue({type:'device_hover_changed',payload:{index:61}});
        outbound.enqueue({type:'scene_projection',payload:{seq:61}});
        outbound.enqueue({type:'device_hover_changed',payload:{index:62}});
        assert.deepEqual(outbound.queue.filter(entry=>entry.kind==='device-hover').map(entry=>entry.message.payload.index),[59,60,62],
            'navigation and fault barriers preserve their separate hover segment');
        assert.equal(outbound.bytes,outbound.queue.reduce((total,entry)=>total+entry.size,0));
        while(socket.callbacks.length)socket.callbacks.shift()();
        assert.deepEqual(socket.sent.filter(message=>message.type==='realtime_frame'&&message.payload.devices[0].analog)
            .map(message=>message.payload.devices[0].analog.position),Array.from({length:60},(_,index)=>index));
        assert.deepEqual(socket.sent.filter(message=>message.type==='device_hover_changed').map(message=>message.payload.index),[59,60,62]);
        outbound.dispose();
    }
    console.log('PASS interleaved latest-only hover/projection, exact bytes, motion edges and navigation/fault barriers');
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
        for(let i=0;i<60;i++)native.send(JSON.stringify({type:'device_hover',payload:{...hover,deviceHoverPointer:{x:i/100,y:.3,visible:true}}}));
        await until(()=>events.some(e=>e.type==='device_hover_changed'&&e.payload.deviceHoverPointer.x===.59));
        const delivered=events.filter(e=>e.type==='device_hover_changed');
        assert.ok(Buffer.byteLength(JSON.stringify(delivered.at(-1)))<600,'hover must not resend the full part metadata');
        const count=delivered.length;
        web.send(JSON.stringify({type:'device_hover',payload:hover}));
        native.send(JSON.stringify({type:'device_hover',payload:{...hover,factoryId:'old'}}));
        await new Promise(resolve=>setTimeout(resolve,60));
        assert.equal(events.filter(e=>e.type==='device_hover_changed').length,count);
        native.send(JSON.stringify({type:'device_hover',payload:{...hover,hoveredDeviceId:'',deviceHoverPointer:{x:0,y:0,visible:false}}}));
        await until(()=>events.some(e=>e.type==='device_hover_changed'&&e.payload.hoveredDeviceId===''));
        console.log('PASS real websocket hover sweep, compact payload, immediate leave and invalid-source rejection');
    } finally {native?.terminate();web?.terminate();hub.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1});
