import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, reactive } from 'vue'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { useShellTransparency } from '../src/runtime/useShellTransparency.js'
import { deferred } from './helpers.mjs'

function fixture(t, send = async()=>true) {
  t.mock.timers.enable({apis:['setTimeout']})
  const context=reactive({sceneReady:true,viewMode:'device',deviceId:'device-a',shellTransparencyAvailable:true,shellTransparent:false}),link=reactive({connected:true}),sent=[]
  const scope=effectScope(),state=scope.run(()=>useShellTransparency({context,connected:()=>link.connected,send:command=>{sent.push(command);return send(command)}}))
  t.after(()=>scope.stop());return {state,context,link,sent,scope}
}
test('device entry and switching devices keep covers opaque without sending an automatic toggle',async t=>{
  const f=fixture(t)
  assert.equal(f.state.available.value,true)
  assert.equal(f.context.shellTransparent,false)
  assert.deepEqual(f.sent,[])
  f.context.deviceId='device-b'
  assert.equal(f.context.shellTransparent,false)
  assert.deepEqual(f.sent,[])
  await f.state.toggle()
  assert.deepEqual(f.sent,[{command:'shell_transparency',enabled:true}])
})

test('shell toggle uses the native acknowledgement, not the successful HTTP relay, to show its pressed icon',async t=>{
  const f=fixture(t);assert.equal(await f.state.toggle(),true);assert.deepEqual(f.sent,[{command:'shell_transparency',enabled:true}]);assert.equal(f.state.pending.value,true);assert.equal(f.context.shellTransparent,false)
  assert.equal(await f.state.toggle(),false)
  f.context.shellTransparent=true;assert.equal(f.state.pending.value,false)
  await f.state.toggle();assert.equal(f.sent.at(-1).enabled,false);f.context.shellTransparent=false;assert.equal(f.state.pending.value,false)
})
test('unsupported/non-device/loading/disconnected contexts cannot send shell commands',async t=>{
  const f=fixture(t)
  for(const patch of [{viewMode:'line'},{viewMode:'device',sceneReady:false},{sceneReady:true,shellTransparencyAvailable:false},{shellTransparencyAvailable:true,deviceId:''}]){
    Object.assign(f.context,patch);assert.equal(await f.state.toggle(),false)
  }
  f.context.deviceId='device-a';f.link.connected=false;assert.equal(await f.state.toggle(),false);assert.deepEqual(f.sent,[])
})
test('timeouts and failed relays stay explicit without faking transparent state',async t=>{
  const f=fixture(t);await f.state.toggle();t.mock.timers.tick(5000);assert.match(f.state.error.value,/未确认/);assert.equal(f.context.shellTransparent,false);assert.equal(f.state.pending.value,false)
})
test('navigation/disposal cancel outstanding acknowledgement timers and ignore late results',async t=>{
  const pending=deferred(),f=fixture(t,()=>pending.promise),sending=f.state.toggle();f.context.deviceId='device-b';assert.equal(f.state.pending.value,false)
  pending.resolve(true);await sending;t.mock.timers.tick(6000);assert.equal(f.state.error.value,'');f.scope.stop();assert.equal(await f.state.toggle(),false)
})
test('shell icons match the solid-cube/dashed-shell-and-gears reference and contain no visible button text',async()=>{
  const source=await readFile(new URL('../src/components/ShellTransparencyButton.vue',import.meta.url),'utf8'),{descriptor}=parse(source)
  compileScript(descriptor,{id:'shell-icons'});const compiled=compileTemplate({source:descriptor.template.content,filename:'ShellTransparencyButton.vue',id:'shell-icons'})
  assert.deepEqual(compiled.errors,[]);const button=compiled.ast.children.find(n=>n.tag==='button')
  assert.ok(button);assert.equal(button.children.filter(n=>n.type===2&&n.content.trim()).length,0)
  assert.match(source,/shell-icon-solid/);assert.match(source,/shell-icon-inside/);assert.match(source,/shell-gears/);assert.match(source,/stroke-dasharray/);assert.match(source,/:aria-pressed="enabled"/)
})
test('the shell toggle stays in a fixed top gap rather than following device projections',async()=>{
  const source=await readFile(new URL('../src/views/DashboardOverlay.vue',import.meta.url),'utf8')
  const control=source.match(/<div v-if="runtimeContext.viewMode === 'device'[^]*?class="device-shell-control"[^]*?<\/div>/)?.[0]
  assert.ok(control);assert.doesNotMatch(control,/shellControlAnchor|:style=/)
  assert.match(source,/\.device-shell-control\{[^}]*top:12px/)
})
