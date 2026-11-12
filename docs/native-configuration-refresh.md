# Native configuration synchronization

Ordinary committed writes may still broadcast `reloadRequired: true`. The native
client now debounces these events, reads the authoritative configuration and
compares the actual scene dependencies before deciding whether a rebuild is needed.

- Names, point definitions, ordinary dashboard settings and published view
  definitions update in place. Unrelated saves preserve the camera, inspection,
  model roots and unsaved layout preview transforms.
- Saved device placement and movement settings update the existing object. Point
  label/metadata changes do not restart movement interpolation.
- Model/action changes prepare replacements only for affected devices, retaining
  the old roots until preparation succeeds. Geometry templates are keyed by the
  source/rig identity, optimization and protected node set, not JSON property order,
  labels, action parameters, inspection camera settings or arbitrary annotations.
- Track-only package changes refresh verified action JSON separately from the
  cached rig. Devices not using that package's tracks keep their static roots.
- Factory/active-scene switches, hierarchy membership, layout/environment changes
  and existing fallback models conservatively use the full scene path. That path
  can still reuse valid geometry templates.
- Debounced requests are cancellation/version/auth-generation guarded. Transient
  read failures retain the current scene and retry up to three times; reconnects
  request an authoritative diff to catch notifications missed while disconnected.

## Isolated regression checks (PowerShell from repository root)

```powershell
dotnet run --project tools/native-runtime-tests/NativeRuntimeTests.csproj
powershell -NoProfile -ExecutionPolicy Bypass -File tools/validate-configuration-refresh.ps1
```

The second command requires Unity 2022.3 (`-UnityPath` can override its path). It
starts an owned loopback fixture serving only literal configurations and allowlisted
repository CAD assets, then runs the real loader and synchronization paths in an
unsaved editor preview scene. It does not enter Play mode, connect to the collector,
write the production database, restart a service or contact a PLC. Its owned child
processes are cleaned up. Results and logs are written beneath ignored `output/`.

Checks cover duplicate notifications, unchanged root IDs/import/clone counters,
retained camera/inspection/preview/movement state, settings removal, publishing,
cancelled stale responses, transient failure recovery, per-device rig enablement
and JSON-only track updates. `DEVICE_ANIMATION_DIAGNOSTICS=1` additionally emits
`[ConfigurationRefresh]` / `[ModelRefresh]` evidence in the native log; the test
enables it only for its isolated process.
