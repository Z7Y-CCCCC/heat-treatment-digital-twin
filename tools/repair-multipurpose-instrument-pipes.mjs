import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Deterministic, hash-guarded repair of the six known V6 instrument feed pipes.
// Optional argument: a new output directory. Existing outputs and the original are never overwritten.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(workspace, 'backend/assets/models/photo_multipurpose_furnace_v6.glb');
const metadataPath = path.join(workspace, 'backend/assets/models/photo_multipurpose_furnace_v6_metadata.json');
const outputDirectory = path.resolve(process.argv[2] || path.join(workspace, 'backend/assets/models'));
fs.mkdirSync(outputDirectory, { recursive: true });
const candidatePath = path.join(outputDirectory, 'photo_multipurpose_furnace_v6_pipefix.glb');
const reportPath = path.join(outputDirectory, 'photo_multipurpose_furnace_v6_pipefix_report.json');
assert.notEqual(path.resolve(candidatePath), path.resolve(sourcePath));
assert(!fs.existsSync(reportPath), 'Refuse to overwrite an existing repair report');
assert(!fs.existsSync(candidatePath), 'Refuse to overwrite an existing candidate');
const original = fs.readFileSync(sourcePath);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const originalHash = sha256(original);
assert.equal(originalHash, '773c45d6f1808a495f4bcde313848051d0c088fd5970b318786083628d068976');
const metadataHash = sha256(fs.readFileSync(metadataPath));

let document;
let binaryOffset;
let jsonChunk;
for (let offset = 12; offset < original.length;) {
    const length = original.readUInt32LE(offset);
    const type = original.toString('ascii', offset + 4, offset + 8);
    if (type === 'JSON') {
        jsonChunk = original.subarray(offset + 8, offset + 8 + length);
        document = JSON.parse(jsonChunk);
    }
    if (type === 'BIN\0') binaryOffset = offset + 8;
    offset += length + 8;
}
assert(document && binaryOffset);
const primitive = document.meshes[58].primitives[0];
assert.equal(document.meshes[58].name, 'gas_instrument_bank_stainless_mesh.002');
assert.deepEqual(primitive.attributes, { POSITION: 166, NORMAL: 167 });
assert.equal(primitive.indices, 168);

function accessorLayout(index) {
    const accessor = document.accessors[index];
    const view = document.bufferViews[accessor.bufferView];
    assert.equal(view.buffer, 0);
    assert(!accessor.sparse);
    const componentSize = { 5123: 2, 5126: 4 }[accessor.componentType];
    const components = { SCALAR: 1, VEC3: 3 }[accessor.type];
    assert(componentSize && components);
    return {
        accessor,
        offset: binaryOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0),
        stride: view.byteStride || componentSize * components,
        components,
        read: accessor.componentType === 5126 ? 'readFloatLE' : 'readUInt16LE',
        componentSize,
    };
}
const positionLayout = accessorLayout(166);
const normalLayout = accessorLayout(167);
const indexLayout = accessorLayout(168);
function readAccessor(buffer, layout) {
    return Array.from({ length: layout.accessor.count }, (_, index) => (
        Array.from({ length: layout.components }, (_, component) => buffer[layout.read](
            layout.offset + index * layout.stride + component * layout.componentSize
        ))
    ));
}
const positions = readAccessor(original, positionLayout);
const normals = readAccessor(original, normalLayout);
const indices = readAccessor(original, indexLayout).flat();
const newPositions = positions.map(vector => [...vector]);
const newNormals = normals.map(vector => [...vector]);

