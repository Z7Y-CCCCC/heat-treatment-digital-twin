#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class RuntimeIndicatorChecks
    {
        // Invoked inside the isolated Play Mode harness, not the live factory.
        public static void Run()
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Indicator checks require isolated Play Mode.");
            var checks = new JArray();
            var roots = new List<GameObject>();
            void Check(bool value, string name)
            {
                if (!value) throw new InvalidOperationException("Indicator regression: " + name);
                checks.Add(name);
            }
            bool HasMarker(GameObject root, string name) => root.GetComponentsInChildren<Transform>(true)
                .Any(t => t.name == name && t.gameObject.activeSelf);
            try
            {
                foreach (var model in new[] { "pit_furnace_1_v1", "pit_furnace_5_v1", "photo_multipurpose_furnace_v6", "photo_transfer_cart_v6", "transfer_cart" })
                {
                    var root = new GameObject(model); roots.Add(root);
                    var lamp = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    lamp.name = "Authored equipment indicator lamp";
                    lamp.transform.SetParent(root.transform, false);
                    var device = new DeviceDto { Id = model, ModelType = model, InstanceConfig = new JObject { ["statusLightY"] = 6.5f } };
                    var status = root.AddComponent<DeviceStatusVisual>();
                    status.Initialize(device);
                    foreach (var state in new[] { "running", "alarm", "idle" })
                    {
                        status.ApplyRealtime(new JObject { ["status"] = new JObject { ["running"] = state == "running", ["alarm"] = state == "alarm" } });
                        Check(!HasMarker(root, "Runtime Status Beacon"), model + ": no default " + state + " floating status sphere");
                    }
                    Check(lamp.activeSelf && lamp.GetComponent<Renderer>().enabled, model + ": authored model lamp untouched");
                    var asset = new ModelAssetDto { Metadata = new JObject { ["runtime"] = new JObject { ["showStatusLight"] = true } } };
                    status.Initialize(device, asset);
                    Check(HasMarker(root, "Runtime Status Beacon"), model + ": explicit metadata opt-in supported");
                    device.InstanceConfigObject["showStatusLight"] = false;
                    status.Initialize(device, asset);
                    Check(!HasMarker(root, "Runtime Status Beacon"), model + ": explicit instance opt-out removes prior marker");
                    device.InstanceConfigObject["showStatusLight"] = "true";
                    status.Initialize(device, asset);
                    Check(!HasMarker(root, "Runtime Status Beacon"), model + ": string value does not accidentally enable marker");
                }
                var cart = new GameObject("Carrier regression"); roots.Add(cart);
                var movement = new JObject { ["enabled"] = true, ["currentPositionPointId"] = "123", ["smoothingMs"] = 0,
                    ["start"] = new JObject { ["x"] = 0 }, ["end"] = new JObject { ["x"] = 10 } };
                var movingDevice = new DeviceDto { Id = "cart-test", ModelType = "photo_transfer_cart_v6",
                    InstanceConfig = new JObject { ["movement"] = movement },
                    DataPoints = new List<DataPointDto> { new DataPointDto { Id = 123, Name = "position", Category = "analog", ValueRole = "position" } } };
                var motion = cart.AddComponent<MobileDeviceMotion>();
                motion.Initialize(movingDevice);
                foreach (var position in new[] { 0f, .2f, .8f, 1f, .1f })
                {
                    motion.ApplyRealtime(new JObject { ["analog"] = new JObject { ["position"] = position } });
                    Check(Math.Abs(cart.transform.localPosition.x - position * 10) < .001f, "carrier PLC position unchanged: " + position);
                    Check(!HasMarker(cart, "移动中提示"), "carrier movement has no floating motion sphere: " + position);
                }
                movement["showMotionIndicator"] = true;
                motion.Reconfigure(movingDevice, true);
                motion.ApplyRealtime(new JObject { ["analog"] = new JObject { ["position"] = .9f } });
                Check(HasMarker(cart, "移动中提示"), "explicit motion diagnostic opt-in supported");
                movement["showMotionIndicator"] = false;
                motion.Reconfigure(movingDevice, true);
                motion.ApplyRealtime(new JObject { ["analog"] = new JObject { ["position"] = .7f } });
                Check(!HasMarker(cart, "移动中提示"), "live reconfiguration removes motion diagnostic marker");
                Check(Math.Abs(cart.transform.localPosition.x - 7) < .001f, "carrier still moves after disabling diagnostic");
                File.WriteAllText(Path.GetFullPath("../output/runtime-indicator-checks.json"), new JObject { ["status"] = "passed", ["checkCount"] = checks.Count, ["checks"] = checks }.ToString());
                Debug.Log("[IndicatorChecks] PASS " + checks.Count);
            }
            finally { foreach (var root in roots) { root.SetActive(false); Object.Destroy(root); } }
        }

        // Build the existing scene/settings as-is; do not bootstrap over local customization.
        public static void BuildExistingClient()
        {
            ProjectBootstrap.ValidateAuthoredHallMaterials();
            ProjectBootstrap.ValidateSceneShadowCoverage();
            var output = Path.GetFullPath("Builds/Windows/HeatTreatmentDigitalTwin.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions { scenes = new[] { "Assets/Scenes/Factory.unity" },
                locationPathName = output, target = BuildTarget.StandaloneWindows64, targetGroup = BuildTargetGroup.Standalone, options = BuildOptions.None });
            if (report.summary.result != BuildResult.Succeeded) throw new BuildFailedException("Indicator-fix client build failed: " + report.summary.result);
            Debug.Log("[IndicatorChecks] Built existing client without scene/settings regeneration: " + output);
        }
    }
}
#endif
