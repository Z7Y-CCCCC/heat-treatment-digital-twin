import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import inspectionConfig from '../../shared/inspectionConfig.mjs'
import { installBrowser, json, settle } from './helpers.mjs'

const { createInspectionDefaults, normalizeInspection } = inspectionConfig
const compiledCache = new Map()
async function compileSfc(url) {
    if (compiledCache.has(url.href)) return compiledCache.get(url.href)
    const source = await readFile(url, 'utf8')
    const { descriptor, errors } = parse(source)
    assert.equal(errors.length, 0)
    // The lightweight renderer has no HTML parser for Vue's static HTML chunks.
    // Compile actual VNodes so the same template is exercised without DOM-only hoists.
    let compiled = compileScript(descriptor, { id: url.pathname, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
        const specifier = match[2]
        const resolved = specifier.startsWith('.') ? new URL(specifier, url) : new URL(import.meta.resolve(specifier))
        const target = specifier.endsWith('.vue') ? await compileSfc(resolved) : resolved.href
        compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
    }
    const result = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
    compiledCache.set(url.href, result)
    return result
}
const { default: Editor } = await import(await compileSfc(new URL('../src/views/admin/components/ModelInspectionEditor.vue', import.meta.url)))
const { default: Overlay } = await import(await compileSfc(new URL('../src/views/admin/components/ModelInspectionPreviewOverlay.vue', import.meta.url)))
const { default: RuntimeOverlay } = await import(await compileSfc(new URL('../src/runtime/InspectionOverlay.vue', import.meta.url)))

function element(type, text = '') {
    const listeners = new Map()
    const node = { type, tagName: type.toUpperCase(), text, children: [], props: {}, style: {}, parent: null, selected: false, multiple: false, value: '',
        addEventListener(name, callback) { listeners.set(name, callback) }, removeEventListener(name) { listeners.delete(name) },
        dispatchEvent(event) { return listeners.get(event.type)?.(event) },
        getRootNode() { return globalThis.document },
        get options() { return this.children.filter(child => child.type === 'option') },
        get textContent() { return textContent(this) }, getAttribute(name) { return this.props[name] }
    }
    return node
}
const textContent = node => [node.text, ...node.children.map(textContent)].join(' ')
function descendants(node) { return [node, ...node.children.flatMap(descendants)] }
function button(root, text) { return descendants(root).find(node => node.type === 'button' && textContent(node).trim() === text) }
async function click(node) { assert.ok(node, 'button exists'); await node.props.onClick?.({target:node}); await nextTick(); await nextTick() }

function fixture(t, initial = {}, component = Editor) {
    const environment = installBrowser(t)
    environment.replace('Document', class Document {})
    environment.replace('ShadowRoot', class ShadowRoot {})
    const requests = []
    environment.replace('fetch', async (url, options) => { requests.push({url,options}); return json({presets:[]}) })
    const renderer = createRenderer({
        createElement: type => element(type), createText: text => element('#text',text), createComment: text => element('#comment',text),
        setText: (node,text) => {node.text=text}, setElementText: (node,text) => {node.text=text;node.children=[]},
        parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node)+1] || null,
        patchProp(node,key,_previous,value) { node.props[key]=value; if (key === 'multiple') node.multiple=value != null && value !== false; if (key==='value') node.value=value; if (key==='checked') node.checked=value; },
        insert(node,parent,anchor=null) { if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);node.parent=parent;const index=parent.children.indexOf(anchor);if(index<0)parent.children.push(node);else parent.children.splice(index,0,node) },
        remove(node) { if(node.parent)node.parent.children=node.parent.children.filter(child=>child!==node);node.parent=null }
    })
    const root=element('root')
    const instance=ref(null)
    const updates=[],commands=[]
    let saves=0
    let current={modelValue:createInspectionDefaults(),modelId:'machine',nodes:[],partBindings:[],previewState:{stage:'solid',progress:0,parts:[]},...initial}
    const hostProps=ref(current)
    let mounted=false
    const app=renderer.createApp({setup:()=>()=>h(component,{...hostProps.value,ref:instance,'onUpdate:modelValue':value=>{updates.push(value);current.modelValue=value},onCommand:value=>commands.push(value),onSave:()=>saves++})})
    const render=async patch => {
        current={...current,...patch}
        hostProps.value=current
        if(!mounted){app.mount(root);mounted=true}
        await nextTick();await nextTick();await settle()
    }
    environment.beforeRestore(()=>{if(mounted)app.unmount()})
    return {root,instance,updates,commands,requests,render,get saves(){return saves},get current(){return current},environment}
}

