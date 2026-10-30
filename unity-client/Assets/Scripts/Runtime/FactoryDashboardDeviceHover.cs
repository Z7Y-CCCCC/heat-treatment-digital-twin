using System;
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

        // Reuse the already prepared exact mesh surfaces. Bounds alone would
        // select the empty space around a CAD model and between its parts.
        private void UpdateDeviceHoverAt(Vector3 pointer, bool blocked)
        {
            var view = ResolveView(_activeViewId, "factory");
            var enabled = _mode == DashboardMode.Overview && _camera != null
                && (view == null || view.Mode == "factory" || view.Mode == "workshop" || view.Mode == "line")
                && view?.Metadata?["deviceTooltip"]?["enabled"]?.Value<bool>() != false;
            var contextChanged = _deviceHoverView != _activeViewId || _deviceHoverCount != _devices.Count;
            var changed = contextChanged || _deviceHoverEnabled != enabled || !_deviceHoverPointer.Equals(pointer);
            _deviceHoverEnabled = enabled;
            // Include model visibility, moving models and camera changes, not
            // just mouse motion. Disabled tooltips do no geometry/raycast work.
            if (enabled)
                foreach (var device in _devices.Values)
                    if (device.Inspection != null) changed |= InspectionHoverChanged(device.Inspection, pointer, blocked);
            var next = string.Empty;
            if (enabled && !blocked && changed)
            {
                next = PickOverviewDevice(pointer)?.Device?.Id ?? string.Empty;
            }
            else if (enabled && !blocked && !changed) return;
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
            var pointer = Input.mousePosition;
            var blocked = (!_webOverlayActive && IsPointerOverDashboard(ScreenToDesign(pointer)))
                || (!_webOverlayActive && !Application.isFocused)
                || pointer.x < 0 || pointer.y < 0 || pointer.x > Screen.width || pointer.y > Screen.height;
            UpdateDeviceHoverAt(pointer, blocked);
        }
    }
}
