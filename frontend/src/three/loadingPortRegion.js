import * as T from 'three'
import { normalizeLoadingPortRegion, loadingPortRegionDatum } from '../../../shared/loadingPorts.mjs'

const fail=message=>{throw Error(message)}
export function loadingPortRegionSurface(hit,root,viewDirection=null) {
  if (!root || !hit?.object || !hit.point?.toArray().every(Number.isFinite) || !hit.face?.normal) fail('请在模型真实料口的竖直表面开始画区域')
  let belongs=false
  for(let node=hit.object;node;node=node.parent){if(node.userData?.loadingPortEditor)fail('不能在选区标记上重新选面');if(node===root){belongs=true;break}}
  if(!belongs)fail('选区不属于当前模型')
  root.updateMatrixWorld(true)
  const inverse=root.matrixWorld.clone().invert(),relative=inverse.clone().multiply(hit.object.matrixWorld)
  if(!Number.isFinite(relative.determinant())||relative.determinant()===0)fail('模型表面坐标不可逆，无法画区域')
  const normal=hit.face.normal.clone().applyMatrix3(new T.Matrix3().getNormalMatrix(relative)).normalize()
  if(!normal.toArray().every(Number.isFinite)||Math.abs(normal.y)>.25)fail('顶面、地面或倾斜面不能作为竖直料口，请转到料口正面再画')
  if(viewDirection&&Math.abs(new T.Vector3(...viewDirection).normalize().dot(normal))<.18)fail('当前接近俯视或侧视，无法可靠画竖直料口；请转到料口正面')
  return {position:hit.point.clone().applyMatrix4(inverse).toArray(),surfaceNormal:normal.toArray(),nodeName:hit.object.name||'',objectId:hit.object.uuid}
}
export function loadingPortRegionFromSurfaces(first,second) {
  const a=new T.Vector3(...first.position),b=new T.Vector3(...second.position),normal=new T.Vector3(...first.surfaceNormal).normalize(),endNormal=new T.Vector3(...second.surfaceNormal).normalize()
  const tolerance=Math.max(a.length(),b.length(),1)*1e-5
  if(normal.dot(endNormal)<.995||Math.abs(b.clone().sub(a).dot(normal))>tolerance)fail('两个角点落在不同面或不同深度；请只框同一料口平面')
  const u=new T.Vector3(0,1,0).cross(normal).normalize(),v=normal.clone().cross(u).normalize()
  if(v.y<0)v.negate()
  const delta=b.clone().sub(a),du=delta.dot(u),dv=delta.dot(v)
  if(Math.abs(du)<tolerance||Math.abs(dv)<tolerance)fail('区域宽高过小；请拖出一个有宽度和高度的料口矩形')
  const origin=a.clone().addScaledVector(u,Math.min(du,0)).addScaledVector(v,Math.min(dv,0)),width=Math.abs(du),height=Math.abs(dv)
  const corners=[origin,origin.clone().addScaledVector(u,width),origin.clone().addScaledVector(u,width).addScaledVector(v,height),origin.clone().addScaledVector(v,height)].map(p=>p.toArray())
  const region=normalizeLoadingPortRegion({version:1,corners,surfaceNormal:normal.toArray(),nodeName:first.nodeName||''}),horizontal=normal.clone().setY(0).normalize()
  return {position:loadingPortRegionDatum(region),direction:horizontal.toArray(),nodeName:first.nodeName||'',region}
}
export function loadingPortRegionSize(region) {
  return {width:new T.Vector3(...region.corners[1]).distanceTo(new T.Vector3(...region.corners[0])),height:new T.Vector3(...region.corners[3]).distanceTo(new T.Vector3(...region.corners[0]))}
}
