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
        for(const suffix of ['housing','lining','hood','upper_housing','tank','tanks','filter_tank','fans_enamel','cold_housing','hot_housing','refractory','vault_bricks','partition_shell','partition_lining','quench_tank','quench_liquid'])this.rig.node(suffix)?.traverse(o=>{if(o.isMesh){const mats=[].concat(o.material).map(m=>{const c=m.clone();c.userData.previewOpacity=m.opacity;c.userData.previewTransparent=m.transparent;return c});o.material=Array.isArray(o.material)?mats:mats[0];this.shell.push(...mats)}})
        this.setCutaway(true);this.resetCamera()
    }
    setCutaway(value){this.shell?.forEach(m=>{const opacity=m.userData.previewOpacity??1;m.transparent=value||!!m.userData.previewTransparent;m.opacity=value ? Math.min(.16,opacity) : opacity;m.depthWrite=!m.transparent})}
    apply(id,time){return this.rig?.apply(id,time)}
    resize(){const rect=this.container.getBoundingClientRect();this.camera.aspect=Math.max(1,rect.width)/Math.max(1,rect.height);this.camera.updateProjectionMatrix();this.renderer.setSize(Math.max(1,rect.width),Math.max(1,rect.height))}
    resetCamera(){
        if(!this.bounds)return
        const b=this.bounds,size=b.getSize(new T.Vector3()),scale=10/Math.max(size.x,size.y,size.z,.001)
        const pose=fitCameraBox({minX:b.min.x*scale,maxX:b.max.x*scale,minY:b.min.y*scale,maxY:b.max.y*scale,minZ:b.min.z*scale,maxZ:b.max.z*scale},{fov:this.camera.fov,aspect:this.camera.aspect,direction:[1,.5,1.25],margin:1.25})
        this.controls.target.fromArray(pose.target).multiplyScalar(1/scale);this.camera.position.fromArray(pose.position).multiplyScalar(1/scale);this.camera.lookAt(this.controls.target);this.controls.update()
    }
    setActive(value){if(this.disposed)return;cancelAnimationFrame(this.raf);this.active=value;if(value)this.raf=requestAnimationFrame(this.render)}
    dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.observer.disconnect();this.controls.dispose();this.rig?.dispose();this.release(this.scene);this.renderer.dispose();this.renderer.forceContextLoss();this.renderer.domElement.remove()}
}
