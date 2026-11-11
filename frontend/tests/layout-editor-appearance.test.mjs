import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import {applyLayoutEditorAppearance,layoutEditorMaterial} from '../src/runtime/layoutEditorAppearance.js'

function fixture(){
 const root=new T.Group(),material=new T.MeshStandardMaterial({name:'authored_enamel',color:0x334455,metalness:.88,roughness:.32}),geometry=new T.BoxGeometry(2,3,4)
 for(let i=0;i<2;i++){const mesh=new T.Mesh(geometry,material);mesh.position.set(i,2,-3);root.add(mesh)}
 root.materials=new Set([material]);root.userData.defaultScale=1
 return {root,material,geometry}
}

test('layout editor uses plain lit gray solids with unchanged geometry and correctly owned material disposal',t=>{
 const {root,material,geometry}=fixture(),disposed=t.mock.method(material,'dispose'),positions=geometry.attributes.position.array.slice()
 const sourceMaterial=new T.MeshStandardMaterial({color:0x334455,metalness:.88,roughness:.32}),untouched=t.mock.method(sourceMaterial,'dispose')
 applyLayoutEditorAppearance(root)
 assert.ok(root.children.every(m=>m.material.isMeshLambertMaterial))
 assert.equal(root.children[0].material,root.children[1].material)
 assert.equal(root.children[0].material.color.getHex(),0xb7bec4)
 assert.equal(root.children[0].material.envMap,null);assert.equal(root.children[0].material.map,null)
 assert.equal(root.children[0].material.metalness,undefined)
 assert.equal(root.materials.size,1);assert.ok(root.materials.has(root.children[0].material))
 assert.equal(disposed.mock.callCount(),1);assert.equal(untouched.mock.callCount(),0)
 assert.deepEqual(geometry.attributes.position.array,positions)
 assert.equal(sourceMaterial.metalness,.88);assert.equal(sourceMaterial.color.getHex(),0x334455)
 root.children.forEach(m=>assert.deepEqual(m.position.toArray(),[root.children.indexOf(m),2,-3]))
 root.children[0].material.dispose();geometry.dispose();sourceMaterial.dispose()
})

test('instanced editor materials retain neutral per-instance tint without PBR reflection properties',()=>{
 const source=new T.MeshStandardMaterial({name:'CAD_stainless',metalness:1,roughness:.2})
 const material=layoutEditorMaterial(source,{instanced:true})
 assert.equal(material.color.getHex(),0xffffff);assert.equal(material.userData.baseColor.getHex(),0xb7bec4)
 assert.ok(material.vertexColors&&material.isMeshLambertMaterial)
 assert.equal(source.metalness,1);assert.equal(source.roughness,.2)
 material.dispose();source.dispose()
})

let current
test.mock.module('../src/three/ModelFactory.js',{namedExports:{createDeviceModel:async()=>current}})
test.mock.module('../src/runtime/ConnectionBadge3D.js',{namedExports:{setConnectionBadge3D(){}}})
const {createConfiguredDeviceModel}=await import('../src/runtime/DeviceRenderer.js')
test('plain appearance is scoped to the layout-editor profile; normal preview material type and PBR parameters remain authored',async()=>{
 const definition={deviceCfg:{id:'furnace',name:'furnace',pos_x:7,pos_y:1,pos_z:-2,scale:2,rotation_y:.4,instance_config:{mirrorX:true}},devIdx:0,wsIdx:0,gLineIdx:0}
 const normal=fixture();current=normal.root;await createConfiguredDeviceModel(definition,[],{})
 assert.ok(normal.root.children[0].material.isMeshStandardMaterial);assert.equal(normal.root.children[0].material.metalness,.88)
 const editor=fixture();current=editor.root;await createConfiguredDeviceModel(definition,[],{renderProfile:'layout-editor'})
 assert.ok(editor.root.children[0].material.isMeshLambertMaterial)
 assert.deepEqual(editor.root.position.toArray(),normal.root.position.toArray());assert.deepEqual(editor.root.scale.toArray(),normal.root.scale.toArray())
 for(const model of [normal.root,editor.root]){model.materials.forEach(m=>m.dispose());model.children[0].geometry.dispose()}
})
