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
                // A null-graphics batch editor has a 1x1 screen; give projection
                // tests their own render target rather than the operator's display.
                var projectionTarget = new RenderTexture(1600, 900, 0);
                camera.targetTexture = projectionTarget;
                var viewport = new Rect(0, 0, 1600, 900);
                camera.pixelRect = viewport; camera.aspect = viewport.width / viewport.height;
                foreach (var precise in new[] { false, true })
                foreach (var fps in new[] { 15, 30, 60, 144 })
                foreach (var point in new[] { new Vector2(.5f, .5f), new Vector2(.76f, .68f), new Vector2(.04f, .13f) })
                {
                    var label = (precise ? "part" : "line") + " wheel " + fps + "fps " + point;
                    var bounds = new Bounds(new Vector3(7, 2, 9), precise ? Vector3.one * .1f : new Vector3(120, 12, 24));
                    orbit.FocusBounds(bounds, -39f, precise ? -30f : 33f, 1.08f, true, precise);
                    var distance = Number("_distance");
                    var pixel = new Vector2(point.x * viewport.width, point.y * viewport.height);
                    // Avoid inverting an extreme far/near projection matrix for
                    // sub-centimetre parts; that adds fixture-only pixel error.
                    var halfHeight = Mathf.Tan(camera.fieldOfView * .5f * Mathf.Deg2Rad) * distance;
                    var anchor = orbit.Target + camera.transform.right * ((point.x * 2f - 1f) * halfHeight * camera.aspect)
                        + camera.transform.up * ((point.y * 2f - 1f) * halfHeight);
                    var position = camera.transform.position;
                    orbit.ZoomAtPointer(1, pixel);
                    Check(Mathf.Abs(Number("_desiredDistance") / distance - Mathf.Exp(-.22f)) < .00001f,
                        label + " one detent closes about 20 percent (ratio=" + Number("_desiredDistance") / distance + ", viewport=" + camera.pixelRect + ")");
                    Check(Vector3.Distance(position, camera.transform.position) < .00001f, label + " input does not snap the rendered camera");
                    var maximumPixelError = 0f;
                    for (var frame = 0; frame < fps; frame++)
                    {
                        Step(1f / fps);
                        var projected = camera.WorldToScreenPoint(anchor);
                        maximumPixelError = Mathf.Max(maximumPixelError, Vector2.Distance(new Vector2(projected.x, projected.y), pixel));
                    }
                    Check(maximumPixelError < .1f, label + " cursor anchor stays fixed during smoothing and after settling (pixel error=" + maximumPixelError + ")");
                    Check(Mathf.Abs(Number("_distance") / distance - Mathf.Exp(-.22f)) < .00001f, label + " final zoom is independent of frame rate");
                    orbit.ZoomAtPointer(-1, pixel);
                    for (var frame = 0; frame < fps; frame++) Step(1f / fps);
                    Check(Vector3.Distance(position, camera.transform.position) / distance < .00001f, label + " opposite detent returns without pivot drift");
                }
                var lineBounds = new Bounds(new Vector3(7, 2, 9), new Vector3(120, 12, 24));
                var cursor = new Vector2(1100, 650);
                void ResetZoom() => orbit.FocusBounds(lineBounds, -39, 33, 1.08f, true);
                ResetZoom();
                var fullDistance = Number("_distance");
                for (var i = 0; i < 4; i++) orbit.ZoomAtPointer(1, cursor);
                var batchedDistance = Number("_desiredDistance"); var batchedTarget = Vector("_desiredTarget");
                Check(batchedDistance / fullDistance < .5f, "four wheel detents more than halve the focus distance before a rendered frame");
                ResetZoom();
                for (var i = 0; i < 40; i++) { orbit.ZoomAtPointer(.1f, cursor); Step(1f / 144f); }
                Check(Mathf.Abs(Number("_desiredDistance") - batchedDistance) / fullDistance < .00001f
                    && Vector3.Distance(batchedTarget, Vector("_desiredTarget")) / fullDistance < .00001f,
                    "fractional high-resolution input and intervening rendered frames retain the same distance and pivot");
                ResetZoom(); orbit.ZoomAtPointer(1, cursor, 2.5f); var fast = Number("_desiredDistance");
                ResetZoom(); orbit.ZoomAtPointer(1, cursor, .25f); var fine = Number("_desiredDistance");
                Check(fast < fullDistance * .6f && fine > fullDistance * .94f, "fast and fine modes provide distinct coarse and precise movement");
                ResetZoom();
                orbit.SetTransitionDuration(8);
                orbit.FocusBounds(new Bounds(Vector3.one * 30, Vector3.one * 5), 80, 55);
                Step(.02f);
                var renderedDistance = Number("_distance"); var renderedYaw = Number("_yaw");
                orbit.ZoomAtPointer(1, cursor);
                Check(Mathf.Abs(Number("_desiredDistance") / renderedDistance - Mathf.Exp(-.22f)) < .00001f
                    && Mathf.Abs(Number("_desiredYaw") - renderedYaw) < .00001f,
                    "wheel interrupts a slow authored transition from the rendered pose, not its future destination");
                Step(.02f);
                Check(Number("_distance") < renderedDistance * .88f, "manual zoom responds within 20ms despite an 8-second authored transition");
                ResetZoom();
                for (var i = 0; i < 100; i++) orbit.ZoomAtPointer(1, cursor);
                Check(Mathf.Abs(Number("_desiredDistance") - .3f) < .00001f, "overview close-up is no longer blocked by the old 2.5-unit zoom floor");
                var limitTarget = Vector("_desiredTarget");
                orbit.ZoomAtPointer(100, cursor);
                Check(Vector3.Distance(limitTarget, Vector("_desiredTarget")) < .00001f, "wheel at the near limit cannot creep the pivot");
                orbit.ZoomAtPointer(-1, cursor);
                Check(Number("_desiredDistance") > .3f, "zoom immediately reverses away from the near limit");
                for (var i = 0; i < 100; i++) orbit.ZoomAtPointer(-1, cursor);
                Check(Mathf.Abs(Number("_desiredDistance") - 1000f) < .00001f, "far zoom remains bounded");
                limitTarget = Vector("_desiredTarget"); orbit.ZoomAtPointer(-100, cursor);
                Check(Vector3.Distance(limitTarget, Vector("_desiredTarget")) < .00001f, "wheel at the far limit cannot creep the pivot");
                orbit.ZoomAtPointer(1, cursor);
                Check(Number("_desiredDistance") < 1000f, "zoom immediately reverses away from the far limit");
                ResetZoom(); var blockedTarget = Vector("_desiredTarget");
                orbit.PointerInputBlocked = true; orbit.ZoomAtPointer(1, cursor); orbit.PointerInputBlocked = false;
                orbit.InteractionEnabled = false; orbit.ZoomAtPointer(1, cursor); orbit.InteractionEnabled = true;
                orbit.ZoomAtPointer(1, new Vector2(-1, 50)); orbit.ZoomAtPointer(float.NaN, cursor);
                orbit.ZoomAtPointer(float.PositiveInfinity, cursor); orbit.ZoomAtPointer(0, cursor);
                Check(Number("_desiredDistance") == fullDistance && Vector3.Distance(blockedTarget, Vector("_desiredTarget")) == 0,
                    "HUD blocking, disabled interaction, outside pixels and invalid/zero wheel cannot move the scene");
                camera.targetTexture = null; Object.DestroyImmediate(projectionTarget);
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
