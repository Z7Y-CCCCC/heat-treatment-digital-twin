import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const WsServer=require('../../backend/services/wsServer.js')
const WebSocket=require('../../backend/node_modules/ws')
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const frame=()=>({version:1,streamId:'stream',seq:1,sceneReady:true,camera:{position:[0,10,-10],forward:[0,0,1],up:[0,1,0],target:[0,0,0],fov:38,aspect:1.8,near:.1,far:600},devices:[{id:'A',matrix:identity,anchor:[0,3,0],visible:true}]})
async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('transport condition timed out')}

test('projection subscription reaches Unity and only subscribed web clients receive its validated frames',async t=>{
  const server=http.createServer(),broker=new WsServer(),clients=[]
  broker.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{clients.forEach(client=>client.socket.terminate());broker.close();await new Promise(resolve=>server.close(resolve))})
  async function connect(role){
    const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`),messages=[]
    socket.on('message',bytes=>messages.push(JSON.parse(bytes)))
    clients.push({socket,messages});await once(socket,'open');socket.send(JSON.stringify({type:'client_hello',role}));return {socket,messages}
  }
  const unity=await connect('unity'),preview=await connect('web'),ordinary=await connect('web')
  await until(()=>unity.messages.some(message=>message.type==='scene_projection_subscription' && !message.payload.enabled))
  preview.socket.send(JSON.stringify({type:'scene_projection_subscribe',enabled:true}))
  await until(()=>unity.messages.some(message=>message.type==='scene_projection_subscription' && message.payload.enabled))
  unity.socket.send(JSON.stringify({type:'scene_projection',payload:frame()}))
  await until(()=>preview.messages.some(message=>message.type==='scene_projection' && message.payload.seq===1))
  assert.equal(ordinary.messages.some(message=>message.type==='scene_projection'),false)
  ordinary.socket.send(JSON.stringify({type:'scene_projection',payload:{...frame(),seq:999}}))
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal(broker.sceneProjection.seq,1)
  unity.socket.terminate()
  await until(()=>preview.messages.some(message=>message.type==='scene_projection' && message.payload.available===false))
  assert.equal(broker.sceneProjection,null)
})

test('backpressure skips stale intermediate frames for a slow preview without affecting other peers',()=>{
  const broker=new WsServer(),received=[]
  const slow={clientRole:'web',sceneProjectionSubscribed:true,readyState:1,bufferedAmount:700000,send:()=>{throw new Error('must not queue')}}
  const fast={clientRole:'web',sceneProjectionSubscribed:true,readyState:1,bufferedAmount:0,send:data=>received.push(JSON.parse(data))}
  broker.clients.add(slow);broker.clients.add(fast)
  broker.broadcastProjection({seq:9})
  assert.equal(received.length,1);assert.equal(received[0].payload.seq,9)
})
