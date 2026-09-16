"""Read-only GLB delivery checks; uses only the Python standard library.

Example:
    python tools/validate_equipment_glb.py model.glb --metadata model_metadata.json

The default root is <metadata.model_id or GLB filename stem>_root. Triangle
budgets use the larger of all mesh geometry and all node mesh instances, so
unused geometry and repeated mesh instances cannot hide excess geometry.
This is a delivery check, not a complete glTF specification validator.
"""

from __future__ import annotations

import argparse
from collections import Counter, deque
import json
from pathlib import Path
import re
import struct
import sys


MAX_TRIANGLES = 200_000
MAX_NODES = 800
DEFAULT_OBJECT_NAME = re.compile(
    r"^(?:Cube|Camera|Light|Lamp|Plane|Sphere|Icosphere|Cylinder|Cone|Torus|"
    r"Suzanne|Monkey|Circle|Grid|Text|Empty)(?:\.\d+)?$", re.IGNORECASE
)


def read_glb(path: Path) -> tuple[dict, int]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("GLB is too short for its header and JSON chunk")
    magic, version, length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2:
        raise ValueError("Expected a binary glTF 2.0 file")
    if length != len(data):
        raise ValueError(f"GLB declared length {length} differs from {len(data)} bytes")
    offset, document, chunk_index, bin_chunks = 12, None, 0, 0
    while offset < length:
        if offset + 8 > length:
            raise ValueError("Truncated GLB chunk header")
        size, kind = struct.unpack_from("<I4s", data, offset)
        offset += 8
        if size % 4 or offset + size > length:
            raise ValueError("Unaligned or truncated GLB chunk")
        if chunk_index == 0 and kind != b"JSON":
            raise ValueError("The first GLB chunk must be JSON")
        if kind == b"JSON":
            if document is not None:
                raise ValueError("GLB contains more than one JSON chunk")
            document = json.loads(data[offset : offset + size].decode("utf-8"))
        elif kind == b"BIN\x00":
            bin_chunks += 1
            if bin_chunks > 1:
                raise ValueError("GLB contains more than one BIN chunk")
        offset += size
        chunk_index += 1
    if not isinstance(document, dict):
        raise ValueError("GLB JSON must be an object")
    asset = document.get("asset")
    if not isinstance(asset, dict) or asset.get("version") != "2.0":
        raise ValueError("GLB JSON asset.version must be 2.0")
    return document, len(data)


def objects(document: dict, key: str) -> list[dict]:
    value = document.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{key} must be an array of objects")
    return value


def is_index(value: object, length: int) -> bool:
    return type(value) is int and 0 <= value < length


