using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Core;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Process = System.Diagnostics.Process;
using ProcessStartInfo = System.Diagnostics.ProcessStartInfo;
using ProcessWindowStyle = System.Diagnostics.ProcessWindowStyle;

namespace HeatTreatment.DigitalTwin.Runtime
{
    [DefaultExecutionOrder(-500)]
    public sealed class FactoryRuntime : MonoBehaviour
    {
        private sealed class DevicePlacement
        {
            public DeviceDto Device;
            public Transform Parent;
            public string WorkshopId;
            public string LineId;
        }

        private static FactoryRuntime _instance;
        private readonly Dictionary<string, ModelBindingDriver> _drivers = new Dictionary<string, ModelBindingDriver>();
        private readonly Dictionary<string, DeviceStatusVisual> _visuals = new Dictionary<string, DeviceStatusVisual>();
        private readonly Dictionary<string, MobileDeviceMotion> _motions = new Dictionary<string, MobileDeviceMotion>();
        private readonly Dictionary<string, JObject> _latestDeviceFrames = new Dictionary<string, JObject>();
        private readonly Dictionary<string, Transform> _deviceRoots = new Dictionary<string, Transform>();
        private readonly Dictionary<string, Transform> _workshopRoots = new Dictionary<string, Transform>();
        private readonly Dictionary<string, Transform> _lineRoots = new Dictionary<string, Transform>();
        private readonly Dictionary<string, string> _deviceModelTypes = new Dictionary<string, string>();
        private readonly Dictionary<string, string> _deviceLineIds = new Dictionary<string, string>();
        private readonly Dictionary<string, string> _deviceWorkshopIds = new Dictionary<string, string>();
        private readonly Dictionary<string, int> _previewModelVersions = new Dictionary<string, int>();
        private readonly Dictionary<string, long> _previewSessionSequences = new Dictionary<string, long>();
        private readonly ConcurrentQueue<string> _nativeAuthCommands = new ConcurrentQueue<string>();

        private NativeClientSettings _settings;
        private BackendApiClient _api;
        private RealtimeWebSocketClient _webSocket;
        private RuntimeModelLibrary _modelLibrary;
        private NativeQualityController _quality;
        private FactoryEnvironmentBuilder _environment;
        private RuntimeDiagnosticsOverlay _diagnostics;
        private FactoryDashboardController _dashboard;
        private NativeWindowMenu _windowMenu;
        private FactoryConfigDto _config;
        private CancellationTokenSource _lifetime;
        private CancellationTokenSource _reload;
        private Thread _nativeAuthPipeThread;
        private CancellationToken _nativeAuthPipeToken;
        private bool _nativeAuthPipeFailureReported;
        private JObject _lastDashboardContext = new JObject
        {
            ["viewId"] = "factory_overview",
            ["sceneReady"] = false,
            ["viewMode"] = "factory",
            ["sceneId"] = string.Empty,
            ["workshopId"] = string.Empty,
            ["lineId"] = string.Empty,
            ["deviceId"] = string.Empty
        };
        private Transform _factoryRoot;
        private Camera _camera;
        private OrbitCameraController _orbit;
        private bool _sceneReady;
        private bool _authenticated;
        private bool _loginInProgress;
        private int _authGeneration;
        private int _lastBackNavigationFrame = -1;
        private float _lastBackNavigationAt = float.NegativeInfinity;
        private const float BackNavigationDebounceSeconds = 0.18f;
        private bool _sceneProjectionRequested;
        private readonly string _sceneProjectionStreamId = Guid.NewGuid().ToString("N");
        private long _sceneProjectionSequence;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void EnsureRuntimeExists()
        {
            if (FindObjectOfType<FactoryRuntime>() != null) return;
            new GameObject("DigitalTwinRuntime").AddComponent<FactoryRuntime>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            Application.runInBackground = true;
            _lifetime = new CancellationTokenSource();
            _settings = NativeClientSettings.Load();
            _api = new BackendApiClient(_settings.backendHttpUrl);

            _windowMenu = GetOrAdd<NativeWindowMenu>();
            _windowMenu.Configure(_settings.maximizeWindowOnStart);
            _windowMenu.SettingsRequested += OpenAdminSettings;

            _environment = GetOrAdd<FactoryEnvironmentBuilder>();
            _camera = _environment.EnsureCamera();
            _orbit = _camera.GetComponent<OrbitCameraController>();
            _environment.BuildLightingAndPostProcessing();

            _quality = GetOrAdd<NativeQualityController>();
            _quality.Configure(_settings);

            _diagnostics = GetOrAdd<RuntimeDiagnosticsOverlay>();
            _diagnostics.Visible = _settings.showDiagnostics;
            _diagnostics.QualityController = _quality;
            _diagnostics.BeginLoading();

            _dashboard = GetOrAdd<FactoryDashboardController>();
            _dashboard.Initialize(
                _camera,
                _camera.GetComponent<OrbitCameraController>(),
                _diagnostics
            );
            _dashboard.ViewContextChanged += OnDashboardViewContextChanged;
            _dashboard.InspectionContextChanged += OnInspectionContextChanged;
            _dashboard.ParentNavigationRequested += NavigateToParentCamera;

            _modelLibrary = GetOrAdd<RuntimeModelLibrary>();
            _webSocket = GetOrAdd<RealtimeWebSocketClient>();
            _webSocket.MessageReceived += OnRealtimeMessage;
            _webSocket.ConnectionStateChanged += OnConnectionStateChanged;
        }

        private void Start()
        {
            _nativeAuthPipeToken = _lifetime.Token;
            _nativeAuthPipeThread = new Thread(ListenForNativeAuthCommands)
            {
                IsBackground = true,
                Name = "DigitalTwinNativeAuthPipe"
            };
            _nativeAuthPipeThread.Start();
            _diagnostics.RequireAuthentication();
            StartCoroutine(StartApplicationChromeCoroutine());
            StartCoroutine(StreamSceneProjection());
        }

