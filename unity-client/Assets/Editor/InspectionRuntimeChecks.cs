#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    /// <summary>
    /// Isolated, no-PLC/no-network/no-player-build checks. May be run in an editor
    /// batch with -executeMethod HeatTreatment.DigitalTwin.Editor.InspectionRuntimeChecks.Run.
    /// All fixtures are in a temporary preview scene; no scene or metadata is saved.
    /// </summary>
    public static class InspectionRuntimeChecks
    {
        [MenuItem("Digital Twin/Validate Inspection Runtime", priority = 30)]
        public static void Run()
        {
            var scene = EditorSceneManager.NewPreviewScene();
            var fixtures = new List<Object>();
            FactoryDashboardController dashboard = null;
            var checks = 0;
            var runtimeErrors = new List<string>();
            void CaptureLog(string message, string stack, LogType type)
            {
                if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) runtimeErrors.Add(message);
            }
            Application.logMessageReceived += CaptureLog;
            void Check(bool condition, string name)
            {
                if (!condition) throw new InvalidOperationException($"Inspection check failed: {name}");
                checks++;
                Debug.Log($"[InspectionChecks] PASS {name}");
            }
            GameObject Create(string name, Transform parent = null)
            {
                var result = new GameObject(name);
                SceneManager.MoveGameObjectToScene(result, scene);
                if (parent != null) result.transform.SetParent(parent, false);
                return result;
            }
            try
            {
                foreach (var resource in new[] { "InspectionShell", "InspectionOutline" })
                {
                    AssetDatabase.ImportAsset($"Assets/Resources/RuntimeShaders/{resource}.shader", ImportAssetOptions.ForceUpdate);
                    var shader = Resources.Load<Shader>($"RuntimeShaders/{resource}");
                    Check(shader != null, $"{resource} is retained in Resources");
                    var errors = ShaderUtil.GetShaderMessages(shader).Where(message => message.severity.ToString() == "Error").ToArray();
                    Check(errors.Length == 0, $"{resource} imported without shader errors: {string.Join("; ", errors.Select(error => error.message))}");
                }
                var material = new Material(Resources.Load<Shader>("RuntimeShaders/InspectionShell")) { name = "Inspection check original" };
                fixtures.Add(material);
                var mesh = new Mesh { name = "Inspection check cube" };
                mesh.vertices = new[]
                {
                    new Vector3(-.5f,-.5f,-.5f), new Vector3(.5f,-.5f,-.5f), new Vector3(.5f,.5f,-.5f), new Vector3(-.5f,.5f,-.5f),
                    new Vector3(-.5f,-.5f,.5f), new Vector3(.5f,-.5f,.5f), new Vector3(.5f,.5f,.5f), new Vector3(-.5f,.5f,.5f)
                };
                mesh.triangles = new[] { 0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5 };
                mesh.RecalculateNormals(); mesh.RecalculateBounds(); fixtures.Add(mesh);
                GameObject Cube(string name, Transform parent, Vector3 position)
                {
                    var cube = Create(name, parent);
                    cube.transform.localPosition = position;
                    cube.AddComponent<MeshFilter>().sharedMesh = mesh;
                    cube.AddComponent<MeshRenderer>().sharedMaterial = material;
                    return cube;
                }
                var model = Create("inspection-model");
                model.transform.SetPositionAndRotation(new Vector3(5, 1, 3), Quaternion.Euler(0, 90, 0));
                model.transform.localScale = new Vector3(-2, 2, 2);
                var parentA = Create("ParentA", model.transform).transform;
                parentA.localPosition = new Vector3(-1, .5f, .2f); parentA.localRotation = Quaternion.Euler(0, 35, 0);
                var parentB = Create("ParentB", model.transform).transform;
                parentB.localPosition = new Vector3(1, .2f, -.4f); parentB.localRotation = Quaternion.Euler(0, -25, 0);
                var a = Cube("A", parentA, new Vector3(.2f,.3f,-.1f));
                var b = Cube("B", parentB, new Vector3(0,.2f,.1f));
                var plate = Cube("Plate", parentA, new Vector3(0, 1.5f, 0));
                var c = Cube("C", model.transform, new Vector3(0,0,2));
                var originalPosition = a.transform.localPosition;
                var originalRotation = a.transform.localRotation;
                var originalSibling = a.transform.GetSiblingIndex();
                var initialAInModel = model.transform.InverseTransformPoint(a.transform.position);
                // Compute the pivot directly from model-local vertices, independent of
                // root placement/rotation and independent of the runtime bounds helper.
                var points = new[] { a, b }.SelectMany(item => mesh.vertices.Select(vertex => model.transform.InverseTransformPoint(item.transform.TransformPoint(vertex)))).ToArray();
                var groupBounds = new Bounds(points[0], Vector3.zero);
                foreach (var point in points) groupBounds.Encapsulate(point);
                var pivot = groupBounds.center;
                var binding = model.AddComponent<ModelBindingDriver>();
                binding.Configure(new[] {
                    new PartBindingDto { NodeName = "A", SourceGroup = "mechanisms", SourceKey = "travel", Action = "translate", Axis = "x", InputMin = 0, InputMax = 1, OutputMin = 0, OutputMax = 1 },
                    new PartBindingDto { NodeName = "A", SourceGroup = "status", SourceKey = "running", Action = "color", OnColor = "#00ff00", OffColor = "#333333" }
                });
                var cameraRoot = Create("inspection-camera");
                var camera = cameraRoot.AddComponent<Camera>();
                camera.aspect = 16f / 9f;
                var orbit = cameraRoot.AddComponent<OrbitCameraController>();
                dashboard = Create("inspection-dashboard").AddComponent<FactoryDashboardController>();
                dashboard.Initialize(camera, orbit, null);
                dashboard.BeginFactory(new FactoryConfigDto());
                var config = new DeviceInspectionConfigDto
                {
                    OffsetSpace = "model", ShellDuration = 1, AnimationDuration = 2, Stagger = 0,
                    Shell = new DeviceInspectionShellDto { NodeNames = new List<string> { "ParentA" }, Transition = "clip" },
                    Parts = new List<DeviceInspectionPartDto>
                    {
                        new DeviceInspectionPartDto { Id = "group", Name = "Drive", NodeNames = new List<string> { "A", "B", "A" }, ExplodeOffset = new List<float> { 1, 0, 0 }, ExplodeRotation = new List<float> { 23, -37, 51 }, PointIds = new List<string> { "42" } },
                        new DeviceInspectionPartDto { Id = "other", NodeName = "C", ExplodeOffset = new List<float> { 0, 0, 1 } }
                    }
                };
                var device = new DeviceDto { Id = "fixture-device", Name = "Inspection fixture" };
                JObject context = null;
                dashboard.InspectionContextChanged += value => context = value;
                dashboard.RegisterDevice(device, model, config);
                bool Command(string command, JToken value = null)
                {
                    var payload = new JObject { ["command"] = command };
                    if (command == "progress") payload["progress"] = value;
                    if (command == "select") payload["partId"] = value;
                    return dashboard.ApplyInspectionCommand(device.Id, payload, out _);
                }
                Check(Command("progress", 1), "scrub to authored endpoint");
                var mirror = Matrix4x4.Scale(new Vector3(-1, 1, 1));
                var authorRotation = Quaternion.AngleAxis(23, Vector3.right) * Quaternion.AngleAxis(-37, Vector3.up) * Quaternion.AngleAxis(51, Vector3.forward);
                var nativeDelta = mirror * Matrix4x4.Rotate(authorRotation) * mirror;
                var expected = model.transform.TransformPoint(pivot + nativeDelta.MultiplyVector(initialAInModel - pivot) - Vector3.right);
                Check(Vector3.Distance(a.transform.position, expected) < .001f, "model-local multi-node rotation and offset work through rotated parents and a mirrored instance");
                Check(a.transform.localPosition == originalPosition && a.transform.localRotation == originalRotation, "inspection never overwrites original-node local PLC transforms");
                Check(plate.GetComponent<Renderer>().forceRenderingOff && !a.GetComponent<Renderer>().forceRenderingOff, "shell-parent removal does not hide retained child parts");
                Check(Command("select", "group") && context.Value<string>("inspectionStage") == "part" && context.Value<string>("partId") == "group", "legacy part context and detail-view bridge remain intact");
                Check(context["partPointIds"][0].ToString() == "42" && context["inspectionParts"][0]["anchor"]["x"] != null, "PLC part links and spatial projections reach the overlay");
                var before = a.transform.position;
                var wrappers = model.GetComponentsInChildren<Transform>(true).Count(target => target.name.StartsWith("__InspectionOffset_"));
                var invalid = JObject.FromObject(config);
                ((JArray)invalid["parts"]).Add(JObject.FromObject(new DeviceInspectionPartDto { Id = "duplicate", NodeName = "A" }));
                Check(!dashboard.ApplyInspectionPreview(device.Id, invalid, out _), "cross-part duplicate targets reject unsaved preview");
                Check(a.transform.position == before && wrappers == model.GetComponentsInChildren<Transform>(true).Count(target => target.name.StartsWith("__InspectionOffset_")), "invalid preview is non-destructive and does not leak wrappers");
                var ancestor = JObject.FromObject(config);
                ((JArray)ancestor["parts"]).Add(JObject.FromObject(new DeviceInspectionPartDto { Id = "ancestor", NodeName = "ParentA" }));
                Check(!dashboard.ApplyInspectionPreview(device.Id, ancestor, out _), "cross-part ancestor targets reject unsaved preview");
                binding.ApplyRealtime(new JObject { ["mechanisms"] = new JObject { ["travel"] = .4f }, ["status"] = new JObject { ["running"] = true } });
                var colorBlock = new MaterialPropertyBlock();
                a.GetComponent<Renderer>().GetPropertyBlock(colorBlock);
                Check(colorBlock.GetColor("_BaseColor") == Color.green, "PLC color creates its material block on the main-thread update path");
                Check(Command("progress", .7f) && Vector3.Distance(a.transform.localPosition, originalPosition + Vector3.right * .4f) < .0001f, "live PLC translation survives partial disassembly");
                Check(Command("progress", 0), "scrub back to assembled");
                Check(plate.GetComponent<Renderer>().sharedMaterial == material && !plate.GetComponent<Renderer>().forceRenderingOff, "assembly restores original shell material and visibility");
                var tiny = new Bounds(Vector3.zero, Vector3.one * .02f);
                orbit.FocusBounds(tiny, 20, 20, 1.1f, true, true);
                var distance = (float)typeof(OrbitCameraController).GetField("_desiredDistance", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(orbit);
                Check(distance < 1 && camera.nearClipPlane < .01f, "small-part framing has no factory-scale distance or near-plane floor");
                orbit.FocusBounds(tiny, 20, -35, .08f, true, true);
                var pitch = (float)typeof(OrbitCameraController).GetField("_desiredPitch", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(orbit);
                Check(Math.Abs(pitch + 35f) < .001f, "authored negative-pitch close inspection camera is retained");
                dashboard.ClearFactory();
                Check(a.transform.parent == parentA && b.transform.parent == parentB && a.transform.GetSiblingIndex() == originalSibling, "exit/reload disposal restores original hierarchy and sibling indices");
                Check(Vector3.Distance(a.transform.localPosition, originalPosition + Vector3.right * .4f) < .0001f, "disposal preserves the latest PLC state, not a stale captured transform");
                Check(!model.GetComponentsInChildren<Transform>(true).Any(target => target.name.StartsWith("__InspectionOffset_")), "disposed inspection wrappers are removed");
                var holeMesh = new Mesh { name = "AABB false-positive fixture" };
                holeMesh.vertices = new[] { new Vector3(-3,-1,0), new Vector3(-1,-1,0), new Vector3(-2,1,0), new Vector3(1,-1,0), new Vector3(3,-1,0), new Vector3(2,1,0) };
                holeMesh.triangles = new[] { 0,1,2,3,4,5 }; holeMesh.RecalculateNormals(); holeMesh.RecalculateBounds(); fixtures.Add(holeMesh);
                var hole = Create("precise-pick-fixture"); hole.AddComponent<MeshFilter>().sharedMesh = holeMesh;
                var holeRenderer = hole.AddComponent<MeshRenderer>(); holeRenderer.sharedMaterial = material;
                using (var surface = new InspectionMeshSurface(holeRenderer))
                {
                    Check(!surface.Raycast(new Ray(new Vector3(0,0,-5), Vector3.forward), out _), "empty space inside mesh bounds is not pickable");
                    Check(surface.Raycast(new Ray(new Vector3(-2,0,-5), Vector3.forward), out var hit) && Math.Abs(hit - 5) < .001f, "actual triangle picking reports the correct nearest surface");
                }
                Check(runtimeErrors.Count == 0, $"no Unity error/exception logs: {string.Join("; ", runtimeErrors)}");
                Debug.Log($"[InspectionChecks] ALL {checks} native checks passed; no database/PLC or saved-scene writes.");
            }
            finally
            {
                Application.logMessageReceived -= CaptureLog;
                if (dashboard != null) dashboard.ClearFactory();
                EditorSceneManager.ClosePreviewScene(scene);
                foreach (var fixture in fixtures) if (fixture != null) Object.DestroyImmediate(fixture);
            }
        }
    }
}
#endif
