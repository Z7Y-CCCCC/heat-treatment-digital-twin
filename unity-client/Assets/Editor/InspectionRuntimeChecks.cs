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
                var selectedFixture = typeof(FactoryDashboardController).GetField("_selected", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(dashboard);
                var inspectionFixture = selectedFixture.GetType().GetField("Inspection", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).GetValue(selectedFixture);
                var hoverGate = typeof(FactoryDashboardController).GetMethod("InspectionHoverChanged", BindingFlags.Instance | BindingFlags.NonPublic);
                var pointer = new Vector3(320, 240, 0);
                bool HoverChanged(bool blocked = false) => (bool)hoverGate.Invoke(dashboard, new object[] { inspectionFixture, pointer, blocked });
                Check(HoverChanged() && !HoverChanged(), "stationary pointer/camera/geometry reuse the exact hover result");
                pointer.x += 1;
                Check(HoverChanged() && !HoverChanged(), "pointer motion refreshes picking without lowering hover cadence");
                var cameraPosition = camera.transform.position;
                camera.transform.position += Vector3.right * .001f;
                Check(HoverChanged(), "stationary pointer still repicks when camera moves");
                camera.transform.position = cameraPosition; HoverChanged();
                var plcPosition = a.transform.localPosition;
                a.transform.localPosition += Vector3.up * .0001f;
                Check(HoverChanged(), "PLC node motion invalidates cached picking");
                a.transform.localPosition = plcPosition; HoverChanged();
                Check(HoverChanged(true) && !HoverChanged(true) && HoverChanged(false), "UI obstruction changes clear and restore hover picking");
                var visibleRenderer = a.GetComponent<MeshRenderer>();
                var previousVisible = visibleRenderer.enabled;
                visibleRenderer.enabled = !previousVisible;
                Check(HoverChanged(), "renderer visibility changes invalidate hover picking");
                visibleRenderer.enabled = previousVisible; HoverChanged();
                var swappedGeometry = Object.Instantiate(mesh); fixtures.Add(swappedGeometry);
                a.GetComponent<MeshFilter>().sharedMesh = swappedGeometry;
                Check(HoverChanged(), "replaced mesh invalidates hover picking even at the same transform");
                a.GetComponent<MeshFilter>().sharedMesh = mesh; HoverChanged();
                var publishContext = typeof(FactoryDashboardController).GetMethod("PublishInspectionContext", BindingFlags.Instance | BindingFlags.NonPublic);
                var hoverAt = typeof(FactoryDashboardController).GetMethod("UpdateInspectionHoverAt", BindingFlags.Instance | BindingFlags.NonPublic);
                JObject hoverMessage = null;
                var hoverMessages = 0;
                dashboard.InspectionHoverUpdated += value => { hoverMessage = value; hoverMessages++; };
                var rendererForHover = a.GetComponent<Renderer>();
                camera.transform.position = rendererForHover.bounds.center + Vector3.back * 5f;
                camera.transform.LookAt(rendererForHover.bounds.center);
                pointer = camera.WorldToScreenPoint(rendererForHover.bounds.center);
                inspectionFixture.GetType().GetField("HoverSnapshotValid").SetValue(inspectionFixture, false);
                hoverAt.Invoke(dashboard, new object[] { pointer, false });
                Check(hoverMessage != null && !string.IsNullOrEmpty(hoverMessage.Value<string>("inspectionHoveredPartId")), "hover enters in the current rendered frame without a 50ms timer");
                var beforeHoverMessages = hoverMessages;
                pointer.x += .01f;
                hoverAt.Invoke(dashboard, new object[] { pointer, false });
                Check(hoverMessages == beforeHoverMessages + 1 && hoverMessage["inspectionHoverPointer"].Value<bool>("visible"), "same-part pointer movement emits only a compact hover update in the same frame");
                hoverAt.Invoke(dashboard, new object[] { pointer, true });
                Check(hoverMessage.Value<string>("inspectionHoveredPartId") == "" && !hoverMessage["inspectionHoverPointer"].Value<bool>("visible"), "hover clears immediately when the pointer is blocked, without waiting for context polling");
                beforeHoverMessages = hoverMessages;
                hoverAt.Invoke(dashboard, new object[] { pointer, true });
                Check(hoverMessages == beforeHoverMessages, "stationary blocked pointer generates no hover traffic");
                var cachedParts = context["inspectionParts"];
                var cachedPointIds = cachedParts[0]["pointIds"];
                var cachedAnchor = cachedParts[0]["anchor"];
                var anchorBefore = cachedAnchor.ToString();
                camera.transform.position += camera.transform.right * .25f;
                publishContext.Invoke(dashboard, new[] { selectedFixture });
                Check(ReferenceEquals(cachedParts, context["inspectionParts"]) && ReferenceEquals(cachedPointIds, context["inspectionParts"][0]["pointIds"])
                    && ReferenceEquals(cachedAnchor, context["inspectionParts"][0]["anchor"]), "projection refresh reuses static part metadata and projection containers");
                Check(anchorBefore != cachedAnchor.ToString(), "cached part projection follows camera motion at the original publish cadence");
                // Keep the integration fixture inactive so FactoryRuntime.Awake never
                // starts authentication, network activity, or loads a scene.
                var bridgeObject = Create("inactive-context-bridge"); bridgeObject.SetActive(false);
                var bridge = bridgeObject.AddComponent<FactoryRuntime>();
                var bridgeContext = typeof(FactoryRuntime).GetField("_lastDashboardContext", BindingFlags.Instance | BindingFlags.NonPublic);
                bridgeContext.SetValue(bridge, new JObject { ["workshopId"] = "retained-workshop" });
                var acceptContext = typeof(FactoryRuntime).GetMethod("OnInspectionContextChanged", BindingFlags.Instance | BindingFlags.NonPublic);
                acceptContext.Invoke(bridge, new object[] { context });
                var priorSnapshot = (JObject)bridgeContext.GetValue(bridge);
                var priorJson = priorSnapshot.ToString();
                camera.transform.position += camera.transform.right * .25f;
                publishContext.Invoke(dashboard, new[] { selectedFixture });
                acceptContext.Invoke(bridge, new object[] { context });
                var currentSnapshot = (JObject)bridgeContext.GetValue(bridge);
                Check(priorSnapshot.ToString() == priorJson && !ReferenceEquals(priorSnapshot["inspectionParts"], context["inspectionParts"]),
                    "runtime copies the borrowed context once and later publishes cannot rewrite prior snapshots");
                Check(currentSnapshot["inspectionParts"][0]["anchor"].ToString() == cachedAnchor.ToString()
                    && currentSnapshot.Value<string>("workshopId") == "retained-workshop", "context updates retain hierarchy fields and current spatial data");
                var issues = (JArray)inspectionFixture.GetType().GetField("Issues").GetValue(inspectionFixture);
                issues.Clear(); issues.Add(new JObject { ["code"] = "old-issue" });
                publishContext.Invoke(dashboard, new[] { selectedFixture });
                issues.Clear(); issues.Add(new JObject { ["code"] = "replacement-issue" });
                publishContext.Invoke(dashboard, new[] { selectedFixture });
                Check(context["inspectionIssues"][0].Value<string>("code") == "replacement-issue", "same-count inspection issue replacements refresh cached metadata");
                camera.transform.position = cameraPosition;
                dashboard.ClearFactory();
                Check(a.transform.parent == parentA && b.transform.parent == parentB && a.transform.GetSiblingIndex() == originalSibling, "exit/reload disposal restores original hierarchy and sibling indices");
                Check(Vector3.Distance(a.transform.localPosition, originalPosition + Vector3.right * .4f) < .0001f, "disposal preserves the latest PLC state, not a stale captured transform");
                Check(!model.GetComponentsInChildren<Transform>(true).Any(target => target.name.StartsWith("__InspectionOffset_")), "disposed inspection wrappers are removed");
                CheckAcceleratedPicking(Check);
                var holeMesh = new Mesh { name = "AABB false-positive fixture" };
                holeMesh.vertices = new[] { new Vector3(-3,-1,0), new Vector3(-1,-1,0), new Vector3(-2,1,0), new Vector3(1,-1,0), new Vector3(3,-1,0), new Vector3(2,1,0) };
                holeMesh.triangles = new[] { 0,1,2,3,4,5 }; holeMesh.RecalculateNormals(); holeMesh.RecalculateBounds(); fixtures.Add(holeMesh);
                var hole = Create("precise-pick-fixture"); hole.AddComponent<MeshFilter>().sharedMesh = holeMesh;
                var holeRenderer = hole.AddComponent<MeshRenderer>(); holeRenderer.sharedMaterial = material;
                using (var surface = new InspectionMeshSurface(holeRenderer))
                {
                    Check(!surface.Raycast(new Ray(new Vector3(0,0,-5), Vector3.forward), out _), "empty space inside mesh bounds is not pickable");
                    Check(surface.Raycast(new Ray(new Vector3(-2,0,-5), Vector3.forward), out var hit) && Math.Abs(hit - 5) < .001f, "actual triangle picking reports the correct nearest surface");
                    hole.transform.SetPositionAndRotation(new Vector3(3, 2, -4), Quaternion.Euler(21, 53, -12));
                    hole.transform.localScale = new Vector3(-2, .7f, 3);
                    var worldPoint = hole.transform.TransformPoint(new Vector3(-2, 0, 0));
                    var normal = hole.transform.TransformDirection(Vector3.forward);
                    Check(surface.Raycast(new Ray(worldPoint - normal * 7, normal), out hit) && Math.Abs(hit - 7) < .001f,
                        "mirrored nonuniform model scale preserves exact world hit distance");
                }
                CheckFinePartAssistance(mesh, material, scene, Check);
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

        private static void CheckFinePartAssistance(Mesh mesh, Material material, Scene scene, Action<bool, string> check)
        {
            var root = new GameObject("fine-part-fixture");
            var cameraRoot = new GameObject("fine-part-camera");
            var dashboardRoot = new GameObject("fine-part-dashboard");
            SceneManager.MoveGameObjectToScene(root, scene);
            SceneManager.MoveGameObjectToScene(cameraRoot, scene);
            SceneManager.MoveGameObjectToScene(dashboardRoot, scene);
            var dashboard = dashboardRoot.AddComponent<FactoryDashboardController>();
            try
            {
                GameObject Box(string name, Vector3 position, Vector3 scale)
                {
                    var box = new GameObject(name); box.transform.SetParent(root.transform, false);
                    box.transform.localPosition = position; box.transform.localScale = scale;
                    box.AddComponent<MeshFilter>().sharedMesh = mesh;
                    box.AddComponent<MeshRenderer>().sharedMaterial = material;
                    return box;
                }
                var needle = Box("FineNeedle", Vector3.zero, new Vector3(.006f, .9f, .05f));
                var body = Box("Body", new Vector3(0, 0, 1), new Vector3(2, 2, .1f)).GetComponent<Renderer>();
                var shield = Box("Occluder", new Vector3(0, 0, -1), new Vector3(2, 2, .1f)).GetComponent<Renderer>();
                shield.forceRenderingOff = true;
                var camera = cameraRoot.AddComponent<Camera>();
                camera.orthographic = true; camera.orthographicSize = 5;
                camera.pixelRect = new Rect(0, 0, 1600, 900); camera.aspect = 16f / 9f;
                camera.transform.position = new Vector3(0, 0, -10); camera.transform.LookAt(Vector3.zero);
                var orbit = cameraRoot.AddComponent<OrbitCameraController>(); orbit.enabled = false;
                dashboard.Initialize(camera, orbit, null); dashboard.BeginFactory(new FactoryConfigDto());
                dashboard.SetWebOverlayActive(true);
                JObject context = null; var contextMessages = 0;
                dashboard.InspectionContextChanged += value => { context = value; contextMessages++; };
                var device = new DeviceDto { Id = "fine", Name = "Fine", Scale = 1 };
                dashboard.RegisterDevice(device, root, new DeviceInspectionConfigDto { Enabled = true,
                    Parts = new List<DeviceInspectionPartDto> {
                        new DeviceInspectionPartDto { Id = "needle", Name = "Needle", NodeName = "FineNeedle" },
                        new DeviceInspectionPartDto { Id = "body", Name = "Body", NodeName = "Body" } } });
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "stage", ["stage"] = "exploded" }, out _);
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "progress", ["progress"] = 1f }, out _);
                // Capture Body as originally visible. Temporary test hiding
                // must not make later un-isolation restore it as permanently off.
                body.forceRenderingOff = true;
                var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                var selected = typeof(FactoryDashboardController).GetField("_selected", flags).GetValue(dashboard);
                var runtime = selected.GetType().GetField("Inspection").GetValue(selected);
                var exact = typeof(FactoryDashboardController).GetMethod("PickInspectionPart", flags);
                var assisted = typeof(FactoryDashboardController).GetMethod("PickInspectionPartAt", flags);
                var center = camera.WorldToScreenPoint(needle.GetComponent<Renderer>().bounds.center);
                var nearby = center + Vector3.right * 3;
                check(exact.Invoke(dashboard, new object[] { runtime, camera.ScreenPointToRay(nearby) }) == null, "subpixel-thin part fixture is missed by the exact center ray");
                check(assisted.Invoke(dashboard, new object[] { runtime, nearby }) != null, "screen-pixel assistance acquires a thin part three pixels away");
                check(assisted.Invoke(dashboard, new object[] { runtime, center + Vector3.right * 14 }) == null, "bounded assistance does not select a distant part");
                string PickId(Vector3 point) {
                    var value = assisted.Invoke(dashboard, new object[] { runtime, point });
                    return (value?.GetType().GetField("Config").GetValue(value) as DeviceInspectionPartDto)?.Id;
                }
                body.forceRenderingOff = false;
                check(PickId(nearby) == "needle", "visible thin foreground part is easy to acquire even against a large selectable body");
                check(PickId(center + Vector3.right * 14) == "body", "assistance does not steal a large part when the thin part is far away");
                needle.transform.localRotation = Quaternion.Euler(0, 0, 45);
                var diagonalPointer = center + new Vector3(-2.12132f, 2.12132f, 0);
                check(PickId(diagonalPointer) == "needle", "projected strip assistance handles a diagonal subpixel-thin part");
                needle.transform.localRotation = Quaternion.identity;
                shield.forceRenderingOff = false;
                check(assisted.Invoke(dashboard, new object[] { runtime, nearby }) == null, "visible unselectable geometry blocks assistance to a hidden part");
                shield.forceRenderingOff = true;
                // The public input loop calls SelectFromWorld. Testing a private
                // picker alone did not catch the missing Detail routing branch.
                var click = typeof(FactoryDashboardController).GetMethod("SelectFromWorld", flags);
                click.Invoke(dashboard, new object[] { nearby });
                var part = runtime.GetType().GetField("SelectedPart").GetValue(runtime);
                check((part?.GetType().GetField("Config").GetValue(part) as DeviceInspectionPartDto)?.Id == "needle", "click and hover share the same assisted target");
                check(context.Value<string>("inspectionStage") == "part", "actual world-click route selects a part instead of reopening solid device detail");
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "pause" }, out _);
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "isolate", ["enabled"] = true }, out _);
                var hover = typeof(FactoryDashboardController).GetMethod("UpdateInspectionHoverAt", flags);
                hover.Invoke(dashboard, new object[] { nearby, false });
                var queries = (int)runtime.GetType().GetField("PickQueryCount").GetValue(runtime);
                var messages = contextMessages;
                var desiredTarget = typeof(OrbitCameraController).GetField("_desiredTarget", flags).GetValue(orbit);
                var desiredDistance = typeof(OrbitCameraController).GetField("_desiredDistance", flags).GetValue(orbit);
                for (var repeated = 0; repeated < 200; repeated++) click.Invoke(dashboard, new object[] { nearby });
                check((int)runtime.GetType().GetField("PickQueryCount").GetValue(runtime) == queries,
                    "200 stationary world clicks reuse the validated rendered hover without new ray queries");
                check(contextMessages == messages && (bool)runtime.GetType().GetField("Paused").GetValue(runtime)
                    && (bool)runtime.GetType().GetField("Isolated").GetValue(runtime),
                    "repeated same-part clicks preserve pause/isolation and generate no full-context traffic");
                check(Equals(desiredTarget, typeof(OrbitCameraController).GetField("_desiredTarget", flags).GetValue(orbit))
                    && Equals(desiredDistance, typeof(OrbitCameraController).GetField("_desiredDistance", flags).GetValue(orbit)),
                    "repeated same-part clicks do not reframe the camera");
                var needlePosition = needle.transform.localPosition;
                needle.transform.localPosition += Vector3.right * 2f;
                click.Invoke(dashboard, new object[] { nearby });
                var movedQueries = (int)runtime.GetType().GetField("PickQueryCount").GetValue(runtime);
                var movedHovered = runtime.GetType().GetField("HoveredPart").GetValue(runtime);
                var movedHoveredId = (movedHovered?.GetType().GetField("Config").GetValue(movedHovered) as DeviceInspectionPartDto)?.Id ?? "<none>";
                check(movedQueries > queries, $"moving geometry forces a fresh world-click query (before={queries}, after={movedQueries}, hovered={movedHoveredId})");
                check(movedHovered == null && context.Value<string>("partId") == "needle",
                    $"moving part geometry cannot select a stale triangle (hovered={movedHoveredId}, selected={context.Value<string>("partId")}, pointer={nearby}, projected={camera.WorldToScreenPoint(needle.transform.position)})");
                needle.transform.localPosition = needlePosition;
                click.Invoke(dashboard, new object[] { nearby });
                click.Invoke(dashboard, new object[] { new Vector3(1400, 800, 0) });
                check(contextMessages == messages && context.Value<string>("partId") == "needle",
                    "empty-space world clicks preserve the current part detail");
                dashboard.SetWebOverlayActive(false);
                // Native GUI panels may contain the fixture pointer at this
                // resolution; add an explicit hit rectangle to test obstruction.
                var designPointer = (Vector2)typeof(FactoryDashboardController).GetMethod("ScreenToDesign", flags).Invoke(dashboard, new object[] { nearby });
                var hitRects = (List<Rect>)typeof(FactoryDashboardController).GetField("_inspectionHitRects", flags).GetValue(dashboard);
                hitRects.Add(new Rect(designPointer.x - 5, designPointer.y - 5, 10, 10));
                queries = (int)runtime.GetType().GetField("PickQueryCount").GetValue(runtime);
                click.Invoke(dashboard, new object[] { nearby });
                check((int)runtime.GetType().GetField("PickQueryCount").GetValue(runtime) == queries
                    && context.Value<string>("partId") == "needle", "dashboard-locked world clicks perform no geometry picking or navigation");
                hitRects.Clear(); dashboard.SetWebOverlayActive(true);
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "isolate", ["enabled"] = false }, out _);
                click.Invoke(dashboard, new object[] { center + Vector3.right * 30 });
                check(context.Value<string>("partId") == "body" && context.Value<string>("inspectionStage") == "part",
                    "a different visible part can still be selected through the actual world-click route");
                dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "stage", ["stage"] = "solid" }, out _);
                click.Invoke(dashboard, new object[] { center });
                check(context.Value<string>("inspectionStage") == "xray", "solid world click enters xray rather than resetting detail");
                click.Invoke(dashboard, new object[] { center });
                check(context.Value<string>("inspectionStage") == "exploded", "second world click advances xray into disassembly");
            }
            finally
            {
                dashboard.ClearFactory(); Object.DestroyImmediate(dashboardRoot);
                Object.DestroyImmediate(cameraRoot); Object.DestroyImmediate(root);
            }
        }

        private static void CheckAcceleratedPicking(Action<bool, string> check)
        {
            const int size = 64;
            var vertices = new Vector3[(size + 1) * (size + 1)];
            var triangles = new int[size * size * 6];
            for (var y = 0; y <= size; y++)
                for (var x = 0; x <= size; x++) vertices[y * (size + 1) + x] = new Vector3(x, y, 0);
            var offset = 0;
            for (var y = 0; y < size; y++)
                for (var x = 0; x < size; x++)
                {
                    var a = y * (size + 1) + x; var b = a + 1; var c = a + size + 1; var d = c + 1;
                    foreach (var value in new[] { a, b, c, b, d, c }) triangles[offset++] = value;
                }
            var accelerated = new TriangleRayIndex(vertices, triangles);
            var reference = new TriangleRayIndex(vertices, triangles, false);
            var random = new System.Random(418);
            var exact = true; var peakTests = 0;
            for (var sample = 0; sample < 160; sample++)
            {
                var origin = new Vector3((float)random.NextDouble() * 80 - 8, (float)random.NextDouble() * 80 - 8, -5);
                // Non-unit local direction must preserve the world-ray parameter.
                var direction = new Vector3(.013f, -.017f, .25f);
                var found = accelerated.Raycast(origin, direction, out var hit);
                var expected = reference.Raycast(origin, direction, out var expectedHit);
                exact &= found == expected && (!found || Math.Abs(hit - expectedHit) < .0001f);
                peakTests = Math.Max(peakTests, accelerated.LastTriangleTests);
            }
            check(exact, "BVH matches brute-force exact triangles for hits/misses and non-unit ray directions");
            check(typeof(TriangleRayIndex).GetField("_buildCenters", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(accelerated) == null,
                "BVH releases temporary centroid storage after construction");
            check(!accelerated.Raycast(new Vector3(10.25f,10.25f,-5), Vector3.forward, out _, null, 4f), "nearest-distance culling does not invent a hit at the distance cap");
            check(accelerated.Raycast(new Vector3(10.25f,10.25f,-5), Vector3.forward, out var boundedHit, null, 6f)
                && Math.Abs(boundedHit - 5f) < .001f, "nearest-distance culling retains an exact hit inside the cap");
            check(peakTests < 128, $"8192-triangle fixture visits at most {peakTests} triangles instead of scanning the mesh");
            // These values reproduce a rounded vertex hit whose float slab
            // entry exceeded exit. Other triangles broaden the renderer bounds
            // while the BVH's target leaf still has this triangle's tight AABB.
            var corner = new[]
            {
                new Vector3(-2.5452471f, -2.7563133f, -7.689426f),
                new Vector3(2.8680212f, -2.39079f, -5.033773f),
                new Vector3(3.4435613f, -1.4310541f, -.558593f)
            };
            var cornerVertices = corner.Concat(corner.Select(value => value + Vector3.one * 50f))
                .Concat(corner.Select(value => value - Vector3.one * 50f)).ToArray();
            var cornerTriangles = new int[195 * 3];
            for (var triangle = 0; triangle < 195; triangle++)
                for (var vertex = 0; vertex < 3; vertex++) cornerTriangles[triangle * 3 + vertex] = triangle / 65 * 3 + vertex;
            var cornerIndex = new TriangleRayIndex(cornerVertices, cornerTriangles);
            var cornerReference = new TriangleRayIndex(cornerVertices, cornerTriangles, false);
            var cornerOrigin = new Vector3(-7.273838f, -.411101f, -3.2131596f);
            var cornerDirection = new Vector3(.68324995f, -.33886757f, -.64679074f);
            var cornerExpected = cornerReference.Raycast(cornerOrigin, cornerDirection, out var cornerExpectedHit);
            var cornerFound = cornerIndex.Raycast(cornerOrigin, cornerDirection, out var cornerHit);
            check(cornerExpected && cornerFound && cornerHit == cornerExpectedHit,
                "rounded vertex intersection survives conservative BVH bounds with identical exact-triangle distance");

            var boundaryExact = true;
            var boundaryHits = 0;
            for (var sample = 0; sample < 192; sample++)
            {
                var target = new Vector3(sample % 65, (sample * 17) % 65, 0f);
                // Test exact zero components, diagonal corner rays, edge rays,
                // negative directions, and cancellation from a distant origin.
                if (sample % 3 == 1) target.y += .25f;
                var origin = sample % 3 == 0 ? target + Vector3.back * 5f
                    : target + new Vector3(-13.25f, 7.75f, sample % 2 == 0 ? -31f : 31f) * (sample % 3 == 1 ? 1f : 3000f);
                var direction = (target - origin).normalized * .25f;
                var found = accelerated.Raycast(origin, direction, out var hit);
                var expected = reference.Raycast(origin, direction, out var expectedHit);
                boundaryExact &= found == expected && (!found || hit == expectedHit);
                if (expected) boundaryHits++;
            }
            check(boundaryExact && boundaryHits > 64,
                $"192 vertex/edge/parallel/distant rays match brute force exactly ({boundaryHits} hits)");
            var layered = new TriangleRayIndex(new[] {
                new Vector3(-1,-1,0), new Vector3(1,-1,0), new Vector3(0,1,0),
                new Vector3(-1,-1,1), new Vector3(1,-1,1), new Vector3(0,1,1)
            }, new[] { 0,1,2,3,4,5 });
            check(layered.Raycast(new Vector3(0,0,-5), Vector3.forward, out var accepted, distance => distance > 5.5f)
                && Math.Abs(accepted - 6f) < .0001f, "clipped nearest triangle does not hide accepted geometry behind it");
            var layers = new Vector3[300];
            var layerTriangles = new int[layers.Length];
            for (var layer = 0; layer < 100; layer++)
            {
                layers[layer * 3] = new Vector3(-1, -1, layer);
                layers[layer * 3 + 1] = new Vector3(1, -1, layer);
                layers[layer * 3 + 2] = new Vector3(0, 1, layer);
            }
            for (var index = 0; index < layerTriangles.Length; index++) layerTriangles[index] = index;
            var indexedLayers = new TriangleRayIndex(layers, layerTriangles);
            check(indexedLayers.Raycast(new Vector3(0, 0, -5), Vector3.forward, out accepted, distance => distance > 55.5f)
                && Math.Abs(accepted - 56f) < .0001f, "BVH searches deeper nodes when closer triangles are clipped");
            check(indexedLayers.Raycast(new Vector3(0, 0, 105), -Vector3.forward * .5f, out accepted)
                && Math.Abs(accepted - 12f) < .0001f, "BVH handles negative non-unit ray directions");
            check(!indexedLayers.Raycast(new Vector3(0, 0, -5), Vector3.forward, out _, distance => false),
                "fully clipped BVH geometry never becomes a bounding-box hit");
        }
    }
}
#endif