const nodes=[
    {path:'Root#0',name:'Root',parentPath:'',type:'Group',isMesh:false,meshCount:2,bounds:{center:[0,0,0],size:[4,2,2]}},
    {path:'Root#0/A#0',name:'A',displayName:'驱动机构',parentPath:'Root#0',type:'Group',isMesh:false,meshCount:1,bounds:{center:[1,0,0],size:[1,1,1]}},
    {path:'Root#0/B#1',name:'B',displayName:'循环风机',parentPath:'Root#0',type:'Group',isMesh:false,meshCount:1,bounds:{center:[-1,0,0],size:[1,1,1]}},
    {path:'Case#1',name:'Case',parentPath:'',type:'Mesh',isMesh:true,meshCount:1,bounds:{center:[0,0,0],size:[4,2,2]}}
]
function richConfig() {
    return normalizeInspection({...createInspectionDefaults(),shell:{node_names:['Case'],transition:'clip',axis:'y',direction:1},parts:[{
        id:'drive-stable',name:'驱动机构',group:'驱动组',node_paths:['Root#0/A#0','Root#0/B#1'],explode_offset:[1,2,3],explode_rotation:[5,10,15],duration:2.1,delay:0.35,label_offset:[0.2,0.4,0.3],point_ids:['pid-stable'],point_keys:['motors.rpm'],description:'设备驱动机构',detail_view_id:'drive_view',camera:{yaw:38,pitch:21,distance_scale:0.8,target_offset:[0.1,0.2,0.3]}
    }]})
}

test('SFC editing name and motion preserves multi-node IDs, PLC links, camera and timing through parent roundtrip', async t => {
    const original=richConfig()
    const view=fixture(t,{modelValue:original,nodes})
    await view.render()
    view.instance.value.draft.parts[0].name='精密驱动总成'
    view.instance.value.draft.parts[0].explode_offset=[3,2,1]
    await nextTick();await nextTick()
    assert.ok(view.updates.length)
    await view.render({modelValue:JSON.parse(JSON.stringify(view.updates.at(-1)))})
    const part=view.instance.value.draft.parts[0]
    assert.equal(part.id,'drive-stable')
    assert.equal(part.name,'精密驱动总成')
    for(const key of ['node_paths','point_ids','point_keys','camera','duration','delay','explode_rotation','label_offset','detail_view_id']) assert.deepEqual(part[key],original.parts[0][key],key)
    await click(button(view.root,'保存拆解配置'))
    assert.equal(view.saves,1)
})

test('engineer reorder/remove actions preserve remaining stable IDs and associations', async t => {
    const config=normalizeInspection({...createInspectionDefaults(),parts:[{id:'first',name:'驱动机构',node_name:'A',point_ids:['keep']},{id:'second',name:'循环风机',node_name:'B'}]})
    const view=fixture(t,{modelValue:config,nodes})
    await view.render()
    await click(descendants(view.root).find(node=>node.props['aria-label']==='部件下移'))
    assert.deepEqual(view.instance.value.draft.parts.map(part=>part.id),['second','first'])
    assert.deepEqual(view.instance.value.draft.parts[1].point_ids,['keep'])
    await click(button(view.root,'移除'))
    assert.equal(view.instance.value.draft.parts.length,2)
    await click(button(view.root,'确认应用'))
    assert.deepEqual(view.instance.value.draft.parts.map(part=>part.id),['second'])
})

test('missing, duplicate and ancestor nodes are surfaced and save is disabled', async t => {
    const view=fixture(t,{nodes,modelValue:normalizeInspection({...createInspectionDefaults(),parts:[{id:'all',node_name:'Root'},{id:'child',node_name:'A'},{id:'missing',node_name:'missing'}]})})
    await view.render()
    assert.equal(view.instance.value.validation.valid,false)
    assert.ok(view.instance.value.validation.errors.length>=2)
    assert.ok(descendants(view.root).find(node=>node.props['data-testid']==='inspection-errors'))
    assert.equal(button(view.root,'保存拆解配置').props.disabled,true)
    await click(button(view.root,'保存拆解配置'))
    assert.equal(view.saves,0)
})

test('preset fetch never overwrites configuration; applying requires an explicit confirmation', async t => {
    const original=richConfig()
    const view=fixture(t,{nodes,modelValue:original})
    view.environment.replace('fetch',async()=>json({presets:[{id:'suggestion',name:'多阶段样板',modelId:'machine',inspection:{...createInspectionDefaults(),parts:[{id:'new',name:'新结构',node_name:'A'}]}}]}))
    await view.render()
    assert.equal(view.instance.value.draft.parts[0].id,'drive-stable')
    const presetSelect=descendants(view.root).find(node=>node.props['aria-label']==='模型拆解预设')
    presetSelect.options.forEach(option=>{option.selected=option.value==='suggestion'})
    presetSelect.dispatchEvent({type:'change',target:presetSelect})
    await nextTick()
    await click(button(view.root,'应用预设'))
    assert.equal(view.instance.value.draft.parts[0].id,'drive-stable')
    await click(button(view.root,'确认应用'))
    assert.equal(view.instance.value.draft.parts[0].id,'new')
})

