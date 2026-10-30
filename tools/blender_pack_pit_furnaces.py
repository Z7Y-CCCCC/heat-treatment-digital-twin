"""Repair the five-furnace editable bundle without regenerating geometry.

Run with Blender --background --factory-startup --python this_file.
Only PitFurnace4's standalone BLEND and the combined BLEND are replaced.
Previous versions are copied to output/pit-furnace-recovery-backups first.
GLB, FBX, materials, reference images and renders are never modified.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil

import bpy
import bmesh
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "backend/assets/models/pit_furnace_references_v1"
OUTPUT = ROOT / "output"
BACKUPS = OUTPUT / "pit-furnace-recovery-backups"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contents(path: Path) -> dict:
    with bpy.data.libraries.load(str(path), link=False) as (source, _):
        return {
            "scenes": sorted(source.scenes),
            "roots": sorted(name for name in source.objects
                            if name.endswith("_root") and name.startswith("pit_furnace_")),
        }


def check_solid_panels(scene) -> dict:
    """Check the front panels only; these do not establish a cabinet body."""
    bpy.context.window.scene = scene
    bpy.context.view_layer.update()
    expected = ("continuous_opaque_main_panel", "solid_inner_plate_backing")
    result = {"valid": True, "panels": []}
    for suffix in expected:
        matches = [obj for obj in scene.objects if obj.type == "MESH"
                   and obj.name == "pf5_" + suffix]
        assert len(matches) == 1, f"Expected one solid PF5 panel: {suffix}"
        obj = matches[0]
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            manifold = bool(bm.edges) and all(edge.is_manifold for edge in bm.edges)
            volume = bm.calc_volume(signed=False)
        finally:
            bm.free()
            evaluated.to_mesh_clear()
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        lo = Vector(tuple(min(c[k] for c in corners) for k in range(3)))
        hi = Vector(tuple(max(c[k] for c in corners) for k in range(3)))
        inverse = obj.matrix_world.inverted()
        direction = (inverse.to_3x3() @ Vector((0, 1, 0))).normalized()
        hits = 0
        for u in (.05, .275, .5, .725, .95):
            for v in (.05, .275, .5, .725, .95):
                origin = inverse @ Vector((lo.x + (hi.x - lo.x) * u,
                                            lo.y - 1, lo.z + (hi.z - lo.z) * v))
                hits += bool(evaluated.ray_cast(origin, direction)[0])
        alphas = [node.inputs["Alpha"].default_value for material in obj.data.materials
                  for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]
        valid = manifold and volume > 1e-5 and hi.y - lo.y > .01 and hits == 25
        valid = valid and bool(alphas) and all(alpha >= .999 for alpha in alphas) and not obj.hide_render
        result["panels"].append({"name": obj.name, "closed_manifold": manifold,
                                  "volume_local_m3": volume, "thickness_m": hi.y - lo.y,
                                  "front_sample_hits": hits, "front_samples": 25,
                                  "material_alphas": alphas, "visible": not obj.hide_render,
                                  "valid": valid})
        result["valid"] &= valid
    assert result["valid"], result
    return result


def mesh_solidity(obj, min_volume=1e-10) -> dict:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        closed = bool(bm.edges) and all(edge.is_manifold for edge in bm.edges)
        volume = bm.calc_volume(signed=False)
    finally:
        bm.free()
        evaluated.to_mesh_clear()
    alphas = [node.inputs["Alpha"].default_value for material in obj.data.materials
              if material and material.use_nodes
              for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]
    visible = not obj.hide_render and obj.visible_get()
    opaque = bool(alphas) and all(alpha >= .999 for alpha in alphas)
    return {"name": obj.name, "closed_manifold": closed, "volume_local_m3": volume,
            "material_alphas": alphas, "opaque": opaque, "visible": visible,
            "valid": closed and volume > min_volume and opaque and visible}


def mesh_bounds(objects) -> dict:
    points = [obj.matrix_world @ Vector(c) for obj in objects for c in obj.bound_box]
    assert points, "Cannot verify the bounds of an empty cabinet group."
    lower = [min(p[k] for p in points) for k in range(3)]
    upper = [max(p[k] for p in points) for k in range(3)]
    return {"min_blender_xyz": lower, "max_blender_xyz": upper,
            "size_blender_xyz": [upper[k] - lower[k] for k in range(3)]}


def check_cabinet_body(edit_scene, runtime_scene) -> dict:
    """Reject the obsolete freestanding door even when its front panels are solid."""
    expected = ("pf5_cabinet_side_wall_L", "pf5_cabinet_side_wall_R",
                "pf5_cabinet_back_wall", "pf5_cabinet_top", "pf5_cabinet_bottom")
    bpy.context.window.scene = edit_scene
    bpy.context.view_layer.update()
    components = []
    for name in expected:
        matches = [obj for obj in edit_scene.objects if obj.type == "MESH" and obj.name == name]
        assert len(matches) == 1, f"Missing cabinet wall/top/bottom: {name}"
        record = mesh_solidity(matches[0], min_volume=1e-5)
        record["bounds"] = mesh_bounds(matches)
        # Real wall pieces must have nonzero thickness on every axis.
        record["valid"] &= min(record["bounds"]["size_blender_xyz"]) > .015
        components.append(record)
    scenes = []
    for scene in (edit_scene, runtime_scene):
        bpy.context.window.scene = scene
        bpy.context.view_layer.update()
        shell_groups = [obj for obj in scene.objects
                        if obj.get("functional_group") == "f5_insulated_cabinet_shell"]
        base_groups = [obj for obj in scene.objects
                       if obj.get("functional_group") == "f5_cabinet_support_base"]
        assert len(shell_groups) == 1 and len(base_groups) == 1, "Cabinet shell/base group missing."
        shell_meshes = [obj for obj in shell_groups[0].children_recursive if obj.type == "MESH"]
        base_meshes = [obj for obj in base_groups[0].children_recursive if obj.type == "MESH"]
        shell = mesh_bounds(shell_meshes)
        width, depth, height = shell["size_blender_xyz"]
        solid_meshes = [mesh_solidity(obj) for obj in shell_meshes]
        roots = [obj for obj in scene.objects if obj.name.startswith("pit_furnace_5_v1_")
                 and obj.parent is None]
        assert len(roots) == 1, "Expected one furnace 5 equipment root."
        equipment_meshes = [obj for obj in roots[0].children_recursive if obj.type == "MESH"]
        valid = (2.5 <= width <= 3.4 and abs(depth - 1.65) <= .12 and 4.0 <= height <= 4.9
                 and bool(base_meshes) and all(item["valid"] for item in solid_meshes))
        scenes.append({"scene": scene.name, "valid": valid, "shell_bounds": shell,
                       "equipment_bounds": mesh_bounds(equipment_meshes),
                       "shell_meshes": solid_meshes, "support_mesh_count": len(base_meshes)})
    consistent = all(abs(a - b) < .02 for a, b in zip(
        scenes[0]["shell_bounds"]["size_blender_xyz"], scenes[1]["shell_bounds"]["size_blender_xyz"]))
    result = {"valid": all(c["valid"] for c in components) and all(s["valid"] for s in scenes) and consistent,
              "interpretation": "Cabinet-depth furnace body, not a freestanding door/panel",
              "expected_cabinet_depth_m": 1.65, "components": components,
              "scenes": scenes, "edit_runtime_dimensions_match": consistent}
    assert result["valid"], {
        "failed_components": [c["name"] for c in components if not c["valid"]],
        "failed_scenes": [{"scene": s["scene"], "bounds": s["shell_bounds"],
                           "invalid_meshes": [m["name"] for m in s["shell_meshes"] if not m["valid"]]}
                          for s in scenes if not s["valid"]],
        "edit_runtime_dimensions_match": consistent,
    }
    return result


def main() -> None:
    if bpy.data.filepath or any(s.name != "Scene" for s in bpy.data.scenes):
        raise RuntimeError("Use --factory-startup; do not run in an existing editing session.")

    OUTPUT.mkdir(exist_ok=True)
    BACKUPS.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    bundle = ASSETS / "pit_furnaces_1_to_5_editable.blend"
    fourth = ASSETS / "PitFurnace4/pit_furnace_4_v1.blend"
    replaced = (fourth, bundle)
    protected = sorted(p for p in ASSETS.rglob("*") if p.is_file()
                       and p not in replaced)
    before = {str(p.relative_to(ROOT)): digest(p) for p in protected}
    report = {"timestamp_utc": stamp, "operation": "scene-only repack; no geometry regeneration",
              "backup_directory": str(BACKUPS),
              "preexisting_backup_files": sorted(str(p) for p in BACKUPS.glob("*.blend")),
              "backups": [], "sources": [], "results": []}
    for target in replaced:
        backup = BACKUPS / f"{target.parent.name}-{target.stem}.{stamp}.blend"
        shutil.copy2(target, backup)
        assert digest(backup) == digest(target)
        report["backups"].append({"target": str(target), "backup": str(backup),
                                  "sha256": digest(backup), "before": contents(target)})

    initial_scenes = list(bpy.data.scenes)
    scenes_by_number = {}
    for number in range(1, 6):
        source_path = ASSETS / f"PitFurnace{number}/pit_furnace_{number}_v1.blend"
        names = [f"井式炉{number}_EDIT", f"井式炉{number}_RUNTIME"]
        with bpy.data.libraries.load(str(source_path), link=False) as (source, target):
            missing = set(names).difference(source.scenes)
            if missing:
                raise RuntimeError(f"{source_path}: missing scenes {sorted(missing)}")
            target.scenes = list(names)
        scenes_by_number[number] = list(target.scenes)
        assert sorted(s.name for s in target.scenes) == sorted(names)
        report["sources"].append({"path": str(source_path), "sha256": digest(source_path),
                                  "selected_scenes": names})

    report["fifth_solid_panels"] = check_solid_panels(scenes_by_number[5][0])
    report["fifth_cabinet_body"] = check_cabinet_body(*scenes_by_number[5])
    # Library writing includes only these scene datablocks and their dependencies.
    bpy.data.libraries.write(str(fourth), set(scenes_by_number[4]),
                             fake_user=True, compress=True)
    bpy.context.window.scene = scenes_by_number[1][0]
    for scene in initial_scenes:
        bpy.data.scenes.remove(scene)
    for obj in list(bpy.data.objects):
        if obj.users == 0:
            bpy.data.objects.remove(obj)
    bpy.context.window.scene = scenes_by_number[1][0]
    # Keep this process untitled so the saved bundle can be reopened read-only
    # for inspection below. Backups were already created explicitly above.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(bundle), compress=True, copy=True)

    for target, numbers in ((fourth, [4]), (bundle, list(range(1, 6)))):
        actual = contents(target)
        expected_scenes = sorted(f"井式炉{n}_{suffix}" for n in numbers
                                 for suffix in ("EDIT", "RUNTIME"))
        expected_roots = sorted(f"pit_furnace_{n}_v1_{suffix}" for n in numbers
                                for suffix in ("root", "editable_root"))
        assert actual["scenes"] == expected_scenes, actual
        assert actual["roots"] == expected_roots, actual
        report["results"].append({"path": str(target), "sha256": digest(target),
                                  "valid": True, **actual})
    changed = [path for path, old_hash in before.items()
               if digest(ROOT / path) != old_hash]
    assert not changed, f"Protected files changed: {changed}"
    report["protected_files_checked"] = len(before)
    report["protected_files_changed"] = changed
    report["fourth_sloped_shields"] = [
        {"name": obj.name, "vertices": len(obj.data.vertices), "faces": len(obj.data.polygons)}
        for obj in scenes_by_number[4][0].objects
        if obj.type == "MESH" and "sloped_transfer_shield" in obj.name
    ]
    report["notes"] = [
        "Five independent EDIT/RUNTIME pairs are retained; production Factory scene is not touched.",
        "Packing deliberately retains existing geometry and does not replace mesh data.",
        "Furnace 5 requires a deep, closed opaque cabinet shell in EDIT and RUNTIME, not only solid front panels.",
    ]
    if any(obj["faces"] == 1 for obj in report["fourth_sloped_shields"]):
        report["notes"].append("PF4's single-face sloped shields predate the procedural builder's thickness fix.")
    report_path = OUTPUT / "pit-furnace-blend-recovery-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PACK_VERIFIED " + json.dumps({"report": str(report_path),
        "bundle_scenes": len(report["results"][1]["scenes"]),
        "fourth_scenes": len(report["results"][0]["scenes"]),
        "protected_files_unchanged": len(before)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