def validate(document: dict, file_bytes: int, root_name: str, metadata: dict | None) -> dict:
    nodes = objects(document, "nodes")
    meshes = objects(document, "meshes")
    materials = objects(document, "materials")
    accessors = objects(document, "accessors")
    scenes = objects(document, "scenes")
    errors: list[dict] = []

    def error(code: str, message: str, **details: object) -> None:
        errors.append({"code": code, "message": message, **details})

    def accessor_count(index: object, label: str) -> int:
        if not is_index(index, len(accessors)):
            error("invalid_accessor", f"{label} references an invalid accessor", index=index)
            return 0
        count = accessors[index].get("count")
        if type(count) is not int or count < 0:
            error("invalid_accessor_count", f"{label} has an invalid accessor count")
            return 0
        return count

    mesh_triangles: list[int] = []
    primitive_modes: Counter = Counter()
    for mesh_index, mesh in enumerate(meshes):
        triangles = 0
        primitives = mesh.get("primitives")
        if not isinstance(primitives, list) or not primitives:
            error("invalid_primitives", f"Mesh {mesh_index} has no valid primitives array")
            mesh_triangles.append(0)
            continue
        for primitive_index, primitive in enumerate(primitives):
            label = f"Mesh {mesh_index}, primitive {primitive_index}"
            if not isinstance(primitive, dict):
                error("invalid_primitive", f"{label} is not an object")
                continue
            mode = primitive.get("mode", 4)
            if type(mode) is not int or mode not in range(7):
                error("invalid_primitive_mode", f"{label} has an invalid mode")
                continue
            primitive_modes[str(mode)] += 1
            attributes = primitive.get("attributes", {})
            if not isinstance(attributes, dict) or "POSITION" not in attributes:
                error("missing_positions", f"{label} has no POSITION accessor")
                continue
            vertices = accessor_count(attributes["POSITION"], label + " POSITION")
            count = accessor_count(primitive["indices"], label + " indices") if "indices" in primitive else vertices
            if "material" in primitive and not is_index(primitive["material"], len(materials)):
                error("invalid_material", f"{label} references an invalid material")
            if mode == 4:
                if count % 3:
                    error("invalid_triangle_count", f"{label} TRIANGLES count is not divisible by 3", count=count)
                triangles += count // 3
            elif mode in (5, 6):
                triangles += max(0, count - 2)
        mesh_triangles.append(triangles)

    names = [node.get("name", "") for node in nodes]
    if any(not isinstance(name, str) for name in names):
        raise ValueError("Node names must be strings when present")
    name_counts = Counter(names)
    parents: list[list[int]] = [[] for _ in nodes]
    children: list[list[int]] = [[] for _ in nodes]
    instance_triangles = 0
    default_nodes = []
    for index, node in enumerate(nodes):
        label = names[index] or f"<unnamed:{index}>"
        extensions = node.get("extensions", {})
        if not isinstance(extensions, dict):
            raise ValueError(f"Node {index} extensions must be an object")
        if DEFAULT_OBJECT_NAME.fullmatch(names[index]) or "camera" in node or "KHR_lights_punctual" in extensions:
            default_nodes.append({"index": index, "name": label})
        if "mesh" in node:
            if not is_index(node["mesh"], len(meshes)):
                error("invalid_mesh", f"Node {label} references an invalid mesh")
            else:
                instances = 1
                gpu_instancing = extensions.get("EXT_mesh_gpu_instancing")
                if gpu_instancing is not None:
                    attributes = gpu_instancing.get("attributes") if isinstance(gpu_instancing, dict) else None
                    if not isinstance(attributes, dict) or not attributes:
                        error("invalid_instancing", f"Node {label} has invalid GPU instancing attributes")
                    else:
                        counts = {accessor_count(value, f"Node {label} instance {key}") for key, value in attributes.items()}
                        if len(counts) != 1:
                            error("invalid_instancing", f"Node {label} has inconsistent GPU instance counts")
                        instances = max(counts, default=0)
                instance_triangles += mesh_triangles[node["mesh"]] * instances
        child_indices = node.get("children", [])
        if not isinstance(child_indices, list):
            error("invalid_children", f"Node {label} children must be an array")
            continue
        for child in child_indices:
            if not is_index(child, len(nodes)):
                error("invalid_child", f"Node {label} references an invalid child", child=child)
            elif child in children[index]:
                error("duplicate_child", f"Node {label} references the same child twice", child=child)
            else:
                children[index].append(child)
                parents[child].append(index)
    if default_nodes:
        error("default_or_render_nodes", "Default primitives, cameras or lights must not be exported", nodes=default_nodes)
    for index, node_parents in enumerate(parents):
        if len(node_parents) > 1:
            error("multiple_parents", f"Node {names[index]} has multiple parents", index=index, parents=node_parents)

    indegrees = [len(items) for items in parents]
    queue = deque(index for index, count in enumerate(indegrees) if count == 0)
    acyclic_count = 0
    while queue:
        index = queue.popleft()
        acyclic_count += 1
        for child in children[index]:
            indegrees[child] -= 1
            if indegrees[child] == 0:
                queue.append(child)
    if acyclic_count != len(nodes):
        error("node_cycle", "The node hierarchy contains a cycle")

    root_matches = [index for index, name in enumerate(names) if name == root_name]
    if len(root_matches) != 1:
        error("root_not_unique", "Expected exactly one named equipment root", root=root_name, matches=root_matches)
    else:
        root = root_matches[0]
        if parents[root]:
            error("root_has_parent", "The equipment root must not have a parent", parents=parents[root])
        reachable: set[int] = set()
        pending = [root]
        while pending:
            index = pending.pop()
            if index not in reachable:
                reachable.add(index)
                pending.extend(children[index])
        outside = [{"index": index, "name": names[index]} for index in range(len(nodes)) if index not in reachable]
        if outside:
            error("nodes_outside_root", "Every exported node must belong to the equipment root", nodes=outside)
        for index, scene in enumerate(scenes):
            if scene.get("nodes", []) != [root]:
                error("invalid_scene_roots", f"Scene {index} must contain only the equipment root", roots=scene.get("nodes", []))
    if not scenes:
        error("missing_scene", "The equipment GLB must contain a scene")
    for index, scene in enumerate(scenes):
        roots = scene.get("nodes", [])
        if not isinstance(roots, list) or any(not is_index(root, len(nodes)) for root in roots):
            error("invalid_scene_nodes", f"Scene {index} has invalid root node references")
    if "scene" in document and not is_index(document["scene"], len(scenes)):
        error("invalid_default_scene", "The default scene index is invalid")

    binding_targets = []
    if metadata is not None:
        bindings = objects(metadata, "partBindings")
        seen_targets: set[str] = set()
        for index, binding in enumerate(bindings):
            name = binding.get("node_name")
            if not isinstance(name, str) or not name.strip():
                error("missing_binding_target", f"partBindings[{index}] requires a nonempty node_name")
                continue
            binding_targets.append(name)
            if name in seen_targets:
                error("duplicate_binding_target", "partBindings node_name must be unique", node_name=name)
            seen_targets.add(name)
            if name_counts[name] != 1:
                error("binding_target_not_unique", "A binding must resolve to exactly one GLB node", node_name=name, matches=name_counts[name])

    geometry_triangles = sum(mesh_triangles)
    budget_triangles = max(geometry_triangles, instance_triangles)
    if budget_triangles > MAX_TRIANGLES:
        error("triangle_budget_exceeded", f"Triangles exceed {MAX_TRIANGLES}", actual=budget_triangles)
    if len(nodes) > MAX_NODES:
        error("node_budget_exceeded", f"Nodes exceed {MAX_NODES}", actual=len(nodes))
    return {
        "valid": not errors,
        "expected_root": root_name,
        "stats": {
            "file_bytes": file_bytes,
            "nodes": len(nodes),
            "meshes": len(meshes),
            "materials": len(materials),
            "triangles": budget_triangles,
            "unique_mesh_triangles": geometry_triangles,
            "mesh_instance_triangles": instance_triangles,
            "primitive_counts_by_mode": dict(sorted(primitive_modes.items())),
            "scenes": len(scenes),
        },
        "limits": {"max_triangles": MAX_TRIANGLES, "max_nodes": MAX_NODES},
        "metadata_checked": metadata is not None,
        "binding_targets": binding_targets,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path, help="GLB to inspect; never modified")
    parser.add_argument("--metadata", type=Path, help="Optional partBindings metadata JSON")
    parser.add_argument("--root", help="Expected root node name; overrides model_id/filename inference")
    args = parser.parse_args()
    try:
        metadata = None
        if args.metadata:
            metadata = json.loads(args.metadata.read_text(encoding="utf-8-sig"))
            if not isinstance(metadata, dict):
                raise ValueError("Metadata JSON must be an object")
        model_id = metadata.get("model_id", args.glb.stem) if metadata is not None else args.glb.stem
        if not isinstance(model_id, str) or not model_id:
            raise ValueError("model_id must be a nonempty string")
        root_name = args.root if args.root is not None else model_id + "_root"
        if not root_name.strip():
            raise ValueError("Expected root name must not be empty")
        document, file_bytes = read_glb(args.glb)
        report = validate(document, file_bytes, root_name, metadata)
    except (OSError, ValueError, TypeError, struct.error) as exc:
        report = {"valid": False, "errors": [{"code": "invalid_input", "message": str(exc)}]}
    report["glb"] = str(args.glb.resolve())
    report["metadata"] = str(args.metadata.resolve()) if args.metadata else None
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
