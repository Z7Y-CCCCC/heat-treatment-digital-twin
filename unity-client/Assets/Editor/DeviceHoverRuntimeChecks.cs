#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class DeviceHoverRuntimeChecks
    {
        public static void Run()
        {
            var roots = new List<GameObject>();
            var checks = new JArray();
            void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); checks.Add(message); }
            GameObject Create(string name) { var root = new GameObject(name); roots.Add(root); return root; }
            try
            {
                var camera = Create("WholeDeviceHoverCamera").AddComponent<Camera>();
                camera.pixelRect = new Rect(0, 0, 1280, 720);
                camera.nearClipPlane = .01f;
                var orbit = camera.gameObject.AddComponent<OrbitCameraController>(); orbit.enabled = false;
                var controller = Create("WholeDeviceHoverFixture").AddComponent<FactoryDashboardController>();
                controller.Initialize(camera, orbit, null);
                controller.BeginFactory(new FactoryConfigDto());
                controller.SetWebOverlayActive(true);
                controller.ApplyPublishedViews(JObject.Parse(@"{'scene':{'defaultViewId':'factory_overview','views':[
                    {'id':'factory_overview','mode':'factory'}, {'id':'workshop_overview','mode':'workshop'},
                    {'id':'line_overview','mode':'line'}, {'id':'device_detail','mode':'device'}]}}"));
                GameObject Cube(string id, Vector3 position) {
                    var cube = GameObject.CreatePrimitive(PrimitiveType.Cube); cube.name = id; roots.Add(cube);
                    Object.DestroyImmediate(cube.GetComponent<Collider>()); cube.transform.position = position;
                    controller.RegisterDevice(new DeviceDto { Id = id, Name = id }, cube, new DeviceInspectionConfigDto { Enabled = false });
                    return cube;
                }
                var front = Cube("front", Vector3.zero);
                Cube("rear", new Vector3(0, 0, 2));
                var method = typeof(FactoryDashboardController).GetMethod("UpdateDeviceHoverAt", BindingFlags.Instance | BindingFlags.NonPublic);
                var draw = typeof(FactoryDashboardController).GetMethod("DrawDeviceHover", BindingFlags.Instance | BindingFlags.NonPublic);
                var outline = typeof(FactoryDashboardController).GetField("_inspectionOutlineMaterial", BindingFlags.Instance | BindingFlags.NonPublic);
                int Draw() => (int)draw.Invoke(controller, null);
                var originalMaterial = front.GetComponent<Renderer>().sharedMaterial;
                JObject payload = null; var events = 0;
                controller.DeviceHoverUpdated += value => { payload = value; events++; };
                var pointer = new Vector3(640, 360, 0);
                void Pick(bool blocked = false) => method.Invoke(controller, new object[] { pointer, blocked });
                void View(string id) {
                    controller.FocusPreviewBounds(new Bounds(Vector3.zero, Vector3.one * 4), controller.GetConfiguredView(id));
                    camera.transform.SetPositionAndRotation(new Vector3(0, 0, -5), Quaternion.identity);
                    pointer = camera.WorldToScreenPoint(Vector3.zero);
                }
                foreach (var id in new[] { "factory_overview", "workshop_overview", "line_overview" }) {
                    View(id); Pick();
                    Check(payload.Value<string>("hoveredDeviceId") == "front" && payload.Value<string>("viewId") == id, id + " picks nearest actual mesh without inspection config or colliders");
                    Check(Draw() == 1, id + " draws only the hovered equipment outline");
                }
                var material = outline.GetValue(controller);
                for (var repeat = 0; repeat < 100; repeat++) Draw();
                Check(material != null && ReferenceEquals(material, outline.GetValue(controller)), "stationary hover reuses one outline material without clone churn");
                Check(front.GetComponent<Renderer>().sharedMaterial == originalMaterial, "hover does not replace equipment PBR material");
                var count = events; Pick();
                Check(count == events, "stationary unchanged scene does not resend hover");
                pointer.x += 3; Pick();
                Check(events == count + 1 && payload["deviceHoverPointer"].Value<bool>("visible"), "pointer motion updates compact tooltip position immediately");
                Pick(true); Check(payload.Value<string>("hoveredDeviceId") == "", "blocked UI clears device hover");
                Check(Draw() == 0, "blocked pointer clears the outline in the same frame");
                Pick(); Check(payload.Value<string>("hoveredDeviceId") == "front", "unblocking same stationary pointer repicks");
                front.SetActive(false); Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "rear", "hidden device cannot intercept a visible device behind it");
                camera.transform.position += Vector3.right * 20; Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "", "camera motion clears hover without moving the pointer");
                Check(Draw() == 0, "camera moving away clears the outline");
                View("line_overview"); Pick();
                var view = controller.GetConfiguredView("line_overview");
                view.Metadata["deviceTooltip"] = new JObject { ["enabled"] = false }; Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "", "per-view disable immediately clears hover");
                Check(Draw() == 0, "disabled view does not draw a stale outline");
                count = events; pointer.x += 2; Pick();
                Check(events == count, "disabled tooltip emits no pointer traffic");
                typeof(FactoryDashboardController).GetMethod("SelectFromWorld", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(controller, new object[] { pointer });
                Check(controller.ActiveViewId == "device_detail", "tooltip disabled does not disable device clicks");
                View("line_overview");
                view.Metadata["deviceTooltip"]["enabled"] = true; Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "front", "re-enable repicks stationary pointer");
                pointer = new Vector3(1100, 600, 0); Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "", "empty space does not become a bounds-only tooltip");
                Check(Draw() == 0, "empty space clears the outline");
                View("workshop_overview"); pointer = camera.WorldToScreenPoint(Vector3.zero); Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "front", "line configuration does not disable workshop hover");
                controller.FocusPreviewDevice("rear"); Pick();
                Check(payload.Value<string>("hoveredDeviceId") == "", "device detail clears overview hover and preserves part tooltip ownership");
                Check(Draw() == 0, "whole-device outline never persists into detail/part inspection");
                controller.ClearFactory();
                Check(Draw() == 0, "factory switch clears the previous equipment outline");
                Debug.Log("[DeviceHoverChecks] PASS " + checks.Count + " checks");
                var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../../output/device-hover-native-checks.json"));
                File.WriteAllText(output, new JObject { ["status"] = "passed", ["checks"] = checks }.ToString());
            }
            finally { foreach (var root in roots) if (root != null) Object.DestroyImmediate(root); }
        }
    }
}
#endif
