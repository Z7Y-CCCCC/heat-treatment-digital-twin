import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {restoreGltfNodeNames} from './gltfNodeIdentity.js'
export class WaterCoolingScene {
    constructor(container,onTick){
        this.container=container;this.scene=new T.Scene();this.scene.background=new T.Color('#edf3f6')
        this.camera=new T.PerspectiveCamera(38,1,.03,100)
        this.renderer=new T.WebGLRenderer({antialias:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));this.renderer.outputColorSpace=T.SRGBColorSpace
        container.appendChild(this.renderer.domElement);this.renderer.domElement.setAttribute('aria-label','水冷槽升降与搅拌三维动画')
        this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true
        this.scene.add(new T.HemisphereLight(0xffffff,0x6d8990,2.4));const key=new T.DirectionalLight(0xffffff,3);key.position.set(4,8,5);this.scene.add(key)
        const fill=new T.DirectionalLight(0xe0efff,2);fill.position.set(-5,4,-6);this.scene.add(fill)
        this.scene.add(new T.GridHelper(10,40,0x9fb7c1,0xd4e0e5));this.resetCamera()
        this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(container);this.resize()
        let previous=performance.now();this.render=now=>{if(this.disposed||this.active===false)return;onTick(Math.min(.1,Math.max(0,(now-previous)/1000)));previous=now;this.controls.update();this.renderer.render(this.scene,this.camera);this.raf=requestAnimationFrame(this.render)}
        this.raf=requestAnimationFrame(this.render)
    }
    resize(){const r=this.container.getBoundingClientRect();this.camera.aspect=Math.max(1,r.width)/Math.max(1,r.height);this.camera.updateProjectionMatrix();this.renderer.setSize(Math.max(1,r.width),Math.max(1,r.height))}
    resetCamera(){this.camera.position.set(5.2,4.5,6.5);this.controls.target.set(-.4,1.9,.3);this.controls.update()}
    async load(url){
        const gltf=await new GLTFLoader().loadAsync(url);restoreGltfNodeNames(gltf)
        if(this.disposed){this.release(gltf.scene);return}
        this.model=gltf.scene;this.scene.add(this.model);this.nodes={};this.model.traverse(n=>{this.nodes[n.name]=n})
        this.shell=[];for(const name of ['tank_shell','side_reservoir','exhaust_hood'])this.nodes[name]?.traverse(n=>{if(n.isMesh){n.material=n.material.clone();this.shell.push(n)}})
        const geometry=new T.SphereGeometry(.012,6,4),mat=new T.MeshBasicMaterial({color:'#49badb',transparent:true,opacity:.8})
        this.drops=new T.Group();for(let i=0;i<28;i++){const o=new T.Mesh(geometry,mat);o.userData.index=i;this.drops.add(o)}this.scene.add(this.drops)
        this.setCutaway(this.cutaway??true)
    }
    setCutaway(value){this.cutaway=value;this.shell?.forEach(n=>{n.material.transparent=value;n.material.opacity=value?.15:1;n.material.depthWrite=!value})}
    apply(frame){
        if(!this.nodes)return
        this.nodes.lift_carriage.position.y=1.633-frame.down*1.05
        this.nodes.hoist_shaft.rotation.x=frame.hoistAngle;this.nodes.agitator_rotor.rotation.y=frame.rotorAngle
        this.nodes.water_level.position.y=.16+frame.level*1.2
        this.nodes.quench_bubbles.scale.setScalar(frame.bubbles?1:.00001)
        this.nodes.quench_bubbles.position.y=frame.bubbles?Math.sin(frame.elapsed*3)*.04:0
        for(const n of this.nodes.lift_chains.children)n.scale.y=1+frame.down*1.05/1.16
        this.drops.visible=frame.dripping
        this.drops.children.forEach((drop,i)=>drop.position.set((i%7-3)*.14,1.63-((frame.elapsed*1.4+i*.11)%1)*.35,Math.floor(i/7)*.15-.23))
    }
    setActive(value){if(this.disposed)return;cancelAnimationFrame(this.raf);this.active=value;if(value)this.raf=requestAnimationFrame(this.render)}
    release(root){const g=new Set(),m=new Set();root?.traverse(n=>{if(n.geometry)g.add(n.geometry);for(const mat of [].concat(n.material||[]))m.add(mat)});g.forEach(x=>x.dispose());m.forEach(x=>x.dispose())}
    dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.observer.disconnect();this.controls.dispose();this.release(this.scene);this.renderer.dispose();this.renderer.domElement.remove()}
}
