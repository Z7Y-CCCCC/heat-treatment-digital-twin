import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import { CadMotionRig } from '../src/three/CadMotionRig.js'
import { createLiftCylinderAnchors } from '../src/three/liftCylinderPose.js'
import { correctLiftGlb, decodeGlb, encodeGlb, parseLiftGlb, transformLiftSourceGeometry, writeSourceGeometry,
    connectedGeometryVertexGroups, liftAuthoringY, LIFT_MODEL_ID as id, LIFT_MODEL_PREFIX as prefix, runCli } from '../../tools/fix-lift-model-rest-pose.mjs'
import { addLiftCrossshaftToGlb, LIFT_CROSSSHAFT_NODE, LIFT_CROSSSHAFT_RADIUS, LIFT_CROSSSHAFT_LENGTH } from '../../tools/add-lift-source-crossshaft.mjs'

const assetPath = '../../backend/assets/models/' + id + '.glb'
const asset = new URL(assetPath, import.meta.url)
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sourceBytes = () => fs.readFileSync(asset)

function withoutSourceCrossshaft(bytes) {
    const glb = decodeGlb(bytes), index = glb.json.nodes.findIndex(node => node.name === LIFT_CROSSSHAFT_NODE)
    if (index < 0) return bytes
    // The new solid is appended, never inserted into existing saved binding paths.
    assert.equal(index, glb.json.nodes.length - 1)
    const root = glb.json.nodes.find(node => node.name === prefix + 'root')
    const parents = glb.json.nodes.filter(node => node.children?.includes(index))
    assert.equal(parents.length, 1)
    assert.equal(parents[0].name, prefix + 'lift')
    assert.equal(parents[0].children.at(-1), index)
    for (const parent of parents) parent.children = parent.children.filter(child => child !== index)
    delete root.extras.liftCrossshaft
    glb.json.nodes.pop()
    // Keep the unreferenced mesh/accessor/BIN tail. Fixtures need no real asset or backup writes.
    return encodeGlb(glb)
}

async function legacyFixture() {
    const bytes = withoutSourceCrossshaft(sourceBytes()), glb = decodeGlb(bytes), authoredRoot = glb.json.nodes.find(node => node.name === prefix + 'root')
    if (!authoredRoot.extras?.liftCylinderRestPose) return bytes
    // Construct a legacy fixture in memory: no ignored backup files, git history or real asset writes.
    const gltf = await parseLiftGlb(bytes), anchors = createLiftCylinderAnchors(liftAuthoringY(gltf.scene))
    const changed = transformLiftSourceGeometry(gltf.scene, anchors, true)
    writeSourceGeometry(glb, gltf, changed)
    delete authoredRoot.extras.liftCylinderRestPose
    return encodeGlb(glb)
}

