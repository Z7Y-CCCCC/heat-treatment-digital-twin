# Heat Treatment Digital Twin - Unity Client

This is the native Windows renderer that replaces the browser/WebGL dashboard.
The existing backend remains responsible for PLC acquisition, MySQL/SQLite,
backup/recovery, logging, voice events and configuration APIs.

## Engine

- Unity/Tuanjie 2022.3 LTS compatible project
- Universal Render Pipeline (URP)
- glTFast runtime GLB/GLTF loading
- Windows x64 standalone target

## First open

1. Sign in to Unity Hub and activate a valid Personal/Pro license.
2. Install/open with Unity `2022.3.34f1c1`, matching `ProjectSettings/ProjectVersion.txt`.
3. Wait for packages to restore.
4. Unity automatically runs `Digital Twin/Bootstrap Project` on first import and creates `Assets/Scenes/Factory.unity` plus the URP assets.
5. Start the existing backend on `http://127.0.0.1:3001`, then press Play.

Runtime connection settings are stored in `Assets/StreamingAssets/runtime-config.json`.

The quality profiles never decimate the imported mesh. `F1`, `F2`, and `F3` only tune render scale, shadows, anti-aliasing and post processing; `F4` performs hardware auto-detection.
The account menu also offers a draggable three-position quality capsule: F1 / 流畅, F2 / 均衡, F3 / 高画质. These are temporary, local changes, not saved backend settings. The capsule and short-lived notification update only after Unity acknowledges the applied profile through the local named-pipe bridge; WebView keyboard focus does not disable the shortcuts.

Workshop, line, device and part cameras use continuous horizontal orbit. A scene drag takes over from the current rendered pose and cancels preset interpolation; release settles at that angle without recentering. Navigation to another view still uses the shortest authored route. Pointer movement is tracked over the whole gesture, so an out-and-back drag cannot become a device click. Run `node tools/native-orbit-camera-checks.cjs` from the repository root for the actual Unity controller regression; the headless direction/gesture cases also run in `tools/native-runtime-tests`.

## Build

Use `Digital Twin/Build Windows Client`. The first development build uses the built-in Windows Mono backend, so no WebGL, UWP, Dedicated Server or IL2CPP module is required. Output is written to `Builds/Windows`.

## Architecture

- `FactoryRuntime`: loads configuration and creates the factory/device hierarchy.
- `BackendApiClient`: reads `/api/config`.
- `RealtimeWebSocketClient`: reads `/ws` realtime frames.
- `RuntimeModelLibrary`: imports and caches GLB/GLTF assets.
- `RuntimeModelOptimizer`: combines static meshes by material while preserving bound/animated nodes.
- `ModelBindingDriver`: maps PLC fields to translation, rotation, visibility and color.
- `NativeQualityController`: integrated-GPU, balanced and showcase profiles.

The current V5 furnace is only a validation asset. The optimization pipeline is model-independent.
