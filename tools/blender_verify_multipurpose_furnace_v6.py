"""Round-trip the V6 GLB into an isolated Blender scene and test its motion.

Run through blender_mcp_client.py after exporting V6. The test scene is removed
afterward; source scenes, source objects and production configuration are not
modified. Verification results are appended to the V6 delivery report only.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Vector


WORKSPACE = Path(__file__).resolve().parents[1]
OUT = WORKSPACE / "backend" / "assets" / "models"
MODEL_ID = "photo_multipurpose_furnace_v6"
CHECK_SCENE = "V6_ISOLATED_ROUNDTRIP_CHECK"


def bounds(objects):
    points=[obj.matrix_world @ Vector(corner) for obj in objects if obj.type=="MESH" for corner in obj.bound_box]
    return [min(p[i] for p in points) for i in range(3)]+[max(p[i] for p in points) for i in range(3)]


def target(scene,name):
    matches=[obj for obj in scene.objects if obj.name==name or (obj.name.startswith(name+".") and obj.name[len(name)+1:].isdigit())]
    if len(matches)!=1:
        raise AssertionError(f"Round-trip node {name!r} not unique: {[obj.name for obj in matches]}")
    return matches[0]


def verify():
    metadata=json.loads((OUT/(MODEL_ID+"_metadata.json")).read_text(encoding="utf-8"))
    report_path=OUT/(MODEL_ID+"_report.json")
    report=json.loads(report_path.read_text(encoding="utf-8"))
    original_scene=bpy.context.window.scene
    if bpy.data.scenes.get(CHECK_SCENE):
        raise RuntimeError("An earlier isolated check scene exists; inspect it before retrying")
    expected_root=bpy.data.objects[MODEL_ID+"_root"]
    bpy.context.window.scene=bpy.data.scenes["V6_RUNTIME_EXPORT"]
    bpy.context.view_layer.update()
    expected_bounds=bounds(expected_root.children_recursive)
    scene=bpy.data.scenes.new(CHECK_SCENE)
    scene["v6_verification"]=True
    bpy.context.window.scene=scene
    result={"status":"running"}
    try:
        bpy.ops.import_scene.gltf(filepath=str(OUT/(MODEL_ID+".glb")))
        bpy.context.view_layer.update()
        imported=list(scene.objects)
        root=target(scene,MODEL_ID+"_root")
        actual_bounds=bounds(root.children_recursive)
        bounds_error=max(abs(a-b) for a,b in zip(expected_bounds,actual_bounds))
        assert bounds_error<1e-4, f"Import changed the model bounds: {bounds_error}"
        triangles=0
        for obj in root.children_recursive:
            if obj.type=="MESH":
                obj.data.calc_loop_triangles()
                triangles+=len(obj.data.loop_triangles)
        assert triangles==report["stats"]["triangles"]
        for binding in metadata["partBindings"]:
            obj=target(scene,binding["node_name"])
            assert obj.parent==root and len(obj.children)>0
            assert binding["axis"]=="y", f"Unexpected V6 GLB binding axis: {binding}"
        depsgraph=bpy.context.evaluated_depsgraph_get()
        ray_origin=Vector((4.0,0.0,1.8))
        ray_direction=Vector((-1,0,0))
        closed_hit=scene.ray_cast(depsgraph,ray_origin,ray_direction)
        assert closed_hit[0] and "door_front_lift" in closed_hit[4].name, "Closed door does not cover its aperture"
        door=target(scene,"door_front_lift")
        closed_position=door.location.copy()
        front_binding=next(b for b in metadata["partBindings"] if b["node_name"]=="door_front_lift")
        door.location.z+=front_binding["output_max"]  # glTF +Y becomes Blender +Z on import
        bpy.context.view_layer.update()
        open_hit=scene.ray_cast(depsgraph,ray_origin,ray_direction)
        assert open_hit[0] and "door_front_lift" not in open_hit[4].name
        assert open_hit[1].x<closed_hit[1].x-.3, "A static duplicate still occludes the aperture"
        door_travel_checks=[]
        for binding in metadata["partBindings"]:
            if binding["action"]!="translate":
                continue
            moving=target(scene,binding["node_name"])
            start=moving.location.copy()
            if moving==door:
                moving.location=closed_position.copy()
            closed=moving.location.copy()
            minimum_clearance=float("inf")
            for step in range(11):
                moving.location.z=closed.z+binding["output_max"]*step/10
                bpy.context.view_layer.update()
                for child in moving.children_recursive:
                    if child.type!="MESH":
                        continue
                    for corner in child.bound_box:
                        p=child.matrix_world @ Vector(corner)
                        if 1.58<=p.x<=2.99:
                            roof_height=4.39-(p.x-1.58)*.91/1.41
                        else:
                            roof_height=4.23+(p.x-1.36)*.16/.22
                        clearance=roof_height-.004-p.z
                        minimum_clearance=min(minimum_clearance,clearance)
                        assert clearance>.012, f"{moving.name} penetrates hood roof at step {step}: {clearance}"
            moving.location=start
            door_travel_checks.append({"node":binding["node_name"],"samples":11,
                                       "roof_min_clearance_m":minimum_clearance})
        bpy.context.view_layer.update()
        static_housing=target(scene,"drive_housings")
        housing_before=bounds(static_housing.children_recursive)
        rotations=[]
        for binding in metadata["partBindings"]:
            if binding["action"]!="rotate_speed":
                continue
            obj=target(scene,binding["node_name"])
            before=bounds(obj.children_recursive)
            initial_rotation=obj.rotation_euler.copy()
            obj.rotation_euler.z+=math.pi/2
            bpy.context.view_layer.update()
            after=bounds(obj.children_recursive)
            assert abs(before[2]-after[2])<1e-5 and abs(before[5]-after[5])<1e-5, "Vertical rotation changed rotor height"
            rotations.append({"node":binding["node_name"],"gltf_local_axis":"y","blender_axis":"z","height_invariant":True})
            obj.rotation_euler=initial_rotation
        bpy.context.view_layer.update()
        assert max(abs(a-b) for a,b in zip(housing_before,bounds(static_housing.children_recursive)))<1e-6
        result={
            "status":"passed","imported_objects":len(imported),"triangles":triangles,
            "bounds_blender_xyz":actual_bounds,"bounds_max_error_m":bounds_error,
            "bindings_resolved":len(metadata["partBindings"]),
            "closed_door_ray_hit":{"object":closed_hit[4].name,"x":closed_hit[1].x},
            "open_door_ray_hit":{"object":open_hit[4].name,"x":open_hit[1].x},
            "front_door_clear_after_lift":True,"rotor_checks":rotations,
            "door_travel_checks":door_travel_checks,
            "static_motor_housings_remain_fixed":True,
            "production_runtime_tested":False,
        }
        # Verify exported normals/materials visually, not only the source scene.
        study=bpy.data.scenes["V6_PHOTO_STUDY"]
        scene.world=study.world
        for source in study.objects:
            if source.type in {"CAMERA","LIGHT"} or source.name=="multi_v6_review_floor":
                obj=source.copy()
                if source.data: obj.data=source.data.copy()
                scene.collection.objects.link(obj)
                if source==study.camera: scene.camera=obj
        scene.render.engine="BLENDER_EEVEE"
        scene.render.resolution_x=1440
        scene.render.resolution_y=1120
        scene.render.resolution_percentage=100
        scene.render.image_settings.file_format="PNG"
        scene.view_settings.view_transform=study.view_settings.view_transform
        scene.view_settings.look=study.view_settings.look
        scene.render.filepath=str(OUT/(MODEL_ID+"_runtime_check.png"))
        bpy.ops.render.render(write_still=True)
        result["render"]=str(Path(scene.render.filepath).relative_to(WORKSPACE))
        door.location=closed_position
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        result={"status":"failed","error":str(exc)}
        raise
    finally:
        report["roundtrip"]=result
        report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        metadata["acceptance"]["roundtrip_verified"]=result["status"]=="passed"
        metadata["acceptance"]["production_runtime_tested"]=False
        (OUT/(MODEL_ID+"_metadata.json")).write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
        bpy.context.window.scene=original_scene
        # Only objects belonging to the newly-created isolated test scene.
        for obj in list(scene.objects):
            bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.scenes.remove(scene)
    return result


if __name__=="__main__":
    verify()