function points(root, mesh, indices) {
    root.updateMatrixWorld(true)
    const position = mesh.geometry.attributes.position, matrix = root.matrixWorld.clone().invert().multiply(mesh.matrixWorld)
    return (indices || Array.from({ length: position.count }, (_, index) => index)).map(index => new T.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix))
}
function center(vertices) { return new T.Box3().setFromPoints(vertices).getCenter(new T.Vector3()) }
function sameVertices(actual, expected) {
    for (const [values, other] of [[actual, expected], [expected, actual]]) for (const value of values) assert.ok(other.some(point => point.distanceTo(value) < 3e-6), 'old and corrected source animations occupy the same positions')
}
function assertRawCylinder(root) {
    const marker = root.getObjectByName(prefix + 'root').userData.liftCylinderRestPose
    assert.equal(marker.schemaVersion, 1)
    const base = new T.Vector3(...marker.base), tip = new T.Vector3(...marker.tip), axis = tip.clone().sub(base).normalize(), distance = tip.distanceTo(base)
    const barrel = points(root, root.getObjectByName(prefix + 'hydraulics_teal')), rod = points(root, root.getObjectByName(prefix + 'hydraulics_stainless'))
    for (const values of [barrel, rod]) assert.ok(center(values).sub(base).cross(axis).length() < .002, 'raw source barrel and piston share one axis without a preview helper')
    const interval = values => { const projected = values.map(point => point.clone().sub(base).dot(axis)); return { min: Math.min(...projected), max: Math.max(...projected) } }
    const b = interval(barrel), r = interval(rod)
    assert.ok(Math.abs(b.min) < .004, 'raw barrel stays on the fixed base pin')
    assert.ok(Math.abs(r.max - distance) < .004, 'raw piston tip reaches its upper pin')
    assert.ok(r.min < b.max - .02 && r.min > b.min && r.max > b.max + .01, 'raw piston overlaps and extends from the barrel')
    const mesh = root.getObjectByName(prefix + 'hydraulics_metal')
    const eyes = connectedGeometryVertexGroups(mesh.geometry).map(indices => center(points(root, mesh, indices)))
    assert.ok(eyes.some(eye => eye.distanceTo(base) < .002), 'raw lower mounting eye remains on the fixed base pin')
    assert.ok(eyes.some(eye => eye.distanceTo(tip) < .002), 'raw upper mounting eye is centred on the scissor shaft')
    assert.ok(root.getObjectByName('preview_cylinder') === undefined, 'this is the untouched raw loading path, not an injected rig')
}
function assertRawCrossshaft(root) {
    const authoredRoot = root.getObjectByName(prefix + 'root'), marker = authoredRoot.userData.liftCrossshaft
    assert.deepEqual(marker, { schemaVersion: 1, node: LIFT_CROSSSHAFT_NODE,
        center: authoredRoot.userData.liftCylinderRestPose.tip, axis: [0, 0, 1],
        radius: LIFT_CROSSSHAFT_RADIUS, length: LIFT_CROSSSHAFT_LENGTH })
    const node = root.getObjectByName(LIFT_CROSSSHAFT_NODE), meshes = []
    assert.ok(node, 'raw source includes its own cross shaft without creating CadMotionRig')
    assert.equal(node.parent.name, prefix + 'lift', 'shaft belongs to the existing scissor inspection assembly without changing saved layouts')
    node.traverse(child => { if (child.isMesh) meshes.push(child) })
    assert.equal(meshes.length, 1, 'the authored shaft is exactly one solid')
    assert.equal(connectedGeometryVertexGroups(meshes[0].geometry).length, 1)
    assert.equal(meshes[0].material.name, 'CAD26_metal', 'the shaft reuses the original CAD metal material')
    const values = points(root, meshes[0]), bounds = new T.Box3().setFromPoints(values), tip = new T.Vector3(...marker.center)
    assert.ok(center(values).distanceTo(tip) < 2e-6)
    const size = bounds.getSize(new T.Vector3())
    for (const [actual, expected] of [[size.x, marker.radius * 2], [size.y, marker.radius * 2], [size.z, marker.length]]) assert.ok(Math.abs(actual - expected) < 2e-6)
    const scissorMesh = root.getObjectByName(prefix + 'lift_edge')
    const scissorCentres = connectedGeometryVertexGroups(scissorMesh.geometry).map(indices => center(points(root, scissorMesh, indices)))
    assert.equal(scissorCentres.length, 4)
    for (const p of scissorCentres) {
        assert.ok(Math.hypot(p.x - tip.x, p.y - tip.y) < 2e-6, 'raw shaft passes through all four scissor-arm pivots')
        assert.ok(bounds.min.z < p.z && bounds.max.z > p.z, 'raw shaft spans both left and right scissor pairs')
    }
    const eyeMesh = root.getObjectByName(prefix + 'hydraulics_metal')
    const upperEyes = connectedGeometryVertexGroups(eyeMesh.geometry).map(indices => points(root, eyeMesh, indices)).filter(vertices => center(vertices).distanceTo(tip) < .002)
    assert.equal(upperEyes.length, 1)
    const eyeBounds = new T.Box3().setFromPoints(upperEyes[0])
    assert.ok(bounds.min.z < eyeBounds.min.z && bounds.max.z > eyeBounds.max.z, 'raw shaft extends through both faces of the upper mounting eye')
    assert.ok(Math.min(...upperEyes[0].map(p => Math.hypot(p.x - tip.x, p.y - tip.y))) >= marker.radius - 2e-6, 'shaft fits the actual eye bore rather than intersecting its ring')
    assert.equal(root.getObjectByName('preview_lift_crosshead'), undefined, 'raw model does not depend on a preview-only cross shaft')
}
function nodeWithoutMarker(node) {
    const clone = structuredClone(node)
    if (clone.extras) delete clone.extras.liftCylinderRestPose
    return clone
}
function accessorWithoutBounds(accessor) { const clone = { ...accessor }; delete clone.min; delete clone.max; return clone }

