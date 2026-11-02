import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { computed, createRenderer, h, reactive } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { deferred, installBrowser, settle } from './helpers.mjs'

const session=reactive({ready:true,authenticated:true,displayAuthenticated:true,serviceUnavailable:false,accountSlotId:'main',user:{id:'owner'},permissions:{view:true,launch:true}})
let issueTicket=async()=> 'owned-ticket',tracking=0
test.mock.module('../src/runtime/adminSession.js',{namedExports:{adminSession:session,issueNativeSessionTicket:(...args)=>issueTicket(...args),logoutCurrentAdminAccount:async()=>{},refreshAdminSession:async()=>{},startAdminSessionTracking:()=>{tracking++},stopAdminSessionTracking:()=>{tracking--}}})
const file=new URL('../src/RootApp.vue',import.meta.url),{descriptor}=parse(await readFile(file,'utf8'))
let source=compileScript(descriptor,{id:'root-handoff'}).content
for(const match of [...source.matchAll(/from\s+(['"])([^'"]+)\1/g)])source=source.replace(match[0],`from ${JSON.stringify(match[2].endsWith('.vue')?'data:text/javascript,export default {}':match[2].startsWith('.')?new URL(match[2],file).href:import.meta.resolve(match[2]))}`)
const {default:Root}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);Root.render=()=>null
async function fixture(t,issue,initial={},surface='admin'){
    const environment=installBrowser(t),messages=[],routes=[]
    document.documentElement={style:{backgroundColor:''}};document.body={style:{backgroundColor:''}}
    environment.replace('innerWidth',1440);environment.replace('innerHeight',900)
    window.chrome={webview:{postMessage:message=>messages.push(message)}}
    // Handoff retries use short logical delays, not an OS window or real clock.
    t.mock.method(window,'setTimeout',callback=>{queueMicrotask(callback);return {}})
    Object.assign(session,{ready:true,authenticated:true,displayAuthenticated:true,serviceUnavailable:false,sessionRevision:0,accountSlotId:'main',user:{id:'owner'},permissions:{view:true,launch:true}},initial)
    issueTicket=issue;tracking=0
    const route=reactive({path:surface==='overlay'?'/overlay':'/admin',fullPath:`/admin?embedded=unity&surface=${surface}`,query:{embedded:'unity',surface}})
    const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
    const app=renderer.createApp({render:()=>h(Root)})
    app.provide(routerKey,{replace:location=>routes.push(location)});app.provide(routeLocationKey,route);app.mount({})
    environment.beforeRestore(()=>app.unmount())
    await settle();await settle();return {app,messages,route,routes}
}

test('a failed initial native handoff retries when the service recovers without switching accounts',async t=>{
    let offline=true,calls=0
    const f=await fixture(t,async()=>{calls++;if(offline){session.serviceUnavailable=true;throw new Error('owned outage')}return 'recovered-ticket'})
    assert.equal(f.messages.some(m=>m.action==='sync_unity_session'),false)
    offline=false;session.serviceUnavailable=false;await settle();await settle()
    assert.ok(calls>=2);assert.equal(f.messages.filter(m=>m.action==='sync_unity_session').at(-1)?.ticket,'recovered-ticket')
    assert.equal(f.messages.some(m=>m.action==='clear_unity_session'),false)
})

test('unmounting while a native ticket is pending cannot hand off to a closed surface',async t=>{
    const pending=deferred(),f=await fixture(t,()=>pending.promise)
    f.app.unmount();pending.resolve('late-ticket');await settle()
    assert.equal(f.messages.some(m=>m.action==='sync_unity_session'),false)
})

test('permission polling and admin locking preserve the existing Unity session, but logout clears it',async t=>{
    const f=await fixture(t,async()=> 'valid-ticket')
    assert.equal(f.messages.filter(m=>m.action==='sync_unity_session').length,1)
    session.permissions={view:true,launch:true};session.authenticated=false;await settle()
    assert.equal(f.messages.filter(m=>m.action==='sync_unity_session').length,1)
    assert.equal(f.messages.some(m=>m.action==='clear_unity_session'),false)
    session.displayAuthenticated=false;await settle()
    assert.equal(f.messages.filter(m=>m.action==='clear_unity_session').length,1)
})

test('a late A-account ticket cannot replace the newer B-account handoff',async t=>{
    const a=deferred(),f=await fixture(t,()=>session.user.id==='owner'?a.promise:Promise.resolve('b-ticket'))
    session.accountSlotId='second';session.user={id:'customer'};await settle();a.resolve('a-ticket');await settle()
    assert.deepEqual(f.messages.filter(m=>m.action==='sync_unity_session').map(m=>m.ticket),['b-ticket'])
})

test('session broadcasts stay subscribed across admin and display routes and stop with the root',async t=>{
    const f=await fixture(t,async()=> 'valid-ticket')
    assert.equal(tracking,1)
    f.route.path='/group';await settle();assert.equal(tracking,1)
    f.route.path='/admin';await settle();assert.equal(tracking,1)
    f.app.unmount();assert.equal(tracking,0)
})

test('reloading the admin surface during an outage cannot clear the running Unity identity',async t=>{
    const f=await fixture(t,async()=>{throw new Error('must not issue')},{authenticated:false,displayAuthenticated:false,serviceUnavailable:true,user:null})
    assert.equal(f.messages.some(m=>m.action==='clear_unity_session'),false)
    session.serviceUnavailable=false;await settle()
    assert.equal(f.messages.filter(m=>m.action==='clear_unity_session').length,1,'only a confirmed anonymous snapshot clears native access')
})

test('an unavailable overlay reports readiness without forcing the operator into the login tab',async t=>{
    const f=await fixture(t,async()=>{throw new Error('must not issue')},{authenticated:false,displayAuthenticated:false,serviceUnavailable:true,user:null},'overlay')
    assert.equal(f.messages.some(m=>m.action==='show_admin'),false)
    assert.equal(f.messages.some(m=>m.type==='overlay_ready'),true)
    session.serviceUnavailable=false;await settle();await settle()
    assert.equal(f.messages.some(m=>m.action==='show_admin'),true,'confirmed logout still reveals the sign-in surface')
})

test('an already delivered native identity is not reissued after a transient service warning',async t=>{
    const f=await fixture(t,async()=> 'valid-ticket')
    session.serviceUnavailable=true;await settle();session.serviceUnavailable=false;await settle()
    assert.equal(f.messages.filter(m=>m.action==='sync_unity_session').length,1)
})

test('same-user credential renewal hands off the replacement session exactly once',async t=>{
    let issued=0
    const f=await fixture(t,async()=> `ticket-${++issued}`)
    session.sessionRevision++;await settle();session.permissions={view:true,launch:true};await settle()
    assert.deepEqual(f.messages.filter(m=>m.action==='sync_unity_session').map(m=>m.ticket),['ticket-1','ticket-2'])
})

test('logout keeps the native surface and factory context on its sign-in return route',async t=>{
    const f=await fixture(t,async()=> 'valid-ticket')
    f.route.path='/site';f.route.fullPath='/site?embedded=unity&surface=admin&factoryId=factory_x';f.route.query.factoryId='factory_x'
    session.displayAuthenticated=false;await settle()
    assert.equal(f.routes.at(-1).path,'/admin')
    assert.equal(f.routes.at(-1).query.embedded,'unity');assert.equal(f.routes.at(-1).query.surface,'admin')
    assert.equal(f.routes.at(-1).query.factoryId,'factory_x');assert.equal(f.routes.at(-1).query.redirect,f.route.fullPath)
})
