# Configurable equipment inspection contract (v2)

This is a renderer-independent extension of `model.metadata.inspection`. Existing single-node parts remain supported. No equipment-specific branches belong in a renderer; authored model presets only provide editable defaults.

## Canonical configuration

```json
{
  "version": 2,
  "enabled": true,
  "offset_space": "model",
  "animation_duration": 1.5,
  "shell_duration": 1,
  "stagger": 0.06,
  "playback_speed": 1,
  "easing": "smoothstep",
  "labels": { "enabled": true, "leader_lines": true },
  "shell": {
    "node_paths": [], "node_names": [], "opacity": 0.18,
    "wireframe": false, "transition": "clip", "axis": "y", "direction": 1
  },
  "solid": { "view_id": "", "transition_seconds": 0.65, "camera": { "yaw": 238, "pitch": 19, "distance_scale": 1.12, "target_offset": [0,0,0] } },
  "xray": { "view_id": "", "transition_seconds": 0.65, "camera": { "yaw": 238, "pitch": 19, "distance_scale": 1.08, "target_offset": [0,0,0] } },
  "exploded": { "view_id": "", "transition_seconds": 1.5, "camera": { "yaw": 238, "pitch": 22, "distance_scale": 1.22, "target_offset": [0,0,0] } },
  "parts": [{
    "id": "part_1", "name": "Assembly", "group": "",
    "enabled": true,
    "node_path": "", "node_name": "",
    "node_paths": [], "node_names": [],
    "explode_offset": [0,0,0], "explode_rotation": [0,0,0],
    "delay": 0, "duration": 0,
    "label_offset": [0,0.35,0], "description": "",
    "point_ids": [], "point_keys": [], "detail_view_id": "",
    "camera": null
  }]
}
```

- `offset_space`: `model` (model-root local axes) or `parent` (legacy target-parent local axes). Legacy documents default to `parent`; new editor/presets explicitly use `model`.
- Model coordinates are the original right-handed glTF/Three scene coordinates. Unity converts X for glTFast's left-handed import, including vectors, shell clipping, labels and cameras. Authored rotations are XYZ Euler degrees; the Unity equivalent is `Qx(x) * Qy(-y) * Qz(-z)`. Multi-target pivots are computed in model space, independent of instance placement. Nonuniform parent transforms with authored rotation must report an actionable issue instead of silently approximating shear.
- `animation_duration` is each part's fallback duration, 0.05–10 seconds. `duration=0` inherits it. Start time is shell_duration + index * stagger + delay, with index in configured enabled-part order. Maximum delay 10s, stagger 0–1s. `playback_speed` is the shared playback multiplier for explosion and reverse assembly, 0.25×–3×; it does not change authored part timing or offsets.
- `shell_duration` 0–5s. `shell.transition`: `clip`, `fade`, `hide`; clip axis x/y/z and direction 1/-1. Explosion clears shell first, then expands parts; assembly reverses this entire timeline. Solid↔exploded must be reversible without an instantaneous reset. Xray uses shell opacity and assembled transforms.
- `easing`: `smoothstep`, `cubic`, `linear`. `explode_rotation` is degrees, applied by a dedicated offset wrapper so PLC transforms remain on the original node.
- A part combines its legacy single target and its target arrays, deduplicating nodes. Within a part, descendant targets of another selected target are redundant. Across different parts, duplicate/ancestor targets are invalid and must be reported to the engineer rather than translated twice. Shell nodes containing retained parts must not accidentally hide those parts.
- `camera=null` uses automatic part framing; a supplied camera overrides framing orientation/scale/offset. `detail_view_id` retains the authored dashboard view bridge.
- `label_offset` belongs to model-local axes when offset_space=model. Labels are projected world anchors, not a static HTML list pretending to be spatial labels.
- At most 64 parts and 100 shell targets. Names/paths are opaque case-sensitive GLB node identifiers; preserve stable part IDs and point associations when editing.
- Canonical shell targets always retain the complete `node_paths` and `node_names` arrays, including their first element. Duplicate node names require full paths. The browser imports `inspectionConfig.mjs`; the CommonJS entry delegates to the same implementation.
- Shared JavaScript normalization/validation API: `shared/inspectionConfig.cjs` exports `createInspectionDefaults()`, `normalizeInspection(input, partBindings=[])`, `validateInspection(config, nodes=[])`. Validation results are `{valid, errors:[{code,partId,message}], warnings:[{code,partId,message}]}`. Node records can contain `path`, `name`, `parentPath`, `isMesh`.

## Read-only runtime commands

`POST /api/native-preview/navigate`:

```json
{
  "action":"inspection",
  "focus":{"mode":"device","deviceId":"device_1"},
  "inspection":{"command":"stage","stage":"exploded","partId":"","progress":0,"enabled":true}
}
```

Commands: `stage` (`solid|xray|exploded`), `select`, `clear`, `progress` (0 assembled → 1 fully exploded), `isolate` (enabled), `labels` (enabled), `pause`, `resume`. These change view state only, never configuration. Unknown commands/stages fail validation. Existing `inspection_back` still works.

Protected engineer preview: `POST /api/native-preview` with `action:"inspection_preview"`, `focus.deviceId`, and `inspectionConfig` applies an unsaved configuration to that device in memory, without DB writes. Saving model metadata uses the existing authenticated model PUT API. Explicit reload/reset discards unsaved preview configuration.

## Runtime context extension

The existing `dashboard_context` payload additionally carries:

```json
{
  "inspectionEnabled":true,
  "inspectionStage":"exploded",
  "inspectionProgress":1,
  "inspectionAnimating":false,
  "inspectionPhase":"idle",
  "inspectionIsolated":false,
  "inspectionLabelsEnabled":true,
  "inspectionLeaderLines":true,
  "inspectionHoveredPartId":"",
  "inspectionIssues":[],
  "inspectionParts":[{
    "id":"part_1", "name":"Assembly", "group":"", "description":"",
    "pointIds":[], "pointKeys":[], "selected":false,
    "anchor":{"x":0.5,"y":0.5,"visible":true},
    "label":{"x":0.5,"y":0.4,"visible":true}
  }]
}
```

Coordinates are normalized to the full Unity viewport, top-left origin, independent of DPI. Throttle context/projection updates to about 10 Hz in detail mode. Clear all inspection fields when leaving the device view. Existing selected `partId/partName/partDescription/partPointIds/partPointKeys` fields remain intact for low-code widgets.

Web overlay controls and label hit boxes must use `data-overlay-hit`; leader lines/background must remain click-through. Native GUI is not the only presentation because the installed product activates the WebView overlay.

## Acceptance baseline

Engineer chooses shell and part nodes, edits names/groups/offsets/timing/cameras/labels/PLC links, previews, saves, reloads and obtains the same authored behavior. Reference-parity baseline: staged shell reveal, deliberately composed explosion, synchronized framing, world labels, hover/selection feedback, linked part parameters, and reverse assembly. Never present a material-merged leaf as a real CAD component or fabricate unseen internals.
