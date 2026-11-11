import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRenderer,h,ref,nextTick} from 'vue'
import {parse,compileScript} from 'vue/compiler-sfc'
import {loadingPhaseState} from '../../shared/loadingPhaseProgress.mjs'
import {installBrowser} from './helpers.mjs'

test('phase arcs follow reported progress, but only phase advancement or real 100% confirms completion',()=>{
  for(let phase=0;phase<4;phase++)for(let p=0;p<=100;p+=.5)for(let index=0;index<4;index++){
    const s=loadingPhaseState(p,phase,index)
    assert.equal(s.complete,index<phase||p===100)
    assert.ok(s.progress>=0&&s.progress<=1)
    if(!s.complete)assert.ok(s.progress<=.99)
    if(index>phase&&p<100)assert.equal(s.progress,0)
  }
  assert.equal(loadingPhaseState(72,1,1).complete,false,'an active phase is not complete merely because its estimated arc is full')
  assert.equal(loadingPhaseState(72,1,1).progress,.99)
  assert.equal(loadingPhaseState(NaN,0,0).progress,0)
  assert.equal(loadingPhaseState(Infinity,0,3).complete,false)
})

const source=new URL('../src/components/LoadingExperience.vue',import.meta.url)
const {descriptor}=parse(fs.readFileSync(source,'utf8'))
let compiled=compileScript(descriptor,{id:'phase-ring',inlineTemplate:true}).content.replace('Transition as _Transition','BaseTransition as _Transition')
for(const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]){
  const name=match[2],resolved=name.startsWith('.')?new URL(name,source).href:import.meta.resolve(name)
  compiled=compiled.replace(match[0],`from ${JSON.stringify(resolved)}`)
}
const {default:Loading}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
test('compiled Vue draws four rings, advances only the current arc and replaces completed centers with checks',async t=>{
  const environment=installBrowser(t);environment.replace('cancelAnimationFrame',()=>{})
  const node=type=>({type,props:{},children:[]}),renderer=createRenderer({
    createElement:node,createText:text=>({...node('#text'),text}),createComment:text=>({...node('#comment'),text}),
    setText:(n,text)=>n.text=text,setElementText:(n,text)=>n.text=text,
    patchProp:(n,key,old,value)=>n.props[key]=value,
    insert(n,parent,anchor){n.parent=parent;const old=parent.children.indexOf(n);if(old>=0)parent.children.splice(old,1);const at=parent.children.indexOf(anchor);parent.children.splice(at<0?parent.children.length:at,0,n)},
    remove(n){const at=n.parent?.children.indexOf(n);if(at>=0)n.parent.children.splice(at,1)},parentNode:n=>n.parent,nextSibling:()=>null
  }),root=node('root'),progress=ref(62),phase=ref(2)
  const app=renderer.createApp({render:()=>h(Loading,{progress:progress.value,phase:phase.value,config:{theme:'light'}})})
  app.mount(root);environment.beforeRestore(()=>app.unmount())
  const all=(n,p)=>[...(p(n)?[n]:[]),...n.children.flatMap(c=>all(c,p))]
  const arcs=()=>all(root,n=>n.props.class==='phase-ring-value'),checks=()=>all(root,n=>n.props.class==='phase-ring-check')
  assert.equal(arcs().length,4);assert.equal(checks().length,2)
  assert.equal(arcs()[2].props['stroke-dasharray'],'48 100')
  progress.value=70;await nextTick();assert.equal(arcs()[2].props['stroke-dasharray'],'80 100');assert.equal(checks().length,2)
  progress.value=99.9;phase.value=3;await nextTick();assert.equal(checks().length,3)
  progress.value=100;await nextTick();assert.equal(checks().length,4)
  progress.value=0;phase.value=0;await nextTick();assert.equal(checks().length,0,'a real new load resets completion')
})

test('native injected script has the same ring math and refreshes the fourth check at 100% without a phase change',()=>{
  const native=fs.readFileSync(new URL('../../native-admin-host/DashboardLoadingExperience.cs',import.meta.url),'utf8')
  const start=native.indexOf('function loadingPhaseState'),end=native.indexOf('const phases',start),fn=native.slice(start,end).trim()
  const state=vm.runInNewContext('('+fn+')')
  for(const phase of [undefined,0,1,2,3,99])for(const p of [0,8,25,32,62,75,99.9,100])for(let i=0;i<4;i++)assert.deepEqual(JSON.parse(JSON.stringify(state(p,phase,i))),loadingPhaseState(p,phase,i))
  const phaseItems=Array.from({length:4},()=>{const classes={},arc={},check={style:{}};return{classes,arc,check,classList:{toggle:(k,v)=>classes[k]=v},querySelector:s=>s==='.dtl-ring-value'?{setAttribute:(k,v)=>arc[k]=v}:check}})
  const set=native.match(/const setProgress = \(value, phase, step\) => \{[\s\S]*?\n          \};/)[0]
  const context=vm.createContext({phaseItems,phases:['a','b','c','d'],fill:{style:{}},percent:{},stepLabel:{}})
  vm.runInContext(`${fn}\nlet lastProgress=-1,lastPhase=-1,lastStep='';${set};globalThis.update=setProgress`,context)
  context.update(99,3,'data');assert.equal(phaseItems[3].check.style.display,'none')
  context.update(100,3,'ready');assert.ok(phaseItems.every(p=>p.classes.complete));assert.ok(phaseItems.every(p=>p.check.style.display===''))
  assert.equal((native.match(/<svg viewBox="0 0 24 24"/g)||[]).length,4)
  assert.match(descriptor.styles[0].content,/prefers-reduced-motion:reduce.*phase-ring-value/s)
})
