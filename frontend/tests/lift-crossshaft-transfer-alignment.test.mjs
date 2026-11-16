import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as T from 'three'
import { alignCadTransferAsset, runTransferHeightAlignment } from '../../tools/align-cad-transfer-heights.mjs'
import { decodeGlb, encodeGlb, parseLiftGlb, LIFT_MODEL_PREFIX as prefix } from '../../tools/fix-lift-model-rest-pose.mjs'
import { transferAuthoringY } from '../../shared/equipmentTransferDatum.mjs'

const id='cad_lifting_load_table_111400'
const source=new URL('../../backend/assets/models/cad_general_20261103_v1/11.14.00_升降备料台.glb',import.meta.url)
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const rawBytes=()=>fs.readFileSync(source)
const rootNode=doc=>doc.nodes.find(node=>node.name===prefix+'root')
const fixtureMetadata=bytes=>({assetSpec:{notes:'isolated regression fixture'},sourceAsset:{sha256:sha(bytes)},
    liftCrossshaft:structuredClone(rootNode(decodeGlb(bytes).json).extras.liftCrossshaft)})
function points(gltf,name){
    gltf.scene.updateMatrixWorld(true)
    const root=gltf.scene.getObjectByName(prefix+'root'),mesh=gltf.scene.getObjectByName(name)
    const matrix=root.matrixWorld.clone().invert().multiply(mesh.matrixWorld),position=mesh.geometry.attributes.position
    return Array.from({length:position.count},(_,i)=>new T.Vector3().fromBufferAttribute(position,i).applyMatrix4(matrix))
}
function vertexAttribute(glb,nodeName,semantic){
    const node=glb.json.nodes.find(n=>n.name===nodeName),primitive=glb.json.meshes[node.mesh].primitives[0]
    const a=glb.json.accessors[primitive.attributes[semantic]],view=glb.json.bufferViews[a.bufferView]
    const offset=(view.byteOffset||0)+(a.byteOffset||0),stride=view.byteStride||12
    return Buffer.concat(Array.from({length:a.count},(_,i)=>glb.bin.subarray(offset+i*stride,offset+i*stride+12)))
}
function assertShaftDimensions(values,center){
    const box=new T.Box3().setFromPoints(values),actualCenter=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3())
    assert.ok(actualCenter.distanceTo(new T.Vector3(...center))<1e-6)
    assert.ok(Math.abs(size.x-.036)<1e-6&&Math.abs(size.y-.036)<1e-6&&Math.abs(size.z-.78)<1e-6)
    for(const point of values){const radius=Math.hypot(point.x-center[0],point.y-center[1]);assert.ok(radius<1e-6||Math.abs(radius-.018)<1e-6)}
}

test('fresh CAD transfer calibration rigidly translates the declared shaft and synchronizes its GLB/metadata centre',async()=>{
    const bytes=rawBytes(),beforeHash=sha(bytes),metadata=fixtureMetadata(bytes),beforeMetadata=structuredClone(metadata)
    const before=decodeGlb(bytes),beforeRoot=rootNode(before.json),name=beforeRoot.extras.liftCrossshaft.node
    assert.ok(Math.abs(beforeRoot.extras.liftCrossshaft.center[1]-.545)<1e-12)
    const result=alignCadTransferAsset(id,bytes,metadata),after=decodeGlb(result.output),marker=rootNode(after.json).extras.liftCrossshaft
    assert.equal(result.aligned,true)
    assert.ok(Math.abs(marker.center[1]-.57)<1e-12)
    assert.deepEqual(marker.center,rootNode(after.json).extras.liftCylinderRestPose.tip)
    assert.deepEqual(result.metadata.liftCrossshaft,marker)
    assert.deepEqual(metadata,beforeMetadata,'caller metadata is not mutated')
    assert.equal(sha(bytes),beforeHash,'caller source Buffer is not mutated')
    const hierarchy=doc=>doc.nodes.map(({name,children,mesh,translation,rotation,scale,matrix})=>({name,children,mesh,translation,rotation,scale,matrix}))
    assert.deepEqual(hierarchy(after.json),hierarchy(before.json),'every source node index, transform and binding path is retained')
    assert.deepEqual(after.json.meshes,before.json.meshes)
    assert.deepEqual(after.json.materials,before.json.materials)
    assert.deepEqual(vertexAttribute(after,name,'NORMAL'),vertexAttribute(before,name,'NORMAL'),'rigid translation preserves exact normal bytes')
    const sourcePoints=points(await parseLiftGlb(bytes),name),outputPoints=points(await parseLiftGlb(result.output),name)
    assertShaftDimensions(sourcePoints,[0,.545,0]);assertShaftDimensions(outputPoints,[0,.57,0])
    for(let i=0;i<sourcePoints.length;i++)assert.ok(outputPoints[i].distanceTo(sourcePoints[i].clone().add(new T.Vector3(0,.025,0)))<1e-6)
    const assembly=after.json.nodes.find(node=>node.name===prefix+'lift')
    assert.ok(assembly.children.includes(after.json.nodes.findIndex(node=>node.name===name)),'shaft remains in the original scissor inspection target')
    assert.equal(sha(rawBytes()),beforeHash,'real source CAD file is unchanged')
})

