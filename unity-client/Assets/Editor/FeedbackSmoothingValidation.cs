#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    // Real Unity drivers/transforms under the same persisted action settings as
    // the native player. No screen automation, PLC commands or authoring writes.
    public static class FeedbackSmoothingValidation
    {
        private static readonly List<GameObject> Owned = new List<GameObject>();
        private static int _checks;
        private static void Require(bool condition, string message)
        { if (!condition) throw new InvalidOperationException(message); _checks++; }
        private sealed class Fixture
        {
            public readonly Transform Slide;
            public readonly DeviceAnimationDriver Clip;
            public readonly ModelBindingDriver Part;
            public readonly string Action;
            public Fixture(bool portable, string source = "point:feedback", float outputMax = 1, string axis = "x")
            {
                var root = new GameObject("feedback-validation"); Owned.Add(root);
                var node = new GameObject("Slide"); node.transform.SetParent(root.transform, false); Slide = node.transform;
                Action = portable ? "clip:feedback" : "part:feedback";
                var binding = new JObject { ["actionId"] = Action, ["clipId"] = "feedback", ["kind"] = portable ? "clip" : "part",
                    ["mode"] = "position", ["enabled"] = true, ["dataItemId"] = source, ["inputMin"] = 0d, ["inputMax"] = 100d,
                    ["transitionSeconds"] = 10d, ["feedbackSmoothingMs"] = 200d, ["speed"] = 1d, ["trigger"] = new JObject { ["mode"] = "range" } };
                var config = new JObject { ["staleMs"] = 600000d, ["bindings"] = new JArray(binding) };
                if (portable)
                {
                    Clip = root.AddComponent<DeviceAnimationDriver>();
                    Clip.Configure(new DeviceDto { Id = "feedback-fixture", InstanceConfig = new JObject { ["animationBindings"] = config } },
                        JObject.Parse("{nodes:[{name:'Slide',p:[0,0,0],v:[1]}],clips:[{id:'feedback',count:2,duration:1,tracks:[{node:'Slide',channel:'p',size:3,values:[0,0,0,1,0,0]}]}]}"));
                }
                else
                {
                    Part = root.AddComponent<ModelBindingDriver>();
                    Part.Configure(new[] { new PartBindingDto { Id = "feedback", NodeName = "Slide", Action = "translate", Axis = axis, OutputMin = 0, OutputMax = outputMax, AuthoringSpace = false } }, config);
                }
            }
            public void Read(double value, double sourceAt, double? now = null, string quality = "good")
            {
                var frame = new JObject { ["timestamp"] = 1000000 + (now ?? sourceAt) * 1000, ["motionInputOnly"] = true,
                    ["motionInputs"] = new JObject { [Action] = new JObject { ["dataItemId"] = "point:feedback", ["value"] = value,
                        ["quality"] = quality, ["timestamp"] = 1000000 + sourceAt * 1000, ["staleMs"] = 600000d } } };
                if (Clip != null) Clip.ApplyMotionInputs(frame, now ?? sourceAt); else Part.ApplyMotionInputs(frame, now ?? sourceAt);
                // The production clip driver applies received state on the
                // next render Advance, not inside the receive callback.
                Advance(now ?? sourceAt);
            }
            public void Advance(double now)
            { if (Clip != null) Clip.Advance(.00001, now); else Part.AdvanceMotion(.00001f, now); }
            public void Suspend()
            { if (Clip != null) Clip.SuspendInputs(); else Part.SuspendInputs(); }
            public JObject Capture() => Clip != null ? Clip.CaptureEndpointDisplayStates() : Part.CaptureEndpointDisplayStates();
            public void Restore(JObject snapshot)
            { if (Clip != null) Clip.RestoreEndpointDisplayStates(snapshot); else Part.RestoreEndpointDisplayStates(snapshot); }
            public void CheckPose(double expected, string reason)
            {
                // Portable GLTF coordinates have their X axis reflected into
                // Unity. The legacy part fixture explicitly uses Unity space.
                var nativeExpected = Clip != null ? -(float)expected : (float)expected;
                Require(Math.Abs(Slide.localPosition.x - nativeExpected) < .000001 && Slide.localPosition.y == 0 && Slide.localPosition.z == 0,
                    reason + " action=" + Action + " actual=" + Slide.localPosition.ToString("R") + " expected=" + nativeExpected.ToString("R"));
            }
        }
        private static void CheckDriver(bool portable)
        {
            var fixture = new Fixture(portable); fixture.Read(0, 0); fixture.Read(100, .2);
            fixture.CheckPose(0, "New source sample teleported the native pose instead of waiting for bounded display interpolation.");
            var observed = (JObject)fixture.Capture()[fixture.Action];
            Require(observed.Value<double>("target") == 1 && observed.Value<double>("numericValue") == 100 && observed.Value<bool>("running"), "Native pose delay leaked into actual signal interpretation.");
            for (var i = 0; i <= 10; i++)
            { var now = .2 + i * .01; fixture.Advance(now); fixture.CheckPose((now - .2) / .2, "Native driver did not render each intermediate observed position."); }
            var snapshot = fixture.Capture(); var refreshed = new Fixture(portable); refreshed.Restore(snapshot);
            refreshed.CheckPose(.5, "Native hot refresh lost the displayed source history.");
            fixture.Advance(.32); refreshed.Advance(.32);
            Require(fixture.Slide.localPosition.x == refreshed.Slide.localPosition.x, "Native hot refresh changed the interpolated Float32 transform.");
            var changed = new Fixture(portable, "point:other"); changed.Restore(snapshot);
            changed.CheckPose(0, "Rebound native action inherited the former point's source history.");
            if (!portable)
            {
                var recalibrated = new Fixture(false, outputMax: 2); recalibrated.Restore(snapshot);
                recalibrated.CheckPose(0, "Changed mechanical calibration inherited the former part's display history.");
                recalibrated.Read(100, .32); recalibrated.CheckPose(2, "Changed mechanical calibration did not align to its first actual observation.");
                var newAxis = new Fixture(false, axis: "z"); newAxis.Restore(snapshot);
                newAxis.CheckPose(0, "Changed mechanical axis inherited the former part's display history.");
            }
            fixture.Advance(.4); fixture.CheckPose(1, "Native source target took more than 200ms due to stacked full-span slew.");
            fixture.Read(0, .4); fixture.Advance(.5); fixture.CheckPose(.5, "Native source reversal lost its intermediate pose.");
            fixture.Read(75, .6, quality: "bad"); fixture.Advance(.6); fixture.CheckPose(.5, "Invalid source continued moving a native actuator.");
            fixture.Read(25, .7); fixture.CheckPose(.25, "Recovery replayed the disconnected native pose history.");
            fixture.Suspend(); fixture.Advance(.8); fixture.CheckPose(.25, "Suspension did not freeze the real native transform.");
            fixture.Read(90, .9); fixture.CheckPose(.9, "Reconnect failed to align immediately to actual source feedback.");
        }
        private static long AllocationCheck(bool portable)
        {
            var fixture = new Fixture(portable); fixture.Read(0, 0); fixture.Read(100, .2);
            for (var i = 0; i < 2048; i++) fixture.Advance(.21);
            var before = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < 8192; i++) fixture.Advance(.21 + i * .00001);
            var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
            Require(bytes == 0, "Bounded native feedback animation allocated managed memory per frame: " + bytes);
            fixture.CheckPose(.45955, "Allocation loop did not actually advance a moving native actuator.");
            return bytes;
        }
        public static void Validate()
        {
            var code = 1;
            try
            {
                _checks = 0; CheckDriver(true); CheckDriver(false);
                var clipBytes = AllocationCheck(true); var partBytes = AllocationCheck(false);
                var result = new JObject { ["success"] = true, ["checks"] = _checks, ["feedbackSmoothingMs"] = 200,
                    ["actualUnityDriversAndTransforms"] = true, ["framesPerAllocationCheck"] = 8192,
                    ["clipMovingManagedBytes"] = clipBytes, ["partMovingManagedBytes"] = partBytes,
                    ["measuredVisualFps"] = false, ["browserOperations"] = 0, ["liveConfigurationWrites"] = 0, ["plcWrites"] = 0 };
                var outPath = Environment.GetEnvironmentVariable("NATIVE_FEEDBACK_SMOOTHING_VALIDATION_PATH");
                if (!string.IsNullOrEmpty(outPath)) File.WriteAllText(outPath, result.ToString());
                Debug.Log("[FeedbackSmoothingValidation] " + result.ToString(Newtonsoft.Json.Formatting.None)); code = 0;
            }
            catch (Exception error) { Debug.LogException(error); }
            finally
            {
                for (var i = Owned.Count - 1; i >= 0; i--) if (Owned[i] != null) UnityEngine.Object.DestroyImmediate(Owned[i]);
                Owned.Clear(); EditorApplication.Exit(code);
            }
        }
    }
}
#endif