const add = (a, b) => a.map((value, index) => value + b[index]);
const sub = (a, b) => a.map((value, index) => value - b[index]);
const scale = (a, factor) => a.map(value => value * factor);
const dot = (a, b) => a.reduce((result, value, index) => result + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(...a);
const normalize = a => { const size = length(a); assert(size > 1e-12); return scale(a, 1 / size); };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const gltf = point => [point[0], point[2], point[1]]; // Blender Z-up plus the authored side reflection.

function controlPoints(x) {
    return [[x, -1.12, .53], [x, -1.12, 1.16], [x + .12, -1.12, 1.16],
        [x + .12, -1.12, 1.99], [x + .17, -1.12, 1.99], [x + .17, -.96, 2.47]];
}

// Faithful numerical reconstruction of source pipe(), for vertex correspondence only.
function originalPipe(x) {
    const points = controlPoints(x);
    const centers = [points[0]];
    for (let index = 1; index < points.length - 1; index++) {
        const [a, b, c] = points.slice(index - 1, index + 2);
        const trim = Math.min(.055, length(sub(b, a)) * .3, length(sub(c, b)) * .3);
        const p = add(b, scale(normalize(sub(a, b)), trim));
        const q = add(b, scale(normalize(sub(c, b)), trim));
        centers.push(p);
        for (let step = 1; step <= 5; step++) {
            const t = step / 5;
            centers.push(add(add(scale(p, (1 - t) ** 2), scale(b, 2 * (1 - t) * t)), scale(q, t * t)));
        }
    }
    centers.push(points.at(-1));
    const vertices = [];
    const frames = [];
    let previous;
    for (let index = 0; index < centers.length; index++) {
        const tangent = normalize(sub(centers[Math.min(index + 1, centers.length - 1)], centers[Math.max(index - 1, 0)]));
        const reference = Math.abs(tangent[2]) < .9 ? [0, 0, 1] : [0, 1, 0];
        const u = previous ? normalize(sub(previous, scale(tangent, dot(previous, tangent)))) : normalize(cross(tangent, reference));
        const v = normalize(cross(tangent, u));
        previous = u;
        frames.push({ u, v, tangent });
        for (let side = 0; side < 10; side++) {
            const angle = side * 2 * Math.PI / 10;
            vertices.push(gltf(add(centers[index], scale(add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle))), .012))));
        }
    }
    assert.equal(centers.length, 26);
    return { points, centers, vertices, frames };
}

// Replace only the final two short-link corners with true circular centerlines.
// Each 90-degree fillet has R=22 mm, leaving a 6 mm straight between them.
// The first two corners, all straight endpoint rings, ring count, radius and topology stay intact.
function correctedRingVertices(originalPipeGeometry) {
    const radius = .022;
    const output = new Map();
    let previous = originalPipeGeometry.frames[12].u;
    const fillets = [];
    for (const corner of [3, 4]) {
        const [a, b, c] = originalPipeGeometry.points.slice(corner - 1, corner + 2);
        const incoming = normalize(sub(b, a));
        const outgoing = normalize(sub(c, b));
        assert(Math.abs(dot(incoming, outgoing)) < 1e-12, 'This local repair only supports the two known orthogonal corners');
        const p = sub(b, scale(incoming, radius));
        const center = add(p, scale(outgoing, radius));
        const firstRing = 1 + (corner - 1) * 6;
        for (let step = 0; step <= 5; step++) {
            const theta = step / 5 * Math.PI / 2;
            const ringCenter = add(center, scale(add(scale(outgoing, -Math.cos(theta)), scale(incoming, Math.sin(theta))), radius));
            const tangent = normalize(add(scale(incoming, Math.cos(theta)), scale(outgoing, Math.sin(theta))));
            const u = normalize(sub(previous, scale(tangent, dot(previous, tangent))));
            const v = normalize(cross(tangent, u));
            previous = u;
            const ring = firstRing + step;
            for (let side = 0; side < 10; side++) {
                const angle = side * 2 * Math.PI / 10;
                output.set(ring * 10 + side, gltf(add(ringCenter,
                    scale(add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle))), .012))));
            }
        }
        fillets.push({ corner, centerlineRadius: radius, tubeRadius: .012,
            ringStart: firstRing, ringEnd: firstRing + 5, start: gltf(p), end: gltf(add(b, scale(outgoing, radius))) });
    }
    return { vertices: output, fillets };
}

function triangleRecords(pointSet, pipe) {
    const records = [];
    for (let local = 0; local < 516; local++) {
        const triangle = pipe * 516 + local;
        const ids = indices.slice(triangle * 3, triangle * 3 + 3);
        const pp = ids.map(id => pointSet[id]);
        const normal = cross(sub(pp[1], pp[0]), sub(pp[2], pp[0]));
        records.push({ triangle, local, ids, pp, normal });
    }
    return records;
}

