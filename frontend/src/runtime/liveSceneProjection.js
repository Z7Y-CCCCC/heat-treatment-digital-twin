import * as THREE from 'three'

const reflection=new THREE.Matrix4().makeScale(-1,1,1)
const vector=value=>new THREE.Vector3(-value[0],value[1],value[2])
const matrix=new THREE.Matrix4(),parentInverse=new THREE.Matrix4()

export function projectionViewport(aspect,width=1920,height=1080) {
  const safe=Number.isFinite(aspect) && aspect>0 ? aspect:width/height
  const fittedWidth=Math.min(width,height*safe),fittedHeight=fittedWidth/safe
  return {x:(width-fittedWidth)/2,y:(height-fittedHeight)/2,width:fittedWidth,height:fittedHeight}
}

export function applyLiveDevicePoses(sceneState,frame) {
  if(!sceneState || !frame?.available)return 0
  sceneState.root.updateMatrixWorld(true)
  const anchors=new Map(sceneState.anchors.map(anchor=>[anchor.id,anchor]))
  let count=0
  for(const row of frame.devices || []){
    const root=sceneState.devices.get(row.id)
    if(!root || !Array.isArray(row.matrix) || row.matrix.length!==16 || !row.matrix.every(Number.isFinite))continue
    // glTFast reflects X. S * UnityWorld * S expresses its device pose in
    // Three's world; undo the authored parent before assigning local space.
    matrix.fromArray(row.matrix).premultiply(reflection).multiply(reflection)
    parentInverse.copy(root.parent?.matrixWorld || new THREE.Matrix4()).invert()
    root.matrix.copy(parentInverse.multiply(matrix));root.matrixAutoUpdate=false
    root.visible=row.visible!==false;root.updateMatrixWorld(true)
    const anchor=anchors.get(row.id)
    if(anchor && Array.isArray(row.anchor) && row.anchor.length===3){anchor.position.copy(vector(row.anchor));anchor.visible=row.visible!==false}
    count++
  }
  return count
}

export function applyLiveCamera(camera,controls,frame) {
  const value=frame?.camera
  if(!value)return
  camera.position.copy(vector(value.position));camera.up.copy(vector(value.up))
  camera.lookAt(vector(value.forward).add(camera.position))
  camera.fov=value.fov;camera.aspect=value.aspect;camera.near=value.near;camera.far=value.far
  camera.updateProjectionMatrix()
  if(controls)controls.target.copy(vector(value.target))
}

export function createProjectionReceiver(maxAge=1800) {
  let last=null,lastAt=0
  return {
    accept(frame,now=Date.now()) {
      if(frame?.available===false){last=null;lastAt=0;return true}
      if(!frame?.available || !frame.camera || !Array.isArray(frame.devices) || !Number.isSafeInteger(frame.seq))return false
      if(last?.streamId===frame.streamId && frame.seq<=last.seq)return false
      last=frame;lastAt=now;return true
    },
    current(now=Date.now()){return last && now-lastAt<=maxAge ? last:null},
    clear(){last=null;lastAt=0}
  }
}
