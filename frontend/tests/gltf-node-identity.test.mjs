import test from 'node:test'
import assert from 'node:assert/strict'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'
import { validateInspection } from '../../shared/inspectionConfig.mjs'

test('original GLB node names and duplicate-name paths survive cache cloning', async () => {
    const originalNames = ['Panel A.Mesh:1', 'Drive', 'Drive', ' 面板 ']
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify({ asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0,1,2,3]}], nodes:originalNames.map(name=>({name})) }), '')
    assert.notDeepEqual(gltf.scene.children.map(node=>node.name), originalNames)
    restoreGltfNodeNames(gltf)
    const cachedClone = clone(gltf.scene)
    assert.deepEqual(cachedClone.children.map(node=>node.name), originalNames)
    const nodes = cachedClone.children.map((node,index)=>({name:node.name,path:`${node.name}#${index}`}))
    assert.equal(validateInspection({parts:[{id:'left',node_path:'Drive#1'},{id:'right',node_path:'Drive#2'}]},nodes).valid,true)
    assert.ok(validateInspection({parts:[{id:'ambiguous',node_name:'Drive'}]},nodes).errors.some(error=>error.code==='ambiguous_node_name'))
})