const correspondence = [];
const filletRecords = [];
for (let pipe = 0; pipe < 6; pipe++) {
    const x = [-1.95, -1.39, -.83, -.27, .29, .85][pipe];
    const reconstructed = originalPipe(x);
    const corrected = correctedRingVertices(reconstructed);
    let maxError = 0;
    let changedPositions = 0;
    const sourceVertexMap = new Map();
    for (let local = 0; local < 280; local++) {
        const index = pipe * 280 + local;
        let nearest = -1;
        let distance = Infinity;
        for (let sourceIndex = 0; sourceIndex < 260; sourceIndex++) {
            const error = length(sub(positions[index], reconstructed.vertices[sourceIndex]));
            if (error < distance) { distance = error; nearest = sourceIndex; }
        }
        assert(distance < 3e-6, `Cannot verify original-source correspondence: pipe ${pipe}, vertex ${index}, error ${distance}`);
        maxError = Math.max(maxError, distance);
        sourceVertexMap.set(index, nearest);
        if (corrected.vertices.has(nearest)) {
            newPositions[index] = corrected.vertices.get(nearest).map(Math.fround);
            changedPositions++;
        }
    }
    // All 516 triangles must be contained by the source's verified 280 exported vertices.
    const triangles = triangleRecords(newPositions, pipe);
    assert(triangles.every(triangle => triangle.ids.every(index => index >= pipe * 280 && index < (pipe + 1) * 280)));
    const smooth = new Map();
    const sideVertices = new Set();
    const capVertices = new Set();
    for (const triangle of triangles) {
        if (triangle.local >= 500) { triangle.ids.forEach(index => capVertices.add(index)); continue; }
        const unitNormal = normalize(triangle.normal);
        for (let corner = 0; corner < 3; corner++) {
            const index = triangle.ids[corner];
            sideVertices.add(index);
            const a = normalize(sub(triangle.pp[(corner + 1) % 3], triangle.pp[corner]));
            const b = normalize(sub(triangle.pp[(corner + 2) % 3], triangle.pp[corner]));
            const angle = Math.acos(clamp(dot(a, b), -1, 1));
            smooth.set(index, add(smooth.get(index) || [0, 0, 0], scale(unitNormal, angle)));
        }
    }
    assert.equal(sideVertices.size, 260);
    assert.equal(capVertices.size, 20);
    assert([...capVertices].every(index => !sideVertices.has(index)));
    // Angle-weighted smooth normals are rebuilt only for these six pipes; flat endcaps stay byte-identical.
    for (const [index, sum] of smooth) newNormals[index] = normalize(sum).map(Math.fround);
    // End cross sections are unchanged, including duplicate vertices used by the flat caps.
    for (const [index, sourceIndex] of sourceVertexMap) if (sourceIndex < 10 || sourceIndex >= 250) {
        assert.deepEqual(newPositions[index], positions[index]);
    }
    correspondence.push({ pipe: pipe + 1, exportedVertexStart: pipe * 280,
        exportedVertexEnd: (pipe + 1) * 280 - 1, maxOriginalReconstructionError: maxError,
        changedPositionVertices: changedPositions, unchangedEndpointRings: true });
    filletRecords.push({ pipe: pipe + 1, fillets: corrected.fillets });
}

function strictSegmentTriangle(a, b, triangle) {
    const direction = sub(b, a);
    const edge1 = sub(triangle[1], triangle[0]);
    const edge2 = sub(triangle[2], triangle[0]);
    const h = cross(direction, edge2);
    const determinant = dot(edge1, h);
    if (Math.abs(determinant) < 1e-16) return null;
    const s = sub(a, triangle[0]);
    const u = dot(s, h) / determinant;
    if (u <= 1e-7 || u >= 1 - 1e-7) return null;
    const q = cross(s, edge1);
    const v = dot(direction, q) / determinant;
    if (v <= 1e-7 || u + v >= 1 - 1e-7) return null;
    const t = dot(edge2, q) / determinant;
    return t > 1e-7 && t < 1 - 1e-7 ? add(a, scale(direction, t)) : null;
}