        private void ListenForNativeAuthCommands()
        {
            var pipeName = $"HeatTreatmentUnityAuth_{Process.GetCurrentProcess().Id}";
            var currentUser = $"{Environment.UserDomainName}\\{Environment.UserName}";
            while (!_nativeAuthPipeToken.IsCancellationRequested)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(
                        pipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None))
                    {
                        server.WaitForConnection();
                        using (var reader = new StreamReader(server, Encoding.UTF8))
                        {
                            var message = reader.ReadLine();
                            if (string.IsNullOrWhiteSpace(message) || message.Length > 4096) continue;
                            var clientUser = server.GetImpersonationUserName();
                            if (!string.Equals(clientUser, Environment.UserName, StringComparison.OrdinalIgnoreCase)
                                && !string.Equals(clientUser, currentUser, StringComparison.OrdinalIgnoreCase))
                            {
                                if (!_nativeAuthPipeFailureReported)
                                {
                                    _nativeAuthPipeFailureReported = true;
                                    _nativeAuthCommands.Enqueue(new JObject
                                    {
                                        ["action"] = "pipe_error",
                                        ["message"] = $"命名管道客户端身份不匹配（{clientUser} / {currentUser}）"
                                    }.ToString(Formatting.None));
                                }
                                continue;
                            }
                            _nativeAuthCommands.Enqueue(message);
                        }
                    }
                }
                catch (Exception exception)
                {
                    if (_nativeAuthPipeToken.IsCancellationRequested) break;
                    if (!_nativeAuthPipeFailureReported)
                    {
                        _nativeAuthPipeFailureReported = true;
                        _nativeAuthCommands.Enqueue(new JObject
                        {
                            ["action"] = "pipe_error",
                            ["message"] = ShortMessage(exception.Message)
                        }.ToString(Formatting.None));
                    }
                    Thread.Sleep(250);
                }
            }
        }

        private void HandleNativeAuthCommand(string message)
        {
            try
            {
                var command = JObject.Parse(message);
                var action = command.Value<string>("action");
                if (action == "pipe_error")
                {
                    Debug.LogWarning($"[FactoryRuntime] Native auth handoff pipe unavailable: {ShortMessage(command.Value<string>("message"))}");
                    return;
                }
                if (action == "clear_unity_session")
                {
                    ClearNativeSession("后台会话已锁定，请重新登录。");
                    return;
                }
                if (action != "sync_unity_session") return;
                var ticket = command.Value<string>("ticket");
                if (string.IsNullOrEmpty(ticket) || ticket.Length != 64 || ticket.Any(character => !Uri.IsHexDigit(character))) return;
                Debug.Log("[FactoryRuntime] Native dashboard session handoff received.");
                _ = AuthenticateNativeTicketAsync(ticket);
            }
            catch
            {
                // Named-pipe messages are advisory; malformed payloads never affect the runtime.
            }
        }

        private async Task AuthenticateNativeTicketAsync(string ticket)
        {
            if (_loginInProgress || _api == null || _diagnostics == null) return;
            _loginInProgress = true;
            var generation = ++_authGeneration;
            _diagnostics.SetLoginBusy(true);
            try
            {
                var session = await _api.ExchangeNativeTicketAsync(ticket, _lifetime.Token);
                if (generation != _authGeneration) return;
                ActivateAuthenticatedSession(session);
            }
            catch (Exception exception)
            {
                if (generation != _authGeneration) return;
                _authenticated = false;
                _api.ClearSession();
                var message = exception is BackendRequestException requestException && requestException.StatusCode == 403
                    ? requestException.Message
                    : ShortMessage(exception.Message);
                _diagnostics.SetLoginError(message);
                Debug.LogWarning($"[FactoryRuntime] Shared dashboard login failed: {message}");
            }
            finally
            {
                if (generation == _authGeneration)
                {
                    _loginInProgress = false;
                    _diagnostics.SetLoginBusy(false);
                }
            }
        }

        private void ClearNativeSession(string message)
        {
            _authGeneration++;
            _loginInProgress = false;
            _authenticated = false;
            _reload?.Cancel();
            _reload?.Dispose();
            _reload = null;
            _api?.ClearSession();
            _webSocket?.StopClient();
            DestroyCurrentFactory();
            _sceneReady = false;
            _diagnostics?.SetLoginBusy(false);
            _diagnostics?.RequireAuthentication(message);
        }

        private static JArray ProjectionVector(Vector3 value) => new JArray(value.x, value.y, value.z);

        private IEnumerator StreamSceneProjection()
        {
            var endOfFrame = new WaitForEndOfFrame();
            var nextFrameAt = 0f;
            while (true)
            {
                // OrbitCameraController and mobile equipment update later than
                // this runtime. Capture AFTER all LateUpdate transforms.
                yield return endOfFrame;
                if (Time.unscaledTime < nextFrameAt) continue;
                nextFrameAt = Time.unscaledTime + 0.1f;
                if (!_sceneProjectionRequested || !_sceneReady || _camera == null
                    || _camera.orthographic || _webSocket?.IsConnected != true) continue;

                var devices = new JArray();
                foreach (var pair in _deviceRoots)
                {
                    if (devices.Count >= 500) break;
                    var root = pair.Value;
                    if (root == null) continue;
                    var matrix = root.localToWorldMatrix;
                    var elements = new JArray();
                    for (var column = 0; column < 4; column++)
                        for (var row = 0; row < 4; row++) elements.Add(matrix[row, column]);
                    var renderers = root.GetComponentsInChildren<Renderer>()
                        .Where(renderer => renderer.enabled && renderer.gameObject.activeInHierarchy).ToArray();
                    var bounds = renderers.Length > 0 ? renderers[0].bounds : new Bounds(root.position, Vector3.zero);
                    for (var index = 1; index < renderers.Length; index++) bounds.Encapsulate(renderers[index].bounds);
                    var anchor = bounds.center;
                    anchor.y = bounds.max.y + Mathf.Max(0.5f, bounds.size.y * 0.08f);
                    devices.Add(new JObject
                    {
                        ["id"] = pair.Key, ["matrix"] = elements,
                        ["anchor"] = ProjectionVector(anchor), ["visible"] = renderers.Length > 0
                    });
                }
                _webSocket.SendTransientMessage(new JObject
                {
                    ["type"] = "scene_projection",
                    ["payload"] = new JObject
                    {
                        ["version"] = 1, ["streamId"] = _sceneProjectionStreamId,
                        ["seq"] = ++_sceneProjectionSequence, ["sceneReady"] = true,
                        ["sceneId"] = _lastDashboardContext.Value<string>("sceneId") ?? string.Empty,
                        ["viewId"] = _dashboard?.ActiveViewId ?? "factory_overview",
                        ["inspectionStage"] = _lastDashboardContext.Value<string>("inspectionStage") ?? string.Empty,
                        ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        ["camera"] = new JObject
                        {
                            ["position"] = ProjectionVector(_camera.transform.position),
                            ["forward"] = ProjectionVector(_camera.transform.forward),
                            ["up"] = ProjectionVector(_camera.transform.up),
                            ["target"] = ProjectionVector(_orbit != null ? _orbit.Target : _camera.transform.position + _camera.transform.forward),
                            ["fov"] = _camera.fieldOfView, ["aspect"] = _camera.aspect,
                            ["near"] = _camera.nearClipPlane, ["far"] = _camera.farClipPlane
                        },
                        ["devices"] = devices
                    }
                });
            }
        }

        private void Update()
        {
            while (_nativeAuthCommands.TryDequeue(out var nativeAuthCommand))
                HandleNativeAuthCommand(nativeAuthCommand);
            if (Input.GetKeyDown(KeyCode.F5) && _authenticated) BeginReload();
            if (Input.GetKeyDown(KeyCode.Escape) || Input.GetKeyDown(KeyCode.Backspace))
            {
                RequestDashboardBack("Update");
            }
        }

        /// <summary>
        /// Unity's legacy input polling can miss a key when a native child
        /// window has focus. OnGUI receives the player event path as a second
        /// fallback; the frame guard makes Update and OnGUI idempotent.
        /// </summary>
        private void OnGUI()
        {
            var current = Event.current;
            if (current == null || current.type != EventType.KeyDown) return;
            if (current.keyCode != KeyCode.Escape && current.keyCode != KeyCode.Backspace) return;
            current.Use();
            RequestDashboardBack("OnGUI");
        }

        private void RequestDashboardBack(string source)
        {
            if (!TryBeginBackNavigation(_dashboard?.ActiveViewId, source)) return;
            Debug.Log($"[FactoryRuntime] Keyboard back requested from {source} at view={_dashboard?.ActiveViewId ?? string.Empty}");
            _dashboard?.NavigateBack();
        }

        private bool TryBeginBackNavigation(string expectedViewId, string source)
        {
            if (_lastBackNavigationFrame == Time.frameCount) return false;
            if (Time.unscaledTime - _lastBackNavigationAt < BackNavigationDebounceSeconds) return false;
            if (!string.IsNullOrWhiteSpace(expectedViewId)
                && !string.Equals(expectedViewId, _dashboard?.ActiveViewId, StringComparison.OrdinalIgnoreCase))
            {
                _diagnostics.Activity = $"Ignored stale back request ({source})";
                return false;
            }
            _lastBackNavigationFrame = Time.frameCount;
            _lastBackNavigationAt = Time.unscaledTime;
            return true;
        }

        private void BeginReload()
        {
            if (!_authenticated)
            {
                _diagnostics?.RequireAuthentication();
                return;
            }
            _reload?.Cancel();
            _reload?.Dispose();
            _reload = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
            _diagnostics?.BeginLoading();
            _sceneReady = false;
            if (_webSocket != null) PublishDashboardContext("factory", viewId: "factory_overview");
            DestroyCurrentFactory();
            _ = LoadConfigurationLoopAsync(_reload.Token);
        }

        private async Task LoadConfigurationLoopAsync(CancellationToken cancellationToken)
        {
            var retry = Mathf.Max(1f, _settings.configurationRetrySeconds);
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    _diagnostics.UpdateLoading(0.05f, "正在读取现场配置");
                    _diagnostics.Activity = "Reading factory configuration";
                    var config = await _api.GetFactoryConfigAsync(cancellationToken);
                    await BuildFactoryAsync(config, cancellationToken);
                    return;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (BackendRequestException exception) when (exception.StatusCode == 401 || exception.StatusCode == 403)
                {
                    _authenticated = false;
                    _api.ClearSession();
                    _webSocket.StopClient();
                    DestroyCurrentFactory();
                    _sceneReady = false;
                    var message = exception.StatusCode == 403
                        ? "当前账户没有查看大屏的权限，请联系管理员授权。"
                        : "登录状态已失效，请重新登录。";
                    _diagnostics.RequireAuthentication(message);
                    Debug.LogWarning($"[FactoryRuntime] Native dashboard authorization ended: {exception.Code}");
                    return;
                }
                catch (Exception exception)
                {
                    _diagnostics.BackendState = "configuration offline";
                    var reason = ShortMessage(exception.Message);
                    _diagnostics.UpdateLoading(0.08f, "现场服务暂不可用，正在重试…", reason);
                    _diagnostics.Activity = $"Config retry in {retry:0}s: {reason}";
                    Debug.LogWarning($"[StartupWarning] 8|现场配置读取失败：{reason}");
                    Debug.LogWarning($"[FactoryRuntime] Configuration unavailable: {exception.Message}");
                    try { await Task.Delay(TimeSpan.FromSeconds(retry), cancellationToken); }
                    catch (OperationCanceledException) { return; }
                }
            }
        }

        private void ActivateAuthenticatedSession(NativeLoginResult session)
        {
            if (session == null || !session.Authenticated)
                throw new InvalidOperationException("后台没有建立有效登录会话，请重试。");
            if (!session.CanLaunch)
                throw new BackendRequestException(403, "ADMIN_PERMISSION_DENIED", "当前账户没有启动实时大屏的权限，请联系管理员授权。");
            if (!session.CanView)
                throw new BackendRequestException(403, "ADMIN_PERMISSION_DENIED", "当前账户没有查看大屏的权限，请联系管理员授权。");

            _authenticated = true;
            _diagnostics.BackendState = "authenticated";
            try
            {
                _api.ScopeSessionForWebSocket(_settings.backendWebSocketUrl);
                _webSocket.StartClient(_settings.backendWebSocketUrl, _settings.autoReconnectSeconds, _api.SessionCookies);
            }
            catch (Exception exception)
            {
                _diagnostics.BackendState = "realtime connection unavailable";
                Debug.LogWarning($"[StartupWarning] 2|实时数据连接初始化失败：{ShortMessage(exception.Message)}");
            }
            BeginReload();
        }

        private async Task BuildFactoryAsync(FactoryConfigDto config, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _diagnostics.UpdateLoading(0.18f, "正在构建设备层级");
            DestroyCurrentFactory();
            _config = config;
            var root = new GameObject("RuntimeFactory");
            root.transform.SetParent(transform, false);
            _factoryRoot = root.transform;
            _dashboard.BeginFactory(config);

            ApplyBackendQuality(config.Settings);
            _environment.ApplySettings(config.Settings);

            var placements = CreateHierarchy(config, _factoryRoot);
            var devices = placements.Select(placement => placement.Device).ToList();
            _diagnostics.DeviceCount = devices.Count;
            _diagnostics.ReadyDeviceCount = 0;
            _diagnostics.FallbackDeviceCount = 0;
            _diagnostics.BackendState = "configuration online";
            _environment.RebuildFactoryFloor(config, devices);
            await _environment.HallReady;
            cancellationToken.ThrowIfCancellationRequested();
            _diagnostics.UpdateLoading(0.32f, "正在准备三维场景");
            _modelLibrary.Configure(_settings.backendHttpUrl, config.Models, _settings.modelLoadTimeoutSeconds);

            var totalPlacements = Mathf.Max(1, placements.Count);
            var loadedPlacements = 0;
            foreach (var placement in placements)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var device = placement.Device;
                _diagnostics.Activity = $"Loading {device.Name ?? device.Id}";
                var instance = await _modelLibrary.InstantiateAsync(device, placement.Parent, cancellationToken);
                if (cancellationToken.IsCancellationRequested)
                {
                    if (instance.Root != null) Destroy(instance.Root);
                    cancellationToken.ThrowIfCancellationRequested();
                }
                var driver = instance.Root.GetComponent<ModelBindingDriver>();
                var visual = instance.Root.AddComponent<DeviceStatusVisual>();
                visual.Initialize(device);
                var motion = instance.Root.AddComponent<MobileDeviceMotion>();
                motion.Initialize(device);
                _dashboard.RegisterDevice(device, instance.Root, instance.Inspection);
                if (!string.IsNullOrWhiteSpace(device.Id))
                {
                    _drivers[device.Id] = driver;
                    _visuals[device.Id] = visual;
                    _motions[device.Id] = motion;
                    _deviceRoots[device.Id] = instance.Root.transform;
                    _deviceModelTypes[device.Id] = device.ModelType ?? string.Empty;
                    _deviceLineIds[device.Id] = placement.LineId ?? device.LineId ?? string.Empty;
                    _deviceWorkshopIds[device.Id] = placement.WorkshopId ?? string.Empty;
                    if (_latestDeviceFrames.TryGetValue(device.Id, out var latest))
                    {
                        driver.ApplyRealtime(latest);
                        visual.ApplyRealtime(latest);
                        motion.ApplyRealtime(latest);
                        _dashboard.ApplyRealtime(device.Id, latest);
                    }
                }
                _diagnostics.ReadyDeviceCount += 1;
                if (instance.IsFallback)
                {
                    _diagnostics.FallbackDeviceCount += 1;
                    _diagnostics.ReportModelError(device.Name ?? device.Id, device.ModelType, instance.LoadError);
                }
                _diagnostics.TemplateCount = _modelLibrary.LoadedTemplateCount;
                loadedPlacements += 1;
                _diagnostics.UpdateLoading(0.32f + 0.55f * loadedPlacements / totalPlacements, $"正在加载设备模型（{loadedPlacements}/{totalPlacements}）");
                await Task.Yield();
            }

            cancellationToken.ThrowIfCancellationRequested();
            var bounds = CalculateFactoryOverviewBounds();
            _sceneReady = true;
            NormalizeFactoryOverviewViewForEnvironment("factory_overview", "factory");
            _dashboard.CompleteFactory(bounds);
            _environment.RefreshReflectionProbe();
            _diagnostics.UpdateLoading(.96f, "正在连接实时数据");
            _diagnostics.CompleteLoading();
            _diagnostics.Activity = _diagnostics.FallbackDeviceCount == 0
                ? "Native factory ready"
                : "Factory ready; one or more model files used fallback geometry";
            Debug.Log(
                $"[FactoryRuntime] {_diagnostics.Activity}: devices={_diagnostics.ReadyDeviceCount}, "
                + $"fallback={_diagnostics.FallbackDeviceCount}, templates={_diagnostics.TemplateCount}"
            );
        }

        private List<DevicePlacement> CreateHierarchy(FactoryConfigDto config, Transform root)
        {
            var result = new List<DevicePlacement>();
            foreach (var workshop in config.Workshops ?? new List<WorkshopDto>())
            {
                var workshopRoot = new GameObject(string.IsNullOrWhiteSpace(workshop.Name) ? workshop.Id : workshop.Name);
                workshopRoot.transform.SetParent(root, false);
                ApplySpatialTransform(workshopRoot.transform, workshop.LayoutObject);
                if (!string.IsNullOrWhiteSpace(workshop.Id)) _workshopRoots[workshop.Id] = workshopRoot.transform;
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    var lineRoot = new GameObject(string.IsNullOrWhiteSpace(line.Name) ? line.Id : line.Name);
                    lineRoot.transform.SetParent(workshopRoot.transform, false);
                    ApplySpatialTransform(lineRoot.transform, line.LayoutObject);
                    if (!string.IsNullOrWhiteSpace(line.Id)) _lineRoots[line.Id] = lineRoot.transform;
                    foreach (var device in line.Devices ?? new List<DeviceDto>())
                    {
                        result.Add(new DevicePlacement
                        {
                            Device = device,
                            Parent = lineRoot.transform,
                            WorkshopId = workshop.Id,
                            LineId = line.Id
                        });
                    }
                }
                foreach (var device in workshop.Devices ?? new List<DeviceDto>())
                {
                    var configuredLineId = ResolveDeviceLineId(device);
                    result.Add(new DevicePlacement
                    {
                        Device = device,
                        Parent = !string.IsNullOrWhiteSpace(configuredLineId)
                            && _lineRoots.TryGetValue(configuredLineId, out var configuredLineRoot)
                                ? configuredLineRoot
                                : workshopRoot.transform,
                        WorkshopId = workshop.Id,
                        LineId = configuredLineId
                    });
                }
            }
            return result;
        }

        private static void ApplySpatialTransform(Transform target, JObject layout)
        {
            if (target == null) return;
            var transformConfig = layout?["transform"] as JObject;
            if (transformConfig == null)
            {
                target.localPosition = Vector3.zero;
                target.localRotation = Quaternion.identity;
                return;
            }
            var x = transformConfig.Value<float?>("x") ?? 0f;
            var y = transformConfig.Value<float?>("y") ?? 0f;
            var z = transformConfig.Value<float?>("z") ?? 0f;
            var rotationY = transformConfig.Value<float?>("rotationY")
                ?? transformConfig.Value<float?>("rotation_y")
                ?? 0f;
            target.localPosition = new Vector3(x, y, z);
            target.localRotation = Quaternion.Euler(0f, -rotationY, 0f);
        }

        private static string ResolveDeviceLineId(DeviceDto device)
        {
            if (device == null) return string.Empty;
            if (!string.IsNullOrWhiteSpace(device.LineId)) return device.LineId;
            var config = device.InstanceConfigObject;
            return config.Value<string>("railLineId")
                ?? config.Value<string>("laneLineId")
                ?? string.Empty;
        }

        private void OnRealtimeMessage(JObject message)
        {
            var type = message.Value<string>("type");
            if (type == "realtime_frame")
            {
                var payload = message["payload"] as JObject;
                var devices = payload?["devices"] as JArray;
                if (devices == null) return;
                foreach (var token in devices)
                {
                    if (!(token is JObject deviceData)) continue;
                    var id = deviceData.Value<string>("furnace_id");
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    _latestDeviceFrames[id] = deviceData;
                    if (_drivers.TryGetValue(id, out var driver)) driver.ApplyRealtime(deviceData);
                    if (_visuals.TryGetValue(id, out var visual)) visual.ApplyRealtime(deviceData);
                    if (_motions.TryGetValue(id, out var motion)) motion.ApplyRealtime(deviceData);
                    _dashboard.ApplyRealtime(id, deviceData);
                }
                _diagnostics.RecordRealtimeFrame(payload.Value<long?>("timestamp") ?? 0L, devices.Count);
            }
            else if (type == "plc_status")
            {
                var payload = message["payload"] as JObject;
                _diagnostics.PlcState = payload?.Value<string>("status")
                    ?? payload?.Value<string>("message")
                    ?? "updated";
                _dashboard.PlcState = _diagnostics.PlcState;
            }
            else if (type == "configuration_changed")
            {
                ApplyLiveSettings(message["payload"] as JObject);
            }
            else if (type == "device_configuration_changed")
            {
                ApplyLiveDeviceConfiguration(message["payload"] as JObject);
            }
            else if (type == "model_metadata_changed")
            {
                var modelId = message["payload"]?.Value<string>("modelId") ?? string.Empty;
                _diagnostics.Activity = string.IsNullOrWhiteSpace(modelId)
                    ? "Model metadata changed; reloading"
                    : $"Model metadata changed ({modelId}); reloading";
                Debug.Log($"[FactoryRuntime] {_diagnostics.Activity}");
                BeginReload();
            }
            else if (type == "native_scene_preview")
            {
                ApplyNativeScenePreview(message["payload"] as JObject);
            }
            else if (type == "scene_projection_subscription")
            {
                _sceneProjectionRequested = message["payload"]?.Value<bool?>("enabled") == true;
            }
            else if (type == "dashboard_release_changed")
            {
                _diagnostics.Activity = "Published dashboard version changed; reloading";
                BeginReload();
            }
        }

        private async void ApplyNativeScenePreview(JObject payload)
        {
            if (payload == null || _config == null || _factoryRoot == null) return;
            var sessionId = payload.Value<string>("sessionId") ?? "admin";
            var sequence = payload.Value<long?>("sequence") ?? 0L;
            if (_previewSessionSequences.TryGetValue(sessionId, out var previous) && sequence > 0 && sequence <= previous)
            {
                return;
            }
            if (sequence > 0) _previewSessionSequences[sessionId] = sequence;

            var action = payload.Value<string>("action") ?? "apply";
            if (string.Equals(action, "reload", StringComparison.OrdinalIgnoreCase))
            {
                _diagnostics.Activity = "Reloading saved Unity layout";
                BeginReload();
                return;
            }

            if (string.Equals(action, "camera", StringComparison.OrdinalIgnoreCase))
            {
                ApplyPreviewCameraAction(payload);
                return;
            }

            if (string.Equals(action, "inspection_back", StringComparison.OrdinalIgnoreCase))
            {
                var expectedViewId = payload.Value<string>("viewId");
                // Escape can arrive through Unity's input loop and the WebView
                // bridge for the same physical key. Use the same frame/time
                // gate for both paths so one key moves exactly one level.
                if (!TryBeginBackNavigation(expectedViewId, "WebView")) return;
                _dashboard.NavigateBack();
                _diagnostics.Activity = "Inspection level returned";
                return;
            }

            if (string.Equals(action, "inspection", StringComparison.Ordinal))
            {
                var deviceId = payload["focus"]?.Value<string>("deviceId");
                var applied = _dashboard.ApplyInspectionCommand(deviceId, payload["inspection"] as JObject, out var error);
                _diagnostics.Activity = applied ? "Inspection view updated" : $"Inspection command rejected: {error}";
                if (!applied) Debug.LogWarning($"[FactoryRuntime] {_diagnostics.Activity}");
                return;
            }

            if (string.Equals(action, "inspection_preview", StringComparison.Ordinal))
            {
                // Only the protected engineer-preview endpoint broadcasts this action.
                // It is intentionally memory-only; reset/reload replaces it from metadata.
                var deviceId = payload["focus"]?.Value<string>("deviceId");
                var applied = _dashboard.ApplyInspectionPreview(deviceId, payload["inspectionConfig"] as JObject, out var error);
                _diagnostics.Activity = applied ? "Unsaved inspection configuration previewed" : $"Inspection preview rejected: {error}";
                if (!applied) Debug.LogWarning($"[FactoryRuntime] {_diagnostics.Activity}");
                return;
            }

            if (string.Equals(action, "focus", StringComparison.OrdinalIgnoreCase))
            {
                var focusBounds = CalculateFactoryOverviewBounds();
                ApplyPreviewFocus(payload["focus"] as JObject, focusBounds, payload.Value<string>("viewId"));
                _diagnostics.Activity = "Dashboard focus action applied";
                return;
            }

            if (string.Equals(action, "view", StringComparison.OrdinalIgnoreCase))
            {
                _dashboard.ApplyTransientView(payload["view"] as JObject);
                var focusBounds = CalculateFactoryOverviewBounds();
                ApplyPreviewFocus(payload["focus"] as JObject, focusBounds, payload.Value<string>("viewId"));
                _diagnostics.Activity = "Dashboard focus action applied";
                return;
            }

            var reset = string.Equals(action, "reset", StringComparison.OrdinalIgnoreCase);
            var devices = reset
                ? EnumerateConfigDevices(_config).ToList()
                : payload["devices"]?.ToObject<List<DeviceDto>>() ?? new List<DeviceDto>();
            if (devices.Count == 0) devices = EnumerateConfigDevices(_config).ToList();

            var includeLayout = reset || payload.Value<bool?>("includeLayout") == true;
            var previewConfig = includeLayout
                ? (reset ? _config : BuildPreviewConfig(payload["workshops"] as JArray, payload["lines"] as JArray))
                : null;
            if (previewConfig != null) ApplyHierarchyTransforms(previewConfig);

            foreach (var device in devices)
            {
                ApplyPreviewDevice(device);
            }

            if (includeLayout)
            {
                _environment.RebuildFactoryFloor(previewConfig, devices, reset);
                await _environment.HallReady;
                if (payload == null || _factoryRoot == null) return;
                if (reset) _environment.RefreshReflectionProbe();
            }

            var factoryBounds = CalculateFactoryOverviewBounds();
            _dashboard.UpdatePreviewFactoryBounds(factoryBounds);
            ApplyPreviewFocus(payload["focus"] as JObject, factoryBounds, payload.Value<string>("viewId"));
            _diagnostics.Activity = reset
                ? "Unity live layout restored from database"
                : "Unity live layout updated from admin";
        }

        private void ApplyPreviewDevice(DeviceDto device)
        {
            if (device == null || string.IsNullOrWhiteSpace(device.Id)) return;
            if (!_deviceRoots.TryGetValue(device.Id, out var root) || root == null) return;
            if (!string.IsNullOrWhiteSpace(device.LineId))
            {
                _deviceLineIds[device.Id] = device.LineId;
                var workshop = FindWorkshopForLine(device.LineId);
                if (!string.IsNullOrWhiteSpace(workshop)) _deviceWorkshopIds[device.Id] = workshop;
            }
            var configuredWorkshop = device.InstanceConfigObject.Value<string>("workshop_id")
                ?? device.InstanceConfigObject.Value<string>("workshopId");
            if (!string.IsNullOrWhiteSpace(configuredWorkshop)) _deviceWorkshopIds[device.Id] = configuredWorkshop;

            var configuredLineId = ResolveDeviceLineId(device);
            if (!string.IsNullOrWhiteSpace(configuredLineId))
            {
                _deviceLineIds[device.Id] = configuredLineId;
                var lineWorkshop = FindWorkshopForLine(configuredLineId);
                if (!string.IsNullOrWhiteSpace(lineWorkshop)) _deviceWorkshopIds[device.Id] = lineWorkshop;
            }
            Transform nextParent = null;
            if (!string.IsNullOrWhiteSpace(configuredLineId)) _lineRoots.TryGetValue(configuredLineId, out nextParent);
            if (nextParent == null && !string.IsNullOrWhiteSpace(configuredWorkshop))
            {
                _workshopRoots.TryGetValue(configuredWorkshop, out nextParent);
            }
            if (nextParent != null && root.parent != nextParent) root.SetParent(nextParent, false);

            var nextModelType = device.ModelType ?? string.Empty;
            if (_deviceModelTypes.TryGetValue(device.Id, out var currentModelType)
                && !string.Equals(currentModelType, nextModelType, StringComparison.OrdinalIgnoreCase))
            {
                var version = _previewModelVersions.TryGetValue(device.Id, out var currentVersion)
                    ? currentVersion + 1
                    : 1;
                _previewModelVersions[device.Id] = version;
                _ = ReplacePreviewModelAsync(device, root, version);
                return;
            }

            _modelLibrary.ApplyPreviewTransform(root, device);
            if (_motions.TryGetValue(device.Id, out var motion))
            {
                var motionDevice = ResolveRuntimeDeviceForMotion(device);
                motion.Reconfigure(motionDevice, true);
            }
            if (!string.IsNullOrWhiteSpace(device.Name)) root.name = device.Name;
            _dashboard.ApplyPreviewDevice(device, root.gameObject);
        }

        private async Task ReplacePreviewModelAsync(DeviceDto device, Transform previousRoot, int version)
        {
            try
            {
                var parent = previousRoot != null ? previousRoot.parent : _factoryRoot;
                var wasActive = previousRoot == null || previousRoot.gameObject.activeSelf;
                var instance = await _modelLibrary.InstantiateAsync(device, parent, _lifetime.Token);
                if (!_previewModelVersions.TryGetValue(device.Id, out var latestVersion) || latestVersion != version)
                {
                    if (instance.Root != null) Destroy(instance.Root);
                    return;
                }

                var root = instance.Root;
                root.SetActive(wasActive);
                var driver = root.GetComponent<ModelBindingDriver>();
                var visual = root.AddComponent<DeviceStatusVisual>();
                visual.Initialize(device);
                var motion = root.AddComponent<MobileDeviceMotion>();
                motion.Initialize(device);
                _drivers[device.Id] = driver;
                _visuals[device.Id] = visual;
                _motions[device.Id] = motion;
                _deviceRoots[device.Id] = root.transform;
                _deviceModelTypes[device.Id] = device.ModelType ?? string.Empty;
                _dashboard.ApplyPreviewDevice(device, root, instance.Inspection);
                if (_latestDeviceFrames.TryGetValue(device.Id, out var latest))
                {
                    driver?.ApplyRealtime(latest);
                    visual.ApplyRealtime(latest);
                    motion.ApplyRealtime(latest);
                    _dashboard.ApplyRealtime(device.Id, latest);
                }
                if (instance.IsFallback)
                {
                    _diagnostics.ReportModelError(device.Name ?? device.Id, device.ModelType, instance.LoadError);
                }
                if (previousRoot != null) Destroy(previousRoot.gameObject);

                var bounds = CalculateFactoryOverviewBounds();
                _dashboard.UpdatePreviewFactoryBounds(bounds);
                _environment.RefreshReflectionProbe();
            }
            catch (OperationCanceledException)
            {
                // A full factory reload superseded the preview model request.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[FactoryRuntime] Live model preview failed for {device.Id}: {exception.Message}");
            }
        }

        private FactoryConfigDto BuildPreviewConfig(JArray workshopPatches, JArray linePatches)
        {
            var clone = JsonConvert.DeserializeObject<FactoryConfigDto>(JsonConvert.SerializeObject(_config))
                ?? _config;
            var workshopsById = (clone.Workshops ?? new List<WorkshopDto>())
                .Where(workshop => !string.IsNullOrWhiteSpace(workshop.Id))
                .ToDictionary(workshop => workshop.Id, workshop => workshop);
            foreach (var token in workshopPatches ?? new JArray())
            {
                if (!(token is JObject patch)) continue;
                var workshopId = patch.Value<string>("id");
                if (string.IsNullOrWhiteSpace(workshopId) || !workshopsById.TryGetValue(workshopId, out var workshop)) continue;
                workshop.Layout = (patch["layout_json"] ?? patch["layout"])?.DeepClone();
            }
            var linesById = (clone.Workshops ?? new List<WorkshopDto>())
                .SelectMany(workshop => workshop.Lines ?? new List<LineDto>())
                .Where(line => !string.IsNullOrWhiteSpace(line.Id))
                .ToDictionary(line => line.Id, line => line);
            foreach (var token in linePatches ?? new JArray())
            {
                if (!(token is JObject patch)) continue;
                var lineId = patch.Value<string>("id");
                if (string.IsNullOrWhiteSpace(lineId) || !linesById.TryGetValue(lineId, out var line)) continue;
                line.Layout = (patch["layout_json"] ?? patch["layout"])?.DeepClone();
                var workshopId = patch.Value<string>("workshop_id");
                if (!string.IsNullOrWhiteSpace(workshopId)) line.WorkshopId = workshopId;
            }
            return clone;
        }

        private void ApplyHierarchyTransforms(FactoryConfigDto config)
        {
            foreach (var workshop in config?.Workshops ?? new List<WorkshopDto>())
            {
                if (!_workshopRoots.TryGetValue(workshop.Id ?? string.Empty, out var workshopRoot)) continue;
                ApplySpatialTransform(workshopRoot, workshop.LayoutObject);
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    if (!_lineRoots.TryGetValue(line.Id ?? string.Empty, out var lineRoot)) continue;
                    if (lineRoot.parent != workshopRoot) lineRoot.SetParent(workshopRoot, false);
                    ApplySpatialTransform(lineRoot, line.LayoutObject);
                }
            }
        }

        private Bounds CalculateFactoryOverviewBounds()
        {
            var bounds = CalculateRendererBounds(_factoryRoot);
            if (_environment != null && _environment.HasFactoryHall)
                bounds.Encapsulate(_environment.EnvironmentBounds);
            return bounds;
        }

        private void NormalizeFactoryOverviewViewForEnvironment(string viewId, string mode)
        {
            var configuredView = _dashboard?.GetConfiguredView(viewId, mode);
            var effectiveMode = configuredView?.Mode == "custom"
                ? (configuredView.TargetType ?? "factory")
                : (mode ?? "factory");
            if (!string.Equals(effectiveMode, "factory", StringComparison.OrdinalIgnoreCase)
                || _environment?.HasFactoryHall != true
                || configuredView == null)
            {
                return;
            }

            // The published value was authored against the old six-device
            // placeholder scene. A real hall is already included in the bounds,
            // so keeping that legacy factor makes larger workshops push the whole
            // scene beyond the camera far plane and appear completely empty.
            configuredView.DistanceScale = Mathf.Min(configuredView.DistanceScale, 1.08f);
            Debug.Log(
                $"[FactoryRuntime] Factory overview camera normalized for hall: "
                + $"distanceScale={configuredView.DistanceScale:0.00}, view={configuredView.Id}"
            );
        }

        private void ApplyPreviewFocus(JObject focus, Bounds factoryBounds, string viewId = "")
        {
            var mode = focus?.Value<string>("mode") ?? "factory";
            var configuredView = _dashboard?.GetConfiguredView(viewId, mode);
            var effectiveMode = configuredView?.Mode == "custom"
                ? (configuredView.TargetType ?? "factory")
                : mode;
            var overviewMode = string.Equals(effectiveMode, "factory", StringComparison.OrdinalIgnoreCase);
            if (overviewMode) NormalizeFactoryOverviewViewForEnvironment(viewId, effectiveMode);
            if (configuredView != null && string.IsNullOrWhiteSpace(focus?.Value<string>("deviceId")) && configuredView.TargetType == "device")
            {
                if (focus == null) focus = new JObject();
                focus["deviceId"] = configuredView.TargetId ?? string.Empty;
            }
            if (configuredView != null && string.IsNullOrWhiteSpace(focus?.Value<string>("lineId")) && configuredView.TargetType == "line")
            {
                if (focus == null) focus = new JObject();
                focus["lineId"] = configuredView.TargetId ?? string.Empty;
            }
            if (configuredView != null && string.IsNullOrWhiteSpace(focus?.Value<string>("workshopId")) && configuredView.TargetType == "workshop")
            {
                if (focus == null) focus = new JObject();
                focus["workshopId"] = configuredView.TargetId ?? string.Empty;
            }
            if (string.Equals(effectiveMode, "device", StringComparison.OrdinalIgnoreCase))
            {
                var deviceId = focus?.Value<string>("deviceId");
                var inspectionStage = focus?.Value<string>("inspectionStage") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(inspectionStage))
                    inspectionStage = configuredView?.Metadata?.Value<string>("inspectionStage") ?? string.Empty;
                var partId = focus?.Value<string>("partId") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(partId))
                    partId = configuredView?.Metadata?.Value<string>("partId") ?? string.Empty;
                _dashboard.FocusPreviewDevice(
                    deviceId,
                    configuredView,
                    inspectionStage,
                    partId);
                // FocusPreviewDevice emits both the base view context and the full
                // inspection context. Do not overwrite the latter with empty defaults.
                Debug.Log($"[FactoryRuntime] Native focus applied: mode=device, target={deviceId ?? string.Empty}");
                return;
            }

            IEnumerable<Transform> roots = _deviceRoots.Values.Where(root => root != null);
            var targetId = string.Empty;
            if (string.Equals(effectiveMode, "line", StringComparison.OrdinalIgnoreCase))
            {
                var lineId = focus?.Value<string>("lineId");
                if (string.IsNullOrWhiteSpace(lineId))
                {
                    var selectedDeviceId = _dashboard?.SelectedDeviceId;
                    if (!string.IsNullOrWhiteSpace(selectedDeviceId))
                    {
                        _deviceLineIds.TryGetValue(selectedDeviceId, out lineId);
                    }
                }
                targetId = lineId ?? string.Empty;
                roots = _deviceRoots
                    .Where(pair => _deviceLineIds.TryGetValue(pair.Key, out var value) && value == lineId)
                    .Select(pair => pair.Value)
                    .Where(root => root != null);
            }
            else if (string.Equals(effectiveMode, "workshop", StringComparison.OrdinalIgnoreCase))
            {
                var workshopId = focus?.Value<string>("workshopId");
                targetId = workshopId ?? string.Empty;
                roots = _deviceRoots
                    .Where(pair => _deviceWorkshopIds.TryGetValue(pair.Key, out var value) && value == workshopId)
                    .Select(pair => pair.Value)
                    .Where(root => root != null);
            }

            var selectedRoots = roots.ToList();
            var targetDeviceIds = new HashSet<string>(
                _deviceRoots
                    .Where(pair => selectedRoots.Contains(pair.Value))
                    .Select(pair => pair.Key)
                    .Where(id => !string.IsNullOrWhiteSpace(id)),
                StringComparer.OrdinalIgnoreCase
            );
            _dashboard.FocusPreviewBounds(!overviewMode && selectedRoots.Count > 0
                ? CalculateRendererBounds(selectedRoots)
                : factoryBounds,
                configuredView,
                selectedRoots.Count > 0 ? targetDeviceIds : null);
            var contextWorkshopId = string.Equals(effectiveMode, "workshop", StringComparison.OrdinalIgnoreCase)
                ? targetId
                : string.Empty;
            if (string.Equals(effectiveMode, "line", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(targetId))
            {
                contextWorkshopId = _config?.Workshops?
                    .FirstOrDefault(workshop => workshop.Lines?.Any(line => string.Equals(line.Id, targetId, StringComparison.OrdinalIgnoreCase)) == true)
                    ?.Id ?? string.Empty;
            }
            PublishDashboardContext(effectiveMode, lineId: string.Equals(effectiveMode, "line", StringComparison.OrdinalIgnoreCase) ? targetId : string.Empty,
                workshopId: contextWorkshopId,
                viewId: configuredView?.Id ?? viewId);
            Debug.Log($"[FactoryRuntime] Native focus applied: mode={effectiveMode}, target={targetId}, roots={selectedRoots.Count}");
        }

        private void OnDashboardViewContextChanged(string mode, string deviceId)
        {
            var view = _dashboard?.GetConfiguredView(_dashboard?.ActiveViewId ?? string.Empty, mode);
            var effectiveMode = view?.Mode == "custom"
                ? (view.TargetType ?? "factory")
                : (view?.Mode ?? mode);
            PublishDashboardContext(effectiveMode, deviceId: deviceId, viewId: view?.Id ?? _dashboard?.ActiveViewId ?? string.Empty);
        }

        private void NavigateToParentCamera()
        {
            if (_dashboard == null || _factoryRoot == null) return;

            var currentMode = _lastDashboardContext?.Value<string>("viewMode") ?? "factory";
            var current = _dashboard.GetConfiguredView(_dashboard.ActiveViewId, currentMode);
            var parentViewId = current?.ReturnViewId ?? current?.ParentViewId;
            if (string.IsNullOrWhiteSpace(parentViewId))
            {
                // Keep Esc useful for older/custom documents that predate the
                // explicit parent edge. This mirrors the authored hierarchy.
                parentViewId = string.Equals(currentMode, "device", StringComparison.OrdinalIgnoreCase)
                    ? "line_overview"
                    : string.Equals(currentMode, "line", StringComparison.OrdinalIgnoreCase)
                        ? "workshop_overview"
                        : string.Equals(currentMode, "workshop", StringComparison.OrdinalIgnoreCase)
                            ? "factory_overview"
                            : string.Empty;
                if (string.IsNullOrWhiteSpace(parentViewId))
                {
                    _diagnostics.Activity = "Already at factory overview";
                    return;
                }
            }

            var parent = _dashboard.GetConfiguredView(parentViewId, "factory");
            if (parent == null || string.Equals(parent.Id, current?.Id, StringComparison.OrdinalIgnoreCase))
            {
                _diagnostics.Activity = "No valid parent view";
                return;
            }

            var mode = string.Equals(parent.Mode, "custom", StringComparison.OrdinalIgnoreCase)
                ? (parent.TargetType ?? "factory")
                : (parent.Mode ?? "factory");
            var focus = new JObject { ["mode"] = mode };
            var deviceId = _lastDashboardContext?.Value<string>("deviceId") ?? string.Empty;
            var lineId = _lastDashboardContext?.Value<string>("lineId") ?? string.Empty;
            var workshopId = _lastDashboardContext?.Value<string>("workshopId") ?? string.Empty;

            if (string.IsNullOrWhiteSpace(lineId) && !string.IsNullOrWhiteSpace(deviceId))
                _deviceLineIds.TryGetValue(deviceId, out lineId);
            if (string.IsNullOrWhiteSpace(workshopId) && !string.IsNullOrWhiteSpace(deviceId))
                _deviceWorkshopIds.TryGetValue(deviceId, out workshopId);
            if (string.IsNullOrWhiteSpace(workshopId) && !string.IsNullOrWhiteSpace(lineId))
            {
                workshopId = _config?.Workshops?
                    .FirstOrDefault(workshop => workshop.Lines?.Any(line => string.Equals(line.Id, lineId, StringComparison.OrdinalIgnoreCase)) == true)
                    ?.Id ?? string.Empty;
            }

            if (string.Equals(mode, "device", StringComparison.OrdinalIgnoreCase))
                focus["deviceId"] = string.IsNullOrWhiteSpace(parent.TargetId) ? deviceId : parent.TargetId;
            else if (string.Equals(mode, "line", StringComparison.OrdinalIgnoreCase))
                focus["lineId"] = string.IsNullOrWhiteSpace(parent.TargetId) ? lineId : parent.TargetId;
            else if (string.Equals(mode, "workshop", StringComparison.OrdinalIgnoreCase))
                focus["workshopId"] = string.IsNullOrWhiteSpace(parent.TargetId) ? workshopId : parent.TargetId;

            ApplyPreviewFocus(focus, CalculateFactoryOverviewBounds(), parent.Id);
            _diagnostics.Activity = $"Returned to {parent.Name}";
        }

        private void OnInspectionContextChanged(JObject payload)
        {
            if (payload == null) return;
            var context = _lastDashboardContext.DeepClone() as JObject ?? new JObject();
            foreach (var property in payload.Properties()) context[property.Name] = property.Value.DeepClone();
            context["sceneReady"] = _sceneReady;
            _lastDashboardContext = context;
            _webSocket?.SendMessage(new JObject
            {
                ["type"] = "dashboard_context",
                ["payload"] = context.DeepClone()
            });
        }

        private void PublishDashboardContext(string mode, string deviceId = "", string lineId = "", string workshopId = "", string viewId = "")
        {
            var normalizedMode = string.IsNullOrWhiteSpace(mode) ? "factory" : mode.ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(deviceId))
            {
                if (string.IsNullOrWhiteSpace(lineId)) _deviceLineIds.TryGetValue(deviceId, out lineId);
                if (string.IsNullOrWhiteSpace(workshopId)) _deviceWorkshopIds.TryGetValue(deviceId, out workshopId);
            }
            _lastDashboardContext = new JObject
            {
                ["viewId"] = viewId ?? string.Empty,
                ["sceneReady"] = _sceneReady,
                ["viewMode"] = normalizedMode,
                ["sceneId"] = _config?.Platform?["activeScene"]?["id"]?.Value<string>() ?? string.Empty,
                ["workshopId"] = workshopId ?? string.Empty,
                ["lineId"] = lineId ?? string.Empty,
                ["deviceId"] = deviceId ?? string.Empty,
                ["inspectionEnabled"] = false,
                ["inspectionStage"] = string.IsNullOrWhiteSpace(deviceId) ? "" : "solid",
                ["inspectionProgress"] = 0f,
                ["inspectionAnimating"] = false,
                ["inspectionPhase"] = "idle",
                ["inspectionIsolated"] = false,
                ["inspectionLabelsEnabled"] = false,
                ["inspectionLeaderLines"] = false,
                ["inspectionHoveredPartId"] = string.Empty,
                ["inspectionIssues"] = new JArray(),
                ["inspectionParts"] = new JArray(),
                ["partId"] = string.Empty,
                ["partName"] = string.Empty,
                ["partDescription"] = string.Empty,
                ["partPointIds"] = new JArray(),
                ["partPointKeys"] = new JArray(),
                ["partDetailViewId"] = string.Empty
            };
            _webSocket?.SendMessage(new JObject
            {
                ["type"] = "dashboard_context",
                ["payload"] = _lastDashboardContext.DeepClone()
            });
        }

        private void ApplyPreviewCameraAction(JObject payload)
        {
            var action = payload.Value<string>("cameraAction") ?? string.Empty;
            switch (action)
            {
                case "rotateLeft":
                    _orbit?.NudgeYaw(-12f);
                    break;
                case "rotateRight":
                    _orbit?.NudgeYaw(12f);
                    break;
                case "zoomIn":
                    _orbit?.ZoomBy(0.82f);
                    break;
                case "zoomOut":
                    _orbit?.ZoomBy(1.22f);
                    break;
                case "fit":
                    if (_dashboard?.RefitInspectionCamera() != true)
                        ApplyPreviewFocus(payload["focus"] as JObject, CalculateFactoryOverviewBounds(), _dashboard?.ActiveViewId);
                    break;
            }
        }

        private void OpenAdminSettings()
        {
            StartCoroutine(OpenAdminSettingsCoroutine());
        }

        private string ResolveAdminHostExecutable()
        {
            if (!string.IsNullOrWhiteSpace(_settings?.adminHostExecutable)
                && File.Exists(_settings.adminHostExecutable))
            {
                return _settings.adminHostExecutable;
            }

            var buildDirectory = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            var bundledHost = Path.Combine(buildDirectory, "AdminHost", "HeatTreatmentAdminHost.exe");
            return File.Exists(bundledHost) ? bundledHost : string.Empty;
        }

        private static string AppendEmbeddedFlag(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return url;
            var separator = url.Contains("?") ? "&" : "?";
            return $"{url}{separator}embedded=unity";
        }

        private static string QuoteProcessArgument(string value)
        {
            return $"\"{(value ?? string.Empty).Replace("\"", "\\\"")}\"";
        }

        private bool TryOpenEmbeddedAdmin(string adminUrl, bool showAdmin = true)
        {
            var executable = ResolveAdminHostExecutable();
            if (string.IsNullOrWhiteSpace(executable)) return false;

            try
            {
                var currentProcess = Process.GetCurrentProcess();
                var arguments = string.Join(" ", new[]
                {
                    "--url", QuoteProcessArgument(AppendEmbeddedFlag(adminUrl)),
                    "--parent-pid", currentProcess.Id.ToString(),
                    "--parent-hwnd", currentProcess.MainWindowHandle.ToInt64().ToString(),
                    "--user-data", QuoteProcessArgument(Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                        "heat-treatment-digital-twin-desktop",
                        "webview2"
                    ))
                });
                if (!string.IsNullOrWhiteSpace(_settings?.adminHostFixedRuntimeFolder))
                {
                    arguments += " --fixed-runtime " + QuoteProcessArgument(_settings.adminHostFixedRuntimeFolder);
                }
                if (!string.IsNullOrWhiteSpace(_settings?.desktopControlUrl))
                {
                    arguments += " --desktop-control-url " + QuoteProcessArgument(_settings.desktopControlUrl);
                }
                if (!string.IsNullOrWhiteSpace(_settings?.desktopControlToken))
                {
                    arguments += " --desktop-control-token " + QuoteProcessArgument(_settings.desktopControlToken);
                }
                if (!showAdmin) arguments += " --dashboard-mode";

                Process.Start(new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = arguments,
                    WorkingDirectory = Path.GetDirectoryName(executable) ?? string.Empty,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                Debug.Log(showAdmin
                    ? "[FactoryRuntime] Embedded admin tab requested"
                    : "[FactoryRuntime] Application tab chrome requested");
                return true;
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[FactoryRuntime] Embedded admin panel failed: {exception.Message}");
                return false;
            }
        }

        private IEnumerator StartApplicationChromeCoroutine()
        {
#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
            yield return new WaitForSecondsRealtime(0.35f);
            var adminUrl = string.IsNullOrWhiteSpace(_settings?.adminUrl)
                ? $"{_settings?.backendHttpUrl?.TrimEnd('/')}/admin"
                : _settings.adminUrl;
            var overlayStarted = TryOpenEmbeddedAdmin(adminUrl, false);
            _dashboard?.SetWebOverlayActive(overlayStarted);
            if (!overlayStarted)
            {
                Debug.LogWarning("[StartupWarning] 96|顶部组件启动失败，请检查 WebView2 运行环境");
                Debug.LogWarning("[FactoryRuntime] Application tab chrome could not be started; press F10 to retry.");
            }
#else
            yield break;
#endif
        }

        private IEnumerator OpenAdminSettingsCoroutine()
        {
            var adminUrl = string.IsNullOrWhiteSpace(_settings?.adminUrl)
                ? $"{_settings?.backendHttpUrl?.TrimEnd('/')}/admin"
                : _settings.adminUrl;
            if (TryOpenEmbeddedAdmin(adminUrl, true))
            {
                _dashboard?.SetWebOverlayActive(true);
                yield break;
            }
            if (string.IsNullOrWhiteSpace(_settings?.desktopControlUrl))
            {
                Debug.Log("[FactoryRuntime] Opening admin in the default browser (development mode)");
                Application.OpenURL(adminUrl);
                yield break;
            }

            var endpoint = $"{_settings.desktopControlUrl.TrimEnd('/')}/open-admin";
            var requestTask = PostDesktopControlAsync(endpoint, _settings.desktopControlToken);
            while (!requestTask.IsCompleted) yield return null;
            if (requestTask.Status == TaskStatus.RanToCompletion && requestTask.Result)
            {
                Debug.Log("[FactoryRuntime] Desktop settings window requested");
                yield break;
            }

            if (requestTask.IsFaulted)
            {
                Debug.LogWarning($"[FactoryRuntime] Desktop settings request failed: {requestTask.Exception?.GetBaseException().Message}");
            }
            Application.OpenURL(adminUrl);
        }

        private static async Task<bool> PostDesktopControlAsync(string endpoint, string token)
        {
            using (var handler = new HttpClientHandler { UseProxy = false })
            using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) })
            using (var request = new HttpRequestMessage(HttpMethod.Post, endpoint))
            {
                request.Headers.TryAddWithoutValidation("x-desktop-control-token", token ?? string.Empty);
                using (var response = await client.SendAsync(request))
                {
                    return response.IsSuccessStatusCode;
                }
            }
        }

        private string FindWorkshopForLine(string lineId)
        {
            foreach (var workshop in _config?.Workshops ?? new List<WorkshopDto>())
            {
                if ((workshop.Lines ?? new List<LineDto>()).Any(line => line.Id == lineId)) return workshop.Id;
            }
            return string.Empty;
        }

        private static IEnumerable<DeviceDto> EnumerateConfigDevices(FactoryConfigDto config)
        {
            foreach (var workshop in config?.Workshops ?? new List<WorkshopDto>())
            {
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    foreach (var device in line.Devices ?? new List<DeviceDto>()) yield return device;
                }
                foreach (var device in workshop.Devices ?? new List<DeviceDto>()) yield return device;
            }
        }

        private void ApplyLiveSettings(JObject payload)
        {
            if (!(payload?["settings"] is JObject changedSettings)) return;
            var merged = _config?.Settings ?? new Dictionary<string, string>();
            foreach (var property in changedSettings.Properties())
            {
                merged[property.Name] = property.Value.Type == JTokenType.String
                    ? property.Value.Value<string>()
                    : property.Value.ToString();
            }
            if (_config != null) _config.Settings = merged;
            _dashboard.ApplySettings(merged);
            _environment.ApplySettings(merged);

            if (changedSettings.Property("native_quality_profile") != null) ApplyBackendQuality(merged);
            _diagnostics.Activity = "Dashboard configuration updated live";
            Debug.Log("[FactoryRuntime] Dashboard configuration updated live");
        }

        private void ApplyLiveDeviceConfiguration(JObject payload)
        {
            var deviceId = payload?.Value<string>("deviceId");
            if (string.IsNullOrWhiteSpace(deviceId) || _config == null) return;
            var device = EnumerateConfigDevices(_config).FirstOrDefault(item => item?.Id == deviceId);
            if (device == null) return;
            if (payload["instanceConfig"] != null) device.InstanceConfig = payload["instanceConfig"].DeepClone();
            if (_motions.TryGetValue(deviceId, out var motion)) motion.Reconfigure(device, true);
            _diagnostics.Activity = "Mobile device configuration updated live";
        }

        private DeviceDto ResolveRuntimeDeviceForMotion(DeviceDto patch)
        {
            if (patch == null || _config == null) return patch;
            var current = EnumerateConfigDevices(_config).FirstOrDefault(item => item?.Id == patch.Id);
            if (current == null) return patch;
            if ((patch.DataPoints == null || patch.DataPoints.Count == 0) && current.DataPoints != null)
            {
                patch.DataPoints = current.DataPoints;
            }
            if (patch.InstanceConfigObject["movement"] == null && current.InstanceConfigObject["movement"] != null)
            {
                patch.InstanceConfig = current.InstanceConfigObject.DeepClone();
            }
            return patch;
        }

        private void ApplyBackendQuality(IReadOnlyDictionary<string, string> settings)
        {
            if (_quality == null || !string.Equals(_settings?.qualityProfile, "auto", StringComparison.OrdinalIgnoreCase)) return;

            var qualityProfile = "auto";
            if (settings != null && settings.TryGetValue("native_quality_profile", out var configured))
            {
                qualityProfile = string.IsNullOrWhiteSpace(configured) ? "auto" : configured.Trim();
            }

            if (string.Equals(qualityProfile, "auto", StringComparison.OrdinalIgnoreCase))
            {
                _quality.ApplyAuto(false);
                return;
            }

            _quality.Apply(qualityProfile, false);
        }

        private void OnConnectionStateChanged(string state)
        {
            _diagnostics.BackendState = state ?? "unknown";
            _dashboard.BackendState = _diagnostics.BackendState;
            if (string.Equals(state, "connected", StringComparison.OrdinalIgnoreCase))
            {
                _webSocket?.SendMessage(new JObject
                {
                    ["type"] = "dashboard_context",
                    ["payload"] = _lastDashboardContext.DeepClone()
                });
            }
        }

        private void DestroyCurrentFactory()
        {
            _drivers.Clear();
            _visuals.Clear();
            _motions.Clear();
            _deviceRoots.Clear();
            _workshopRoots.Clear();
            _lineRoots.Clear();
            _deviceModelTypes.Clear();
            _deviceLineIds.Clear();
            _deviceWorkshopIds.Clear();
            _previewModelVersions.Clear();
            _dashboard?.ClearFactory();
            if (_factoryRoot != null) Destroy(_factoryRoot.gameObject);
            _factoryRoot = null;
            if (_diagnostics != null)
            {
                _diagnostics.ReadyDeviceCount = 0;
                _diagnostics.DeviceCount = 0;
                _diagnostics.FallbackDeviceCount = 0;
            }
        }

        private static Bounds CalculateRendererBounds(Transform root)
        {
            // 设备详情视角会暂时隐藏其它设备；返回产线/工厂时仍必须把这些
            // inactive 设备计入镜头包围盒，否则镜头看起来仍停留在单台设备上。
            var renderers = root.GetComponentsInChildren<Renderer>(true)
                .Where(renderer => renderer.enabled)
                .ToArray();
            if (renderers.Length == 0) return new Bounds(Vector3.zero, new Vector3(40f, 10f, 30f));
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index += 1) bounds.Encapsulate(renderers[index].bounds);
            bounds.Expand(new Vector3(4f, 2f, 4f));
            return bounds;
        }

        private static Bounds CalculateRendererBounds(IEnumerable<Transform> roots)
        {
            var renderers = (roots ?? Enumerable.Empty<Transform>())
                .Where(root => root != null)
                .SelectMany(root => root.GetComponentsInChildren<Renderer>(true))
                .Where(renderer => renderer.enabled)
                .ToArray();
            if (renderers.Length == 0) return new Bounds(Vector3.zero, new Vector3(40f, 10f, 30f));
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index += 1) bounds.Encapsulate(renderers[index].bounds);
            bounds.Expand(new Vector3(4f, 2f, 4f));
            return bounds;
        }

        private T GetOrAdd<T>() where T : Component
        {
            return GetComponent<T>() ?? gameObject.AddComponent<T>();
        }

        private static string ShortMessage(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unknown error";
            return value.Length <= 86 ? value : value.Substring(0, 83) + "...";
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
            if (_webSocket != null)
            {
                _webSocket.MessageReceived -= OnRealtimeMessage;
                _webSocket.ConnectionStateChanged -= OnConnectionStateChanged;
                _webSocket.StopClient();
            }
            if (_dashboard != null) _dashboard.ViewContextChanged -= OnDashboardViewContextChanged;
            if (_dashboard != null) _dashboard.InspectionContextChanged -= OnInspectionContextChanged;
            if (_dashboard != null) _dashboard.ParentNavigationRequested -= NavigateToParentCamera;
            if (_windowMenu != null) _windowMenu.SettingsRequested -= OpenAdminSettings;
            _reload?.Cancel();
            _reload?.Dispose();
            _lifetime?.Cancel();
            _lifetime?.Dispose();
        }
    }

    public sealed class DeviceStatusVisual : MonoBehaviour
    {
        private Renderer _renderer;
        private Material _material;
        private Color _lastColor = Color.clear;

        public void Initialize(DeviceDto device)
        {
            var config = device?.InstanceConfigObject ?? new JObject();
            var labelY = config.Value<float?>("statusLightY") ?? config.Value<float?>("labelY") ?? 3.2f;
            var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            marker.name = "Runtime Status Beacon";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = new Vector3(0f, labelY, 0f);
            marker.transform.localScale = Vector3.one * 0.14f;
            var collider = marker.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
            _renderer = marker.GetComponent<Renderer>();
            _material = RuntimeShaderLibrary.CreateLitMaterial($"{device?.Id} status beacon");
            _material.EnableKeyword("_EMISSION");
            _renderer.sharedMaterial = _material;
            SetColor(new Color(0.28f, 0.32f, 0.35f));
        }

        public void ApplyRealtime(JObject data)
        {
            var quality = TokenString(data?["status"]?["quality"])
                ?? TokenString(data?["quality"]?["overall"])
                ?? TokenString(data?["quality"]);
            var alarm = ToBool(data?["status"]?["alarm"]);
            var running = ToBool(data?["status"]?["running"]);
            if (string.Equals(quality, "bad", StringComparison.OrdinalIgnoreCase)) SetColor(new Color(0.95f, 0.18f, 0.13f));
            else if (string.Equals(quality, "stale", StringComparison.OrdinalIgnoreCase)) SetColor(new Color(1f, 0.52f, 0.12f));
            else if (alarm) SetColor(new Color(1f, 0.06f, 0.035f));
            else if (running) SetColor(new Color(0.04f, 1f, 0.48f));
            else SetColor(new Color(0.25f, 0.31f, 0.34f));
        }

        private void SetColor(Color color)
        {
            if (_material == null || color == _lastColor) return;
            _lastColor = color;
            _material.color = color;
            if (_material.HasProperty("_BaseColor")) _material.SetColor("_BaseColor", color);
            if (_material.HasProperty("_EmissionColor")) _material.SetColor("_EmissionColor", color * 2.2f);
        }

        private static bool ToBool(JToken token)
        {
            if (token == null) return false;
            if (token.Type == JTokenType.Boolean) return token.Value<bool>();
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) return Math.Abs(token.Value<double>()) > double.Epsilon;
            var value = token.Value<string>()?.ToLowerInvariant();
            return value == "1" || value == "true" || value == "on" || value == "running" || value == "alarm";
        }

        private static string TokenString(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Object || token.Type == JTokenType.Array)
            {
                return null;
            }
            return token.ToString();
        }

        private void OnDestroy()
        {
            if (_material != null) Destroy(_material);
        }
    }
}
