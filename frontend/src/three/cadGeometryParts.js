import * as T from 'three'

/** Split disconnected closed geometry while welding only for connectivity tests.
 * Render attributes are copied verbatim, preserving normals/UVs/materials at seams.
 */
export function connectedGeometryParts(mesh) {
    const geometry=mesh.geometry,p=geometry.attributes.position
    const indices=geometry.index?.array || Array.from({length:p.count},(_,i)=>i)
    const keys=new Map(),parents=[],ids=[]
    function find(i){while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i]}return i}
    for(let i=0;i<p.count;i++){
        const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*1e5)).join(',')
        if(!keys.has(key)){keys.set(key,parents.length);parents.push(parents.length)}
        ids.push(keys.get(key))
    }
    for(let i=0;i<indices.length;i+=3){const a=find(ids[indices[i]]);parents[find(ids[indices[i+1]])]=a;parents[find(ids[indices[i+2]])]=a}
    const sets=new Map()
    for(let i=0;i<indices.length;i+=3){const key=find(ids[indices[i]]);if(!sets.has(key))sets.set(key,[]);sets.get(key).push(indices[i],indices[i+1],indices[i+2])}
    return [...sets.values()].map(vertices=>{
        const g=new T.BufferGeometry()
        for(const [name,a] of Object.entries(geometry.attributes)){
            const data=new a.array.constructor(vertices.length*a.itemSize)
            vertices.forEach((v,i)=>{for(let j=0;j<a.itemSize;j++)data[i*a.itemSize+j]=a.array[v*a.itemSize+j]})
            g.setAttribute(name,new T.BufferAttribute(data,a.itemSize,a.normalized))
        }
        const part=new T.Mesh(g,mesh.material);part.position.copy(mesh.position);part.quaternion.copy(mesh.quaternion);part.scale.copy(mesh.scale)
        part.name=mesh.name+'_component';g.computeBoundingBox()
        mesh.parent.add(part);part.updateWorldMatrix(true,false)
        const bounds=g.boundingBox.clone().applyMatrix4(part.matrixWorld)
        return {mesh:part,bounds,center:bounds.getCenter(new T.Vector3()),size:bounds.getSize(new T.Vector3())}
    })
}
