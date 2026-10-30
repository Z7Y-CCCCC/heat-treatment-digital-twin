#if UNITY_EDITOR
using System;
using System.IO;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    /// <summary>Compare saved Three drag endpoints with actual Unity inspection transforms.</summary>
    public static class DeviceInspectionLayoutChecks
    {
        public static void Run()
        {
            var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../../output"));
            var source = JObject.Parse(File.ReadAllText(Path.Combine(output, "device-inspection-offset-preview-contract.json")));
            if (source.Value<string>("status") != "passed" || (source["cases"] as JArray)?.Count != 4)
                throw new InvalidOperationException("Run frontend/tests/device-inspection-offset-contract.test.mjs before the native layout checks.");
            var scene = EditorSceneManager.NewPreviewScene();
            var checks = 0;
            void Check(bool value, string text)
            {
                if (!value) throw new InvalidOperationException("Device layout check failed: " + text);
                checks++; Debug.Log("[DeviceLayoutChecks] PASS " + text);
            }
            Vector3 Vector(JToken value) => new Vector3(value[0].Value<float>(), value[1].Value<float>(), value[2].Value<float>());
            Vector3 Mirror(Vector3 value) => new Vector3(-value.x, value.y, value.z);
            GameObject Create(string name, Transform parent = null)
            {
                var item = new GameObject(name); SceneManager.MoveGameObjectToScene(item, scene);
                if (parent != null) item.transform.SetParent(parent, false);
                return item;
            }
            try
            {
                foreach (JObject fixture in (JArray)source["cases"])
                {
                    var id = fixture.Value<string>("id");
                    var settings = (JObject)fixture["settings"];
                    var root = Create("NativeDeviceLayout-" + id);
                    var scale = settings.Value<float>("scale");
                    root.transform.position = Vector(settings["position"]);
                    root.transform.rotation = Quaternion.Euler(0, -settings.Value<float>("yaw"), 0);
                    root.transform.localScale = new Vector3(settings.Value<bool>("mirrored") ? -scale : scale, scale, scale);
                    Transform Parent(string name, Vector3 gltfPosition, float yaw, float parentScale)
                    {
                        var item = Create(name, root.transform).transform;
                        item.localPosition = Mirror(gltfPosition); item.localRotation = Quaternion.Euler(0, -yaw, 0);
                        item.localScale = Vector3.one * parentScale; return item;
                    }
                    GameObject Cube(string name, Transform parent, Vector3 gltfPosition)
                    {
                        var item = GameObject.CreatePrimitive(PrimitiveType.Cube); item.name = name;
                        SceneManager.MoveGameObjectToScene(item, scene); Object.DestroyImmediate(item.GetComponent<Collider>());
                        item.transform.SetParent(parent, false); item.transform.localPosition = Mirror(gltfPosition);
                        return item;
                    }
                    var parentA = Parent("ParentA", new Vector3(-1, .5f, .2f), 35, .7f);
                    var parentB = Parent("ParentB", new Vector3(1, .2f, -.4f), -25, 1.3f);
                    var targets = new[] { Cube("A", parentA, new Vector3(.2f, .3f, -.1f)),
                        Cube("B", parentB, new Vector3(0, .2f, .1f)), Cube("C", root.transform, new Vector3(0, 0, 2)) };
                    var originalPositions = Array.ConvertAll(targets, item => item.transform.localPosition);
                    var asset = new ModelAssetDto { Metadata = new JObject { ["inspection"] = fixture["sourceInspection"].DeepClone() } };
                    var device = new DeviceDto { Id = id, InstanceConfig = new JValue(fixture["instanceConfig"].ToString()) };
                    var effective = InspectionConfigResolver.Resolve(asset, device);
                    var cameraRoot = Create("LayoutCheckCamera-" + id);
                    var camera = cameraRoot.AddComponent<Camera>();
                    var orbit = cameraRoot.AddComponent<OrbitCameraController>();
                    var dashboardRoot = Create("LayoutCheckDashboard-" + id);
                    var dashboard = dashboardRoot.AddComponent<FactoryDashboardController>();
                    dashboard.Initialize(camera, orbit, null); dashboard.BeginFactory(new FactoryConfigDto());
                    dashboard.RegisterDevice(device, root, effective);
                    try
                    {
                        foreach (var progress in new[] { "0", "0.35", "1", "0", "1" })
                        {
                            Check(dashboard.ApplyInspectionCommand(device.Id, new JObject { ["command"] = "progress",
                                ["progress"] = float.Parse(progress, System.Globalization.CultureInfo.InvariantCulture) }, out var error), id + " apply progress " + progress + ": " + error);
                            foreach (var target in targets)
                            {
                                var nativePoint = root.transform.InverseTransformPoint(target.transform.position);
                                var expected = Mirror(Vector(fixture["samples"][progress][target.name]));
                                Check(Vector3.Distance(nativePoint, expected) < .0005f,
                                    id + "/" + target.name + " progress=" + progress + " saved Three layout matches Unity: " + nativePoint + " / " + expected);
                            }
                        }
                        for (var index = 0; index < targets.Length; index++)
                            Check(targets[index].transform.localPosition == originalPositions[index], id + " preserves original-node PLC local transforms " + targets[index].name);
                    }
                    finally
                    {
                        dashboard.ClearFactory(); Object.DestroyImmediate(dashboardRoot); Object.DestroyImmediate(cameraRoot); Object.DestroyImmediate(root);
                    }
                }
                File.WriteAllText(Path.Combine(output, "device-inspection-offset-native-contract.json"),
                    new JObject { ["status"] = "passed", ["cases"] = 4, ["checks"] = checks }.ToString());
                Debug.Log("[DeviceLayoutChecks] ALL " + checks + " checks passed; no backend, PLC, or saved-scene writes.");
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
    }
}
#endif
