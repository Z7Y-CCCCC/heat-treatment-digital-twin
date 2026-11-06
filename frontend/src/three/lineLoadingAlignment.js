import * as T from 'three'
import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'
import {TRANSFER_MODEL_PROFILES} from './feedSequence.js'
import {nativeDeviceTransform} from '../runtime/factorySceneConfig.js'
import {loadConfiguredGltf,disposeSceneObject} from '../runtime/ConfiguredFactoryScene.js'
import {resolveBackendAssetUrl} from './ModelFactory.js'
import {resolveLoadingPort} from '../../../shared/loadingPorts.mjs'

const nameOf = device => device?.name || device?.id || '设备'
const errorFor = (device,message) => Error(`「${nameOf(device)}」${message}，未移动设备`)
const parsedObject = value => typeof value === 'string' ? JSON.parse(value) : value || {}
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key)
const kindLabel = kind => kind === 'outlet' ? '出料口' : '进料口'
const round = number => Number(number.toFixed(6))

// Compose authored hierarchy transforms without updating matrices, attaching
// meshes, normalizing the asset, or populating geometry.boundingBox. glTF scene
// root-local coordinates exclude a preview/scene owner's transform.
function rawNodeMatrix(node,root) {
    const chain=[]
    for(let current=node;current&&current!==root;current=current.parent)chain.push(current)
    const matrix=new T.Matrix4()
    for(const current of chain.reverse())matrix.multiply(current.matrixAutoUpdate
        ? new T.Matrix4().compose(current.position,current.quaternion,current.scale) : current.matrix)
    return matrix
}

function rawBounds(node,root) {
    const box=new T.Box3(),point=new T.Vector3()
    node?.traverse(mesh=>{
        const position=mesh.geometry?.getAttribute('position')
        if(!position)return
        const matrix=rawNodeMatrix(mesh,root)
        for(let i=0;i<position.count;i++)box.expandByPoint(point.fromBufferAttribute(position,i).applyMatrix4(matrix))
    })
    return box
}

// Unlike connectedGeometryParts, this read-only mouth-sill measurement creates
// no scene nodes or GPU geometry. Authored UVs, materials and matrices stay put.
function rawComponentBounds(mesh,root) {
    const geometry=mesh?.geometry,position=geometry?.getAttribute('position')
    if(!position)return []
    const keys=new Map(),parents=[],ids=[]
    const find=index=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index]}return index}
    for(let i=0;i<position.count;i++) {
        const key=[position.getX(i),position.getY(i),position.getZ(i)].map(v=>Math.round(v*1e5)).join(',')
        if(!keys.has(key)){keys.set(key,parents.length);parents.push(parents.length)}
        ids.push(keys.get(key))
    }
    const indices=geometry.index?.array || Array.from({length:position.count},(_,i)=>i)
    for(let i=0;i+2<indices.length;i+=3) {
        const a=find(ids[indices[i]])
        parents[find(ids[indices[i+1]])]=a;parents[find(ids[indices[i+2]])]=a
    }
    const boxes=new Map(),point=new T.Vector3(),matrix=rawNodeMatrix(mesh,root)
    for(const i of indices) {
        const key=find(ids[i])
        if(!boxes.has(key))boxes.set(key,new T.Box3())
        boxes.get(key).expandByPoint(point.fromBufferAttribute(position,i).applyMatrix4(matrix))
    }
    return [...boxes.values()]
}

const CAD_SURFACE_NODES={
    cad_tempering_furnace_091300:'internal_rollers',cad_cleaner_170700:'internal_rollers',
    cad_multipurpose_furnace_082000:'elevator_basket',cad_water_cooling_tank_471000:'basket',
    cad_lifting_load_table_111400:'roller_bed',cad_fixed_load_table_112200:'roller_bed',
    cad_transfer_cart_101300:'roller_bed',cad_air_cooling_table_115800ht:'roller_bed'
}

function cadSurfaceHeight(root,profile) {
    const modelId=Object.keys(CAD_MOTION_PROFILES).find(id=>CAD_MOTION_PROFILES[id]===profile)
    const suffix=CAD_SURFACE_NODES[modelId]
    // These named stainless meshes contain load rollers, not taller side guides.
    // Use their actual crowns, not a global height constant or door center.
    const rollers=suffix&&root.getObjectByName(profile.prefix+suffix+'_stainless')
    const box=rollers&&rawBounds(rollers,root)
    return box&&!box.isEmpty()?box.max.y:null
}

function transferSurfaceHeight(root,profile,mouthBox,normalAxis) {
    if(profile===TRANSFER_MODEL_PROFILES.photo_tempering_furnace_v6) {
        const floor=root.getObjectByName('temper_v6_front_shallow_tray_brushed_metal')
        const box=floor&&rawBounds(floor,root)
        return box&&!box.isEmpty()?box.max.y:null
    }
    if(profile===TRANSFER_MODEL_PROFILES.photo_multipurpose_furnace_v6) {
        const refractory=root.getObjectByName('mouth_frame_refractory')
        const crossAxis=normalAxis==='x'?'z':'x',size=mouthBox.getSize(new T.Vector3()),center=mouthBox.getCenter(new T.Vector3())
        const slabs=rawComponentBounds(refractory,root).filter(box=>{
            const s=box.getSize(new T.Vector3()),c=box.getCenter(new T.Vector3())
            return s.y>0&&s.y<size.y*.2&&s[crossAxis]>=size[crossAxis]*.6
                &&Math.abs(c[crossAxis]-center[crossAxis])<size[crossAxis]*.1&&c.y<center.y
        })
        // Multiple plausible sills are ambiguous and require calibration.
        return slabs.length===1?slabs[0].max.y:null
    }
    return null
}

