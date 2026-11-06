#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Deterministic, display-only checks. Uses no scene assets, PLC, sockets or installed application data.
    public static class MotionSignalRuntimeChecks
    {
        private static int _checks;
        private static void Check(bool result, string message) { if (!result) throw new InvalidOperationException(message); _checks++; }
        private static void Near(double actual, double expected, string message) => Check(Math.Abs(actual - expected) < .00001, message + ": " + actual + " != " + expected);
        private static JObject Frame(JObject binding, JObject step)
        {
            var stamp = 1000000 + step.Value<double>("now") * 1000;
            return new JObject {
                ["timestamp"] = stamp, ["status"] = new JObject { ["online"] = step.Value<bool?>("online") ?? true },
                ["motionInputs"] = step.Value<bool?>("missing") == true ? new JObject() : new JObject {
                    [binding.Value<string>("actionId")] = new JObject {
                        ["dataItemId"] = step.Value<string>("identity") ?? binding.Value<string>("dataItemId"),
                        ["value"] = step["value"]?.DeepClone(), ["quality"] = step.Value<string>("quality") ?? "good",
                        ["timestamp"] = step.Value<double?>("stamp") ?? stamp, ["staleMs"] = step.Value<double?>("sourceStaleMs") ?? 5000
                    }
                }
            };
        }
        private static JObject Snapshot(MotionSignalState signal) => new JObject {
            ["position"] = signal.Position, ["target"] = signal.Target, ["seconds"] = signal.Seconds,
            ["receivedAt"] = signal.ReceivedAt, ["usable"] = signal.Usable, ["running"] = signal.Running, ["reason"] = signal.Reason
        };
        private static void CheckFixtures(JObject fixtures, JArray results)
        {
            foreach (var fixture in fixtures["cases"].OfType<JObject>())
            {
                var signal = new MotionSignalState(); var binding = (JObject)fixture["binding"]; var name = fixture.Value<string>("name");
                foreach (var step in fixture["events"].OfType<JObject>())
                {
                    if (step.Value<string>("op") == "receive") signal.Receive(Frame(binding, step), binding, step.Value<double>("now"));
                    else signal.Step(step.Value<double>("delta"), step.Value<double>("now"), step.Value<double?>("staleMs") ?? 5000, binding);
                    var actual = Snapshot(signal);
                    foreach (var expected in ((JObject)step["expect"]).Properties())
                    {
                        var label = name + "/" + step["op"] + "@" + step["now"] + "/" + expected.Name;
                        if (expected.Value.Type == JTokenType.Integer || expected.Value.Type == JTokenType.Float) Near(actual[expected.Name].Value<double>(), expected.Value.Value<double>(), label);
                        else Check(JToken.DeepEquals(actual[expected.Name], expected.Value), label);
                    }
                }
                results.Add(new JObject { ["name"] = name, ["status"] = "passed", ["final"] = Snapshot(signal) });
            }
        }
        private static void CheckComparisons()
        {
            var cases = JArray.Parse("[[\"eq\",3,3,true],[\"ne\",3,3,false],[\"ne\",3,4,true],[\"gt\",3,3,false],[\"gte\",3,3,true],[\"lt\",3,3,false],[\"lte\",3,3,true],[\"eq\",false,false,true],[\"eq\",\"运行\",\"运行\",true],[\"eq\",\"3\",3,null],[\"ne\",true,1,null],[\"gt\",\"3\",2,null]]");
            foreach (var row in cases.OfType<JArray>())
            {
                var actual = MotionSignalState.EvaluateCondition(row[1], new JObject { ["operator"] = row[0].DeepClone(), ["value"] = row[2].DeepClone() });
                Check(actual == row[3].Value<bool?>(), "operator/type boundary " + row);
            }
            var trigger = new JObject { ["operator"] = "lt", ["value"] = 50, ["hysteresis"] = 5 };
            Check(MotionSignalState.EvaluateCondition(new JValue(48), trigger, false) == true, "lt inactive enters at primary threshold");
            Check(MotionSignalState.EvaluateCondition(new JValue(51), trigger, false) == false, "lt inactive outside primary threshold");
            Check(MotionSignalState.EvaluateCondition(new JValue(44), trigger, false) == true, "lt enter band");
            Check(MotionSignalState.EvaluateCondition(new JValue(52), trigger, true) == true, "lt active dead band");
            Check(MotionSignalState.EvaluateCondition(new JValue(56), trigger, true) == false, "lt exit band");
            var greater = new JObject { ["operator"] = "gte", ["value"] = 50, ["hysteresis"] = 5 };
            Check(MotionSignalState.EvaluateCondition(new JValue(50), greater, false) == true, "gte enters at threshold, not threshold plus hysteresis");
            Check(MotionSignalState.EvaluateCondition(new JValue(51), greater, false) == true, "gte reaches primary threshold");
            Check(MotionSignalState.EvaluateCondition(new JValue(49), greater, false) == false, "gte inactive below primary threshold");
        }
        private static void CheckLegacy()
        {
            var binding = new JObject { ["sourceGroup"] = "doors", ["sourceKey"] = "open", ["pointId"] = "42", ["inputMin"] = 0, ["inputMax"] = 1 };
            var signal = new MotionSignalState();
            JObject Legacy(double now) => new JObject { ["timestamp"] = 1000000 + now * 1000, ["doors"] = new JObject { ["open"] = 1 }, ["pointMeta"] = new JObject { ["doors.open"] = new JObject { ["id"] = "42", ["timestamp"] = 1000000 } } };
            signal.Receive(Legacy(0), binding, 0); signal.Receive(Legacy(4), binding, 4); Near(signal.ReceivedAt, 0, "same PLC sample does not refresh");
            signal.Receive(new JObject { ["timestamp"] = 1010000, ["motionInputs"] = new JObject() }, binding, 4); Check(signal.Usable, "catalog-only packet does not invalidate PLC observation"); Near(signal.ReceivedAt, 0, "catalog-only packet does not refresh PLC age");
            signal.Step(0, 6, 5000, binding); Check(!signal.Usable, "source PLC read timestamp expires");
            binding["dataItemId"] = "point:stroke"; binding["actionId"] = "part:door";
            var explicitSignal = new MotionSignalState(); explicitSignal.Receive(Legacy(0), binding, 0); Check(!explicitSignal.HasSample && !explicitSignal.Usable, "catalog assignment never falls back to old point");
            var legacyBoolean = new MotionSignalState(); binding.Remove("dataItemId");
            legacyBoolean.Receive(new JObject { ["doors"] = new JObject { ["open"] = true } }, binding, 0); Near(legacyBoolean.Position, 1, "legacy boolean range compatibility");
            legacyBoolean.Receive(new JObject { ["doors"] = new JObject { ["open"] = "0.25" } }, binding, 1); Near(legacyBoolean.Position, .25, "legacy numeric text range compatibility");
        }
        private static void CheckReplayCache()
        {
            var binding = new JObject { ["actionId"] = "clip:door", ["dataItemId"] = "point:stroke", ["inputMin"] = 0, ["inputMax"] = 1 };
            var cache = new MotionInputFrameCache();
            var source = Frame(binding, new JObject { ["now"] = 0, ["value"] = 1 }); source["doors"] = new JObject { ["open"] = 99 };
            cache.Remember("fixture", source, 0);
            var older = Frame(binding, new JObject { ["now"] = 2, ["stamp"] = 999000, ["value"] = 0 }); cache.Remember("fixture", older, 2);
            Check(cache.TryGet("fixture", out var replay, 6), "motion cache replays device");
            Check(replay["doors"] == null && replay["status"] == null && replay.Value<bool>("motionInputOnly"), "replay cannot masquerade as PLC telemetry");
            Near(replay["motionInputs"]["clip:door"].Value<double>("value"), 1, "older source cannot overwrite replay input");
            Near(replay.Value<double>("timestamp"), 1006000, "replay retains elapsed source age");
            Near(replay["motionInputs"]["clip:door"].Value<double>("timestamp"), 1000000, "replay never restamps source read");
            var signal = new MotionSignalState(); signal.Receive(replay, binding, 6); Check(!signal.HasSample && !signal.Usable, "model recreation cannot resurrect expired source");
            replay["motionInputs"]["clip:door"]["value"] = 0;
            cache.TryGet("fixture", out var untouched, 6); Near(untouched["motionInputs"]["clip:door"].Value<double>("value"), 1, "replay is detached from stored input");
            var bad = Frame(binding, new JObject { ["now"] = 7, ["stamp"] = 999000, ["value"] = 0, ["quality"] = "bad" }); cache.Remember("fixture", bad, 7);
            cache.TryGet("fixture", out var failedReplay, 7); Check(failedReplay["motionInputs"]["clip:door"].Value<string>("quality") == "bad", "older failed packet stays failed after model recreation");
            Near(failedReplay["motionInputs"]["clip:door"].Value<double>("timestamp"), 1000000, "failed packet cannot restamp source freshness");
            cache.Remember("fixture", older, 7); cache.TryGet("fixture", out var noResurrection, 7); Check(noResurrection["motionInputs"]["clip:door"].Value<string>("quality") == "bad", "older good cannot overwrite cached failure");
            cache.Remember("fixture", Frame(binding, new JObject { ["now"] = 10, ["value"] = 1 }), 10);
            cache.Remember("fixture", new JObject { ["timestamp"] = 1011000, ["motionInputOnly"] = true, ["motionInputs"] = new JObject() }, 11);
            cache.TryGet("fixture", out var missingReplay, 11); Check(missingReplay["motionInputs"]["clip:door"] == null, "complete empty snapshot invalidates cached action");
            var missingSignal = new MotionSignalState(); missingSignal.Receive(missingReplay, binding, 11); Check(!missingSignal.HasSample && !missingSignal.Usable, "model recreation cannot resurrect omitted catalog action");
            cache.Clear(); Check(!cache.TryGet("fixture", out _, 7), "factory clear removes motion cache");
        }
        private static void CheckPartTransforms(Scene scene)
        {
            var root = new GameObject("part_signal_checks"); SceneManager.MoveGameObjectToScene(root, scene);
            var part = new GameObject("part"); part.transform.SetParent(root.transform, false); part.transform.localPosition = new Vector3(1, 2, 3);
            var binding = new JObject { ["actionId"] = "part:door", ["dataItemId"] = "state:door", ["enabled"] = true, ["trigger"] = new JObject { ["mode"] = "condition", ["operator"] = "eq", ["value"] = true }, ["transitionSeconds"] = 0, ["inputMin"] = 0, ["inputMax"] = 1 };
            var definition = new PartBindingDto { Id = "door", NodeName = "part", SourceGroup = "doors", SourceKey = "legacy", Action = "translate", Axis = "y", OutputMax = 2, AuthoringSpace = true };
            var driver = root.AddComponent<ModelBindingDriver>(); driver.DataTimeoutSeconds = 5; driver.Configure(new[] { definition }, new JObject { ["bindings"] = new JArray(binding) });
            JObject Observe(double now, bool value, string quality = "good") => Frame(binding, new JObject { ["now"] = now, ["value"] = value, ["quality"] = quality });
            driver.ApplyRealtime(Observe(0, false), 0); Near(part.transform.localPosition.y, 2, "configured part first actual pose");
            driver.ApplyRealtime(Observe(1, true), 1); Near(part.transform.localPosition.y, 4, "configured bool drives part endpoint");
            driver.ApplyRealtime(Observe(2, false, "bad"), 2); driver.AdvanceMotion(.5f, 2.5); Near(part.transform.localPosition.y, 4, "configured part freezes on bad value");
            driver.ApplyRealtime(Observe(3, false), 3); Near(part.transform.localPosition.y, 4, "reconnect first frame cannot jump part");
            driver.AdvanceMotion(.1f, 3.1); Near(part.transform.localPosition.y, 3, "reconnect smooths from frozen part pose");
            driver.AdvanceMotion(.1f, 3.2); Near(part.transform.localPosition.y, 2, "reconnect reaches observed part pose");
            driver.ApplyRealtime(Observe(4, true), 4); driver.AdvanceMotion(1, 10); Near(part.transform.localPosition.y, 4, "expired part observation freezes all transforms");
            var oldRow = new JObject { ["actionId"] = "part:door", ["enabled"] = true, ["sourceGroup"] = "doors", ["sourceKey"] = "open", ["inputMin"] = 0, ["inputMax"] = 1, ["transitionSeconds"] = 0 };
            driver.Configure(new[] { definition }, new JObject { ["bindings"] = new JArray(oldRow) });
            driver.ApplyRealtime(new JObject { ["doors"] = new JObject { ["open"] = 1 } }, 0); var oldPose = part.transform.localPosition;
            driver.ApplyMotionInputs(new JObject { ["motionInputOnly"] = true, ["timestamp"] = 1004000, ["motionInputs"] = new JObject(), ["doors"] = new JObject { ["open"] = 0 } }, 4);
            Check(part.transform.localPosition == oldPose, "partial frames do not update legacy part bindings");
            UnityEngine.Object.DestroyImmediate(root);
        }
        private static void CheckClipFreeze(Scene scene)
        {
            var root = new GameObject("clip_signal_checks"); SceneManager.MoveGameObjectToScene(root, scene);
            var mesh = GameObject.CreatePrimitive(PrimitiveType.Cube); mesh.name = "part"; mesh.transform.SetParent(root.transform, false);
            var package = JObject.Parse("{\"nodes\":[{\"name\":\"part\",\"v\":[0],\"c0\":[0,1,0,1]}],\"clips\":[{\"id\":\"run\",\"duration\":1,\"count\":2,\"tracks\":[{\"node\":\"part\",\"channel\":\"p\",\"size\":3,\"values\":[0,0,0,1,0,0]},{\"node\":\"part\",\"channel\":\"v\",\"size\":1,\"values\":[1,1]},{\"node\":\"part\",\"channel\":\"c0\",\"size\":4,\"values\":[1,0,0,1,1,0,0,1]}]}]}");
            var binding = new JObject { ["enabled"] = true, ["kind"] = "clip", ["mode"] = "running", ["clipId"] = "run", ["actionId"] = "clip:run", ["dataItemId"] = "point:run", ["inputMin"] = 0, ["inputMax"] = 1 };
            var driver = root.AddComponent<DeviceAnimationDriver>();
            driver.Configure(new DeviceDto { Id = "fixture", InstanceConfig = new JObject { ["animationBindings"] = new JObject { ["staleMs"] = 5000, ["bindings"] = new JArray(binding) } } }, package);
            driver.ApplyRealtime(Frame(binding, new JObject { ["now"] = 0, ["value"] = 1 }), 0); driver.Advance(.25, .25);
            Near(mesh.transform.localPosition.x, -.25, "native glTF mirror preserved"); Check(mesh.activeSelf, "running native clip visible");
            var before = new MaterialPropertyBlock(); mesh.GetComponent<Renderer>().GetPropertyBlock(before, 0);
            var color = before.GetColor("baseColorFactor"); var pose = mesh.transform.localPosition; var visible = mesh.activeSelf;
            driver.ApplyRealtime(Frame(binding, new JObject { ["now"] = 1, ["value"] = 0, ["quality"] = "bad" }), 1); driver.Advance(1, 2);
            var after = new MaterialPropertyBlock(); mesh.GetComponent<Renderer>().GetPropertyBlock(after, 0);
            Check(mesh.transform.localPosition == pose, "bad native clip preserves mechanical pose"); Check(mesh.activeSelf == visible, "bad native clip preserves visibility"); Check(after.GetColor("baseColorFactor") == color, "bad native clip preserves material state");
            UnityEngine.Object.DestroyImmediate(root);
        }
        private static JObject EndpointFrame(double now, bool extended, bool retracted, double? extendedStamp = null, double? retractedStamp = null, string quality = "good")
        {
            var stamp = 1000000 + now * 1000;
            return new JObject { ["timestamp"] = stamp, ["motionInputOnly"] = true, ["motionInputs"] = new JObject {
                ["clip:feed"] = new JObject { ["quality"] = quality, ["timestamp"] = Math.Min(extendedStamp ?? stamp, retractedStamp ?? stamp),
                    ["endpointFeedback"] = new JObject {
                        ["extended"] = new JObject { ["dataItemId"] = "point:front", ["value"] = extended, ["quality"] = quality, ["timestamp"] = extendedStamp ?? stamp, ["staleMs"] = 5000 },
                        ["retracted"] = new JObject { ["dataItemId"] = "point:back", ["value"] = retracted, ["quality"] = quality, ["timestamp"] = retractedStamp ?? stamp, ["staleMs"] = 5000 }
                    }
                }
            } };
        }
        private static void CheckEndpointCacheAndTransforms(Scene scene)
        {
            var binding = JObject.Parse("{actionId:'clip:feed',clipId:'feed',kind:'clip',enabled:true,mode:'position',transitionSeconds:2,trigger:{mode:'endpoints',extended:{dataItemId:'point:front'},retracted:{dataItemId:'point:back'}}}");
            var cache = new MotionInputFrameCache();
            cache.Remember("fixture", EndpointFrame(1, true, false, 1001000, 1000000), 1);
            cache.Remember("fixture", EndpointFrame(3, false, true, 1000000, 1003000), 3);
            Check(cache.TryGet("fixture", out var replay, 3), "endpoint cache remembers pair");
            Check(replay["motionInputs"]["clip:feed"]["endpointFeedback"]["extended"].Value<bool>("value"), "one older endpoint cannot replace pair even when minimum timestamp equals prior");
            cache.Remember("fixture", EndpointFrame(4, false, true, 1000000, 1004000, "bad"), 4);
            cache.TryGet("fixture", out var badReplay, 4);
            Check(badReplay["motionInputs"]["clip:feed"].Value<string>("quality") == "bad", "bad older endpoint invalidates rather than replaying good");
            cache.Remember("fixture", EndpointFrame(4, false, true, 1000000, 1004000), 4);
            cache.TryGet("fixture", out var stillBad, 4);
            Check(stillBad["motionInputs"]["clip:feed"].Value<string>("quality") == "bad", "old good endpoint cannot resurrect cached failure");
            var root = new GameObject("endpoint_clip_checks"); SceneManager.MoveGameObjectToScene(root, scene);
            var mesh = GameObject.CreatePrimitive(PrimitiveType.Cube); mesh.name = "part"; mesh.transform.SetParent(root.transform, false);
            var package = JObject.Parse("{nodes:[{name:'part',v:[1]}],clips:[{id:'feed',duration:1,count:2,tracks:[{node:'part',channel:'p',size:3,values:[0,0,0,1,0,0]}]}]}");
            var driver = root.AddComponent<DeviceAnimationDriver>();
            var device = new DeviceDto { Id = "fixture", InstanceConfig = new JObject { ["animationBindings"] = new JObject { ["staleMs"] = 5000, ["bindings"] = new JArray(binding) } } };
            driver.Configure(device, package); driver.ApplyMotionInputs(EndpointFrame(0, false, true), 0); driver.Advance(.1, .1); Near(mesh.transform.localPosition.x, 0, "catalog-only dual feedback reaches actual native driver");
            driver.ApplyMotionInputs(EndpointFrame(1, true, false), 1); driver.Advance(.5, 1.5); Near(mesh.transform.localPosition.x, -.25, "confirmed endpoint display smoothing matches actual Transform");
            driver.ApplyMotionInputs(EndpointFrame(2, false, false), 2); driver.Advance(.5, 2.5); Near(mesh.transform.localPosition.x, -.25, "both-off freezes actual native Transform");
            var saved = driver.CaptureEndpointDisplayStates();
            var replacement = new GameObject("endpoint_rebuilt_clip"); SceneManager.MoveGameObjectToScene(replacement, scene);
            var replacedMesh = GameObject.CreatePrimitive(PrimitiveType.Cube); replacedMesh.name = "part"; replacedMesh.transform.SetParent(replacement.transform, false);
            var replacedDriver = replacement.AddComponent<DeviceAnimationDriver>(); replacedDriver.Configure(device, package); replacedDriver.RestoreEndpointDisplayStates(saved); replacedDriver.ApplyMotionInputs(EndpointFrame(3, false, false), 3); replacedDriver.Advance(.5, 3.5);
            Near(replacedMesh.transform.localPosition.x, -.25, "config reload preserves frozen display rather than GLB zero pose");
            replacedDriver.ApplyMotionInputs(EndpointFrame(4, false, true, quality: "bad"), 4); replacedDriver.Advance(.1, 4.1); Near(replacedMesh.transform.localPosition.x, -.25, "bad endpoint quality freezes actual Transform");
            replacedDriver.ApplyMotionInputs(EndpointFrame(5, false, true), 5); replacedDriver.Advance(.01, 5.01); Near(replacedMesh.transform.localPosition.x, 0, "reconnect confirms latest endpoint without old display timer");
            UnityEngine.Object.DestroyImmediate(root); UnityEngine.Object.DestroyImmediate(replacement);
        }
        public static void Run()
        {
            _checks = 0;
            var root = Path.GetFullPath(Path.Combine(Application.dataPath, "../.."));
            var output = Path.Combine(root, "output", "motion-signal-native-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfff")); Directory.CreateDirectory(output);
            var report = new JObject { ["directory"] = output }; var results = new JArray();
            var scene = EditorSceneManager.NewPreviewScene();
            try
            {
                var fixturePath = Path.Combine(root, "frontend", "tests", "fixtures", "motion-signals.json");
                CheckFixtures(JObject.Parse(File.ReadAllText(fixturePath)), results); CheckComparisons(); CheckLegacy(); CheckReplayCache(); CheckPartTransforms(scene); CheckClipFreeze(scene); CheckEndpointCacheAndTransforms(scene);
                report["success"] = true; report["checks"] = _checks; report["fixtures"] = results;
                Debug.Log("[MotionSignalRuntimeChecks] Passed " + _checks + " checks: " + output);
            }
            catch (Exception exception) { report["success"] = false; report["checks"] = _checks; report["error"] = exception.ToString(); Debug.LogError(exception); }
            finally { EditorSceneManager.ClosePreviewScene(scene); File.WriteAllText(Path.Combine(output, "result.json"), report.ToString()); }
            if (Application.isBatchMode) EditorApplication.Exit(report.Value<bool>("success") ? 0 : 1);
        }
    }
}
#endif
