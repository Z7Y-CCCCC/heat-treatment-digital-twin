#!/usr/bin/env node
// Explicit offline addition of the missing authored shaft. No UI/runtime patch,
// database access, registration, automatic migration, or installer construction.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import { decodeGlb, encodeGlb, parseLiftGlb, LIFT_MODEL_PREFIX } from './fix-lift-model-rest-pose.mjs'

export const LIFT_CROSSSHAFT_NODE = LIFT_MODEL_PREFIX + 'crossshaft_metal'
export const LIFT_CROSSSHAFT_RADIUS = .018
export const LIFT_CROSSSHAFT_LENGTH = .78

/** Append only: existing node indices, sibling binding paths, accessors and BIN
 * bytes are preserved. The additional solid is part of the source GLB itself.
 */
export async function addLiftCrossshaftToGlb(input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), glb = decodeGlb(bytes)
    const rootIndex = glb.json.nodes.findIndex(node => node.name === LIFT_MODEL_PREFIX + 'root')
    if (rootIndex < 0) throw Error('The explicit 11.14 lift source root is absent')
    const assemblyIndex = glb.json.nodes.findIndex(node => node.name === LIFT_MODEL_PREFIX + 'lift')
    if (assemblyIndex < 0) throw Error('The original scissor lift assembly is absent')
    const assembly = glb.json.nodes[assemblyIndex]
    const authoredRoot = glb.json.nodes[rootIndex], rest = authoredRoot.extras?.liftCylinderRestPose
    if (!rest || rest.schemaVersion !== 1 || rest.coordinateSpace !== 'three-y-up-local-m' ||
        !Array.isArray(rest.tip) || rest.tip.length !== 3 || !rest.tip.every(Number.isFinite)) {
        throw Error('Repair the cylinder source rest pose before adding its crossshaft')
    }
    const existing = glb.json.nodes.filter(node => node.name === LIFT_CROSSSHAFT_NODE)
    if (existing.length || authoredRoot.extras?.liftCrossshaft !== undefined) {
        const marker = authoredRoot.extras?.liftCrossshaft
        if (existing.length !== 1 || !assembly.children?.includes(glb.json.nodes.indexOf(existing[0])) ||
            marker?.schemaVersion !== 1 || marker.node !== LIFT_CROSSSHAFT_NODE ||
            marker.radius !== LIFT_CROSSSHAFT_RADIUS || marker.length !== LIFT_CROSSSHAFT_LENGTH ||
            JSON.stringify(marker.center) !== JSON.stringify(rest.tip) || JSON.stringify(marker.axis) !== '[0,0,1]') {
            throw Error('Existing source crossshaft declaration is inconsistent; refusing to add a duplicate')
        }
        return bytes
    }
    const parsed = await parseLiftGlb(bytes), sourceAssembly = parsed.scene.getObjectByName(LIFT_MODEL_PREFIX + 'lift')
    parsed.scene.updateMatrixWorld(true)
    const assemblyToScene = parsed.scene.matrixWorld.clone().invert().multiply(sourceAssembly.matrixWorld)
    const sourceMetal = glb.json.materials.findIndex(material => material.name === 'CAD26_metal')
    if (sourceMetal < 0) throw Error('Original CAD metal material is absent')
    const geometry = new T.CylinderGeometry(LIFT_CROSSSHAFT_RADIUS, LIFT_CROSSSHAFT_RADIUS, LIFT_CROSSSHAFT_LENGTH, 24)
    geometry.rotateX(Math.PI / 2).translate(...rest.tip).applyMatrix4(assemblyToScene.clone().invert())
    geometry.computeBoundingBox()
    const segments = [], originalLength = glb.bin.length
    let length = originalLength
    const append = (values, target) => {
        const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
        const padding = Buffer.alloc((4 - length % 4) % 4)
        segments.push(padding, data)
        length += padding.length
        const bufferView = glb.json.bufferViews.length
        glb.json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length, target })
        length += data.length
        return bufferView
    }
    const accessor = (attribute, type, componentType, target, bounds) => {
        const index = glb.json.accessors.length
        glb.json.accessors.push({ bufferView: append(attribute.array, target), componentType,
            count: attribute.count, type, ...(bounds || {}) })
        return index
    }
    const position = accessor(geometry.attributes.position, 'VEC3', 5126, 34962,
        { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() })
    const normal = accessor(geometry.attributes.normal, 'VEC3', 5126, 34962)
    const indices = accessor(geometry.index, 'SCALAR', geometry.index.array instanceof Uint32Array ? 5125 : 5123, 34963)
    const meshIndex = glb.json.meshes.length
    glb.json.meshes.push({ name: LIFT_CROSSSHAFT_NODE, primitives: [
        { attributes: { POSITION: position, NORMAL: normal }, indices, material: sourceMetal, mode: 4 }
    ] })
    const nodeIndex = glb.json.nodes.length
    glb.json.nodes.push({ name: LIFT_CROSSSHAFT_NODE, mesh: meshIndex, extras: { part: 'lift_crossshaft' } })
    // Belongs to the existing lift assembly, so existing source/field inspection
    // targets include it without rewriting any disassembly layout or binding.
    assembly.children = [...(assembly.children || []), nodeIndex]
    authoredRoot.extras.liftCrossshaft = { schemaVersion: 1, node: LIFT_CROSSSHAFT_NODE,
        center: [...rest.tip], axis: [0, 0, 1], radius: LIFT_CROSSSHAFT_RADIUS, length: LIFT_CROSSSHAFT_LENGTH }
    segments.push(Buffer.alloc((4 - length % 4) % 4))
    glb.bin = Buffer.concat([glb.bin, ...segments])
    glb.chunks.find(chunk => chunk.type === 0x004e4942).data = glb.bin
    glb.json.buffers[0].byteLength = glb.bin.length
    geometry.dispose()
    return encodeGlb(glb)
}

async function cli(args) {
    if (!args.length || args.includes('--help')) {
        console.log('Usage: node tools/add-lift-source-crossshaft.mjs --input FILE.glb --output NEW_FILE.glb\nOffline source repair; existing files and uploads/database data are never overwritten.')
        return
    }
    const options = {}
    for (let i = 0; i < args.length; i += 2) {
        if (!['--input', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Explicit --input and --output are required')
        options[args[i]] = args[i + 1]
    }
    if (!options['--input'] || !options['--output']) throw Error('Explicit --input and --output are required')
    const input = path.resolve(options['--input']), output = path.resolve(options['--output'])
    const forbidden = value => /(^|[\\/])uploads([\\/]|$)|(^|[\\/])backend[\\/]data([\\/]|$)/i.test(value)
    if (input.toLowerCase() === output.toLowerCase() || !/\.glb$/i.test(input) || !/\.glb$/i.test(output) || forbidden(output)) throw Error('Choose a new GLB outside uploads/database data')
    let ancestor = path.dirname(output), missing = []
    for (;;) {
        try { ancestor = await fs.realpath(ancestor); break }
        catch (error) {
            if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
            missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor)
        }
    }
    if (forbidden(path.join(ancestor, ...missing, path.basename(output)))) throw Error('Output alias resolves into uploads/database data')
    const before = await fs.readFile(input), after = await addLiftCrossshaftToGlb(before)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, after, { flag: 'wx' })
    console.log(JSON.stringify({ input, output, changed: !before.equals(after), addedNode: LIFT_CROSSSHAFT_NODE, radius: LIFT_CROSSSHAFT_RADIUS, length: LIFT_CROSSSHAFT_LENGTH }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
