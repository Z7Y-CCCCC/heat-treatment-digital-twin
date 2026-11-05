// Production UI + real HTML audio, using only an owned disposable backend/profile.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const Database=require('../backend/node_modules/better-sqlite3');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,requireTestPath,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const root=path.resolve(__dirname,'..'),directory=createRunDirectory('voice-motion-ui'),checks=[],errors=[];
let server,browser,page;
const check=name=>{checks.push(name);console.log('PASS '+name)};
(async()=>{
 const infoFile=path.join(directory,'server.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:root,env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'isolated backend');
 const info=JSON.parse(fs.readFileSync(infoFile));requireTestPath(info.database);
 const db=new Database(info.database),line=db.prepare('SELECT l.*,w.factory_id FROM lines l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=(SELECT line_id FROM devices WHERE id=?)').get(info.devices[0]);
 const marker={preserve:'voice-motion-ui'};
 db.prepare('INSERT INTO devices(id,name,line_id,model_type,instance_config) VALUES(?,?,?,?,?)').run('qa_voice_cart','语音验收料车',line.id,'transfer_cart',JSON.stringify({role:'auxiliary',workshop_id:line.workshop_id,marker,movement:{enabled:false,valueMode:'range',valueMin:0,valueMax:100,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0}}}));
 const pointId=Number(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms) VALUES(?,?,?,?,?,?,?,?)').run('qa_voice_cart','position','当前位置','DB1.DBW200','WORD','analog','position',1000).lastInsertRowid);
 const voiceRule={id:'qa_alarm',enabled:true,trigger:'rising',mode:'tts',text:'设备测试播报',cooldown_ms:0};
 db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,voice_config) VALUES(?,?,?,?,?,?,?,?)').run(info.devices[0],'qa_voice_alarm','语音报警','DB1.DBX0.0','BOOL','status','qa_voice_alarm',JSON.stringify({rules:[voiceRule]}));
 db.prepare('INSERT INTO factories(id,name) VALUES(?,?)').run('voice_factory_b','独立工厂B');db.close();
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--mute-audio']});
 const context=await browser.newContext({viewport:{width:1600,height:1100}});
 await context.addInitScript(()=>{if(!localStorage.getItem('digital_twin_admin_ui_state_v1'))localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'mobile-devices'}))});
 page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 const motion=page.locator('.mobile-motion-page');await motion.getByRole('button',{name:'保存移动配置',exact:true}).waitFor();
 await motion.getByRole('combobox',{name:'选择设备（小车 / 辅助设备）',exact:true}).selectOption('qa_voice_cart');
 await motion.getByRole('checkbox',{name:'启用移动同步',exact:true}).check();
 const save=motion.getByRole('button',{name:'保存移动配置',exact:true});await save.click();
 await page.getByRole('alert').filter({hasText:'请先绑定'}).waitFor();assert.equal(await motion.locator('.motion-alert').count(),0);
 await page.getByRole('button',{name:'关闭消息',exact:true}).click();await save.click();await page.getByRole('alert').filter({hasText:'请先绑定'}).waitFor();
 check('movement validation errors appear in a top bubble, including repeated identical failures, never as an inline status strip');
 await motion.getByRole('combobox',{name:/PLC 当前工位编号点位/}).selectOption(String(pointId));
 await page.route('**/api/devices/qa_voice_cart/movement',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'隔离保存失败'})}));
 await save.click();await page.getByRole('alert').filter({hasText:'隔离保存失败'}).waitFor();assert.ok(await save.isEnabled());await page.unroute('**/api/devices/qa_voice_cart/movement');
 await save.click();const success=page.getByRole('status').filter({hasText:'移动配置已保存'});await success.waitFor();
 const box=await success.boundingBox();assert.ok(box.y<150&&box.x>300);assert.equal(await motion.locator('.motion-alert').count(),0);
 const detail=await(await page.request.get(info.origin+'/api/devices/qa_voice_cart')).json();assert.equal(detail.dataPoints.find(p=>p.id===pointId).sample_interval_ms,100);assert.deepEqual(JSON.parse(detail.instance_config).marker,marker);
 await page.screenshot({path:path.join(directory,'01-motion-save-toast.png'),fullPage:true});
 check('HTTP failures show error bubbles; retry saves the actual movement atomically, preserves unrelated config and shows a brief success bubble');

 await page.locator('.admin-nav button[title="点位映射"]').click();const capsule=page.getByRole('switch',{name:'当前工厂语音播报',exact:true});await capsule.waitFor();await waitUntil(async()=>await capsule.isEnabled(),5000,'voice state loaded');assert.equal(await capsule.getAttribute('aria-checked'),'true');
 await page.evaluate(origin=>{window.__voiceEvents=[];window.__voiceSocket=new WebSocket(origin.replace('http','ws')+'/ws');window.__voiceSocket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='factory_voice_changed')window.__voiceEvents.push(m.payload)}},info.origin);
 await page.waitForFunction(()=>window.__voiceSocket.readyState===1);await capsule.click();await waitUntil(async()=>await capsule.getAttribute('aria-checked')==='false',5000,'voice off');
 await page.waitForFunction(()=>window.__voiceEvents.some(e=>e.enabled===false));const event=await page.evaluate(()=>window.__voiceEvents.at(-1));assert.equal(event.factoryId,line.factory_id);
 const state=async factoryId=>(await(await page.request.get(info.origin+'/api/settings/voice',{headers:{'X-Factory-ID':factoryId}})).json());
 assert.equal((await state(line.factory_id)).enabled,false);assert.equal((await state('voice_factory_b')).enabled,true);
 await page.screenshot({path:path.join(directory,'02-factory-voice-capsule.png'),fullPage:true});await page.reload();await waitUntil(async()=>await capsule.isEnabled(),5000,'voice state reloaded');assert.equal(await capsule.getAttribute('aria-checked'),'false');
 await page.route('**/api/settings/voice',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'语音开关测试失败'})}):route.continue());
 await capsule.click();await page.getByRole('alert').filter({hasText:'语音开关测试失败'}).waitFor();assert.equal(await capsule.getAttribute('aria-checked'),'false');await page.unroute('**/api/settings/voice');
 await capsule.click();await waitUntil(async()=>await capsule.getAttribute('aria-checked')==='true',5000,'voice enabled');
 check('factory capsule really persists, broadcasts immediately, survives reload, isolates the other factory and retains its old state after a failed save');

 // Verify the shipped Unity-overlay route handles PLC point speech, not only designer preview.
 const overlay=await context.newPage();overlay.on('pageerror',e=>errors.push(e.message));
 await overlay.addInitScript(()=>{
  window.__spoken=[];window.__speechCancel=0;window.__qaSockets=[];
  const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__qaSockets.push(this)}};
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[],cancel(){window.__speechCancel++},speak(u){window.__spoken.push(u.text);u.onstart?.();queueMicrotask(()=>u.onend?.())}},configurable:true});
  window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
 });
 await overlay.goto(info.origin+'/overlay?factoryId='+encodeURIComponent(line.factory_id));await overlay.locator('.dashboard-overlay-root').waitFor();
 await overlay.waitForFunction(()=>window.__qaSockets.some(s=>s.readyState===1));
 const send=async value=>overlay.evaluate(({value,id})=>{const socket=window.__qaSockets.find(s=>s.readyState===1);socket.onmessage({data:JSON.stringify({type:'realtime_frame',payload:{devices:[{furnace_id:id,status:{qa_voice_alarm:value},quality:{status:{qa_voice_alarm:'good'}}}]}})})},{value,id:info.devices[0]});
 await send(0);await send(1);await overlay.waitForFunction(()=>window.__spoken.includes('设备测试播报'));
 await capsule.click();await waitUntil(async()=>await capsule.getAttribute('aria-checked')==='false',5000,'disable while overlay online');
 const oldCount=await overlay.evaluate(()=>window.__spoken.length);await send(0);await send(1);await new Promise(r=>setTimeout(r,150));assert.equal(await overlay.evaluate(()=>window.__spoken.length),oldCount);
 await capsule.click();await waitUntil(async()=>await capsule.getAttribute('aria-checked')==='true',5000,'re-enable live voice');await send(0);await send(1);await overlay.waitForFunction(n=>window.__spoken.length>n,oldCount);
 check('actual Unity-overlay page announces point transitions from its real DataStore handler, mutes immediately through WebSocket and resumes without a scene reload');

 // Real media-element timing, not a stubbed audio.play(). Output is muted to avoid disturbing the operator.
 const bench=await context.newPage();bench.on('pageerror',e=>errors.push(e.message));
 const runtimeDir=path.join(root,'frontend/src/runtime');
 await bench.route('**/__voice/*.js',route=>{const name=path.basename(new URL(route.request().url()).pathname);if(!['VoiceAnnouncer.js','backendEndpoint.js','factoryVoice.js'].includes(name))return route.abort();return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(runtimeDir,name),'utf8')})});
 const wav=Buffer.alloc(44+1600);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
 await bench.route('**/__voice/sample.wav',route=>route.fulfill({contentType:'audio/wav',body:wav}));
 await bench.route('**/__voice/bench',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Owned voice latency test</title>'}));await bench.goto(info.origin+'/__voice/bench');
 const timing=await bench.evaluate(async()=>{
  const {createVoiceAnnouncer}=await import('/__voice/VoiceAnnouncer.js');const a=createVoiceAnnouncer({now:()=>performance.now()}),samples=[];
  for(let i=0;i<24;i++){await a.preview({mode:'file',audio_url:'/__voice/sample.wav',text:'test'});samples.push(a.stats.lastStartDelayMs)}
  a.dispose();const sorted=[...samples].sort((x,y)=>x-y);return{samples,coldMs:samples[0],p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),scope:'HTML audio play request to playing event; loopback WAV; no PLC acquisition or hardware speaker latency'};
 });
 assert.ok(timing.p95Ms<500,'local cached audio startup must not add a long artificial delay');
 check('24 real, muted HTML-audio playbacks measure cold/warm startup latency, with bounded resource reuse');
 await bench.route('**/__voice/never.wav',route=>{setTimeout(()=>route.abort().catch(()=>{}),3500)});
 const recovery=await bench.evaluate(async()=>{
  const {createVoiceAnnouncer}=await import('/__voice/VoiceAnnouncer.js');let spoken=0;
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>[],cancel(){},speak(u){spoken++;u.onstart?.();queueMicrotask(()=>u.onend?.())}}});window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
  const a=createVoiceAnnouncer(),start=performance.now();await a.preview({mode:'file',audio_url:'/__voice/never.wav',text:'fallback'});const stalledFileMs=performance.now()-start;
  const next=performance.now();await a.preview({mode:'tts',text:'next'});const nextRuleMs=performance.now()-next;a.dispose();return{stalledFileMs,nextRuleMs,ttsCalls:spoken}
 });
 assert.equal(recovery.ttsCalls,2);assert.ok(recovery.stalledFileMs>=1400&&recovery.stalledFileMs<2600);assert.ok(recovery.nextRuleMs<500);
 check('a real stalled audio request falls back near the 1.5-second startup budget and does not block the next announcement');
 assert.deepEqual(errors,[]);const result={success:true,checks,timing,recovery,browserErrors:errors,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
