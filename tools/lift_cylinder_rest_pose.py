"""Rigid cylinder rest-pose math shared by CAD builders and explicit source repair.

Inputs and transforms use Blender Z-up local metres. The export marker is
explicitly converted to glTF / Three.js Y-up local metres.
"""
from mathutils import Matrix, Vector


def cylinder_rest_pose(base, barrel_tip, rod_tip, crossshaft):
    base, barrel_tip, rod_tip, crossshaft = map(Vector, (base, barrel_tip, rod_tip, crossshaft))
    barrel_length = (barrel_tip - base).length
    rod_length = (rod_tip - barrel_tip).length
    stroke_axis = crossshaft - base
    if min(barrel_length, rod_length, stroke_axis.length) < 1e-8:
        raise ValueError('Cylinder anchors must be distinct')
    axis = stroke_axis.normalized()
    if barrel_length >= stroke_axis.length:
        raise ValueError('The barrel must end before the upper mounting eye')
    if barrel_length + rod_length <= stroke_axis.length:
        raise ValueError('The rod must telescope into the barrel at rest')
    barrel_rotation = (barrel_tip - base).normalized().rotation_difference(axis)
    rod_rotation = (rod_tip - barrel_tip).normalized().rotation_difference(axis)

    def around_pin(before, after, rotation):
        return Matrix.Translation(after) @ rotation.to_matrix().to_4x4() @ Matrix.Translation(-before)

    return {
        'base': base,
        'barrel_tip': base + axis * barrel_length,
        'rod_start': crossshaft - axis * rod_length,
        'tip': crossshaft,
        'axis': axis,
        'barrel_length': barrel_length,
        'rod_length': rod_length,
        'barrel': around_pin(base, base, barrel_rotation),
        'rod': around_pin(rod_tip, crossshaft, rod_rotation),
        'upper_eye': Matrix.Translation(crossshaft - rod_tip),
    }


def three_rest_pose_marker(pose):
    def y_up(point):
        return [float(point.x), float(point.z), float(-point.y)]
    return {
        'schemaVersion': 1,
        'coordinateSpace': 'three-y-up-local-m',
        'base': y_up(pose['base']),
        'mid': y_up(pose['barrel_tip']),
        'tip': y_up(pose['tip']),
    }
