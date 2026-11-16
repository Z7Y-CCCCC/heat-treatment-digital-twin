#!/usr/bin/env node
// Explicit, offline source-asset repair. Never imported by the application UI.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import { GLTFLoader } from '../frontend/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
import { restoreGltfNodeNames } from '../frontend/src/three/gltfNodeIdentity.js'
import { createLiftCylinderAnchors, sampleLiftCylinderPose } from '../frontend/src/three/liftCylinderPose.js'
import { transferAuthoringY } from '../shared/equipmentTransferDatum.mjs'

export const LIFT_MODEL_ID = 'cad_lifting_load_table_111400'
export const LIFT_MODEL_PREFIX = 'cad_lifting_staging_table_v1_'
const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942
// Authored source-node contract, deliberately separate from runtime motion profiles.
const PARTS = [
    { node: 'hydraulics_teal', transform: 'barrel' },
    { node: 'hydraulics_stainless', transform: 'rod' },
    { node: 'hydraulics_brass', transform: 'barrel', selection: 'below-deck' },
    { node: 'hydraulics_metal', transform: 'upperEye', selection: 'upper-eye', excludeDeck: true },
    { node: 'lift_stainless', transform: 'upperEye', selection: 'upper-eye' },
    { node: 'pivot_detail', transform: 'upperEye', selection: 'upper-eye' },
    { node: 'slide_detail', transform: 'upperEye', selection: 'upper-eye' }
]

export function decodeGlb(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error('Expected a complete GLB version 2 file')
    const chunks = []
    for (let offset = 12; offset < bytes.length;) {
        if (offset + 8 > bytes.length) throw Error('Truncated GLB chunk header')
        const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4)
        if (length % 4 || offset + 8 + length > bytes.length) throw Error('Invalid GLB chunk length')
        chunks.push({ type, data: Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)) })
        offset += 8 + length
    }
    if (chunks[0]?.type !== JSON_CHUNK || chunks.filter(chunk => chunk.type === JSON_CHUNK).length !== 1 || chunks.filter(chunk => chunk.type === BIN_CHUNK).length !== 1) throw Error('Expected one JSON and one embedded BIN chunk')
    const json = JSON.parse(chunks[0].data.toString('utf8').replace(/\0+$/, '').trim())
    if (json.buffers?.length !== 1 || json.buffers[0].uri) throw Error('Only self-contained GLB buffers are supported; no external resource is fetched')
    if (json.images?.some(image => image.uri)) throw Error('External texture resources are not fetched by this offline repair')
    return { json, chunks, bin: chunks.find(chunk => chunk.type === BIN_CHUNK).data }
}

export function encodeGlb(glb) {
    const text = Buffer.from(JSON.stringify(glb.json)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20)
    text.copy(json)
    const chunks = glb.chunks.map(chunk => ({ ...chunk, data: chunk.type === JSON_CHUNK ? json : chunk.data }))
    const bytes = Buffer.alloc(12 + chunks.reduce((size, chunk) => size + 8 + chunk.data.length, 0))
    bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8)
    let offset = 12
    for (const chunk of chunks) {
        bytes.writeUInt32LE(chunk.data.length, offset); bytes.writeUInt32LE(chunk.type, offset + 4)
        chunk.data.copy(bytes, offset + 8); offset += 8 + chunk.data.length
    }
    return bytes
}

export async function parseLiftGlb(bytes) {
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const gltf = await new GLTFLoader().parseAsync(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength), '')
    restoreGltfNodeNames(gltf)
    return gltf
}

/** Pure connectivity query, preserving the original vertices and index buffer. */
export function connectedGeometryVertexGroups(geometry) {
    const position = geometry.attributes.position
    if (!position) return []
    const indices = geometry.index?.array || Array.from({ length: position.count }, (_, i) => i)
    const welded = new Map(), parents = [], ids = []
    const find = id => {
        while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id] }
        return id
    }
    for (let i = 0; i < position.count; i++) {
        const key = [position.getX(i), position.getY(i), position.getZ(i)].map(value => Math.round(value * 1e5)).join(',')
        if (!welded.has(key)) { welded.set(key, parents.length); parents.push(parents.length) }
        ids.push(welded.get(key))
    }
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = find(ids[indices[i]])
        parents[find(ids[indices[i + 1]])] = a; parents[find(ids[indices[i + 2]])] = a
    }
    const groups = new Map()
    for (const index of indices) {
        const key = find(ids[index])
        if (!groups.has(key)) groups.set(key, new Set())
        groups.get(key).add(index)
    }
    return [...groups.values()].map(group => [...group])
}

export function liftAuthoringY(root) {
    return root.getObjectByName(LIFT_MODEL_PREFIX + 'root')?.userData.transferAlignment ? y => transferAuthoringY(LIFT_MODEL_ID, y) : y => y
}

