import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {InspectionPreview} from '../src/runtime/InspectionPreview.js'
import {restoreGltfNodeNames} from '../src/three/gltfNodeIdentity.js'
const require=createRequire(import.meta.url),{CATALOG}=require('../../backend/services/cadEquipmentModels.js')
for(const {id} of CATALOG)test(`${id}: complete assembly coverage, reversible explosion and disposal`,async()=>{
    const b=fs.readFileSync(new URL(`../../backend/assets/models/${id}.glb`,import.meta.url))
    const gltf=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')
    restoreGltfNodeNames(gltf)
    const config=JSON.parse(fs.readFileSync(new URL(`../../backend/assets/models/${id}_metadata.json`,import.meta.url))).inspection
    const root=gltf.scene,scene=new T.Scene();scene.add(root);root.updateMatrixWorld(true)
    const meshes=[];root.traverse(o=>{if(o.isMesh)meshes.push({o,matrix:o.matrixWorld.clone(),material:o.material,parent:o.parent})})
    const nodes=[],nodeMap=new Map()
    function collect(parent,parentPath=''){parent.children.forEach((o,i)=>{const path=parentPath+'/'+o.name+'#'+i;nodes.push({name:o.name,path,parentPath,type:o.type,isMesh:!!o.isMesh});nodeMap.set(path,o);collect(o,path)})}collect(root)
    const camera=new T.PerspectiveCamera(40,1,.01,100);camera.position.set(6,6,8);camera.lookAt(0,1,0);camera.updateMatrixWorld()
    const controls={target:new T.Vector3(0,1,0),update(){}}
    const runtime=new InspectionPreview({root,nodes,nodeMap,scene,camera,controls,config})
    assert.deepEqual(runtime.validation.errors,[])
    assert.equal(runtime.parts.length,config.parts.length)
    assert.equal(runtime.parts.flatMap(p=>p.targets).length,gltf.parser.json.nodes[gltf.parser.json.scenes[0].nodes[0]].children.length)
    for(let cycle=0;cycle<3;cycle++){
        runtime.setProgress(1);root.updateMatrixWorld(true)
        assert.ok(meshes.some(({o,matrix})=>o.matrixWorld.elements.some((v,i)=>Math.abs(v-matrix.elements[i])>1e-5)))
        runtime.setProgress(0);root.updateMatrixWorld(true)
        for(const {o,matrix} of meshes)assert.ok(o.matrixWorld.elements.every((v,i)=>Math.abs(v-matrix.elements[i])<1e-5),o.name)
    }
    runtime.dispose();root.updateMatrixWorld(true)
    for(const {o,matrix,material,parent} of meshes){assert.equal(o.material,material);assert.equal(o.parent,parent);assert.ok(o.matrixWorld.elements.every((v,i)=>Math.abs(v-matrix.elements[i])<1e-5))}
})