test('isolated filesystem runner updates only sandbox derived copies, preserves its originals in backups, and is restart-idempotent',()=>{
    const bytes=rawBytes(),sourceHash=sha(bytes),workspace=fileURLToPath(new URL('../../',import.meta.url))
    const evidence=path.join(workspace,'output/model-crossshaft-20261116');fs.mkdirSync(evidence,{recursive:true})
    const sandbox=fs.mkdtempSync(path.join(evidence,'transfer-alignment-test-'))
    assert.ok(path.resolve(sandbox).startsWith(path.resolve(evidence)+path.sep))
    const models=path.join(sandbox,'backend/assets/models');fs.mkdirSync(models,{recursive:true})
    const file=path.join(models,id+'.glb'),metaFile=path.join(models,id+'_metadata.json'),metadata=fixtureMetadata(bytes)
    fs.writeFileSync(file,bytes);fs.writeFileSync(metaFile,JSON.stringify(metadata))
    const first=runTransferHeightAlignment({workspaceRoot:sandbox,modelIds:[id]})
    assert.equal(first.aligned,1)
    assert.equal(sha(fs.readFileSync(path.join(first.backup,id+'.glb'))),sourceHash)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.backup,path.basename(metaFile)))),metadata)
    const derived=fs.readFileSync(file),meta=JSON.parse(fs.readFileSync(metaFile)),marker=rootNode(decodeGlb(derived).json).extras.liftCrossshaft
    assert.deepEqual(meta.liftCrossshaft,marker)
    assert.equal(meta.transferAlignment.assetSha256,sha(derived))
    assert.ok(Math.abs(marker.center[1]-.57)<1e-12)
    const second=runTransferHeightAlignment({workspaceRoot:sandbox,modelIds:[id]})
    assert.equal(second.aligned,0);assert.equal(second.backup,null)
    assert.equal(sha(fs.readFileSync(file)),sha(derived),'repeat calibration does not double-shift the shaft')
    assert.equal(sha(rawBytes()),sourceHash,'the real CAD source is unchanged')
    fs.writeFileSync(path.join(sandbox,'result.json'),JSON.stringify({success:true,sourceHash,derivedHash:sha(derived),center:marker.center,realAssetsWritten:false},null,2))
})

test('unmarked legacy geometry keeps per-vertex datum mapping; malformed shaft contracts fail before filesystem publishing',async()=>{
    const bytes=rawBytes(),legacy=decodeGlb(bytes),name=rootNode(legacy.json).extras.liftCrossshaft.node
    delete rootNode(legacy.json).extras.liftCrossshaft
    const legacyBytes=encodeGlb(legacy),metadata={assetSpec:{notes:'legacy fixture'},sourceAsset:{}}
    const result=alignCadTransferAsset(id,legacyBytes,metadata)
    assert.equal(result.metadata.liftCrossshaft,undefined)
    const before=points(await parseLiftGlb(legacyBytes),name),after=points(await parseLiftGlb(result.output),name)
    for(let i=0;i<before.length;i++)assert.ok(after[i].distanceTo(new T.Vector3(before[i].x,transferAuthoringY(id,before[i].y),before[i].z))<1e-6)
    for(const edit of [marker=>marker.center[1]+=.01,marker=>marker.radius*=2,marker=>marker.axis=[0,1,0],marker=>marker.node='missing_shaft']){
        const invalid=decodeGlb(bytes);edit(rootNode(invalid.json).extras.liftCrossshaft)
        assert.throws(()=>alignCadTransferAsset(id,encodeGlb(invalid),fixtureMetadata(bytes)),/crossshaft/)
    }
})
