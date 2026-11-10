using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    // Actual Unity components/transforms and property blocks. Verifies exact
    // idle-write suppression without UI, PLC, GPU or live configuration writes.
    public static class IdleMotionWriteValidation
    {
        private static int _checks;
        private static long _clipIdleBytes, _partIdleBytes;
        private static JObject _actualCadBenchmark;
        private static readonly List<GameObject> Owned = new List<GameObject>();
        private static void Require(bool value, string message)
        { if (!value) throw new InvalidOperationException(message); _checks++; }
        private static GameObject Node(string name, Transform parent = null)
        {
            var value = new GameObject(name); value.transform.SetParent(parent, false); Owned.Add(value); return value;
        }
        private static GameObject Cube(string name, Transform parent)
        {
            var value = GameObject.CreatePrimitive(PrimitiveType.Cube); value.name = name;
            value.transform.SetParent(parent, false); Owned.Add(value); return value;
        }
        private static JObject Frame(string actionId, string item, object value, string quality = "good", long stamp = 1000000)
        {
            return new JObject { ["timestamp"] = stamp, ["motionInputOnly"] = true, ["motionInputs"] = new JObject {
                [actionId] = new JObject { ["dataItemId"] = item, ["value"] = JToken.FromObject(value), ["quality"] = quality, ["timestamp"] = stamp, ["staleMs"] = 600000 }
            } };
        }
        private static long Counter(object driver, string name)
        {
            var property = driver.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (property == null) throw new InvalidOperationException("Missing editor-only optimization counter " + name);
            return Convert.ToInt64(property.GetValue(driver));
        }
        private static Color NativeColor(Color requested)
        {
            // An independent native block captures Unity's real linear/gamma
            // conversion. No epsilon and no reliance on the driver's cache.
            var block = new MaterialPropertyBlock(); block.SetColor("_BaseColor", requested); return block.GetColor("_BaseColor");
        }
        private static JObject PosePackage()
        {
            return JObject.Parse(@"{nodes:[
                {name:'Slide',p:[0,0,0],v:[1]},{name:'Rotation',q:[0,0,0,1],v:[1]},
                {name:'Scale',s:[1,1,1],v:[1]},{name:'Visible',v:[1]},{name:'Color',c0:[0,0,0,1],v:[1]}],
                clips:[{id:'pose',count:2,duration:1,tracks:[
                    {node:'Slide',channel:'p',size:3,values:[0,0,0,1,2,3]},
                    {node:'Rotation',channel:'q',size:4,values:[0,0,0,1,0,0.5,0,0.8660254037844386]},
                    {node:'Scale',channel:'s',size:3,values:[1,1,1,2,3,4]},
                    {node:'Visible',channel:'v',size:1,values:[1,1]},
                    {node:'Color',channel:'c0',size:4,values:[0,0,0,1,1,0.5,0.25,1]}
                ]}]}");
        }
        private static DeviceDto PoseDevice(string item = "point:pose", bool running = false)
        {
            return new DeviceDto { Id = "idle-fixture", InstanceConfig = new JObject { ["animationBindings"] = new JObject {
                ["staleMs"] = 600000, ["bindings"] = new JArray(new JObject {
                    ["actionId"] = "clip:pose", ["clipId"] = "pose", ["dataItemId"] = item, ["enabled"] = true,
                    ["kind"] = "clip", ["mode"] = running ? "running" : "position", ["inputMin"] = 0, ["inputMax"] = 1,
                    ["speed"] = 1, ["transitionSeconds"] = 0, ["trigger"] = running
                        ? new JObject { ["mode"] = "condition", ["operator"] = "eq", ["value"] = true }
                        : new JObject { ["mode"] = "range" }
                })
            } } };
        }
        private static void ClipIdleAndExternalChanges()
        {
            var root = Node("clip-fixture");
            var slide = Node("Slide", root.transform); var rotation = Node("Rotation", root.transform);
            var scale = Node("Scale", root.transform); var visible = Node("Visible", root.transform);
            var colored = Cube("Color", root.transform); var renderer = colored.GetComponent<Renderer>();
            var driver = root.AddComponent<DeviceAnimationDriver>();
            driver.Configure(PoseDevice(), PosePackage());
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", .25), 0);
            for (var i = 0; i < 32; i++) driver.Advance(.001, i * .001);
            var position = slide.transform.localPosition; var quaternion = rotation.transform.localRotation; var size = scale.transform.localScale;
            foreach (var node in root.GetComponentsInChildren<Transform>(true)) node.hasChanged = false;
            for (var i = 0; i < 256; i++) driver.Advance(.001, .032 + i * .001);
            Require(!slide.transform.hasChanged && !rotation.transform.hasChanged && !scale.transform.hasChanged,
                "A healthy but stationary clip kept dirtying unchanged native transforms.");
            var sampleCount = Counter(driver, "PoseSampleEvaluations");
            var writeCount = Counter(driver, "PropertyBlockApplications");
            var allocationStart = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < 256; i++) driver.Advance(.001, .288 + i * .001);
            var allocations = GC.GetAllocatedBytesForCurrentThread() - allocationStart;
            _clipIdleBytes = allocations;
            Require(allocations <= 256, "Stationary clip allocated " + allocations + " managed bytes.");
            Require(Counter(driver, "PoseSampleEvaluations") == sampleCount, "Stationary clip repeated typed track sampling.");
            if (Counter(driver, "PropertyBlockApplications") != writeCount)
            {
                var detail = new MaterialPropertyBlock(); renderer.GetPropertyBlock(detail, 0);
                foreach (var alias in new[] { "_BaseColor", "_Color", "baseColorFactor" })
                {
                    var actual = detail.GetColor(alias);
                    Debug.Log("[IdleColorRoundTrip] " + alias + " hasColor=" + detail.HasColor(alias) + " hasProperty=" + detail.HasProperty(alias)
                        + " rgba=" + actual.r.ToString("R") + "," + actual.g.ToString("R") + "," + actual.b.ToString("R") + "," + actual.a.ToString("R"));
                }
            }
            Require(Counter(driver, "PropertyBlockApplications") == writeCount, "Stationary clip rewrote unchanged PLC material blocks.");

            slide.transform.localPosition += Vector3.right; rotation.transform.localRotation = Quaternion.Euler(12, 23, 34);
            scale.transform.localScale *= 2; visible.SetActive(false);
            var external = new MaterialPropertyBlock(); renderer.GetPropertyBlock(external, 0);
            external.SetColor("_BaseColor", Color.magenta); external.SetFloat("_UnrelatedFixture", 7);
            renderer.SetPropertyBlock(external, 0);
            driver.Advance(0, .6);
            Require(slide.transform.localPosition.Equals(position), "Signal-only cache ignored an externally modified position.");
            Require(rotation.transform.localRotation.Equals(quaternion), "Signal-only cache ignored an externally modified rotation.");
            Require(scale.transform.localScale.Equals(size) && visible.activeSelf, "Cached pose failed to restore external scale/visibility edits.");
            renderer.GetPropertyBlock(external, 0);
            Require(external.GetColor("_BaseColor").Equals(external.GetColor("baseColorFactor")), "External material edit was not corrected.");
            Require(external.GetFloat("_UnrelatedFixture") == 7, "PLC color restoration cleared another owner's material property.");
            Require(Counter(driver, "PoseSampleEvaluations") == sampleCount, "External pose correction needlessly sampled unchanged clip values.");

            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", .25, "bad", 1000001), .65);
            slide.transform.localPosition = new Vector3(91, 92, 93); var frozen = slide.transform.localPosition;
            driver.Advance(.01, .7);
            Require(slide.transform.localPosition.Equals(frozen), "A cached healthy pose bypassed bad source quality.");
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", .25, "good", 1000002), .75);
            driver.Advance(.01, .8);
            Require(slide.transform.localPosition.Equals(position), "Same-valued source recovery left an externally changed pose behind.");
            driver.Configure(PoseDevice("point:replacement"), PosePackage());
            driver.ApplyMotionInputs(Frame("clip:pose", "point:replacement", .75, "good", 1000003), .85);
            driver.Advance(0, .9);
            Require(slide.transform.localPosition.Equals(new Vector3(-.75f, 1.5f, 2.25f)), "Reconfiguration reused an old source's cached pose.");
            var snapshot = driver.CaptureEndpointDisplayStates();
            slide.transform.localPosition = Vector3.one;
            driver.RestoreEndpointDisplayStates(snapshot);
            Require(slide.transform.localPosition.Equals(new Vector3(-.75f, 1.5f, 2.25f)), "Restoring same-valued display state failed to correct an external pose edit.");
            driver.Advance(.01, 601);
            slide.transform.localPosition = Vector3.one;
            driver.Advance(.01, 602);
            Require(slide.transform.localPosition.Equals(Vector3.one), "An idle pose cache bypassed source staleness.");
        }
        private static void SameTimeRunningVisuals()
        {
            var root = Node("running-fixture"); var visible = Node("Lamp", root.transform);
            var device = PoseDevice(running: true);
            var package = JObject.Parse(@"{nodes:[{name:'Lamp',v:[0]}],clips:[{id:'pose',count:2,duration:1,
                tracks:[{node:'Lamp',channel:'v',size:1,values:[1,1]}]}]}");
            var driver = root.AddComponent<DeviceAnimationDriver>(); driver.Configure(device, package);
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", false), 0); driver.Advance(0, 0);
            Require(!visible.activeSelf, "Stopped clip did not use its authored resting visibility.");
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", true, "good", 1000001), .01); driver.Advance(0, .01);
            Require(visible.activeSelf, "Unchanged clip time masked a start edge on a previously unsampled visual channel.");
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", false, "good", 1000002), .02); driver.Advance(0, .02);
            Require(!visible.activeSelf, "Unchanged clip time masked a stop edge/rest visual.");
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", true, "good", 1000003), .03); driver.Advance(0, .03);
            Require(visible.activeSelf, "Restart after a same-time stop did not restore sampled visuals.");
        }
        private static void PartIdleColorAndHierarchyChanges()
        {
            var root = Node("part-fixture"); var slide = Node("Slide", root.transform); var fan = Node("Fan", root.transform);
            var hinge = Node("Hinge", root.transform); var flag = Node("Flag", root.transform);
            var group = Node("ColorGroup", root.transform); var other = Node("Other", root.transform);
            var colored = Cube("ColorPart", group.transform); var renderer = colored.GetComponent<Renderer>();
            var driver = root.AddComponent<ModelBindingDriver>();
            var bindings = new[] {
                new PartBindingDto { Id = "slide", NodeName = "Slide", Action = "translate", Axis = "x", OutputMin = 0, OutputMax = 1, TransitionDuration = 1, AuthoringSpace = false },
                new PartBindingDto { Id = "fan", NodeName = "Fan", Action = "rotate_speed", Axis = "y", SpeedFactor = 1, AuthoringSpace = false },
                new PartBindingDto { Id = "hinge", NodeName = "Hinge", Action = "rotate_angle", Axis = "z", OutputMax = 90, AuthoringSpace = false },
                new PartBindingDto { Id = "flag", NodeName = "Flag", Action = "visibility", AuthoringSpace = false },
                new PartBindingDto { Id = "color", NodeName = "ColorGroup", Action = "color", OffColor = "#123456", OnColor = "#fedcba", AuthoringSpace = false }
            };
            var config = new JObject { ["bindings"] = new JArray(bindings.Select(binding => new JObject {
                ["actionId"] = "part:" + binding.Id, ["dataItemId"] = "point:" + binding.Id,
                ["enabled"] = true, ["kind"] = "part", ["mode"] = "position", ["inputMin"] = 0, ["inputMax"] = 1,
                ["speed"] = 1, ["transitionSeconds"] = 0, ["trigger"] = new JObject { ["mode"] = "range" }
            })) };
            driver.Configure(bindings, config);
            var frame = Frame("part:slide", "point:slide", 0);
            ((JObject)frame["motionInputs"])["part:fan"] = Frame("part:fan", "point:fan", 0)["motionInputs"]["part:fan"].DeepClone();
            ((JObject)frame["motionInputs"])["part:color"] = Frame("part:color", "point:color", 0)["motionInputs"]["part:color"].DeepClone();
            ((JObject)frame["motionInputs"])["part:hinge"] = Frame("part:hinge", "point:hinge", .25)["motionInputs"]["part:hinge"].DeepClone();
            ((JObject)frame["motionInputs"])["part:flag"] = Frame("part:flag", "point:flag", 1)["motionInputs"]["part:flag"].DeepClone();
            driver.ApplyMotionInputs(frame, 0);
            for (var i = 0; i < 32; i++) driver.AdvanceMotion(.001f, i * .001);
            var angle = hinge.transform.localRotation;
            slide.transform.hasChanged = fan.transform.hasChanged = hinge.transform.hasChanged = false;
            var writes = Counter(driver, "PropertyBlockApplications");
            var allocationsAt = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < 256; i++) driver.AdvanceMotion(.001f, .032 + i * .001);
            var allocations = GC.GetAllocatedBytesForCurrentThread() - allocationsAt;
            _partIdleBytes = allocations;
            Require(!slide.transform.hasChanged && !fan.transform.hasChanged && !hinge.transform.hasChanged,
                "Idle part, fixed angle or zero RPM repeatedly dirtied a transform.");
            Require(Counter(driver, "PropertyBlockApplications") == writes, "Idle part color repeatedly rewrote all descendant material blocks.");
            Require(allocations <= 256, "Idle part color/renderer enumeration allocated " + allocations + " managed bytes.");
            slide.transform.localPosition = Vector3.one; hinge.transform.localRotation = Quaternion.Euler(10, 20, 30); flag.SetActive(false);
            driver.AdvanceMotion(.001f, .29);
            Require(slide.transform.localPosition.Equals(Vector3.zero) && hinge.transform.localRotation.Equals(angle) && flag.activeSelf,
                "Same-valued part state failed to restore external position, rotation or visibility edits.");
            ColorUtility.TryParseHtmlString("#123456", out var desired);
            desired = NativeColor(desired);
            var external = new MaterialPropertyBlock(); renderer.GetPropertyBlock(external);
            external.SetColor("_BaseColor", Color.magenta); external.SetFloat("_OtherOwner", 19); renderer.SetPropertyBlock(external);
            driver.AdvanceMotion(.001f, .3); renderer.GetPropertyBlock(external);
            Require(external.GetColor("_BaseColor").Equals(desired) && external.GetFloat("_OtherOwner") == 19,
                "Same-valued part color failed to restore an external change while preserving unrelated properties.");
            colored.transform.SetParent(other.transform, false); external.SetColor("_BaseColor", Color.magenta); renderer.SetPropertyBlock(external);
            driver.AdvanceMotion(.001f, .31); renderer.GetPropertyBlock(external);
            Require(external.GetColor("_BaseColor").Equals(Color.magenta), "Cached color membership rewrote a part moved outside its binding subtree.");
            colored.transform.SetParent(group.transform, false); driver.AdvanceMotion(.001f, .32); renderer.GetPropertyBlock(external);
            Require(external.GetColor("_BaseColor").Equals(desired), "Returning part did not regain its binding color after inspection reparenting.");
            var added = Cube("NewColorPart", group.transform); driver.AdvanceMotion(.001f, .33);
            added.GetComponent<Renderer>().GetPropertyBlock(external);
            Require(external.GetColor("_BaseColor").Equals(desired), "Renderer cache ignored a newly attached descendant.");
            bindings.Single(binding => binding.Id == "color").OffColor = "#2468ac";
            driver.AdvanceMotion(.001f, .34); renderer.GetPropertyBlock(external); ColorUtility.TryParseHtmlString("#2468ac", out desired);
            Require(external.GetColor("_BaseColor").Equals(NativeColor(desired)), "Color text changes reused an old parsed color.");
            bindings.Single(binding => binding.Id == "color").AuthoringSpace = true;
            driver.AdvanceMotion(.001f, .35); renderer.GetPropertyBlock(external);
            Require(external.GetColor("_BaseColor").Equals(NativeColor(QualitySettings.activeColorSpace == ColorSpace.Linear ? desired.linear : desired)),
                "An authoring/linear-space change reused the previous parsed color.");
            var snapshot = driver.CaptureEndpointDisplayStates(); hinge.transform.localRotation = Quaternion.identity;
            driver.RestoreEndpointDisplayStates(snapshot);
            Require(hinge.transform.localRotation.Equals(angle), "Restoring same-valued part display state failed to correct an external rotation.");
            driver.ApplyMotionInputs(Frame("part:slide", "point:slide", 0, "bad", 1000001), .4);
            slide.transform.localPosition = Vector3.one; driver.AdvanceMotion(.001f, .41);
            Require(slide.transform.localPosition.Equals(Vector3.one), "An idle part cache bypassed bad quality.");
            driver.ApplyMotionInputs(Frame("part:slide", "point:slide", 0, "good", 1000002), .42);
            driver.AdvanceMotion(.001f, .43);
            Require(slide.transform.localPosition.Equals(Vector3.zero), "Same-valued part source recovery failed to restore an external pose edit.");
        }

        private static void MissingZeroColorAliasesAndEmission()
        {
            var root = Node("zero-color-fixture"); var colored = Cube("Color", root.transform); var lamp = Cube("Emission", root.transform);
            var driver = root.AddComponent<DeviceAnimationDriver>();
            var package = JObject.Parse(@"{nodes:[{name:'Color',v:[1],c0:[0,0,0,0]},{name:'Emission',v:[1],e0:[0,0,0,0]}],
                clips:[{id:'pose',count:2,duration:1,tracks:[
                {node:'Color',channel:'c0',size:4,values:[0,0,0,0,0,0,0,0]},
                {node:'Emission',channel:'e0',size:4,values:[0,0,0,0,0,0,0,0]}]}]}");
            var colorRenderer = colored.GetComponent<Renderer>(); var emissionRenderer = lamp.GetComponent<Renderer>();
            var block = new MaterialPropertyBlock(); block.SetFloat("_OtherOwner", 13); colorRenderer.SetPropertyBlock(block, 0);
            driver.Configure(PoseDevice(), package); driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", 0), 0); driver.Advance(0, 0);
            colorRenderer.GetPropertyBlock(block, 0);
            foreach (var alias in new[] { "_BaseColor", "_Color", "baseColorFactor" })
                Require(block.HasColor(alias) && block.GetColor(alias).Equals(new Color(0, 0, 0, 0)), "Missing zero RGBA clip alias was mistaken for an explicit override: " + alias);
            Require(block.GetFloat("_OtherOwner") == 13, "First zero RGBA clip application cleared another owner's property.");
            emissionRenderer.GetPropertyBlock(block, 0);
            foreach (var alias in new[] { "_EmissionColor", "emissiveFactor" })
                Require(block.HasColor(alias) && block.GetColor(alias).Equals(new Color(0, 0, 0, 1)), "Emission aliases did not preserve original alpha/intensity semantics: " + alias);
            var writes = Counter(driver, "PropertyBlockApplications"); driver.Advance(.01, .01);
            Require(Counter(driver, "PropertyBlockApplications") == writes, "Explicit zero color/emission overrides were written again while idle.");
            block.Clear(); block.SetFloat("_OtherOwner", 21); colorRenderer.SetPropertyBlock(block, 0); driver.Advance(.01, .02); colorRenderer.GetPropertyBlock(block, 0);
            Require(block.HasColor("_BaseColor") && block.HasColor("_Color") && block.HasColor("baseColorFactor") && block.GetFloat("_OtherOwner") == 21,
                "A missing zero alias after another owner's MPB replacement was not restored without clearing unrelated properties.");

            var partRoot = Node("part-zero-color-fixture"); var partColor = Cube("PartColor", partRoot.transform);
            var partDriver = partRoot.AddComponent<ModelBindingDriver>();
            partDriver.Configure(new[] { new PartBindingDto { Id = "zero", NodeName = "PartColor", Action = "color", OffColor = "#00000000" } },
                JObject.Parse(@"{bindings:[{actionId:'part:zero',dataItemId:'point:zero',enabled:true,kind:'part',mode:'position',inputMin:0,inputMax:1,transitionSeconds:0}]}"));
            partDriver.ApplyMotionInputs(Frame("part:zero", "point:zero", 0), 0);
            partColor.GetComponent<Renderer>().GetPropertyBlock(block);
            foreach (var alias in new[] { "_BaseColor", "_Color", "baseColorFactor" })
                Require(block.HasColor(alias) && block.GetColor(alias).Equals(new Color(0, 0, 0, 0)), "Missing zero RGBA part alias was mistaken for an explicit override: " + alias);
        }

        private static void ExactSubEpsilonMovement()
        {
            var root = Node("exact-motion-fixture"); var slide = Node("Slide", root.transform); var rotation = Node("Rotation", root.transform); var scale = Node("Scale", root.transform);
            var reference = Node("Reference", root.transform); var driver = root.AddComponent<DeviceAnimationDriver>();
            var package = JObject.Parse(@"{nodes:[{name:'Slide',v:[1]},{name:'Rotation',v:[1]},{name:'Scale',v:[1]}],
                clips:[{id:'pose',count:2,duration:1,tracks:[
                {node:'Slide',channel:'p',size:3,values:[0,0,0,0.0000001,0,0]},
                {node:'Rotation',channel:'q',size:4,values:[0,0,0,1,0,0,0.0000005,1]},
                {node:'Scale',channel:'s',size:3,values:[1,1,1,1.00000012,1,1]}]}]}");
            driver.Configure(PoseDevice(), package); driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", 0), 0); driver.Advance(0, 0);
            driver.ApplyMotionInputs(Frame("clip:pose", "point:pose", 1, "good", 1000001), .01); driver.Advance(0, .01);
            Require(slide.transform.localPosition.Equals(new Vector3(-.0000001f, 0, 0)), "Approximate vector equality suppressed a represented sub-epsilon position.");
            Require(scale.transform.localScale.Equals(new Vector3(1.00000012f, 1, 1)), "Approximate vector equality suppressed a represented sub-epsilon scale.");
            reference.transform.localRotation = new Quaternion(0, 0, -.0000005f, 1).normalized;
            Require(rotation.transform.localRotation.Equals(reference.transform.localRotation), "Approximate quaternion equality suppressed a represented sub-epsilon rotation.");

            var partRoot = Node("exact-part-fixture"); var partSlide = Node("Slide", partRoot.transform); var hinge = Node("Hinge", partRoot.transform);
            var partDriver = partRoot.AddComponent<ModelBindingDriver>();
            partDriver.Configure(new[] {
                new PartBindingDto { Id = "slide", NodeName = "Slide", Action = "translate", Axis = "x", OutputMax = .0000001f },
                new PartBindingDto { Id = "hinge", NodeName = "Hinge", Action = "rotate_angle", Axis = "z", OutputMax = .0001f }
            }, JObject.Parse(@"{bindings:[
                {actionId:'part:slide',dataItemId:'point:slide',enabled:true,kind:'part',mode:'position',inputMin:0,inputMax:1,transitionSeconds:0},
                {actionId:'part:hinge',dataItemId:'point:hinge',enabled:true,kind:'part',mode:'position',inputMin:0,inputMax:1,transitionSeconds:0}]}"));
            var frame = Frame("part:slide", "point:slide", 0);
            ((JObject)frame["motionInputs"])["part:hinge"] = Frame("part:hinge", "point:hinge", 0)["motionInputs"]["part:hinge"].DeepClone();
            partDriver.ApplyMotionInputs(frame, 0);
            frame = Frame("part:slide", "point:slide", 1, "good", 1000001);
            ((JObject)frame["motionInputs"])["part:hinge"] = Frame("part:hinge", "point:hinge", 1, "good", 1000001)["motionInputs"]["part:hinge"].DeepClone();
            partDriver.ApplyMotionInputs(frame, .01);
            Require(partSlide.transform.localPosition.Equals(new Vector3(.0000001f, 0, 0)), "Approximate equality suppressed sub-epsilon part translation.");
            reference.transform.localRotation = Quaternion.AngleAxis(.0001f, Vector3.forward);
            Require(hinge.transform.localRotation.Equals(reference.transform.localRotation), "Approximate equality suppressed sub-epsilon part rotation.");
        }

        private static void CheckActualCadPose(DeviceAnimationDriver driver, JObject clip, Dictionary<string, Transform> nodes, Transform reference)
        {
            var phase = driver.CaptureDiagnostic()["actions"][0].Value<double>("position");
            var time = phase * clip.Value<double>("duration");
            foreach (var track in clip["tracks"].OfType<JObject>())
            {
                var values = new double[track.Value<int>("size")];
                // Independent original JSON sampler + direct native setter,
                // not the optimized driver's cached values or desired pose.
                MotionSignalState.SampleInto(clip, track, time, values);
                var target = nodes[track.Value<string>("node")]; var channel = track.Value<string>("channel");
                if (channel == "p")
                    Require(target.localPosition.Equals(new Vector3(-(float)values[0], (float)values[1], (float)values[2])), "Actual CAD position differs from its original sampler: " + target.name);
                else if (channel == "q")
                {
                    reference.localRotation = new Quaternion((float)values[0], -(float)values[1], -(float)values[2], (float)values[3]).normalized;
                    Require(target.localRotation.Equals(reference.localRotation), "Actual CAD rotation differs from its original sampler/native setter: " + target.name);
                }
                else if (channel == "v") Require(target.gameObject.activeSelf == (values[0] > .5), "Actual CAD visibility differs from its original sampler: " + target.name);
                else throw new InvalidOperationException("The actual feed acceptance fixture unexpectedly changed channel type: " + channel);
            }
        }

        private static void ActualCadIdleAndMoving()
        {
            var workspace = Path.GetFullPath(Path.Combine(Application.dataPath, "../.."));
            var package = JObject.Parse(File.ReadAllText(Path.Combine(workspace, "backend/assets/motions/cad_transfer_cart_101300.json")));
            var clip = package["clips"].OfType<JObject>().Single(value => value.Value<string>("id") == "feed");
            var root = Node("actual-cad-feed-fixture"); var nodes = new Dictionary<string, Transform>(StringComparer.Ordinal);
            foreach (var row in package["nodes"].OfType<JObject>())
            {
                var name = row.Value<string>("name"); if (!nodes.ContainsKey(name)) nodes[name] = Node(name, root.transform).transform;
            }
            var reference = Node("actual-cad-direct-setter-reference").transform;
            var driver = root.AddComponent<DeviceAnimationDriver>();
            var binding = JObject.Parse(@"{actionId:'clip:feed',clipId:'feed',enabled:true,kind:'clip',mode:'position',dataItemId:'point:feed',
                inputMin:0,inputMax:1,speed:1,transitionSeconds:0,trigger:{mode:'range'}}");
            var device = new DeviceDto { Id = "actual-cad-isolated-feed", InstanceConfig = new JObject { ["animationBindings"] = new JObject {
                ["staleMs"] = 600000, ["diagnosticLogging"] = false, ["bindings"] = new JArray(binding)
            } } };
            driver.Configure(device, package); driver.ApplyMotionInputs(Frame("clip:feed", "point:feed", .37), 0); driver.Advance(0, 0);
            for (var i = 0; i < 128; i++) driver.Advance(1d / 60, 0);
            CheckActualCadPose(driver, clip, nodes, reference);
            foreach (var target in nodes.Values) target.hasChanged = false;
            var sampleCount = Counter(driver, "PoseSampleEvaluations");
            var timer = new System.Diagnostics.Stopwatch(); var before = GC.GetAllocatedBytesForCurrentThread(); timer.Start();
            const int frames = 2048;
            for (var i = 0; i < frames; i++) driver.Advance(1d / 60, 0);
            timer.Stop(); var idleBytes = GC.GetAllocatedBytesForCurrentThread() - before; var idleMs = timer.Elapsed.TotalMilliseconds;
            Require(idleBytes == 0, "Actual CAD idle advance allocated " + idleBytes + " managed bytes.");
            Require(Counter(driver, "PoseSampleEvaluations") == sampleCount, "Actual CAD idle phase still sampled its typed tracks.");
            Require(nodes.Values.All(target => !target.hasChanged), "Actual CAD idle phase dirtied unchanged native transforms.");

            binding["transitionSeconds"] = 1;
            driver.Configure(device, package); driver.ApplyMotionInputs(Frame("clip:feed", "point:feed", 0), 0); driver.Advance(0, 0);
            driver.ApplyMotionInputs(Frame("clip:feed", "point:feed", 1, "good", 1000001), 0);
            for (var i = 0; i < 128; i++) driver.Advance(.00001, 0);
            CheckActualCadPose(driver, clip, nodes, reference);
            sampleCount = Counter(driver, "PoseSampleEvaluations"); timer.Reset(); before = GC.GetAllocatedBytesForCurrentThread(); timer.Start();
            for (var i = 0; i < frames; i++) driver.Advance(1d / 4096, 0);
            timer.Stop(); var movingBytes = GC.GetAllocatedBytesForCurrentThread() - before; var movingMs = timer.Elapsed.TotalMilliseconds;
            var trackCount = clip["tracks"].Count();
            Require(movingBytes == 0, "Actual CAD moving advance allocated " + movingBytes + " managed bytes.");
            Require(Counter(driver, "PoseSampleEvaluations") - sampleCount == (long)trackCount * frames,
                "Actual CAD changing phase skipped a necessary exact-time sample.");
            var phase = driver.CaptureDiagnostic()["actions"][0].Value<double>("position");
            Require(phase > .1 && phase < .9, "Moving benchmark accidentally measured a settled pose.");
            CheckActualCadPose(driver, clip, nodes, reference);
            driver.ApplyMotionInputs(Frame("clip:feed", "point:feed", 0, "good", 1000002), 0);
            for (var i = 0; i < 16; i++) driver.Advance(1d / 64, 0);
            CheckActualCadPose(driver, clip, nodes, reference);
            for (var i = 0; i < 64; i++) driver.Advance(1d / 64, 0);
            CheckActualCadPose(driver, clip, nodes, reference);
            _actualCadBenchmark = new JObject { ["asset"] = "cad_transfer_cart_101300/feed", ["actualOriginalCadTracks"] = trackCount,
                ["framesPerMode"] = frames, ["idleAdvanceMilliseconds"] = idleMs, ["idleManagedAllocatedBytes"] = idleBytes,
                ["idleAdditionalSamples"] = 0, ["movingAdvanceMilliseconds"] = movingMs, ["movingManagedAllocatedBytes"] = movingBytes,
                ["movingAdditionalSamples"] = (long)trackCount * frames, ["fixedSourceClockForIsolatedCpuBenchmark"] = true,
                ["includesActualNativeTransforms"] = true, ["measuredVisualFps"] = false, ["measuredNetworkLatency"] = false, ["measuredGpuLatency"] = false };
        }
        public static void ValidateBatch()
        {
            var code = 1;
            try
            {
                _checks = 0;
                ClipIdleAndExternalChanges(); SameTimeRunningVisuals(); PartIdleColorAndHierarchyChanges();
                MissingZeroColorAliasesAndEmission(); ExactSubEpsilonMovement(); ActualCadIdleAndMoving();
                var result = new JObject { ["success"] = true, ["checks"] = _checks, ["actualUnityDriversAndTransforms"] = true,
                    ["browserOperations"] = 0, ["liveConfigurationWrites"] = 0, ["measuredGpuLatency"] = false, ["measuredVisualFps"] = false,
                    ["clipIdleManagedBytesFor256Frames"] = _clipIdleBytes, ["partIdleManagedBytesFor256Frames"] = _partIdleBytes,
                    ["actualCadCpuBenchmark"] = _actualCadBenchmark,
                    ["checkedAt"] = DateTimeOffset.UtcNow.ToString("o") };
                var destination = Environment.GetEnvironmentVariable("NATIVE_IDLE_MOTION_VALIDATION_PATH");
                if (!string.IsNullOrEmpty(destination)) File.WriteAllText(destination, result.ToString());
                Debug.Log("[IdleMotionWriteValidation] " + result.ToString(Newtonsoft.Json.Formatting.None)); code = 0;
            }
            catch (Exception error) { Debug.LogException(error); }
            finally
            {
                foreach (var item in Owned) if (item != null) UnityEngine.Object.DestroyImmediate(item);
                Owned.Clear(); EditorApplication.Exit(code);
            }
        }
    }
}
