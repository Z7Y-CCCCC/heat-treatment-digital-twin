#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class MotionLoggingRuntimeChecks
    {
        [MenuItem("Digital Twin/Validate Motion Logging", priority = 31)]
        public static void Run()
        {
            var environmentValue = Environment.GetEnvironmentVariable("MOBILE_DEVICE_MOTION_DIAGNOSTICS");
            var scene = EditorSceneManager.NewPreviewScene();
            var fixtures = new List<GameObject>();
            var messages = new List<string>();
            var errors = new List<string>();
            var checks = 0;
            void Capture(string message, string stack, LogType type)
            {
                if (message.StartsWith("[MobileDeviceMotion]", StringComparison.Ordinal)) messages.Add(message);
                if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) errors.Add(message);
            }
            void Check(bool condition, string name)
            {
                if (!condition) throw new InvalidOperationException($"Motion logging check failed: {name}");
                checks++;
                Debug.Log($"[MotionLoggingChecks] PASS {name}");
            }
            MobileDeviceMotion Create(string id, bool diagnostics)
            {
                var instance = new GameObject(id);
                fixtures.Add(instance);
                SceneManager.MoveGameObjectToScene(instance, scene);
                var motion = instance.AddComponent<MobileDeviceMotion>();
                motion.Initialize(new DeviceDto
                {
                    Id = id,
                    DataPoints = new List<DataPointDto> { new DataPointDto { Id = 1, Category = "analog", Name = "position" } },
                    InstanceConfig = new JObject
                    {
                        ["movement"] = new JObject
                        {
                            ["enabled"] = true,
                            ["diagnosticLogging"] = diagnostics,
                            ["currentPositionPointId"] = 1,
                            ["valueMode"] = "normalized",
                            ["start"] = new JObject { ["x"] = 0, ["y"] = 2, ["z"] = 3 },
                            ["end"] = new JObject { ["x"] = 10, ["y"] = 2, ["z"] = 3 }
                        }
                    }
                });
                return motion;
            }
            JObject Frame(float position) => new JObject { ["analog"] = new JObject { ["position"] = position } };
            int PositionLogs() => messages.Count(message => message.Contains("PLC position="));
            Application.logMessageReceived += Capture;
            try
            {
                Environment.SetEnvironmentVariable("MOBILE_DEVICE_MOTION_DIAGNOSTICS", null);
                var normal = Create("quiet-motion", false);
                for (var index = 0; index <= 1000; index++) normal.ApplyRealtime(Frame(index / 1000f));
                Check(messages.Count == 0, "1001 ordinary position changes emit no diagnostic messages by default");
                Check((normal.transform.localPosition - new Vector3(10, 2, 3)).sqrMagnitude < .000001f,
                    "position continues updating with diagnostics disabled");

                var diagnostic = Create("sampled-motion", true);
                diagnostic.ApplyRealtime(Frame(.2f));
                Check((diagnostic.transform.localPosition - new Vector3(2, 2, 3)).sqrMagnitude < .000001f,
                    "first PLC sample still establishes the initial pose immediately");
                var firstCount = PositionLogs();
                var samePositions = true;
                for (var index = 0; index <= 1000; index++)
                {
                    var frame = Frame(index / 1000f);
                    normal.ApplyRealtime(frame);
                    diagnostic.ApplyRealtime(frame);
                    samePositions &= (normal.transform.localPosition - diagnostic.transform.localPosition).sqrMagnitude < .000001f;
                }
                Check(firstCount == 1 && PositionLogs() == 1, "enabled diagnostics sample a burst once instead of logging every change");
                Check(samePositions, "all 1001 sampled and unsampled motion positions are identical");

                // Advance only the sampling deadline; no sleeps or edits to Unity's clock/motion settings.
                var deadline = typeof(MobileDeviceMotion).GetField("_nextDiagnosticLogAt", BindingFlags.Instance | BindingFlags.NonPublic);
                deadline.SetValue(diagnostic, Time.unscaledTime - 1f);
                diagnostic.ApplyRealtime(Frame(.8f));
                Check(PositionLogs() == 2, "a later changed sample is recorded after the diagnostic interval");
                deadline.SetValue(diagnostic, Time.unscaledTime - 1f);
                diagnostic.ApplyRealtime(Frame(.8f));
                Check(PositionLogs() == 2, "an unchanged value remains quiet after the diagnostic interval");

                messages.Clear();
                Environment.SetEnvironmentVariable("MOBILE_DEVICE_MOTION_DIAGNOSTICS", "1");
                var environmentEnabled = Create("environment-motion", false);
                environmentEnabled.ApplyRealtime(Frame(.5f));
                Check(PositionLogs() == 1, "environment opt-in enables diagnostic sampling without changing device configuration");
                Check(errors.Count == 0, "motion fixtures complete without runtime errors");
                Debug.Log($"[MotionLoggingChecks] SUCCESS {checks} checks");
            }
            finally
            {
                Application.logMessageReceived -= Capture;
                Environment.SetEnvironmentVariable("MOBILE_DEVICE_MOTION_DIAGNOSTICS", environmentValue);
                foreach (var fixture in fixtures) if (fixture != null) Object.DestroyImmediate(fixture);
                EditorSceneManager.ClosePreviewScene(scene);
            }
        }
    }
}
#endif
