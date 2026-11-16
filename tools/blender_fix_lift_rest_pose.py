"""Explicit, isolated repair of the existing editable lift source, not a model rebuild.

Requires distinct --input and --output paths. Never exports GLB, modifies the
input, rewrites other assets, adds/removes objects, or changes saved object paths.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lift_cylinder_rest_pose import cylinder_rest_pose, three_rest_pose_marker


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mesh_signature(obj):
    mesh = obj.data
    digest = hashlib.sha256()
    for vertex in mesh.vertices:
        digest.update(struct.pack('<3f', *vertex.co))
    return {
        'coordinates': digest.hexdigest(),
        'vertices': len(mesh.vertices),
        'edges': [tuple(edge.vertices) for edge in mesh.edges],
        'polygons': [(tuple(face.vertices), face.material_index, face.use_smooth) for face in mesh.polygons],
        'materials': [material.name if material else None for material in mesh.materials],
    }


def world_vertices(obj):
    return [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]


def bounds_center(obj):
    points = world_vertices(obj)
    return Vector(tuple((min(point[i] for point in points) + max(point[i] for point in points)) / 2 for i in range(3)))


def projection_length(obj, axis):
    values = [point.dot(axis) for point in world_vertices(obj)]
    return max(values) - min(values)


def main():
    if not bpy.app.background:
        raise RuntimeError('Use an isolated --background --factory-startup Blender process')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prefix', default='cad_lifting_staging_table_v1_')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source, output = args.input.resolve(strict=True), args.output.resolve()
    if source == output or output.exists():
        raise ValueError('The output must be a new file, distinct from the preserved source')
    if source.suffix.lower() != '.blend' or output.suffix.lower() != '.blend':
        raise ValueError('Explicit Blender source paths are required')
    before_hash = sha(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    root = bpy.data.objects.get(args.prefix + 'root')
    if root is None or root.get('liftCylinderRestPose') is not None:
        raise ValueError('Expected an unmarked legacy lift source root')
    objects = list(root.children_recursive)
    before_all_objects = set(bpy.data.objects)
    before_structure = {obj: (obj.name, obj.parent, tuple(obj.children), tuple(tuple(row) for row in obj.matrix_world)) for obj in before_all_objects}
    meshes = [obj for obj in objects if obj.type == 'MESH']
    before_meshes = {obj: mesh_signature(obj) for obj in meshes}
    base, mid, tip, crossshaft = Vector((.48, 0, .16)), Vector((.20, 0, .59)), Vector((.03, 0, .83)), Vector((0, 0, .545))
    pose = cylinder_rest_pose(base, mid, tip, crossshaft)

    def named(suffix):
        return [obj for obj in meshes if obj.name == args.prefix + suffix or obj.name.startswith(args.prefix + suffix + '.')]

    barrels, rods = named('hydraulic_cylinder_barrel'), named('hard_chrome_piston')
    eyes, unions = named('cylinder_mount_eye'), named('hydraulic_hose_union')
    if len(barrels) != 1 or len(rods) != 1 or len(eyes) != 2 or len(unions) != 2:
        raise ValueError('Legacy editable cylinder solids do not match the known source structure')
    upper_eyes = [obj for obj in eyes if (bounds_center(obj) - tip).length < .002]
    upper_hardware = [obj for obj in meshes if obj.parent and obj.parent.name == args.prefix + 'pivot_detail'
                      and (bounds_center(obj) - tip).length < .065]
    if len(upper_eyes) != 1 or len(upper_hardware) != 3:
        raise ValueError('Expected one upper mounting eye and its washer/nut/thread set')
    operations = [(barrels[0], pose['barrel']), (rods[0], pose['rod'])]
    operations += [(obj, pose['barrel']) for obj in unions]
    operations += [(obj, pose['upper_eye']) for obj in upper_eyes + upper_hardware]
    if len({obj for obj, _ in operations}) != len(operations):
        raise ValueError('A source solid cannot receive two pose operations')
    if any(obj.data.users != 1 or obj.modifiers for obj, _ in operations):
        raise ValueError('Only independent, already-baked editable meshes may be repaired')
    original_lengths = [projection_length(barrels[0], (mid - base).normalized()), projection_length(rods[0], (tip - mid).normalized())]
    for obj, transform in operations:
        # Bake only this rigid correction in local mesh data, preserving every
        # Object3D-equivalent name, parent, order and saved object transform.
        local = obj.matrix_world.inverted() @ transform @ obj.matrix_world
        obj.data.transform(local)
        obj.data.update()
    root['liftCylinderRestPose'] = three_rest_pose_marker(pose)
    bpy.context.view_layer.update()

    assert set(bpy.data.objects) == before_all_objects, 'No source objects may be added or removed'
    for obj, before in before_structure.items():
        assert (obj.name, obj.parent, tuple(obj.children), tuple(tuple(row) for row in obj.matrix_world)) == before, 'Source hierarchy/object transforms changed: ' + obj.name
    edited = {obj for obj, _ in operations}
    for obj, before in before_meshes.items():
        after = mesh_signature(obj)
        assert {key: value for key, value in after.items() if key != 'coordinates'} == {key: value for key, value in before.items() if key != 'coordinates'}, 'Topology/materials changed: ' + obj.name
        if obj not in edited:
            assert after == before, 'Unrelated editable source geometry changed: ' + obj.name
    new_lengths = [projection_length(obj, pose['axis']) for obj in [barrels[0], rods[0]]]
    assert all(abs(before - after) < 5e-6 for before, after in zip(original_lengths, new_lengths)), 'Cylinder lengths must be rigidly preserved'
    assert (bounds_center(upper_eyes[0]) - crossshaft).length < 2e-6, 'The upper eye must meet the scissor centre shaft'
    assert (bounds_center(barrels[0]) - (pose['base'] + pose['barrel_tip']) / 2).length < 2e-6
    assert (bounds_center(rods[0]) - (pose['rod_start'] + pose['tip']) / 2).length < 2e-6
    assert (pose['barrel_tip'] - pose['rod_start']).dot(pose['axis']) > 0, 'The rod must telescope inside the barrel'
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)
    assert sha(source) == before_hash, 'The original source must remain byte-for-byte intact'
    report = {
        'success': True, 'input': str(source), 'inputSha256': before_hash,
        'output': str(output), 'outputSha256': sha(output),
        'editedObjects': [obj.name for obj, _ in operations],
        'objects': len(before_all_objects), 'sourceMeshes': len(meshes),
        'objectHierarchyUnchanged': True, 'topologyMaterialsUnchanged': True,
        'unrelatedGeometryUnchanged': True, 'inputUnchanged': True,
        'originalCylinderLengths': original_lengths, 'correctedCylinderLengths': new_lengths,
        'rodBarrelOverlap': (pose['barrel_tip'] - pose['rod_start']).dot(pose['axis']),
        'liftCylinderRestPose': three_rest_pose_marker(pose),
    }
    output.with_suffix('.validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print('LIFT_SOURCE_REPAIR ' + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
