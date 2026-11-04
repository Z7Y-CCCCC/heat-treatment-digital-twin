const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {buildMetadata,calibrateDoorBindings,doorTravel,movingNodes,fixedDoorNodes,groups}=require('../../tools/model-profiles/ultrasonic_cleaner_cad.cjs');
const cleanerGlb=process.env.CLEANER_GLB||require('node:path').join(__dirname,'../assets/models/ultrasonic_cleaner_cad.glb');

test('packaged cleaner loads its CAD and authored defaults without a local upload database',()=>{
    const model=require('../services/builtinModels').getBuiltinModels().find(model=>model.id==='ultrasonic_cleaner_cad');
    assert.equal(model.file_path,'/assets/models/ultrasonic_cleaner_cad.glb');
    const metadata=JSON.parse(model.metadata);
    assert.equal(metadata.inspection.parts.length,9);
    assert.equal(metadata.partBindings.length,20);
    assert.deepEqual(metadata,buildMetadata(metadata));
    assert.ok(fs.statSync(require('node:path').join(__dirname,'..',model.file_path)).size>1000);
});

function readCadGeometry(file) {
    const THREE=require('../../frontend/node_modules/three');
    const binary=fs.readFileSync(file),length=binary.readUInt32LE(12);
    const gltf=JSON.parse(binary.toString('utf8',20,20+length)),binStart=20+length+8;
    function attribute(index) {
        const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView];
        const count={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],size={5121:1,5123:2,5125:4,5126:4}[a.componentType];
        const read={5121:'readUInt8',5123:'readUInt16LE',5125:'readUInt32LE',5126:'readFloatLE'}[a.componentType];
        const array=a.componentType===5126?new Float32Array(a.count*count):new Uint32Array(a.count*count);
        for(let i=0;i<a.count;i++)for(let c=0;c<count;c++)array[i*count+c]=binary[read](binStart+(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||count*size)+c*size);
        return new THREE.BufferAttribute(array,count);
    }
    const objects=gltf.nodes.map(node=>{
        const object=new THREE.Group();object.name=node.name;
        if(node.matrix)new THREE.Matrix4().fromArray(node.matrix).decompose(object.position,object.quaternion,object.scale);
        if(node.translation)object.position.fromArray(node.translation);
        if(node.rotation)object.quaternion.fromArray(node.rotation);
        if(node.scale)object.scale.fromArray(node.scale);
        for(const p of gltf.meshes[node.mesh]?.primitives||[]) {
            const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',attribute(p.attributes.POSITION));
            if(p.indices!==undefined)geometry.setIndex(attribute(p.indices));
            object.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide})));
        }
        return object;
    });
    gltf.nodes.forEach((node,index)=>(node.children||[]).forEach(child=>objects[index].add(objects[child])));
    const root=new THREE.Group();gltf.scenes[gltf.scene||0].nodes.forEach(index=>root.add(objects[index]));root.updateMatrixWorld(true);
    return {THREE,objects,root,byName:new Map(objects.map(object=>[object.name,object]))};
}

test('packaged cleaner and portable motion rig omit the detached pneumatic pipe assembly',()=>{
    const path=require('node:path');
    for(const file of [cleanerGlb,path.join(__dirname,'../assets/motions/ultrasonic_cleaner_cad.glb')]){
        const binary=fs.readFileSync(file),gltf=JSON.parse(binary.toString('utf8',20,20+binary.readUInt32LE(12)));
        assert.ok(!gltf.nodes.some(node=>node.name==='221_气动管路'),'floating pipes must be removed from the asset, not just hidden in one viewer');
        for(const name of [...movingNodes,...fixedDoorNodes,...groups.flatMap(group=>group[2])])assert.ok(gltf.nodes.some(node=>node.name===name),name+' must remain');
    }
});

