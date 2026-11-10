import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, effect } from 'vue'
import { createPointValueIndex } from '../src/runtime/pointValueIndex.js'
test('unrelated scans retain point prop identity and do not invalidate another Vue card',()=>{
 const index=createPointValueIndex(reactive),a={id:'a',points:[{id:1,name:'x'}],frame:{analog:{x:10},timestamp:1}},b={id:'b',points:[{id:2,name:'y'}],frame:{analog:{y:20},timestamp:1}}
 index.update([a,b]);const root=index.records,original=root['b:2'];let renders=0,last
 effect(()=>{last=index.records['b:2'].value;renders++})
 for(let i=0;i<100;i++)index.update([{...a,frame:{analog:{x:i},timestamp:i+2}},b])
 assert.equal(index.records,root);assert.equal(root['b:2'],original);assert.equal(renders,1);assert.equal(last,20);assert.equal(index.pointVisits,102)
 index.update([a,{...b,frame:{analog:{y:21},timestamp:50}}]);assert.equal(last,21);assert.equal(renders,2)
})
test('same-valued fresh reads advance source metadata without rerendering scalar values; quality and source loss remain immediate',()=>{
 const index=createPointValueIndex(reactive),row={id:'cart',points:[{id:4,name:'present',category:'mechanisms'}],quality:'good'}
 index.update([{...row,frame:{mechanisms:{present:false},timestamp:1}}]);let values=0,qualities=0
 effect(()=>{index.records[4].value;values++});effect(()=>{index.records[4].quality;qualities++})
 index.update([{...row,frame:{mechanisms:{present:false},timestamp:2}}]);assert.equal(values,1);assert.equal(index.records[4].lastReadAt,2)
 index.update([{...row,frame:{mechanisms:{present:true},quality:{mechanisms:{present:'stale'}},pointMeta:{'mechanisms.present':{lastReadAt:123}},timestamp:3}}]);assert.equal(index.records[4].lastReadAt,123);assert.equal(values,2);assert.equal(qualities,2)
 index.update([{...row,frame:null,quality:'bad'}]);assert.equal(index.records[4].value,undefined);assert.equal(index.records[4].quality,'bad');assert.equal(index.records[4].lastReadAt,null)
})
test('definition, factory and device removal discard old aliases rather than retaining foreign data',()=>{
 const index=createPointValueIndex(),row={id:'a',points:[{id:1,name:'old'}],revision:'old',frame:{analog:{old:9}}}
 index.update([row]);index.update([{...row,revision:'new',points:[{id:2,value_role:'new'}],frame:{analog:{new:10}}}])
 assert.equal(index.records[1],undefined);assert.equal(index.records['a:1'],undefined);assert.equal(index.records[2].value,10)
 index.update([]);assert.deepEqual(index.records,{})
})
