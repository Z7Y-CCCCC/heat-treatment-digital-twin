"""Add the explicitly reviewed lift through-shaft to a new editable source copy.

Run only in isolated Blender --background --factory-startup. The input, all
existing objects, saved transforms, mesh geometry and materials remain intact.
No GLB export, installed-service write, database operation or asset scan occurs.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

PREFIX = 'cad_lifting_staging_table_v1_'
CENTER = (0.0, 0.0, 0.545)  # Blender Z-up root-local metres
RADIUS, LENGTH, SIDES = 0.018, 0.78, 24
MARKER = {'schemaVersion': 1, 'node': PREFIX + 'crossshaft_metal',
          'center': [0, .545, 0], 'axis': [0, 0, 1],
          'radius': RADIUS, 'length': LENGTH}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mesh_signature(obj):
    mesh = obj.data
    digest = hashlib.sha256()
    for vertex in mesh.vertices:
        digest.update(struct.pack('<3f', *vertex.co))
    return {
        'coordinates': digest.hexdigest(), 'vertices': len(mesh.vertices),
        'edges': [tuple(edge.vertices) for edge in mesh.edges],
        'polygons': [(tuple(face.vertices), face.material_index, face.use_smooth)
                     for face in mesh.polygons],
        'materials': [material.name if material else None for material in mesh.materials],
    }


def structure(obj):
    return (obj.name, obj.parent, tuple(obj.children),
            tuple(tuple(row) for row in obj.matrix_world))


def require_output(source, output):
    if source == output or output.exists():
        raise ValueError('Choose a new .blend output distinct from the preserved input')
    if source.suffix.lower() != '.blend' or output.suffix.lower() != '.blend':
        raise ValueError('Explicit .blend input and output are required')
    lowered = [part.lower() for part in output.parts]
    if 'uploads' in lowered or ('backend' in lowered and 'data' in lowered):
        raise ValueError('No output to uploads or database directories is allowed')


def main():
    if not bpy.app.background:
        raise RuntimeError('Use an isolated --background --factory-startup process')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source, output = args.input.resolve(strict=True), args.output.resolve()
    require_output(source, output)
    input_sha = sha(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    root = bpy.data.objects.get(PREFIX + 'root')
    if root is None or root.get('liftCylinderRestPose') is None:
        raise ValueError('Expected the reviewed, rest-pose-corrected editable lift source')
    if root.get('liftCrossshaft') is not None or bpy.data.objects.get(PREFIX + 'crossshaft'):
        raise ValueError('Source already declares a shaft; do not duplicate its geometry')
    marker = root['liftCylinderRestPose'].to_dict()
    if marker.get('schemaVersion') != 1 or marker.get('coordinateSpace') != 'three-y-up-local-m':
        raise ValueError('Unsupported cylinder rest-pose declaration')
    if (Vector(marker['tip']) - Vector((0, .545, 0))).length > 1e-6:
        raise ValueError('Unexpected upper eye; shaft position must be reviewed separately')

    before_objects = tuple(bpy.data.objects)
    before_structure = {obj: structure(obj) for obj in before_objects}
    before_meshes = {obj: mesh_signature(obj) for obj in before_objects if obj.type == 'MESH'}
    material = bpy.data.materials.get('CAD26_metal')
    pivot_parent = bpy.data.objects.get(PREFIX + 'pivot_detail')
    lift_parent = bpy.data.objects.get(PREFIX + 'lift')
    sleeves = [obj for obj in root.children_recursive
               if obj.name == PREFIX + 'pivot_cross_pin' or obj.name.startswith(PREFIX + 'pivot_cross_pin.')]
    if material is None or pivot_parent is None or lift_parent is None or lift_parent.parent != root or len(sleeves) != 2:
        raise ValueError('Expected the existing metal material, scissor/pivot groups and two side sleeves')

    group = bpy.data.objects.new(PREFIX + 'crossshaft', None)
    root.users_collection[0].objects.link(group)
    group.parent = lift_parent
    group.matrix_world = root.matrix_world.copy()
    group['part'] = 'crossshaft'
    # Root-local coordinates and identity object transforms avoid altering the
    # saved world frame of any existing editable solid.
    vertices = [(RADIUS * math.cos(i * 2 * math.pi / SIDES), y,
                 CENTER[2] + RADIUS * math.sin(i * 2 * math.pi / SIDES))
                for y in [-LENGTH / 2, LENGTH / 2] for i in range(SIDES)]
    faces = [(i, SIDES + i, SIDES + (i + 1) % SIDES, (i + 1) % SIDES)
             for i in range(SIDES)]
    faces += [tuple(range(SIDES)), tuple(reversed(range(SIDES, 2 * SIDES)))]
    mesh = bpy.data.meshes.new(PREFIX + 'pivot_crossshaft_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    mesh.update()
    for face in mesh.polygons:
        face.use_smooth = len(face.vertices) == 4
    shaft = bpy.data.objects.new(PREFIX + 'pivot_crossshaft', mesh)
    root.users_collection[0].objects.link(shaft)
    shaft.parent = group
    root['liftCrossshaft'] = MARKER
    bpy.context.view_layer.update()

    after_objects = set(bpy.data.objects)
    assert after_objects - set(before_objects) == {group, shaft}, 'Only the reviewed shaft and group may be added'
    assert set(before_objects) <= after_objects, 'No existing source object may be removed'
    assert tuple(root.children) == before_structure[root][2], 'Root-level inspection children must remain exactly unchanged'
    assert group.parent == lift_parent and shaft.parent == group, 'The shaft must belong to the existing scissor assembly'
    assert tuple(tuple(row) for row in group.matrix_world) == tuple(tuple(row) for row in root.matrix_world), 'New shaft geometry must stay in the model root-local frame'
    for obj, before in before_structure.items():
        after = structure(obj)
        assert after[:2] == before[:2] and after[3] == before[3], 'Old object name, parent or transform changed: ' + obj.name
        assert tuple(child for child in after[2] if child in before_objects) == before[2], 'Old sibling ordering changed: ' + obj.name
    for obj, before in before_meshes.items():
        assert mesh_signature(obj) == before, 'Existing source geometry/materials changed: ' + obj.name
    assert root['liftCylinderRestPose'].to_dict() == marker, 'Cylinder rest-pose metadata changed'
    points = [vertex.co for vertex in mesh.vertices]
    assert abs(min(point.y for point in points) + LENGTH / 2) < 1e-6
    assert abs(max(point.y for point in points) - LENGTH / 2) < 1e-6
    assert max(abs(math.hypot(point.x, point.z - CENTER[2]) - RADIUS) for point in points) < 1e-6
    for face in mesh.polygons[:SIDES]:
        radial = Vector((face.center.x, 0, face.center.z - CENTER[2])).normalized()
        assert face.normal.dot(radial) > .999, 'Cylinder side faces must point outward'
    assert mesh.polygons[SIDES].normal.y < -.999
    assert mesh.polygons[SIDES + 1].normal.y > .999
    assert RADIUS < .019, 'Shaft must fit the existing Ø38 upper-eye bore'
    # Existing sleeves span [-.43,-.27] and [.27,.43]; this shaft overlaps both.
    assert LENGTH / 2 > .27, 'Shaft must physically join both side sleeves'

    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)
    assert sha(source) == input_sha, 'Preserved input was changed'
    report = {'success': True, 'input': str(source), 'inputSha256': input_sha,
              'output': str(output), 'outputSha256': sha(output),
              'addedObjects': [group.name, shaft.name], 'objectsBefore': len(before_objects),
              'objectsAfter': len(after_objects), 'oldObjectHierarchyUnchanged': True,
              'oldGeometryMaterialsUnchanged': True, 'inputUnchanged': True,
              'rootChildrenUnchanged': True, 'shaftInspectionBranch': lift_parent.name,
              'centerBlender': list(CENTER), 'throughEyeBore': True,
              'sideSleeveOverlapMetres': LENGTH / 2 - .27, 'liftCrossshaft': MARKER}
    output.with_suffix('.validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print('LIFT_CROSSSHAFT_SOURCE ' + json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
