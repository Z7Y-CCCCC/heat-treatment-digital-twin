using System;
using System.Collections.Generic;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed partial class FactoryDashboardController
    {
        public event Action<JObject> DeviceHoverUpdated;
        private string _hoveredDeviceId = string.Empty;
        private string _deviceHoverView = string.Empty;
        private Vector3 _deviceHoverPointer;
        private int _deviceHoverCount = -1;
        private bool _deviceHoverEnabled;
        private bool _deviceHoverNeedsRebuild = true;
#if UNITY_EDITOR
        public int OverviewPickEvaluations { get; private set; }
#endif
        private NativePointerWindowGuard _hoverPointerWindowGuard = new NativePointerWindowGuard();
        private readonly HoverTransformBatch _overviewMatrices = new HoverTransformBatch();
        private readonly List<DeviceInspectionRuntime> _overviewMatrixOwners = new List<DeviceInspectionRuntime>(16);
        private readonly List<DeviceInspectionRuntime> _currentMatrixOwners = new List<DeviceInspectionRuntime>(16);
        private readonly List<Transform> _overviewTransforms = new List<Transform>(256);
        private bool _overviewMatricesActive;
        private int _overviewScanPhase;
        private Matrix4x4 _overviewCameraView, _overviewCameraProjection;
        private Rect _overviewCameraRect;

        private void CaptureOverviewMatrices()
        {
            using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.OverviewMatrixBatch);
            _currentMatrixOwners.Clear(); var count = 0;
            foreach (var device in _devices.Values) if (device.Inspection != null) {
                _currentMatrixOwners.Add(device.Inspection); count += device.Inspection.Renderers.Count;
            }
            var changed = count != _overviewMatrices.Count || _currentMatrixOwners.Count != _overviewMatrixOwners.Count;
            if (!changed) for (var i = 0; i < _currentMatrixOwners.Count; i++)
                if (!ReferenceEquals(_currentMatrixOwners[i], _overviewMatrixOwners[i])) { changed = true; break; }
            if (count < 128) { _overviewMatrices.Dispose(); _overviewMatrixOwners.Clear(); _overviewTransforms.Clear(); _overviewMatricesActive = false; return; }
            if (changed) {
                _overviewTransforms.Clear(); _overviewMatrixOwners.Clear();
                foreach (var owner in _currentMatrixOwners) {
                    _overviewMatrixOwners.Add(owner);
                    foreach (var state in owner.Renderers) {
                        state.HoverMatrixBatchIndex = _overviewTransforms.Count;
                        _overviewTransforms.Add(state.Renderer != null ? state.Renderer.transform : null);
                    }
                }
                _overviewMatrices.SetTransforms(_overviewTransforms.ToArray());
            }
            _overviewMatrices.Capture(); _overviewMatricesActive = true;
        }

        private void ClearOverviewMatrices()
        {
            _overviewMatrices.Dispose(); _overviewMatrixOwners.Clear(); _currentMatrixOwners.Clear();
            _overviewTransforms.Clear(); _overviewMatricesActive = false;
        }

        private bool TryGetHoverPointer(out Vector3 pointer)
        {
            using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.PointerWindow);
            var legacy = Input.mousePosition;
            var owned = _hoverPointerWindowGuard.TryResolvePointer(_webOverlayActive, Application.isFocused,
                Time.frameCount, Screen.width, Screen.height, legacy.x, legacy.y, out var x, out var y);
            pointer = new Vector3(x, y, legacy.z);
            return owned;
        }

        // Reuse the already prepared exact mesh surfaces. Bounds alone would
        // select the empty space around a CAD model and between its parts.
        private void UpdateDeviceHoverAt(Vector3 pointer, bool blocked)
        {
            var view = ResolveView(_activeViewId, "factory");
            var templateReference = view?.Metadata?["tooltipTemplates"]?["device"]?.Value<string>();
            var tooltipEnabled = !string.IsNullOrEmpty(templateReference)
                ? templateReference != "disabled"
                : view?.Metadata?["deviceTooltip"]?["enabled"]?.Value<bool>() != false;
            var enabled = _mode == DashboardMode.Overview && _camera != null
                && (view == null || view.Mode == "factory" || view.Mode == "workshop" || view.Mode == "line")
                && tooltipEnabled;
            var contextChanged = _deviceHoverView != _activeViewId || _deviceHoverCount != _devices.Count;
            var changed = contextChanged || _deviceHoverNeedsRebuild || _deviceHoverEnabled != enabled || !_deviceHoverPointer.Equals(pointer);
            _deviceHoverEnabled = enabled;
            var pickable = enabled && !blocked && float.IsFinite(pointer.x) && float.IsFinite(pointer.y)
                && _camera.pixelRect.Contains(new Vector2(pointer.x, pointer.y));
            // Include model visibility, moving models and camera changes, not
            // just mouse motion. A blocked/outside pointer must not scan the
            // entire CAD hierarchy. Rebuild on re-entry even if it moved away
            // and back while no snapshots were observed.
            if (pickable)
            {
                CaptureOverviewMatrices();
                using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.OverviewSnapshot);
                var fullScan = changed || !_overviewCameraView.Equals(_camera.worldToCameraMatrix)
                    || !_overviewCameraProjection.Equals(_camera.projectionMatrix) || !_overviewCameraRect.Equals(_camera.pixelRect);
                _overviewCameraView = _camera.worldToCameraMatrix; _overviewCameraProjection = _camera.projectionMatrix;
                _overviewCameraRect = _camera.pixelRect;
                var index = 0; var phase = _overviewScanPhase;
                _overviewScanPhase = (_overviewScanPhase + 1) % 3;
                foreach (var device in _devices.Values)
                {
                    var runtime = device.Inspection; if (runtime == null) continue;
                    var matrix = device.Root != null ? device.Root.transform.localToWorldMatrix : Matrix4x4.identity;
                    var active = device.Root != null && device.Root.activeInHierarchy;
                    var rootChanged = !runtime.OverviewRootValid || !runtime.OverviewRootMatrix.Equals(matrix) || runtime.OverviewRootActive != active;
                    runtime.OverviewRootValid = true; runtime.OverviewRootMatrix = matrix; runtime.OverviewRootActive = active;
                    // Pointer/camera/root motion, re-entry and the hovered device
                    // stay immediate. For a stationary pointer, unrelated internal
                    // animation detection is spread over at most three frames.
                    // This budgets hover observation ONLY, never model/PLC updates.
                    // Selection still raycasts exact current triangles, never a
                    // mixed/stale snapshot or bounds-only fabricated hit.
                    if (fullScan || rootChanged || device.Device.Id == _hoveredDeviceId || index % 3 == phase)
                        changed |= OverviewHoverChanged(runtime, pointer);
                    index++;
                }
                _deviceHoverNeedsRebuild = false;
            }
            else _deviceHoverNeedsRebuild = true;
            var next = string.Empty;
            if (pickable && changed)
            {
                using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.OverviewPick);
                next = PickOverviewDevice(pointer)?.Device?.Id ?? string.Empty;
            }
            else if (pickable && !changed) return;
            var publish = contextChanged || next != _hoveredDeviceId
                || (next.Length > 0 && !_deviceHoverPointer.Equals(pointer));
            _hoveredDeviceId = next;
            _deviceHoverView = _activeViewId;
            _deviceHoverCount = _devices.Count;
            _deviceHoverPointer = pointer;
            if (!publish) return;
            DeviceHoverUpdated?.Invoke(new JObject {
                ["viewId"] = _activeViewId ?? string.Empty,
                ["hoveredDeviceId"] = next,
                ["deviceHoverPointer"] = new JObject {
                    ["x"] = pointer.x / Mathf.Max(1, Screen.width),
                    ["y"] = 1f - pointer.y / Mathf.Max(1, Screen.height),
                    ["visible"] = next.Length > 0
                }
            });
        }

        private DeviceView PickOverviewDevice(Vector3 pointer)
        {
#if UNITY_EDITOR
            OverviewPickEvaluations++;
#endif
            if (_camera == null) return null;
            var ray = _camera.ScreenPointToRay(pointer);
            var closest = _camera.farClipPlane;
            DeviceView selected = null;
            foreach (var device in _devices.Values)
            {
                if (device.Root == null || !device.Root.activeInHierarchy || device.Inspection == null) continue;
                foreach (var state in device.Inspection.Renderers)
                {
                    if (state.Renderer == null || (_camera.cullingMask & (1 << state.Renderer.gameObject.layer)) == 0) continue;
                    if (state.Surface != null && state.Surface.Raycast(ray, out var distance, null, closest) && distance < closest)
                    {
                        closest = distance;
                        selected = device;
                    }
                }
            }
            return selected;
        }

        private void UpdateDeviceHover()
        {
            var pointerOwned = TryGetHoverPointer(out var pointer);
            var blocked = !pointerOwned
                || (!_webOverlayActive && IsPointerOverDashboard(ScreenToDesign(pointer)))
                || pointer.x < 0 || pointer.y < 0 || pointer.x > Screen.width || pointer.y > Screen.height;
            UpdateDeviceHoverAt(pointer, blocked);
        }

        // A transient, screen-space-width edge on the actual equipment meshes.
        // Reuses the inspection shader/surfaces; no material replacement, box,
        // extra camera or per-frame geometry allocation (one reused silhouette mask).
        private int DrawDeviceHover()
        {
            using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.OverviewOutline);
            InspectionOutlineRenderer.Begin(_camera);
            if (_mode != DashboardMode.Overview || !_deviceHoverEnabled || _camera == null
                || string.IsNullOrEmpty(_hoveredDeviceId)
                || !_devices.TryGetValue(_hoveredDeviceId, out var device)
                || device.Root == null || !device.Root.activeInHierarchy || device.Inspection == null) return 0;
            var material = EnsureHoverOutlineMaterial();
            if (material == null) return 0;
            var drawn = 0;
            foreach (var state in device.Inspection.Renderers)
            {
                if (state.Surface == null || !state.Surface.IsVisible
                    || (_camera.cullingMask & (1 << state.Renderer.gameObject.layer)) == 0) continue;
                state.Surface.DrawOutline(material, _camera, new Color(.48f, .84f, 1f, .95f), 2f);
                drawn++;
            }
            return drawn;
        }
    }
}
