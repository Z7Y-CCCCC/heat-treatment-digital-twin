#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Loads production GLBs through the production library in an unsaved empty scene.
    // No backend, PLC, persisted scene, or existing equipment is started or modified.
    [InitializeOnLoad]
    public static class PitFurnaceSystemChecks
    {
        private const string Pending = "PitFurnaceSystemChecks.Pending";
        private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
        private static string Output => Path.GetFullPath(Path.Combine(Application.dataPath, "../../output"));

        static PitFurnaceSystemChecks()
        {
            EditorApplication.playModeStateChanged += state =>
            {
                if (state != PlayModeStateChange.EnteredPlayMode || !SessionState.GetBool(Pending, false)) return;
                SessionState.SetBool(Pending, false);
                RunPlaying();
            };
        }

        public static void Run()
        {
            if (EditorApplication.isPlaying) throw new InvalidOperationException("Start these checks outside Play Mode.");
            InspectionRuntimeChecks.Run();
            DeviceHoverRuntimeChecks.Run();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            SessionState.SetBool(Pending, true);
            EditorApplication.EnterPlaymode();
        }

        private static async void RunPlaying()
        {
            // The production AfterSceneLoad bootstrap also runs in an empty
            // Play Mode scene. This fixture owns its camera/library and must not
            // keep a second runtime/auth pipe or its automatic quality changes.
            var automaticRuntime = Object.FindObjectOfType<FactoryRuntime>();
            if (automaticRuntime != null) Object.DestroyImmediate(automaticRuntime.gameObject);
            var pipeline = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline as UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset;
            var previousRenderScale = pipeline != null ? pipeline.renderScale : 1f;
            if (pipeline != null) pipeline.renderScale = 1f;
            var checks = new JArray();
            var models = new JArray();
            var errors = new List<string>();
            var report = new JObject { ["status"] = "running", ["checks"] = checks, ["models"] = models, ["cadComponentCompletenessVerified"] = false };
            void Capture(string text, string stack, LogType type)
            {
                if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) errors.Add(text);
            }
            void Check(bool value, string text)
            {
                if (!value) throw new InvalidOperationException(text);
                checks.Add(text);
            }
            Application.logMessageReceived += Capture;
            FactoryDashboardController dashboard = null;
            try
            {
                await CheckAuthPipeShutdown(Check);
                RuntimeIndicatorChecks.Run();
                var assets = JArray.Parse(File.ReadAllText(Path.Combine(Output, "pit-furnace-native-manifest.json"))).ToObject<List<ModelAssetDto>>();
                Check(assets.Count == 5, "five production model assets");
                var host = new GameObject("PitFurnaceIsolatedTest");
                var library = host.AddComponent<RuntimeModelLibrary>();
                library.Configure("http://127.0.0.1:1", assets, 90f);
                var camera = new GameObject("Inspection Camera").AddComponent<Camera>();
                camera.aspect = 16f / 9f;
                camera.pixelRect = new Rect(0, 0, 1600, 900);
                camera.backgroundColor = new Color(.065f, .09f, .13f);
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.nearClipPlane = .01f;
                camera.farClipPlane = 500f;
                var orbit = camera.gameObject.AddComponent<OrbitCameraController>();
                dashboard = new GameObject("Inspection Dashboard").AddComponent<FactoryDashboardController>();
                dashboard.Initialize(camera, orbit, null);
                dashboard.BeginFactory(new FactoryConfigDto());
                dashboard.SetWebOverlayActive(true);
                JObject context = null;
                var contextMessages = 0;
                dashboard.InspectionContextChanged += value => { context = (JObject)value.DeepClone(); contextMessages++; };
                JObject overviewHover = null;
                dashboard.DeviceHoverUpdated += value => overviewHover = (JObject)value.DeepClone();
                RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
                RenderSettings.ambientLight = new Color(.65f, .7f, .8f);
                var light = new GameObject("Inspection key light").AddComponent<Light>();
                light.type = LightType.Directional;
                light.intensity = 2f;
                light.transform.rotation = Quaternion.Euler(45, -35, 0);
                var count = 0;
                foreach (var asset in assets)
                {
                    count++;
                    var device = new DeviceDto { Id = "PitFurnace_0" + count, Name = asset.Name, ModelType = asset.Id, Scale = 1f };
                    var instance = await library.InstantiateAsync(device, host.transform, CancellationToken.None);
                    Check(!instance.IsFallback && string.IsNullOrEmpty(instance.LoadError), asset.Id + " GLB loaded without fallback");
                    Check(instance.Bindings.Count == 0 && instance.Inspection.Enabled, asset.Id + " inspection enabled without invented PLC bindings");
                    var root = instance.Root;
                    root.AddComponent<DeviceStatusVisual>().Initialize(device, asset);
                    root.AddComponent<MobileDeviceMotion>().Initialize(device);
                    Check(!root.GetComponentsInChildren<Transform>(true).Any(t => t.name == "Runtime Status Beacon" || t.name == "移动中提示"), asset.Id + " no unrequested floating indicators");
                    var original = root.GetComponentsInChildren<Transform>(true).ToDictionary(t => t, t => t.localToWorldMatrix);
                    var renderers = root.GetComponentsInChildren<Renderer>(true);
                    Check(renderers.Length > 0 && renderers.All(r => r.sharedMaterials.All(m => m != null)), asset.Id + " meshes and materials resolved");
                    var preparationWatch = System.Diagnostics.Stopwatch.StartNew();
                    dashboard.RegisterDevice(device, root, instance.Inspection);
                    preparationWatch.Stop();
                    void Command(string name, string field = null, JToken value = null)
                    {
                        var command = new JObject { ["command"] = name };
                        if (field != null) command[field] = value;
                        Check(dashboard.ApplyInspectionCommand(device.Id, command, out var error), asset.Id + " command " + name + ": " + error);
                    }
                    Command("progress", "progress", 0f);
                    var hoverProfile = new JArray();
                    hoverProfile.Add(MeasurePicking(dashboard, renderers, "solid"));
                    Check(context["inspectionIssues"] is JArray issues && issues.Count == 0, asset.Id + " no missing or conflicting targets");
                    Check(((JArray)context["inspectionParts"]).Count == instance.Inspection.Parts.Count, asset.Id + " every assembly published to overlay");

                    // Exercise the actual mesh-click handler, not only metadata commands.
                    var click = typeof(FactoryDashboardController).GetMethod("SelectFromWorld", Private);
                    Vector3 ClickSurface(Ray surfaceRay)
                    {
                        // Feed a screen pointer to the exact method used by the
                        // mouse input loop, rather than invoking a ray helper
                        // that can pass even when the real route is disconnected.
                        camera.transform.position = surfaceRay.origin - surfaceRay.direction;
                        camera.transform.LookAt(surfaceRay.GetPoint(.01f));
                        var pointer = camera.WorldToScreenPoint(surfaceRay.GetPoint(.01f));
                        click.Invoke(dashboard, new object[] { pointer });
                        return pointer;
                    }
                    Ray? SurfaceRay(IEnumerable<Renderer> candidates)
                    {
                        foreach (var renderer in candidates.Where(r => r.enabled && !r.forceRenderingOff && r.gameObject.activeInHierarchy))
                        {
                            var mesh = renderer.GetComponent<MeshFilter>()?.sharedMesh;
                            if (mesh == null || !mesh.isReadable) continue;
                            var vertices = mesh.vertices;
                            var triangles = mesh.triangles;
                            for (var i = 0; i + 2 < triangles.Length; i += 3)
                            {
                                var a = renderer.transform.TransformPoint(vertices[triangles[i]]);
                                var b = renderer.transform.TransformPoint(vertices[triangles[i + 1]]);
                                var c = renderer.transform.TransformPoint(vertices[triangles[i + 2]]);
                                var normal = Vector3.Cross(b - a, c - a).normalized;
                                if (normal.sqrMagnitude < .5f) continue;
                                var point = (a + b + c) / 3f;
                                return new Ray(point + normal * .01f, -normal);
                            }
                        }
                        return null;
                    }
                    Command("stage", "stage", "solid");
                    var ray = SurfaceRay(renderers);
                    Check(ray.HasValue, asset.Id + " real geometry provides a click ray");
                    ClickSurface(ray.Value);
                    Check(context.Value<string>("inspectionStage") == "xray", asset.Id + " model click enters xray");
                    hoverProfile.Add(MeasurePicking(dashboard, renderers, "xray"));
                    ClickSurface(ray.Value);
                    Check(context.Value<string>("inspectionStage") == "exploded", asset.Id + " second model click starts disassembly");
                    Command("progress", "progress", 1f);
                    hoverProfile.Add(MeasurePicking(dashboard, renderers, "exploded"));
                    Check(original.Any(pair => MatrixDifference(pair.Key.localToWorldMatrix, pair.Value) > .1f), asset.Id + " exploded transforms actually move");
                    Command("pause");
                    Command("resume");
                    Command("labels", "enabled", false);
                    Check(!context.Value<bool>("inspectionLabelsEnabled"), asset.Id + " labels hide");
                    Command("labels", "enabled", true);
                    var partClicks = 0;
                    var clickPressure = new JArray();
                    foreach (var part in instance.Inspection.Parts)
                    {
                        Command("select", "partId", part.Id);
                        if (partClicks == 0) hoverProfile.Add(MeasurePicking(dashboard, renderers, "part"));
                        Check(context.Value<string>("partId") == part.Id && context.Value<string>("partName") == part.Name, asset.Id + " detail " + part.Id);
                        Command("isolate", "enabled", true);
                        Check(context.Value<bool>("inspectionIsolated"), asset.Id + " isolation " + part.Id);
                        var partRay = SurfaceRay(renderers);
                        Check(partRay.HasValue, asset.Id + " isolated part has visible triangles " + part.Id);
                        var selected = typeof(FactoryDashboardController).GetField("_selected", Private).GetValue(dashboard);
                        var runtime = selected.GetType().GetField("Inspection", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).GetValue(selected);
                        var picked = typeof(FactoryDashboardController).GetMethod("PickInspectionPart", Private).Invoke(dashboard, new object[] { runtime, partRay.Value });
                        var pickedConfig = picked?.GetType().GetField("Config").GetValue(picked) as DeviceInspectionPartDto;
                        Check(pickedConfig != null && pickedConfig.Id == part.Id, asset.Id + " raycast returns exact assembly " + part.Id);
                        var clickPointer = ClickSurface(partRay.Value);
                        Check(context.Value<string>("partId") == part.Id, asset.Id + " triangle picking " + part.Id);
                        if (partClicks == 0 || part.Id == "pf2_fixture")
                        {
                            Command("pause");
                            typeof(FactoryDashboardController).GetMethod("UpdateInspectionHoverAt", Private)
                                .Invoke(dashboard, new object[] { clickPointer, false });
                            var runtimeType = runtime.GetType();
                            var queryFence = (int)runtimeType.GetField("PickQueryCount").GetValue(runtime);
                            var messageFence = contextMessages;
                            var targetFence = typeof(OrbitCameraController).GetField("_desiredTarget", Private).GetValue(orbit);
                            var distanceFence = typeof(OrbitCameraController).GetField("_desiredDistance", Private).GetValue(orbit);
                            var times = new List<double>();
                            var burst = System.Diagnostics.Stopwatch.StartNew();
                            for (var repeated = 0; repeated < 200; repeated++)
                            {
                                var step = System.Diagnostics.Stopwatch.StartNew();
                                click.Invoke(dashboard, new object[] { clickPointer });
                                step.Stop(); times.Add(step.Elapsed.TotalMilliseconds);
                            }
                            burst.Stop(); times.Sort();
                            Check(context.Value<string>("inspectionStage") == "part" && context.Value<string>("partId") == part.Id
                                && (bool)runtimeType.GetField("Paused").GetValue(runtime) && (bool)runtimeType.GetField("Isolated").GetValue(runtime),
                                asset.Id + " 200 repeated world clicks preserve selected part/pause/isolation " + part.Id);
                            Check(contextMessages == messageFence && (int)runtimeType.GetField("PickQueryCount").GetValue(runtime) == queryFence,
                                asset.Id + " repeated world clicks generate no redundant ray queries/full-context traffic " + part.Id);
                            Check(Equals(targetFence, typeof(OrbitCameraController).GetField("_desiredTarget", Private).GetValue(orbit))
                                && Equals(distanceFence, typeof(OrbitCameraController).GetField("_desiredDistance", Private).GetValue(orbit)),
                                asset.Id + " repeated world clicks preserve camera destination " + part.Id);
                            Check(burst.Elapsed.TotalSeconds < 10, asset.Id + " 200 world clicks complete without a main-thread stall " + part.Id);
                            clickPressure.Add(new JObject { ["partId"] = part.Id, ["clicks"] = 200, ["totalMs"] = burst.Elapsed.TotalMilliseconds,
                                ["p95Ms"] = times[190], ["maxMs"] = times.Last(), ["newRayQueries"] = 0, ["newContextMessages"] = 0 });
                            // Also cross real rendered frames. Change the camera
                            // slightly so this cannot pass solely by exercising
                            // the unchanged-snapshot cache fast path. The orbit
                            // is disabled only to retain the controlled fixture
                            // camera; the production dashboard keeps updating.
                            var frameTarget = new RenderTexture(1600, 900, 24);
                            var priorTarget = camera.targetTexture;
                            var priorOrbitEnabled = orbit.enabled;
                            var frameWatch = System.Diagnostics.Stopwatch.StartNew();
                            var frameQueryFence = (int)runtimeType.GetField("PickQueryCount").GetValue(runtime);
                            var frameMessageFence = contextMessages;
                            var frameStateValid = true;
                            try
                            {
                                orbit.enabled = false;
                                camera.targetTexture = frameTarget;
                                for (var frame = 0; frame < 20; frame++)
                                {
                                    camera.transform.position += Vector3.up * (frame % 2 == 0 ? .002f : -.002f);
                                    camera.transform.LookAt(partRay.Value.GetPoint(.01f));
                                    var pointer = camera.WorldToScreenPoint(partRay.Value.GetPoint(.01f));
                                    click.Invoke(dashboard, new object[] { pointer });
                                    typeof(FactoryDashboardController).GetMethod("DrawInspectionHover", Private).Invoke(dashboard, new[] { runtime });
                                    camera.Render();
                                    await Task.Yield();
                                    frameStateValid &= context.Value<string>("inspectionStage") == "part" && context.Value<string>("partId") == part.Id
                                        && (bool)runtimeType.GetField("Paused").GetValue(runtime) && (bool)runtimeType.GetField("Isolated").GetValue(runtime);
                                }
                            }
                            finally
                            {
                                camera.targetTexture = priorTarget;
                                orbit.enabled = priorOrbitEnabled;
                                frameTarget.Release(); Object.Destroy(frameTarget);
                                frameWatch.Stop();
                            }
                            Check(frameStateValid, asset.Id + " 20 rendered-frame clicks retain selected part/pause/isolation " + part.Id);
                            var frameQueries = (int)runtimeType.GetField("PickQueryCount").GetValue(runtime) - frameQueryFence;
                            Check(frameQueries >= 20, asset.Id + " rendered-frame camera motion invalidates stale pick snapshots " + part.Id);
                            Check(Equals(targetFence, typeof(OrbitCameraController).GetField("_desiredTarget", Private).GetValue(orbit))
                                && Equals(distanceFence, typeof(OrbitCameraController).GetField("_desiredDistance", Private).GetValue(orbit)),
                                asset.Id + " rendered-frame repeated clicks do not restart camera focus " + part.Id);
                            clickPressure.Add(new JObject { ["partId"] = part.Id, ["clicks"] = 20, ["renderedFrames"] = 20,
                                ["cameraInvalidation"] = true, ["totalMs"] = frameWatch.Elapsed.TotalMilliseconds,
                                ["newRayQueries"] = frameQueries, ["periodicContextMessages"] = contextMessages - frameMessageFence });
                            Command("resume");
                        }
                        partClicks++;
                        Command("isolate", "enabled", false);
                    }
                    Command("clear");
                    // Render the actual loaded GLB in an exploded pose for visual review.
                    var bounds = BoundsOf(renderers.Where(r => !r.forceRenderingOff));
                    orbit.enabled = false;
                    camera.transform.position = bounds.center + new Vector3(1.1f, .75f, 1.6f).normalized * bounds.size.magnitude * 1.2f;
                    camera.transform.LookAt(bounds.center);
                    Render(camera, Path.Combine(Output, asset.Id + "-native-exploded.png"));
                    Command("progress", "progress", 0f);
                    Check(original.All(pair => MatrixDifference(pair.Key.localToWorldMatrix, pair.Value) < .001f), asset.Id + " complete transform restoration");
                    Check(renderers.All(r => !r.forceRenderingOff), asset.Id + " complete visibility restoration");
                    bounds = BoundsOf(renderers);
                    camera.transform.position = bounds.center + new Vector3(1.1f, .7f, 1.6f).normalized * bounds.size.magnitude * 1.25f;
                    camera.transform.LookAt(bounds.center);
                    Render(camera, Path.Combine(Output, asset.Id + "-native-solid.png"));
                    // Reuse real, visible triangle geometry, never a proxy collider.
                    var overviewRay = SurfaceRay(renderers);
                    Check(overviewRay.HasValue, asset.Id + " overview has visible device triangles");
                    var overviewPoint = overviewRay.Value.GetPoint(.01f);
                    var overviewAt = typeof(FactoryDashboardController).GetMethod("UpdateDeviceHoverAt", Private);
                    foreach (var overviewId in new[] { "factory_overview", "workshop_overview", "line_overview" })
                    {
                        dashboard.FocusPreviewBounds(bounds, dashboard.GetConfiguredView(overviewId));
                        camera.transform.position = overviewRay.Value.origin - overviewRay.Value.direction;
                        camera.transform.LookAt(overviewPoint);
                        var pointer = camera.WorldToScreenPoint(overviewPoint);
                        overviewAt.Invoke(dashboard, new object[] { pointer, false });
                        Check(overviewHover?.Value<string>("hoveredDeviceId") == device.Id && overviewHover.Value<string>("viewId") == overviewId,
                            asset.Id + " whole-device hover on " + overviewId);
                        var clickedDevice = typeof(FactoryDashboardController).GetMethod("PickOverviewDevice", Private).Invoke(dashboard, new object[] { pointer });
                        var clickedDto = clickedDevice?.GetType().GetField("Device").GetValue(clickedDevice) as DeviceDto;
                        Check(clickedDto?.Id == device.Id, asset.Id + " overview click matches hover on " + overviewId);
                    }
                    var overviewTimings = new List<double>();
                    for (var sample = 0; sample < 96; sample++)
                    {
                        var pointer = camera.WorldToScreenPoint(overviewPoint) + new Vector3((sample % 9) - 4, ((sample / 9) % 9) - 4, 0);
                        var watch = System.Diagnostics.Stopwatch.StartNew();
                        overviewAt.Invoke(dashboard, new object[] { pointer, false });
                        watch.Stop(); overviewTimings.Add(watch.Elapsed.TotalMilliseconds);
                    }
                    overviewTimings.Sort();
                    hoverProfile.Add(new JObject { ["stage"] = "overview_device", ["samples"] = overviewTimings.Count,
                        ["p95Ms"] = overviewTimings[(int)(overviewTimings.Count * .95f)], ["maxMs"] = overviewTimings.Last() });
                    orbit.enabled = true;
                    models.Add(new JObject { ["id"] = asset.Id, ["renderers"] = renderers.Length, ["assemblies"] = instance.Inspection.Parts.Count, ["partTrianglePicks"] = partClicks, ["fallback"] = false, ["preparationMs"] = preparationWatch.Elapsed.TotalMilliseconds, ["hoverProfile"] = hoverProfile, ["worldClickPressure"] = clickPressure });
                    dashboard.ClearFactory();
                    root.SetActive(false);
                    Object.Destroy(root);
                    await Task.Yield();
                    Debug.Log("[PitSystemChecks] PASS " + asset.Id);
                }
                Check(errors.Count == 0, "no native error or exception logs: " + string.Join("; ", errors));
                report["status"] = "passed";
            }
            catch (Exception exception)
            {
                report["status"] = "failed";
                report["error"] = exception.ToString();
            }
            finally
            {
                if (pipeline != null) pipeline.renderScale = previousRenderScale;
                Application.logMessageReceived -= Capture;
                if (dashboard != null) dashboard.ClearFactory();
                report["checkCount"] = checks.Count;
                report["runtimeErrors"] = new JArray(errors);
                File.WriteAllText(Path.Combine(Output, "pit-furnace-native-system-report.json"), report.ToString());
                var profileLabel = Environment.GetEnvironmentVariable("INSPECTION_PROFILE_LABEL");
                if (profileLabel == "before" || profileLabel == "after")
                    File.WriteAllText(Path.Combine(Output, "inspection-hover-" + profileLabel + ".json"), report.ToString());
                Debug.Log("[PitSystemChecks] " + report.Value<string>("status") + " checks=" + checks.Count);
                EditorApplication.Exit(report.Value<string>("status") == "passed" ? 0 : 1);
            }
        }

        private static async Task CheckAuthPipeShutdown(Action<bool, string> check)
        {
            // AfterSceneLoad bootstrap can run after EnteredPlayMode. Let it
            // finish before isolating these self-owned runtime lifecycle tests.
            await Task.Yield();
            foreach (var automatic in Object.FindObjectsOfType<FactoryRuntime>())
            {
                var thread = typeof(FactoryRuntime).GetField("_nativeAuthPipeThread", Private).GetValue(automatic) as Thread;
                Object.DestroyImmediate(automatic.gameObject);
                check(thread == null || !thread.IsAlive, "automatic runtime auth listener stops after destruction");
            }
            foreach (var connected in new[] { false, true })
            {
                var root = new GameObject("OwnedAuthPipeShutdownFixture");
                NamedPipeClientStream client = null;
                try
                {
                    var runtime = root.AddComponent<FactoryRuntime>();
                    await Task.Yield();
                    var thread = typeof(FactoryRuntime).GetField("_nativeAuthPipeThread", Private).GetValue(runtime) as Thread;
                    check(thread != null && thread.IsAlive, "self-owned auth listener starts: connected=" + connected);
                    if (connected)
                    {
                        client = new NamedPipeClientStream(".", "HeatTreatmentUnityAuth_" + System.Diagnostics.Process.GetCurrentProcess().Id,
                            PipeDirection.InOut, PipeOptions.Asynchronous);
                        await client.ConnectAsync(1500, CancellationToken.None);
                        // Deliberately send no line. Destruction, not client EOF,
                        // must release the listener's blocked ReadLine.
                        await Task.Yield();
                        await Task.Yield();
                    }
                    var watch = System.Diagnostics.Stopwatch.StartNew();
                    Object.DestroyImmediate(root); root = null;
                    watch.Stop();
                    check(!thread.IsAlive, "destroyed auth listener terminates without an external wakeup: connected=" + connected);
                    check(watch.Elapsed.TotalSeconds < 2, "auth listener shutdown is bounded: connected=" + connected);
                }
                finally
                {
                    if (root != null) Object.DestroyImmediate(root);
                    client?.Dispose();
                }
            }
        }

        private static float MatrixDifference(Matrix4x4 a, Matrix4x4 b)
        {
            var difference = 0f;
            for (var i = 0; i < 16; i++) difference = Mathf.Max(difference, Mathf.Abs(a[i] - b[i]));
            return difference;
        }

        private static JObject MeasurePicking(FactoryDashboardController dashboard, Renderer[] renderers, string stage)
        {
            var selected = typeof(FactoryDashboardController).GetField("_selected", Private).GetValue(dashboard);
            var runtime = selected.GetType().GetField("Inspection", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).GetValue(selected);
            var pick = typeof(FactoryDashboardController).GetMethod("PickInspectionPart", Private);
            var bounds = BoundsOf(renderers);
            var direction = new Vector3(1.1f, .7f, 1.6f).normalized;
            var origin = bounds.center + direction * Mathf.Max(10f, bounds.size.magnitude * 1.5f);
            var rays = renderers.Where(r => r.enabled && !r.forceRenderingOff && r.gameObject.activeInHierarchy)
                .Select(r => new Ray(origin, r.bounds.center - origin)).Take(128).ToArray();
            var samples = new List<double>();
            var watch = new System.Diagnostics.Stopwatch();
            var arguments = new object[] { runtime, default(Ray) };
            foreach (var ray in rays)
            {
                arguments[1] = ray; watch.Restart(); pick.Invoke(dashboard, arguments); watch.Stop();
                samples.Add(watch.Elapsed.TotalMilliseconds);
            }
            var coldMax = samples.Count == 0 ? 0d : samples.Max();
            samples.Clear();
            for (var pass = 0; pass < 3; pass++) foreach (var ray in rays)
            {
                arguments[1] = ray; watch.Restart(); pick.Invoke(dashboard, arguments); watch.Stop();
                samples.Add(watch.Elapsed.TotalMilliseconds);
            }
            samples.Sort();
            var assisted = typeof(FactoryDashboardController).GetMethod("PickInspectionPartAt", Private);
            var camera = (Camera)typeof(FactoryDashboardController).GetField("_camera", Private).GetValue(dashboard);
            var position = camera.transform.position; var rotation = camera.transform.rotation;
            var assistance = new List<double>();
            try
            {
                camera.transform.position = origin; camera.transform.LookAt(bounds.center);
                var pointers = renderers.Where(r => r.enabled && !r.forceRenderingOff && r.gameObject.activeInHierarchy)
                    .Take(32).Select(r => camera.WorldToScreenPoint(r.bounds.center) + Vector3.right * 5f).ToArray();
                foreach (var point in pointers) assisted.Invoke(dashboard, new object[] { runtime, point });
                for (var pass = 0; pass < 3; pass++) foreach (var point in pointers)
                {
                    arguments[1] = point; watch.Restart(); assisted.Invoke(dashboard, arguments); watch.Stop();
                    assistance.Add(watch.Elapsed.TotalMilliseconds);
                }
                assistance.Sort();
            }
            finally { camera.transform.SetPositionAndRotation(position, rotation); }
            return new JObject { ["stage"] = stage, ["samples"] = samples.Count, ["coldSweepMaxMs"] = coldMax,
                ["warmP50Ms"] = samples.Count == 0 ? 0 : samples[samples.Count / 2],
                ["warmP95Ms"] = samples.Count == 0 ? 0 : samples[Math.Min(samples.Count - 1, (int)(samples.Count * .95))],
                ["warmMaxMs"] = samples.Count == 0 ? 0 : samples[samples.Count - 1],
                ["assistedP95Ms"] = assistance.Count == 0 ? 0 : assistance[Math.Min(assistance.Count - 1, (int)(assistance.Count * .95))],
                ["assistedMaxMs"] = assistance.Count == 0 ? 0 : assistance[assistance.Count - 1] };
        }

        private static Bounds BoundsOf(IEnumerable<Renderer> source)
        {
            var renderers = source.ToArray();
            var bounds = renderers[0].bounds;
            foreach (var renderer in renderers.Skip(1)) bounds.Encapsulate(renderer.bounds);
            return bounds;
        }

        private static void Render(Camera camera, string path)
        {
            var target = new RenderTexture(1280, 720, 24);
            var previous = RenderTexture.active;
            var texture = new Texture2D(1280, 720, TextureFormat.RGB24, false);
            try
            {
                camera.targetTexture = target;
                camera.Render();
                RenderTexture.active = target;
                texture.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
                texture.Apply();
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            finally
            {
                camera.targetTexture = null;
                RenderTexture.active = previous;
                target.Release();
                Object.Destroy(target);
                Object.Destroy(texture);
            }
        }
    }
}
#endif
