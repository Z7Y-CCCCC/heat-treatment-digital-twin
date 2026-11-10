using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    // CPU-only actual Unity transforms/drivers; no app UI, browser, PLC or live
    // configuration. Uses the real managed CAD motion JSON/GLB node hierarchy.
    public static class RealtimeMotionLinkageValidation
    {
        private static int _checks;
        private static JObject _benchmark;
        private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); _checks++; }
        private static Vector3 Vector(JArray values, Vector3 fallback, bool reflect = false)
        { return values?.Count == 3 ? new Vector3((reflect ? -1 : 1) * values[0].Value<float>(), values[1].Value<float>(), values[2].Value<float>()) : fallback; }
        private static GameObject Rig(JObject gltf)
        {
            var rows = (JArray)gltf["nodes"]; var nodes = rows.OfType<JObject>().Select(row => new GameObject(row.Value<string>("name"))).ToArray();
            for (var index = 0; index < nodes.Length; index++)
            {
                var row = (JObject)rows[index]; var node = nodes[index].transform;
                node.localPosition = Vector(row["translation"] as JArray, Vector3.zero, true);
                node.localScale = Vector(row["scale"] as JArray, Vector3.one);
                var q = row["rotation"] as JArray;
                node.localRotation = q?.Count == 4 ? new Quaternion(q[0].Value<float>(), -q[1].Value<float>(), -q[2].Value<float>(), q[3].Value<float>()) : Quaternion.identity;
            }
            for (var index = 0; index < nodes.Length; index++)
                foreach (var child in rows[index]["children"]?.Values<int>() ?? Enumerable.Empty<int>()) nodes[child].transform.SetParent(nodes[index].transform, false);
            var wrapper = new GameObject("Configured cart");
            foreach (var index in gltf["scenes"][(gltf.Value<int?>("scene") ?? 0)]["nodes"].Values<int>()) nodes[index].transform.SetParent(wrapper.transform, false);
            return wrapper;
        }
        private static JObject Input(double feed, bool presence, string quality = "good", long? observation = null)
        {
            var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new JObject { ["furnace_id"] = "cart", ["timestamp"] = stamp, ["motionInputOnly"] = true, ["motionInputs"] = new JObject {
                ["clip:feed"] = new JObject { ["dataItemId"] = "point:feed", ["value"] = feed, ["quality"] = "good", ["timestamp"] = stamp, ["staleMs"] = 5000 },
                ["__transfer_presence"] = new JObject { ["dataItemId"] = "point:material", ["value"] = presence, ["quality"] = quality, ["timestamp"] = observation ?? stamp, ["staleMs"] = 5000 }
            } };
        }
        private static void Tick(RealtimeTransferCoordinator coordinator) => typeof(RealtimeTransferCoordinator).GetMethod("LateUpdate", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(coordinator, null);
        private static GameObject Cargo(GameObject factory, string id = "cart") => factory.GetComponentsInChildren<Transform>(true).First(node => node.name == "Configured transfer material " + id).gameObject;
        private static bool Eligible(DeviceAnimationDriver driver) => driver.TransferDiagnostic?.Value<bool?>("handoffEligible") == true;
        private static void Near(Vector3 actual, Vector3 expected, string reason) => Require(Vector3.Distance(actual, expected) < .0002f, reason + " actual=" + actual + " expected=" + expected);
        private static JObject MobileInput(double position, bool start = true, long? observation = null)
        {
            var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new JObject { ["timestamp"] = stamp, ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
                ["analog"] = new JObject { ["position"] = position }, ["motors"] = new JObject { ["start"] = start },
                ["quality"] = new JObject { ["overall"] = "good", ["analog"] = new JObject { ["position"] = "good" }, ["motors"] = new JObject { ["start"] = "good" } }, ["pointMeta"] = new JObject {
                    ["analog.position"] = new JObject { ["id"] = 101, ["timestamp"] = observation ?? stamp, ["category"] = "analog", ["field_name"] = "position" },
                    ["motors.start"] = new JObject { ["id"] = 102, ["timestamp"] = observation ?? stamp, ["category"] = "motors", ["field_name"] = "start" }
                } };
        }
        private static void ValidateMetricPayloadAndTargetRefresh(GameObject factory, GameObject cart, GameObject furnace, GameObject cargo,
            DeviceDto source, DeviceDto target, ModelAssetDto sourceModel, ModelAssetDto targetModel, DeviceAnimationDriver driver,
            RealtimeTransferCoordinator coordinator, Dictionary<string, Transform> roots)
        {
            var movement = JObject.Parse("{enabled:false,sceneUnitsPerMeter:2}"); source.InstanceConfigObject["movement"] = movement;
            void Refresh() => coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, new Dictionary<string, MobileDeviceMotion>());
            Refresh();
            Near(cargo.transform.lossyScale, new Vector3(1, .2f, .8f), "Configured material metres were rendered as raw scene units at scale 2.");
            Near(cargo.transform.position, new Vector3(11.885f, .1f, 20), "Metric material half-height used its local rather than actual world height.");
            movement["sceneUnitsPerMeter"] = 1.25; Refresh();
            Near(cargo.transform.lossyScale, new Vector3(.625f, .125f, .5f), "Unchanged transfer configuration ignored a hot meter-scale change.");
            Near(cargo.transform.position, new Vector3(11.885f, .0625f, 20), "Hot meter-scale change retained an old material support height.");
            movement.Remove("sceneUnitsPerMeter"); movement["scene_units_per_meter"] = 2; Refresh();
            Near(cargo.transform.lossyScale, new Vector3(1, .2f, .8f), "Legacy snake_case metre calibration differs from mobile motion.");
            movement["scene_units_per_meter"] = 1; factory.transform.localScale = new Vector3(2, 3, 4); Refresh();
            Near(cargo.transform.lossyScale, new Vector3(.5f, .1f, .4f), "Payload parent nonuniform scale changed configured metre dimensions.");
            Near(cargo.transform.position, new Vector3(23.77f, .05f, 80), "Actual world material half-height drifted under a scaled presentation parent.");
            cart.transform.localRotation = Quaternion.Euler(0, 45, 0); Tick(coordinator);
            Require(!cargo.activeSelf && !Eligible(driver), "A sheared nonuniform/yaw parent was presented as a metrically rectangular material.");
            cart.transform.localRotation = Quaternion.identity; factory.transform.localScale = new Vector3(1, -1, 1); Tick(coordinator);
            Require(!cargo.activeSelf, "An upside-down support silently placed material above the wrong face.");
            factory.transform.localScale = new Vector3(0, 1, 1); Tick(coordinator); Require(!cargo.activeSelf, "Zero parent scale produced a nonfinite material pose.");
            factory.transform.localScale = Vector3.one; Refresh();
            Require(cargo.activeSelf && Eligible(driver), "Valid metric source failed to recover after invalid presentation geometry.");
            var supportedPosition = cargo.transform.position;
            cart.transform.localScale = new Vector3(1, -1, 1); Tick(coordinator);
            Require(!cargo.activeSelf && !Eligible(driver) && driver.TransferDiagnostic?["sourceMaterialVisible"]?.Value<bool>() == false,
                "Source-only Y reflection passed a normal presentation parent and fabricated an upright support.");
            cart.transform.localScale = Vector3.one; cart.transform.localRotation = Quaternion.Euler(0, 0, 12); Tick(coordinator);
            Require(!cargo.activeSelf && !Eligible(driver), "A source-only tilted support was treated as a horizontal material plane.");
            cart.transform.localRotation = Quaternion.identity; cart.transform.localScale = new Vector3(1, 0, 1); Tick(coordinator);
            Require(!cargo.activeSelf && !Eligible(driver), "A source-only zero-height support fabricated a load pose under a valid presentation parent.");
            cart.transform.localScale = Vector3.one; Refresh();
            Require(cargo.activeSelf && Eligible(driver), "Valid source support failed to recover after source-only reflection/tilt/degeneracy.");
            Near(cargo.transform.position, supportedPosition, "Source support validation changed the actual restored material position.");
            foreach (var invalid in new[] { 0d, -1, double.NaN })
            { movement["scene_units_per_meter"] = invalid; Refresh(); Require(!cargo.activeSelf && !Eligible(driver), "Invalid metre calibration displayed an invented size or handoff."); }
            movement["scene_units_per_meter"] = 1; Refresh();
            var physicalNode = cart.GetComponentsInChildren<Transform>(true).First(node => node.name == "cad_transfer_cart_v1_feed_carriage");
            var heldDrive = physicalNode.localPosition; var heldCargo = cargo.transform.position;
            target.InstanceConfigObject["movement"] = new JObject { ["enabled"] = true }; Refresh();
            Require(cargo.activeSelf && !Eligible(driver) && driver.TransferDiagnostic?["sourceMaterialVisible"]?.Value<bool>() == true,
                "Enabling target movement hid healthy source material or kept a false fixed handoff eligible.");
            Near(cargo.transform.position, heldCargo, "A hot mobile target changed the observed source material position.");
            Near(physicalNode.localPosition, heldDrive, "A mobile target changed the source actuator to simulate transfer.");
            target.InstanceConfigObject["movement"]["enabled"] = false; Refresh();
            Require(cargo.activeSelf && Eligible(driver), "Restoring a fixed target did not re-evaluate the existing physical source.");
        }
        private static void ValidateLineCalibrationInheritance(GameObject factory, GameObject cart, GameObject cargo,
            DeviceDto source, DeviceDto target, ModelAssetDto sourceModel, ModelAssetDto targetModel,
            DeviceAnimationDriver driver, RealtimeTransferCoordinator coordinator, Dictionary<string, Transform> roots)
        {
            var instance = source.InstanceConfigObject;
            var originalMovement = instance["movement"]?.DeepClone(); var originalRail = instance["railLineId"]?.DeepClone(); var originalLine = source.LineId;
            var line = new LineDto { Id = "calibrated-line", Layout = new JObject { ["sceneUnitsPerMeter"] = .8 } };
            var node = cart.GetComponentsInChildren<Transform>(true).First(item => item.name == "cad_transfer_cart_v1_feed_carriage");
            var drive = node.localPosition; var pointClock = driver.TransferDiagnostic?["presenceSourceTimestamp"]?.DeepClone();
            void Refresh() => coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots,
                new Dictionary<string, MobileDeviceMotion>(), new[] { line });
            source.LineId = line.Id; instance.Remove("movement");
            foreach (var units in new[] { .8, 1.25, 2d })
            {
                line.LayoutObject["sceneUnitsPerMeter"] = units; Refresh();
                Require(cargo.activeSelf && Eligible(driver), "A fixed source without movement did not inherit its authored line calibration.");
                Near(cargo.transform.lossyScale, new Vector3(.5f, .1f, .4f) * (float)units, "Line calibration differs from actual material metre dimensions.");
                Near(cargo.transform.position, new Vector3(11.885f, .05f * (float)units, 20), "Inherited line units used an old or unscaled material half-height.");
                Near(node.localPosition, drive, "Line calibration rewrote physical actuator travel.");
                Require(instance["movement"] == null, "Reading a line calibration wrote an invented movement object.");
                Require(JToken.DeepEquals(pointClock, driver.TransferDiagnostic?["presenceSourceTimestamp"]), "A line calibration update fabricated a new material observation clock.");
            }
            source.LineId = null; instance["railLineId"] = line.Id; Refresh();
            Require(cargo.activeSelf, "A workshop-owned source lost its explicitly bound rail line calibration.");
            instance["movement"] = new JObject { ["enabled"] = false, ["sceneUnitsPerMeter"] = 1 }; Refresh();
            Require(!cargo.activeSelf && !Eligible(driver) && driver.TransferDiagnostic?["reason"]?.ToString().Contains("不一致") == true,
                "An explicitly conflicting calibration silently changed material scale or approved handoff.");
            instance["movement"]["sceneUnitsPerMeter"] = 2; Refresh();
            Require(cargo.activeSelf && Eligible(driver), "Matching manual calibration did not recover without a fabricated new point sample.");
            instance["movement"]["scene_units_per_meter"] = JValue.CreateNull(); Refresh();
            Require(!cargo.activeSelf && !Eligible(driver), "A malformed explicit legacy alias was hidden by a valid canonical value.");
            instance.Remove("movement"); line.LayoutObject["sceneUnitsPerMeter"] = 0; Refresh();
            Require(!cargo.activeSelf && !Eligible(driver), "An invalid declared line calibration fell back to 1 metre.");
            source.LineId = originalLine;
            if (originalRail == null) instance.Remove("railLineId"); else instance["railLineId"] = originalRail;
            if (originalMovement == null) instance.Remove("movement"); else instance["movement"] = originalMovement;
            coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, new Dictionary<string, MobileDeviceMotion>());
            Require(cargo.activeSelf && Eligible(driver), "Restoring the original source configuration lost its existing healthy observation.");

            var mobileRoot = new GameObject("Independent inherited movement calibration"); mobileRoot.transform.SetParent(factory.transform, false);
            var movement = JObject.Parse("{enabled:true,currentPositionPointId:'101',startActionPointId:'102',valueMode:'station',stationInputMeaning:'target',simulationEnabled:true,speedMode:'fixed',maxSpeed:2,acceleration:1,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:10,y:0,z:0}}]}");
            var device = new DeviceDto { Id = "calibrated-mobile", InstanceConfig = new JObject { ["movement"] = movement }, DataPoints = new List<DataPointDto> {
                new DataPointDto { Id = 101, DeviceId = "calibrated-mobile", Category = "analog", ValueRole = "position" },
                new DataPointDto { Id = 102, DeviceId = "calibrated-mobile", Category = "motors", ValueRole = "start" } } };
            var mobile = mobileRoot.AddComponent<MobileDeviceMotion>(); var layout = new JObject { ["sceneUnitsPerMeter"] = .8 };
            mobile.Initialize(device, layout); mobile.ApplyRealtime(MobileInput(2)); mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
            Near(mobileRoot.transform.localPosition, new Vector3(.2f, 0, 0), "Inherited movement units changed the configured m/s speed or acceleration budget.");
            layout["sceneUnitsPerMeter"] = 2; var held = mobileRoot.transform.localPosition; mobile.UpdateLineCalibration(device, layout);
            Near(mobileRoot.transform.localPosition, held, "Hot line calibration teleported an estimated target into measured arrival.");
            mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
            Near(mobileRoot.transform.localPosition, new Vector3(.7f, 0, 0), "Hot inherited line units retained an obsolete movement speed scale.");
            Require(!mobile.HasConfirmedPosition, "Calibration promoted a target command to actual docking feedback.");
            movement["sceneUnitsPerMeter"] = 1; mobile.Reconfigure(device, true, layout); held = mobileRoot.transform.localPosition;
            mobile.ApplyRealtime(MobileInput(2)); mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
            Near(mobileRoot.transform.localPosition, held, "Conflicting explicit line/mobile units continued target estimation.");
            Require(!mobile.HasFreshPosition, "Invalid calibration retained an actionable motion pose.");
            movement["sceneUnitsPerMeter"] = 2; mobile.Reconfigure(device, true, layout); mobile.ApplyRealtime(MobileInput(2));
            Require(mobile.HasFreshPosition && !mobile.HasConfirmedPosition, "Valid manual recalibration failed to restore only the configured target estimate.");
            UnityEngine.Object.DestroyImmediate(mobileRoot);
        }
        private static void ValidateContinuous111Source(GameObject factory, JObject gltf, JObject package, JObject animation,
            ModelAssetDto sourceModel, ModelAssetDto targetModel)
        {
            var scene = new GameObject("Isolated actual 111 range feedback"); scene.transform.SetParent(factory.transform, false);
            var cart = Rig(gltf); cart.transform.SetParent(scene.transform, false);
            var furnace = new GameObject("range fixed equipment"); furnace.transform.SetParent(scene.transform, false); furnace.transform.localPosition = new Vector3(-7.4f, 0, .5f);
            var config = (JObject)animation.DeepClone(); config["transferLink"]["targetMode"] = "fixed"; config["transferLink"]["targetDeviceId"] = "range_fixed";
            var movement = JObject.Parse("{enabled:true,currentPositionPointId:'1245',startActionPointId:'603',valueMode:'range',valueMin:0,valueMax:100,smoothingMs:100,simulationEnabled:true,staleMs:1000,sceneUnitsPerMeter:1,start:{x:-20,y:0,z:.5},end:{x:-10,y:0,z:.5}}");
            var source = new DeviceDto { Id = "111", ModelType = sourceModel.Id, PositionX = -20, PositionZ = .5f,
                InstanceConfig = new JObject { ["movement"] = movement, ["animationBindings"] = config }, DataPoints = new List<DataPointDto> {
                    new DataPointDto { Id = 1245, DeviceId = "111", Category = "mechanisms", ValueRole = "actual_position_pct" },
                    new DataPointDto { Id = 603, DeviceId = "111", Category = "analog", ValueRole = "point_cd612f" } } };
            var target = new DeviceDto { Id = "range_fixed", ModelType = targetModel.Id, InstanceConfig = new JObject() };
            var driver = cart.AddComponent<DeviceAnimationDriver>(); driver.Configure(source, package);
            var mobile = cart.AddComponent<MobileDeviceMotion>(); mobile.Initialize(source);
            var coordinator = scene.AddComponent<RealtimeTransferCoordinator>();
            var roots = new Dictionary<string, Transform> { [source.Id] = cart.transform, [target.Id] = furnace.transform };
            var motions = new Dictionary<string, MobileDeviceMotion> { [source.Id] = mobile };
            void Refresh() => coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, motions);
            var sequence = 0;
            JObject Position(double percent, bool running)
            {
                var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ++sequence;
                return new JObject { ["furnace_id"] = "111", ["timestamp"] = stamp, ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
                    ["mechanisms"] = new JObject { ["actual_position_pct"] = percent }, ["analog"] = new JObject { ["point_cd612f"] = running ? 1 : 0 },
                    ["quality"] = new JObject { ["overall"] = "good", ["mechanisms"] = new JObject { ["actual_position_pct"] = "good" }, ["analog"] = new JObject { ["point_cd612f"] = "good" } },
                    ["pointMeta"] = new JObject { ["mechanisms.actual_position_pct"] = new JObject { ["id"] = 1245, ["timestamp"] = stamp },
                        ["analog.point_cd612f"] = new JObject { ["id"] = 603, ["timestamp"] = stamp } } };
            }
            JObject Motion(double phase, bool present) { var frame = Input(phase, present); frame["furnace_id"] = "111"; return frame; }
            Refresh(); var frame = Motion(0, true); driver.ApplyMotionInputs(frame); driver.Advance(0, Time.realtimeSinceStartupAsDouble); coordinator.ApplyInputs(source.Id, frame);
            mobile.ApplyRealtime(Position(20, true)); mobile.AdvanceMotion(0, Time.realtimeSinceStartupAsDouble); Tick(coordinator);
            var cargo = Cargo(scene, source.Id);
            Require(cargo.activeSelf && !Eligible(driver) && mobile.HasReliableSourcePose && !mobile.HasConfirmedPosition,
                "Real 111-style moving coordinates made healthy material disappear or incorrectly confirmed docking.");
            Near(cargo.transform.position, new Vector3(-17.2f, .05f, .5f), "Moving source material ignored its measured initial cart coordinates.");
            mobile.ApplyRealtime(Position(80, true)); mobile.AdvanceMotion(.11f, Time.realtimeSinceStartupAsDouble + .11); Tick(coordinator);
            Near(cart.transform.localPosition, new Vector3(-12, 0, .5f), "Fresh range feedback was replaced by a station journey estimate.");
            Near(cargo.transform.position, new Vector3(-11.2f, .05f, .5f), "Cargo did not remain continuously attached to the rendered measured cart.");
            Require(cargo.activeSelf && !Eligible(driver), "Moving=true lost source material or claimed a fixed handoff.");
            mobile.ApplyRealtime(Position(100, false));
            Near(cart.transform.localPosition, new Vector3(-10, 0, .5f), "Fresh range position plus stopped movement retained a smoothing/old-target delay.");
            frame = Motion(1, true); driver.ApplyMotionInputs(frame); driver.Advance(.5, Time.realtimeSinceStartupAsDouble + .5); coordinator.ApplyInputs(source.Id, frame); Tick(coordinator);
            Require(cargo.activeSelf && Eligible(driver) && mobile.HasConfirmedPosition, "Measured 111 arrival plus false movement bit failed same-frame feed handoff.");
            Near(cargo.transform.position, new Vector3(-8.6575f, .05f, .5f), "111 material failed to follow the real half-stroke node after measured arrival.");
            driver.Advance(.5, Time.realtimeSinceStartupAsDouble + .5); Tick(coordinator);
            Near(cargo.transform.position, new Vector3(-8.115f, .05f, .5f), "111 source material used a separate invented transfer timeline.");
            var feed = cart.GetComponentsInChildren<Transform>(true).First(node => node.name == "cad_transfer_cart_v1_feed_carriage"); var heldFeed = feed.localPosition;
            mobile.ApplyRealtime(Position(80, true)); mobile.AdvanceMotion(.11f, Time.realtimeSinceStartupAsDouble + .11); Tick(coordinator);
            Require(cargo.activeSelf && !Eligible(driver), "A fresh moving position after feed erased real source material or retained docking authorization.");
            Near(cargo.transform.position, new Vector3(-10.115f, .05f, .5f), "Moving loaded cart detached its material from the actual feed carriage.");
            mobile.ApplyRealtime(Position(100, false)); Tick(coordinator);
            target.InstanceConfigObject["movement"] = new JObject { ["enabled"] = true }; Refresh();
            Require(cargo.activeSelf && !Eligible(driver), "Hot moving target still allowed a fixed 111 handoff or hid its confirmed material.");
            target.InstanceConfigObject["movement"]["enabled"] = false; Refresh(); Require(cargo.activeSelf && Eligible(driver), "Fixed target restoration did not reconfirm observed source eligibility.");
            furnace.transform.localPosition += Vector3.right * 3; Tick(coordinator);
            Require(cargo.activeSelf && !Eligible(driver), "Unreachable target erased source material or invented a completed handoff.");
            Near(feed.localPosition, heldFeed, "Unreachable target stretched the source feed actuator.");
            Near(cargo.transform.position, new Vector3(-8.115f, .05f, .5f), "Unreachable target remapped cargo to a guessed target port.");
            furnace.transform.localPosition -= Vector3.right * 3;
            coordinator.ApplyInputs(source.Id, Motion(1, false)); Tick(coordinator); Require(!cargo.activeSelf && !Eligible(driver), "False observed material presence retained a source load.");
            coordinator.ApplyInputs(source.Id, Motion(1, true)); Tick(coordinator); Require(cargo.activeSelf, "Fresh true presence did not recover real measured source material.");
            foreach (var mutate in new Action<JObject>[] { data => data.Remove("pointMeta"),
                data => ((JObject)data["pointMeta"]["mechanisms.actual_position_pct"]).Remove("timestamp"),
                data => ((JObject)data["pointMeta"]["analog.point_cd612f"]).Remove("id"),
                data => data["cachedAgeMs"] = 10000 })
            {
                var bad = Position(0, false); mutate(bad); var held = cart.transform.localPosition; mobile.ApplyRealtime(bad); Tick(coordinator);
                Near(cart.transform.localPosition, held, "Missing/old 111 source confirmation changed the held measured pose.");
                Require(!cargo.activeSelf && !Eligible(driver) && !mobile.HasFreshPosition, "A wrapper revived invalid/ten-second cached mobile source material.");
                mobile.ApplyRealtime(Position(100, false)); Tick(coordinator); Require(cargo.activeSelf && Eligible(driver), "Fresh owned continuous feedback failed to recover after a rejected wrapper.");
            }
            movement["valueMode"] = "normalized"; mobile.Reconfigure(source, true); mobile.ApplyRealtime(Position(.8, true)); mobile.AdvanceMotion(.11f, Time.realtimeSinceStartupAsDouble + .11); Tick(coordinator);
            Near(cart.transform.localPosition, new Vector3(-12, 0, .5f), "Normalized actual moving feedback used different gating than range feedback.");
            Require(cargo.activeSelf && !Eligible(driver), "Normalized moving real load disappeared or became docked.");
            mobile.ApplyRealtime(Position(1, false)); Tick(coordinator); Require(cargo.activeSelf && Eligible(driver), "Normalized stopped measured position did not confirm immediate docking.");
            var unknown = (JObject)config["transferLink"]; unknown["driveNodeName"] = "missing_actual_drive"; Refresh();
            coordinator.ApplyInputs(source.Id, Motion(1, true)); Tick(coordinator); Require(!Cargo(scene, source.Id).activeSelf && !Eligible(driver), "Unknown source drive fabricated a material location.");
            unknown["driveNodeName"] = "cad_transfer_cart_v1_feed_carriage"; Refresh(); coordinator.ApplyInputs(source.Id, Motion(1, true)); Tick(coordinator);
            Require(Cargo(scene, source.Id).activeSelf, "Restored source drive could not show its true material presence.");
            mobile.AdvanceMotion(.1f, Time.realtimeSinceStartupAsDouble + 2); coordinator.Advance(.1f, Time.realtimeSinceStartupAsDouble + 2);
            Require(!Cargo(scene, source.Id).activeSelf && !Eligible(driver), "Silent actual mobile source expiry retained material or handoff eligibility.");
        }
        private static void ValidateCompiledTracks(JObject package)
        {
            foreach (var clip in package["clips"].OfType<JObject>())
            {
                var equal = true;
                foreach (var track in clip["tracks"].OfType<JObject>())
                {
                    if (!CompiledMotionTrack.TryCompile(clip, track, out var compiled, out _)) { equal = false; break; }
                    var reference = new double[compiled.Size]; var actual = new double[compiled.Size];
                    foreach (var progress in new[] { -.1, 0, .001, .13, .5, .79, .999, 1, 1.1 })
                    {
                        var time = progress * compiled.Duration; MotionSignalState.SampleInto(clip, track, time, reference);
                        if (!compiled.SampleInto(time, actual) || !reference.SequenceEqual(actual)) { equal = false; break; }
                    }
                    if (!equal) break;
                }
                Require(equal, "Compiled sampling changed actual managed CAD channels for " + clip["id"]);
            }
        }
        private static void BenchmarkActualDriver(DeviceAnimationDriver driver, RealtimeTransferCoordinator coordinator, GameObject cargo, int trackCount)
        {
            var now = Time.realtimeSinceStartupAsDouble;
            for (var frame = 0; frame < 256; frame++) { driver.Advance(1d / 60, now); coordinator.Advance(1f / 60, now); }
            var allocationMethod = typeof(GC).GetMethod("GetAllocatedBytesForCurrentThread", BindingFlags.Public | BindingFlags.Static);
            var allocationCounter = allocationMethod == null ? null : (Func<long>)Delegate.CreateDelegate(typeof(Func<long>), allocationMethod);
            Require(allocationCounter != null, "Actual Unity runtime did not expose a trustworthy allocation counter.");
            var timer = new System.Diagnostics.Stopwatch();
            var before = allocationCounter(); timer.Start();
            const int frames = 2048;
            for (var frame = 0; frame < frames; frame++) { driver.Advance(1d / 60, now); coordinator.Advance(1f / 60, now); }
            timer.Stop(); var bytes = allocationCounter() - before;
            Require(bytes == 0, "Actual Unity steady-state clip/link rendering allocated per frame: " + bytes + " bytes.");
            Require(cargo.activeSelf, "CPU benchmark lost the valid actual handoff pose.");
            _benchmark = new JObject { ["frames"] = frames, ["actualCadFeedTracks"] = trackCount, ["elapsedMilliseconds"] = timer.Elapsed.TotalMilliseconds,
                ["millisecondsPerCpuAdvance"] = timer.Elapsed.TotalMilliseconds / frames, ["managedAllocatedBytes"] = bytes,
                ["diagnosticsEnabled"] = false, ["fixedSourceClockForIsolatedCpuBenchmark"] = true,
                ["includesActualUnityTransformApplication"] = true, ["includesTransferReachCheck"] = true,
                ["measuredNetworkLatency"] = false, ["measuredGpuLatency"] = false };
        }
        private static void ValidateLegacyPointDriver(GameObject factory)
        {
            var root = new GameObject("Isolated legacy part acceptance"); root.transform.SetParent(factory.transform, false);
            var door = new GameObject("legacy_door"); door.transform.SetParent(root.transform, false);
            var lamp = new GameObject("legacy_lamp"); lamp.transform.SetParent(root.transform, false);
            var part = root.AddComponent<ModelBindingDriver>(); part.DataTimeoutSeconds = 1;
            part.Configure(new[] { new PartBindingDto { Id = "door", NodeName = door.name, PointId = "700", SourceGroup = "doors", SourceKey = "open",
                    Action = "translate", Axis = "x", InputMin = 0, InputMax = 1, OutputMin = 0, OutputMax = 2, TransitionDuration = 1 },
                new PartBindingDto { Id = "lamp", NodeName = lamp.name, PointId = "701", SourceGroup = "mechanisms", SourceKey = "lamp", Action = "visibility" } });
            var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            JObject Frame(double value, long observation, bool meta = true, string quality = "good")
            {
                var frame = new JObject { ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["doors"] = new JObject { ["open"] = value },
                    ["mechanisms"] = new JObject { ["lamp"] = "on" }, ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
                    ["quality"] = new JObject { ["overall"] = "good" } };
                if (meta) frame["pointMeta"] = new JObject {
                    ["doors.open"] = new JObject { ["id"] = "700", ["timestamp"] = observation, ["quality"] = quality },
                    ["mechanisms.lamp"] = new JObject { ["id"] = "701", ["timestamp"] = observation, ["quality"] = quality } };
                return frame;
            }
            part.ApplyRealtime(Frame(.5, stamp));
            Near(door.transform.localPosition, Vector3.right, "Legacy assigned part did not establish its first measured pose.");
            Require(lamp.activeSelf, "Legacy source confirmation changed an existing textual visibility action into a numeric binding.");
            part.ApplyRealtime(Frame(1, stamp + 1)); part.AdvanceMotion(.25f, Time.realtimeSinceStartupAsDouble + .25);
            Near(door.transform.localPosition, Vector3.right * 1.5f, "Strict legacy confirmation changed the authored range/transition formula.");
            part.ApplyRealtime(Frame(0, stamp)); part.AdvanceMotion(.1f, Time.realtimeSinceStartupAsDouble + .35);
            Near(door.transform.localPosition, Vector3.right * 1.7f, "An older legacy point read reversed a newer part target.");
            part.ApplyRealtime(Frame(0, stamp + 2, false)); var held = door.transform.localPosition;
            part.AdvanceMotion(.25f, Time.realtimeSinceStartupAsDouble + .6);
            Near(door.transform.localPosition, held, "Missing owned point metadata revived a real legacy part on wrapper receipt.");
            part.ApplyRealtime(Frame(.25, stamp + 3));
            Near(door.transform.localPosition, Vector3.right * .5f, "Fresh legacy recovery replayed an old estimated part opening.");
            part.ApplyRealtime(Frame(1, stamp + 4, quality: "bad")); part.AdvanceMotion(.25f, Time.realtimeSinceStartupAsDouble + .25);
            Near(door.transform.localPosition, Vector3.right * .5f, "Bad point metadata changed or reset a held legacy pose.");
            part.SuspendInputs(); part.ApplyRealtime(Frame(1, stamp - 10000));
            Near(door.transform.localPosition, Vector3.right * .5f, "Queued old source revived an explicitly assigned legacy part after disconnect.");
            part.ApplyRealtime(Frame(.25, stamp + 5)); part.AdvanceMotion(.1f, Time.realtimeSinceStartupAsDouble + 2);
            Near(door.transform.localPosition, Vector3.right * .5f, "Silent point-age expiry continued a legacy target.");
            // Unbound model-level settings intentionally keep their existing
            // read-only compatibility rather than silently assigning point IDs.
            var unbound = new GameObject("legacy_unbound"); unbound.transform.SetParent(root.transform, false);
            part.Configure(new[] { new PartBindingDto { Id = "unbound", NodeName = unbound.name, SourceGroup = "doors", SourceKey = "open",
                Action = "translate", Axis = "x", InputMin = 0, InputMax = 1, OutputMin = 0, OutputMax = 2 } });
            part.ApplyRealtime(Frame(.5, stamp + 6, false));
            Near(unbound.transform.localPosition, Vector3.right, "Older unbound model-level part behavior was made incompatible.");
        }
        private static void ValidatePartRotationBounds(GameObject factory)
        {
            var root = new GameObject("Isolated continuous RPM acceptance"); root.transform.SetParent(factory.transform, false);
            var fan = new GameObject("bounds_fan"); fan.transform.SetParent(root.transform, false);
            var driver = root.AddComponent<ModelBindingDriver>(); driver.DataTimeoutSeconds = 5;
            var definition = new PartBindingDto { Id = "fan", NodeName = fan.name, PointId = "702", SourceGroup = "mechanisms", SourceKey = "rpm",
                Action = "rotate_speed", Axis = "y", SpeedFactor = .25f, InputMin = 0, InputMax = 1000 };
            var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); var now = Time.realtimeSinceStartupAsDouble;
            JObject Frame(double rpm, int sequence) => new JObject { ["timestamp"] = stamp + sequence,
                ["mechanisms"] = new JObject { ["rpm"] = rpm }, ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
                ["quality"] = new JObject { ["overall"] = "good" }, ["pointMeta"] = new JObject {
                    ["mechanisms.rpm"] = new JObject { ["id"] = "702", ["timestamp"] = stamp + sequence, ["quality"] = "good" } } };
            bool Finite(Quaternion q) => !float.IsNaN(q.x) && !float.IsInfinity(q.x) && !float.IsNaN(q.y) && !float.IsInfinity(q.y)
                && !float.IsNaN(q.z) && !float.IsInfinity(q.z) && !float.IsNaN(q.w) && !float.IsInfinity(q.w);
            driver.Configure(new[] { definition }); driver.ApplyRealtime(Frame(10, 0), now); driver.AdvanceMotion(.1f, now + .1);
            Require(Quaternion.Angle(fan.transform.localRotation, Quaternion.AngleAxis(10 * .25f * Mathf.Rad2Deg * .1f, Vector3.up)) < .001f,
                "Legacy continuous RPM no longer follows the actual numeric factor.");
            var held = fan.transform.localRotation;
            driver.ApplyRealtime(Frame(float.MaxValue, 1), now + .2); driver.AdvanceMotion(.1f, now + .3);
            Require(Finite(fan.transform.localRotation) && Quaternion.Angle(held, fan.transform.localRotation) < .001f,
                "Overflowing legacy RPM contaminated the held Unity quaternion.");
            driver.ApplyRealtime(Frame(2, 2), now + .4); driver.AdvanceMotion(.1f, now + .5);
            Require(Quaternion.Angle(held, fan.transform.localRotation) > .1f && Finite(fan.transform.localRotation),
                "A fresh valid RPM could not recover after a numerical fault.");

            fan.transform.localRotation = Quaternion.identity;
            var binding = JObject.Parse("{actionId:'part:fan',enabled:true,kind:'part',mode:'running',dataItemId:'point:rpm',trigger:{mode:'range'},inputMin:0,inputMax:1000,speed:1.5,invert:true}");
            driver.Configure(new[] { definition }, new JObject { ["version"] = 1, ["staleMs"] = 5000, ["bindings"] = new JArray(binding) });
            JObject Catalog(double rpm, int sequence) => new JObject { ["timestamp"] = stamp + sequence, ["motionInputOnly"] = true,
                ["motionInputs"] = new JObject { ["part:fan"] = new JObject { ["dataItemId"] = "point:rpm", ["value"] = rpm,
                    ["timestamp"] = stamp + sequence, ["quality"] = "good", ["staleMs"] = 5000 } } };
            driver.ApplyRealtime(Catalog(10, 3), now + .6); driver.AdvanceMotion(.1f, now + .7);
            Require(Quaternion.Angle(fan.transform.localRotation, Quaternion.AngleAxis(-10 * .25f * Mathf.Rad2Deg * 1.5f * .1f, Vector3.up)) < .001f,
                "Catalog RPM became a midpoint switch or lost configured speed/inversion.");
            held = fan.transform.localRotation;
            driver.ApplyRealtime(Catalog(float.MaxValue, 4), now + .8); driver.AdvanceMotion(.1f, now + .9);
            Require(Finite(fan.transform.localRotation) && Quaternion.Angle(held, fan.transform.localRotation) < .001f,
                "Overflowing catalog RPM contaminated the held Unity quaternion.");
            driver.ApplyRealtime(Catalog(float.MaxValue / 1000, 5), now + 1);
            driver.AdvanceMotion(float.MaxValue, now + 1.1);
            Require(Finite(fan.transform.localRotation) && Quaternion.Angle(held, fan.transform.localRotation) < .001f,
                "An overflowing render step reached Unity Transform.Rotate.");
        }
        private static void ValidateAnimationDeclarationIsolation()
        {
            var selection = typeof(RuntimeModelLibrary).GetMethod("DeviceBindings", BindingFlags.Static | BindingFlags.NonPublic);
            var definitions = new[] { new PartBindingDto { Id = "fan", NodeName = "fan", Action = "rotate_speed", SourceGroup = "motors", SourceKey = "rpm", PointId = "702" } };
            int Count(JObject instance) => ((List<PartBindingDto>)selection.Invoke(null, new object[] { definitions,
                new DeviceDto { Id = "isolated_bad_animation_config", InstanceConfig = instance } })).Count;
            Require(Count(new JObject()) == 1, "Missing animation configuration stopped inheriting existing model-level parts.");
            foreach (var invalid in new JToken[] { JValue.CreateNull(), new JValue(true), new JValue(1), new JValue("invalid"), new JArray() })
                Require(Count(new JObject { ["animationBindings"] = invalid }) == 0,
                    "An explicit malformed animation declaration threw or reactivated inherited actions.");
            Require(Count(JObject.Parse("{animationBindings:{}}")) == 0, "An explicit empty object reactivated model-level actions.");
            Require(Count(JObject.Parse("{animationBindings:{bindings:[]}}")) == 0, "An explicit empty action list reactivated model-level actions.");
            Require(Count(JObject.Parse("{animationBindings:{bindings:[{actionId:'part:fan',enabled:false}]}}")) == 0,
                "An explicitly disabled part inherited the model's live source.");
            Require(Count(JObject.Parse("{animationBindings:{bindings:[{actionId:'part:fan',enabled:true,sourceGroup:'motors',sourceKey:'rpm',pointId:'702',inputMin:0,inputMax:1000,transitionSeconds:0}]}}")) == 1,
                "A valid explicit enabled part was disabled by the legacy-declaration isolation guard.");
        }
        private static void ValidateLastConfirmedStationFeedback(GameObject factory)
        {
            var root = new GameObject("Retained last-arrival feedback only"); root.transform.SetParent(factory.transform, false);
            var config = JObject.Parse("{enabled:true,currentPositionPointId:'101',startActionPointId:'',valueMode:'station',stationInputMeaning:'last-confirmed',simulationEnabled:true,smoothingMs:200,maxSpeed:2,acceleration:1,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:10,y:0,z:0}}]}");
            var device = new DeviceDto { Id = "last-station-fixture", PositionX = 42, InstanceConfig = new JObject { ["movement"] = config },
                DataPoints = new List<DataPointDto> {
                    new DataPointDto { Id = 101, DeviceId = "last-station-fixture", DataType = "WORD", AccessType = "READ", Category = "analog", ValueRole = "position" },
                    new DataPointDto { Id = 102, DeviceId = "last-station-fixture", DataType = "BOOL", AccessType = "READ", Category = "motors", ValueRole = "moving" } } };
            var motion = root.AddComponent<MobileDeviceMotion>(); motion.Initialize(device);
            Near(root.transform.localPosition, new Vector3(42, 0, 0), "Missing last-arrival observation guessed a start station.");
            Require(!motion.HasFreshPosition && !motion.HasConfirmedPosition && !motion.HasReliableSourcePose, "An authored initial pose became a real station observation.");
            JObject Frame(int station, bool moving = true, string gateQuality = "good")
            {
                var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return new JObject { ["furnace_id"] = device.Id, ["timestamp"] = stamp,
                    ["analog"] = new JObject { ["position"] = station }, ["motors"] = new JObject { ["moving"] = moving },
                    ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
                    ["quality"] = new JObject { ["overall"] = "good", ["analog"] = new JObject { ["position"] = "good" }, ["motors"] = new JObject { ["moving"] = gateQuality } },
                    ["pointMeta"] = new JObject {
                        ["analog.position"] = new JObject { ["id"] = 101, ["category"] = "analog", ["field_name"] = "position", ["timestamp"] = stamp },
                        ["motors.moving"] = new JObject { ["id"] = 102, ["category"] = "motors", ["field_name"] = "moving", ["timestamp"] = stamp } } };
            }
            motion.ApplyRealtime(Frame(1));
            Near(root.transform.localPosition, Vector3.zero, "First last-arrival observation did not directly align to station 1.");
            Require(motion.HasFreshPosition && !motion.HasConfirmedPosition && !motion.HasReliableSourcePose && motion.CurrentPositionValue == 1,
                "A held station number without actual movement feedback confirmed ongoing docking.");
            root.transform.hasChanged = false;
            for (var i = 0; i < 120; i++)
            {
                motion.ApplyRealtime(Frame(1)); motion.AdvanceMotion(.00001f, Time.realtimeSinceStartupAsDouble + .00001);
                Require(motion.CurrentPositionValue == 1 && root.transform.localPosition.Equals(Vector3.zero) && !motion.HasConfirmedPosition,
                    "Repeated last-arrival feedback generated an intermediate percentage/station or arrival.");
            }
            Require(!root.transform.hasChanged, "Unchanged last-arrival reads kept dirtying native transforms.");
            motion.ApplyRealtime(Frame(2));
            Near(root.transform.localPosition, new Vector3(10, 0, 0), "New last-arrival feedback replayed an estimated journey after arrival.");
            Require(motion.CurrentPositionValue == 2 && !motion.HasConfirmedPosition, "New last-arrival number guessed continued docking.");
            motion.AdvanceMotion(.1f, Time.realtimeSinceStartupAsDouble + .1);
            Near(root.transform.localPosition, new Vector3(10, 0, 0), "Imported simulation/smoothing fields estimated an unobserved intermediate trip.");
            config["startActionPointId"] = "102"; motion.Initialize(device); motion.ApplyRealtime(Frame(1, true));
            Require(motion.HasFreshPosition && !motion.HasConfirmedPosition && !motion.HasReliableSourcePose,
                "Actual BOOL moving feedback allowed a last-station cargo docking claim.");
            motion.ApplyRealtime(Frame(1, false));
            Require(motion.HasConfirmedPosition && motion.HasReliableSourcePose, "Actual owned BOOL stopped feedback could not confirm the held station.");
            motion.ApplyRealtime(Frame(1, false, "bad"));
            Require(!motion.HasFreshPosition && !motion.HasConfirmedPosition && !motion.HasReliableSourcePose,
                "Bad actual movement feedback remained a confirmed cargo source.");
        }
        public static void Run()
        {
            var factory = (GameObject)null;
            try
            {
                _checks = 0;
                _benchmark = null;
                var root = Path.GetFullPath(Path.Combine(Application.dataPath, "../.."));
                var package = JObject.Parse(File.ReadAllText(Path.Combine(root, "backend/assets/motions/cad_transfer_cart_101300.json")));
                ValidateCompiledTracks(package);
                var bytes = File.ReadAllBytes(Path.Combine(root, "backend/assets/motions/cad_transfer_cart_101300.glb"));
                var gltf = JObject.Parse(System.Text.Encoding.UTF8.GetString(bytes, 20, BitConverter.ToInt32(bytes, 12)));
                factory = new GameObject("Isolated transfer acceptance");
                ValidateLastConfirmedStationFeedback(factory);
                var cart = Rig(gltf); cart.transform.SetParent(factory.transform, false); cart.transform.localPosition = new Vector3(10, 0, 20);
                var furnace = new GameObject("Configured fixed equipment"); furnace.transform.SetParent(factory.transform, false); furnace.transform.localPosition = new Vector3(12.6f, 0, 20);
                var transfer = JObject.Parse("{enabled:true,actionId:'clip:feed',driveNodeName:'cad_transfer_cart_v1_feed_carriage',targetMode:'fixed',targetDeviceId:'furnace',sourcePort:'outlet',targetPort:'inlet',presenceDataItemId:'point:material',materialSize:[.5,.1,.4],materialColor:'#dca34f',heightToleranceMeters:.02,lateralToleranceMeters:.02,angleToleranceDegrees:1}");
                var config = JObject.Parse("{version:1,staleMs:5000,diagnosticLogging:false,bindings:[{enabled:true,actionId:'clip:feed',kind:'clip',clipId:'feed',mode:'position',dataItemId:'point:feed',inputMin:0,inputMax:1,transitionSeconds:1,speed:1,invert:false}]}" );
                config["transferLink"] = transfer;
                var source = new DeviceDto { Id = "cart", ModelType = "cad_transfer_cart_101300", InstanceConfig = new JObject { ["animationBindings"] = config } };
                var target = new DeviceDto { Id = "furnace", ModelType = "fixture_equipment", InstanceConfig = new JObject() };
                var sourceModel = new ModelAssetDto { Id = source.ModelType, Metadata = JObject.Parse("{loadingPorts:{version:1,inlet:null,outlet:{position:[-.8,0,0],direction:[-1,0,0],nodeName:''}}}") };
                var targetModel = new ModelAssetDto { Id = target.ModelType, Metadata = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[1,0,0],direction:[1,0,0],nodeName:''},outlet:null}}") };
                var driver = cart.AddComponent<DeviceAnimationDriver>(); driver.Configure(source, package);
                var coordinator = factory.AddComponent<RealtimeTransferCoordinator>();
                var roots = new Dictionary<string, Transform> { [source.Id] = cart.transform, [target.Id] = furnace.transform };
                coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, new Dictionary<string, MobileDeviceMotion>());
                var frame = Input(0, false); driver.ApplyMotionInputs(frame); driver.Advance(0, Time.realtimeSinceStartupAsDouble); coordinator.ApplyInputs(source.Id, frame); Tick(coordinator);
                var cargo = Cargo(factory); Require(!cargo.activeSelf, "Unconfirmed/absent material was invented.");
                frame = Input(1, true); driver.ApplyMotionInputs(frame); driver.Advance(.5, Time.realtimeSinceStartupAsDouble + .5); coordinator.ApplyInputs(source.Id, frame); Tick(coordinator);
                Require(cargo.activeSelf && Eligible(driver), "Aligned real cart/fixed-device transfer did not display or confirm eligibility.");
                Near(cargo.transform.position, new Vector3(11.3425f, .05f, 20), "Cargo failed to follow the real half-stroke node.");
                driver.Advance(.5, Time.realtimeSinceStartupAsDouble + 1); Tick(coordinator);
                Near(cargo.transform.position, new Vector3(11.885f, .05f, 20), "Full feed was remapped/stretched to the furnace port instead of physical stroke.");
                BenchmarkActualDriver(driver, coordinator, cargo, package["clips"].OfType<JObject>().First(clip => clip.Value<string>("id") == "feed")["tracks"].Count());
                var feed = cart.GetComponentsInChildren<Transform>(true).First(node => node.name == "cad_transfer_cart_v1_feed_carriage"); var fullPose = feed.localPosition;
                ValidateMetricPayloadAndTargetRefresh(factory, cart, furnace, cargo, source, target, sourceModel, targetModel, driver, coordinator, roots);
                ValidateLineCalibrationInheritance(factory, cart, cargo, source, target, sourceModel, targetModel, driver, coordinator, roots);
                cart.transform.position += new Vector3(.2f, 0, 0); Tick(coordinator);
                Near(cargo.transform.position, new Vector3(12.085f, .05f, 20), "Cargo and drive lost the already-rendered cart root motion.");
                furnace.transform.position += new Vector3(2, 0, 0); Tick(coordinator);
                Require(cargo.activeSelf && !Eligible(driver) && driver.TransferDiagnostic?["reason"]?.ToString().Contains("超过") == true,
                    "Unreachable separation hid healthy source material or declared a fictional handoff.");
                Near(cargo.transform.position, new Vector3(12.085f, .05f, 20), "Unreachable target relocated healthy source material.");
                Near(feed.localPosition, fullPose, "Reach checking stretched the CAD pusher to compensate a bad layout.");
                cart.transform.localPosition = new Vector3(10, 0, 20); furnace.transform.localPosition = new Vector3(10, 0, 22.6f);
                cart.transform.localRotation = furnace.transform.localRotation = Quaternion.Euler(0, -90, 0); Tick(coordinator);
                Require(cargo.activeSelf && Eligible(driver), "Rotated cart and fixed equipment failed the same geometry contract.");
                Near(cargo.transform.position, new Vector3(10, .05f, 21.885f), "glTF X reflection/device yaw differs between drive and loading datum.");
                cart.transform.localRotation = furnace.transform.localRotation = Quaternion.identity;
                cart.transform.localScale = furnace.transform.localScale = new Vector3(-1, 1, 1);
                furnace.transform.localPosition = new Vector3(7.4f, 0, 20); Tick(coordinator);
                Require(cargo.activeSelf && Eligible(driver), "Mirrored cart/fixed-device pair was mistaken for a reverse feed.");
                Near(cargo.transform.position, new Vector3(8.115f, .05f, 20), "Mirroring was applied zero or two times to the material drive.");
                coordinator.ApplyInputs(source.Id, Input(1, true, "bad")); Tick(coordinator); Require(!cargo.activeSelf, "Bad material presence continued a fictitious transfer.");
                coordinator.ApplyInputs(source.Id, Input(1, false)); Tick(coordinator); Require(!cargo.activeSelf, "Confirmed no material displayed a payload.");
                coordinator.ApplyInputs(source.Id, Input(1, true)); Tick(coordinator); Require(cargo.activeSelf, "Fresh real presence did not recover without a made-up process timer.");
                coordinator.SuspendInputs(); Tick(coordinator); Require(!cargo.activeSelf, "Disconnect retained moving material.");
                coordinator.ApplyInputs(source.Id, Input(1, true, observation: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 10000)); Tick(coordinator);
                Require(!cargo.activeSelf, "Replayed stale source presence was made fresh by a transport packet.");
                driver.SuspendInputs(); coordinator.ApplyInputs(source.Id, Input(1, true)); Tick(coordinator);
                Require(!cargo.activeSelf, "Fresh material presence unfreezed an invalid motion driver.");
                transfer["enabled"] = false; coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, new Dictionary<string, MobileDeviceMotion>());
                Require(!factory.GetComponentsInChildren<Transform>(true).Any(node => node.name.StartsWith("Configured transfer material ", StringComparison.Ordinal)), "Disabled configuration retained an invented payload.");
                source.DataPoints = new List<DataPointDto> { new DataPointDto { Id = 101, DeviceId = "cart", Category = "analog", ValueRole = "position" },
                    new DataPointDto { Id = 102, DeviceId = "cart", Category = "motors", ValueRole = "start" } };
                var movement = JObject.Parse("{enabled:true,currentPositionPointId:'101',startActionPointId:'102',valueMode:'station',smoothingMs:100,simulationEnabled:true,speedMode:'fixed',maxSpeed:2,acceleration:1,sceneUnitsPerMeter:1,staleMs:1000,start:{x:-20,y:0,z:.5},end:{x:-10,y:0,z:.5},stations:[{value:1,position:{x:-21,y:0,z:.5},anchorDeviceId:'first'},{value:2,position:{x:7,y:0,z:.5},anchorDeviceId:'furnace'}]}" );
                source.InstanceConfigObject["movement"] = movement;
                var mobile = cart.AddComponent<MobileDeviceMotion>(); mobile.Initialize(source); mobile.ApplyRealtime(MobileInput(1));
                Near(cart.transform.localPosition, new Vector3(-21, 0, .5f), "Initial measured station was clamped to the hidden legacy axis/start point.");
                mobile.ApplyRealtime(MobileInput(2)); cart.transform.localPosition += Vector3.right * .5f;
                var held = cart.transform.localPosition; mobile.ApplyRealtime(MobileInput(2, false));
                typeof(MobileDeviceMotion).GetMethod("Update", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(mobile, null);
                Near(cart.transform.localPosition, held, "A false start bit continued to chase the old station target.");
                Require(!mobile.HasFreshPosition, "Disabled start signal retained an actionable movement pose.");
                mobile.ApplyRealtime(MobileInput(2)); Near(cart.transform.localPosition, new Vector3(7, 0, .5f), "Fresh recovery replayed an estimated pre-disconnect travel timer.");
                foreach (var key in new[] { "start", "end" }) movement[key]["z"] = 3.5;
                foreach (var station in movement["stations"].OfType<JObject>()) station["position"]["z"] = 3.5;
                mobile.Reconfigure(source, true);
                Near(cart.transform.localPosition, new Vector3(7, 0, 3.5f), "Saved rail spacing did not move the existing movement geometry or applied its delta twice.");
                mobile.ApplyRealtime(MobileInput(99)); Require(!mobile.HasFreshPosition, "Unknown station ID silently selected the final configured workstation.");
                Near(cart.transform.localPosition, new Vector3(7, 0, 3.5f), "Unknown station ID moved the held cart pose.");
                mobile.ApplyRealtime(MobileInput(1, observation: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 10000));
                Require(!mobile.HasFreshPosition, "A queued stale cart position was made fresh by dispatch.");
                mobile.ApplyRealtime(MobileInput(2)); mobile.ApplyRealtime(null);
                Require(!mobile.HasFreshPosition, "Null telemetry left an old movement target active.");
                // Explicit current feedback is an arrived position, not a new
                // target command. No configured preview speed may add latency.
                movement["stationInputMeaning"] = "current"; mobile.Reconfigure(source, true);
                mobile.ApplyRealtime(MobileInput(1, false));
                Near(cart.transform.localPosition, new Vector3(-21, 0, 3.5f), "Current-station arrival replayed a simulated journey or a smoothing tail.");
                Require(mobile.HasConfirmedPosition, "A fresh stopped cart at its measured station was not confirmed.");
                mobile.ApplyRealtime(MobileInput(2, false));
                Near(cart.transform.localPosition, new Vector3(7, 0, 3.5f), "New current-station feedback remained behind the PLC during immediate feed.");
                cart.transform.localScale = furnace.transform.localScale = Vector3.one;
                furnace.transform.localPosition = new Vector3(9.6f, 0, 3.5f);
                transfer["enabled"] = true; transfer["targetMode"] = "station";
                var motionMap = new Dictionary<string, MobileDeviceMotion> { [source.Id] = mobile };
                coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, motionMap);
                frame = Input(1, true); driver.ApplyMotionInputs(frame); driver.Advance(0, Time.realtimeSinceStartupAsDouble); coordinator.ApplyInputs(source.Id, frame); Tick(coordinator);
                cargo = Cargo(factory); Require(cargo.activeSelf && Eligible(driver), "Measured station feedback and immediate feed could not hand off in the same rendered frame.");
                mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
                Near(cart.transform.localPosition, new Vector3(7, 0, 3.5f), "Confirmed arrival continued a previously estimated movement.");
                mobile.ApplyRealtime(MobileInput(2, true));
                Require(!mobile.HasConfirmedPosition, "A retained station number was considered docked while movement was true.");
                Tick(coordinator); Require(!cargo.activeSelf && !Eligible(driver), "Retained discrete current station plus movement=true manufactured a known source location.");
                mobile.ApplyRealtime(MobileInput(2, false));
                Require(mobile.HasConfirmedPosition, "Fresh movement=false did not reconfirm measured arrival.");
                Tick(coordinator); Require(cargo.activeSelf, "Fresh measured stop and presence could not recover the material handoff without a fabricated process timer.");
                mobile.SuspendInputs();
                var currentHeld = cart.transform.localPosition;
                mobile.ApplyRealtime(MobileInput(1, false, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 10000));
                Near(cart.transform.localPosition, currentHeld, "Old current-station feedback moved the cart on reconnect.");
                Require(!mobile.HasConfirmedPosition, "A replayed current-station observation reconfirmed docking.");
                mobile.ApplyRealtime(MobileInput(2, false));
                Require(mobile.HasConfirmedPosition, "Fresh measured feedback failed to restore a stopped cart.");
                // An explicit target input is allowed to estimate motion only
                // after opt-in. Initial/recovery reads must never teleport or
                // become a measured material-handoff authorization.
                source.PositionX = 7; source.PositionY = 0; source.PositionZ = 3.5f;
                movement["stationInputMeaning"] = "target"; mobile.Initialize(source); mobile.ApplyRealtime(MobileInput(2));
                coordinator.Configure(new[] { source, target }, new[] { sourceModel, targetModel }, roots, motionMap); Tick(coordinator);
                Require(!cargo.activeSelf && mobile.HasFreshPosition && !mobile.HasConfirmedPosition,
                    "A geometrically aligned target-only command was falsely accepted as measured docking.");
                source.PositionX = -21;
                movement["stationInputMeaning"] = "target"; mobile.Initialize(source);
                var targetHeld = cart.transform.localPosition;
                mobile.ApplyRealtime(MobileInput(2));
                Near(cart.transform.localPosition, targetHeld, "The first target command teleported the cart to an unmeasured station.");
                Require(mobile.HasFreshPosition && !mobile.HasConfirmedPosition, "A usable target command was promoted to actual arrival.");
                mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
                Require(cart.transform.localPosition.x > targetHeld.x && cart.transform.localPosition.x < 7,
                    "Explicit target estimation failed to move within its configured speed/acceleration budget.");
                mobile.SuspendInputs(); targetHeld = cart.transform.localPosition;
                mobile.ApplyRealtime(MobileInput(2));
                Near(cart.transform.localPosition, targetHeld, "Recovering a target command reset the real rendered pose to a made-up destination.");
                mobile.ApplyRealtime(MobileInput(2, false));
                mobile.AdvanceMotion(.5f, Time.realtimeSinceStartupAsDouble + .5);
                Near(cart.transform.localPosition, targetHeld, "Target-command motion ignored an explicit stop bit.");
                Require(!mobile.HasConfirmedPosition, "Stopped target estimation became confirmed docking.");
                movement["simulationEnabled"] = false; mobile.Reconfigure(source, true); targetHeld = cart.transform.localPosition;
                mobile.ApplyRealtime(MobileInput(1));
                Near(cart.transform.localPosition, targetHeld, "A target input without simulation opt-in was rendered as a measured current station.");
                Require(!mobile.HasFreshPosition && !mobile.HasConfirmedPosition, "A disabled target estimate still authorized a handoff.");
                // Invalid calibration is rejected without start/end or XYZ
                // fallback. Existing valid station calibration remains intact.
                movement["stationInputMeaning"] = "current"; movement["simulationEnabled"] = true;
                movement["end"] = movement["start"].DeepClone(); mobile.Reconfigure(source, true); var invalidHeld = cart.transform.localPosition;
                mobile.ApplyRealtime(MobileInput(1, false));
                Near(cart.transform.localPosition, invalidHeld, "A degenerate horizontal rail invented a dock at its start.");
                Require(!mobile.HasFreshPosition, "A degenerate rail axis was actionable.");
                movement["end"] = JObject.Parse("{x:-10,y:0,z:3.5}"); movement["stations"][0]["position"].Parent.Remove();
                mobile.Reconfigure(source, true); mobile.ApplyRealtime(MobileInput(1, false));
                Near(cart.transform.localPosition, invalidHeld, "Missing station XYZ used the configured start as a hidden fallback.");
                Require(!mobile.HasFreshPosition, "An incomplete station pose was treated as real arrival.");
                movement["stations"][0]["position"] = JObject.Parse("{x:-21,y:0}");
                mobile.Reconfigure(source, true); mobile.ApplyRealtime(MobileInput(1, false));
                Near(cart.transform.localPosition, invalidHeld, "Partial station coordinates borrowed a hidden rail Z value.");
                Require(!mobile.HasFreshPosition, "Partially authored XYZ confirmed an actual dock.");
                var invalidPackage = (JObject)package.DeepClone();
                var invalidFeed = invalidPackage["clips"].OfType<JObject>().First(clip => clip.Value<string>("id") == "feed");
                invalidFeed["tracks"][0]["values"][0] = double.NaN;
                var beforeInvalidDefinition = feed.localPosition;
                driver.Configure(source, invalidPackage); driver.ApplyMotionInputs(Input(0, true)); driver.Advance(1, Time.realtimeSinceStartupAsDouble);
                Near(feed.localPosition, beforeInvalidDefinition, "Invalid compiled action partially applied a fabricated transform.");
                Require(!driver.TryGetTransferDrive("clip:feed", "cad_transfer_cart_v1_feed_carriage", out _, out _, out _, out _),
                    "Invalid compiled motion definition still authorized physical transfer.");
                ValidateLegacyPointDriver(factory);
                ValidatePartRotationBounds(factory);
                ValidateAnimationDeclarationIsolation();
                ValidateContinuous111Source(factory, gltf, package, config, sourceModel, targetModel);
                var output = Environment.GetEnvironmentVariable("REALTIME_LINKAGE_EVIDENCE");
                if (!string.IsNullOrEmpty(output))
                {
                    Directory.CreateDirectory(output);
                    File.WriteAllText(Path.Combine(output, "unity-transfer-actual-driver-validation.json"), new JObject { ["success"] = true, ["checks"] = _checks,
                        ["actualUnityTransformsAndDrivers"] = true, ["actualManagedCadMotionData"] = true, ["browserOperations"] = 0, ["liveConfigurationWrites"] = 0,
                        ["visualVerification"] = false, ["cpuBenchmark"] = _benchmark, ["checkedAt"] = DateTimeOffset.UtcNow.ToString("o") }.ToString());
                }
                Debug.Log("PASS: " + _checks + " actual Unity cart/fixed-device linkage checks (CPU-only).");
                EditorApplication.Exit(0);
            }
            catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
            finally { if (factory != null) UnityEngine.Object.DestroyImmediate(factory); }
        }
    }
}
