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
    /// It intentionally uses the authored PBR materials without neon edge rendering.
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
        private Vector2 _pointerDown;
        private Vector2 _deviceScroll;
        private Vector2 _pointScroll;
        private float _uiBlend = 1f;
        private bool _webOverlayActive;
        private NativeDashboardConfig _dashboardConfig = new NativeDashboardConfig();
        private readonly Dictionary<string, ConfiguredView> _configuredViews = new Dictionary<string, ConfiguredView>();
        private string _defaultViewId = "factory_overview";

        private Texture2D _whiteTexture;
        private Texture2D _buttonTexture;
        private Texture2D _buttonHoverTexture;
        private Texture2D _buttonActiveTexture;
        private Font _font;
        private GUIStyle _brandStyle;
        private GUIStyle _headerStyle;
        private GUIStyle _sectionStyle;
        private GUIStyle _bodyStyle;
        private GUIStyle _mutedStyle;
        private GUIStyle _smallStyle;
        private GUIStyle _metricStyle;
        private GUIStyle _metricValueStyle;
        private GUIStyle _buttonStyle;
        private GUIStyle _centerStyle;

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
        public event Action<string, string> ViewContextChanged;
        public event Action<JObject> InspectionContextChanged;
        public event Action ParentNavigationRequested;

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
            _config = config;
            ApplyPublishedViews(config?.Platform?["document"] as JObject);
            _lineNames.Clear();
            ApplySettings(config?.Settings);

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
                return;
            }
            RegisterDevice(device, root, inspection);
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
            if (_selected != null) ResetInspection(_selected, false);
            _selected = null;
            _mode = DashboardMode.Overview;
            _uiBlend = 1f;
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
            foreach (var entry in _devices.Values)
            {
                ResetInspection(entry, true);
                if (entry.Root != null) entry.Root.SetActive(true);
            }
            _devices.Clear();
            _selected = null;
            _mode = DashboardMode.Overview;
            _deviceScroll = Vector2.zero;
            _pointScroll = Vector2.zero;
        }

        private void Update()
        {
            UpdateCanvasMetrics();
            UpdateInspectionTransition();
            UpdateInspectionHover();
            _uiBlend = Mathf.MoveTowards(_uiBlend, 1f, Time.unscaledDeltaTime * 4.2f);
            var pointer = ScreenToDesign(Input.mousePosition);
            var legacyDashboardBlocksPointer = !_webOverlayActive && IsPointerOverDashboard(pointer);
            if (_orbit != null) _orbit.PointerInputBlocked = legacyDashboardBlocksPointer;

            if (Input.GetMouseButtonDown(0)) _pointerDown = pointer;
            if (!Input.GetMouseButtonUp(0)) return;
            if (legacyDashboardBlocksPointer) return;
            if (Vector2.Distance(_pointerDown, pointer) > 10f) return;
            SelectFromWorld(Input.mousePosition);
        }

        private void OnGUI()
        {
            if (_camera == null || _webOverlayActive) return;
            EnsureStyles();
            UpdateCanvasMetrics();
            var oldMatrix = GUI.matrix;
            var oldColor = GUI.color;
            GUI.matrix = Matrix4x4.TRS(
                new Vector3(_uiOffset.x, _uiOffset.y, 0f),
                Quaternion.identity,
                new Vector3(_uiScale, _uiScale, 1f)
            );
            GUI.color = new Color(1f, 1f, 1f, Mathf.SmoothStep(0f, 1f, _uiBlend));

            if (_dashboardConfig.ShowHeader && IsActiveViewComponentVisible("widget_navigation", "navigation")) DrawHeader();
            if (_mode == DashboardMode.Detail && _selected != null) DrawDetail();
            else DrawOverview();

            GUI.color = oldColor;
            GUI.matrix = oldMatrix;
        }

        private float OverviewTop => _dashboardConfig.ShowHeader ? 104f : 24f;
        private float DetailTop => _dashboardConfig.ShowHeader ? 148f : 76f;

        private Rect OverviewLeftRect()
        {
            var panel = _dashboardConfig.Overview.Left;
            return new Rect(_dashboardConfig.SideMargin, OverviewTop, panel.Width, panel.Height);
        }

        private Rect OverviewRightRect()
        {
            var panel = _dashboardConfig.Overview.Right;
            return new Rect(DesignWidth - _dashboardConfig.SideMargin - panel.Width, OverviewTop, panel.Width, panel.Height);
        }

        private Rect DetailLeftRect()
        {
            var panel = _dashboardConfig.Detail.Left;
            return new Rect(_dashboardConfig.SideMargin, DetailTop, panel.Width, panel.Height);
        }

        private Rect DetailRightRect()
        {
            var panel = _dashboardConfig.Detail.Right;
            return new Rect(DesignWidth - _dashboardConfig.SideMargin - panel.Width, DetailTop, panel.Width, panel.Height);
        }

        private Rect DetailTrendRect()
        {
            var left = DetailLeftRect();
            var right = DetailRightRect();
            var x = _dashboardConfig.Detail.Left.Visible ? left.xMax + 30f : _dashboardConfig.SideMargin;
            var rightEdge = _dashboardConfig.Detail.Right.Visible ? right.x - 30f : DesignWidth - _dashboardConfig.SideMargin;
            var bottom = DesignHeight - 24f;
            return new Rect(
                x,
                bottom - _dashboardConfig.Detail.Trends.Height,
                Mathf.Max(360f, rightEdge - x),
                _dashboardConfig.Detail.Trends.Height
            );
        }

        private Rect DetailBackRect()
        {
            return new Rect(34f, _dashboardConfig.ShowHeader ? 98f : 24f, 150f, 38f);
        }

        private void DrawHeader()
        {
            DrawSolid(new Rect(20f, 18f, 1880f, 66f), Background);
            DrawSolid(new Rect(20f, 82f, 1880f, 2f), AccentSoft);
            DrawSolid(new Rect(38f, 34f, 8f, 34f), Accent);
            GUI.Label(new Rect(58f, 26f, 490f, 30f), "热处理智能工厂", _brandStyle);
            GUI.Label(new Rect(58f, 55f, 560f, 22f), _factoryName, _mutedStyle);

            var title = _mode == DashboardMode.Detail && _selected != null
                ? $"{InspectionStageLabel(_selected.Inspection?.Stage ?? InspectionStage.Solid)}  /  {_selected.Device.Name}"
                : "全厂设备运行总览";
            GUI.Label(new Rect(630f, 28f, 660f, 38f), title, _headerStyle);

            GUI.Label(
                new Rect(1515f, 27f, 350f, 24f),
                DateTime.Now.ToString("yyyy-MM-dd   HH:mm:ss"),
                _bodyStyle
            );
            DrawStatusPill(new Rect(1515f, 55f, 165f, 22f), $"后台  {FriendlyState(_backendState)}", StateColor(_backendState));
            DrawStatusPill(new Rect(1690f, 55f, 175f, 22f), $"PLC  {FriendlyState(_plcState)}", StateColor(_plcState));
        }

        private void DrawOverview()
        {
            if (_dashboardConfig.Overview.Left.Visible && IsActiveViewComponentVisible("widget_metrics", "metrics")) DrawOverviewLeftPanel();
            if (_dashboardConfig.Overview.Right.Visible && IsActiveViewComponentVisible("widget_line_overview_cards", "line_overview_cards")) DrawOverviewDeviceList();
            if (_dashboardConfig.ShowWorldLabels && IsActiveViewComponentVisible("widget_device_label", "device_label")) DrawWorldLabels();
        }

        private void DrawOverviewLeftPanel()
        {
            var panel = _dashboardConfig.Overview.Left;
            var rect = OverviewLeftRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "全厂运行概况", "OVERVIEW METRICS");

                var total = _devices.Count;
                var online = _devices.Values.Count(IsOnline);
                var running = _devices.Values.Count(IsRunning);
                var alarms = _devices.Values.Count(HasAlarm);
                var x = rect.x + 18f;
                var width = rect.width - 36f;
                var gap = 12f;
                var tileWidth = (width - gap) * 0.5f;

                DrawMetricTile(new Rect(x, rect.y + 68f, tileWidth, 86f), "设备总数", total.ToString(), Accent);
                DrawMetricTile(new Rect(x + tileWidth + gap, rect.y + 68f, tileWidth, 86f), "在线设备", online.ToString(), Good);
                DrawMetricTile(new Rect(x, rect.y + 166f, tileWidth, 86f), "运行设备", running.ToString(), Good);
                DrawMetricTile(new Rect(x + tileWidth + gap, rect.y + 166f, tileWidth, 86f), "报警设备", alarms.ToString(), alarms > 0 ? Bad : Muted);

                GUI.Label(new Rect(x, rect.y + 282f, width, 26f), "设备状态分布", _sectionStyle);
                DrawProgressRow(new Rect(x, rect.y + 320f, width, 34f), "在线率", total == 0 ? 0f : online / (float)total, Good);
                DrawProgressRow(new Rect(x, rect.y + 364f, width, 34f), "运行率", total == 0 ? 0f : running / (float)total, Accent);
                DrawProgressRow(new Rect(x, rect.y + 408f, width, 34f), "报警率", total == 0 ? 0f : alarms / (float)total, alarms > 0 ? Bad : Muted);

                GUI.Label(new Rect(x, rect.y + 470f, width, 26f), "实时数据质量", _sectionStyle);
                var goodPoints = 0;
                var badPoints = 0;
                foreach (var device in _devices.Values)
                {
                    CountPointQuality(device.Frame, ref goodPoints, ref badPoints);
                }
                var qualityTotal = goodPoints + badPoints;
                DrawProgressRow(
                    new Rect(x, rect.y + 508f, width, 34f),
                    "有效点位",
                    qualityTotal == 0 ? 0f : goodPoints / (float)qualityTotal,
                    Good
                );
                DrawInfoRow(new Rect(x, rect.y + 558f, width, 30f), "有效 / 异常", $"{goodPoints} / {badPoints}");
                DrawInfoRow(new Rect(x, rect.y + 596f, width, 30f), "数据源", "现场 MySQL 数据库");
                DrawInfoRow(new Rect(x, rect.y + 634f, width, 30f), "显示模式", "原生三维总览");

                var footerY = rect.yMax - 132f;
                DrawSolid(new Rect(x, footerY, width, 1f), Border);
                GUI.Label(new Rect(x, footerY + 18f, width, 22f), "当前数据与管理后台完全一致", _bodyStyle);
                GUI.Label(new Rect(x, footerY + 48f, width, 52f), "设备位置、名称、模型和点位均直接读取后台配置。", _mutedStyle);
            });
        }

        private void DrawOverviewDeviceList()
        {
            var panel = _dashboardConfig.Overview.Right;
            var rect = OverviewRightRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "设备状态", "CLICK TO OPEN DETAIL");
                var ordered = _devices.Values
                    .OrderBy(device => device.LineName)
                    .ThenBy(device => device.Device.Name)
                    .Take(panel.MaxDevices)
                    .ToList();
                var view = new Rect(rect.x + 14f, rect.y + 62f, rect.width - 28f, rect.height - 82f);
                var contentWidth = Mathf.Max(180f, view.width - 20f);
                var contentHeight = Mathf.Max(view.height - 4f, ordered.Count * 66f + 6f);
                _deviceScroll = GUI.BeginScrollView(
                    view,
                    _deviceScroll,
                    new Rect(0f, 0f, contentWidth, contentHeight),
                    false,
                    contentHeight > view.height
                );
                for (var index = 0; index < ordered.Count; index += 1)
                {
                    var device = ordered[index];
                    var row = new Rect(0f, index * 66f, contentWidth - 4f, 58f);
                    var state = DeviceState(device);
                    var color = DeviceStateColor(device);
                    var stateWidth = Mathf.Min(88f, row.width * 0.32f);
                    var stateX = row.xMax - stateWidth - 10f;
                    var labelWidth = Mathf.Max(80f, stateX - row.x - 24f);
                    DrawSolid(row, PanelSoft);
                    DrawSolid(new Rect(row.x, row.y, 4f, row.height), color);
                    GUI.Label(new Rect(row.x + 14f, row.y + 7f, labelWidth, 23f), device.Device.Name, _bodyStyle);
                    GUI.Label(new Rect(row.x + 14f, row.y + 31f, labelWidth, 18f), device.LineName, _smallStyle);
                    DrawStatusPill(new Rect(stateX, row.y + 9f, stateWidth, 21f), state, color);
                    GUI.Label(new Rect(stateX, row.y + 34f, stateWidth, 18f), OverviewValue(device), _smallStyle);
                    if (GUI.Button(row, GUIContent.none, GUIStyle.none)) ShowDetail(device);
                }
                GUI.EndScrollView();
            });
        }

        private void DrawWorldLabels()
        {
            var leftBoundary = _dashboardConfig.Overview.Left.Visible ? OverviewLeftRect().xMax : 0f;
            var rightBoundary = _dashboardConfig.Overview.Right.Visible ? OverviewRightRect().x : DesignWidth;
            foreach (var device in _devices.Values)
            {
                if (device.Root == null || !device.Root.activeInHierarchy) continue;
                var anchor = device.WorldBounds.center + Vector3.up * (device.WorldBounds.extents.y + 0.65f);
                var screen = _camera.WorldToScreenPoint(anchor);
                if (screen.z <= 0f) continue;
                var design = ScreenPixelToDesign(screen);
                if (design.x < leftBoundary || design.x > rightBoundary || design.y < 12f || design.y > 980f) continue;
                var rect = new Rect(design.x - 74f, design.y - 23f, 148f, 43f);
                var color = DeviceStateColor(device);
                DrawSolid(rect, new Color(0.018f, 0.052f, 0.075f, 0.9f));
                DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
                GUI.Label(new Rect(rect.x + 9f, rect.y + 3f, rect.width - 16f, 20f), device.Device.Name, _centerStyle);
                GUI.Label(new Rect(rect.x + 9f, rect.y + 22f, rect.width - 16f, 17f), OverviewValue(device), _smallStyle);
                if (GUI.Button(rect, GUIContent.none, GUIStyle.none)) ShowDetail(device);
            }
        }

        private void DrawDetail()
        {
            var device = _selected;
            if (IsActiveViewComponentVisible("widget_navigation", "navigation")
                && GUI.Button(DetailBackRect(), "〈 返回上一级", _buttonStyle)) NavigateBack();
            DrawInspectionHint(device);
            DrawInspectionControlsAndLabels(device);
            if (!IsActiveViewComponentVisible("widget_diagnostics", "diagnostics")) return;
            if (_dashboardConfig.Detail.Left.Visible) DrawDetailLeft(device);
            if (_dashboardConfig.Detail.Right.Visible) DrawDetailRight(device);
            if (_dashboardConfig.Detail.Trends.Visible) DrawDetailTrends(device);
        }

        private void DrawInspectionHint(DeviceView device)
        {
            if (device?.Inspection?.Config?.Enabled != true) return;
            var stage = device.Inspection.Stage;
            var selectedPart = device.Inspection.SelectedPart?.Config;
            var text = stage == InspectionStage.Solid
                ? "再次点击设备：查看透明外壳与内部结构"
                : stage == InspectionStage.Xray
                    ? "再次点击设备：移除外壳并拆解关键部件"
                    : stage == InspectionStage.Exploded
                        ? "点击任一关键部件：在右侧查看参数与运行状态"
                        : $"当前部件：{selectedPart?.Name ?? selectedPart?.Id ?? "未选择"}";
            var width = Mathf.Min(620f, Mathf.Max(360f, text.Length * 16f));
            var rect = new Rect((DesignWidth - width) * .5f, _dashboardConfig.ShowHeader ? 98f : 24f, width, 38f);
            DrawSolid(rect, new Color(0.025f, 0.075f, 0.11f, .9f));
            DrawSolid(new Rect(rect.x, rect.yMax - 2f, rect.width, 2f), Accent);
            GUI.Label(rect, text, _centerStyle);
        }

        private void DrawDetailLeft(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Left;
            var rect = DetailLeftRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "设备运行参数", device.Device.Id);
                var x = rect.x + 18f;
                var width = rect.width - 36f;
                var stateColor = DeviceStateColor(device);
                var statusWidth = Mathf.Min(126f, width * 0.44f);
                DrawStatusPill(new Rect(x, rect.y + 60f, statusWidth, 28f), DeviceState(device), stateColor);
                GUI.Label(new Rect(x + statusWidth + 16f, rect.y + 57f, width - statusWidth - 16f, 22f), device.LineName, _bodyStyle);
                GUI.Label(new Rect(x + statusWidth + 16f, rect.y + 80f, width - statusWidth - 16f, 18f), device.Device.ModelType, _smallStyle);

                GUI.Label(new Rect(x, rect.y + 122f, width, 26f), "核心参数", _sectionStyle);
                var rowStart = rect.y + 158f;
                var infoY = rect.yMax - 210f;
                var availableRows = Mathf.Max(1, Mathf.FloorToInt((infoY - rowStart - 8f) / 58f));
                var analog = DetailAnalogPoints(device.Device)
                    .Take(Mathf.Min(panel.MaxPoints, availableRows))
                    .ToList();
                if (analog.Count == 0)
                {
                    GUI.Label(new Rect(x, rowStart + 6f, width, 28f), "此设备未配置模拟量点位", _mutedStyle);
                }
                for (var index = 0; index < analog.Count; index += 1)
                {
                    var point = analog[index];
                    var y = rowStart + index * 58f;
                    DrawSolid(new Rect(x, y, width, 48f), PanelSoft);
                    var valueWidth = Mathf.Min(112f, width * 0.4f);
                    var labelWidth = Mathf.Max(80f, width - valueWidth - 26f);
                    GUI.Label(new Rect(x + 12f, y + 5f, labelWidth, 20f), PointLabel(point), _bodyStyle);
                    GUI.Label(new Rect(x + 12f, y + 26f, labelWidth, 16f), point.PlcTag ?? string.Empty, _smallStyle);
                    var value = FormatPointValue(device, point);
                    LabelWithColor(new Rect(x + width - valueWidth - 12f, y + 8f, valueWidth, 30f), value, _metricStyle, PointQualityColor(device, point));
                }

                DrawSolid(new Rect(x, infoY, width, 1f), Border);
                DrawInfoRow(new Rect(x, infoY + 16f, width, 28f), "模型", device.Device.ModelType);
                DrawInfoRow(new Rect(x, infoY + 50f, width, 28f), "点位数量", (device.Device.DataPoints?.Count ?? 0).ToString());
                DrawInfoRow(new Rect(x, infoY + 84f, width, 28f), "通信状态", IsOnline(device) ? "数据有效" : "通信异常/等待");
            });
        }

        private void DrawDetailRight(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Right;
            var rect = DetailRightRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "状态与联锁", "REALTIME SIGNALS");
                var points = DetailStatusPoints(device.Device).Take(panel.MaxPoints).ToList();
                var view = new Rect(rect.x + 14f, rect.y + 60f, rect.width - 28f, rect.height - 82f);
                var contentWidth = Mathf.Max(180f, view.width - 20f);
                var contentHeight = Mathf.Max(view.height - 4f, points.Count * 48f + 8f);
                _pointScroll = GUI.BeginScrollView(
                    view,
                    _pointScroll,
                    new Rect(0f, 0f, contentWidth, contentHeight),
                    false,
                    contentHeight > view.height
                );
                for (var index = 0; index < points.Count; index += 1)
                {
                    var point = points[index];
                    var row = new Rect(0f, index * 48f, contentWidth - 4f, 42f);
                    var active = PointBool(device, point);
                    var alarm = string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase);
                    var qualityColor = PointQualityColor(device, point);
                    var color = active ? (alarm ? Bad : Good) : qualityColor;
                    var valueWidth = Mathf.Min(82f, row.width * 0.3f);
                    var labelWidth = Mathf.Max(80f, row.width - valueWidth - 42f);
                    DrawSolid(row, PanelSoft);
                    DrawSolid(new Rect(row.x + 8f, row.y + 14f, 10f, 10f), color);
                    GUI.Label(new Rect(row.x + 28f, row.y + 3f, labelWidth, 20f), PointLabel(point), _bodyStyle);
                    GUI.Label(new Rect(row.x + 28f, row.y + 23f, labelWidth, 16f), point.PlcTag ?? point.Category, _smallStyle);
                    var text = FormatPointValue(device, point);
                    LabelWithColor(new Rect(row.xMax - valueWidth - 8f, row.y + 8f, valueWidth, 24f), text, _metricStyle, color);
                }
                if (points.Count == 0)
                {
                    GUI.Label(new Rect(12f, 16f, contentWidth - 24f, 28f), "此设备未配置状态点位", _mutedStyle);
                }
                GUI.EndScrollView();
            });
        }

        private void DrawDetailTrends(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Trends;
            var rect = DetailTrendRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "实时趋势", "进入详情后持续记录当前会话数据");
                var points = TrendPoints(device.Device).Take(panel.MaxCharts).ToList();
                if (points.Count == 0)
                {
                    GUI.Label(new Rect(rect.x + 34f, rect.y + 82f, rect.width - 68f, 30f), "没有可绘制的模拟量点位", _mutedStyle);
                    return;
                }

                var gap = 18f;
                var contentX = rect.x + 34f;
                var contentWidth = rect.width - 68f;
                var width = (contentWidth - gap * (points.Count - 1)) / points.Count;
                var chartHeight = Mathf.Max(74f, rect.height - 76f);
                for (var index = 0; index < points.Count; index += 1)
                {
                    var chart = new Rect(contentX + index * (width + gap), rect.y + 52f, width, chartHeight);
                    var color = index == 0 ? Accent : (index == 1 ? Warning : (index == 2 ? Good : new Color(0.72f, 0.44f, 0.94f)));
                    DrawTrendChart(device, points[index], chart, color);
                }
            });
        }

        private void DrawTrendChart(DeviceView device, DataPointDto point, Rect rect, Color color)
        {
            DrawSolid(rect, new Color(0.016f, 0.044f, 0.066f, 0.84f));
            GUI.Label(new Rect(rect.x + 10f, rect.y + 5f, rect.width - 100f, 20f), PointLabel(point), _bodyStyle);
            LabelWithColor(
                new Rect(rect.x + rect.width - 98f, rect.y + 4f, 88f, 22f),
                FormatPointValue(device, point),
                _metricStyle,
                color
            );
            var plot = new Rect(rect.x + 10f, rect.y + 31f, rect.width - 20f, rect.height - 42f);
            for (var line = 1; line < 4; line += 1)
            {
                DrawSolid(new Rect(plot.x, plot.y + plot.height * line / 4f, plot.width, 1f), new Color(0.18f, 0.31f, 0.39f, 0.35f));
            }
            if (!device.History.TryGetValue(PointKey(point), out var values) || values.Count < 2)
            {
                GUI.Label(plot, "等待有效实时数据", _centerStyle);
                return;
            }
            var minimum = values.Min();
            var maximum = values.Max();
            if (Mathf.Abs(maximum - minimum) < 0.001f)
            {
                minimum -= 0.5f;
                maximum += 0.5f;
            }
            Vector2? previous = null;
            for (var index = 0; index < values.Count; index += 1)
            {
                var x = plot.x + plot.width * index / Mathf.Max(1f, values.Count - 1f);
                var normalized = Mathf.InverseLerp(minimum, maximum, values[index]);
                var y = plot.yMax - normalized * plot.height;
                var current = new Vector2(x, y);
                if (previous.HasValue) DrawLine(previous.Value, current, color, 2f);
                previous = current;
            }
        }

        private void ShowDetail(DeviceView device, ConfiguredView configuredView = null)
        {
            if (device == null || device.Root == null) return;
            if (_selected != null && _selected != device) ResetInspection(_selected, false);
            _selected = device;
            _mode = DashboardMode.Detail;
            _uiBlend = 0f;
            _pointScroll = Vector2.zero;
            ResetInspection(device, false);
            if (device.Inspection == null)
            {
                device.Inspection = new DeviceInspectionRuntime { Config = ResolveInspectionConfig(device.Device) };
                PrepareInspection(device);
            }
            device.Inspection.Stage = InspectionStage.Solid;
            var hideOtherDevices = configuredView == null
                || string.Equals(configuredView.Mode, "device", System.StringComparison.OrdinalIgnoreCase)
                || configuredView.HideNonTargetDevices;
            foreach (var entry in _devices.Values)
            {
                if (entry.Root != null) entry.Root.SetActive(entry == device || !hideOtherDevices);
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
            if (_selected != null) ResetInspection(_selected, false);
            _selected = null;
            _mode = DashboardMode.Overview;
            _uiBlend = immediate ? 1f : 0f;
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
            var ray = _camera.ScreenPointToRay(screenPosition);
            if (_mode == DashboardMode.Detail && _selected != null)
            {
                SelectInspectionTarget(ray);
                return;
            }
            DeviceView closest = null;
            var distance = float.PositiveInfinity;
            foreach (var device in _devices.Values)
            {
                if (device.Root == null || !device.Root.activeInHierarchy) continue;
                if (!device.WorldBounds.IntersectRay(ray, out var hitDistance) || hitDistance >= distance) continue;
                closest = device;
                distance = hitDistance;
            }
            if (closest != null) ShowDetail(closest);
        }

        private DeviceInspectionConfigDto ResolveInspectionConfig(DeviceDto device)
        {
            var asset = _config?.Models?.FirstOrDefault(model => string.Equals(model?.Id, device?.ModelType, StringComparison.OrdinalIgnoreCase));
            return InspectionConfigResolver.Resolve(asset, device);
        }

        private bool IsPointerOverDashboard(Vector2 pointer)
        {
            if (pointer.x < 0f || pointer.y < 0f || pointer.x > DesignWidth || pointer.y > DesignHeight) return true;
            if (_dashboardConfig.ShowHeader && new Rect(20f, 18f, 1880f, 66f).Contains(pointer)) return true;
            if (_mode == DashboardMode.Overview)
            {
                if (_dashboardConfig.Overview.Left.Visible && OverviewLeftRect().Contains(pointer)) return true;
                if (_dashboardConfig.Overview.Right.Visible && OverviewRightRect().Contains(pointer)) return true;
                return false;
            }
            if (DetailBackRect().Contains(pointer) || _inspectionHitRects.Any(rect => rect.Contains(pointer))) return true;
            if (_dashboardConfig.Detail.Left.Visible && DetailLeftRect().Contains(pointer)) return true;
            if (_dashboardConfig.Detail.Right.Visible && DetailRightRect().Contains(pointer)) return true;
            return _dashboardConfig.Detail.Trends.Visible && DetailTrendRect().Contains(pointer);
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

        private static void WithOpacity(float opacity, Action draw)
        {
            var previous = GUI.color;
            GUI.color = new Color(previous.r, previous.g, previous.b, previous.a * Mathf.Clamp01(opacity));
            try
            {
                draw?.Invoke();
            }
            finally
            {
                GUI.color = previous;
            }
        }

        private void DrawPanel(Rect rect, string title, string subtitle)
        {
            DrawSolid(rect, Panel);
            DrawSolid(new Rect(rect.x, rect.y, rect.width, 2f), AccentSoft);
            GUI.Label(new Rect(rect.x + 18f, rect.y + 14f, rect.width - 36f, 26f), title, _sectionStyle);
            GUI.Label(new Rect(rect.x + 18f, rect.y + 39f, rect.width - 36f, 18f), subtitle, _smallStyle);
            DrawSolid(new Rect(rect.x + 18f, rect.y + 61f, rect.width - 36f, 1f), Border);
        }

        private void DrawMetricTile(Rect rect, string label, string value, Color color)
        {
            DrawSolid(rect, PanelStrong);
            DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
            GUI.Label(new Rect(rect.x + 12f, rect.y + 10f, rect.width - 20f, 22f), label, _mutedStyle);
            LabelWithColor(new Rect(rect.x + 12f, rect.y + 34f, rect.width - 20f, 40f), value, _metricValueStyle, color);
        }

        private void DrawProgressRow(Rect rect, string label, float value, Color color)
        {
            value = Mathf.Clamp01(value);
            GUI.Label(new Rect(rect.x, rect.y, 96f, 20f), label, _bodyStyle);
            GUI.Label(new Rect(rect.x + rect.width - 54f, rect.y, 54f, 20f), $"{value * 100f:0}%", _smallStyle);
            DrawSolid(new Rect(rect.x, rect.y + 24f, rect.width, 6f), new Color(0.12f, 0.2f, 0.25f, 0.75f));
            DrawSolid(new Rect(rect.x, rect.y + 24f, rect.width * value, 6f), color);
        }

        private void DrawInfoRow(Rect rect, string label, string value)
        {
            GUI.Label(new Rect(rect.x, rect.y, 116f, rect.height), label, _mutedStyle);
            GUI.Label(new Rect(rect.x + 112f, rect.y, rect.width - 112f, rect.height), value ?? "--", _bodyStyle);
        }

        private void DrawStatusPill(Rect rect, string text, Color color)
        {
            DrawSolid(rect, new Color(color.r * 0.25f, color.g * 0.25f, color.b * 0.25f, 0.94f));
            DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
            LabelWithColor(rect, text, _centerStyle, color);
        }

        private void DrawSolid(Rect rect, Color color)
        {
            if (_whiteTexture == null) return;
            var previous = GUI.color;
            color.a *= previous.a;
            GUI.color = color;
            GUI.DrawTexture(rect, _whiteTexture, ScaleMode.StretchToFill);
            GUI.color = previous;
        }

        private void DrawLine(Vector2 start, Vector2 end, Color color, float thickness)
        {
            var delta = end - start;
            if (delta.sqrMagnitude < 0.01f) return;
            var previousMatrix = GUI.matrix;
            var previousColor = GUI.color;
            var angle = Mathf.Atan2(delta.y, delta.x) * Mathf.Rad2Deg;
            GUIUtility.RotateAroundPivot(angle, start);
            color.a *= previousColor.a;
            GUI.color = color;
            GUI.DrawTexture(new Rect(start.x, start.y - thickness * 0.5f, delta.magnitude, thickness), _whiteTexture);
            GUI.matrix = previousMatrix;
            GUI.color = previousColor;
        }

        private static void LabelWithColor(Rect rect, string text, GUIStyle style, Color color)
        {
            var previous = style.normal.textColor;
            style.normal.textColor = color;
            GUI.Label(rect, text, style);
            style.normal.textColor = previous;
        }

        private void EnsureStyles()
        {
            if (_whiteTexture != null) return;
            _whiteTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false) { name = "Dashboard Solid Texture" };
            _whiteTexture.SetPixel(0, 0, Color.white);
            _whiteTexture.Apply();
            _buttonTexture = CreateSolidTexture("Dashboard Button", PanelStrong);
            _buttonHoverTexture = CreateSolidTexture("Dashboard Button Hover", new Color(0.055f, 0.16f, 0.22f, 0.98f));
            _buttonActiveTexture = CreateSolidTexture("Dashboard Button Active", AccentSoft);
            _font = Font.CreateDynamicFontFromOSFont(
                new[] { "Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "Arial" },
                18
            );

            _brandStyle = CreateStyle(24, FontStyle.Bold, Text, TextAnchor.UpperLeft);
            _headerStyle = CreateStyle(30, FontStyle.Bold, Text, TextAnchor.MiddleCenter);
            _sectionStyle = CreateStyle(18, FontStyle.Bold, Text, TextAnchor.MiddleLeft);
            _bodyStyle = CreateStyle(15, FontStyle.Normal, Text, TextAnchor.MiddleLeft);
            _mutedStyle = CreateStyle(13, FontStyle.Normal, Muted, TextAnchor.MiddleLeft);
            _smallStyle = CreateStyle(12, FontStyle.Normal, Muted, TextAnchor.MiddleCenter);
            _metricStyle = CreateStyle(17, FontStyle.Bold, Accent, TextAnchor.MiddleRight);
            _metricValueStyle = CreateStyle(30, FontStyle.Bold, Accent, TextAnchor.MiddleLeft);
            _centerStyle = CreateStyle(13, FontStyle.Normal, Text, TextAnchor.MiddleCenter);
            _buttonStyle = CreateStyle(15, FontStyle.Bold, Text, TextAnchor.MiddleCenter);
            _buttonStyle.normal.background = _buttonTexture;
            _buttonStyle.normal.textColor = Text;
            _buttonStyle.hover.background = _buttonHoverTexture;
            _buttonStyle.hover.textColor = Color.white;
            _buttonStyle.active.background = _buttonActiveTexture;
            _buttonStyle.active.textColor = Color.white;
            _buttonStyle.padding = new RectOffset(12, 12, 7, 7);
        }

        private static Texture2D CreateSolidTexture(string name, Color color)
        {
            var texture = new Texture2D(1, 1, TextureFormat.RGBA32, false) { name = name };
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }

        private GUIStyle CreateStyle(int fontSize, FontStyle fontStyle, Color color, TextAnchor alignment)
        {
            return new GUIStyle(GUI.skin.label)
            {
                font = _font,
                fontSize = fontSize,
                fontStyle = fontStyle,
                alignment = alignment,
                clipping = TextClipping.Clip,
                wordWrap = false,
                normal = { textColor = color }
            };
        }

        private void OnDestroy()
        {
            ClearFactory();
            if (_whiteTexture != null) Destroy(_whiteTexture);
            if (_buttonTexture != null) Destroy(_buttonTexture);
            if (_buttonHoverTexture != null) Destroy(_buttonHoverTexture);
            if (_buttonActiveTexture != null) Destroy(_buttonActiveTexture);
            if (_font != null) Destroy(_font);
        }
    }
}
