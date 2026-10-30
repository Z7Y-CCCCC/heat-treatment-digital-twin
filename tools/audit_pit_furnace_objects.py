"""Read-only inventory of authored furnace components; does not certify CAD fidelity.

Run in Blender with --background --factory-startup --python-exit-code 1.
Loads only the five EDIT scenes and writes a bounded JSON inventory under output.
"""
from pathlib import Path
import json

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "backend/assets/models/pit_furnace_references_v1"


def main():
    result = {"scope": "Actual authored mesh inventory, not a CAD bill of materials or completeness certificate.",
              "cad_component_completeness_verified": False, "furnaces": []}
    for number in range(1, 6):
        path = ASSETS / f"PitFurnace{number}/pit_furnace_{number}_v1.blend"
        name = f"井式炉{number}_EDIT"
        with bpy.data.libraries.load(str(path), link=False) as (source, target):
            assert name in source.scenes, name
            target.scenes = [name]
        scene = target.scenes[0]
        bpy.context.window.scene = scene
        bpy.context.view_layer.update()
        groups = []
        for group in sorted((o for o in scene.objects if o.get("functional_group")), key=lambda o: o.name):
            parts = []
            for obj in sorted((o for o in group.children_recursive if o.type == "MESH"), key=lambda o: o.name):
                points = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
                lower = [min(p[k] for p in points) for k in range(3)]
                upper = [max(p[k] for p in points) for k in range(3)]
                parts.append({"object": obj.name,
                              "size_xyz_m": [round(upper[k] - lower[k], 6) for k in range(3)],
                              "center_xyz_m": [round((upper[k] + lower[k]) / 2, 6) for k in range(3)],
                              "materials": [m.name for m in obj.data.materials if m],
                              "visible_in_render": not obj.hide_render})
            groups.append({"functional_group": group["functional_group"], "mesh_count": len(parts), "parts": parts})
        result["furnaces"].append({"number": number, "source": str(path), "groups": groups,
                                    "mesh_count": sum(g["mesh_count"] for g in groups)})
    target = ROOT / "output/pit-furnace-authored-components.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"inventory": str(target), "furnaces": [
        {"number": f["number"], "groups": len(f["groups"]), "meshes": f["mesh_count"]}
        for f in result["furnaces"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
