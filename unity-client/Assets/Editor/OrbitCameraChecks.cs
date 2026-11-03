#if UNITY_EDITOR
using System;
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Exercise the real controller, transforms and Unity math without sending
    // OS mouse input to the operator's running screen or changing its project.
    public static class OrbitCameraChecks
    {
        public static void Run()
        {
            var checks = new JArray();
            var root = new GameObject("__OrbitCameraContinuityChecks");
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
            try
            {
                var camera = root.AddComponent<Camera>(); camera.aspect = 16f / 9f;
                var orbit = root.AddComponent<OrbitCameraController>(); orbit.enabled = false;
                var type = typeof(OrbitCameraController);
                float Number(string field) => (float)type.GetField(field, flags).GetValue(orbit);
                Vector3 Vector(string field) => (Vector3)type.GetField(field, flags).GetValue(orbit);
                void Step(float dt) => type.GetMethod("AdvanceMotion", flags).Invoke(orbit, new object[] { dt });
                void Check(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks.Add(label); }
                Check(Mathf.LerpAngle(0, 240, .1f) < 0, "legacy shortest-angle damping reproduces a reversed +240-degree drag");
                foreach (var precise in new[] { false, true })
                foreach (var fps in new[] { 30, 60, 144 })
                foreach (var direction in new[] { -1f, 1f })
                {
                    var label = (precise ? "device/part" : "workshop/line") + " " + fps + "fps " + direction;
                    var bounds = new Bounds(new Vector3(7, -2, 9), precise ? Vector3.one * .1f : new Vector3(120, 12, 24));
                    orbit.FocusBounds(bounds, 170f * direction, precise ? -30 : 35, 1.08f, true, precise);
                    orbit.SetTransitionDuration(8f);
                    orbit.FocusBounds(new Bounds(new Vector3(-30, 4, 50), bounds.size), -40, 60, 1.08f, false, precise);
                    Step(.02f);
                    var startingTarget = orbit.Target;
                    var startingDistance = Number("_distance");
                    var startingYaw = Number("_yaw");
                    orbit.StopAutoTransition();
                    orbit.NudgeYaw(240f * direction); Step(1f / fps);
                    Check(Mathf.DeltaAngle(startingYaw, Number("_yaw")) * direction > 0f, label + " large manual drag retains its direction");
                    Check(Mathf.Abs(Number("_desiredYaw") - Number("_yaw")) < 240f, label + " manual response does not inherit an 8-second navigation delay");
                    var monotonic = true;
                    for (var frame = 0; frame < fps * 12; frame++)
                    {
                        var prior = Number("_yaw");
                        orbit.NudgeYaw(180f / fps * direction); Step(1f / fps);
                        monotonic &= Mathf.DeltaAngle(prior, Number("_yaw")) * direction > 0f;
                    }
                    Check(monotonic, label + " repeated full orbits never reverse at +/-180 or 360 degrees");
                    for (var frame = 0; frame < fps; frame++) Step(1f / fps);
                    var settled = camera.transform.rotation;
                    for (var frame = 0; frame < fps * 3; frame++) Step(1f / fps);
                    Check(Quaternion.Angle(settled, camera.transform.rotation) < .01f, label + " release and idle do not recenter");
                    Check(Vector3.Distance(startingTarget, orbit.Target) < .001f && Mathf.Abs(startingDistance - Number("_distance")) < .001f,
                        label + " cancelled preset cannot move the pivot or distance during manual orbit");
                    orbit.TrackBoundsCenter(new Bounds(Vector3.one * 100, bounds.size));
                    Check(Vector3.Distance(Vector("_desiredTarget"), startingTarget) < .001f, label + " inspection tracking cannot steal a manual pivot");
                    var beforeNextDrag = Number("_yaw");
                    orbit.StopAutoTransition(); orbit.NudgeYaw(12f * direction); Step(1f / fps);
                    Check(Mathf.DeltaAngle(beforeNextDrag, Number("_yaw")) * direction > 0, label + " second drag continues from the settled angle");
                    orbit.FocusBounds(bounds, -179, precise ? -35 : 35, 1.08f, false, precise);
                    Check(Mathf.Abs(Number("_desiredYaw") - Number("_yaw")) <= 180.001f, label + " explicit navigation still takes the short route");
                    orbit.TrackBoundsCenter(bounds);
                    Check(Vector3.Distance(Vector("_desiredTarget"), bounds.center) < .001f, label + " explicit navigation re-enables authored target tracking");
                }
                var click = new PointerClickGesture(); click.Begin(10, 10, true); click.Move(200, 10);
                Check(!click.End(10, 10, true), "returning a drag to its starting pixel cannot select or reframe a device");
                Debug.Log("[OrbitCameraChecks] PASS " + checks.Count);
                var output = Environment.GetEnvironmentVariable("ORBIT_CAMERA_REPORT")
                    ?? Path.GetFullPath(Path.Combine(Application.dataPath, "../../output/orbit-camera-native.json"));
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                File.WriteAllText(output, new JObject { ["status"] = "passed", ["checks"] = checks }.ToString());
            }
            finally { Object.DestroyImmediate(root); }
        }
    }
}
#endif
