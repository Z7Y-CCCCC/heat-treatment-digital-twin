// Preserve the original cart mesh buffers; mount the separately authored hook
// under a moving carriage while the existing guide and guide rollers stay fixed.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import {CART_FEED} from '../frontend/src/three/cartFeedMechanism.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),prefix='cad_transfer_cart_v1_'
const original=path.join(root,'backend/assets/models/cad_general_20261103_v1/10.13.00_料车.glb')
const hookFile=path.join(root,'backend/assets/models/attachments/push_pull_hook_08050105.glb')
const target=path.join(root,'backend/assets/models/cad_transfer_cart_101300.glb')
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
function read(file){const bytes=fs.readFileSync(file);if(bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid GLB');const length=bytes.readUInt32LE(12),doc=JSON.parse(bytes.toString('utf8',20,20+length));if(doc.buffers.length!==1||doc.skins?.length||doc.animations?.length||doc.images?.length)throw Error('Expected embedded static geometry');return {bytes,doc,bin:bytes.subarray(28+length)}}
const base=read(original),hook=read(hookFile),d=base.doc,h=hook.doc
const pusher=d.nodes.findIndex(n=>n.name===prefix+'pusher'),shuttle=d.nodes.findIndex(n=>n.name===prefix+'pusher_steel')
if(pusher<0||shuttle<0||!d.nodes[pusher].children.includes(shuttle))throw Error('Cart pusher hierarchy changed')
const carriage=d.nodes.length;d.nodes.push({name:prefix+'feed_carriage',translation:[CART_FEED.rearX-CART_FEED.carriageOriginalX,0,0],children:[shuttle]})
d.nodes[pusher].children=d.nodes[pusher].children.filter(i=>i!==shuttle);d.nodes[pusher].children.push(carriage)
const offsets={node:d.nodes.length,mesh:d.meshes.length,material:d.materials.length,accessor:d.accessors.length,view:d.bufferViews.length,bin:base.bin.length}
for(const node of h.nodes){if(node.children)node.children=node.children.map(i=>i+offsets.node);if(node.mesh!==undefined)node.mesh+=offsets.mesh;node.name=node.name==='push_pull_hook_08050105_root'?prefix+'push_hook':node.name==='hook_latch'?prefix+'hook_latch':prefix+'hook_'+node.name}
h.nodes[0].translation=[-.06,1.4025,0]
h.nodes[0].rotation=[0,1,0,0] // Face the open (-X) end, away from the return-chain tower.
d.nodes[carriage].children.push(offsets.node)
for(const mesh of h.meshes)for(const primitive of mesh.primitives){primitive.indices+=offsets.accessor;primitive.material+=offsets.material;for(const key of Object.keys(primitive.attributes))primitive.attributes[key]+=offsets.accessor}
for(const accessor of h.accessors)accessor.bufferView+=offsets.view
for(const view of h.bufferViews)view.byteOffset=(view.byteOffset||0)+offsets.bin
for(const key of ['nodes','meshes','materials','accessors','bufferViews'])d[key].push(...h[key])
const bin=Buffer.concat([base.bin,hook.bin]);d.buffers[0].byteLength=bin.length
const json=Buffer.from(JSON.stringify(d)),padding=Buffer.alloc((4-json.length%4)%4,0x20),payload=Buffer.concat([json,padding]),out=Buffer.alloc(28+payload.length+bin.length)
out.write('glTF');out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(payload.length,12);out.writeUInt32LE(0x4e4f534a,16);payload.copy(out,20);out.writeUInt32LE(bin.length,20+payload.length);out.writeUInt32LE(0x004e4942,24+payload.length);bin.copy(out,28+payload.length)
fs.writeFileSync(target,out)
const objects=d.nodes.map(n=>{const o=new T.Object3D();if(n.matrix)new T.Matrix4().fromArray(n.matrix).decompose(o.position,o.quaternion,o.scale);if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);return o})
d.nodes.forEach((n,i)=>(n.children||[]).forEach(child=>objects[i].add(objects[child])));const scene=new T.Group();d.scenes[d.scene||0].nodes.forEach(i=>scene.add(objects[i]));scene.updateMatrixWorld(true)
const bounds=new T.Box3();let triangles=0
d.nodes.forEach((n,i)=>{for(const p of d.meshes[n.mesh]?.primitives||[]){const a=d.accessors[p.attributes.POSITION];bounds.union(new T.Box3(new T.Vector3(...a.min),new T.Vector3(...a.max)).applyMatrix4(objects[i].matrixWorld));triangles+=(p.indices===undefined?a.count:d.accessors[p.indices].count)/3}})
const metadataFile=target.replace('.glb','_metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataFile))
metadata.sourceAsset={filename:'10.13.00_料车_安装推拉钩.glb',sha256:hash(out),stats:{nodes:d.nodes.length,meshes:d.meshes.length,triangles,materials:d.materials.length,size:bounds.getSize(new T.Vector3()).toArray(),min:bounds.min.toArray(),max:bounds.max.toArray()}}
metadata.cartPushHook={version:1,attachment:'/assets/models/attachments/push_pull_hook_08050105.glb',attachmentSha256:hash(hook.bytes),originalCartSha256:hash(base.bytes),sourceDwgSha256:'55cf019e503953268fad17add654e7677335995439869d3f178468acce07803c',mountOrigin:[-.06,1.4025,0],mountRotationY:Math.PI,feedAxis:'-X',unit:'m',feedCarriageNode:prefix+'feed_carriage',latchNode:prefix+'hook_latch',note:'推拉钩试装与仿真；安装转接板、演示行程和脱开角待现场核验。'}
metadata.assetSpec.notes='原料车 CAD 几何保留；在中央滑块上试装 08.05.01.05 推拉钩，固定导轨不随动。'
metadata.cartPushHook.carriageRearX=CART_FEED.rearX;metadata.cartPushHook.carriageFrontX=CART_FEED.frontX;metadata.cartPushHook.previewStroke=CART_FEED.stroke
metadata.inspection.parts.find(part=>part.node_name===prefix+'pusher').name='推料机构与推拉钩'
fs.writeFileSync(metadataFile,JSON.stringify(metadata,null,2)+'\n')
console.log(JSON.stringify({target,hook:metadata.cartPushHook,stats:metadata.sourceAsset.stats},null,2))
