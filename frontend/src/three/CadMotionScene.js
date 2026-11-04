import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {restoreGltfNodeNames} from './gltfNodeIdentity.js'
import {CadMotionRig} from './CadMotionRig.js'
import {fitCameraBox} from '../utils/cameraBoxFit.js'
export class CadMotionScene {
    constructor(container,onTick){
        this.container=container;this.scene=new T.Scene();this.scene.background=new T.Color('#eff4f7')
        this.camera=new T.PerspectiveCamera(38,1,.01,100)
        this.renderer=new T.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));this.renderer.outputColorSpace=T.SRGBColorSpace
        container.appendChild(this.renderer.domElement);this.renderer.domElement.setAttribute('aria-label','CAD 设备动作三维演示')
        this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true
        this.scene.add(new T.HemisphereLight(0xffffff,0x718c9d,2.2))
        for(const [p,power] of [[[4,8,6],2.7],[[-6,5,-4],1.7]]){const light=new T.DirectionalLight(0xffffff,power);light.position.fromArray(p);this.scene.add(light)}
        this.scene.add(new T.GridHelper(12,48,0x9eb6c8,0xd3dfe8))
        this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(container);this.resize()
        let previous=performance.now();this.render=now=>{if(this.disposed||this.active===false)return;const delta=Math.min(.1,Math.max(0,(now-previous)/1000));previous=now;onTick(delta);this.controls.update();this.renderer.render(this.scene,this.camera);this.raf=requestAnimationFrame(this.render)}
        this.raf=requestAnimationFrame(this.render)
    }
    release(root){const g=new Set(),m=new Set(),textures=new Set();root.traverse(o=>{if(o.geometry)g.add(o.geometry);for(const mat of [].concat(o.material||[]))m.add(mat)});for(const mat of m)for(const value of Object.values(mat))if(value?.isTexture)textures.add(value);textures.forEach(o=>o.dispose());g.forEach(o=>o.dispose());m.forEach(o=>o.dispose())}
    async load(url,id){
        const gltf=await new GLTFLoader().loadAsync(url);restoreGltfNodeNames(gltf)
        if(this.disposed){this.release(gltf.scene);return}
        this.model=gltf.scene;this.scene.add(this.model);this.bounds=new T.Box3().setFromObject(this.model)
        this.rig=new CadMotionRig(this.model,id);this.shell=[]
        for(const suffix of ['housing','lining','hood','upper_housing','tank','tanks','central_lower_body','lower_collection','filter_tank','fans_enamel','cold_housing','hot_housing','refractory','vault_bricks','partition_shell','partition_lining','hot_access_panels','hot_rear_hatch','quench_tank','quench_liquid'])this.rig.node(suffix)?.traverse(o=>{if(o.isMesh){const mats=[].concat(o.material).map(m=>{const c=m.clone();c.userData.previewOpacity=m.opacity;c.userData.previewTransparent=m.transparent;return c});o.material=Array.isArray(o.material)?mats:mats[0];this.shell.push(...mats)}})
        this.oilDoorShell=[]
        if(id==='cad_multipurpose_furnace_082000')for(const suffix of ['door','tank_lids','tank_baffles','cold_front_hatches'])this.rig.node(suffix)?.traverse(node=>{
            if(!node.isMesh)return
            const materials=[].concat(node.material).map(material=>{const clone=material.clone();clone.userData.previewOpacity=material.opacity;clone.userData.previewTransparent=material.transparent;this.oilDoorShell.push(clone);return clone})
            node.material=Array.isArray(node.material)?materials:materials[0]
        })
        this.setCutaway(true);this.resetCamera()
    }
    setCutaway(value){
        this.cutaway=value
        const apply=(material,enabled)=>{const opacity=material.userData.previewOpacity??1;material.transparent=enabled||!!material.userData.previewTransparent;material.opacity=enabled?Math.min(.16,opacity):opacity;material.depthWrite=!material.transparent}
        this.shell?.forEach(material=>apply(material,value));this.oilDoorShell?.forEach(material=>apply(material,value&&this.oilView))
    }
    apply(id,time){return this.rig?.apply(id,time)}
    resize(){const rect=this.container.getBoundingClientRect();this.camera.aspect=Math.max(1,rect.width)/Math.max(1,rect.height);this.camera.updateProjectionMatrix();this.renderer.setSize(Math.max(1,rect.width),Math.max(1,rect.height))}
    resetCamera(){
        if(!this.bounds)return
        this.oilView=false;this.cartHookView=false;this.setCutaway(this.cutaway??true);this.frameBox(this.bounds)
    }
    focusOilDrainage(){
        if(this.rig?.id!=='cad_multipurpose_furnace_082000')return
        this.model.updateWorldMatrix(true,false);this.oilView=true;this.setCutaway(this.cutaway??true)
        const box=new T.Box3(new T.Vector3(-.48,this.rig.authoringY(1.23),-1.66),new T.Vector3(.48,this.rig.authoringY(1.94),-.3)).applyMatrix4(this.model.matrixWorld)
        this.frameBox(box,[.15,.03,1.4])
    }
    focusCartHook(){
        if(this.rig?.id!=='cad_transfer_cart_101300')return
        this.model.updateWorldMatrix(true,false);this.cartHookView=true
        const box=new T.Box3(new T.Vector3(-.75,1.15,-.43),new T.Vector3(.8,1.62,.43)).applyMatrix4(this.model.matrixWorld)
        this.frameBox(box,[-.8,.7,1.2])
    }
    focusMultipurposeCycle(){
        if(this.rig?.id!=='cad_multipurpose_furnace_082000')return
        this.oilView=true;this.setCutaway(this.cutaway??true)
        this.frameBox(this.bounds,[1.7,.5,.75])
    }
    frameBox(b,direction=[1,.5,1.25]){
        const size=b.getSize(new T.Vector3()),scale=10/Math.max(size.x,size.y,size.z,.001)
        const pose=fitCameraBox({minX:b.min.x*scale,maxX:b.max.x*scale,minY:b.min.y*scale,maxY:b.max.y*scale,minZ:b.min.z*scale,maxZ:b.max.z*scale},{fov:this.camera.fov,aspect:this.camera.aspect,direction,margin:1.25})
        this.controls.target.fromArray(pose.target).multiplyScalar(1/scale);this.camera.position.fromArray(pose.position).multiplyScalar(1/scale);this.camera.lookAt(this.controls.target);this.controls.update()
    }
    setActive(value){if(this.disposed)return;cancelAnimationFrame(this.raf);this.active=value;if(value)this.raf=requestAnimationFrame(this.render)}
    dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.observer.disconnect();this.controls.dispose();this.rig?.dispose();this.release(this.scene);this.renderer.dispose();this.renderer.forceContextLoss();this.renderer.domElement.remove()}
}