function auditPipe(pointSet, normalSet, pipe) {
    const triangles = triangleRecords(pointSet, pipe);
    const points = triangles.flatMap(triangle => triangle.pp);
    const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])));
    const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])));
    const center = scale(add(min, max), .5);
    const weldMap = new Map();
    const welded = pointSet.map(point => {
        const key = point.map(value => Math.round(value * 1e6)).join(',');
        if (!weldMap.has(key)) weldMap.set(key, weldMap.size);
        return weldMap.get(key);
    });
    const edges = new Map();
    const faces = new Set();
    let duplicates = 0;
    let signedVolume = 0;
    const reversed = [];
    const degenerates = [];
    for (const triangle of triangles) {
        triangle.welded = triangle.ids.map(index => welded[index]);
        const faceKey = [...triangle.welded].sort((a, b) => a - b).join(',');
        if (faces.has(faceKey)) duplicates++;
        faces.add(faceKey);
        signedVolume += dot(sub(triangle.pp[0], center), cross(sub(triangle.pp[1], center), sub(triangle.pp[2], center))) / 6;
        if (length(triangle.normal) <= 1e-12) degenerates.push(triangle.triangle);
        const averageNormal = scale(triangle.ids.map(index => normalSet[index]).reduce(add, [0, 0, 0]), 1 / 3);
        if (dot(triangle.normal, averageNormal) < -1e-7) reversed.push(triangle.triangle);
        for (let side = 0; side < 3; side++) {
            const a = triangle.welded[side];
            const b = triangle.welded[(side + 1) % 3];
            const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
            if (!edges.has(key)) edges.set(key, []);
            edges.get(key).push([a, b]);
        }
    }
    const intersections = [];
    for (let first = 0; first < triangles.length; first++) for (let second = first + 1; second < triangles.length; second++) {
        const a = triangles[first];
        const b = triangles[second];
        if (a.welded.some(index => b.welded.includes(index))) continue;
        if ([0, 1, 2].some(axis => (
            Math.max(...a.pp.map(point => point[axis])) < Math.min(...b.pp.map(point => point[axis])) ||
            Math.max(...b.pp.map(point => point[axis])) < Math.min(...a.pp.map(point => point[axis]))
        ))) continue;
        let hit;
        for (let side = 0; side < 3 && !hit; side++) hit =
            strictSegmentTriangle(a.pp[side], a.pp[(side + 1) % 3], b.pp) ||
            strictSegmentTriangle(b.pp[side], b.pp[(side + 1) % 3], a.pp);
        if (hit) intersections.push({ triangles: [a.triangle, b.triangle], point: hit });
    }
    return { pipe: pipe + 1, triangles: triangles.length, min, max, signedVolume,
        boundaryEdges: [...edges.values()].filter(edge => edge.length === 1).length,
        nonmanifoldEdges: [...edges.values()].filter(edge => edge.length > 2).length,
        inconsistentDirectedEdges: [...edges.values()].filter(edge => edge.length === 2 && edge[0][0] === edge[1][0]).length,
        duplicateCoincidentFaces: duplicates, reversedTriangles: reversed, degenerateTriangles: degenerates,
        nonAdjacentStrictIntersectionPairs: intersections };
}

const before = Array.from({ length: 6 }, (_, pipe) => auditPipe(positions, normals, pipe));
const after = Array.from({ length: 6 }, (_, pipe) => auditPipe(newPositions, newNormals, pipe));
console.log(JSON.stringify({ candidateLocalAudit: after.map(record => ({ pipe: record.pipe,
    reversed: record.reversedTriangles.length, intersections: record.nonAdjacentStrictIntersectionPairs.length,
    degenerates: record.degenerateTriangles.length, volume: record.signedVolume })) }, null, 2));
for (const record of after) {
    assert.equal(record.boundaryEdges, 0);
    assert.equal(record.nonmanifoldEdges, 0);
    assert.equal(record.inconsistentDirectedEdges, 0);
    assert.equal(record.duplicateCoincidentFaces, 0);
    assert.equal(record.reversedTriangles.length, 0, 'No misleading reversed-normal-only fix');
    assert.equal(record.degenerateTriangles.length, 0);
    assert.equal(record.nonAdjacentStrictIntersectionPairs.length, 0, 'No candidate written while local self intersections remain');
    assert(record.signedVolume > 0);
}