test('door calibration preserves authored bindings except the owned door endpoints',()=>{
    const source=buildMetadata({});
    source.partBindings[0].transition_duration=4.5;
    source.partBindings.push({id:'custom_site_binding',output_min:10,output_max:20});
    const before=structuredClone(source.partBindings),result=calibrateDoorBindings(source.partBindings);
    assert.deepEqual(source.partBindings,before);
    assert.equal(result[0].transition_duration,4.5);
    assert.deepEqual(result.at(-1),before.at(-1));
});
test('CAD motion profile preserves other bindings and is repeatable',()=>{
    const source={runtime:{otherFlag:true},inspection:{parts:[]},partBindings:[{id:'site_signal',node_name:'other',source_key:'alarm',action:'color'}]};
    const result=buildMetadata(source);
    assert.equal(result.partBindings.length,21);assert.equal(result.partBindings[0].id,'site_signal');
    assert.equal(result.inspection.parts.length,9);assert.equal(result.runtime.otherFlag,true);
    assert.deepEqual(buildMetadata(result),result);
    assert.ok(fixedDoorNodes.every(n=>!movingNodes.includes(n)));
    assert.ok(result.partBindings.slice(1).every(b=>b.axis==='z'&&b.transition_duration===3&&b.input_max===1));
});
test('real CAD hierarchy lifts the door and cylinder rod vertically while keeping guides and barrel fixed',()=>{
    const THREE=require('../../frontend/node_modules/three');
    const binary=fs.readFileSync(cleanerGlb),gltf=JSON.parse(binary.toString('utf8',20,20+binary.readUInt32LE(12)));
    const objects=gltf.nodes.map(node=>{
        const obj=new THREE.Object3D();obj.name=node.name;
        if(node.matrix)new THREE.Matrix4().fromArray(node.matrix).decompose(obj.position,obj.quaternion,obj.scale);
        return obj;
    });
    gltf.nodes.forEach((node,index)=>(node.children||[]).forEach(child=>objects[index].add(objects[child])));
    const root=objects[gltf.scenes[gltf.scene||0].nodes[0]];root.updateMatrixWorld(true);
    const byName=new Map(objects.map(obj=>[obj.name,obj]));
    const before=new Map(objects.map(obj=>[obj.name,obj.getWorldPosition(new THREE.Vector3())]));
    for(const name of [...movingNodes,...fixedDoorNodes,...groups.flatMap(g=>g[2])])assert.ok(byName.has(name),name);
    for(const name of movingNodes)byName.get(name).position.z+=.4;
    root.updateMatrixWorld(true);
    for(const name of movingNodes){const delta=byName.get(name).getWorldPosition(new THREE.Vector3()).sub(before.get(name));assert.ok(Math.abs(delta.y-.4)<.001,`${name} must move upward`);assert.ok(Math.hypot(delta.x,delta.z)<.001);}
    for(const name of fixedDoorNodes)assert.ok(byName.get(name).getWorldPosition(new THREE.Vector3()).distanceTo(before.get(name))<1e-8,name+' must remain stationary');
});

test('real door mesh fully covers the front aperture when closed and clears it when open',()=>{
    const {THREE,root,byName,objects}=readCadGeometry(cleanerGlb);
    const door=byName.get('108_炉门'),panel=byName.get('006_前面板');
    const aperture=new THREE.Box3().setFromObject(objects.find(object=>object.name.startsWith('008_')));
    const ray=new THREE.Raycaster(),samples=[];
    for(let x=aperture.min.x+.02;x<aperture.max.x-.02;x+=.025)for(let y=aperture.min.y+.02;y<aperture.max.y-.02;y+=.025){
        const origin=new THREE.Vector3(x,y,aperture.min.z-2);ray.set(origin,new THREE.Vector3(0,0,1));
        if(!ray.intersectObject(panel,true).length)samples.push(origin);
    }
    assert.ok(samples.length>500,'sample the actual open aperture rather than its surrounding frame');
    const initial=new Map(movingNodes.map(name=>[name,byName.get(name).position.z]));
    for(const [endpoint,expected] of [[doorTravel.closed,true],[doorTravel.open,false]]){
        for(const name of movingNodes)byName.get(name).position.z=initial.get(name)+endpoint;
        root.updateMatrixWorld(true);
        for(const origin of samples){ray.set(origin,new THREE.Vector3(0,0,1));assert.equal(ray.intersectObject(door,true).length>0,expected,`door coverage at ${origin.x}, ${origin.y}, endpoint ${endpoint}`);}
    }
});