function inferPortGeometry(root,device={},model={},kind='inlet',railDirection) {
    if(kind!=='inlet'&&kind!=='outlet')throw Error('kind 必须为 inlet 或 outlet')
    // A visible front door is not evidence of a separate discharge opening.
    if(kind==='outlet'||!root?.getObjectByName)return null
    const cad=CAD_MOTION_PROFILES[device.model_type || model.id] || Object.values(CAD_MOTION_PROFILES).find(p=>root.getObjectByName(p.prefix+'root'))
    const transfer=TRANSFER_MODEL_PROFILES[device.model_type || model.id] || Object.values(TRANSFER_MODEL_PROFILES).find(p=>root.getObjectByName(p.mouthNode)&&root.getObjectByName(p.doorNode))
    if(!cad&&!transfer)return null
    const panel=cad?['door_black','door_enamel','door'].map(s=>root.getObjectByName(cad.prefix+s)).find(Boolean):root.getObjectByName(transfer.doorNode)
    const mouth=cad?root.getObjectByName(cad.prefix+'roller_bed'):root.getObjectByName(transfer.mouthNode)
    const node=transfer?(mouth||panel):(panel||mouth)
    if(!node)return null
    const box=rawBounds(node,root),panelBox=panel&&rawBounds(panel,root)
    if(box.isEmpty()||(panelBox&&panelBox.isEmpty()))return null
    const size=(panelBox||box).getSize(new T.Vector3()),axis=panel?(size.x<size.z?'x':'z'):(size.x>size.z?'x':'z')
    const center=box.getCenter(new T.Vector3()),bodyCenter=rawBounds(root,root).getCenter(new T.Vector3())
    let side
    if(panel)side=Math.sign((panelBox||box).getCenter(new T.Vector3())[axis]-bodyCenter[axis])||1
    else {
        // Legacy open staging beds work from either end. Retain the existing
        // rail-facing end selection without inventing a separate outlet.
        const transform=nativeDeviceTransform(device,model),candidate=new T.Vector3(axis==='x'?1:0,0,axis==='z'?1:0)
            .multiply(new T.Vector3(...transform.scale)).applyAxisAngle(new T.Vector3(0,1,0),transform.yaw)
        side=railDirection===1||railDirection===-1?(Math.sign(candidate.z)*railDirection||1):-1
    }
    center[axis]=side>0?box.max[axis]:box.min[axis]
    const height=cad?cadSurfaceHeight(root,cad):transferSurfaceHeight(root,transfer,box,axis)
    center.y=height??0 // Depth-only sentinel, never reported as a measured height.
    return {position:center.toArray(),direction:[axis==='x'?side:0,0,axis==='z'?side:0],nodeName:node.name,heightReliable:height!==null}
}

/** Optional, reliable editor suggestion in untouched raw glTF coordinates. */
export function inferLoadingPort(root,device={},model={},kind='inlet') {
    const inferred=inferPortGeometry(root,device,model,kind)
    if(!inferred?.heightReliable)return null
    const {heightReliable,...port}=inferred
    return port
}

function effectivePort(root,device,model={},kind,railDirection,requireHeight) {
    // Validate before fallback. Explicit null/missing ports, malformed JSON and
    // invalid instance overrides must never be concealed by legacy geometry.
    let port=resolveLoadingPort(model,device,kind)
    const metadata=parsedObject(model.metadata),instance=parsedObject(device.instance_config)
    let source='model',heightReliable=true
    if(!port) {
        if(own(metadata,'loadingPorts'))throw errorFor(device,`${kindLabel(kind)}未配置，请配置${kindLabel(kind)}`)
        const inferred=inferPortGeometry(root,device,model,kind,railDirection)
        if(!inferred)throw errorFor(device,`尚未配置${kindLabel(kind)}，模型没有可靠的${kindLabel(kind)}节点`)
        heightReliable=inferred.heightReliable
        const {heightReliable:ignored,...base}=inferred
        port=resolveLoadingPort({...model,metadata:{...metadata,loadingPorts:{version:1,inlet:base,outlet:null}}},device,kind)
        source='fallback'
    }
    if(requireHeight&&!heightReliable)throw errorFor(device,`${kindLabel(kind)}送料高度无法可靠判定，请配置${kindLabel(kind)}`)
    if(source==='model'&&parsedObject(instance.loadingPortOverrides)?.[kind])source='instance'
    return {...port,source,heightReliable}
}

