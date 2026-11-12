import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createSSRApp,h} from 'vue'
import {renderToString} from '@vue/server-renderer'
import {parse,compileScript,compileStyle} from '@vue/compiler-sfc'
import {parse as parseTemplate} from '@vue/compiler-dom'

const url=new URL('../src/views/admin/components/ModelPartActionList.vue',import.meta.url)
const source=await readFile(url,'utf8'),descriptor=parse(source).descriptor
let compiled=compileScript(descriptor,{id:'import-only-part-actions',inlineTemplate:true}).content
compiled=compiled.replace(/from\s+(['"])([^'"]+)\1/g,(_all,_quote,name)=>`from ${JSON.stringify(import.meta.resolve(name))}`)
const Component=(await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))).default
const render=props=>renderToString(createSSRApp({render:()=>h(Component,props)}))

test('empty part-action model asks for a package, never manual parameter authoring',async()=>{
 const html=await render({})
 assert.match(html,/暂无动作，请导入动作包/)
 assert.doesNotMatch(html,/参数配置|新增动作|保存绑定|清空表单|添加绑定|更新绑定|编辑动作/)
 assert.match(html,/动作节点/)
 assert.match(html,/搜索动作节点/)
 assert.match(html,/0 项/)
})
test('imported and historical actions remain readable, with only preview/search/paging controls',async()=>{
 const entries=[{process:{id:'door',label:'炉门开启',detail:'动作包行程动作'},index:-1},{binding:{id:'saved-fan',name:'已有风机'},index:0}]
 const before=JSON.stringify(entries),html=await render({entries,nodeCount:2,total:2,page:1,pageCount:1})
 assert.match(html,/炉门开启/);assert.match(html,/已有风机/);assert.match(html,/预览/)
 assert.doesNotMatch(html,/>编辑<|>删除<|>新增动作<|参数配置|输出最小值|动作轴/)
 assert.equal(JSON.stringify(entries),before,'Rendering does not delete or rewrite saved actions')
})
test('search misses use a search message without pretending the model has no actions',async()=>{
 const html=await render({entries:[],search:'不存在的动作',nodeCount:9,total:0})
 assert.match(html,/没有匹配的动作/);assert.doesNotMatch(html,/暂无动作，请导入动作包/)
})
test('actual parent has no manual authoring form and retains the canonical package import/export entry',async()=>{
 const panel=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
 const template=parse(panel).descriptor.template.content,ast=parseTemplate(template),nodes=[]
 function visit(node){if(node.tag==='section'&&node.props?.some(prop=>prop.name==='show'&&prop.exp?.content==="modelLibraryStep === 'bindings'"))nodes.push(node);for(const child of node.children||[])visit(child)}
 visit(ast);assert.equal(nodes.length,1)
 assert.match(nodes[0].loc.source,/<ModelPartActionList/)
 assert.doesNotMatch(nodes[0].loc.source,/参数配置|新增动作|editModelBinding|removeModelBinding|saveModelPartBindings|modelBindingForm|ModelBindingFields/)
 assert.match(nodes[0].loc.source,/@preview-binding="previewModelBinding"/)
 assert.match(nodes[0].loc.source,/@preview-process="previewInlineCleanerProcess"/)
 assert.doesNotMatch(panel,/motionEditorPanel|newMotionBinding\(|editModelBinding\(/)
 assert.match(template,/<ModelAssetTransfer/)
 const importer=await readFile(new URL('../src/views/admin/components/ModelAssetTransfer.vue',import.meta.url),'utf8')
 assert.match(importer,/>导入动作包<\/button>/)
 assert.match(importer,/inspectedSha256/)
})
test('device binding empty state gives the same package-only instruction while point binding remains present',async()=>{
 const binding=await readFile(new URL('../src/views/admin/components/DeviceAnimationLink.vue',import.meta.url),'utf8')
 assert.match(binding,/暂无动作，请导入动作包/)
 assert.doesNotMatch(binding,/在“部件动作”中配置模型节点/)
 assert.match(binding,/<MotionDataPicker/)
})
test('read-only action list style and template compile cleanly',()=>{
 assert.deepEqual(parseTemplate(descriptor.template.content).errors||[],[])
 for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,id:'import-only-part-actions',scoped:true}).errors,[])
})
