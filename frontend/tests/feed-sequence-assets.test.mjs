import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { TRANSFER_MODEL_PROFILES, planFeedPlacement } from '../src/three/feedSequence.js'

function assetGeometry(file, rotationY) {
    const buffer = fs.readFileSync(file)
    const gltf = JSON.parse(buffer.toString('utf8', 20, 20 + buffer.readUInt32LE(12)))
    const objects = gltf.nodes.map(node => {
        const object = new THREE.Object3D()
        if (node.matrix) new THREE.Matrix4().fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale)
        if (node.translation) object.position.fromArray(node.translation)
        if (node.rotation) object.quaternion.fromArray(node.rotation)
        if (node.scale) object.scale.fromArray(node.scale)
        return object
    })
    gltf.nodes.forEach((node, i) => (node.children || []).forEach(j => objects[i].add(objects[j])))
    const root = new THREE.Group()
    root.rotation.y = rotationY
    gltf.scenes[gltf.scene || 0].nodes.forEach(i => root.add(objects[i]))
    root.updateMatrixWorld(true)
    const boxAt = i => {
        const node = gltf.nodes[i], box = new THREE.Box3()
        for (const primitive of gltf.meshes[node.mesh]?.primitives || []) {
            const position = gltf.accessors[primitive.attributes.POSITION]
            box.union(new THREE.Box3(new THREE.Vector3(...position.min), new THREE.Vector3(...position.max)).applyMatrix4(objects[i].matrixWorld))
        }
        for (const child of node.children || []) box.union(boxAt(child))
        return box
    }
    return name => {
        const index = gltf.nodes.findIndex(node => node.name === name)
        assert.ok(index >= 0, `Required CAD node ${name}`)
        return boxAt(index)
    }
}

const directory = new URL('../../backend/assets/models/', import.meta.url)
const cleaner = process.env.CLEANER_GLB || new URL('ultrasonic_cleaner_cad.glb', directory)
for (const [id, profile] of Object.entries(TRANSFER_MODEL_PROFILES)) {
    const file = id === 'ultrasonic_cleaner_cad' ? cleaner : new URL(`${id === 'photo_multipurpose_furnace_v6' ? id + '_pipefix' : id}.glb`, directory)
    test(`${profile.label}: cart alignment, load envelope and retract clearance match the actual model`, { skip: !fs.existsSync(file) }, () => {
        const bounds = assetGeometry(file, profile.rotationY)
        const mouth = bounds(profile.mouthNode), door = bounds(profile.doorNode)
        const cart = assetGeometry(new URL('photo_transfer_cart_v6.glb', directory), Math.PI)
        const chassis = cart('cart_v6_node_cart_open_chassis')
        const plan = planFeedPlacement({ mouthMaxX: mouth.max.x, mouthCenterZ: mouth.getCenter(new THREE.Vector3()).z,
            cartLeadingX: chassis.min.x, innerDoorX: door.min.x, materialLength: profile.materialLength })
        assert.ok(plan.dockX + chassis.min.x > mouth.max.x + .15, 'cart chassis stops clear of the machine')
        assert.ok(profile.materialWidth < mouth.max.z - mouth.min.z, 'pallet width fits the opening')
        if (id === 'ultrasonic_cleaner_cad') {
            assert.ok(plan.materialY > mouth.min.y, 'load enters above the sill')
            assert.ok(plan.materialY + profile.materialHeight < mouth.max.y, 'load passes below the opening top')
        }
        assert.ok(plan.materialStartX - profile.materialLength / 2 > mouth.max.x, 'initial load is outside the machine')
        assert.ok(plan.materialEndX + profile.materialLength / 2 < door.min.x - .1, 'load clears the door closing plane')
        assert.ok(plan.dockX + .0325 > mouth.max.x + .1, 'retracted chain head clears the doorway')
        assert.ok(plan.feedDistance > 0)
    })
}