test('offline source repair makes the raw GLB cylinder correct and preserves original nodes, materials, indices, strides and counts', async () => {
    const legacy = await legacyFixture(), originalHash = sha(legacy), original = decodeGlb(legacy)
    const correctedBytes = await correctLiftGlb(legacy), corrected = decodeGlb(correctedBytes)
    assert.equal(sha(legacy), originalHash, 'Buffer input is never mutated')
    assert.notEqual(sha(correctedBytes), originalHash)
    assertRawCylinder((await parseLiftGlb(correctedBytes)).scene)
    assert.deepEqual(corrected.json.nodes.map(nodeWithoutMarker), original.json.nodes.map(nodeWithoutMarker))
    for (const key of ['meshes', 'materials', 'scenes', 'scene', 'bufferViews', 'buffers', 'textures', 'images', 'samplers']) assert.deepEqual(corrected.json[key], original.json[key], key + ' remains unchanged')
    assert.deepEqual(corrected.json.accessors.map(accessorWithoutBounds), original.json.accessors.map(accessorWithoutBounds))
    assert.equal(corrected.bin.length, original.bin.length)
    const repairNodes = new Set(['hydraulics_teal', 'hydraulics_stainless', 'hydraulics_brass', 'hydraulics_metal', 'lift_stainless', 'pivot_detail', 'slide_detail'].map(name => prefix + name))
    const repairMeshes = new Set()
    const collectMeshes = node => { if (node.mesh !== undefined) repairMeshes.add(node.mesh); for (const child of node.children || []) collectMeshes(original.json.nodes[child]) }
    for (const node of original.json.nodes) if (repairNodes.has(node.name)) collectMeshes(node)
    const writable = new Set([...repairMeshes].flatMap(index => original.json.meshes[index].primitives.flatMap(primitive => ['POSITION', 'NORMAL', 'TANGENT'].map(key => primitive.attributes[key]).filter(index => index !== undefined))))
    const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
    for (let index = 0; index < original.json.accessors.length; index++) {
        if (writable.has(index)) continue
        const accessor = original.json.accessors[index], view = original.json.bufferViews[accessor.bufferView], size = componentBytes[accessor.componentType] * components[accessor.type]
        const start = (view.byteOffset || 0) + (accessor.byteOffset || 0), stride = view.byteStride || size
        for (let item = 0; item < accessor.count; item++) {
            const offset = start + item * stride
            assert.ok(corrected.bin.subarray(offset, offset + size).equals(original.bin.subarray(offset, offset + size)), 'indices, UVs and all unrelated mesh attributes remain byte-identical')
        }
    }
})

test('corrected source animates without a second initial correction and remains compatible with unmarked legacy source', async () => {
    const legacy = await legacyFixture(), corrected = await correctLiftGlb(legacy)
    const oldRoot = (await parseLiftGlb(legacy)).scene, newRoot = (await parseLiftGlb(corrected)).scene
    const oldRig = new CadMotionRig(oldRoot, id), newRig = new CadMotionRig(newRoot, id)
    try {
        assert.ok(newRig.cylinder.quaternion.angleTo(new T.Quaternion()) < 1e-6)
        assert.ok(newRig.rod.quaternion.angleTo(new T.Quaternion()) < 1e-6)
        const compare = () => {
            for (const suffix of ['hydraulics_teal_component', 'hydraulics_stainless_component']) sameVertices(points(newRoot, newRoot.getObjectByName(prefix + suffix)), points(oldRoot, oldRoot.getObjectByName(prefix + suffix)))
            sameVertices(points(newRoot, newRoot.getObjectByName('preview_lift_upper_eye')), points(oldRoot, oldRoot.getObjectByName('preview_lift_upper_eye')))
        }
        compare()
        for (const action of ['lift_up', 'lift_down']) for (const time of [0, 2, 4, 6, 8, 4, 0]) { oldRig.apply(action, time); newRig.apply(action, time); compare() }
        for (const lift of [0, .5, 1, .25, 0]) { oldRig.applyLinked({ lift }); newRig.applyLinked({ lift }); compare() }
        oldRig.reset(); newRig.reset(); compare()
    } finally { oldRig.dispose(); newRig.dispose() }
})

