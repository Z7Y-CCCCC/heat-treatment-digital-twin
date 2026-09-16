"""Read-only geometry audit for binary glTF 2.0 equipment models.

Example:
    python tools/audit_equipment_glb_geometry.py model.glb

Uses only the standard library, prints JSON to stdout, and never rewrites the
model or creates a report file. Counts geometry once per mesh primitive, not
once per node instance. POSITION/NORMAL must be float32 VEC3; indices may be
uint8, uint16, or uint32. Accessor offsets, interleaved byte strides, and sparse
overrides are supported. TRIANGLES, TRIANGLE_STRIP, and TRIANGLE_FAN are audited.

Reversed triangles have dot(cross(B-A, C-A), (Na+Nb+Nc)/3) < -1e-7 in mesh-local
coordinates. Degenerate triangles (cross-product length <= 1e-12) are excluded
from that test. A normal length differing from 1 by more than 1e-4 is abnormal.
This checks agreement between winding and exported normals, not whether an
otherwise consistent closed surface points outward. Node transforms and
deformations are deliberately outside this mesh-geometry audit.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct
import sys


NORMAL_LENGTH_TOLERANCE = 1e-4
DEGENERATE_CROSS_LENGTH = 1e-12
REVERSED_DOT_THRESHOLD = -1e-7
ANOMALY_KEYS = (
    "non_finite_positions",
    "non_finite_normals",
    "non_unit_normals",
    "degenerate_triangles",
    "reversed_triangles",
    "invalid_index_triangles",
    "non_finite_triangles",
)


def integer(value: object, label: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def object_array(document: dict, key: str) -> list[dict]:
    value = document.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{key} must be an array of objects")
    return value


def read_glb(path: Path) -> tuple[dict, bytes, int]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("GLB is too short for its header and JSON chunk")
    magic, version, length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2:
        raise ValueError("Expected a binary glTF 2.0 file")
    if length != len(data):
        raise ValueError("GLB declared length differs from the actual file size")
    offset, chunk_index = 12, 0
    document, binary = None, None
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
            if binary is not None:
                raise ValueError("GLB contains more than one BIN chunk")
            binary = data[offset : offset + size]
        offset += size
        chunk_index += 1
    if not isinstance(document, dict):
        raise ValueError("GLB JSON must be an object")
    asset = document.get("asset")
    if not isinstance(asset, dict) or asset.get("version") != "2.0":
        raise ValueError("GLB JSON asset.version must be 2.0")
    return document, binary if binary is not None else b"", len(data)


class AccessorReader:
    """Decode supported accessors with bounds checks against the BIN payload."""

    FORMATS = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}

    def __init__(self, document: dict, binary: bytes):
        self.binary = binary
        self.buffers = object_array(document, "buffers")
        self.views = object_array(document, "bufferViews")
        self.accessors = object_array(document, "accessors")
        self.cache: dict[tuple[int, str], list[tuple]] = {}

    def view_values(
        self,
        view_index: object,
        relative_offset: int,
        count: int,
        component_type: int,
        components: int,
        allow_stride: bool = True,
    ) -> list[tuple]:
        view_index = integer(view_index, "bufferView index")
        if view_index >= len(self.views):
            raise ValueError(f"Invalid bufferView index {view_index}")
        view = self.views[view_index]
        buffer_index = integer(view.get("buffer"), "bufferView.buffer")
        if buffer_index != 0 or not self.buffers:
            raise ValueError("Only the GLB embedded buffer 0 is supported")
        buffer = self.buffers[0]
        if "uri" in buffer:
            raise ValueError("External or URI buffers are not supported")
        declared_length = integer(buffer.get("byteLength"), "buffer.byteLength")
        if declared_length > len(self.binary):
            raise ValueError("Embedded buffer is shorter than buffer.byteLength")
        view_start = integer(view.get("byteOffset", 0), "bufferView.byteOffset")
        view_length = integer(view.get("byteLength"), "bufferView.byteLength")
        if view_start + view_length > declared_length:
            raise ValueError("bufferView extends beyond the declared embedded buffer")
        unpacker = struct.Struct("<" + self.FORMATS[component_type] * components)
        component_size = struct.calcsize("<" + self.FORMATS[component_type])
        if not allow_stride and "byteStride" in view:
            raise ValueError("Sparse bufferViews must not have byteStride")
        stride = integer(view.get("byteStride", unpacker.size), "bufferView.byteStride", 1)
        if stride < unpacker.size or stride % component_size:
            raise ValueError("bufferView.byteStride is too small or misaligned")
        if relative_offset % component_size or (view_start + relative_offset) % component_size:
            raise ValueError("Accessor data is not aligned to its component size")
        required = relative_offset + ((count - 1) * stride + unpacker.size if count else 0)
        if required > view_length:
            raise ValueError("Accessor data extends beyond its bufferView")
        start = view_start + relative_offset
        return [unpacker.unpack_from(self.binary, start + index * stride) for index in range(count)]

    def read(self, accessor_index: object, semantic: str) -> list[tuple]:
        accessor_index = integer(accessor_index, f"{semantic} accessor index")
        if accessor_index >= len(self.accessors):
            raise ValueError(f"Invalid {semantic} accessor index {accessor_index}")
        key = (accessor_index, semantic)
        if key in self.cache:
            return self.cache[key]
        accessor = self.accessors[accessor_index]
        component_type = accessor.get("componentType")
        if semantic == "indices":
            if accessor.get("type") != "SCALAR" or component_type not in (5121, 5123, 5125):
                raise ValueError("Indices must use uint8, uint16, or uint32 SCALAR accessors")
            components = 1
        else:
            if accessor.get("type") != "VEC3" or component_type != 5126:
                raise ValueError(f"{semantic} must use float32 VEC3 accessors")
            components = 3
        if accessor.get("normalized", False) is not False:
            raise ValueError(f"{semantic} must not use normalized accessors")
        count = integer(accessor.get("count"), "accessor.count")
        offset = integer(accessor.get("byteOffset", 0), "accessor.byteOffset")
        if "bufferView" in accessor:
            values = self.view_values(accessor["bufferView"], offset, count, component_type, components)
        else:
            if offset:
                raise ValueError("An accessor without a bufferView cannot have a byteOffset")
            values = [(0,) * components for _ in range(count)]
        if "sparse" in accessor:
            sparse = accessor["sparse"]
            if not isinstance(sparse, dict):
                raise ValueError("accessor.sparse must be an object")
            sparse_count = integer(sparse.get("count"), "sparse.count", 1)
            if sparse_count > count:
                raise ValueError("sparse.count exceeds accessor.count")
            indices, replacements = sparse.get("indices"), sparse.get("values")
            if not isinstance(indices, dict) or not isinstance(replacements, dict):
                raise ValueError("Sparse indices and values must be objects")
            index_type = indices.get("componentType")
            if index_type not in (5121, 5123, 5125):
                raise ValueError("Sparse indices must use uint8, uint16, or uint32")
            sparse_indices = self.view_values(
                indices.get("bufferView"),
                integer(indices.get("byteOffset", 0), "sparse.indices.byteOffset"),
                sparse_count, index_type, 1, allow_stride=False,
            )
            sparse_values = self.view_values(
                replacements.get("bufferView"),
                integer(replacements.get("byteOffset", 0), "sparse.values.byteOffset"),
                sparse_count, component_type, components, allow_stride=False,
            )
            previous = -1
            for (index,), replacement in zip(sparse_indices, sparse_values):
                if index <= previous or index >= count:
                    raise ValueError("Sparse indices must be increasing and within accessor.count")
                values[index] = replacement
                previous = index
        self.cache[key] = values
        return values


def triangles(indices: list[int], mode: int):
    if mode == 4:
        if len(indices) % 3:
            raise ValueError("TRIANGLES index/vertex count must be divisible by three")
        for index in range(0, len(indices), 3):
            yield indices[index], indices[index + 1], indices[index + 2]
    elif mode == 5:
        for index in range(len(indices) - 2):
            a, b, c = indices[index : index + 3]
            yield (b, a, c) if index % 2 else (a, b, c)
    elif mode == 6:
        for index in range(1, len(indices) - 1):
            yield indices[0], indices[index], indices[index + 1]


def empty_counts() -> dict[str, int]:
    return {"triangles": 0, **dict.fromkeys(ANOMALY_KEYS, 0)}


def audit(document: dict, binary: bytes, file_bytes: int) -> dict:
    reader = AccessorReader(document, binary)
    meshes = object_array(document, "meshes")
    totals = empty_counts()
    errors, mesh_issues, reversed_by_mesh = [], [], []
    primitive_count = non_triangle_primitives = 0
    for mesh_index, mesh in enumerate(meshes):
        mesh_name = mesh.get("name", f"<unnamed:{mesh_index}>")
        counts = empty_counts()
        primitive_issues = []
        primitives = mesh.get("primitives")
        if not isinstance(primitives, list) or not primitives:
            errors.append({"mesh_index": mesh_index, "mesh_name": mesh_name, "message": "Missing primitives array"})
            continue
        for primitive_index, primitive in enumerate(primitives):
            primitive_count += 1
            local = empty_counts()
            try:
                if not isinstance(primitive, dict):
                    raise ValueError("Mesh primitive must be an object")
                mode = integer(primitive.get("mode", 4), "primitive.mode")
                if mode > 6:
                    raise ValueError("primitive.mode must be between 0 and 6")
                attributes = primitive.get("attributes")
                if not isinstance(attributes, dict) or "POSITION" not in attributes:
                    raise ValueError("Primitive is missing POSITION")
                positions = reader.read(attributes["POSITION"], "POSITION")
                normals = reader.read(attributes["NORMAL"], "NORMAL") if "NORMAL" in attributes else None
                if normals is not None and len(normals) != len(positions):
                    raise ValueError("POSITION and NORMAL counts must match")
                finite_positions = [all(math.isfinite(value) for value in vector) for vector in positions]
                local["non_finite_positions"] = finite_positions.count(False)
                finite_normals = []
                if normals is not None:
                    finite_normals = [all(math.isfinite(value) for value in vector) for vector in normals]
                    local["non_finite_normals"] = finite_normals.count(False)
                    local["non_unit_normals"] = sum(
                        abs(math.hypot(*normal) - 1.0) > NORMAL_LENGTH_TOLERANCE
                        for normal, finite in zip(normals, finite_normals) if finite
                    )
                indices = (
                    [value[0] for value in reader.read(primitive["indices"], "indices")]
                    if "indices" in primitive else list(range(len(positions)))
                )
                if mode not in (4, 5, 6):
                    non_triangle_primitives += 1
                    if any(index >= len(positions) for index in indices):
                        raise ValueError("Non-triangle primitive has an index outside POSITION")
                else:
                    if normals is None:
                        raise ValueError("Triangle primitive is missing NORMAL; winding cannot be audited")
                    for a, b, c in triangles(indices, mode):
                        local["triangles"] += 1
                        if any(index >= len(positions) for index in (a, b, c)):
                            local["invalid_index_triangles"] += 1
                            continue
                        if not all(finite_positions[index] and finite_normals[index] for index in (a, b, c)):
                            local["non_finite_triangles"] += 1
                            continue
                        pa, pb, pc = positions[a], positions[b], positions[c]
                        u = tuple(pb[axis] - pa[axis] for axis in range(3))
                        v = tuple(pc[axis] - pa[axis] for axis in range(3))
                        cross = (
                            u[1] * v[2] - u[2] * v[1],
                            u[2] * v[0] - u[0] * v[2],
                            u[0] * v[1] - u[1] * v[0],
                        )
                        if math.hypot(*cross) <= DEGENERATE_CROSS_LENGTH:
                            local["degenerate_triangles"] += 1
                            continue
                        average_normal = tuple(
                            (normals[a][axis] + normals[b][axis] + normals[c][axis]) / 3.0
                            for axis in range(3)
                        )
                        dot = sum(cross[axis] * average_normal[axis] for axis in range(3))
                        if dot < REVERSED_DOT_THRESHOLD:
                            local["reversed_triangles"] += 1
            except (ValueError, TypeError, KeyError, struct.error) as exc:
                errors.append({
                    "mesh_index": mesh_index, "mesh_name": mesh_name,
                    "primitive_index": primitive_index, "message": str(exc),
                })
            for key in counts:
                counts[key] += local[key]
            if any(local[key] for key in ANOMALY_KEYS):
                primitive_issues.append({"primitive_index": primitive_index, **local})
        for key in totals:
            totals[key] += counts[key]
        if primitive_issues:
            mesh_issues.append({
                "mesh_index": mesh_index, "mesh_name": mesh_name,
                **counts, "primitive_issues": primitive_issues,
            })
        if counts["reversed_triangles"]:
            reversed_by_mesh.append({
                "mesh_index": mesh_index, "mesh_name": mesh_name,
                "reversed_triangles": counts["reversed_triangles"],
            })
    return {
        "valid": not errors and not any(totals[key] for key in ANOMALY_KEYS),
        "scope": "mesh-local geometry, counted per primitive; node instances/transforms and deformations excluded",
        "stats": {
            "file_bytes": file_bytes, "meshes": len(meshes), "primitives": primitive_count,
            "non_triangle_primitives": non_triangle_primitives, **totals,
        },
        "thresholds": {
            "normal_length_tolerance": NORMAL_LENGTH_TOLERANCE,
            "degenerate_cross_length_lte": DEGENERATE_CROSS_LENGTH,
            "reversed_cross_dot_average_normal_lt": REVERSED_DOT_THRESHOLD,
        },
        "counting_notes": [
            "Vertex anomalies count VEC3 elements, including unused elements, per primitive reference.",
            "Non-finite normals are excluded from the non-unit normal count.",
            "Non-finite/invalid-index triangles are counted but excluded from degeneracy and winding tests.",
            "Only meshes with anomalies are listed in mesh_issues and reversed_triangles_by_mesh.",
        ],
        "reversed_triangles_by_mesh": reversed_by_mesh,
        "mesh_issues": mesh_issues,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path, help="GLB to audit; never modified")
    args = parser.parse_args()
    try:
        document, binary, file_bytes = read_glb(args.glb)
        report = audit(document, binary, file_bytes)
    except (OSError, ValueError, TypeError, KeyError, struct.error) as exc:
        report = {"valid": False, "errors": [{"code": "invalid_input", "message": str(exc)}]}
    report["glb"] = str(args.glb.resolve())
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