test('JSON import retains rich fields and requires a deliberate apply action', async t => {
    const view=fixture(t,{nodes})
    await view.render()
    await click(button(view.root,'配置与运行端'))
    const jsonEditor=descendants(view.root).find(node=>node.props['aria-label']==='拆解配置 JSON')
    jsonEditor.props['onUpdate:modelValue'](JSON.stringify(richConfig()))
    await nextTick()
    await click(button(view.root,'校验并载入草稿'))
    assert.equal(view.instance.value.draft.parts.length,0)
    await click(button(view.root,'确认应用'))
    assert.deepEqual(normalizeInspection(view.instance.value.draft),richConfig())
})

for (const [label, incoming] of [
    ['parts', {parts:Array.from({length:65},(_,index)=>({id:`part-${index}`,node_name:`Node${index}`}))}],
    ['shell targets', {parts:[],shell:{node_names:Array.from({length:101},(_,index)=>`Shell${index}`)}}]
]) test(`oversized JSON ${label} cannot silently truncate the current draft`, async t => {
    const original = richConfig()
    const view = fixture(t,{nodes,modelValue:original})
    await view.render()
    await click(button(view.root,'配置与运行端'))
    const jsonEditor=descendants(view.root).find(node=>node.props['aria-label']==='拆解配置 JSON')
    jsonEditor.props['onUpdate:modelValue'](JSON.stringify(incoming))
    await nextTick()
    await click(button(view.root,'校验并载入草稿'))
    assert.deepEqual(normalizeInspection(view.instance.value.draft),original)
    assert.equal(button(view.root,'确认应用'),undefined)
    assert.ok(textContent(view.root).includes('JSON 配置未载入'))
})

test('playback controls emit actual timeline commands including reverse assembly and scrubbing', async t => {
    const view=fixture(t,{nodes,modelValue:richConfig()})
    await view.render()
    await click(button(view.root,'▶ 演示拆解'))
    await click(button(view.root,'↶ 反向组装'))
    await click(button(view.root,'暂停'))
    const scrub=descendants(view.root).find(node=>node.props['aria-label']==='拆解进度')
    await scrub.props.onInput({target:{value:'0.42'}})
    assert.deepEqual(view.commands.slice(0,4),[{command:'stage',stage:'exploded'},{command:'stage',stage:'solid'},{command:'pause'},{command:'progress',progress:0.42}])
})

test('spatial overlay renders projected anchors, description and preserved point associations', async t => {
    const view=fixture(t,{state:{labelsEnabled:true,leaderLines:true,selectedId:'motor',stage:'exploded',parts:[{id:'motor',name:'循环风机',description:'循环炉内气流',group:'驱动组',point_keys:['motors.rpm'],point_ids:['rpm-id'],selected:true,anchor:{x:0.6,y:0.5,visible:true},label:{x:0.7,y:0.4,visible:true}}]}},Overlay)
    await view.render()
    assert.match(textContent(view.root),/循环炉内气流/)
    assert.match(textContent(view.root),/motors\.rpm/)
    assert.match(textContent(view.root),/rpm-id/)
    const line=descendants(view.root).find(node=>node.type==='line')
    assert.equal(line.props.x1,60)
    assert.equal(line.props.y1,50)
    await click(button(view.root,'循环风机'))
    assert.deepEqual(view.commands.at(-1),{command:'select',partId:'motor'})
})

test('installed runtime overlay exposes view-only controls, spatial hits and live part parameters', async t => {
    const context = { inspectionStage: 'exploded', inspectionProgress: .45, inspectionPhase: 'paused', inspectionLabelsEnabled: true, inspectionLeaderLines: true,
        inspectionParts: [{id:'drive',name:'驱动机构',description:'已配置总成',pointIds:['pid'],pointKeys:['motors.rpm'],selected:true,anchor:{x:.3,y:.4,visible:true},label:{x:.2,y:.3,visible:true}}], partId:'drive', inspectionIssues:[] }
    const view = fixture(t,{ context, selectedPart:{points:[{id:'pid',name:'实时转速',value:1250,quality:'good',unit:'rpm'}]} },RuntimeOverlay)
    await view.render()
    assert.ok(textContent(view.root).includes('实时转速'))
    assert.ok(textContent(view.root).includes('1,250'))
    const label = descendants(view.root).find(node=>node.props.class?.includes('runtime-part-label'))
    assert.equal(label.props['data-overlay-hit'],'true')
    await click(button(view.root,'反向组装'))
    await click(button(view.root,'继续'))
    await click(button(view.root,'单独查看此部件'))
    assert.deepEqual(view.commands,[{command:'stage',stage:'solid'},{command:'resume'},{command:'isolate',enabled:true}])
    await view.render({selectedPart:{points:[{id:'pid',name:'实时转速',value:1250,quality:'bad'}]}})
    assert.ok(textContent(view.root).includes('数据未就绪'))
    assert.equal(textContent(view.root).includes('1,250'),false)
})