test('source correction is marker-idempotent and rejects invalid declarations and unrelated source models', async () => {
    const corrected = await correctLiftGlb(await legacyFixture())
    assert.equal(await correctLiftGlb(corrected), corrected, 'already marked source returns the exact original Buffer')
    const invalid = decodeGlb(corrected), root = invalid.json.nodes.find(node => node.name === prefix + 'root')
    root.extras.liftCylinderRestPose.schemaVersion = 2
    await assert.rejects(correctLiftGlb(encodeGlb(invalid)), /元数据不合法/)
    root.extras.liftCylinderRestPose = null
    await assert.rejects(correctLiftGlb(encodeGlb(invalid)), /元数据不合法/)
    root.name = 'unrelated_model'
    await assert.rejects(correctLiftGlb(encodeGlb(invalid)), /explicit 11\.14 lift source node is absent/)
})

test('adding the source crossshaft is append-only, preserves all previous source bytes and binding paths, and is idempotent', async () => {
    const input = withoutSourceCrossshaft(sourceBytes()), inputHash = sha(input), before = decodeGlb(input)
    const output = await addLiftCrossshaftToGlb(input), after = decodeGlb(output)
    assert.equal(sha(input), inputHash, 'the input Buffer is never mutated')
    assert.equal(after.json.nodes.length, before.json.nodes.length + 1)
    assert.equal(after.json.meshes.length, before.json.meshes.length + 1)
    assert.equal(after.json.accessors.length, before.json.accessors.length + 3)
    assert.equal(after.json.bufferViews.length, before.json.bufferViews.length + 3)
    const addedIndex = before.json.nodes.length
    for (let index = 0; index < before.json.nodes.length; index++) {
        const actual = structuredClone(after.json.nodes[index]), expected = before.json.nodes[index]
        if (expected.name === prefix + 'lift') {
            assert.deepEqual(actual.children, [...expected.children, addedIndex], 'existing sibling indices keep their original order')
            actual.children.pop()
        }
        if (expected.name === prefix + 'root') delete actual.extras.liftCrossshaft
        assert.deepEqual(actual, expected, 'existing source node and saved binding identity remain unchanged')
    }
    for (const key of ['meshes', 'accessors', 'bufferViews']) assert.deepEqual(after.json[key].slice(0, before.json[key].length), before.json[key])
    for (const key of ['materials', 'scenes', 'scene', 'textures', 'images', 'samplers', 'animations', 'skins']) assert.deepEqual(after.json[key], before.json[key])
    assert.ok(after.bin.subarray(0, before.bin.length).equals(before.bin), 'every original mesh and index byte remains intact')
    assertRawCylinder((await parseLiftGlb(output)).scene)
    assertRawCrossshaft((await parseLiftGlb(output)).scene)
    assert.equal(await addLiftCrossshaftToGlb(output), output, 'marked source returns the exact same Buffer without another shaft')
    const invalid = decodeGlb(output)
    invalid.json.nodes.find(node => node.name === prefix + 'root').extras.liftCrossshaft.radius *= 2
    await assert.rejects(addLiftCrossshaftToGlb(encodeGlb(invalid)), /inconsistent/)
})

