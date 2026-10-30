"""Verify five furnace exports, Unity reviews/package, and protected originals.

Read-only toward source assets. Writes one JSON report under output and returns
nonzero for any missing, stale, out-of-scope, or failed delivery component.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct
import sys
import tarfile

from validate_equipment_glb import read_glb, validate


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "backend/assets/models/pit_furnace_references_v1"
UNITY = ROOT / "unity-client"
UNITY_PATH = "Assets/Equipment/PitFurnaceReferences"
UNITY_ASSETS = UNITY / UNITY_PATH
IMPORTER = "Assets/Editor/PitFurnaceReferenceImport.cs"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def png_size(path: Path) -> list[int]:
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a PNG image: {path}")
    width, height = struct.unpack(">II", header[16:24])
    if min(width, height) < 100 or path.stat().st_size < 1000:
        raise ValueError(f"Image is unexpectedly small: {path}")
    return [width, height]


def glb_mesh_bounds(path: Path, document: dict, functional_group: str | None = None) -> dict:
    """Measure actual exported POSITION data, including the node transform chain.

    glTF and Unity are Y-up; Blender's cabinet depth Y therefore becomes Z.
    Accessor min/max and descriptive metadata are deliberately not trusted here.
    """
    data = path.read_bytes()
    offset, binary = 12, None
    while offset < len(data):
        size, kind = struct.unpack_from("<I4s", data, offset)
        offset += 8
        if kind == b"BIN\x00":
            binary = data[offset:offset + size]
        offset += size
    if binary is None:
        raise ValueError("GLB has no binary geometry data.")
    identity = [[float(i == j) for j in range(4)] for i in range(4)]

    def multiply(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

    def transform(node):
        if "matrix" in node:
            values = node["matrix"]
            return [[values[col * 4 + row] for col in range(4)] for row in range(4)]
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        scale = node.get("scale", [1, 1, 1])
        translation = node.get("translation", [0, 0, 0])
        rotation = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                    [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                    [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
        return [[rotation[row][col] * scale[col] for col in range(3)] + [translation[row]]
                for row in range(3)] + [[0, 0, 0, 1]]

    positions = {}

    def points(accessor_index):
        if accessor_index not in positions:
            accessor = document["accessors"][accessor_index]
            if accessor.get("componentType") != 5126 or accessor.get("type") != "VEC3" or "sparse" in accessor:
                raise ValueError("Cabinet bounds require nonsparse FLOAT VEC3 positions.")
            view = document["bufferViews"][accessor["bufferView"]]
            if view.get("buffer", 0) != 0:
                raise ValueError("Expected geometry in the GLB's binary buffer.")
            start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            stride = view.get("byteStride", 12)
            positions[accessor_index] = [struct.unpack_from("<3f", binary, start + n * stride)
                                         for n in range(accessor["count"])]
        return positions[accessor_index]

    measured = []
    mesh_nodes = []

    def visit(index, parent, selected, ancestors):
        if index in ancestors:
            raise ValueError("Cycle in GLB node hierarchy.")
        node = document["nodes"][index]
        world = multiply(parent, transform(node))
        selected = selected or node.get("extras", {}).get("functional_group") == functional_group
        if selected and "mesh" in node:
            mesh_nodes.append(node.get("name", str(index)))
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                for point in points(primitive["attributes"]["POSITION"]):
                    measured.append([sum(world[row][col] * point[col] for col in range(3)) + world[row][3]
                                     for row in range(3)])
        for child in node.get("children", []):
            visit(child, world, selected, ancestors | {index})

    scene = document["scenes"][document.get("scene", 0)]
    for index in scene["nodes"]:
        visit(index, identity, functional_group is None, set())
    if not measured:
        raise ValueError("No geometry for cabinet group: " + str(functional_group))
    lower = [min(point[k] for point in measured) for k in range(3)]
    upper = [max(point[k] for point in measured) for k in range(3)]
    return {"min_gltf_xyz": lower, "max_gltf_xyz": upper,
            "size_gltf_xyz": [upper[k] - lower[k] for k in range(3)], "mesh_nodes": mesh_nodes}


def model_check(number: int) -> dict:
    folder = ASSETS / f"PitFurnace{number}"
    stem = f"pit_furnace_{number}_v1"
    metadata = read_json(folder / "metadata.json")
    document, size = read_glb(folder / f"{stem}.glb")
    report = validate(document, size, stem + "_root", metadata)
    problems = [str(e) for e in report["errors"]]
    groups = [node.get("extras", {}).get("functional_group") for node in document["nodes"]]
    groups = [group for group in groups if group]
    if sorted(groups) != sorted(metadata["groups"]):
        problems.append("GLB functional groups do not match metadata.")
    if metadata.get("model_id") != stem or metadata.get("display_name") != f"井式炉{number}":
        problems.append("Incorrect model identity.")
    if metadata.get("depth_is_estimated") is not True or not metadata.get("dimensional_accuracy"):
        problems.append("Estimated dimensions are not disclosed.")
    cabinet = None
    if number == 5:
        required_groups = {"f5_opaque_solid_main_body", "f5_suspended_solid_inner_plate",
                           "f5_insulated_cabinet_shell", "f5_cabinet_support_base"}
        if not required_groups.issubset(groups) or any("cage" in g or "external_cover" in g for g in groups):
            problems.append("Furnace 5 lacks the deep cabinet furnace shell/base; front panels alone are insufficient.")
        if metadata.get("reference_correction") != "codex-clipboard-2c8fda05-bb20-44a6-a48f-6d2e85812a06.jpg":
            problems.append("Furnace 5 metadata does not identify the latest correction.")
        if "cabinet furnace" not in metadata.get("body_interpretation", "").lower():
            problems.append("Furnace 5 metadata does not disclose the cabinet furnace interpretation.")
        if metadata.get("latest_user_correction") != "Cabinet-depth furnace body, not a freestanding door/panel":
            problems.append("Furnace 5 metadata does not preserve the latest cabinet-depth user correction.")
        if not isinstance(metadata.get("cabinet_depth_m"), (float, int)) or abs(metadata["cabinet_depth_m"] - 1.65) > .01:
            problems.append("Furnace 5 estimated cabinet depth must be recorded as 1.65 m.")
        if any(m.get("alphaMode", "OPAQUE") != "OPAQUE" for m in document.get("materials", [])):
            problems.append("Furnace 5 has a non-opaque material.")
        if any(m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])[3] < .999
               for m in document.get("materials", [])):
            problems.append("Furnace 5 has material alpha below one.")
        try:
            cabinet = glb_mesh_bounds(folder / f"{stem}.glb", document, "f5_insulated_cabinet_shell")
            width, height, depth = cabinet["size_gltf_xyz"]
            if not (2.5 <= width <= 3.4 and 4.0 <= height <= 4.9 and abs(depth - 1.65) <= .12):
                problems.append("Furnace 5 exported shell is not a full-width, full-height, 1.65 m deep cabinet.")
        except (ValueError, KeyError, IndexError, struct.error) as error:
            problems.append("Furnace 5 actual cabinet geometry check failed: " + str(error))
    files = {ext: folder / f"{stem}.{ext}" for ext in ("glb", "fbx", "blend")}
    if any(path.stat().st_size < 100 for path in files.values()):
        problems.append("An exported model file is unexpectedly empty.")
    if sha256(files["fbx"]) != sha256(UNITY_ASSETS / folder.name / files["fbx"].name):
        problems.append("Unity FBX differs from the standalone FBX.")
    palette = {m["name"]: m for m in read_json(folder / "palette.json")["materials"]}
    for material in document.get("materials", []):
        source = palette[material["name"]]
        pbr = material.get("pbrMetallicRoughness", {})
        comparisons = [(pbr.get("metallicFactor", 1), source["metallic"]),
                       (pbr.get("roughnessFactor", 1), source["roughness"])]
        comparisons += list(zip(pbr.get("baseColorFactor", [1] * 4), source["color"]))
        if any(abs(actual - expected) > 1e-6 for actual, expected in comparisons):
            problems.append("GLB palette mismatch: " + material["name"])
    return {"model": stem, "valid": not problems, "errors": problems,
            "stats": report["stats"], "groups": groups, "cabinet_shell_bounds": cabinet,
            "images": {name: png_size(folder / name) for name in ("preview.png", "cutaway.png")},
            "sha256": {ext: sha256(path) for ext, path in files.items()}}


def unity_check(number: int | None) -> dict:
    folder = UNITY_ASSETS / f"PitFurnace{number}" if number else UNITY_ASSETS
    filename = "verification.json" if number else "overview-verification.json"
    path = folder / filename
    report = read_json(path)
    problems = []
    if report.get("status") != "passed":
        problems.append("Unity verification status is not passed.")
    if report.get("previewRendered") is not True:
        problems.append("Unity did not confirm preview rendering.")
    if report.get("errors"):
        problems.extend(report["errors"])
    preview = folder / ("unity-preview.png" if number else "overview-preview.png")
    image_size = png_size(preview)
    if number:
        stem = f"pit_furnace_{number}_v1"
        for name in (f"{stem}.prefab", f"PitFurnace{number}Review.unity"):
            if not (folder / name).is_file():
                problems.append("Missing Unity asset: " + name)
        for key in ("missingMeshes", "missingMaterialSlots", "meshesWithoutNormals"):
            if report.get(key) != 0:
                problems.append(key + " is not zero.")
        if report.get("furnaceIndex") != number or report.get("instanceTriangles", 0) <= 0:
            problems.append("Incorrect or empty Unity model.")
        if path.stat().st_mtime + 1 < (folder / f"{stem}.fbx").stat().st_mtime:
            problems.append("Unity report predates its current FBX.")
        if number == 5:
            required = ("f5_insulated_cabinet_shell", "f5_cabinet_support_base")
            reported_groups = report.get("directChildGroups", [])
            prefab = (folder / f"{stem}.prefab").read_text(encoding="utf-8-sig")
            if any(not any(group in value for value in reported_groups) or group not in prefab for group in required):
                problems.append("Unity prefab/report lacks the corrected cabinet shell or support base.")
            glb_path = ASSETS / "PitFurnace5/pit_furnace_5_v1.glb"
            document, _ = read_glb(glb_path)
            actual = glb_mesh_bounds(glb_path, document)["size_gltf_xyz"]
            unity_size = [report.get("boundsSize", {}).get(axis, 0) for axis in ("x", "y", "z")]
            if unity_size[2] < 1.5 or any(abs(a - b) > .03 for a, b in zip(actual, unity_size)):
                problems.append("Unity furnace 5 bounds differ from the current thick-cabinet GLB.")
    else:
        if report.get("nonOverlapping") is not True:
            problems.append("Overview is not confirmed non-overlapping.")
        if sorted(item.get("index") for item in report.get("furnaces", [])) != [1, 2, 3, 4, 5]:
            problems.append("Overview does not contain exactly five numbered furnaces.")
        if not (folder / "PitFurnacesOverview.unity").is_file():
            problems.append("Missing overview scene.")
    return {"furnace": number if number else "overview", "path": str(path),
            "valid": not problems, "errors": problems, "preview_size": image_size,
            "preview_status": report.get("previewStatus"), "preview_rendered": report.get("previewRendered")}


def package_check(path: Path) -> dict:
    problems, paths, checksums, meta_checks = [], [], [], []
    with tarfile.open(path, mode="r:gz") as archive:
        members = {member.name: member for member in archive.getmembers()}
        for member in members.values():
            parsed = PurePosixPath(member.name)
            if parsed.is_absolute() or ".." in parsed.parts or member.issym() or member.islnk():
                problems.append("Unsafe archive member: " + member.name)
            if parsed.name != "pathname" or not member.isfile():
                continue
            stream = archive.extractfile(member)
            asset_path = stream.read().decode("utf-8-sig").strip("\x00\r\n")
            paths.append(asset_path)
            posix = PurePosixPath(asset_path)
            if posix.is_absolute() or ".." in posix.parts or "\\" in asset_path:
                problems.append("Unsafe Unity asset path: " + asset_path)
                continue
            allowed = asset_path == IMPORTER or asset_path == UNITY_PATH or asset_path.startswith(UNITY_PATH + "/")
            if not allowed:
                problems.append("Out-of-scope Unity asset: " + asset_path)
                continue
            local = UNITY / asset_path
            local_meta = UNITY / (asset_path + ".meta")
            meta_member = members.get(str(parsed.parent / "asset.meta"))
            if not local_meta.is_file() or not meta_member or not meta_member.isfile():
                problems.append("Missing package/local metadata: " + asset_path)
            else:
                same_meta = hashlib.sha256(archive.extractfile(meta_member).read()).hexdigest() == sha256(local_meta)
                meta_checks.append({"asset": asset_path, "matches_current_meta": same_meta})
                if not same_meta:
                    problems.append("Stale package metadata/GUIDs: " + asset_path)
            asset_member = members.get(str(parsed.parent / "asset"))
            if local.is_file():
                if not asset_member or not asset_member.isfile():
                    problems.append("Missing package payload: " + asset_path)
                else:
                    stored_hash = hashlib.sha256(archive.extractfile(asset_member).read()).hexdigest()
                    same = stored_hash == sha256(local)
                    checksums.append({"asset": asset_path, "matches_current_file": same})
                    if not same:
                        problems.append("Stale package payload: " + asset_path)
            elif not local.is_dir():
                problems.append("Package asset does not exist locally: " + asset_path)
    expected_prefabs = [f"{UNITY_PATH}/PitFurnace{n}/pit_furnace_{n}_v1.prefab" for n in range(1, 6)]
    expected_scenes = [f"{UNITY_PATH}/PitFurnace{n}/PitFurnace{n}Review.unity" for n in range(1, 6)]
    expected_scenes.append(f"{UNITY_PATH}/PitFurnacesOverview.unity")
    required = expected_prefabs + expected_scenes + [IMPORTER, f"{UNITY_PATH}/overview-preview.png"]
    for required_path in required:
        if required_path not in paths:
            problems.append("Missing required package asset: " + required_path)
    if len(paths) != len(set(paths)):
        problems.append("Duplicate Unity pathname entries.")
    if sorted(p for p in paths if p.endswith(".prefab")) != sorted(expected_prefabs):
        problems.append("Package does not contain exactly the five expected prefabs.")
    return {"path": str(path), "valid": not problems, "errors": problems,
            "bytes": path.stat().st_size, "sha256": sha256(path), "asset_count": len(paths),
            "prefabs": expected_prefabs, "scenes": expected_scenes, "payload_checks": checksums,
            "meta_checks": meta_checks, "asset_paths": sorted(paths)}


def baseline_check() -> dict:
    paths = read_json(ROOT / "output/pit-furnace-original-hashes.json")
    checks = [{"path": item["Path"], "expected_sha256": item["Hash"].lower(),
               "actual_sha256": sha256(Path(item["Path"]))} for item in paths]
    valid = len(checks) == 3 and all(c["actual_sha256"] == c["expected_sha256"] for c in checks)
    return {"valid": valid, "errors": [] if valid else ["Original protected asset hash changed."], "files": checks}


def blend_check() -> dict:
    path = ROOT / "output/pit-furnace-blend-recovery-report.json"
    report = read_json(path)
    problems = []
    expected = {"pit_furnace_4_v1.blend": [4],
                "pit_furnaces_1_to_5_editable.blend": list(range(1, 6))}
    for item in report["results"]:
        file = Path(item["path"])
        numbers = expected.get(file.name)
        if numbers is None:
            problems.append("Unexpected repacked blend: " + file.name)
            continue
        names = sorted(f"井式炉{n}_{suffix}" for n in numbers for suffix in ("EDIT", "RUNTIME"))
        if item.get("scenes") != names or item.get("valid") is not True:
            problems.append("Incorrect saved blend scenes: " + file.name)
        if item["sha256"] != sha256(file):
            problems.append("Blend changed after its verified packing: " + file.name)
    if len(report.get("results", [])) != 2:
        problems.append("Missing blend packing results.")
    fifth = report.get("fifth_solid_panels", {})
    if fifth.get("valid") is not True or len(fifth.get("panels", [])) != 2:
        problems.append("Furnace 5 closed, opaque front panels were not verified.")
    cabinet = report.get("fifth_cabinet_body", {})
    expected_components = {"pf5_cabinet_side_wall_L", "pf5_cabinet_side_wall_R", "pf5_cabinet_back_wall",
                           "pf5_cabinet_top", "pf5_cabinet_bottom"}
    if (cabinet.get("valid") is not True or cabinet.get("edit_runtime_dimensions_match") is not True
            or {c.get("name") for c in cabinet.get("components", [])} != expected_components
            or any(c.get("valid") is not True for c in cabinet.get("components", []))
            or len(cabinet.get("scenes", [])) != 2):
        problems.append("Furnace 5 full closed opaque cabinet walls/top/bottom were not verified in EDIT and RUNTIME.")
    glb_path = ASSETS / "PitFurnace5/pit_furnace_5_v1.glb"
    document, _ = read_glb(glb_path)
    glb_size = glb_mesh_bounds(glb_path, document)["size_gltf_xyz"]
    for scene in cabinet.get("scenes", []):
        width, depth, height = scene.get("shell_bounds", {}).get("size_blender_xyz", [0, 0, 0])
        if not scene.get("valid") or not (2.5 <= width <= 3.4 and abs(depth - 1.65) <= .12 and 4.0 <= height <= 4.9):
            problems.append("BLEND cabinet shell does not have the required real cabinet proportions.")
        size = scene.get("equipment_bounds", {}).get("size_blender_xyz", [0, 0, 0])
        if any(abs(a - b) > .03 for a, b in zip(glb_size, [size[0], size[2], size[1]])):
            problems.append("BLEND furnace 5 dimensions differ from the current GLB.")
    shields = report.get("fourth_sloped_shields", [])
    if len(shields) != 2 or any(s.get("faces", 0) < 5 for s in shields):
        problems.append("Furnace 4 still has its old single-face sloped shields.")
    for source in report["sources"]:
        file = Path(source["path"])
        if file.name != "pit_furnace_4_v1.blend" and source["sha256"] != sha256(file):
            problems.append("Standalone blend changed after bundle packing: " + file.name)
    return {"valid": not problems, "errors": problems, "report": str(path),
            "fifth_solid_panels": fifth, "fifth_cabinet_body": cabinet, "fourth_sloped_shields": shields}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=ROOT / "output/pit-furnace-references-v1.unitypackage")
    parser.add_argument("--report", type=Path, default=ROOT / "output/pit-furnace-delivery-verification.json")
    args = parser.parse_args()
    checks = []
    tasks = [(f"GLB {n}", lambda n=n: model_check(n)) for n in range(1, 6)]
    tasks += [(f"Unity {n}", lambda n=n: unity_check(n)) for n in range(1, 6)]
    tasks += [("Unity overview", lambda: unity_check(None)),
              ("Unity package", lambda: package_check(args.package)),
              ("Editable BLEND bundle", blend_check), ("Original baselines", baseline_check)]
    for label, operation in tasks:
        try:
            result = operation()
        except Exception as error:
            result = {"valid": False, "errors": [f"{type(error).__name__}: {error}"]}
        checks.append({"check": label, **result})
    report = {"generated_utc": datetime.now(timezone.utc).isoformat(),
              "verification_scope": "Export geometry, package freshness, Unity import and protected-file integrity only; not CAD component completeness.",
              "cad_component_completeness_verified": False,
              "valid": all(item["valid"] for item in checks), "checks": checks}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"valid": report["valid"], "passed": sum(item["valid"] for item in checks),
                      "total": len(checks), "report": str(args.report.resolve()),
                      "failed": [{"check": item["check"], "errors": item["errors"]}
                                 for item in checks if not item["valid"]]}, ensure_ascii=False))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