const candidate = Buffer.from(original);
for (const [layout, values] of [[positionLayout, newPositions], [normalLayout, newNormals]]) {
    for (let index = 0; index < 1680; index++) for (let axis = 0; axis < 3; axis++) {
        candidate.writeFloatLE(values[index][axis], layout.offset + index * layout.stride + axis * 4);
    }
}
// JSON/accessor bounds must remain valid without modifying any scene or metadata bytes.
const extrema = set => ({ min: [0, 1, 2].map(axis => Math.min(...set.map(point => point[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...set.map(point => point[axis]))) });
assert.deepEqual(extrema(newPositions), extrema(positions));
assert.deepEqual(extrema(positions), { min: positionLayout.accessor.min, max: positionLayout.accessor.max });
const allowedRanges = [positionLayout, normalLayout].map(layout => [layout.offset, layout.offset + 1680 * layout.stride]);
const changedOffsets = [];
for (let offset = 0; offset < candidate.length; offset++) if (candidate[offset] !== original[offset]) {
    assert(allowedRanges.some(([start, end]) => offset >= start && offset < end), `Unexpected byte edit at ${offset}`);
    changedOffsets.push(offset);
}
const outsideHash = buffer => sha256(Buffer.concat([
    buffer.subarray(0, allowedRanges[0][0]),
    buffer.subarray(allowedRanges[0][1], allowedRanges[1][0]),
    buffer.subarray(allowedRanges[1][1]),
]));
assert.equal(outsideHash(original), outsideHash(candidate));
assert(candidate.subarray(20, 20 + jsonChunk.length).equals(jsonChunk));
assert(candidate.subarray(indexLayout.offset, indexLayout.offset + indexLayout.accessor.count * 2)
    .equals(original.subarray(indexLayout.offset, indexLayout.offset + indexLayout.accessor.count * 2)));
fs.writeFileSync(candidatePath, candidate, { flag: 'wx' });

function pythonAudit(script, args) {
    const result = spawnSync('python', ['-B', path.join(workspace, 'tools', script), ...args],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert(!result.error, result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, JSON.stringify(report));
    assert(report.valid);
    return report;
}
const structure = pythonAudit('validate_equipment_glb.py', [candidatePath, '--metadata', metadataPath]);
const geometry = pythonAudit('audit_equipment_glb_geometry.py', [candidatePath]);
assert.equal(sha256(fs.readFileSync(sourcePath)), originalHash);
assert.equal(sha256(fs.readFileSync(metadataPath)), metadataHash);
const changes = {
    meshIndex: 58, meshName: document.meshes[58].name, nodeIndex: 72, nodeName: document.nodes[72].name,
    positionAccessor: 166, normalAccessor: 167, unchangedIndexAccessor: 168,
    eligibleExportedVertexIndicesInclusive: [0, 1679],
    changedPositionVertices: newPositions.filter((point, index) => point.some((value, axis) => value !== positions[index][axis])).length,
    changedNormalVertices: newNormals.filter((normal, index) => normal.some((value, axis) => value !== normals[index][axis])).length,
    absoluteAllowedByteRangesHalfOpen: allowedRanges,
    actualChangedByteCount: changedOffsets.length,
    actualChangedByteMin: Math.min(...changedOffsets), actualChangedByteMax: Math.max(...changedOffsets),
    changedTriangleIndexEntries: 0,
    unchangedJsonChunk: true, unchangedNodeHierarchy: true, unchangedMaterials: true,
    unchangedOtherGeometry: true, unchangedAccessorAndModelBounds: true,
    outsideAllowedRangesSha256: outsideHash(original),
};
const report = { sourcePath, candidatePath, originalSha256: originalHash, candidateSha256: sha256(candidate),
    originalMetadataSha256: metadataHash, originalAndMetadataUnchanged: true,
    method: 'Six verified meter-feed pipes only: original-radius 12mm tubes; replace two final short-link quadratic bends per pipe with 22mm circular fillets, 6mm intervening straight; preserve both endpoint rings, all indices, nodes, materials, and other geometry. Recompute angle-weighted side normals only for these pipes; preserve flat cap normals.',
    changedNodeTransforms: 0, changedBindings: 0, changedIndexEntries: 0,
    limitations: ['Derived copy only; selecting the fixed model as an application default is a separate configuration step.',
        'Pipe routing remains a photo-estimated visual model, not a measured engineering specification.',
        'Strict nonadjacent triangle intersection checks exclude shared vertices and coplanar contacts; closed-manifold, duplicate-face and topology checks supplement this test. Independent verification is still recommended.'],
    correspondence, filletRecords, before, after, changes, structure, geometry };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidatePath, reportPath, originalSha256: originalHash, candidateSha256: report.candidateSha256,
    structureValid: structure.valid, geometryValid: geometry.valid, changes }, null, 2));
