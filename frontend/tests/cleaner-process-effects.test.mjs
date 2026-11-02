import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'
import { CleanerProcessEffects } from '../src/three/CleanerProcessEffects.js'
import { CLEANER_EFFECT_NODES } from '../src/three/cleanerProcessLayout.js'

test('real cleaner CAD anchors effects, freezes on pause, keeps housings fixed and restores shared materials', async () => {
    const buffer = fs.readFileSync(new URL('../../backend/assets/models/ultrasonic_cleaner_cad.glb', import.meta.url))
    const gltf = await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '')
    restoreGltfNodeNames(gltf)
    const cad = gltf.scene
    cad.rotation.y = -Math.PI / 2
    cad.updateMatrixWorld(true)
    const fan = cad.getObjectByName(CLEANER_EFFECT_NODES.fan)
    const plate = cad.getObjectByName(CLEANER_EFFECT_NODES.ultrasonic[0])
    const fanMatrix = fan.matrixWorld.clone(), plateMatrix = plate.matrixWorld.clone()
    const heater = cad.getObjectByName(CLEANER_EFFECT_NODES.heaters[0])
    let heaterMesh
    heater.traverse(node => { if (node.isMesh && !heaterMesh) heaterMesh = node })
    const original = heaterMesh.material
    const scene = new THREE.Scene()
    scene.add(cad)
    const effects = new CleanerProcessEffects(scene, cad)
    const { chamber, jets } = effects.layout
    assert.ok(chamber.min.y > 1.17 && chamber.max.y < 2.02)
    assert.equal(jets.length, 30)
    for (const jet of jets) assert.ok(jet.start.x >= chamber.min.x - .1 && jet.start.x < chamber.max.x)
    effects.apply({ time: 10, level: .5, spray: true, heat: true })
    assert.equal(effects.water.visible, true)
    assert.equal(effects.sprayParticles.visible, true)
    assert.ok(effects.water.position.y - effects.water.scale.y / 2 >= chamber.min.y - 1e-6)
    assert.ok(effects.water.position.y + effects.water.scale.y / 2 < chamber.max.y)
    const positions = effects.sprayParticles.geometry.attributes.position.array.slice()
    effects.apply({ time: 10, level: .5, spray: true, heat: true })
    assert.deepEqual(effects.sprayParticles.geometry.attributes.position.array, positions)
    assert.notEqual(heaterMesh.material, original)
    let plateMesh
    plate.traverse(node => { if (node.isMesh && !plateMesh) plateMesh = node })
    const plateOpacity = plateMesh.material.opacity
    effects.setCutaway(true)
    assert.equal(plateMesh.material.opacity, .2)
    effects.setCutaway(false)
    assert.equal(plateMesh.material.opacity, plateOpacity)
    effects.apply({ time: 18, level: 1, ultrasonic: true })
    assert.equal(effects.bubbles.visible, true)
    const bubblePositions = effects.bubbles.geometry.attributes.position
    for (let i = 0; i < bubblePositions.count; i++) {
        assert.ok(chamber.containsPoint(new THREE.Vector3().fromBufferAttribute(bubblePositions, i)), `bubble ${i} stays in the liquid volume`)
    }
    cad.updateMatrixWorld(true)
    assert.deepEqual(fan.matrixWorld, fanMatrix)
    assert.deepEqual(plate.matrixWorld, plateMatrix)
    effects.apply({ time: 30, level: 0, blow: true, wetness: .5 })
    assert.equal(effects.water.visible, false)
    assert.equal(effects.sprayParticles.visible, false)
    assert.equal(effects.air.visible, true)
    effects.apply(null)
    assert.equal(effects.root.visible, false)
    effects.dispose()
    assert.equal(heaterMesh.material, original)
    assert.equal(effects.root.parent, null)
})
