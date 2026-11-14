using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Runtime
{
    /// <summary>
    /// Configurable multi-level presentation shell:
    /// factory -> workshop -> line -> device (plus custom authored views).
    /// Authored PBR materials are retained; only the hovered device gets a transient edge.
    /// </summary>
    [DefaultExecutionOrder(200)]
    public sealed partial class FactoryDashboardController : MonoBehaviour
    {
        private enum DashboardMode
        {
            Overview,
            Detail
        }

        private enum InspectionStage
        {
            Solid,
            Xray,
            Exploded,
            PartDetail
        }

        public sealed class ConfiguredView
        {
            public string Id;
            public string Name;
            public string Mode;
            public string TargetType;
            public string TargetId;
            public string ParentViewId;
            public string ReturnViewId;
            public float Yaw = -39f;
            public float Pitch = 33f;
            public float DistanceScale = 1.08f;
            public float TransitionSeconds = 0.8f;
            public bool RelativeToTarget;
            public Vector3 TargetOffset = Vector3.zero;
            public readonly HashSet<string> ShowComponents = new HashSet<string>();
            public readonly HashSet<string> HideComponents = new HashSet<string>();
            public bool HideNonTargetDevices;
            public JObject Metadata = new JObject();
        }

        private sealed class DeviceView
        {
            public DeviceDto Device;
            public GameObject Root;
            public Bounds WorldBounds;
            public string LineName;
            public JObject Frame;
            public float LastHistoryAt;
            public readonly Dictionary<string, List<float>> History = new Dictionary<string, List<float>>();
            public DeviceInspectionRuntime Inspection;
        }

        private sealed class DashboardPanelConfig
        {
            [JsonProperty("visible")] public bool Visible { get; set; } = true;
            [JsonProperty("width")] public float Width { get; set; } = 326f;
            [JsonProperty("height")] public float Height { get; set; } = 824f;
            [JsonProperty("opacity")] public float Opacity { get; set; } = 1f;
            [JsonProperty("maxDevices")] public int MaxDevices { get; set; } = 20;
            [JsonProperty("maxPoints")] public int MaxPoints { get; set; } = 6;
            [JsonProperty("maxCharts")] public int MaxCharts { get; set; } = 3;
        }

        private sealed class DashboardOverviewConfig
        {
            [JsonProperty("left")] public DashboardPanelConfig Left { get; set; } = new DashboardPanelConfig();
            [JsonProperty("right")] public DashboardPanelConfig Right { get; set; } = new DashboardPanelConfig
            {
                MaxDevices = 20
            };
        }

        private sealed class DashboardDetailConfig
        {
            [JsonProperty("left")] public DashboardPanelConfig Left { get; set; } = new DashboardPanelConfig
            {
                Height = 742f,
                MaxPoints = 6
            };
            [JsonProperty("right")] public DashboardPanelConfig Right { get; set; } = new DashboardPanelConfig
            {
                Height = 742f,
                MaxPoints = 24
            };
            [JsonProperty("trends")] public DashboardPanelConfig Trends { get; set; } = new DashboardPanelConfig
            {
                Width = 1160f,
                Height = 192f,
                MaxCharts = 3
            };
        }

        private sealed class DashboardDeviceOverride
        {
            [JsonProperty("analogPointIds")] public List<string> AnalogPointIds { get; set; } = new List<string>();
            [JsonProperty("statusPointIds")] public List<string> StatusPointIds { get; set; } = new List<string>();
            [JsonProperty("trendPointIds")] public List<string> TrendPointIds { get; set; } = new List<string>();
        }

        private sealed class NativeDashboardConfig
        {
            [JsonProperty("version")] public int Version { get; set; } = 1;
            [JsonProperty("uiScale")] public float UiScale { get; set; } = 1f;
            [JsonProperty("sideMargin")] public float SideMargin { get; set; } = 24f;
            [JsonProperty("showHeader")] public bool ShowHeader { get; set; } = true;
            [JsonProperty("showWorldLabels")] public bool ShowWorldLabels { get; set; } = true;
            [JsonProperty("overview")] public DashboardOverviewConfig Overview { get; set; } = new DashboardOverviewConfig();
            [JsonProperty("detail")] public DashboardDetailConfig Detail { get; set; } = new DashboardDetailConfig();
            [JsonProperty("deviceOverrides")] public Dictionary<string, DashboardDeviceOverride> DeviceOverrides { get; set; }
                = new Dictionary<string, DashboardDeviceOverride>();
        }

        private const float DesignWidth = 1920f;
        private const float DesignHeight = 1080f;
        private const float ApplicationChromeHeight = 46f;
        private const int HistoryLimit = 72;

        private readonly Dictionary<string, DeviceView> _devices = new Dictionary<string, DeviceView>();
        private readonly Dictionary<string, string> _lineNames = new Dictionary<string, string>();

        private Camera _camera;
        private readonly DeviceOcclusionFader _occlusionFader = new DeviceOcclusionFader();
        private OrbitCameraController _orbit;
        private RuntimeDiagnosticsOverlay _diagnostics;
        private FactoryConfigDto _config;
        private Bounds _factoryBounds;
        private DeviceView _selected;
        private DashboardMode _mode = DashboardMode.Overview;
        private string _factoryName = "智能热处理数字孪生控制中心";
        private string _activeViewId = "factory_overview";
        private string _backendState = "starting";
        private string _plcState = "unknown";
        private float _uiScale = 1f;
        private Vector2 _uiOffset;
        private readonly PointerClickGesture _worldClick = new PointerClickGesture();
        private bool _webOverlayActive;
        private NativeDashboardConfig _dashboardConfig = new NativeDashboardConfig();
        private readonly Dictionary<string, ConfiguredView> _configuredViews = new Dictionary<string, ConfiguredView>();
        private string _defaultViewId = "factory_overview";

        private static readonly Color Background = new Color(0.025f, 0.055f, 0.095f, 0.9f);
        private static readonly Color Panel = new Color(0.035f, 0.075f, 0.12f, 0.84f);
        private static readonly Color PanelStrong = new Color(0.045f, 0.095f, 0.145f, 0.91f);
        private static readonly Color PanelSoft = new Color(0.065f, 0.12f, 0.17f, 0.68f);
        private static readonly Color Border = new Color(0.22f, 0.46f, 0.62f, 0.72f);
        private static readonly Color Accent = new Color(0.24f, 0.69f, 0.88f, 1f);
        private static readonly Color AccentSoft = new Color(0.18f, 0.46f, 0.62f, 0.72f);
        private static readonly Color Good = new Color(0.18f, 0.78f, 0.52f, 1f);
        private static readonly Color Warning = new Color(0.96f, 0.62f, 0.19f, 1f);
        private static readonly Color Bad = new Color(0.91f, 0.25f, 0.22f, 1f);
        private static readonly Color Text = new Color(0.89f, 0.95f, 0.98f, 1f);
        private static readonly Color Muted = new Color(0.52f, 0.66f, 0.73f, 1f);

        public string BackendState
        {
            get => _backendState;
            set => _backendState = string.IsNullOrWhiteSpace(value) ? "unknown" : value;
        }

        public string PlcState
        {
            get => _plcState;
            set => _plcState = string.IsNullOrWhiteSpace(value) ? "unknown" : value;
        }

        public string SelectedDeviceId => _selected?.Device?.Id ?? string.Empty;
        public string SelectedPartId => _selected?.Inspection?.SelectedPart?.Config?.Id ?? string.Empty;
        public string InspectionStageName => InspectionStageKey(_selected?.Inspection?.Stage ?? InspectionStage.Solid);
        public string ActiveViewId => _activeViewId;
        public string ActiveFactoryId => _config?.FactoryId ?? string.Empty;
        public string ActiveSceneId => ((_config?.Platform?["activeScene"] as JObject)?["id"] as JValue)?.Value as string ?? string.Empty;
        public event Action<string, string> ViewContextChanged;
        public event Action<JObject> InspectionContextChanged;
        public event Action<JObject> InspectionHoverUpdated;
        public event Action ParentNavigationRequested;
        public event Action DeviceEntryStarting;

        /// <summary>
        /// Determines whether a native Unity component is enabled for the active
        /// authored view. IDs are checked first, then the stable component type,
        /// so old documents and newly generated designer IDs both work.
        /// </summary>
        public bool IsActiveViewComponentVisible(string id, string type = "")
        {
            var view = ResolveView(_activeViewId, _mode == DashboardMode.Detail ? "device" : "factory");
            if (view == null) return true;
            var candidates = new[] { id, type, string.IsNullOrWhiteSpace(type) ? string.Empty : $"system:{type}" }
                .Where(value => !string.IsNullOrWhiteSpace(value));
            if (candidates.Any(value => view.HideComponents.Contains(value))) return false;
            return view.ShowComponents.Count == 0 || candidates.Any(value => view.ShowComponents.Contains(value));
        }

        public void Initialize(
            Camera runtimeCamera,
            OrbitCameraController orbit,
            RuntimeDiagnosticsOverlay diagnostics)
        {
            _camera = runtimeCamera;
            _orbit = orbit;
            _diagnostics = diagnostics;
        }

        public void BeginFactory(FactoryConfigDto config)
        {
            ClearFactory();
            UpdateFactoryDefinition(config, true);
            ApplySettings(config?.Settings);
        }

        // Definition refresh is not navigation. Do not reset selected device,
        // shell transparency, disassembly, camera or the visible widget state.
        public void UpdateFactoryDefinition(FactoryConfigDto config, bool publishedViewsChanged = false)
        {
            var documentChanged = !JToken.DeepEquals(_config?.Platform?["document"], config?.Platform?["document"]);
            _config = config;
            if (publishedViewsChanged || documentChanged) ApplyPublishedViews(config?.Platform?["document"] as JObject);
            _lineNames.Clear();

            foreach (var workshop in config?.Workshops ?? new List<WorkshopDto>())
            {
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    foreach (var device in line.Devices ?? new List<DeviceDto>())
                    {
                        if (!string.IsNullOrWhiteSpace(device.Id))
                        {
                            _lineNames[device.Id] = string.IsNullOrWhiteSpace(line.Name) ? line.Id : line.Name;
                        }
                    }
                }
                foreach (var device in workshop.Devices ?? new List<DeviceDto>())
                {
                    if (!string.IsNullOrWhiteSpace(device.Id))
                    {
                        _lineNames[device.Id] = string.IsNullOrWhiteSpace(workshop.Name)
                            ? "车间直属设备"
                            : workshop.Name;
                    }
                }
            }
        }

        public void ApplySettings(IReadOnlyDictionary<string, string> settings)
        {
            if (settings != null
                && settings.TryGetValue("factory_name", out var configuredName)
                && !string.IsNullOrWhiteSpace(configuredName))
            {
                _factoryName = configuredName;
            }

            var next = new NativeDashboardConfig();
            if (settings != null
                && settings.TryGetValue("native_dashboard_config", out var serialized)
                && !string.IsNullOrWhiteSpace(serialized))
            {
                try
                {
                    next = JsonConvert.DeserializeObject<NativeDashboardConfig>(serialized)
                        ?? new NativeDashboardConfig();
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"[FactoryDashboard] Invalid component configuration: {exception.Message}");
                }
            }
            _dashboardConfig = NormalizeDashboardConfig(next);
        }

        public void ApplyPublishedViews(JObject document)
        {
            _configuredViews.Clear();
            var hiddenViews = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            _defaultViewId = document?.SelectToken("scene.defaultViewId")?.Value<string>()
                ?? document?.SelectToken("scene.default_view_id")?.Value<string>()
                ?? "factory_overview";
            var views = document?.SelectToken("scene.views") as JArray;
            if (views != null)
            {
                foreach (var token in views.OfType<JObject>())
                {
                    var id = token.Value<string>("id");
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    var hidden = token.SelectToken("metadata.runtimeHidden")?.Value<bool?>()
                        ?? token.SelectToken("metadata.hierarchyHidden")?.Value<bool?>() ?? false;
                    // Geographic / site surfaces belong to the WebView router, never
                    // to the native factory camera or its Escape parent chain.
                    var globalSurface = id == "map_world" || id == "map_country" || id == "map_province"
                        || id == "map_city" || id == "map_district" || id == "site_street" || id == "site_factory";
                    if (hidden || globalSurface) { hiddenViews.Add(id); continue; }
                    var camera = token["camera"] as JObject;
                    var state = (token["componentState"] ?? token["components"]) as JObject;
                    var targetOffset = camera?["targetOffset"] as JArray;
                    var view = new ConfiguredView
                    {
                        Id = id,
                        Name = token.Value<string>("name") ?? id,
                        Mode = (token.Value<string>("mode") ?? "custom").ToLowerInvariant(),
                        TargetType = (token.Value<string>("targetType") ?? token.Value<string>("target_type") ?? "factory").ToLowerInvariant(),
                        TargetId = token.Value<string>("targetId") ?? token.Value<string>("target_id") ?? string.Empty,
                        ParentViewId = token.Value<string>("parentViewId") ?? token.Value<string>("parent_view_id") ?? string.Empty,
                        ReturnViewId = token.Value<string>("returnViewId") ?? token.Value<string>("return_view_id") ?? string.Empty,
                        Yaw = Mathf.Clamp(camera?.Value<float?>("yaw") ?? -39f, -360f, 360f),
                        Pitch = Mathf.Clamp(camera?.Value<float?>("pitch") ?? 33f, 6f, 82f),
                        DistanceScale = Mathf.Clamp(camera?.Value<float?>("distanceScale") ?? 1.08f, .1f, 10f),
                        TransitionSeconds = Mathf.Clamp(camera?.Value<float?>("transitionSeconds") ?? .8f, 0f, 10f),
                        RelativeToTarget = camera?.Value<bool?>("relativeToTarget") ?? false,
                        HideNonTargetDevices = state?.Value<bool?>("hideNonTargetDevices") ?? false,
                        Metadata = token["metadata"] as JObject ?? new JObject()
                    };
                    if (targetOffset != null)
                    {
                        view.TargetOffset = new Vector3(
                            targetOffset.Count > 0 ? targetOffset[0].Value<float>() : 0f,
                            targetOffset.Count > 1 ? targetOffset[1].Value<float>() : 0f,
                            targetOffset.Count > 2 ? targetOffset[2].Value<float>() : 0f);
                    }
                    foreach (var item in state?["show"] as JArray ?? new JArray()) view.ShowComponents.Add(item.ToString());
                    foreach (var item in state?["hide"] as JArray ?? new JArray()) view.HideComponents.Add(item.ToString());
                    _configuredViews[id] = view;
                }
            }
            EnsureBuiltInViews();
            foreach (var id in hiddenViews) _configuredViews.Remove(id);
            if (!_configuredViews.ContainsKey(_defaultViewId))
                _defaultViewId = _configuredViews.Values.FirstOrDefault()?.Id ?? "factory_overview";
            NormalizeViewNavigation();
        }

        public void ApplyTransientView(JObject token)
        {
            if (token == null) return;
            var id = token.Value<string>("id");
            if (string.IsNullOrWhiteSpace(id)) return;
            var camera = token["camera"] as JObject;
            var state = (token["componentState"] ?? token["components"]) as JObject;
            var view = new ConfiguredView
            {
                Id = id,
                Name = token.Value<string>("name") ?? id,
                Mode = (token.Value<string>("mode") ?? "custom").ToLowerInvariant(),
                TargetType = (token.Value<string>("targetType") ?? "factory").ToLowerInvariant(),
                TargetId = token.Value<string>("targetId") ?? string.Empty,
                ParentViewId = token.Value<string>("parentViewId") ?? string.Empty,
                ReturnViewId = token.Value<string>("returnViewId") ?? string.Empty,
                Yaw = Mathf.Clamp(camera?.Value<float?>("yaw") ?? -39f, -360f, 360f),
                Pitch = Mathf.Clamp(camera?.Value<float?>("pitch") ?? 33f, 6f, 82f),
                DistanceScale = Mathf.Clamp(camera?.Value<float?>("distanceScale") ?? 1.08f, .1f, 10f),
                TransitionSeconds = Mathf.Clamp(camera?.Value<float?>("transitionSeconds") ?? .8f, 0f, 10f),
                RelativeToTarget = camera?.Value<bool?>("relativeToTarget") ?? false,
                HideNonTargetDevices = state?.Value<bool?>("hideNonTargetDevices") ?? false,
                Metadata = token["metadata"] as JObject ?? new JObject()
            };
            var targetOffset = camera?["targetOffset"] as JArray;
            if (targetOffset != null)
            {
                view.TargetOffset = new Vector3(
                    targetOffset.Count > 0 ? targetOffset[0].Value<float>() : 0f,
                    targetOffset.Count > 1 ? targetOffset[1].Value<float>() : 0f,
                    targetOffset.Count > 2 ? targetOffset[2].Value<float>() : 0f);
            }
            foreach (var item in state?["show"] as JArray ?? new JArray()) view.ShowComponents.Add(item.ToString());
            foreach (var item in state?["hide"] as JArray ?? new JArray()) view.HideComponents.Add(item.ToString());
            _configuredViews[id] = view;
            NormalizeViewNavigation();
        }

        private void EnsureBuiltInViews()
        {
            if (!_configuredViews.ContainsKey("factory_overview"))
                _configuredViews["factory_overview"] = new ConfiguredView { Id = "factory_overview", Name = "全厂总览", Mode = "factory", TargetType = "factory", Yaw = -39f, Pitch = 33f, DistanceScale = 1.08f };
            if (!_configuredViews.ContainsKey("workshop_overview"))
                _configuredViews["workshop_overview"] = new ConfiguredView { Id = "workshop_overview", Name = "车间视角", Mode = "workshop", TargetType = "workshop", ParentViewId = "factory_overview", ReturnViewId = "factory_overview", Yaw = -39f, Pitch = 36f, DistanceScale = 1.08f };
            if (!_configuredViews.ContainsKey("line_overview"))
                _configuredViews["line_overview"] = new ConfiguredView { Id = "line_overview", Name = "产线视角", Mode = "line", TargetType = "line", ParentViewId = "workshop_overview", ReturnViewId = "workshop_overview", Yaw = -39f, Pitch = 33f, DistanceScale = 1.08f };
            if (!_configuredViews.ContainsKey("device_detail"))
                _configuredViews["device_detail"] = new ConfiguredView { Id = "device_detail", Name = "设备详情", Mode = "device", TargetType = "device", ParentViewId = "line_overview", ReturnViewId = "line_overview", Yaw = 238f, Pitch = 19f, DistanceScale = 1.12f, RelativeToTarget = true };
            if (!_configuredViews.ContainsKey("device_xray"))
                _configuredViews["device_xray"] = new ConfiguredView { Id = "device_xray", Name = "设备透视", Mode = "device", TargetType = "device", ParentViewId = "device_detail", ReturnViewId = "device_detail", Yaw = 238f, Pitch = 19f, DistanceScale = 1.08f, RelativeToTarget = true };
            if (!_configuredViews.ContainsKey("device_exploded"))
                _configuredViews["device_exploded"] = new ConfiguredView { Id = "device_exploded", Name = "设备拆解", Mode = "device", TargetType = "device", ParentViewId = "device_xray", ReturnViewId = "device_xray", Yaw = 238f, Pitch = 22f, DistanceScale = 1.22f, RelativeToTarget = true };
            if (!_configuredViews.ContainsKey("device_part"))
                _configuredViews["device_part"] = new ConfiguredView { Id = "device_part", Name = "部件详情", Mode = "device", TargetType = "device_part", ParentViewId = "device_exploded", ReturnViewId = "device_exploded", Yaw = 238f, Pitch = 18f, DistanceScale = 1.35f, RelativeToTarget = true };
            if (!_configuredViews.ContainsKey(_defaultViewId)) _defaultViewId = "factory_overview";

            NormalizeViewNavigation();
        }

        private void NormalizeViewNavigation()
        {
            foreach (var view in _configuredViews.Values)
            {
                if (!string.IsNullOrWhiteSpace(view.ParentViewId)
                    && (string.Equals(view.ParentViewId, view.Id, StringComparison.OrdinalIgnoreCase)
                        || !_configuredViews.ContainsKey(view.ParentViewId)))
                    view.ParentViewId = string.Empty;
                if (!string.IsNullOrWhiteSpace(view.ReturnViewId)
                    && (string.Equals(view.ReturnViewId, view.Id, StringComparison.OrdinalIgnoreCase)
                        || !_configuredViews.ContainsKey(view.ReturnViewId)))
                    view.ReturnViewId = view.ParentViewId ?? string.Empty;
            }

            // Break parent cycles defensively. A malformed custom hierarchy
            // should degrade to a root view, never trap Esc in a loop.
            foreach (var start in _configuredViews.Values)
            {
                var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var cursor = start;
                while (cursor != null && !string.IsNullOrWhiteSpace(cursor.ParentViewId))
                {
                    if (!visited.Add(cursor.Id))
                    {
                        start.ParentViewId = string.Empty;
                        if (string.Equals(start.ReturnViewId, cursor.Id, StringComparison.OrdinalIgnoreCase))
                            start.ReturnViewId = string.Empty;
                        break;
                    }
                    _configuredViews.TryGetValue(cursor.ParentViewId, out cursor);
                }
            }
        }

        private ConfiguredView ResolveView(string viewId, string mode = "")
        {
            if (!string.IsNullOrWhiteSpace(viewId) && _configuredViews.TryGetValue(viewId, out var exact)) return exact;
            var normalized = (mode ?? string.Empty).ToLowerInvariant();
            var match = _configuredViews.Values.FirstOrDefault(view => string.Equals(view.Mode, normalized, System.StringComparison.OrdinalIgnoreCase));
            return match ?? (_configuredViews.TryGetValue(_defaultViewId, out var fallback) ? fallback : null);
        }

        public ConfiguredView GetConfiguredView(string viewId, string mode = "") => ResolveView(viewId, mode);

        public void SetWebOverlayActive(bool active)
        {
            _webOverlayActive = active;
            if (_orbit != null && active) _orbit.PointerInputBlocked = false;
        }

        public void RegisterDevice(DeviceDto device, GameObject root, DeviceInspectionConfigDto inspection = null)
        {
            if (device == null || root == null || string.IsNullOrWhiteSpace(device.Id)) return;
            var view = new DeviceView
            {
                Device = device,
                Root = root,
                WorldBounds = CalculateBounds(root),
                LineName = _lineNames.TryGetValue(device.Id, out var lineName) ? lineName : "未分配产线",
                Inspection = new DeviceInspectionRuntime { Config = inspection ?? ResolveInspectionConfig(device) }
            };
            PrepareInspection(view);
            _devices[device.Id] = view;
            _deviceHoverView = string.Empty;
        }

        public void ApplyPreviewDevice(DeviceDto device, GameObject root, DeviceInspectionConfigDto inspection = null)
        {
            if (device == null || root == null || string.IsNullOrWhiteSpace(device.Id)) return;
            if (_devices.TryGetValue(device.Id, out var existing))
            {
                ResetInspection(existing, true);
                existing.Device = device;
                existing.Root = root;
                existing.WorldBounds = CalculateBounds(root);
                existing.Inspection = new DeviceInspectionRuntime { Config = inspection ?? ResolveInspectionConfig(device) };
                PrepareInspection(existing);
                _deviceHoverView = string.Empty;
                return;
            }
            RegisterDevice(device, root, inspection);
        }

        public void UpdateLiveDeviceDefinition(DeviceDto device, bool boundsChanged)
        {
            if (device == null || !_devices.TryGetValue(device.Id, out var existing)) return;
            existing.Device = device;
            if (boundsChanged && existing.Root != null) existing.WorldBounds = CalculateBounds(existing.Root);
        }

        public void UpdatePreviewFactoryBounds(Bounds factoryBounds)
        {
            _factoryBounds = factoryBounds;
            foreach (var device in _devices.Values)
            {
                if (device.Root != null) device.WorldBounds = CalculateBounds(device.Root);
            }
        }

        public void FocusPreviewBounds(Bounds bounds, ConfiguredView view = null, ISet<string> targetDeviceIds = null)
        {
            _occlusionFader.Clear();
            if (_selected != null) ResetInspection(_selected, false);
            _selected = null;
            _mode = DashboardMode.Overview;
            var configured = view ?? ResolveView(string.Empty, "factory");
            foreach (var entry in _devices.Values)
            {
                var keepVisible = !(configured?.HideNonTargetDevices ?? false)
                    || targetDeviceIds == null
                    || targetDeviceIds.Contains(entry.Device?.Id ?? string.Empty);
                if (entry.Root != null) entry.Root.SetActive(keepVisible);
            }
            _activeViewId = configured?.Id ?? _defaultViewId;
            _orbit?.SetTransitionDuration(configured?.TransitionSeconds ?? .8f);
            _orbit?.SetTargetOffset(configured?.TargetOffset ?? Vector3.zero);
            _orbit?.FocusBounds(bounds, configured?.Yaw ?? -39f, configured?.Pitch ?? 33f, configured?.DistanceScale ?? 1.08f, false);
        }

        public void FocusPreviewDevice(string deviceId, ConfiguredView view = null, string inspectionStage = "", string partId = "")
        {
            if (string.IsNullOrWhiteSpace(deviceId)) return;
            if (!_devices.TryGetValue(deviceId, out var device)) return;
            ShowDetail(device, view ?? ResolveView(string.Empty, "device"));
            if (!string.IsNullOrWhiteSpace(inspectionStage))
            {
                SetInspectionStage(device, ParseInspectionStage(inspectionStage), false, partId);
            }
        }

        public void CompleteFactory(Bounds factoryBounds)
        {
            _factoryBounds = factoryBounds;
            ShowOverview(true, ResolveView(_defaultViewId, "factory"));
            if (_diagnostics != null) _diagnostics.Visible = false;
        }

        public void ApplyRealtime(string deviceId, JObject frame)
        {
            if (string.IsNullOrWhiteSpace(deviceId) || !_devices.TryGetValue(deviceId, out var device)) return;
            device.Frame = frame;
            var now = Time.realtimeSinceStartup;
            if (now - device.LastHistoryAt < 0.7f) return;
            device.LastHistoryAt = now;

            foreach (var point in TrendPoints(device.Device))
            {
                if (!TryPointNumber(device, point, out var value)) continue;
                var key = PointKey(point);
                if (!device.History.TryGetValue(key, out var values))
                {
                    values = new List<float>();
                    device.History[key] = values;
                }
                values.Add(value);
                if (values.Count > HistoryLimit) values.RemoveRange(0, values.Count - HistoryLimit);
            }
        }

        public void ClearFactory()
        {
            ClearOverviewMatrices();
            InspectionOutlineRenderer.Release(_camera);
            _occlusionFader.Clear();
            _worldClick.Cancel();
            _inspectionHitRects.Clear();
            foreach (var entry in _devices.Values)
            {
                ResetInspection(entry, true);
                if (entry.Root != null) entry.Root.SetActive(true);
            }
            _devices.Clear();
            _deviceHoverView = string.Empty;
            _hoveredDeviceId = string.Empty;
            _deviceHoverCount = -1;
            _selected = null;
            _mode = DashboardMode.Overview;
        }

        private void Update()
        {
            UpdateCanvasMetrics();
            UpdateInspectionTransition();
            var pointer = ScreenToDesign(Input.mousePosition);
            var explicitUiBlocksPointer = !_webOverlayActive && IsPointerOverDashboard(pointer);
            if (_orbit != null) _orbit.PointerInputBlocked = explicitUiBlocksPointer;

            var screenPointer = Input.mousePosition;
            if (Input.GetMouseButtonDown(0)) _worldClick.Begin(screenPointer.x, screenPointer.y, !explicitUiBlocksPointer);
            if (Input.GetMouseButton(0)) _worldClick.Move(screenPointer.x, screenPointer.y);
            if (!Input.GetMouseButtonUp(0)) return;
            if (_worldClick.End(screenPointer.x, screenPointer.y, !explicitUiBlocksPointer)) SelectFromWorld(screenPointer);
        }

        private void OnApplicationFocus(bool focused)
        {
            if (!focused) _worldClick.Cancel();
        }

        private void ShowDetail(DeviceView device, ConfiguredView configuredView = null)
        {
            if (device == null || device.Root == null) return;
            if (_mode != DashboardMode.Detail) DeviceEntryStarting?.Invoke();
            _occlusionFader.Clear();
            if (_selected != null && _selected != device) ResetInspection(_selected, false);
            _selected = device;
            _mode = DashboardMode.Detail;
            ResetInspection(device, false);
            if (device.Inspection == null)
            {
                device.Inspection = new DeviceInspectionRuntime { Config = ResolveInspectionConfig(device.Device) };
                PrepareInspection(device);
            }
            device.Inspection.Stage = InspectionStage.Solid;
            // Enter with the original solid covers. The upper shell button
            // explicitly enables the transparent presentation when requested.
            foreach (var entry in _devices.Values)
            {
                // A device inspection is always a single-machine view, even
                // when a custom view forgot to opt into non-target hiding.
                if (entry.Root != null) entry.Root.SetActive(entry == device);
            }
            device.WorldBounds = CalculateBounds(device.Root);
            // Keep the same authored three-quarter view regardless of the device's
            // configured factory yaw. This prevents a correctly rotated device from
            // opening on its rear side in the detail view.
            var view = configuredView ?? ResolveView(string.Empty, "device");
            var detailYaw = view?.RelativeToTarget == true
                ? Mathf.DeltaAngle(0f, device.Root.transform.eulerAngles.y + view.Yaw)
                : (view?.Yaw ?? Mathf.DeltaAngle(0f, device.Root.transform.eulerAngles.y + 238f));
            _activeViewId = view?.Id ?? "device_detail";
            _orbit?.SetTransitionDuration(view?.TransitionSeconds ?? .55f);
            _orbit?.SetTargetOffset(view?.TargetOffset ?? Vector3.zero);
            _orbit?.FocusBounds(device.WorldBounds, detailYaw, view?.Pitch ?? 19f, view?.DistanceScale ?? 1.12f, false);
            ViewContextChanged?.Invoke("device", device.Device?.Id ?? string.Empty);
            PublishInspectionContext(device);
        }

        private void ShowOverview(bool immediate, ConfiguredView configuredView = null)
        {
            _occlusionFader.Clear();
            if (_selected != null) ResetInspection(_selected, false);
            _selected = null;
            _mode = DashboardMode.Overview;
            foreach (var entry in _devices.Values)
            {
                if (entry.Root != null) entry.Root.SetActive(true);
            }
            var view = configuredView ?? ResolveView(string.Empty, "factory");
            _activeViewId = view?.Id ?? _defaultViewId;
            _orbit?.SetTransitionDuration(view?.TransitionSeconds ?? .8f);
            _orbit?.SetTargetOffset(view?.TargetOffset ?? Vector3.zero);
            _orbit?.FocusBounds(_factoryBounds, view?.Yaw ?? -39f, view?.Pitch ?? 33f, view?.DistanceScale ?? 1.08f, immediate);
            ViewContextChanged?.Invoke("factory", string.Empty);
        }

        public void NavigateBack()
        {
            if (_mode == DashboardMode.Detail && _selected?.Inspection != null)
            {
                switch (_selected.Inspection.Stage)
                {
                    case InspectionStage.PartDetail:
                        SetInspectionStage(_selected, InspectionStage.Exploded);
                        return;
                    case InspectionStage.Exploded:
                        SetInspectionStage(_selected, InspectionStage.Xray);
                        return;
                    case InspectionStage.Xray:
                        SetInspectionStage(_selected, InspectionStage.Solid);
                        return;
                }
            }
            // The runtime owns the scene hierarchy and keeps the current target
            // ids (workshop/line/device). It can therefore return to the real
            // authored parent instead of treating every parent as factory view.
            ParentNavigationRequested?.Invoke();
        }

        private void SelectFromWorld(Vector3 screenPosition)
        {
            if (_camera == null) return;
            if (!_webOverlayActive && IsPointerOverDashboard(ScreenToDesign(screenPosition))) return;
            // Once inside a device, world clicks belong to its inspection
            // state machine. Re-entering ShowDetail here resets disassembly,
            // materials, camera framing and the entire overlay on every click.
            if (_mode == DashboardMode.Detail)
            {
                SelectInspectionTargetAt(screenPosition);
                return;
            }
            // Click and hover share the same exact visible geometry; a rear
            // device seen through a CAD gap must not open a front device's box.
            var closest = PickOverviewDevice(screenPosition);
            if (closest != null) ShowDetail(closest);
        }

        private DeviceInspectionConfigDto ResolveInspectionConfig(DeviceDto device)
        {
            var asset = _config?.Models?.FirstOrDefault(model => string.Equals(model?.Id, device?.ModelType, StringComparison.OrdinalIgnoreCase));
            return InspectionConfigResolver.Resolve(asset, device);
        }

        private bool IsPointerOverDashboard(Vector2 pointer)
        {
            // Only explicitly registered interaction controls reserve pixels.
            // Retired headers, sidebars and default labels never do.
            return _inspectionHitRects.Any(rect => rect.Contains(pointer));
        }

        private void UpdateCanvasMetrics()
        {
            var availableHeight = Mathf.Max(1f, Screen.height - ApplicationChromeHeight);
            var fitScale = Mathf.Max(0.1f, Mathf.Min(Screen.width / DesignWidth, availableHeight / DesignHeight));
            _uiScale = fitScale * _dashboardConfig.UiScale;
            _uiOffset = new Vector2(
                (Screen.width - DesignWidth * _uiScale) * 0.5f,
                ApplicationChromeHeight + (availableHeight - DesignHeight * _uiScale) * 0.5f
            );
        }

        private Vector2 ScreenToDesign(Vector3 screenPoint)
        {
            return new Vector2(
                (screenPoint.x - _uiOffset.x) / _uiScale,
                (Screen.height - screenPoint.y - _uiOffset.y) / _uiScale
            );
        }

        private Vector2 ScreenPixelToDesign(Vector3 screenPoint)
        {
            return new Vector2(
                (screenPoint.x - _uiOffset.x) / _uiScale,
                (Screen.height - screenPoint.y - _uiOffset.y) / _uiScale
            );
        }

        private static Bounds CalculateBounds(GameObject root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(true)
                .Where(renderer => renderer != null && renderer.enabled)
                .ToArray();
            if (renderers.Length == 0) return new Bounds(root.transform.position, new Vector3(3f, 3f, 3f));
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index += 1) bounds.Encapsulate(renderers[index].bounds);
            bounds.Expand(new Vector3(0.5f, 0.5f, 0.5f));
            return bounds;
        }

        private static NativeDashboardConfig NormalizeDashboardConfig(NativeDashboardConfig value)
        {
            var config = value ?? new NativeDashboardConfig();
            config.UiScale = Mathf.Clamp(config.UiScale, 0.8f, 1.2f);
            config.SideMargin = Mathf.Clamp(config.SideMargin, 8f, 100f);
            config.Overview ??= new DashboardOverviewConfig();
            config.Detail ??= new DashboardDetailConfig();
            config.Overview.Left ??= new DashboardPanelConfig();
            config.Overview.Right ??= new DashboardPanelConfig { MaxDevices = 20 };
            config.Detail.Left ??= new DashboardPanelConfig { Height = 742f, MaxPoints = 6 };
            config.Detail.Right ??= new DashboardPanelConfig { Height = 742f, MaxPoints = 24 };
            config.Detail.Trends ??= new DashboardPanelConfig { Height = 192f, MaxCharts = 3 };

            NormalizePanel(config.Overview.Left, 260f, 520f, 800f, 900f);
            NormalizePanel(config.Overview.Right, 260f, 520f, 420f, 900f);
            NormalizePanel(config.Detail.Left, 260f, 520f, 520f, 830f);
            NormalizePanel(config.Detail.Right, 260f, 520f, 420f, 830f);
            NormalizePanel(config.Detail.Trends, 360f, 1600f, 140f, 320f);
            config.Overview.Right.MaxDevices = Mathf.Clamp(config.Overview.Right.MaxDevices, 1, 100);
            config.Detail.Left.MaxPoints = Mathf.Clamp(config.Detail.Left.MaxPoints, 1, 12);
            config.Detail.Right.MaxPoints = Mathf.Clamp(config.Detail.Right.MaxPoints, 1, 100);
            config.Detail.Trends.MaxCharts = Mathf.Clamp(config.Detail.Trends.MaxCharts, 1, 4);

            var overrides = new Dictionary<string, DashboardDeviceOverride>();
            foreach (var entry in config.DeviceOverrides ?? new Dictionary<string, DashboardDeviceOverride>())
            {
                if (string.IsNullOrWhiteSpace(entry.Key) || entry.Value == null) continue;
                entry.Value.AnalogPointIds = SanitizePointIds(entry.Value.AnalogPointIds);
                entry.Value.StatusPointIds = SanitizePointIds(entry.Value.StatusPointIds);
                entry.Value.TrendPointIds = SanitizePointIds(entry.Value.TrendPointIds);
                overrides[entry.Key] = entry.Value;
            }
            config.DeviceOverrides = overrides;
            return config;
        }

        private static void NormalizePanel(
            DashboardPanelConfig panel,
            float minimumWidth,
            float maximumWidth,
            float minimumHeight,
            float maximumHeight)
        {
            panel.Width = Mathf.Clamp(panel.Width, minimumWidth, maximumWidth);
            panel.Height = Mathf.Clamp(panel.Height, minimumHeight, maximumHeight);
            panel.Opacity = Mathf.Clamp(panel.Opacity, 0.25f, 1f);
        }

        private static List<string> SanitizePointIds(IEnumerable<string> values)
        {
            return (values ?? Enumerable.Empty<string>())
                .Select(value => value?.Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct()
                .Take(200)
                .ToList();
        }

        private DashboardDeviceOverride DeviceOverride(DeviceDto device)
        {
            if (device == null || string.IsNullOrWhiteSpace(device.Id)) return null;
            return _dashboardConfig.DeviceOverrides.TryGetValue(device.Id, out var value) ? value : null;
        }

        private IEnumerable<DataPointDto> DetailAnalogPoints(DeviceDto device)
        {
            return SelectConfiguredPoints(device, AnalogPoints(device), DeviceOverride(device)?.AnalogPointIds);
        }

        private IEnumerable<DataPointDto> DetailStatusPoints(DeviceDto device)
        {
            var candidates = (device?.DataPoints ?? new List<DataPointDto>())
                .Where(point => !string.Equals(point.Category, "analog", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(point => string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase))
                .ThenBy(point => point.Category)
                .ThenBy(point => point.Label);
            return SelectConfiguredPoints(device, candidates, DeviceOverride(device)?.StatusPointIds);
        }

        private IEnumerable<DataPointDto> TrendPoints(DeviceDto device)
        {
            return SelectConfiguredPoints(device, AnalogPoints(device), DeviceOverride(device)?.TrendPointIds)
                .Take(_dashboardConfig.Detail.Trends.MaxCharts);
        }

        private static IEnumerable<DataPointDto> SelectConfiguredPoints(
            DeviceDto device,
            IEnumerable<DataPointDto> candidates,
            IReadOnlyList<string> configuredIds)
        {
            var available = (candidates ?? Enumerable.Empty<DataPointDto>()).ToList();
            if (configuredIds == null || configuredIds.Count == 0) return available;
            var byId = available
                .GroupBy(point => point.Id.ToString(CultureInfo.InvariantCulture))
                .ToDictionary(group => group.Key, group => group.First());
            return configuredIds
                .Where(id => !string.IsNullOrWhiteSpace(id) && byId.ContainsKey(id))
                .Select(id => byId[id])
                .ToList();
        }

        private static IEnumerable<DataPointDto> AnalogPoints(DeviceDto device)
        {
            return (device?.DataPoints ?? new List<DataPointDto>())
                .Where(point => string.Equals(point.Category, "analog", StringComparison.OrdinalIgnoreCase));
        }

        private static string PointKey(DataPointDto point)
        {
            return string.IsNullOrWhiteSpace(point?.ValueRole) ? point?.Name ?? string.Empty : point.ValueRole;
        }

        private static string PointLabel(DataPointDto point)
        {
            if (!string.IsNullOrWhiteSpace(point?.Label)) return point.Label;
            if (!string.IsNullOrWhiteSpace(point?.Name)) return point.Name;
            return "未命名点位";
        }

        private static JToken PointToken(DeviceView device, DataPointDto point)
        {
            if (device?.Frame == null || point == null) return null;
            var category = string.IsNullOrWhiteSpace(point.Category) ? "analog" : point.Category;
            var key = PointKey(point);
            return device.Frame[category]?[key]
                ?? device.Frame[category]?[point.Name]
                ?? device.Frame.SelectToken($"{category}.{key}");
        }

        private static string PointQuality(DeviceView device, DataPointDto point)
        {
            if (device?.Frame == null || point == null) return "bad";
            var category = string.IsNullOrWhiteSpace(point.Category) ? "analog" : point.Category;
            var key = PointKey(point);
            return device.Frame["quality"]?[category]?[key]?.ToString()
                ?? device.Frame["quality"]?[category]?[point.Name]?.ToString()
                ?? "bad";
        }

        private static bool TryPointNumber(DeviceView device, DataPointDto point, out float value)
        {
            value = 0f;
            var token = PointToken(device, point);
            if (token == null || token.Type == JTokenType.Null) return false;
            return float.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        private static bool PointBool(DeviceView device, DataPointDto point)
        {
            return TokenBool(PointToken(device, point));
        }

        private static bool TokenBool(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null) return false;
            if (token.Type == JTokenType.Boolean) return token.Value<bool>();
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) return Math.Abs(token.Value<double>()) > double.Epsilon;
            var value = token.ToString().Trim().ToLowerInvariant();
            return value == "1" || value == "true" || value == "on" || value == "running" || value == "alarm";
        }

        private static string FormatPointValue(DeviceView device, DataPointDto point)
        {
            var token = PointToken(device, point);
            if (token == null || token.Type == JTokenType.Null) return "--";
            if (string.Equals(point.DataType, "BOOL", StringComparison.OrdinalIgnoreCase)
                || token.Type == JTokenType.Boolean)
            {
                return TokenBool(token) ? "开启" : "关闭";
            }
            var text = token.ToString();
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            {
                var format = string.IsNullOrWhiteSpace(point.DisplayFormat) ? "0.##" : point.DisplayFormat;
                try { text = number.ToString(format, CultureInfo.InvariantCulture); }
                catch (FormatException) { text = number.ToString("0.##", CultureInfo.InvariantCulture); }
            }
            var unit = string.IsNullOrWhiteSpace(point.Unit) ? InferUnit(PointLabel(point)) : point.Unit;
            return string.IsNullOrWhiteSpace(unit) ? text : $"{text} {unit}";
        }

        private static string InferUnit(string label)
        {
            if (label.Contains("温度")) return "℃";
            if (label.Contains("碳势")) return "%";
            if (label.Contains("压力")) return "Pa";
            if (label.Contains("转速")) return "rpm";
            return string.Empty;
        }

        private static bool IsOnline(DeviceView device)
        {
            if (device?.Frame == null) return false;
            var values = LeafValues(device.Frame["quality"])
                .Select(value => value.ToString())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToList();
            if (values.Count == 0) return true;
            return values.Any(value => string.Equals(value, "good", StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsRunning(DeviceView device)
        {
            if (device?.Frame == null) return false;
            foreach (var categoryName in new[] { "status", "motors", "mechanisms" })
            {
                if (!(device.Frame[categoryName] is JObject category)) continue;
                foreach (var property in category.Properties())
                {
                    var name = property.Name.ToLowerInvariant();
                    if ((name.Contains("run") || name.Contains("fan") || name.Contains("stir") || name.Contains("运行"))
                        && TokenBool(property.Value)) return true;
                }
            }
            return false;
        }

        private static bool HasAlarm(DeviceView device)
        {
            foreach (var point in device?.Device?.DataPoints ?? new List<DataPointDto>())
            {
                if (!string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase)) continue;
                if (PointBool(device, point)) return true;
            }
            return TokenBool(device?.Frame?["status"]?["alarm"]);
        }

        private static string DeviceState(DeviceView device)
        {
            if (HasAlarm(device)) return "报警";
            if (!IsOnline(device)) return "离线";
            if (IsRunning(device)) return "运行";
            return "待机";
        }

        private static Color DeviceStateColor(DeviceView device)
        {
            if (HasAlarm(device)) return Bad;
            if (!IsOnline(device)) return Warning;
            return IsRunning(device) ? Good : Accent;
        }

        private static Color PointQualityColor(DeviceView device, DataPointDto point)
        {
            var quality = PointQuality(device, point);
            if (string.Equals(quality, "good", StringComparison.OrdinalIgnoreCase)) return Good;
            if (string.Equals(quality, "stale", StringComparison.OrdinalIgnoreCase)) return Warning;
            return Bad;
        }

        private static string OverviewValue(DeviceView device)
        {
            var point = AnalogPoints(device.Device).FirstOrDefault(candidate => PointLabel(candidate).Contains("实际温度"))
                ?? AnalogPoints(device.Device).FirstOrDefault();
            return point == null ? DeviceState(device) : FormatPointValue(device, point);
        }

        private static void CountPointQuality(JObject frame, ref int good, ref int bad)
        {
            if (frame?["quality"] == null) return;
            foreach (var value in LeafValues(frame["quality"]))
            {
                var quality = value.ToString();
                if (string.Equals(quality, "good", StringComparison.OrdinalIgnoreCase)) good += 1;
                else if (!string.IsNullOrWhiteSpace(quality)) bad += 1;
            }
        }

        private static IEnumerable<JValue> LeafValues(JToken token)
        {
            if (token == null) yield break;
            if (token is JValue value)
            {
                yield return value;
                yield break;
            }
            foreach (var child in token.Children())
            {
                foreach (var leaf in LeafValues(child)) yield return leaf;
            }
        }

        private static string FriendlyState(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "未知";
            var normalized = value.ToLowerInvariant();
            if (normalized.Contains("connected") || normalized.Contains("online") || normalized.Contains("running")) return "正常";
            if (normalized.Contains("simulat")) return "模拟";
            if (normalized.Contains("connect")) return "连接中";
            if (normalized.Contains("bad") || normalized.Contains("offline") || normalized.Contains("error")) return "异常";
            return value.Length > 8 ? value.Substring(0, 8) : value;
        }

        private static Color StateColor(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return Muted;
            var normalized = value.ToLowerInvariant();
            if (normalized.Contains("connected") || normalized.Contains("online") || normalized.Contains("running") || normalized.Contains("simulat")) return Good;
            if (normalized.Contains("connect") || normalized.Contains("retry")) return Warning;
            if (normalized.Contains("bad") || normalized.Contains("offline") || normalized.Contains("error")) return Bad;
            return Accent;
        }

        private void OnDestroy()
        {
            ClearOverviewMatrices();
            ClearFactory();
            DisposeInspectionHighlight();
        }

        private void OnDisable()
        {
            _occlusionFader.Clear();
            InspectionOutlineRenderer.Release(_camera);
        }
    }
}