/** Used only by this offline tool and its inverse-fixture regression, never at startup. */
export function transformLiftSourceGeometry(root, anchors, inverse = false) {
    const pose = sampleLiftCylinderPose(anchors), targetEye = inverse ? pose.top : anchors.tip
    root.updateMatrixWorld(true)
    const inverseRoot = root.matrixWorld.clone().invert(), plans = new Map()
    for (const part of PARTS) {
        const node = root.getObjectByName(LIFT_MODEL_PREFIX + part.node)
        if (!node) throw Error('Source lift model is missing node: ' + part.node)
        let meshCount = 0
        node.traverse(mesh => {
            if (!mesh.isMesh || !mesh.geometry?.attributes.position?.count) return
            if (mesh.isSkinnedMesh || Object.keys(mesh.geometry.morphAttributes).length) throw Error('Skinned/morph source geometry is not supported by this repair')
            meshCount++
            const meshToRoot = inverseRoot.clone().multiply(mesh.matrixWorld), rootToMesh = meshToRoot.clone().invert()
            for (const indices of connectedGeometryVertexGroups(mesh.geometry)) {
                const bounds = new T.Box3(), point = new T.Vector3()
                for (const index of indices) bounds.expandByPoint(point.fromBufferAttribute(mesh.geometry.attributes.position, index).applyMatrix4(meshToRoot))
                const center = bounds.getCenter(new T.Vector3())
                if (part.selection === 'below-deck' && center.y > .9) continue
                if (part.selection === 'upper-eye' && (Math.hypot(center.x - targetEye.x, center.y - targetEye.y) >= .06 || Math.abs(center.z) >= .09 || part.excludeDeck && center.y > .9)) continue
                if (!plans.has(mesh)) plans.set(mesh, [])
                const transform = pose[part.transform].clone()
                if (inverse) transform.invert()
                plans.get(mesh).push({ indices, matrix: rootToMesh.clone().multiply(transform).multiply(meshToRoot) })
            }
        })
        if (!meshCount) throw Error('Source lift node has no mesh: ' + part.node)
    }
    if (!plans.size) throw Error('No source cylinder geometry matched the authored contract')
    for (const [mesh, operations] of plans) {
        const geometry = mesh.geometry.clone(), point = new T.Vector3()
        for (const { indices, matrix } of operations) {
            const normalMatrix = new T.Matrix3().getNormalMatrix(matrix)
            for (const [name, attribute] of Object.entries(geometry.attributes)) {
                if (!['position', 'normal', 'tangent'].includes(name)) continue
                for (const index of indices) {
                    point.fromBufferAttribute(attribute, index)
                    if (name === 'position') point.applyMatrix4(matrix)
                    else if (name === 'normal') point.applyNormalMatrix(normalMatrix)
                    else point.transformDirection(matrix)
                    attribute.setXYZ(index, point.x, point.y, point.z)
                }
            }
        }
        geometry.computeBoundingBox(); geometry.computeBoundingSphere(); mesh.geometry = geometry
    }
    return [...plans.keys()]
}

/** In-place edits to original accessor storage; no exporter, new topology or node hierarchy. */
export function writeSourceGeometry(glb, gltf, meshes) {
    const writes = new Map(), getters = ['getX', 'getY', 'getZ', 'getW']
    for (const mesh of meshes) {
        const association = gltf.parser.associations.get(mesh), primitive = glb.json.meshes?.[association?.meshes]?.primitives?.[association?.primitives]
        if (!primitive) throw Error('Cannot associate a repaired mesh with its original glTF primitive')
        for (const [name, semantic] of [['position', 'POSITION'], ['normal', 'NORMAL'], ['tangent', 'TANGENT']]) {
            const attribute = mesh.geometry.attributes[name], accessorId = primitive.attributes[semantic]
            if (!attribute) continue
            const accessor = glb.json.accessors[accessorId], view = glb.json.bufferViews[accessor?.bufferView]
            const size = semantic === 'TANGENT' ? 4 : 3, stride = view?.byteStride || size * 4
            const offset = (view?.byteOffset || 0) + (accessor?.byteOffset || 0)
            if (!accessor || !view || accessor.sparse || accessor.normalized || accessor.componentType !== 5126 || accessor.type !== 'VEC' + size || accessor.count !== attribute.count || attribute.itemSize !== size || view.buffer !== 0 || stride < size * 4 || stride % 4 || offset % 4 || (accessor.byteOffset || 0) + (attribute.count - 1) * stride + size * 4 > view.byteLength || offset + (attribute.count - 1) * stride + size * 4 > glb.bin.length) throw Error('Repair requires an unchanged, embedded FLOAT accessor: ' + semantic)
            const values = new Float32Array(attribute.count * size)
            for (let index = 0; index < attribute.count; index++) for (let component = 0; component < size; component++) {
                const value = attribute[getters[component]](index)
                if (!Number.isFinite(value)) throw Error('Repair produced a non-finite vertex attribute')
                values[index * size + component] = value
            }
            if (writes.has(accessorId) && !Buffer.from(values.buffer).equals(Buffer.from(writes.get(accessorId).buffer))) throw Error('A shared source accessor requires conflicting instance transforms')
            writes.set(accessorId, values)
            for (let index = 0; index < attribute.count; index++) for (let component = 0; component < size; component++) glb.bin.writeFloatLE(values[index * size + component], offset + index * stride + component * 4)
            if (semantic === 'POSITION') {
                accessor.min = [Infinity, Infinity, Infinity]; accessor.max = [-Infinity, -Infinity, -Infinity]
                for (let index = 0; index < attribute.count; index++) for (let component = 0; component < 3; component++) {
                    const value = values[index * 3 + component]
                    accessor.min[component] = Math.min(accessor.min[component], value); accessor.max[component] = Math.max(accessor.max[component], value)
                }
            }
        }
    }
    return writes.size
}

