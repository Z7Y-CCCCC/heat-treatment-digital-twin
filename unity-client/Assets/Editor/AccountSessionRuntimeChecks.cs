#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Core;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Calls the actual FactoryRuntime session activation on an isolated preview
    // scene. An invalid transport URL guarantees no network or PLC is contacted.
    public static class AccountSessionRuntimeChecks
    {
        public static void RunAndBuildExistingClient()
        {
            Run();
            RuntimeIndicatorChecks.BuildExistingClient();
        }

        public static void Run()
        {
            var scene = EditorSceneManager.NewPreviewScene();
            var checks = new List<string>();
            GameObject Create(string name)
            {
                var obj = new GameObject(name);
                obj.SetActive(false);
                SceneManager.MoveGameObjectToScene(obj, scene);
                return obj;
            }
            var host = Create("AccountSessionFixture");
            var runtime = host.AddComponent<FactoryRuntime>();
            runtime.enabled = false;
            FieldInfo Field(string name) => typeof(FactoryRuntime).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)
                ?? throw new InvalidOperationException("Missing field: " + name);
            void Set(string name, object value) => Field(name).SetValue(runtime, value);
            void Check(bool result, string name)
            {
                if (!result) throw new InvalidOperationException("AccountSessionChecks: " + name);
                checks.Add(name);
                Debug.Log("[AccountSessionChecks] PASS " + name);
            }
            try
            {
                var factory = Create("RuntimeFactoryFixture").transform;
                var device = Create("DeviceFixture").transform;
                device.SetParent(factory, false);
                device.localPosition = new Vector3(3, 4, 5);
                var camera = Create("CameraFixture").AddComponent<Camera>();
                camera.transform.position = new Vector3(7, 8, 9);
                Set("_factoryRoot", factory);
                Set("_camera", camera);
                Set("_api", new BackendApiClient("http://127.0.0.1:1"));
                Set("_settings", new NativeClientSettings { backendHttpUrl = "http://127.0.0.1:1", backendWebSocketUrl = "http://invalid-transport" });
                Set("_webSocket", host.AddComponent<RealtimeWebSocketClient>());
                Set("_diagnostics", host.AddComponent<RuntimeDiagnosticsOverlay>());
                Set("_authenticated", true);
                Set("_sceneReady", true);
                Set("_configurationReloadVersion", 19);
                var devices = (Dictionary<string, Transform>)Field("_deviceRoots").GetValue(runtime);
                devices.Add("device", device);
                var frames = (Dictionary<string, JObject>)Field("_latestDeviceFrames").GetValue(runtime);
                frames.Add("device", new JObject { ["temperature"] = 700 });
                var activate = typeof(FactoryRuntime).GetMethod("ActivateAuthenticatedSession", BindingFlags.NonPublic | BindingFlags.Instance);
                for (var index = 0; index < 12; index++) activate.Invoke(runtime, new object[] {
                    new NativeLoginResult { Authenticated = true, CanLaunch = true, CanView = true, DisplayName = "Customer " + index }
                });
                Check(ReferenceEquals(Field("_factoryRoot").GetValue(runtime), factory) && devices["device"] == device, "twelve account switches preserve the exact factory/device instances");
                Check(camera.transform.position == new Vector3(7, 8, 9) && device.localPosition == new Vector3(3, 4, 5), "camera and running equipment poses remain unchanged");
                Check((int)Field("_configurationReloadVersion").GetValue(runtime) == 19 && (bool)Field("_sceneReady").GetValue(runtime), "account identity updates never enter BeginReload or reset scene readiness");
                Check(frames["device"].Value<int>("temperature") == 700, "the latest PLC frame remains available");
                var loading = new CancellationTokenSource();
                Set("_reload", loading);
                Set("_sceneReady", false);
                activate.Invoke(runtime, new object[] { new NativeLoginResult { Authenticated = true, CanLaunch = true, CanView = true } });
                Check(ReferenceEquals(Field("_reload").GetValue(runtime), loading) && !loading.IsCancellationRequested,
                    "switching during initial loading does not cancel and rebuild that same scene");
                try
                {
                    activate.Invoke(runtime, new object[] { new NativeLoginResult { Authenticated = true, CanLaunch = true, CanView = false } });
                    throw new InvalidOperationException("View denial was ignored");
                }
                catch (TargetInvocationException exception)
                {
                    Check(exception.InnerException is BackendRequestException error && error.StatusCode == 403,
                        "an account without view permission is rejected before scene activation");
                }
                var filename = Path.GetFullPath("../output/account-session-native-checks.json");
                File.WriteAllText(filename, new JObject { ["success"] = true, ["checks"] = JArray.FromObject(checks) }.ToString());
                Debug.Log("[AccountSessionChecks] PASS " + checks.Count + " checks");
            }
            finally
            {
                Object.DestroyImmediate(host);
                EditorSceneManager.ClosePreviewScene(scene);
            }
        }
    }
}
#endif
