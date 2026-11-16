// Modify only derived library assets. Preserve names, indices, materials,
// assemblies and the original CAD delivery / Blender source directories.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import {TRANSFER_DATUM,TRANSFER_ALIGNMENT,transferAuthoringY,transferAuthoringSlope} from '../shared/equipmentTransferDatum.mjs'
import {CAD_MOTION_PROFILES} from '../frontend/src/three/cadMotionProfiles.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex')
// Pure transformation entry point for isolated tests; importing this module
// never scans, backs up or overwrites the real model library.
export function alignCadTransferAsset(id,bytes,inputMetadata){
    const calibration=TRANSFER_ALIGNMENT[id],metadata=structuredClone(inputMetadata)
    if(!calibration)throw Error(id+': unknown transfer-alignment model')
    if(metadata.transferAlignment){if(metadata.transferAlignment.assetSha256!==sha(bytes))throw Error(id+': calibrated asset was replaced');return {id,aligned:false,output:bytes,metadata}}
    const jsonLength=bytes.readUInt32LE(12),doc=JSON.parse(bytes.toString('utf8',20,20+jsonLength)),bin=Buffer.from(bytes.subarray(28+jsonLength))
    if(doc.buffers.length!==1||doc.skins?.length||doc.animations?.length)throw Error(id+': expected static embedded CAD')
    const prefix=CAD_MOTION_PROFILES[id].prefix
    const rootIndex=doc.nodes.findIndex(n=>n.name===prefix+'root'),rootNode=doc.nodes[rootIndex]
    if(!rootNode)throw Error('Missing model root')
    const shaftMarker=rootNode.extras?.liftCrossshaft
    let shaftIndex=-1
    if(shaftMarker!==undefined){
        const validPoint=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)
        if(!shaftMarker||shaftMarker.schemaVersion!==1||shaftMarker.node!==prefix+'crossshaft_metal'||
            !validPoint(shaftMarker.center)||!validPoint(shaftMarker.axis)||
            shaftMarker.axis.some((v,i)=>v!==[0,0,1][i])||
            !Number.isFinite(shaftMarker.radius)||shaftMarker.radius<=0||
            !Number.isFinite(shaftMarker.length)||shaftMarker.length<=0)
            throw Error(id+': invalid crossshaft marker')
        shaftIndex=doc.nodes.findIndex(n=>n.name===shaftMarker.node)
        if(shaftIndex<0||doc.nodes.filter(n=>n.name===shaftMarker.node).length!==1||!doc.meshes[doc.nodes[shaftIndex].mesh]?.primitives?.length)
            throw Error(id+': declared crossshaft source mesh is missing or ambiguous')
    }
    if(calibration.pusherOffsetY){const pusher=doc.nodes.find(n=>n.name===prefix+'pusher');if(!pusher)throw Error('Missing pusher');pusher.translation=[...(pusher.translation||[0,0,0])];pusher.translation[1]+=calibration.pusherOffsetY}
    const objects=doc.nodes.map(n=>{const o=new T.Object3D();if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);if(n.matrix)new T.Matrix4().fromArray(n.matrix).decompose(o.position,o.quaternion,o.scale);return o})
    doc.nodes.forEach((n,i)=>(n.children||[]).forEach(j=>objects[i].add(objects[j])));const scene=new T.Group();doc.scenes[doc.scene||0].nodes.forEach(i=>scene.add(objects[i]));scene.updateMatrixWorld(true)
    const sourceShaftCenter=shaftMarker?new T.Vector3(...shaftMarker.center).applyMatrix4(objects[rootIndex].matrixWorld):null
    const shaftDeltaY=sourceShaftCenter?transferAuthoringY(id,sourceShaftCenter.y)-sourceShaftCenter.y:0
    if(shaftMarker){
        const shaftToRoot=objects[rootIndex].matrixWorld.clone().invert().multiply(objects[shaftIndex].matrixWorld),shaftBounds=new T.Box3()
        for(const primitive of doc.meshes[doc.nodes[shaftIndex].mesh].primitives){
            const a=doc.accessors[primitive.attributes.POSITION],view=doc.bufferViews[a?.bufferView]
            if(!a||!view||a.componentType!==5126||a.type!=='VEC3'||a.sparse)throw Error(id+': crossshaft requires embedded float positions')
            const offset=(view.byteOffset||0)+(a.byteOffset||0),stride=view.byteStride||12
            for(let i=0;i<a.count;i++){
                const point=new T.Vector3(...[0,1,2].map(c=>bin.readFloatLE(offset+i*stride+c*4))).applyMatrix4(shaftToRoot)
                shaftBounds.expandByPoint(point)
                const radius=Math.hypot(point.x-shaftMarker.center[0],point.y-shaftMarker.center[1])
                if(!Number.isFinite(radius)||(radius>2e-6&&Math.abs(radius-shaftMarker.radius)>2e-6))throw Error(id+': crossshaft geometry does not match its declared radius')
            }
        }
        const expectedMin=new T.Vector3(shaftMarker.center[0]-shaftMarker.radius,shaftMarker.center[1]-shaftMarker.radius,shaftMarker.center[2]-shaftMarker.length/2)
        const expectedMax=new T.Vector3(shaftMarker.center[0]+shaftMarker.radius,shaftMarker.center[1]+shaftMarker.radius,shaftMarker.center[2]+shaftMarker.length/2)
        if(shaftBounds.min.distanceTo(expectedMin)>4e-6||shaftBounds.max.distanceTo(expectedMax)>4e-6)throw Error(id+': crossshaft geometry does not match its declared centre/length')
    }
    const edited=new Set(),box=new T.Box3();let triangles=0
    for(const [index,node] of doc.nodes.entries())for(const primitive of doc.meshes[node.mesh]?.primitives||[]){
        const position=doc.accessors[primitive.attributes.POSITION],normal=doc.accessors[primitive.attributes.NORMAL],matrix=objects[index].matrixWorld,inverse=matrix.clone().invert(),normalMatrix=new T.Matrix3().getNormalMatrix(matrix),inverseNormal=normalMatrix.clone().invert(),suffix=node.name?.replace(prefix,'')||''
        const stream=a=>{if(!a||a.componentType!==5126||a.type!=='VEC3'||a.sparse)throw Error('Expected float VEC3');const v=doc.bufferViews[a.bufferView];return {offset:(v.byteOffset||0)+(a.byteOffset||0),stride:v.byteStride||12}}
        const p=stream(position),n=normal?stream(normal):null,key=primitive.attributes.POSITION
        if(edited.has(key))throw Error('Shared geometry needs an explicit instance policy');edited.add(key)
        const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]
        for(let i=0;i<position.count;i++){
            const v=new T.Vector3(...[0,1,2].map(c=>bin.readFloatLE(p.offset+i*p.stride+c*4))).applyMatrix4(matrix),originalY=v.y
            // A declared through-shaft is a rigid solid: move its centre by the
            // datum mapping, not its individual vertices (which would ovalise
            // the Ø36 cross-section). Unmarked/other assets retain their mapping.
            v.y=index===shaftIndex?v.y+shaftDeltaY:transferAuthoringY(id,v.y,suffix)
            box.expandByPoint(v);v.applyMatrix4(inverse)
            // Already-aligned rigid geometry stays byte-for-byte intact.
            if(calibration.delta===0&&!calibration.doorCorrection)continue
            for(let c=0;c<3;c++){const value=v.getComponent(c);bin.writeFloatLE(value,p.offset+i*p.stride+c*4);min[c]=Math.min(min[c],value);max[c]=Math.max(max[c],value)}
            if(n&&index!==shaftIndex){const normalValue=new T.Vector3(...[0,1,2].map(c=>bin.readFloatLE(n.offset+i*n.stride+c*4))).applyMatrix3(normalMatrix);normalValue.y/=transferAuthoringSlope(id,originalY);normalValue.applyMatrix3(inverseNormal).normalize();for(let c=0;c<3;c++)bin.writeFloatLE(normalValue.getComponent(c),n.offset+i*n.stride+c*4)}
        }
        if(Number.isFinite(min[0])){position.min=min;position.max=max}
        triangles+=(primitive.indices===undefined?position.count:doc.accessors[primitive.indices].count)/3
    }
    const transfer={version:1,surfaceY:TRANSFER_DATUM.surfaceY,loadY:TRANSFER_DATUM.loadY,basketStroke:calibration.basketStroke||null,sourceSha256:sha(bytes),note:'Display transfer-height alignment; door sealing overlap retained; original CAD deliveries preserved.'}
    rootNode.extras={...rootNode.extras,transferAlignment:transfer}
    // A corrected source declares pin coordinates in the exported frame.
    // Move those coordinates through the same transfer-height mapping as its geometry.
    if(rootNode.extras.liftCylinderRestPose){
        const pose=rootNode.extras.liftCylinderRestPose,validPoint=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)
        if(pose.schemaVersion!==1||pose.coordinateSpace!=='three-y-up-local-m'||!['base','mid','tip'].every(key=>validPoint(pose[key])))throw Error(id+': invalid cylinder rest-pose marker')
        rootNode.extras.liftCylinderRestPose={...pose,...Object.fromEntries(['base','mid','tip'].map(key=>[key,[pose[key][0],transferAuthoringY(id,pose[key][1]),pose[key][2]]]))}
    }
    if(shaftMarker){
        const alignedCenter=sourceShaftCenter.clone();alignedCenter.y+=shaftDeltaY
        alignedCenter.applyMatrix4(objects[rootIndex].matrixWorld.clone().invert())
        rootNode.extras.liftCrossshaft={...shaftMarker,center:alignedCenter.toArray()}
        metadata.liftCrossshaft=structuredClone(rootNode.extras.liftCrossshaft)
    }
    const json=Buffer.from(JSON.stringify(doc)),padding=Buffer.alloc((4-json.length%4)%4,32),payload=Buffer.concat([json,padding]),output=Buffer.alloc(28+payload.length+bin.length)
    output.write('glTF');output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);output.writeUInt32LE(payload.length,12);output.writeUInt32LE(0x4e4f534a,16);payload.copy(output,20);output.writeUInt32LE(bin.length,20+payload.length);output.writeUInt32LE(0x004e4942,24+payload.length);bin.copy(output,28+payload.length)
    metadata.transferAlignment={...transfer,assetSha256:sha(output),calibration}
    metadata.sourceAsset={...metadata.sourceAsset,sha256:sha(output),stats:{...metadata.sourceAsset?.stats,triangles,nodes:doc.nodes.length,meshes:doc.meshes.length,materials:doc.materials.length,size:box.getSize(new T.Vector3()).toArray(),min:box.min.toArray(),max:box.max.toArray()}}
    metadata.assetSpec.notes=(metadata.assetSpec.notes||'')+' 统一展示送料基准为 1.25 m；门板密封搭边保留，原 CAD 交付文件保留。'
    return {id,aligned:true,metadata,output}
}
export function runTransferHeightAlignment({workspaceRoot=root,modelIds=Object.keys(TRANSFER_ALIGNMENT)}={}){
    const backup=path.join(workspaceRoot,'output','transfer-height-backup-'+new Date().toISOString().replace(/[:.]/g,'-')),prepared=[]
    for(const id of modelIds){
        const file=path.join(workspaceRoot,'backend/assets/models',id+'.glb'),metaFile=file.replace('.glb','_metadata.json'),bytes=fs.readFileSync(file),metadata=JSON.parse(fs.readFileSync(metaFile))
        const result=alignCadTransferAsset(id,bytes,metadata)
        if(!result.aligned){console.log(id+': already aligned');continue}
        prepared.push({...result,file,metaFile,bytes})
    }
    if(prepared.length){fs.mkdirSync(backup,{recursive:true});for(const p of prepared){fs.writeFileSync(path.join(backup,p.id+'.glb'),p.bytes);fs.copyFileSync(p.metaFile,path.join(backup,path.basename(p.metaFile)));fs.writeFileSync(p.file,p.output);fs.writeFileSync(p.metaFile,JSON.stringify(p.metadata,null,2)+'\n');console.log(p.id+': aligned, '+p.output.length+' bytes')}console.log('Backup: '+backup)}
    return {aligned:prepared.length,backup:prepared.length?backup:null}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runTransferHeightAlignment()
