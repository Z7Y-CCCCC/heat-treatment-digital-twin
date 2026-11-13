import * as T from 'three'
import {CAD_MOTION_PROFILES} from './cadMotionProfiles.js'

const CAD_BEDS={
    cad_tempering_furnace_091300:'internal_rollers',cad_cleaner_170700:'internal_rollers',
    cad_multipurpose_furnace_082000:'elevator_basket',cad_water_cooling_tank_471000:'basket',
    cad_lifting_load_table_111400:'roller_bed',cad_fixed_load_table_112200:'roller_bed',
    cad_air_cooling_table_115800ht:'roller_bed',cad_transfer_cart_101300:'roller_bed'
}
const OTHER_BEDS={
    ultrasonic_cleaner_cad:'026_棍子座',
    photo_multipurpose_furnace_v6:'chamber_visible_brushed_metal',
    photo_tempering_furnace_v6:'temper_v6_refractory_chamber_temper_lining'
}

// Measure in the untouched asset's coordinate system before the preview rig
// splits/reparents rollers. An enclosure, doorway or model origin is not a bed.
function nodeMatrix(node,root){
    const chain=[];for(let n=node;n&&n!==root;n=n.parent)chain.push(n)
    return chain.reverse().reduce((matrix,n)=>matrix.multiply(n.matrixAutoUpdate
        ?new T.Matrix4().compose(n.position,n.quaternion,n.scale):n.matrix),new T.Matrix4())
}
export function loadSurfaceBounds(root,node){
    const box=new T.Box3(),point=new T.Vector3()
    node.traverse(mesh=>{
        const positions=mesh.geometry?.attributes.position;if(!positions)return
        const matrix=nodeMatrix(mesh,root)
        for(let i=0;i<positions.count;i++)box.expandByPoint(point.fromBufferAttribute(positions,i).applyMatrix4(matrix))
    })
    if(box.isEmpty())throw Error('设备承料台缺少有效几何数据：'+node.name)
    return box
}
function floorSurface(root,node){
    // The legacy refractory mesh includes its walls and ceiling. Select the
    // largest horizontal floor face below the chamber midpoint, not its roof.
    const bounds=loadSurfaceBounds(root,node),levels=new Map(),a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3()
    node.traverse(mesh=>{
        const p=mesh.geometry?.attributes.position;if(!p)return
        const index=mesh.geometry.index,matrix=nodeMatrix(mesh,root),count=index?.count??p.count
        for(let i=0;i+2<count;i+=3){
            a.fromBufferAttribute(p,index?index.getX(i):i).applyMatrix4(matrix)
            b.fromBufferAttribute(p,index?index.getX(i+1):i+1).applyMatrix4(matrix)
            c.fromBufferAttribute(p,index?index.getX(i+2):i+2).applyMatrix4(matrix)
            if(Math.max(a.y,b.y,c.y)-Math.min(a.y,b.y,c.y)>1e-5||a.y>bounds.getCenter(new T.Vector3()).y)continue
            const area=Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))/2
            if(area<1e-8)continue
            const key=a.y.toFixed(5),level=levels.get(key)||{area:0,box:new T.Box3()}
            level.area+=area;level.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);levels.set(key,level)
        }
    })
    const floor=[...levels.values()].sort((a,b)=>b.area-a.area||b.box.max.y-a.box.max.y)[0]
    if(!floor)throw Error('设备内部缺少可识别的承料平面：'+node.name)
    return floor.box
}
export function measureEquipmentLoadCenters(root,modelId){
    const prefix=CAD_MOTION_PROFILES[modelId]?.prefix
    const name=prefix&&CAD_BEDS[modelId]?prefix+CAD_BEDS[modelId]+'_stainless':OTHER_BEDS[modelId]
    if(!name)return null
    const surface=root.getObjectByName(name)
    if(!surface)throw Error('设备缺少内部承料台节点：'+name)
    const box=modelId==='photo_tempering_furnace_v6'?floorSurface(root,surface):loadSurfaceBounds(root,surface)
    const front=box.getCenter(new T.Vector3());front.y=box.max.y
    let hot=null
    if(modelId==='cad_multipurpose_furnace_082000'){
        const hotSurface=root.getObjectByName(prefix+'hot_rollers_stainless')
        if(!hotSurface)throw Error('多用炉缺少热室承料辊台')
        const hotBox=loadSurfaceBounds(root,hotSurface);hot=hotBox.getCenter(new T.Vector3());hot.y=hotBox.max.y
    }
    return {front,hot}
}

export function equipmentLoadPoint(centers,{chamber=0,basket=0,lift=0}={},basketStroke=0,palletThickness=.08){
    const point=centers.front.clone()
    if(centers.hot)point.lerp(centers.hot,T.MathUtils.clamp(chamber,0,1))
    // The small preview tray is centred about its origin, so its bottom rests
    // on the actual roller crowns. Lowering applies only in the front chamber.
    point.y+=palletThickness/2-basketStroke*basket*(centers.hot?1-T.MathUtils.clamp(chamber,0,1):1)+.24*lift
    return point
}