test('source shaft is reused exactly once by runtime motion while old unmarked assets keep their fallback', async () => {
    const root = (await parseLiftGlb(sourceBytes())).scene
    assertRawCrossshaft(root)
    const rawNode = root.getObjectByName(LIFT_CROSSSHAFT_NODE), rawMeshes = []
    rawNode.traverse(node => { if (node.isMesh) rawMeshes.push(node) })
    const material = rawMeshes[0].material, rawVertices = points(root, rawMeshes[0])
    const oldRoot = (await parseLiftGlb(withoutSourceCrossshaft(sourceBytes()))).scene
    const rig = new CadMotionRig(root, id), oldRig = new CadMotionRig(oldRoot, id)
    try {
        assert.ok(rig.liftCrosshead.isGroup, 'new assets animate an authored part pivot')
        assert.ok(oldRig.liftCrosshead.isMesh, 'old assets retain their synthetic compatibility shaft')
        const shaftMeshes = []
        rig.liftCrosshead.traverse(node => { if (node.isMesh) shaftMeshes.push(node) })
        assert.equal(shaftMeshes.length, 1, 'runtime contains no duplicate shaft')
        const mesh = shaftMeshes[0], geometry = mesh.geometry
        assert.equal(mesh.material, material, 'source material is reused, not a helper material')
        sameVertices(points(root, mesh), rawVertices)
        const baseline = points(root, mesh).map(point => point.sub(rig.liftCrosshead.position))
        const compare = () => {
            assert.equal(mesh.geometry, geometry, 'seeking never rebuilds or replaces the authored solid')
            sameVertices(points(root, mesh).map(point => point.sub(rig.liftCrosshead.position)), baseline)
            sameVertices(points(root, mesh), points(oldRoot, oldRig.liftCrosshead))
            const current = []
            root.traverse(node => { if (node.isMesh && node.name.startsWith(LIFT_CROSSSHAFT_NODE)) current.push(node) })
            assert.deepEqual(current, [mesh])
        }
        compare()
        for (const action of ['lift_up', 'lift_down']) for (const progress of [0, .5, 1, .5, 0]) { rig.apply(action, progress * 8); oldRig.apply(action, progress * 8); compare() }
        for (const lift of [0, .5, 1, 0]) { rig.applyLinked({ lift }); oldRig.applyLinked({ lift }); compare() }
        rig.reset(); oldRig.reset(); compare()
    } finally { rig.dispose(); oldRig.dispose() }
})

test('the checked-in managed GLB is already correct, and its source hash matches both asset and motion registries', async () => {
    const bytes = sourceBytes()
    assertRawCylinder((await parseLiftGlb(bytes)).scene)
    assertRawCrossshaft((await parseLiftGlb(bytes)).scene)
    const registry = JSON.parse(fs.readFileSync(new URL('../../shared/motionPackages.json', import.meta.url), 'utf8')).models[id]
    assert.equal(registry.sourceSha256, sha(bytes))
    assert.equal(registry.rigSha256, sha(fs.readFileSync(new URL('../../backend' + registry.rigPath, import.meta.url))))
    assert.equal(registry.clipSha256, sha(fs.readFileSync(new URL('../../backend' + registry.clipPath, import.meta.url))))
    const manifest = JSON.parse(fs.readFileSync(new URL('../../model-assets.manifest.json', import.meta.url), 'utf8'))
    const entry = manifest.files.find(file => file.path === 'backend/assets/models/' + id + '.glb')
    assert.equal(entry.sha256, sha(bytes)); assert.equal(entry.bytes, bytes.length)
    assert.equal(await correctLiftGlb(bytes), bytes)
})

test('model management uses the original raw source path and imports no runtime rest-pose patch', async () => {
    const admin = fs.readFileSync(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
    assert.doesNotMatch(admin, /modelRestPose|applyModelRestPose|fix-lift-model-rest-pose/)
    const preview = admin.slice(admin.indexOf('async function renderSelectedModelPreview()'), admin.indexOf('function parseModelMetadata('))
    assert.match(preview, /resolveBackendAssetUrl\(model\.file_path\)/)
    assert.doesNotMatch(preview, /rigPath|motion_package/)
    await assert.rejects(runCli(['--input', '/source.glb', '--output', '/source.glb']), /not overwritten/)
    await assert.rejects(runCli(['--input', '/source.glb', '--output', '/uploads/model.glb']), /outside uploads/)
})
