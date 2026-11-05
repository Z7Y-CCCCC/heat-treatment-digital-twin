import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceAnnouncer, normalizeVoiceRule, shouldTriggerVoiceRule } from '../src/runtime/VoiceAnnouncer.js'
import { createFactoryVoiceController } from '../src/runtime/factoryVoice.js'
import { installBrowser, settle, deferred } from './helpers.mjs'
import { readFile } from 'node:fs/promises'
const rule = (patch = {}) => normalizeVoiceRule({ id: 'alarm', trigger: 'rising', mode: 'tts', text: '报警 {值}', cooldown_ms: 0, ...patch })
const device = (id = 'a', patch = {}) => ({ id, name: `设备${id}`, dataPoints: [{ id: 1, name: 'alarm', category: 'status', voice_config: { rules: [rule(patch)] } }] })
const frame = (value, quality = 'good', id = 'a') => ({ furnace_id: id, status: { alarm: value }, quality: { status: { alarm: quality } } })

test('trigger directions and threshold crossings reject missing samples instead of treating them as zero', () => {
    for (const [trigger, before, after] of [['rising',0,1],['falling',1,0],['above',9,10],['below',11,10],['equals',9,10],['change',1,2]]) {
        const r=rule({trigger,threshold:10});assert.equal(shouldTriggerVoiceRule(r,before,after,true),true)
        assert.equal(shouldTriggerVoiceRule(r,after,after,true),false)
    }
    assert.equal(shouldTriggerVoiceRule(rule({trigger:'above',threshold:1}),null,2,true),false)
})

test('factory master switches immediately stop speech, isolate factories, survive stale config and do not suppress new alarms after unmuting', async () => {
    const c=createFactoryVoiceController(), calls=[];c.configure({factoryId:'A',voiceDevices:[device()],settings:{voice_enabled:'true'}})
    c.announcer._playItem=async item=>calls.push(item)
    c.handleDeviceData(frame(0));c.handleDeviceData(frame(1,'good','other'));c.handleDeviceData(frame(1));await settle();assert.equal(calls.length,1)
    assert.equal(c.handleMessage({type:'factory_voice_changed',payload:{factoryId:'B',enabled:false}}),true);assert.equal(c.announcer.muted,false)
    c.handleMessage({type:'factory_voice_changed',payload:{factoryId:'A',enabled:false}});assert.equal(c.announcer.muted,true)
    c.configure({factoryId:'A',voiceDevices:[device()],settings:{voice_enabled:'true'}});assert.equal(c.announcer.muted,true,'an older in-flight config response cannot re-enable voice')
    c.handleDeviceData(frame(0));c.handleDeviceData(frame(1));await settle();assert.equal(calls.length,1)
    c.handleMessage({type:'factory_voice_changed',payload:{factoryId:'A',enabled:true}});c.handleDeviceData(frame(0));c.handleDeviceData(frame(1));await settle();assert.equal(calls.length,2)
    const old=c.announcer;c.configure({factoryId:'B',voiceDevices:[device('b')],settings:{voice_enabled:'false'}});assert.equal(old.disposed,true);assert.equal(c.announcer.muted,true);c.dispose()
})

test('bad/stale frames cannot trigger speech and recovery establishes a baseline, including announce-on-start rules', async () => {
    const a=createVoiceAnnouncer(), calls=[];a.setFactoryDevices([device('a',{announce_on_start:true})]);a._playItem=async i=>calls.push(i)
    a.handleDeviceData(frame(0));a.handleDeviceData(frame(null,'bad'));a.handleDeviceData(frame(1));await settle();assert.equal(calls.length,0)
    a.handleDeviceData(frame(0));a.handleDeviceData(frame(1));await settle();assert.equal(calls.length,1)
    a.handleDeviceData({...frame(0),online:false});a.handleDeviceData(frame(1));await settle();assert.equal(calls.length,1);a.dispose()
})

test('active-key deduplication, newest queued context, bounded backlog and stale expiry prevent delayed repeated announcements', async () => {
    let now=0;const gate=deferred(),calls=[],a=createVoiceAnnouncer({now:()=>now,maxQueue:2,maxQueueAgeMs:100})
    a._playItem=async item=>{calls.push(item);if(item.key==='active')await gate.promise}
    const add=(key,value=0)=>a.enqueue({key,rule:rule(),context:{value}})
    add('active');assert.equal(add('active'),false);add('old');add('new',1);assert.equal(add('new',2),false);assert.equal(a.queue.at(-1).context.value,2)
    add('last');assert.equal(a.queue.length,2);assert.equal(a.pendingKeys.has('old'),false)
    now=101;gate.resolve();await settle();assert.deepEqual(calls.map(i=>i.key),['active']);assert.equal(a.pendingKeys.size,0);assert.equal(a.stats.dropped,3);a.dispose()
})

test('autoplay-blocked audio waits for a real unlock, then retries once rather than silently losing the alert', async t => {
    installBrowser(t);let count=0;const a=createVoiceAnnouncer()
    a._playItem=async()=>{if(++count===1)throw Object.assign(Error('gesture'),{name:'NotAllowedError'})}
    a.enqueue({key:'alert',rule:rule(),context:{}});await settle();assert.equal(a.blocked,true);assert.equal(a.queue.length,1)
    a.unlock();await settle();assert.equal(count,2);assert.equal(a.queue.length,0);assert.equal(a.pendingKeys.size,0);a.dispose()
})

