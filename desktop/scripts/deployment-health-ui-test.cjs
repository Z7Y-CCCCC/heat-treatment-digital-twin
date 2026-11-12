'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const elements = Object.fromEntries(['mode','form','error','remote','backendOrigin','connectionHealth','transport','displayLink','collection','healthNote','healthChecked','checkConnection','save'].map(id => [id, {
        value:'', textContent:'', dataset:{}, handlers:{}, addEventListener(type,callback){const previous=this.handlers[type];this.handlers[type]=previous?event=>{previous(event);return callback(event);}:callback;}
    }]));
    const timers=[], calls=[], windows={}; let saves=0;
    const context = vm.createContext({document:{getElementById:id=>elements[id]}, window:{
        addEventListener:(type,handler)=>{windows[type]=handler;}, deployment:{
            load:async()=>({config:{mode:'client',backendOrigin:'http://127.0.0.1:3001'}}),
            probe:value=>new Promise((resolve,reject)=>calls.push({value,resolve,reject})), save:async()=>{saves++;return {success:true};}
        }}, Date, console,
        setTimeout:(callback,ms)=>{const timer={callback,ms,cleared:false};timers.push(timer);return timer;},
        clearTimeout:timer=>{if(timer)timer.cleared=true;}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/deployment.js'),'utf8'),context);
    return {elements,timers,calls,windows,get saves(){return saves;}};
}
const online = {state:'online',transport:'服务接口可达',collection:'采集正常',display:{status:'online',connectedClients:2,sceneReadyClients:1,ageMs:500},checkedAt:Date.now(),latencyMs:20};
test('loaded config auto-probes and polls, while HTTP and display status remain separate; no automatic save', async () => {
    const f=fixture();await tick();assert.equal(f.calls.length,1);f.calls[0].resolve(online);await tick();
    assert.equal(f.elements.transport.textContent,'服务接口可达');assert.match(f.elements.displayLink.textContent,/2 个在线.*场景就绪/);
    assert.equal(f.timers.at(-1).ms,3000);f.timers.at(-1).callback();await tick();
    f.calls[1].resolve({...online,display:{status:'offline',ageMs:16000}});await tick();
    assert.equal(f.elements.displayLink.textContent,'未连接大屏');assert.equal(f.elements.collection.textContent,'采集正常');assert.equal(f.saves,0);
});
test('changing address clears old healthy details, debounces and discards out-of-order probe responses', async () => {
    const f=fixture();await tick();f.calls[0].resolve(online);await tick();
    f.elements.checkConnection.handlers.click();await tick();const old=f.calls[1];
    f.elements.backendOrigin.value='http://127.0.0.1:4567';f.elements.backendOrigin.handlers.input();
    assert.equal(f.elements.connectionHealth.dataset.state,'checking');assert.equal(f.elements.collection.textContent,'等待检测');
    assert.doesNotMatch(f.elements.displayLink.textContent,/在线/);assert.doesNotMatch(f.elements.healthNote.textContent,/最近大屏通信/);
    const debounce=f.timers.at(-1);assert.equal(debounce.ms,400);debounce.callback();await tick();
    assert.equal(f.calls[2].value.backendOrigin,'http://127.0.0.1:4567');
    f.calls[2].resolve({state:'offline',transport:'采集服务不可达',collection:'未知',display:null});await tick();
    old.resolve(online);await tick();assert.equal(f.elements.connectionHealth.dataset.state,'offline');assert.equal(f.elements.transport.textContent,'采集服务不可达');
});
test('probe errors reset normal state; mode change is read-only; pagehide stops timers and ignores pending replies', async () => {
    const f=fixture();await tick();f.calls[0].resolve(online);await tick();
    f.elements.checkConnection.handlers.click();await tick();f.calls[1].reject(Error('fixture'));await tick();
    assert.equal(f.elements.connectionHealth.dataset.state,'offline');assert.equal(f.elements.displayLink.textContent,'状态未知');
    f.elements.mode.value='display';f.elements.mode.handlers.change();assert.equal(f.elements.remote.hidden,true);assert.equal(f.elements.backendOrigin.required,false);
    f.timers.at(-1).callback();await tick();assert.equal(f.calls.at(-1).value.mode,'display');
    f.windows.pagehide();f.calls.at(-1).resolve(online);await tick();assert.notEqual(f.elements.connectionHealth.dataset.state,'online');
    assert.ok(f.timers.every(timer=>timer.cleared || timer.ms===400),'all active poll timers disposed');assert.equal(f.saves,0);
});
test('unknown future/malformed display status is unknown, not a fabricated disconnection; content is rendered as text', async () => {
    const f=fixture();await tick();f.calls[0].resolve({...online,collection:'<script>fixture</script>',display:{status:'unknown',ageMs:null}});await tick();
    assert.equal(f.elements.displayLink.textContent,'状态未知');assert.equal(f.elements.collection.textContent,'<script>fixture</script>');
    const html=fs.readFileSync(path.join(__dirname,'../assets/deployment.html'),'utf8');assert.match(html,/id="checkConnection" type="button"/);
    const preload=fs.readFileSync(path.join(__dirname,'../deployment-preload.cjs'),'utf8');assert.match(preload,/deployment:probe/);
    assert.ok(require('../package.json').build.files.includes('connectionHealth.cjs'));
});