function projectPort(port,device,model) {
    const transform=nativeDeviceTransform(device,model)
    const matrix=new T.Matrix4().compose(new T.Vector3(),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),transform.yaw),new T.Vector3(...transform.scale))
    const position=new T.Vector3(...port.position).applyMatrix4(matrix)
    const direction=new T.Vector3(...port.direction).transformDirection(matrix)
    return {faceOffset:position.z,heightOffset:port.heightReliable?position.y:null,portPosition:position.toArray(),
        portDirection:direction.toArray(),portSource:port.source,source:port.source,nodeName:port.nodeName}
}

function assertRailDirection(row) {
    const device=row.device||row
    if(row.direction!==1&&row.direction!==-1)throw errorFor(device,'导轨侧方向无效')
    if(!row.portDirection)return // Legacy callers supply already checked offsets.
    const [x,y,z]=row.portDirection
    if(![x,y,z].every(Number.isFinite)||Math.abs(z)<.9999||Math.abs(y)>.0001)throw errorFor(device,'进料方向未垂直于导轨，请先调整朝向')
    if(z*row.direction<0)throw errorFor(device,'炉门背向导轨，请先调整朝向')
}

// Backwards-compatible depth-only API. New height operations reject unknown Y.
export function loadingFaceOffset(root,device,model={},direction) {
    const measured=projectPort(effectivePort(root,device,model,'inlet',direction,false),device,model)
    assertRailDirection({...measured,device,direction})
    return measured.faceOffset
}

function coordinate(row,axis) {
    const value=row[axis]??row.device?.['pos_'+axis]??0
    if(value===''||value===null||!Number.isFinite(Number(value)))throw errorFor(row.device||row,`${axis.toUpperCase()} 坐标无效`)
    return Number(value)
}
function reference(rows,id) {
    if(id===undefined||id===null||id==='')throw Error('请选择范围内的基准设备')
    const found=rows.find(row=>String(row.id??row.device?.id)===String(id))
    if(!found)throw Error('请选择范围内的基准设备')
    return found
}

/** Only row.z changes; an explicitly chosen reference stays exactly fixed. */
export function alignLoadingFaces(rows,referenceId) {
    if(rows.length<2)throw Error('同一设备线至少需要两台设备')
    rows.forEach(assertRailDirection)
    const direction=rows[0].direction
    if(rows.some(r=>r.direction!==direction))throw Error('进料面必须朝向同一侧导轨')
    for(const row of rows)if(!Number.isFinite(row.faceOffset))throw errorFor(row.device||row,'进料面测量值无效')
    const anchor=referenceId===undefined||referenceId===null?null:reference(rows,referenceId)
    // The old nearest-to-rail rule remains the default for callers without a reference.
    const front=anchor?coordinate(anchor,'z')+anchor.faceOffset:direction*Math.max(...rows.map(r=>direction*(coordinate(r,'z')+r.faceOffset)))
    return rows.map(row=>({...row,z:row===anchor?coordinate(row,'z'):round(front-row.faceOffset)}))
}

/** Only row.y changes; height alignment has no rail/orientation restriction. */
export function alignLoadingHeights(rows,referenceId) {
    if(rows.length<2)throw Error('送料高度对齐至少需要两台设备')
    const anchor=reference(rows,referenceId)
    for(const row of rows)if(!Number.isFinite(row.heightOffset))throw errorFor(row.device||row,'送料高度无法可靠判定，请配置进出料口')
    const height=coordinate(anchor,'y')+anchor.heightOffset
    return rows.map(row=>({...row,y:row===anchor?coordinate(row,'y'):round(height-row.heightOffset)}))
}

/** One measurement owns its loaded assets and reclaims them on every exit. */
export async function measureLoadingPorts(rows,models,{load=loadConfiguredGltf,dispose=disposeSceneObject,kind='inlet',requireRailDirection=false,requireHeight=true,signal}={}) {
    const assets=new Map()
    try {
        const measured=[]
        for(const row of rows) {
            const device=row.device||row,model=models.find(m=>String(m.id)===String(device.model_type))||{}
            const file=device.model_file||model.file_path,portKind=row.portKind||kind
            if(!file)throw errorFor(device,'没有模型文件')
            const configured=resolveLoadingPort(model,device,portKind),metadata=parsedObject(model.metadata)
            let root=null
            if(!configured&&!own(metadata,'loadingPorts')) {
                const url=resolveBackendAssetUrl(file)
                if(!assets.has(url)) {
                    const loaded=await load(url,{signal}),scene=loaded?.scene||loaded?.scenes?.[0]
                    if(!scene)throw errorFor(device,'模型文件中没有可用场景')
                    assets.set(url,scene)
                }
                root=assets.get(url)
            }
            const port=effectivePort(root,device,model,portKind,row.direction,requireHeight)
            const result={...row,...projectPort(port,device,model),portKind}
            if(requireRailDirection)assertRailDirection(result)
            measured.push(result)
        }
        return measured
    } finally {
        // A test/parser can return one root for different URLs; dispose it once.
        for(const root of new Set(assets.values()))dispose(root)
    }
}

export function measureLoadingFaces(rows,models,options={}) {
    return measureLoadingPorts(rows,models,{...options,kind:'inlet',requireRailDirection:true,requireHeight:false})
}
