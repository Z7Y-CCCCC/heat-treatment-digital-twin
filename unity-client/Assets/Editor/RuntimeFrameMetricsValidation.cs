using System;
using System.Collections.Generic;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Explicit batch validation only. No live account/database/window is opened.
    public static class RuntimeFrameMetricsValidation
    {
        public static void Validate()
        {
            var samples = new RuntimeFrameStatistics(4);
            samples.Add(.01); samples.Add(.02); samples.Add(.03); samples.Add(.04); samples.SortForSummary();
            Require(samples.Percentile(.5) == 25d && Math.Abs(samples.Percentile(.95).Value - 38.5) < 1e-8,
                "Real Unity runtime disagrees with the fixed-storage percentile calculation.");
            samples.Add(.05); samples.SortForSummary();
            Require(samples.Frames == 5 && samples.PercentileOverflow == 1 && !samples.Percentile(.99).HasValue,
                "Overflow exposed a truncated percentile as real whole-window telemetry.");
            Require(samples.CopyFrameIntervalsMs() == null, "Overflow exposed incomplete raw-frame evidence.");
            var helper = typeof(RuntimeFrameMetrics).GetMethod("PositiveTiming", BindingFlags.NonPublic | BindingFlags.Static);
            Require(helper != null, "Runtime timing conversion helper is missing.");
            JToken Timing(uint count, double value) => (JToken)helper.Invoke(null, new object[] { count, value });
            Require(Timing(0, 17).Type == JTokenType.Null && Timing(1, 0).Type == JTokenType.Null
                && Timing(1, -1).Type == JTokenType.Null && Timing(1, double.NaN).Type == JTokenType.Null
                && Timing(1, double.PositiveInfinity).Type == JTokenType.Null,
                "Unavailable/nonfinite native timing became a fabricated zero or valid measurement.");
            Require(Timing(1, 17.25).Value<double>() == 17.25, "Valid millisecond timing was rescaled or discarded.");
            var root = new GameObject("__FrameMetricsOptInValidation") { hideFlags = HideFlags.HideAndDontSave };
            try
            {
                var metrics = root.AddComponent<RuntimeFrameMetrics>();
                var sink = typeof(RuntimeFrameMetrics).GetField("_log", BindingFlags.NonPublic | BindingFlags.Instance);
                Require(sink != null && sink.GetValue(metrics) == null, "A non-initialized metrics component created a filesystem worker.");
                typeof(RuntimeFrameMetrics).GetMethod("LateUpdate", BindingFlags.NonPublic | BindingFlags.Instance)?.Invoke(metrics, null);
                Require(sink.GetValue(metrics) == null, "Ordinary non-opt-in frames activated telemetry I/O.");
                var camera = root.AddComponent<Camera>(); var orbit = root.AddComponent<OrbitCameraController>();
                void Set(string name, object value) => typeof(RuntimeFrameMetrics).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).SetValue(metrics, value);
                void Invoke(string name) => typeof(RuntimeFrameMetrics).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(metrics, null);
                bool Stable() => (bool)typeof(RuntimeFrameMetrics).GetField("_cameraStable", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics);
                Set("_camera", camera); Set("_cameraTransform", root.transform); Set("_orbit", orbit);
                Invoke("CaptureWindowContext"); Invoke("ObserveCamera");
                Require(Stable(), "An unchanged real Unity camera was reported as moving.");
                root.transform.position += Vector3.right; Invoke("ObserveCamera");
                Require(!Stable(), "Camera movement with an unchanged view ID was not detected.");
                Invoke("CaptureWindowContext"); camera.fieldOfView += 1; Invoke("ObserveCamera");
                Require(!Stable(), "A field-of-view/projection change was accepted as the same camera pose.");
                Invoke("CaptureWindowContext"); root.transform.rotation = Quaternion.Euler(0, 15, 0); Invoke("ObserveCamera");
                Require(!Stable(), "Camera rotation was not included in window stability.");
                var pose = (JObject)typeof(RuntimeFrameMetrics).GetMethod("CameraContext", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(metrics, null);
                Require(pose.Value<bool>("available") && pose["position"] is JArray p && p.Count == 3
                    && pose["rotation"] is JArray q && q.Count == 4 && pose["target"] is JArray t && t.Count == 3,
                    "Camera evidence did not preserve the actual position, quaternion and orbit target.");
                ValidateActiveMainCamera(metrics, camera, orbit);
                var dashboard = root.AddComponent<FactoryDashboardController>();
                var configField = typeof(FactoryDashboardController).GetField("_config", BindingFlags.NonPublic | BindingFlags.Instance);
                Require(dashboard.ActiveFactoryId == string.Empty && dashboard.ActiveSceneId == string.Empty,
                    "An unconfigured dashboard fabricated factory or scene identity.");
                var config = new FactoryConfigDto { FactoryId = "factory-a", Platform = new JObject { ["activeScene"] = new JObject { ["id"] = "scene-a" } } };
                configField.SetValue(dashboard, config); Set("_dashboard", dashboard);
                Require(dashboard.ActiveFactoryId == "factory-a" && dashboard.ActiveSceneId == "scene-a",
                    "Read-only scope getters do not reflect the actual dashboard configuration.");
                var scopeJson = config.Platform.ToString();
                Invoke("CaptureWindowContext"); Invoke("ObserveContext");
                Require((bool)typeof(RuntimeFrameMetrics).GetField("_contextStable", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics)
                    && config.Platform.ToString() == scopeJson && ReferenceEquals(configField.GetValue(dashboard), config),
                    "Reading scope identity mutated configuration or destabilized an unchanged context.");
                config.FactoryId = "factory-b"; Invoke("ObserveContext");
                Require(!(bool)typeof(RuntimeFrameMetrics).GetField("_contextStable", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics),
                    "A factory change with the same view/camera did not mark the frame context unstable.");
                Invoke("CaptureWindowContext"); config.Platform["activeScene"]["id"] = "scene-b"; Invoke("ObserveContext");
                Require(dashboard.ActiveSceneId == "scene-b"
                    && !(bool)typeof(RuntimeFrameMetrics).GetField("_contextStable", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics),
                    "A scene change with the same view/camera did not mark the frame context unstable.");
                config.Platform["activeScene"] = new JValue("invalid");
                Require(dashboard.ActiveSceneId == string.Empty, "Malformed scene metadata fabricated a usable scope.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
            Debug.Log("[RuntimeFrameMetricsValidation] PASS: real Unity percentiles, raw-frame bounds, unavailable timings, camera pose/stability, live-main switching and inactive telemetry.");
        }

        private static void ValidateActiveMainCamera(RuntimeFrameMetrics metrics, Camera oldMain, OrbitCameraController oldOrbit)
        {
            // Preserve all pre-existing scene main tags. This is a test-only
            // batch scene, never the user's running player, and nothing is saved.
            var priorMains = new List<Camera>();
            foreach (var camera in UnityEngine.Object.FindObjectsOfType<Camera>(true))
                if (camera.CompareTag("MainCamera")) priorMains.Add(camera);
            var originalTag = oldMain.gameObject.tag;
            GameObject newRoot = null;
            try
            {
                foreach (var camera in priorMains) camera.gameObject.tag = "Untagged";
                oldMain.gameObject.tag = "MainCamera";
                var type = typeof(RuntimeFrameMetrics);
                var refreshInfo = type.GetMethod("RefreshActiveCamera", BindingFlags.NonPublic | BindingFlags.Instance);
                var observeInfo = type.GetMethod("ObserveCamera", BindingFlags.NonPublic | BindingFlags.Instance);
                var refresh = (Action)Delegate.CreateDelegate(typeof(Action), metrics, refreshInfo);
                var observe = (Action)Delegate.CreateDelegate(typeof(Action), metrics, observeInfo);
                void Invoke(string name) => type.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(metrics, null);
                Camera Tracked() => (Camera)type.GetField("_camera", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics);
                bool Stable() => (bool)type.GetField("_cameraStable", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics);
                long Switches() => (long)type.GetField("_windowCameraSwitches", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(metrics);
                refresh(); Invoke("CaptureWindowContext");
                Require(Camera.main == oldMain && Tracked() == oldMain && Stable(), "Initial real main camera was not captured.");
                newRoot = new GameObject("__FrameMetricsNewMainCameraValidation") { hideFlags = HideFlags.HideAndDontSave };
                var newMain = newRoot.AddComponent<Camera>(); newRoot.AddComponent<OrbitCameraController>();
                newRoot.transform.position = oldMain.transform.position; newRoot.transform.rotation = oldMain.transform.rotation;
                newMain.fieldOfView = oldMain.fieldOfView;
                // Identical pose, but different active main identity. The old
                // camera intentionally stays alive, enabled and in the scene.
                oldMain.gameObject.tag = "Untagged"; newRoot.tag = "MainCamera";
                Invoke("CacheContext");
                Require(oldMain != null && oldMain.enabled && oldMain.gameObject.activeInHierarchy && Camera.main == newMain
                    && Tracked() == newMain && !Stable() && Switches() == 1,
                    "A main-camera switch retained the still-live old camera or falsely reported a stable window.");
                var evidence = (JObject)type.GetMethod("CameraContext", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(metrics, null);
                Require(evidence.Value<int>("instanceId") == newMain.GetInstanceID()
                    && evidence.Value<int>("windowStartInstanceId") == oldMain.GetInstanceID(),
                    "Camera evidence lost either the original or currently active main identity.");
                newRoot.tag = "Untagged"; oldMain.gameObject.tag = "MainCamera"; refresh();
                Require(Tracked() == oldMain && !Stable() && Switches() == 2,
                    "An out-and-back main switch was erased because its ending pose matched the beginning.");
                oldMain.gameObject.tag = "Untagged"; refresh();
                Require(Camera.main == null && Tracked() == null && !Stable() && Switches() == 3,
                    "A window without any active main kept reporting a stale live camera.");
                oldMain.gameObject.tag = "MainCamera"; refresh(); Invoke("CaptureWindowContext");
                Require(Tracked() == oldMain && Stable() && Switches() == 0,
                    "A later complete window did not recover its real active main context.");
                for (var index = 0; index < 2000; index++) { refresh(); observe(); }
                var before = GC.GetAllocatedBytesForCurrentThread();
                for (var index = 0; index < 10000; index++) { refresh(); observe(); }
                var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
                Require(allocated == 0, "Steady active-main resolution/pose sampling allocated managed bytes: " + allocated);
            }
            finally
            {
                oldMain.gameObject.tag = originalTag;
                if (newRoot != null) UnityEngine.Object.DestroyImmediate(newRoot);
                foreach (var camera in priorMains) if (camera != null) camera.gameObject.tag = "MainCamera";
            }
        }

        private static void Require(bool condition, string reason)
        {
            if (!condition) throw new Exception(reason);
        }
    }
}
