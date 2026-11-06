import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareLoadingAlignment,loadingAlignmentCandidates,ALIGNMENT_DEVICE_FIELDS} from '../src/views/admin/utils/loadingAlignment.js'

const clone=value=>structuredClone(value)
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`)
const port=(position,direction=[0,0,1],nodeName='custom-opening')=>({position,direction,nodeName})
const model=(id,height=1.25,depth=1,extra={})=>({id,name:id,file_path:`/assets/${id}.glb`,default_scale:1,
    metadata:{description:'keep model metadata',loadingPorts:{version:1,inlet:port([0,height,depth]),outlet:null}},...extra})
function device(id,binding='lane-a',extra={}) {
    return {id,name:id,line_id:'line',coordinate_space:'line_local',model_type:'small',model_file:'',pos_x:1,pos_y:.25,
        pos_z:binding==='lane-b'?4:binding==='rail'?0:-4,rotation_y:binding==='lane-b'?180:0,scale:1,
        instance_config:JSON.stringify({[binding==='rail'?'railId':'laneId']:binding,customFlag:'preserve',loadingPortOverrides:{version:1,inlet:null,outlet:null}}),...extra}
}
function fixture() {
    const layout={version:1,lanes:[{id:'lane-a',name:'南设备线',offsetZ:-4,length:60},{id:'lane-b',name:'北设备线',offsetZ:4,length:60}],
        rails:[{id:'rail',name:'中导轨',offsetZ:0,length:60}]}
    const line={id:'line',workshop_id:'workshop',layout_json:JSON.stringify(layout)}
    const devices=[device('a-small'),device('a-large','lane-a',{model_type:'large',pos_x:5,pos_y:.7}),
        device('b-small','lane-b',{pos_x:12,pos_y:-.1}),device('b-large','lane-b',{model_type:'large',pos_x:17,pos_y:.9}),
        device('cart','rail',{model_type:'cart',pos_x:9,pos_y:.33}),device('unplaced','missing')]
    const models=[model('small',1.25,1),model('large',1.4,2),model('cart',1.3,.5)]
    return {line,layout,devices,models}
}
const noAsset={load:async()=>{throw Error('Explicit ports must not load a GLB')}}
const setup=(extra={})=>({...fixture(),mode:'faces',scope:'lane',laneId:'lane-a',selectedIds:[],...extra})
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child)}return value}

test('participation scopes select placed lane devices or rail carts according to alignment mode',()=>{
    const {devices,layout}=fixture()
    assert.deepEqual(loadingAlignmentCandidates(devices,layout,'faces','lane','lane-a').map(r=>r.id),['a-small','a-large'])
    assert.deepEqual(loadingAlignmentCandidates(devices,layout,'faces','line').map(r=>r.id),['a-small','a-large','b-small','b-large'])
    assert.deepEqual(loadingAlignmentCandidates(devices,layout,'heights','line').map(r=>r.id),['a-small','a-large','b-small','b-large','cart'])
    assert.deepEqual(loadingAlignmentCandidates(devices,layout,'heights','selected',null,['cart','b-small']).map(r=>r.id),['cart','b-small'])
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'faces','selected',null,['cart','a-small']),/导轨小车/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'heights','selected',null,['a-small','unplaced']),/已改变/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'heights','selected',null,['a-small','deleted']),/已改变/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'faces','lane','missing'),/至少需要两台/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'faces','unknown'),/参与范围/)
})

test('candidate validation excludes mixed coordinate spaces, invalid positions, missing rail side and degenerate selection',()=>{
    const {devices,layout}=fixture()
    for(const coordinate_space of ['workshop_world','workshop_local',null,undefined]) {
        assert.throws(()=>loadingAlignmentCandidates([{...devices[0],coordinate_space},devices[1]],layout,'heights','lane','lane-a'),/坐标空间|车间级/)
    }
    for(const [field,value] of [['pos_x',''],['pos_y',NaN],['pos_z',Infinity],['pos_y',null]]) {
        assert.throws(()=>loadingAlignmentCandidates([{...devices[0],[field]:value},devices[1]],layout,'heights','lane','lane-a'),/无效/)
    }
    assert.throws(()=>loadingAlignmentCandidates(devices,{...layout,rails:[]},'faces','lane','lane-a'),/配置.*导轨/)
    assert.throws(()=>loadingAlignmentCandidates(devices,{...layout,rails:[{...layout.rails[0],offsetZ:-4}]},'faces','lane','lane-a'),/配置.*导轨/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'heights','selected',null,['a-small']),/至少需要两台/)
    assert.throws(()=>loadingAlignmentCandidates(devices,layout,'heights','selected',null,['a-small','a-small']),/重复|至少需要两台|不同设备/)
})

test('maximum batch size is 200 distinct devices, checked before asset measurement',async()=>{
    const {layout,line,models}=fixture(),devices=Array.from({length:200},(_,i)=>device(`batch-${i}`,undefined,{pos_x:i,pos_z:-4-i/100}))
    const candidates=loadingAlignmentCandidates(devices,layout,'faces','line')
    assert.equal(candidates.length,200)
    const prepared=await prepareLoadingAlignment({line,layout,models,devices,mode:'faces',scope:'line'},noAsset)
    assert.equal(prepared.payload.devices.length,200)
    assert.throws(()=>loadingAlignmentCandidates([...devices,device('overflow')],layout,'faces','line'),/最多.*200/)
    await assert.rejects(()=>prepareLoadingAlignment({line,layout,models,devices:[...devices,device('overflow')],mode:'faces',scope:'line'},noAsset),/最多.*200/)
})

test('whole-line depth alignment uses one nearest reference per lane and changes Z alone, retaining each side of the rail',async()=>{
    const input=setup({scope:'line'}),before=clone(input)
    const prepared=await prepareLoadingAlignment(input,noAsset)
    assert.equal(prepared.axis,'z');assert.equal(prepared.mode,'faces')
    assert.deepEqual(prepared.referenceIds,['a-large','b-large'])
    assert.deepEqual(prepared.rows.map(r=>r.id),['a-small','a-large','b-small','b-large'])
    assert.deepEqual(prepared.rows.map(r=>r.direction),[1,1,-1,-1])
    assert.deepEqual(prepared.rows.map(r=>r.z),[-3,-4,3,4])
    for(const current of prepared.rows) {
        const source=input.devices.find(d=>d.id===current.id)
        assert.equal(current.x,source.pos_x);assert.equal(current.y,source.pos_y)
        assert.deepEqual(current.device,source)
    }
    const groups=[prepared.rows.slice(0,2),prepared.rows.slice(2,4)]
    for(const group of groups)close(group[0].z+group[0].faceOffset,group[1].z+group[1].faceOffset)
    assert.deepEqual(input,before,'preview does not move live devices or alter their settings')
    const repeated={...input,devices:input.devices.map(source=>({...source,pos_z:prepared.rows.find(r=>r.id===source.id)?.z??source.pos_z}))}
    const again=await prepareLoadingAlignment(repeated,noAsset)
    assert.deepEqual(again.rows.map(r=>r.z),prepared.rows.map(r=>r.z),'the next invocation is idempotent')
})

test('a specified lane reference keeps its unrounded Z exactly and cannot silently select another lane',async()=>{
    const input=setup({referenceId:'a-small'})
    input.devices[0].pos_z=-4.123456789
    const before=clone(input),prepared=await prepareLoadingAlignment(input,noAsset)
    assert.deepEqual(prepared.referenceIds,['a-small']);assert.equal(prepared.rows[0].z,-4.123456789)
    close(prepared.rows[1].z,-5.123456789)
    assert.equal(prepared.payload.devices[0].position,-4.123456789)
    assert.deepEqual(input,before)
    await assert.rejects(()=>prepareLoadingAlignment({...input,referenceId:'cart'},noAsset),/范围内.*基准/)
    await assert.rejects(()=>prepareLoadingAlignment({...input,scope:'line'},noAsset),/同一设备线/)
    await assert.rejects(()=>prepareLoadingAlignment({...input,scope:'selected',referenceId:undefined,selectedIds:['a-small','a-large','b-small']},noAsset),/不足两台/)
})

test('automatic nearest reference also stays exactly fixed when authored Z has more than six decimals',async()=>{
    const input=setup(),anchor=input.devices.find(d=>d.id==='a-large')
    anchor.pos_z=-4.123456789
    const prepared=await prepareLoadingAlignment(input,noAsset)
    assert.deepEqual(prepared.referenceIds,['a-large'])
    assert.equal(prepared.rows.find(r=>r.id==='a-large').z,anchor.pos_z,'the automatic reference must not be rounded or moved')
    assert.equal(prepared.payload.devices.find(d=>d.id==='a-large').position,anchor.pos_z)
})

test('height alignment can anchor on cart outlet with furnace inlets, without direction constraints or X/Z changes',async()=>{
    const input=setup({mode:'heights',scope:'selected',selectedIds:['cart','a-small','b-large'],referenceId:'cart',portKind:'inlet',referencePortKind:'outlet'})
    const cartModel=input.models.find(m=>m.id==='cart')
    cartModel.metadata.loadingPorts={version:1,inlet:null,outlet:port([2,2.1,-3],[1,0,0],'cart-discharge')}
    const cart=input.devices.find(d=>d.id==='cart')
    cart.pos_y=.123456789;cart.rotation_y=90;cart.scale=1.5
    const before=clone(input),prepared=await prepareLoadingAlignment(input,noAsset)
    assert.equal(prepared.axis,'y');assert.deepEqual(prepared.referenceIds,['cart'])
    assert.deepEqual(prepared.rows.map(r=>r.portKind),['outlet','inlet','inlet'])
    assert.equal(prepared.rows[0].y,.123456789)
    for(const current of prepared.rows) {
        close(current.y+current.heightOffset,.123456789+2.1*1.5)
        const source=input.devices.find(d=>d.id===current.id)
        assert.equal(current.x,source.pos_x);assert.equal(current.z,source.pos_z)
        assert.deepEqual(current.device,source)
    }
    assert.equal(prepared.rows[0].nodeName,'cart-discharge')
    assert.deepEqual(input,before)
    await assert.rejects(()=>prepareLoadingAlignment({...input,referencePortKind:'inlet'},noAsset),/进料口未配置/)
    await assert.rejects(()=>prepareLoadingAlignment(setup({mode:'heights',referenceId:undefined}),noAsset),/基准/)
    await assert.rejects(()=>prepareLoadingAlignment({...input,portKind:'outlet'},noAsset),/出料口未配置/)
})

test('batch CAS payload contains complete original device fields, matching model fields and the exact original line layout',async()=>{
    const input=setup({referenceId:'a-small'})
    input.devices[0].instance_config=JSON.stringify({laneId:'lane-a',scaleMultiplier:1.2,mirrorX:true,notes:{keep:['nested']},
        loadingPortOverrides:{version:1,inlet:{offset:[.1,.2,.3],yawDegrees:0},outlet:null}})
    const before=clone(input),prepared=await prepareLoadingAlignment(input,noAsset)
    assert.deepEqual(prepared.payload.expectedLine,{id:input.line.id,workshop_id:input.line.workshop_id,layout_json:input.line.layout_json})
    assert.deepEqual(Object.keys(prepared.payload).sort(),['devices','expectedLine','mode'])
    for(const entry of prepared.payload.devices) {
        const source=input.devices.find(d=>d.id===entry.id),m=input.models.find(item=>item.id===source.model_type)
        assert.deepEqual(Object.keys(entry).sort(),['expected','expectedModel','id','position'])
        assert.deepEqual(Object.keys(entry.expected),ALIGNMENT_DEVICE_FIELDS)
        assert.deepEqual(entry.expected,Object.fromEntries(ALIGNMENT_DEVICE_FIELDS.map(key=>[key,source[key]??null])))
        assert.deepEqual(entry.expectedModel,{id:m.id,file_path:m.file_path,default_scale:m.default_scale,metadata:m.metadata})
        assert.equal(entry.position,prepared.rows.find(r=>r.id===entry.id).z)
        assert.equal(entry.expected.instance_config,source.instance_config,'CAS preserves exact serialized config, not a normalized rewrite')
    }
    assert.deepEqual(input,before)
    const frozen=deepFreeze(setup({referenceId:'a-small'}))
    await prepareLoadingAlignment(frozen,noAsset)
})

test('expected device, model and line values are captured before any asynchronous preview boundary',async()=>{
    const input=setup({referenceId:'a-small'}),before=clone(input)
    const pending=prepareLoadingAlignment(input,noAsset)
    input.devices[0].pos_z=100
    input.devices[0].instance_config=JSON.stringify({laneId:'lane-a',changedAfterMeasurement:true})
    input.models[0].default_scale=9
    input.models[0].metadata.loadingPorts.inlet.position[1]=42
    input.line.workshop_id='changed-workshop'
    input.line.layout_json=JSON.stringify({...input.layout,revision:'changed-after-measurement'})
    input.layout.lanes[0].name='changed-lane-name'
    input.layout.lanes[0].offsetZ=88
    const prepared=await pending,first=prepared.payload.devices.find(d=>d.id==='a-small')
    assert.equal(first.expected.pos_z,before.devices[0].pos_z)
    assert.equal(first.expected.instance_config,before.devices[0].instance_config)
    assert.deepEqual(first.expectedModel.metadata,before.models[0].metadata)
    assert.equal(first.expectedModel.default_scale,before.models[0].default_scale)
    assert.deepEqual(prepared.payload.expectedLine,{id:before.line.id,workshop_id:before.line.workshop_id,layout_json:before.line.layout_json})
    assert.equal(first.position,before.devices[0].pos_z,'the reference was measured before the live object changed')
    assert.deepEqual(prepared.rows[0].binding.item,before.layout.lanes[0],'preview bindings are snapshots too')
})

test('invalid operation, absent models and explicit invalid ports abort preparation without returning a partial payload',async()=>{
    const input=setup()
    await assert.rejects(()=>prepareLoadingAlignment({...input,mode:'invalid'},noAsset),/操作无效/)
    await assert.rejects(()=>prepareLoadingAlignment({...input,models:[]},noAsset),/模型文件/)
    const models=clone(input.models)
    models[0].metadata.loadingPorts.inlet.direction=[0,1,0]
    await assert.rejects(()=>prepareLoadingAlignment({...input,models},noAsset),/水平/)
    models[0].metadata.loadingPorts={version:1,inlet:null,outlet:null}
    await assert.rejects(()=>prepareLoadingAlignment({...input,models},noAsset),/未配置/)
})
