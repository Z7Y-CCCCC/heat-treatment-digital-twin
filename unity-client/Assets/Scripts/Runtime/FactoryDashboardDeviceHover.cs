using System;
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
        private NativePointerWindowGuard _hoverPointerWindowGuard = new NativePointerWindowGuard();

        private bool TryGetHoverPointer(out Vector3 pointer)
        {
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
                foreach (var device in _devices.Values)
                    if (device.Inspection != null) changed |= InspectionHoverChanged(device.Inspection, pointer, false);
                _deviceHoverNeedsRebuild = false;
            }
            else _deviceHoverNeedsRebuild = true;
            var next = string.Empty;
            if (pickable && changed)
            {
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
