using System;
using System.Globalization;
using System.IO;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Entirely absent during ordinary launches. This component measures actual
    // rendered-player frame intervals; it never changes quality, timing or UI.
    [DefaultExecutionOrder(31000)]
    public sealed class RuntimeFrameMetrics : MonoBehaviour
    {
        public const string InstrumentationVersion = "wall-frames-v3-active-camera-raw";
        public const string ActiveCameraTracking = "Camera.main every sampled LateUpdate and before URP camera rendering";
        private struct Counter
        {
            public string Key;
            public string Name;
            public ProfilerRecorder Recorder;
        }

        private readonly RuntimeFrameStatistics _statistics = new RuntimeFrameStatistics();
        private readonly FrameTiming[] _timing = new FrameTiming[1];
        private Counter[] _counters;
        private RuntimeMetricLog _log;
        private RuntimeDiagnosticsOverlay _diagnostics;
        private NativeQualityController _quality;
        private FactoryDashboardController _dashboard;
        private Camera _camera;
        private Transform _cameraTransform;
        private OrbitCameraController _orbit;
        private Camera _windowCamera;
        private Vector3 _windowCameraPosition;
        private Quaternion _windowCameraRotation;
        private Vector3 _windowCameraTarget;
        private float _windowCameraFov;
        private float _windowCameraAspect;
        private float _windowCameraNear;
        private float _windowCameraFar;
        private float _windowCameraOrthoSize;
        private bool _windowCameraOrthographic;
        private int _windowCameraInstanceId;
        private bool _windowHasOrbitTarget;
        private long _windowCameraSwitches;
        private bool _cameraStable;
        private string _sessionId;
        private string _measurementTag;
        private double _previous;
        private double _windowStart;
        private long _sequence;
        private bool _timingEnabled;
        private bool _stopped;
        private bool _contextStable = true;
        private bool? _windowReady;
        private string _windowView;
        private string _windowFactoryId;
        private string _windowSceneId;
        private string _windowProfile;
        private int _windowWidth;
        private int _windowHeight;
        private bool _windowFocus;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Install()
        {
            var requested = Environment.GetEnvironmentVariable("DIGITAL_TWIN_FRAME_METRICS_PATH");
            if (string.IsNullOrWhiteSpace(requested)) return;
            try
            {
                var path = Path.GetFullPath(requested);
                var root = new GameObject("__OptInRuntimeFrameMetrics") { hideFlags = HideFlags.HideInHierarchy };
                DontDestroyOnLoad(root);
                root.AddComponent<RuntimeFrameMetrics>().Begin(path);
            }
            catch (Exception error) { Debug.LogWarning("[RuntimeFrameMetrics] Disabled: " + error.Message); }
        }

        private void Begin(string path)
        {
            _sessionId = Guid.NewGuid().ToString("N");
            _measurementTag = Environment.GetEnvironmentVariable("DIGITAL_TWIN_FRAME_METRICS_TAG") ?? string.Empty;
            _log = new RuntimeMetricLog(path);
            _counters = new[]
            {
                StartCounter("drawCalls", ProfilerCategory.Render, "Draw Calls Count"),
                StartCounter("setPassCalls", ProfilerCategory.Render, "SetPass Calls Count"),
                StartCounter("batches", ProfilerCategory.Render, "Batches Count"),
                StartCounter("triangles", ProfilerCategory.Render, "Triangles Count"),
                StartCounter("gcAllocatedBytes", ProfilerCategory.Memory, "GC Allocated In Frame"),
                StartCounter("cpuMainThreadNanoseconds", ProfilerCategory.Internal, "CPU Main Thread Frame Time")
            };
            _timingEnabled = FrameTimingManager.IsFeatureEnabled();
            CacheContext();
            RenderPipelineManager.beginCameraRendering += BeforeCameraRendering;
            _previous = _windowStart = Time.realtimeSinceStartupAsDouble;
            CaptureWindowContext();
            _log.TryEnqueue(new JObject
            {
                ["type"] = "frame-metrics-metadata", ["schemaVersion"] = 2,
                ["instrumentationVersion"] = InstrumentationVersion, ["sessionId"] = _sessionId,
                ["measurementTag"] = _measurementTag,
                ["assemblyModuleVersionId"] = typeof(RuntimeFrameMetrics).Assembly.ManifestModule.ModuleVersionId.ToString("D"),
                ["timestampUtc"] = UtcNow(), ["unityVersion"] = Application.unityVersion,
                ["gpu"] = SystemInfo.graphicsDeviceName, ["graphicsApi"] = SystemInfo.graphicsDeviceType.ToString(),
                ["graphicsMemoryMiB"] = SystemInfo.graphicsMemorySize,
                ["cpu"] = SystemInfo.processorType, ["logicalProcessors"] = SystemInfo.processorCount,
                ["systemMemoryMiB"] = SystemInfo.systemMemorySize,
                ["batchmode"] = Application.isBatchMode, ["isEditor"] = Application.isEditor,
                ["debugBuild"] = Debug.isDebugBuild, ["runtimePlatform"] = Application.platform.ToString(),
                ["frameTimingFeatureEnabled"] = _timingEnabled,
                ["frameSample"] = "wall-clock intervals between consecutive LateUpdate callbacks; not display scan-out",
                ["percentileMethod"] = "linear interpolation at (N-1)*p; null if fixed sample storage overflows",
                ["wholeRunPercentiles"] = "concatenate eligible frameIntervalsMs arrays; never average window percentiles",
                ["cameraStability"] = "same camera, position/target drift <=0.0001 scene units, quaternion abs-dot >=0.9999999; projection drift <=0.0001",
                ["activeCameraTracking"] = ActiveCameraTracking,
                ["windowSeconds"] = 1, ["maximumBufferedWindows"] = 8,
                ["nativeCounterSample"] = "last completed frame at window end; not a window mean",
                ["frameTimingSample"] = "latest captured frame at window end; GPU timings may lag",
                ["shutdown"] = "background flush is best effort; Unity main thread never waits for filesystem I/O",
                ["context"] = Context()
            }.ToString(Formatting.None));
        }

        private static Counter StartCounter(string key, ProfilerCategory category, string name)
        {
            var result = new Counter { Key = key, Name = name };
            try { result.Recorder = ProfilerRecorder.StartNew(category, name, 1); }
            catch (Exception) { /* Unsupported production counters remain unavailable, never fake zero. */ }
            return result;
        }

        private void LateUpdate()
        {
            if (_log == null || _stopped) return;
            var now = Time.realtimeSinceStartupAsDouble;
            _statistics.Add(now - _previous);
            _previous = now;
            RefreshActiveCamera();
            ObserveCamera();
            ObserveContext();
            if (_timingEnabled)
            {
                try { FrameTimingManager.CaptureFrameTimings(); }
                catch (Exception) { _timingEnabled = false; }
            }
            if (now - _windowStart >= 1d) EmitWindow(now, false);
        }

        private void ObserveContext()
        {
            if (_windowReady != SceneReady() || !string.Equals(_windowView, _dashboard != null ? _dashboard.ActiveViewId : null, StringComparison.Ordinal)
                || !string.Equals(_windowFactoryId, _dashboard != null ? _dashboard.ActiveFactoryId : null, StringComparison.Ordinal)
                || !string.Equals(_windowSceneId, _dashboard != null ? _dashboard.ActiveSceneId : null, StringComparison.Ordinal)
                || !string.Equals(_windowProfile, _quality != null ? _quality.ActiveProfileName : null, StringComparison.Ordinal)
                || _windowWidth != Screen.width || _windowHeight != Screen.height || _windowFocus != Application.isFocused)
                _contextStable = false;
        }

        private void EmitWindow(double now, bool partial)
        {
            _statistics.SortForSummary();
            _timing[0] = default;
            var timingCount = _timingEnabled ? FrameTimingManager.GetLatestTimings(1, _timing) : 0;
            var frameTiming = _timing[0];
            var counters = new JObject();
            if (_counters != null)
            {
                foreach (var counter in _counters)
                {
                    var available = counter.Recorder.Valid && counter.Recorder.Count > 0;
                    counters[counter.Key] = new JObject
                    {
                        ["available"] = available, ["source"] = counter.Name,
                        ["value"] = available ? new JValue(counter.Recorder.LastValue) : JValue.CreateNull()
                    };
                }
            }
            var elapsed = now - _windowStart;
            CacheContext();
            ObserveCamera();
            var intervals = _statistics.CopyFrameIntervalsMs();
            var row = new JObject
            {
                ["type"] = "frame-metrics-window", ["schemaVersion"] = 2, ["sequence"] = ++_sequence,
                ["instrumentationVersion"] = InstrumentationVersion, ["sessionId"] = _sessionId,
                ["measurementTag"] = _measurementTag, ["windowStartRealtimeSeconds"] = _windowStart,
                ["timestampUtc"] = UtcNow(), ["realtimeSeconds"] = now,
                ["elapsedSeconds"] = elapsed, ["partial"] = partial,
                ["frames"] = _statistics.Frames, ["fps"] = Number(_statistics.FramesPerSecond(elapsed)),
                ["medianMs"] = Number(_statistics.Percentile(.5)), ["p95Ms"] = Number(_statistics.Percentile(.95)),
                ["p99Ms"] = Number(_statistics.Percentile(.99)),
                ["frameIntervalsMs"] = intervals != null ? (JToken)new JArray(intervals) : JValue.CreateNull(),
                ["maximumMs"] = _statistics.Frames > 0 ? new JValue(_statistics.MaximumMs) : JValue.CreateNull(),
                ["over33Ms"] = _statistics.Over33Ms, ["over50Ms"] = _statistics.Over50Ms,
                ["invalidSamples"] = _statistics.InvalidSamples, ["percentileOverflow"] = _statistics.PercentileOverflow,
                ["contextStable"] = _contextStable, ["cameraStable"] = _cameraStable,
                ["cameraSwitches"] = _windowCameraSwitches, ["context"] = Context(),
                ["nativeCounters"] = counters,
                ["frameTiming"] = new JObject
                {
                    ["featureEnabled"] = _timingEnabled, ["available"] = timingCount > 0,
                    ["sample"] = "latest captured frame; not a window mean",
                    ["cpuFrameMs"] = PositiveTiming(timingCount, frameTiming.cpuFrameTime),
                    ["cpuMainThreadMs"] = PositiveTiming(timingCount, frameTiming.cpuMainThreadFrameTime),
                    ["cpuPresentWaitMs"] = PositiveTiming(timingCount, frameTiming.cpuMainThreadPresentWaitTime),
                    ["cpuRenderThreadMs"] = PositiveTiming(timingCount, frameTiming.cpuRenderThreadFrameTime),
                    ["gpuFrameMs"] = PositiveTiming(timingCount, frameTiming.gpuFrameTime)
                },
                ["droppedRecords"] = _log.DroppedRecords, ["writtenRecords"] = _log.WrittenRecords,
                ["pendingRecords"] = _log.PendingRecords
            };
            _log.TryEnqueue(row.ToString(Formatting.None));
            if (_log.Error != null)
            {
                Debug.LogWarning("[RuntimeFrameMetrics] Output unavailable; animation is unaffected: " + _log.Error);
                Stop(false); return;
            }
            _statistics.Reset(); _windowStart = now; CaptureWindowContext();
        }

        private void CacheContext()
        {
            if (_diagnostics == null) _diagnostics = FindObjectOfType<RuntimeDiagnosticsOverlay>();
            if (_quality == null) _quality = FindObjectOfType<NativeQualityController>();
            if (_dashboard == null) _dashboard = FindObjectOfType<FactoryDashboardController>();
            RefreshActiveCamera();
        }

        // Old main cameras can remain alive and enabled after being untagged.
        // Resolve the actual main every sampled frame even while this window is
        // already unstable; otherwise its last pose could falsely describe the
        // next camera. GetComponent only runs when camera identity changes.
        private void RefreshActiveCamera()
        {
            var active = Camera.main;
            if (ReferenceEquals(active, _camera)) return;
            _cameraStable = false; _windowCameraSwitches++;
            _camera = active;
            _cameraTransform = active != null ? active.transform : null;
            _orbit = active != null ? active.GetComponent<OrbitCameraController>() : null;
        }

        private void BeforeCameraRendering(ScriptableRenderContext context, Camera camera)
        {
            // Also catch switches by later-LateUpdate scripts before URP draws.
            // Reflection/overlay camera callbacks never substitute themselves
            // for the actual Camera.main.
            if (_log != null && !_stopped) RefreshActiveCamera();
        }

        private bool? SceneReady() => _diagnostics != null
            ? !_diagnostics.LoadingVisible && _diagnostics.ReadyDeviceCount >= _diagnostics.DeviceCount
            : (bool?)null;

        private void CaptureWindowContext()
        {
            _contextStable = true; _windowReady = SceneReady();
            _windowView = _dashboard != null ? _dashboard.ActiveViewId : null;
            _windowFactoryId = _dashboard != null ? _dashboard.ActiveFactoryId : null;
            _windowSceneId = _dashboard != null ? _dashboard.ActiveSceneId : null;
            _windowProfile = _quality != null ? _quality.ActiveProfileName : null;
            _windowWidth = Screen.width; _windowHeight = Screen.height; _windowFocus = Application.isFocused;
            _windowCamera = _camera; _cameraStable = _camera != null;
            _windowCameraSwitches = 0; _windowCameraInstanceId = _camera != null ? _camera.GetInstanceID() : 0;
            _windowHasOrbitTarget = _orbit != null;
            if (_camera == null) return;
            _windowCameraPosition = _cameraTransform.position; _windowCameraRotation = _cameraTransform.rotation;
            _windowCameraTarget = _orbit != null ? _orbit.Target : Vector3.zero;
            _windowCameraFov = _camera.fieldOfView; _windowCameraAspect = _camera.aspect;
            _windowCameraNear = _camera.nearClipPlane; _windowCameraFar = _camera.farClipPlane;
            _windowCameraOrthographic = _camera.orthographic; _windowCameraOrthoSize = _camera.orthographicSize;
        }

        private void ObserveCamera()
        {
            if (!_cameraStable) return;
            if (_camera == null || _cameraTransform == null || _camera != _windowCamera
                || (_cameraTransform.position - _windowCameraPosition).sqrMagnitude > .00000001f
                || Mathf.Abs(Quaternion.Dot(_cameraTransform.rotation, _windowCameraRotation)) < .9999999f
                || (_orbit != null && (_orbit.Target - _windowCameraTarget).sqrMagnitude > .00000001f)
                || Mathf.Abs(_camera.fieldOfView - _windowCameraFov) > .0001f
                || Mathf.Abs(_camera.aspect - _windowCameraAspect) > .0001f
                || Mathf.Abs(_camera.nearClipPlane - _windowCameraNear) > .0001f
                || Mathf.Abs(_camera.farClipPlane - _windowCameraFar) > .0001f
                || _camera.orthographic != _windowCameraOrthographic
                || Mathf.Abs(_camera.orthographicSize - _windowCameraOrthoSize) > .0001f)
                _cameraStable = false;
        }

        private JObject CameraContext()
        {
            if (_camera == null || _cameraTransform == null) return new JObject
            {
                ["available"] = false,
                ["windowStartInstanceId"] = _windowCameraInstanceId != 0 ? new JValue(_windowCameraInstanceId) : JValue.CreateNull()
            };
            var position = _cameraTransform.position; var rotation = _cameraTransform.rotation;
            var target = _orbit != null ? _orbit.Target : Vector3.zero;
            return new JObject
            {
                ["available"] = true, ["instanceId"] = _camera.GetInstanceID(),
                ["windowStartInstanceId"] = _windowCameraInstanceId != 0 ? new JValue(_windowCameraInstanceId) : JValue.CreateNull(),
                ["position"] = Vector(position),
                ["rotation"] = new JArray(rotation.x, rotation.y, rotation.z, rotation.w),
                ["target"] = _orbit != null ? Vector(target) : (JToken)JValue.CreateNull(),
                ["fieldOfView"] = _camera.fieldOfView, ["aspect"] = _camera.aspect,
                ["nearClip"] = _camera.nearClipPlane, ["farClip"] = _camera.farClipPlane,
                ["orthographic"] = _camera.orthographic, ["orthographicSize"] = _camera.orthographicSize,
                ["windowStartPosition"] = _windowCameraInstanceId != 0 ? Vector(_windowCameraPosition) : (JToken)JValue.CreateNull(),
                ["windowStartRotation"] = _windowCameraInstanceId != 0
                    ? new JArray(_windowCameraRotation.x, _windowCameraRotation.y, _windowCameraRotation.z, _windowCameraRotation.w)
                    : (JToken)JValue.CreateNull(),
                ["windowStartTarget"] = _windowCameraInstanceId != 0 && _windowHasOrbitTarget ? Vector(_windowCameraTarget) : (JToken)JValue.CreateNull()
            };
        }

        private static JArray Vector(Vector3 value) => new JArray(value.x, value.y, value.z);

        private JObject Context()
        {
            var pipeline = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            return new JObject
            {
            ["sceneReady"] = _diagnostics != null ? new JValue(SceneReady()) : JValue.CreateNull(),
            ["sceneReadySource"] = "diagnostic loading cover hidden and ready count >= device count",
            ["viewId"] = _dashboard != null ? new JValue(_dashboard.ActiveViewId) : JValue.CreateNull(),
            ["factoryId"] = Identifier(_dashboard != null ? _dashboard.ActiveFactoryId : null),
            ["sceneId"] = Identifier(_dashboard != null ? _dashboard.ActiveSceneId : null),
            ["devices"] = _diagnostics != null ? new JValue(_diagnostics.DeviceCount) : JValue.CreateNull(),
            ["fallbackDevices"] = _diagnostics != null ? new JValue(_diagnostics.FallbackDeviceCount) : JValue.CreateNull(),
            ["profile"] = _quality != null ? new JValue(_quality.ActiveProfileName) : JValue.CreateNull(),
            ["renderScale"] = _quality != null ? new JValue(_quality.ActiveRenderScale) : JValue.CreateNull(),
            ["effectiveRenderScale"] = pipeline != null ? new JValue(pipeline.renderScale) : JValue.CreateNull(),
            ["shadowDistance"] = pipeline != null ? new JValue(pipeline.shadowDistance) : new JValue(QualitySettings.shadowDistance),
            ["shadowCascades"] = pipeline != null ? new JValue(pipeline.shadowCascadeCount) : new JValue(QualitySettings.shadowCascades),
            ["msaa"] = _quality != null ? new JValue(_quality.ActiveMsaa) : JValue.CreateNull(),
            ["width"] = Screen.width, ["height"] = Screen.height,
            ["targetFrameRate"] = Application.targetFrameRate, ["vSyncCount"] = QualitySettings.vSyncCount,
            ["focused"] = Application.isFocused, ["runInBackground"] = Application.runInBackground,
            ["batchmode"] = Application.isBatchMode, ["camera"] = CameraContext()
            };
        }

        private static string UtcNow() => DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        private static JToken Number(double? value) => value.HasValue ? new JValue(value.Value) : JValue.CreateNull();
        private static JToken Identifier(string value) => !string.IsNullOrWhiteSpace(value) ? new JValue(value) : JValue.CreateNull();
        private static JToken PositiveTiming(uint count, double value) => count > 0 && value > 0 && !double.IsNaN(value) && !double.IsInfinity(value)
            ? new JValue(value) : JValue.CreateNull();

        private void Stop(bool flush)
        {
            if (_stopped || _log == null) return;
            _stopped = true;
            RenderPipelineManager.beginCameraRendering -= BeforeCameraRendering;
            if (flush && _statistics.Frames > 0) EmitWindow(Time.realtimeSinceStartupAsDouble, true);
            if (_counters != null) foreach (var counter in _counters) if (counter.Recorder.Valid) counter.Recorder.Dispose();
            _log.RequestStop();
        }

        private void OnApplicationQuit() => Stop(true);
        private void OnDestroy() => Stop(false);
    }
}
