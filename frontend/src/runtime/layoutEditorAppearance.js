import * as THREE from 'three'

// Layout editing needs readable silhouettes, not PBR/metal reflections. This
// policy is opt-in per renderer; cached assets and the live screen stay intact.
export function layoutEditorMaterial(source,{instanced=false}={}) {
    const color=new THREE.Color(0xb7bec4)
    const material=new THREE.MeshLambertMaterial({
        name:source?.name||'layout_editor_solid',color:instanced?0xffffff:color,
        side:source?.side??THREE.FrontSide,vertexColors:instanced,
        transparent:false,opacity:1,depthWrite:true
    })
    material.userData={...(source?.userData||{}),baseColor:color,layoutEditor:true}
    return material
}

export function applyLayoutEditorAppearance(model) {
    const replacements=new Map()
    const replace=source=>{
        if(!source)return source
        if(!replacements.has(source))replacements.set(source,layoutEditorMaterial(source))
        return replacements.get(source)
    }
    model.traverse(child=>{
        if(!child.isMesh||child===model.statusLight)return
        child.material=Array.isArray(child.material)?child.material.map(replace):replace(child.material)
        child.castShadow=false;child.receiveShadow=false
    })
    // Imported and procedural models keep their own material collections for
    // update/disposal. Do not leave them pointing at replaced PBR instances.
    if(model.materials instanceof Set)model.materials=new Set([...model.materials].map(m=>replacements.get(m)||m))
    else if(Array.isArray(model.materials))model.materials=model.materials.map(m=>replacements.get(m)||m)
    replacements.forEach((_material,original)=>original.dispose())
    return model
}