/** Pure Buffer -> Buffer repair. Does not read/write a database, register or replace any asset. */
export async function correctLiftGlb(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), glb = decodeGlb(bytes)
    const rootIndex = glb.json.nodes?.findIndex(node => node.name === LIFT_MODEL_PREFIX + 'root')
    if (!(rootIndex >= 0)) throw Error('The explicit 11.14 lift source node is absent')
    const sourceRoot = glb.json.nodes[rootIndex], marker = sourceRoot.extras?.liftCylinderRestPose
    if (marker !== undefined) {
        createLiftCylinderAnchors(y => y, marker) // Validate, then preserve already corrected bytes exactly.
        return bytes
    }
    const gltf = await parseLiftGlb(bytes), anchors = createLiftCylinderAnchors(liftAuthoringY(gltf.scene))
    const meshes = transformLiftSourceGeometry(gltf.scene, anchors)
    writeSourceGeometry(glb, gltf, meshes)
    const pose = sampleLiftCylinderPose(anchors)
    sourceRoot.extras = { ...sourceRoot.extras, liftCylinderRestPose: {
        schemaVersion: 1, coordinateSpace: 'three-y-up-local-m', base: anchors.base.toArray(),
        mid: anchors.mid.clone().applyMatrix4(pose.barrel).toArray(), tip: pose.top.toArray()
    } }
    return encodeGlb(glb)
}

export async function runCli(args = process.argv.slice(2)) {
    const help = 'Offline 11.14 lift-source repair (no runtime preview workaround).\nUsage: node tools/fix-lift-model-rest-pose.mjs --input FILE.glb --output NEW_FILE.glb\nBoth paths must be explicit. Existing files, input itself and uploads directories are never overwritten.\nNo scanning, import, registration, database access or installer build occurs.\n'
    if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return }
    const options = {}
    for (let index = 0; index < args.length; index += 2) {
        if (!['--input', '--output'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || options[args[index]]) throw Error(help)
        options[args[index]] = args[index + 1]
    }
    if (!options['--input'] || !options['--output']) throw Error(help)
    const input = path.resolve(options['--input']), output = path.resolve(options['--output'])
    const forbiddenOutput = location => /(^|[\\/])uploads([\\/]|$)/i.test(location) || /(^|[\\/])backend[\\/]data([\\/]|$)/i.test(location)
    if (input.toLowerCase() === output.toLowerCase() || !/\.glb$/i.test(input) || !/\.glb$/i.test(output) || forbiddenOutput(output)) throw Error('Choose a new .glb output outside uploads/database data; input/library files are not overwritten')
    // Resolve the existing ancestor before mkdir, so junction/symlink aliases cannot write into uploads.
    let ancestor = path.dirname(output), missing = []
    for (;;) {
        try { ancestor = await fs.realpath(ancestor); break }
        catch (error) {
            if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
            missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor)
        }
    }
    if (forbiddenOutput(path.join(ancestor, ...missing, path.basename(output)))) throw Error('Choose an output outside uploads/database data, including symlink aliases')
    const bytes = await fs.readFile(input), corrected = await correctLiftGlb(bytes)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, corrected, { flag: 'wx' })
    const sha = data => crypto.createHash('sha256').update(data).digest('hex')
    process.stdout.write(JSON.stringify({ input, output, changed: !bytes.equals(corrected), inputBytes: bytes.length, outputBytes: corrected.length, inputSha256: sha(bytes), outputSha256: sha(corrected) }, null, 2) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    runCli().catch(error => { process.stderr.write(String(error?.message || error) + '\n'); process.exitCode = 1 })
}
