import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { effectScope, ref } from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { useEdgeReveal } from '../src/runtime/useEdgeReveal.js'

function fixture(t, initiallyOpen = false) {
  t.mock.timers.enable({ apis:['setTimeout'] })
  const keepOpen = ref(initiallyOpen), focused = ref(false), element = ref({querySelector:() => focused.value ? {} : null})
  const scope = effectScope(), state = scope.run(() => useEdgeReveal({element,keepOpen:() => keepOpen.value}))
  t.after(() => scope.stop())
  return { ...state, keepOpen, focused, scope, tick:ms => t.mock.timers.tick(ms) }
}
test('edge controls start folded, reveal on approach and wait 1.2 seconds after leaving', t => {
  const f=fixture(t);assert.equal(f.hidden.value,true)
  f.enter();assert.equal(f.hidden.value,false);f.tick(10000);assert.equal(f.hidden.value,false)
  f.leave();f.tick(1199);assert.equal(f.hidden.value,false);f.tick(1);assert.equal(f.hidden.value,true)
})
test('quick re-entry cancels a pending hide rather than flickering under the pointer', t => {
  const f=fixture(t);f.enter();f.leave();f.tick(900);f.enter();f.tick(2000);assert.equal(f.hidden.value,false)
  f.leave();f.tick(1200);assert.equal(f.hidden.value,true)
})
test('open menus and in-flight operations keep their control visible until released', t => {
  const f=fixture(t,true);assert.equal(f.hidden.value,false)
  f.leave();f.tick(5000);assert.equal(f.hidden.value,false)
  f.keepOpen.value=false;f.tick(1200);assert.equal(f.hidden.value,true)
  f.keepOpen.value=true;assert.equal(f.hidden.value,false)
})
test('keyboard/input focus prevents auto-hide and focus departure can arm it again', t => {
  const f=fixture(t);f.reveal();f.focused.value=true;f.arm();f.tick(1200);assert.equal(f.hidden.value,false)
  f.focused.value=false;f.arm();f.tick(1200);assert.equal(f.hidden.value,true)
})
test('disposing an edge dock cancels timers and ignores late reveal calls', t => {
  const f=fixture(t);f.enter();f.leave();f.scope.stop();f.tick(5000);assert.equal(f.hidden.value,false)
  f.hidden.value=true;f.enter();assert.equal(f.hidden.value,true)
})
test('both docks share the 14px folded tab and preserve native hover hotspots', async () => {
  for(const path of ['components/EdgeFoldTab.vue','components/SceneCameraControls.vue','views/DashboardAccountDock.vue']){
    const source=await readFile(new URL('../src/'+path,import.meta.url),'utf8'),{descriptor}=parse(source)
    compileScript(descriptor,{id:path})
    assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:path,id:path}).errors,[])
    assert.deepEqual(compileStyle({source:descriptor.styles.map(s=>s.content).join('\n'),id:path}).errors,[])
    if(path.endsWith('EdgeFoldTab.vue')){
      assert.match(source,/width:14px;height:42px/);assert.match(source,/clip-path:polygon/);assert.match(source,/:aria-label="label"/)
    }else{
      assert.match(source,/useEdgeReveal/);assert.match(source,/<EdgeFoldTab/);assert.match(source,/data-overlay-hit="true"/);assert.match(source,/:inert="hidden"/)
    }
  }
})
