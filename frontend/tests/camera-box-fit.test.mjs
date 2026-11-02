import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector3, PerspectiveCamera } from 'three'
import { fitCameraBox } from '../src/utils/cameraBoxFit.js'
for (const aspect of [.65, 1.1, 2.4]) test(`long buried workshop fits completely in a perspective view at aspect ${aspect}`, () => {
    const bounds = { minX: -35, maxX: 35, minY: -5, maxY: 8, minZ: -10, maxZ: 10 }
    const fit = fitCameraBox(bounds, { aspect })
    const camera = new PerspectiveCamera(42, aspect, .1, 1000)
    camera.position.fromArray(fit.position); camera.lookAt(new Vector3(...fit.target)); camera.updateMatrixWorld(true)
    for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) for (const z of [bounds.minZ, bounds.maxZ]) {
        const projected = new Vector3(x, y, z).project(camera)
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z < 1, `cropped corner ${x}, ${y}, ${z}`)
    }
})
