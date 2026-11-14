import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref, nextTick } from 'vue'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { usePointHistoryColumn } from '../src/views/admin/composables/usePointHistoryColumn.js'
import { saveFeedback, showSaveFeedback } from '../src/runtime/saveFeedback.js'
const response=(factoryId='f',id=1)=>({success:true,factoryId,points:[{id,label:'温度',history_mode:'recent',history_days:30}]})
function fixture(api={},factory='f') {
 const scope=effectScope(),factoryId=ref(factory),deviceId=ref('all'),canEdit=ref(true),notices=[],writes=[]
 const value=scope.run(()=>usePointHistoryColumn({factoryId,deviceId,canEdit,notify:(message,type='success')=>notices.push({message,type}),api:{getHistoryPolicy:async()=>response(factory||'current'),savePointHistoryPolicy:async(f,id,policy)=>{writes.push({f,id,policy});return{success:true,factoryId:f,pointId:id}},...api}}))
 return {...value,factoryId,deviceId,canEdit,notices,writes,close:()=>scope.stop()}
}
test('column starts hidden, reads once on demand and pins an unset factory to its confirmed server response',async()=>{
 const f=fixture({},'');try{assert.equal(f.visible.value,false);assert.deepEqual(f.rows.value,{})
 await f.toggle();assert.equal(f.visible.value,true);await f.save(1,{mode:'permanent',days:30})
 assert.deepEqual(f.writes,[{f:'current',id:1,policy:{mode:'permanent',days:30}}]);assert.equal(f.notices[0].type,'success')
 await f.toggle();assert.equal(f.visible.value,false);await f.toggle();assert.equal(f.rows.value['1'].mode,'recent')
 }finally{f.close()}
})
for(const mode of ['off','finite','permanent'])test(`row autosave persists ${mode} only to its confirmed point and scope`,async()=>{
 const f=fixture();try{await f.load();await f.save(1,{mode,days:7});assert.deepEqual(f.writes,[{f:'f',id:1,policy:{mode,days:7}}]);assert.equal(f.rows.value['1'].mode,mode);assert.equal(f.rows.value['1'].days,7);assert.equal(f.anySaving.value,false)}finally{f.close()}
})
test('failed, thrown and wrong-point confirmations retain the saved row and show only failure bubbles',async()=>{
 let result={success:false,error:'磁盘错误'};const f=fixture({savePointHistoryPolicy:async()=>{if(result instanceof Error)throw result;return result}})
 try{await f.load();for(const value of [result,new Error('断线'),{success:true,factoryId:'other',pointId:1},{success:true,factoryId:'f',pointId:2}]){result=value;assert.equal(await f.save(1,{mode:'finite',days:7}),false);assert.equal(f.rows.value['1'].mode,'recent')}
 assert.equal(f.notices.length,4);assert.ok(f.notices.every(n=>n.type==='error'));assert.equal(f.anySaving.value,false)}finally{f.close()}
})
test('read-only, missing saved point, loading and invalid day counts never write',async()=>{
 const f=fixture();try{await f.load();f.canEdit.value=false;assert.equal(await f.save(1,{mode:'off',days:30}),false);f.canEdit.value=true
 assert.equal(await f.save('new',{mode:'off',days:30}),false)
 for(const days of [0,36501,1.5,NaN,'7'])assert.equal(await f.save(1,{mode:'finite',days}),false)
 f.loading.value=true;assert.equal(await f.save(1,{mode:'off',days:30}),false);assert.equal(f.writes.length,0)
 }finally{f.close()}
})
test('mismatched factory cannot enable writes and late reads cannot replace the active factory rows',async()=>{
 const calls=[],f=fixture({getHistoryPolicy:(factory)=>new Promise(resolve=>calls.push({factory,resolve}))})
 try{const old=f.load();f.visible.value=true;f.factoryId.value='g';await nextTick();calls[1].resolve(response('g',2));await nextTick();calls[0].resolve(response('f'));await old
 assert.deepEqual(Object.keys(f.rows.value),['2']);await f.save(2,{mode:'off',days:30});assert.equal(f.writes[0].f,'g')
 const bad=f.load();calls[2].resolve(response('wrong',3));await bad;assert.deepEqual(f.rows.value,{});assert.equal(await f.save(3,{mode:'off',days:30}),false)
 }finally{f.close()}
})
test('in-flight row saves block duplicate actions and late results after scope change or dispose never update another scope or toast',async()=>{
 let finish;const f=fixture({savePointHistoryPolicy:()=>new Promise(resolve=>finish=resolve)})
 try{await f.toggle();const saving=f.save(1,{mode:'off',days:30});assert.equal(f.anySaving.value,true)
 assert.equal(await f.save(1,{mode:'finite',days:2}),false);await f.toggle();assert.equal(f.visible.value,true)
 f.factoryId.value='g';await nextTick();finish({success:true,factoryId:'f',pointId:1});assert.equal(await saving,false);assert.deepEqual(f.notices,[])
 }finally{f.close()}
 const g=fixture({getHistoryPolicy:()=>new Promise(resolve=>finish=resolve)});const pending=g.load();g.close();finish(response());await pending;assert.deepEqual(g.rows.value,{})
})
test('cell and toast compile; optional table column and empty colspan stay aligned',async()=>{
 for(const name of ['PointHistoryPolicyCell','SaveFeedbackToast']){const source=await readFile(new URL(`../src/views/admin/components/${name}.vue`,import.meta.url),'utf8'),descriptor=parse(source).descriptor
 assert.doesNotThrow(()=>compileScript(descriptor,{id:name}));assert.deepEqual(compileTemplate({source:descriptor.template.content,id:name,filename:name+'.vue'}).errors,[])
 for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,id:name,scoped:true}).errors,[])}
 const panel=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
 assert.match(panel,/更多设置/);assert.doesNotMatch(panel,/显示保存策略|隐藏保存策略|显示换算字段|收起换算字段/);assert.match(panel,/v-if="pointHistoryColumn.visible.value"[^>]*>保存策略/)
 assert.match(panel,/point-col-alarm"\/><col v-if="pointHistoryColumn.visible.value" class="point-col-history"/)
 assert.match(panel,/\+ \(pointHistoryColumn.visible.value \? 1 : 0\)/)
})
test('save bubbles distinguish success and errors and replace older notices by unique identity',()=>{
 showSaveFeedback('已保存');const first=saveFeedback.value;showSaveFeedback('失败','error');assert.equal(saveFeedback.value.type,'error');assert.ok(saveFeedback.value.id>first.id);assert.equal(saveFeedback.value.message,'失败');saveFeedback.value=null
})

test('one extra-settings action toggles history and conversion columns together and cannot collapse a pending save', async()=>{
 const panel=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
 const body=panel.slice(panel.indexOf('async function togglePointExtraColumns()'),panel.indexOf('watch([() => dataPoints.value.map'))
 const showPointAdvancedFields={value:false},pointHistoryColumn={loading:{value:false},anySaving:{value:false},visible:{value:false},toggle:async()=>{pointHistoryColumn.visible.value=!pointHistoryColumn.visible.value}}
 const toggle=new Function('showPointAdvancedFields','pointHistoryColumn',`${body};return togglePointExtraColumns`)(showPointAdvancedFields,pointHistoryColumn)
 await toggle();assert.equal(showPointAdvancedFields.value,true);assert.equal(pointHistoryColumn.visible.value,true)
 pointHistoryColumn.anySaving.value=true;await toggle();assert.equal(showPointAdvancedFields.value,true)
 pointHistoryColumn.anySaving.value=false;await toggle();assert.equal(showPointAdvancedFields.value,false);assert.equal(pointHistoryColumn.visible.value,false)
 assert.match(panel,/showPointAdvancedFields.value = false\s+const pointHistoryColumn/)
})