test('audio cache is bounded and a failed file falls back promptly without blocking the next rule', async t => {
    const {browser,replace}=installBrowser(t);let created=0,speech=0
    replace('Audio',class {constructor(){created++}pause(){}removeAttribute(){}load(){}play(){return Promise.reject(Error('bad file'))}})
    replace('SpeechSynthesisUtterance',class {constructor(text){this.text=text}})
    browser.speechSynthesis={getVoices:()=>[],cancel(){},speak(u){speech++;u.onstart?.();queueMicrotask(()=>u.onend?.())}}
    const a=createVoiceAnnouncer();for(let i=0;i<10;i++)a._cachedAudio('/'+i,true);assert.equal(created,4)
    await a.preview(rule({mode:'file',audio_url:'/bad.wav'}));assert.equal(speech,1);assert.ok(a.audioCache.size<=4)
    await a.preview(rule());assert.equal(speech,2);a.dispose()
})

test('stale active audio is cancelled without speaking a TTS fallback for an invalid sample', async t => {
    const {browser,replace}=installBrowser(t);let speech=0,active
    replace('Audio',class{constructor(){active=this}play(){this.onplaying?.();return Promise.resolve()}pause(){}removeAttribute(){}load(){}})
    browser.speechSynthesis={getVoices:()=>[],speak(){speech++},cancel(){}}
    const a=createVoiceAnnouncer();a.setFactoryDevices([device('a',{mode:'file',audio_url:'/uploads/audio/a.wav'})]);a.handleDeviceData(frame(0));a.handleDeviceData(frame(1));assert.ok(active.onended)
    a.handleDeviceData(frame(null,'bad'));await settle();assert.equal(speech,0);assert.equal(a.playing,false);a.dispose()
})

test('a silent/stalled file times out quickly, falls back to speech and leaves the next announcement usable', async t => {
    const {browser,replace}=installBrowser(t);let speech=0
    replace('Audio',class {play(){return new Promise(()=>{})}pause(){}removeAttribute(){}load(){}})
    replace('SpeechSynthesisUtterance',class {constructor(text){this.text=text}})
    browser.speechSynthesis={getVoices:()=>[],cancel(){},speak(u){speech++;u.onstart?.();queueMicrotask(()=>u.onend?.())}}
    const a=createVoiceAnnouncer({startTimeoutMs:25}), began=Date.now()
    await a.preview(rule({mode:'file',audio_url:'/stall.wav'}));assert.equal(speech,1);assert.ok(Date.now()-began<500)
    await a.preview(rule());assert.equal(speech,2);a.dispose()
})

test('unchanged point metadata reuses compiled voice rules instead of parsing every PLC frame', () => {
    const a=createVoiceAnnouncer(), data={...frame(0),pointMeta:{'status.alarm':{id:1,voice_config:JSON.stringify({rules:[rule()]})}}}
    a.updateDefinitionsFromFrame(data);const before=a.definitionsByDevice.get('a')
    for(let i=0;i<100;i++)a.updateDefinitionsFromFrame(structuredClone(data))
    assert.equal(a.definitionsByDevice.get('a'),before);a.dispose()
})

test('native overlay, maps and street views wire the shared factory voice engine and keep point previews separate', async () => {
    for(const name of ['DashboardOverlay','GroupOverview','FactoryDrilldown']) {
        const source=await readFile(new URL(`../src/views/${name}.vue`,import.meta.url),'utf8')
        assert.match(source,/setDeviceDataHandler\([^\n]*factoryVoice.handleDeviceData/)
        assert.match(source,/factoryVoice.handleMessage\(message\)/);assert.match(source,/factoryVoice.dispose\(\)/)
    }
    const host=await readFile(new URL('../../native-admin-host/AdminPanelForm.cs',import.meta.url),'utf8')
    assert.ok(host.includes('--autoplay-policy=no-user-gesture-required'))
    const motion=await readFile(new URL('../src/views/admin/components/MobileDeviceMotion.vue',import.meta.url),'utf8')
    assert.match(motion,/<AdminNotice/);assert.doesNotMatch(motion,/<div v-if="(?:message|errorMessage)" class="motion-alert/)
})

test('dispose stops an active audio file, clears its handlers and prevents TTS fallback', async t => {
    const { browser, replace } = installBrowser(t)
    const files = []
    let ttsCalls = 0
    browser.speechSynthesis = { speak: () => { ttsCalls += 1 }, getVoices: () => [], cancel() {} }
    replace('Audio', class {
        constructor(url) { this.url = url; files.push(this) }
        play() { return Promise.resolve() }
        pause() { this.paused = true }
        removeAttribute(name) { this.removed = name }
    })
    const announcer = createVoiceAnnouncer()
    const playback = announcer.preview({ mode: 'file', audio_url: '/uploads/alarm.wav', text: 'fallback' })
    assert.equal(files.length, 1)
    announcer.dispose()
    await playback
    assert.equal(files[0].paused, true)
    assert.equal(files[0].onended, null)
    assert.equal(files[0].onerror, null)
    assert.equal(files[0].removed, 'src')
    assert.equal(announcer.playbackCancels.size, 0)
    assert.equal(ttsCalls, 0)
})

test('muting stops active system speech and settles its promise immediately', async t => {
    const { browser, replace } = installBrowser(t)
    let cancellations = 0
    browser.speechSynthesis = { speak() {}, getVoices: () => [], cancel: () => { cancellations += 1 } }
    replace('SpeechSynthesisUtterance', class { constructor(text) { this.text = text } })
    const announcer = createVoiceAnnouncer()
    const playback = announcer.preview({ mode: 'tts', text: 'alarm' })
    const rejection = assert.rejects(playback, /语音播放已停止/)
    announcer.setMuted(true)
    await rejection
    assert.equal(cancellations, 1)
    assert.equal(announcer.playbackCancels.size, 0)
    announcer.dispose()
})
