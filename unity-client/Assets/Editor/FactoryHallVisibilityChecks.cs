#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Production loader, ground generator and mesh picker in an unsaved,
    // isolated scene. No live backend, credentials or PLC are used.
    [InitializeOnLoad]
    public static class FactoryHallVisibilityChecks
    {
        private const string Pending = "FactoryHallVisibilityChecks.Pending";
        private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
        static FactoryHallVisibilityChecks()
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
            ProjectBootstrap.ValidateAuthoredHallMaterials();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            SessionState.SetBool(Pending, true);
            EditorApplication.EnterPlaymode();
        }

        private static async void RunPlaying()
        {
            var directory = Environment.GetEnvironmentVariable("HALL_CHECK_DIRECTORY");
            var checks = new JArray();
            var errors = new List<string>();
            var report = new JObject { ["success"] = false, ["checks"] = checks };
            void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); checks.Add(message); }
            void Capture(string message, string stack, LogType type) { if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) errors.Add(message); }
            Application.logMessageReceived += Capture;
            try
            {
                var runtime = Object.FindObjectOfType<FactoryRuntime>();
                if (runtime != null) Object.DestroyImmediate(runtime.gameObject);
                DeviceHoverRuntimeChecks.Run();
                var fixture = JObject.Parse(File.ReadAllText(Path.Combine(directory, "fixture.json")));
                var config = fixture["config"].ToObject<FactoryConfigDto>();
                var devices = fixture["devices"].ToObject<List<DeviceDto>>();
                Check(devices.Count == 17, "17 CAD objects in isolated native fixture");
                var host = new GameObject("Hall Visibility Fixture");
                var environment = host.AddComponent<FactoryEnvironmentBuilder>();
                var camera = environment.EnsureCamera();
                environment.BuildLightingAndPostProcessing();
                environment.ApplySettings(config.Settings);
                environment.RebuildFactoryFloor(config, devices);
                await environment.HallReady;
                Check(environment.HasFactoryHall, "production hall GLB loaded, not fallback geometry");
                var hall = Object.FindObjectOfType<FactoryHallPresentation>();
                Check(hall != null && hall.MaterialCount > 0, "hall owns a bounded set of ghost materials");
                var hallRenderers = hall.GetComponentsInChildren<Renderer>(true);
                var walls = hallRenderers.Where(r => !FactoryHallPresentation.IsFloor(r)).ToArray();
                Check(walls.Length > 0 && walls.All(r => !r.receiveShadows && r.shadowCastingMode == ShadowCastingMode.Off), "architecture never casts opaque shadows on equipment");
                Check(walls.SelectMany(r => r.sharedMaterials).All(m => m.shader.name == "HeatTreatment/FactoryHallGhost" && Mathf.Approximately(m.GetFloat("_Opacity"), .1f)), "all architecture uses 10 percent opacity and the production transparent shader");
                Check(!hall.GetComponentsInChildren<Collider>(true).Any(c => c.enabled), "hall has no active physics picking obstruction");
                var floors = hallRenderers.Where(FactoryHallPresentation.IsFloor).ToArray();
                Check(floors.Length > 0 && floors.All(r => !r.enabled), "original solid hall floor hidden in favor of actual industrial pits");
                Check(IndustrialGroundPlan.Resolve(config.Workshops.Single(), devices).Areas.Count == 10, "all ten real pit cutouts retained");

                // Shared source material, opaque ground and cleanup contract.
                var shared = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                var materialFixture = new GameObject("Shared material fixture");
                Renderer Cube(string name) { var cube = GameObject.CreatePrimitive(PrimitiveType.Cube); cube.name = name; cube.transform.SetParent(materialFixture.transform); var r = cube.GetComponent<Renderer>(); r.sharedMaterial = shared; return r; }
                var wall = Cube("wall"); var roof = Cube("roof"); var floor = Cube("floor");
                var owner = FactoryHallPresentation.Apply(materialFixture);
                var ghost = wall.sharedMaterial;
                Check(owner.MaterialCount == 1 && ghost == roof.sharedMaterial && ghost != shared && floor.sharedMaterial == shared, "wall and roof share one owned clone, floor and source remain opaque");
                Check(FactoryHallPresentation.Apply(materialFixture) == owner && owner.MaterialCount == 1, "repeated application does not allocate more materials");
                Object.DestroyImmediate(materialFixture); await System.Threading.Tasks.Task.Yield();
                Check(ghost == null && shared != null, "hall teardown releases only its owned materials");
                Object.DestroyImmediate(shared);

                var library = host.AddComponent<RuntimeModelLibrary>();
                library.Configure("http://127.0.0.1:1", config.Models, 90f);
                camera.tag = "MainCamera"; camera.aspect = 16f / 9f;
                camera.pixelRect = new Rect(0, 0, 1600, 900); camera.nearClipPlane = .01f; camera.farClipPlane = 500f;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.065f, .085f, .11f);
                var orbit = camera.GetComponent<OrbitCameraController>();
                var dashboard = host.AddComponent<FactoryDashboardController>();
                dashboard.Initialize(camera, orbit, null); dashboard.BeginFactory(config); dashboard.SetWebOverlayActive(true);
                JObject context = null; dashboard.InspectionContextChanged += value => context = value;
                var roots = new Dictionary<string, GameObject>();
                foreach (var device in devices)
                {
                    var instance = await library.InstantiateAsync(device, host.transform, CancellationToken.None);
                    Check(!instance.IsFallback && string.IsNullOrEmpty(instance.LoadError), device.Id + " production equipment GLB loaded");
                    roots[device.Id] = instance.Root;
                    dashboard.RegisterDevice(device, instance.Root, instance.Inspection);
                }
                var materials = roots.Values.SelectMany(r => r.GetComponentsInChildren<Renderer>()).ToDictionary(r => r, r => r.sharedMaterials.ToArray());
                var bounds = new Bounds(new Vector3(0, 0, 0), new Vector3(64, 12, 18));
                dashboard.UpdatePreviewFactoryBounds(bounds);
                orbit.enabled = false;
                var pick = typeof(FactoryDashboardController).GetMethod("PickOverviewDevice", Private);
                var click = typeof(FactoryDashboardController).GetMethod("SelectFromWorld", Private);
                foreach (var device in devices)
                {
                    dashboard.FocusPreviewBounds(bounds);
                    orbit.enabled = false;
                    var hit = false;
                    foreach (var r in roots[device.Id].GetComponentsInChildren<Renderer>().Where(r => r.enabled))
                    {
                        var mesh = r.GetComponent<MeshFilter>()?.sharedMesh;
                        if (mesh == null || !mesh.isReadable) continue;
                        var vertices = mesh.vertices; var triangles = mesh.triangles;
                        for (var i = 0; i + 2 < triangles.Length; i += Math.Max(3, triangles.Length / 90 / 3 * 3))
                        {
                            var a = r.transform.TransformPoint(vertices[triangles[i]]); var b = r.transform.TransformPoint(vertices[triangles[i + 1]]); var c = r.transform.TransformPoint(vertices[triangles[i + 2]]);
                            var normal = Vector3.Cross(b - a, c - a).normalized;
                            if (normal.sqrMagnitude < .5f) continue;
                            var target = (a + b + c) / 3;
                            camera.transform.position = target + normal * 12;
                            camera.transform.LookAt(target);
                            var pointer = camera.WorldToScreenPoint(target);
                            var selected = pick.Invoke(dashboard, new object[] { pointer });
                            var selectedDevice = selected?.GetType().GetField("Device").GetValue(selected) as DeviceDto;
                            if (selectedDevice?.Id != device.Id) continue;
                            click.Invoke(dashboard, new object[] { pointer });
                            Check(context?.Value<string>("deviceId") == device.Id, device.Id + " real mesh pointer opens correct device with architecture present");
                            hit = true; break;
                        }
                        if (hit) break;
                    }
                    Check(hit, device.Id + " has a reachable precise mesh click target");
                }
                dashboard.FocusPreviewBounds(bounds); orbit.enabled = false;
                foreach (var pair in materials) Check(pair.Value.SequenceEqual(pair.Key.sharedMaterials), pair.Key.name + " equipment material unchanged");
                // Deterministic native renders of the production hall, equipment and ground.
                // This is a render-to-texture check, not desktop/computer automation.
                camera.transform.position = new Vector3(0, 8, -67); camera.transform.LookAt(new Vector3(0, 0, 0));
                Save(camera, Path.Combine(directory, "native-hall-front.png"));
                camera.transform.position = new Vector3(-38, 28, -45); camera.transform.LookAt(new Vector3(0, -1, 0));
                var baselinePixels = Save(camera, Path.Combine(directory, "native-hall-oblique.png"));
                var hover = typeof(FactoryDashboardController).GetMethod("UpdateDeviceHoverAt", Private);
                var draw = typeof(FactoryDashboardController).GetMethod("DrawDeviceHover", Private);
                var outlined = false;
                foreach (var r in roots["PitFurnace_01"].GetComponentsInChildren<Renderer>())
                {
                    var mesh = r.GetComponent<MeshFilter>()?.sharedMesh;
                    if (mesh == null || !mesh.isReadable) continue;
                    var vertices = mesh.vertices; var triangles = mesh.triangles;
                    for (var i = 0; i + 2 < triangles.Length; i += Math.Max(3, triangles.Length / 100 / 3 * 3))
                    {
                        var target = r.transform.TransformPoint((vertices[triangles[i]] + vertices[triangles[i + 1]] + vertices[triangles[i + 2]]) / 3);
                        var pointer = camera.WorldToScreenPoint(target);
                        if (pointer.z <= 0 || pointer.x < 0 || pointer.x > 1600 || pointer.y < 0 || pointer.y > 900) continue;
                        var selected = pick.Invoke(dashboard, new object[] { pointer });
                        if ((selected?.GetType().GetField("Device").GetValue(selected) as DeviceDto)?.Id != "PitFurnace_01") continue;
                        hover.Invoke(dashboard, new object[] { pointer, false });
                        Check((int)draw.Invoke(dashboard, null) > 0, "actual hovered CAD furnace submits only equipment outline meshes");
                        var highlightedPixels = Save(camera, Path.Combine(directory, "native-hall-hover-outline.png"));
                        var edgePixels = highlightedPixels.Where((p, index) => p.b > baselinePixels[index].b + 30 && p.g > baselinePixels[index].g + 20).Count();
                        Check(edgePixels > 50 && edgePixels < baselinePixels.Length / 20, "native rendered outline is visible and narrow, not a full-screen tint");
                        report["outlineEdgePixels"] = edgePixels;
                        outlined = true; break;
                    }
                    if (outlined) break;
                }
                Check(outlined, "overview has a precise visible furnace hover target");
                Check(errors.Count == 0, "native load, shader and rendering have no errors");
                report["success"] = true; report["hallMeshes"] = hallRenderers.Length; report["ownedMaterials"] = hall.MaterialCount;
            }
            catch (Exception error) { report["error"] = error.ToString(); Debug.LogException(error); }
            finally
            {
                Application.logMessageReceived -= Capture;
                report["errors"] = JArray.FromObject(errors);
                File.WriteAllText(Path.Combine(directory, "native-result.json"), report.ToString());
                Debug.Log("[HallVisibilityChecks] " + report.Value<bool>("success"));
                EditorApplication.Exit(report.Value<bool>("success") ? 0 : 1);
            }
        }

        private static Color32[] Save(Camera camera, string file)
        {
            var target = RenderTexture.GetTemporary(1600, 900, 24);
            var texture = new Texture2D(1600, 900, TextureFormat.RGB24, false);
            var previous = RenderTexture.active;
            try { camera.targetTexture = target; camera.Render(); RenderTexture.active = target; texture.ReadPixels(new Rect(0, 0, 1600, 900), 0, 0); texture.Apply(); File.WriteAllBytes(file, texture.EncodeToPNG()); return texture.GetPixels32(); }
            finally { camera.targetTexture = null; RenderTexture.active = previous; RenderTexture.ReleaseTemporary(target); Object.Destroy(texture); }
        }

        public static void BuildExistingClient()
        {
            ProjectBootstrap.ValidateAuthoredHallMaterials();
            ProjectBootstrap.ValidateSceneShadowCoverage();
            var directory = Environment.GetEnvironmentVariable("HALL_BUILD_DIRECTORY");
            if (string.IsNullOrWhiteSpace(directory)) throw new BuildFailedException("HALL_BUILD_DIRECTORY is required for a staged build.");
            Directory.CreateDirectory(directory);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = new[] { "Assets/Scenes/Factory.unity" }, locationPathName = Path.Combine(directory, "HeatTreatmentDigitalTwin.exe"), target = BuildTarget.StandaloneWindows64, targetGroup = BuildTargetGroup.Standalone, options = BuildOptions.None });
            if (report.summary.result != BuildResult.Succeeded) throw new BuildFailedException("Hall client build failed: " + report.summary.result);
        }
    }
}
#endif
