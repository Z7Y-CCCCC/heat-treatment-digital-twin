#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Tiny real-Unity fixtures only: no browser, scene edits, PLC or GPU benchmark.
    public static class InspectionFrameBudgetValidation
    {
        private const BindingFlags Members = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        private static readonly List<Object> Owned = new List<Object>();
        private static readonly List<FactoryDashboardController> Controllers = new List<FactoryDashboardController>();
        private static int _checks;

        private sealed class Fixture
        {
            public FactoryDashboardController Controller;
            public Camera Camera;
            public GameObject Root, Shell, Door;
            public Material Original;
            public object DeviceView, Runtime, Part, Target;
            public Vector3 Pivot;
            public int OriginalSibling;
            public Transform Offset => Get<Transform>(Target, "OffsetRoot");
            public Renderer ShellRenderer => Shell.GetComponent<Renderer>();
        }

        private static void Require(bool value, string message)
        { if (!value) throw new InvalidOperationException(message); _checks++; }
        private static T Own<T>(T value) where T : Object
        { value.hideFlags = HideFlags.HideAndDontSave; Owned.Add(value); return value; }
        private static GameObject Node(string name, Transform parent = null)
        { var node = Own(new GameObject(name)); node.transform.SetParent(parent, false); return node; }
        private static GameObject Cube(string name, Transform parent, Material material)
        {
            var node = Own(GameObject.CreatePrimitive(PrimitiveType.Cube)); node.name = name;
            node.transform.SetParent(parent, false); Object.DestroyImmediate(node.GetComponent<Collider>());
            node.GetComponent<Renderer>().sharedMaterial = material; return node;
        }
        private static T Get<T>(object target, string name)
        {
            var field = target.GetType().GetField(name, Members);
            if (field == null) throw new MissingFieldException(target.GetType().FullName, name);
            return (T)field.GetValue(target);
        }
        private static void Set(object target, string name, object value)
        { target.GetType().GetField(name, Members).SetValue(target, value); }
        private static object Call(FactoryDashboardController controller, string name, params object[] values)
        {
            var method = typeof(FactoryDashboardController).GetMethod(name, Members);
            if (method == null) throw new MissingMethodException(typeof(FactoryDashboardController).FullName, name);
            return method.Invoke(controller, values);
        }
        private static Fixture CreateFixture()
        {
            var fixture = new Fixture();
            fixture.Camera = Node("frame-budget-camera").AddComponent<Camera>(); fixture.Camera.enabled = false;
            fixture.Camera.pixelRect = new Rect(0, 0, 1280, 720); fixture.Camera.aspect = 16f / 9f;
            fixture.Camera.nearClipPlane = .01f; fixture.Camera.farClipPlane = 100f;
            fixture.Camera.transform.SetPositionAndRotation(new Vector3(0, 0, -5), Quaternion.identity);
            fixture.Controller = Node("frame-budget-dashboard").AddComponent<FactoryDashboardController>();
            Controllers.Add(fixture.Controller); fixture.Controller.enabled = false;
            fixture.Controller.Initialize(fixture.Camera, null, null);
            fixture.Controller.BeginFactory(new FactoryConfigDto()); fixture.Controller.SetWebOverlayActive(true);
            var shader = Resources.Load<Shader>("RuntimeShaders/InspectionShell");
            Require(shader != null, "Actual inspection shader is available to the fixture.");
            fixture.Original = Own(new Material(shader));
            fixture.Root = Node("frame-budget-model");
            fixture.Shell = Cube("Shell", fixture.Root.transform, fixture.Original);
            fixture.Door = Cube("Door", fixture.Root.transform, fixture.Original);
            fixture.Door.transform.localPosition = new Vector3(1.3f, .4f, .1f);
            fixture.Door.transform.localRotation = Quaternion.Euler(2, 3, 4);
            fixture.Door.transform.localScale = new Vector3(.5f, 1f, .7f);
            fixture.Pivot = fixture.Root.transform.InverseTransformPoint(fixture.Door.GetComponent<Renderer>().bounds.center);
            fixture.OriginalSibling = fixture.Door.transform.GetSiblingIndex();
            fixture.Controller.RegisterDevice(new DeviceDto { Id = "frame-budget-fixture" }, fixture.Root,
                new DeviceInspectionConfigDto {
                    ShellDuration = .5f, Stagger = 0f, Easing = "linear",
                    Shell = new DeviceInspectionShellDto { NodeNames = new List<string> { "Shell" }, Wireframe = true },
                    Parts = new List<DeviceInspectionPartDto> { new DeviceInspectionPartDto {
                        Id = "door", NodeName = "Door", Duration = 1f,
                        ExplodeOffset = new List<float> { 2f, 3f, 1f }, ExplodeRotation = new List<float> { 23f, 37f, 51f }
                    } }
                });
            fixture.DeviceView = ((IDictionary)Get<object>(fixture.Controller, "_devices"))["frame-budget-fixture"];
            fixture.Runtime = Get<object>(fixture.DeviceView, "Inspection");
            fixture.Part = ((IList)Get<object>(fixture.Runtime, "Parts"))[0];
            fixture.Target = ((IList)Get<object>(fixture.Part, "Targets"))[0];
            fixture.Offset.gameObject.hideFlags = HideFlags.HideAndDontSave;
            Require(Get<bool>(fixture.Runtime, "Valid") && Get<bool>(fixture.Runtime, "Prepared"), "Real part wrapper and mesh picking are prepared.");
            return fixture;
        }

        private static void HoverSkipsIneligibleFrames()
        {
            var f = CreateFixture(); var c = f.Controller;
            var pointer = f.Camera.WorldToScreenPoint(Vector3.zero);
            JObject payload = null; c.DeviceHoverUpdated += value => payload = value;
            void Pick(Vector3 at, bool blocked) => Call(c, "UpdateDeviceHoverAt", at, blocked);
            string Hover() => Get<string>(c, "_hoveredDeviceId");
            Pick(pointer, false);
            Require(Hover() == "frame-budget-fixture" && c.HoverRendererObservations > 0, "Eligible pointer picks actual cube geometry.");
            var observations = c.HoverRendererObservations; Pick(pointer, true);
            Require(Hover() == "" && payload != null && !payload["deviceHoverPointer"].Value<bool>("visible"), "Blocked pointer clears hover immediately.");
            for (var i = 0; i < 32; i++) Pick(pointer, true);
            Require(c.HoverRendererObservations == observations, "Blocked pointer never scans CAD renderer snapshots.");
            f.Root.transform.position = Vector3.right * 20; Pick(pointer, true); Pick(pointer, false);
            Require(Hover() == "" && c.HoverRendererObservations > observations, "Unblocking repicks geometry moved away while blocked.");
            f.Root.transform.position = Vector3.zero; Pick(pointer, false); Pick(pointer, true);
            observations = c.HoverRendererObservations;
            f.Root.transform.position = Vector3.right * 20; Pick(pointer, true);
            f.Root.transform.position = Vector3.zero; Pick(pointer, true); Pick(pointer, false);
            Require(Hover() == "frame-budget-fixture" && c.HoverRendererObservations > observations, "Re-entry repicks even after geometry moved away and back while blocked.");
            var outside = new Vector3(f.Camera.pixelRect.xMax + 1, pointer.y, 0);
            observations = c.HoverRendererObservations; Pick(outside, false);
            for (var i = 0; i < 32; i++) Pick(outside, false);
            Require(Hover() == "" && c.HoverRendererObservations == observations, "Outside-camera pointer clears hover without a renderer scan.");
            f.Root.transform.position = Vector3.right * 20; Pick(outside, false);
            f.Root.transform.position = Vector3.zero; Pick(outside, false); Pick(pointer, false);
            Require(Hover() == "frame-budget-fixture" && c.HoverRendererObservations > observations, "Camera-rect re-entry refreshes a stationary pick.");
            observations = c.HoverRendererObservations;
            Pick(new Vector3(float.NaN, pointer.y, 0), false);
            Require(Hover() == "" && c.HoverRendererObservations == observations, "Non-finite pointer cannot enter mesh picking.");
        }

        private static void PausedPoseKeepsPlcOwnership()
        {
            var f = CreateFixture(); var c = f.Controller;
            Set(f.Runtime, "Clock", 1f); Set(f.Runtime, "TargetClock", 1.5f); Set(f.Runtime, "Paused", true);
            Set(f.Runtime, "XrayAmount", .35f); Set(f.Runtime, "XrayTarget", .35f);
            void Apply() => Call(c, "ApplyInspectionPose", f.Runtime);
            Apply(); Apply();
            var position = f.Offset.localPosition; var rotation = f.Offset.localRotation;
            var offsetWrites = c.InspectionOffsetWrites; var visibilityWrites = c.InspectionVisibilityWrites;
            var materialWrites = c.InspectionMaterialWrites; f.Offset.hasChanged = false;
            for (var i = 0; i < 64; i++) Apply();
            Require(!f.Offset.hasChanged && c.InspectionOffsetWrites == offsetWrites, "Paused inspection does not dirty unchanged native wrapper transforms.");
            Require(c.InspectionVisibilityWrites == visibilityWrites && c.InspectionMaterialWrites == materialWrites, "Paused inspection does not repeat visibility, shader uniform or render-queue writes.");
            var bounds = Get<Bounds>(f.Part, "WorldBounds");
            f.Door.transform.localPosition += new Vector3(.2f, .1f, .3f);
            f.Door.transform.localRotation = Quaternion.Euler(17, 29, 41); f.Door.transform.localScale *= 1.1f;
            var childPosition = f.Door.transform.localPosition; var childRotation = f.Door.transform.localRotation;
            var childScale = f.Door.transform.localScale; Apply();
            Require(f.Offset.localPosition.Equals(position) && f.Offset.localRotation.Equals(rotation) && c.InspectionOffsetWrites == offsetWrites, "PLC child changes do not cause an unchanged inspection offset write.");
            Require(f.Door.transform.localPosition.Equals(childPosition) && f.Door.transform.localRotation.Equals(childRotation)
                && f.Door.transform.localScale.Equals(childScale), "Inspection preserves PLC-owned child local TRS.");
            Require(!Get<Bounds>(f.Part, "WorldBounds").Equals(bounds) && Get<Bounds>(f.Part, "WorldBounds").Equals(f.Door.GetComponent<Renderer>().bounds), "Part bounds still follow live PLC geometry on a paused clock.");

            var material = f.ShellRenderer.sharedMaterial;
            var alpha = material.GetFloat("_Opacity"); var axis = material.GetVector("_ClipAxis");
            var range = material.GetVector("_ClipRange"); var matrix = material.GetMatrix("_InspectionWorldToModel");
            var queue = material.renderQueue;
            f.Offset.localPosition += Vector3.one; f.Offset.localRotation = Quaternion.Euler(1, 2, 3);
            f.ShellRenderer.forceRenderingOff = false;
            material.SetFloat("_Opacity", .91f); material.SetVector("_ClipAxis", Vector4.one * 9);
            material.SetVector("_ClipRange", Vector4.zero); material.SetMatrix("_InspectionWorldToModel", Matrix4x4.Translate(Vector3.one * 9));
            material.renderQueue = 1234; Apply();
            Require(f.Offset.localPosition.Equals(position) && f.Offset.localRotation.Equals(rotation), "Unchanged requested pose repairs external wrapper edits.");
            Require(f.ShellRenderer.forceRenderingOff && c.InspectionVisibilityWrites > visibilityWrites, "Unchanged visibility intent repairs an external renderer edit.");
            Require(material.GetFloat("_Opacity").Equals(alpha) && material.GetVector("_ClipAxis").Equals(axis)
                && material.GetVector("_ClipRange").Equals(range) && material.GetMatrix("_InspectionWorldToModel").Equals(matrix)
                && material.renderQueue == queue, "Native float, vector, uniform matrix and queue edits are corrected.");
        }

        private static float NextSingle(float value)
            => BitConverter.ToSingle(BitConverter.GetBytes(BitConverter.ToInt32(BitConverter.GetBytes(value), 0) + 1), 0);

        private static void ExactSubEpsilonUpdates()
        {
            var f = CreateFixture(); var c = f.Controller;
            var reference = Node("native-pose-round-trip").transform;
            var position = new Vector3(1e-7f, -2e-7f, 3e-7f);
            var rotation = new Quaternion(1e-7f, -2e-7f, 3e-7f, 1f);
            reference.SetLocalPositionAndRotation(position, rotation);
            Call(c, "ApplyInspectionTargetPose", f.Target, Vector3.zero, Quaternion.identity);
            var writes = c.InspectionOffsetWrites;
            Call(c, "ApplyInspectionTargetPose", f.Target, position, rotation);
            Require(f.Offset.localPosition.Equals(reference.localPosition) && f.Offset.localRotation.Equals(reference.localRotation)
                && c.InspectionOffsetWrites == writes + 1, "Sub-epsilon Float32 position and rotation are not discarded by approximate equality.");
            writes = c.InspectionOffsetWrites; f.Offset.hasChanged = false;
            for (var i = 0; i < 32; i++) Call(c, "ApplyInspectionTargetPose", f.Target, position, rotation);
            Require(!f.Offset.hasChanged && c.InspectionOffsetWrites == writes, "Native quaternion round-trip does not create idle writes.");
            f.Offset.localPosition += new Vector3(1e-7f, 0, 0);
            f.Offset.localRotation = new Quaternion(2e-7f, -2e-7f, 3e-7f, 1f);
            Call(c, "ApplyInspectionTargetPose", f.Target, position, rotation);
            Require(f.Offset.localPosition.Equals(reference.localPosition) && f.Offset.localRotation.Equals(reference.localRotation), "Sub-epsilon external wrapper changes are repaired exactly.");

            var material = Own(new Material(f.Original.shader));
            var floatId = Shader.PropertyToID("_Opacity"); var vectorId = Shader.PropertyToID("_ClipRange");
            var matrixId = Shader.PropertyToID("_InspectionWorldToModel");
            var scalar = NextSingle(.5f); var vector = new Vector4(0, 1, 1, NextSingle(.25f));
            var matrix = Matrix4x4.Translate(new Vector3(NextSingle(.5f), 1f, 2f));
            material.SetFloat(floatId, .5f); material.SetVector(vectorId, new Vector4(0, 1, 1, .25f));
            material.SetMatrix(matrixId, Matrix4x4.Translate(new Vector3(.5f, 1f, 2f)));
            writes = c.InspectionMaterialWrites;
            Call(c, "SetInspectionMaterialFloat", material, floatId, scalar);
            Call(c, "SetInspectionMaterialVector", material, vectorId, vector);
            Call(c, "SetInspectionMaterialMatrix", material, matrixId, matrix);
            Require(material.GetFloat(floatId).Equals(scalar) && material.GetVector(vectorId).Equals(vector)
                && material.GetMatrix(matrixId).Equals(matrix) && c.InspectionMaterialWrites == writes + 3,
                "One-ULP native float, vector and non-Properties shader matrix updates all apply.");
            writes = c.InspectionMaterialWrites;
            for (var i = 0; i < 16; i++) {
                Call(c, "SetInspectionMaterialFloat", material, floatId, scalar);
                Call(c, "SetInspectionMaterialVector", material, vectorId, vector);
                Call(c, "SetInspectionMaterialMatrix", material, matrixId, matrix);
            }
            Require(c.InspectionMaterialWrites == writes, "Repeated exact shader values perform no setter calls.");
            material.SetFloat(floatId, .5f); material.SetVector(vectorId, new Vector4(0, 1, 1, .25f));
            material.SetMatrix(matrixId, Matrix4x4.Translate(new Vector3(.5f, 1f, 2f)));
            Call(c, "SetInspectionMaterialFloat", material, floatId, scalar);
            Call(c, "SetInspectionMaterialVector", material, vectorId, vector);
            Call(c, "SetInspectionMaterialMatrix", material, matrixId, matrix);
            Require(c.InspectionMaterialWrites == writes + 3 && material.GetMatrix(matrixId).Equals(matrix), "One-ULP external shader edits are restored without a stale intent cache.");
        }

        private static void ForwardReverseAndReset()
        {
            var f = CreateFixture(); var c = f.Controller; var reference = Node("inspection-pose-oracle").transform;
            var childPosition = f.Door.transform.localPosition; var childRotation = f.Door.transform.localRotation;
            var childScale = f.Door.transform.localScale; var reversing = false;
            foreach (var clock in new[] { 0f, .25f, .5f, .75f, 1f, 1.5f, 1f, .75f, .5f, .25f, 0f }) {
                if (clock == 1.5f) reversing = true;
                Set(f.Runtime, "Clock", clock); Set(f.Runtime, "TargetClock", reversing ? 0f : 1.5f);
                var amount = Mathf.Clamp01(clock - .5f);
                var rotation = Quaternion.Euler(new Vector3(23, 37, 51) * amount);
                var position = new Vector3(2, 3, 1) * amount + f.Pivot - rotation * f.Pivot;
                reference.SetLocalPositionAndRotation(position, rotation); Call(c, "ApplyInspectionPose", f.Runtime);
                Require(f.Offset.localPosition.Equals(reference.localPosition) && f.Offset.localRotation.Equals(reference.localRotation), "Absolute-clock forward/reverse pose matches native oracle at " + clock);
                Require(f.Door.transform.localPosition.Equals(childPosition) && f.Door.transform.localRotation.Equals(childRotation)
                    && f.Door.transform.localScale.Equals(childScale), "Forward/reverse leaves child TRS untouched at " + clock);
                Require(f.ShellRenderer.forceRenderingOff == (Mathf.Clamp01(clock / .5f) >= .99999f), "Shell visibility follows both clock directions at " + clock);
                if (clock > 0f) Require(f.ShellRenderer.sharedMaterial.GetVector("_ClipRange").w.Equals(Mathf.Clamp01(clock / .5f)), "Shell clip progression updates at " + clock);
                else Require(f.ShellRenderer.sharedMaterial == f.Original, "Assembly restores original shell material.");
            }
            Set(f.Runtime, "Clock", 1.5f); Set(f.Runtime, "XrayAmount", 1f); Call(c, "ApplyInspectionPose", f.Runtime);
            Call(c, "ResetInspection", f.DeviceView, false);
            Require(f.Offset.localPosition.Equals(Vector3.zero) && f.Offset.localRotation.Equals(Quaternion.identity)
                && !f.ShellRenderer.forceRenderingOff && f.ShellRenderer.sharedMaterial == f.Original, "Reset restores native offset, shell material and renderer visibility.");
            var offsetWrites = c.InspectionOffsetWrites; var visibilityWrites = c.InspectionVisibilityWrites;
            for (var i = 0; i < 16; i++) Call(c, "ResetInspection", f.DeviceView, false);
            Require(c.InspectionOffsetWrites == offsetWrites && c.InspectionVisibilityWrites == visibilityWrites, "Repeated reset does not rewrite unchanged offset or visibility.");
            Call(c, "ResetInspection", f.DeviceView, true);
            Require(f.Door.transform.parent == f.Root.transform && f.Door.transform.GetSiblingIndex() == f.OriginalSibling
                && f.Door.transform.localPosition.Equals(childPosition) && f.Door.transform.localRotation.Equals(childRotation)
                && f.Door.transform.localScale.Equals(childScale), "Disposal restores hierarchy without altering PLC-owned child TRS.");
        }

        private static void WindowsPointerOwnership()
        {
            bool Owned(uint app, uint hit, uint root, uint owner, bool found = true)
                => NativePointerWindowGuard.BelongsToApplication(new NativePointerWindowGuard.WindowObservation(app, hit, root, owner, found));
            Require(Owned(11, 11, 11, 11), "An actual Unity window owns its pointer.");
            Require(Owned(11, 22, 22, 11), "The cross-process owned native HUD remains eligible while Unity is unfocused.");
            Require(Owned(11, 33, 22, 11), "WebView2 renderer child PID follows the native HUD root-owner chain.");
            Require(Owned(11, 33, 11, 11), "A cross-process child parented into Unity follows its root.");
            Require(!Owned(11, 22, 22, 22), "An unrelated covering application cannot inherit overlay eligibility.");
            Require(!Owned(11, 22, 22, 0), "An ownerless foreign window is blocked.");
            Require(!Owned(11, 22, 22, 44), "A reused native-host PID without the Unity owner chain is not trusted.");
            Require(!Owned(0, 22, 22, 0), "Unknown application PID fails closed.");
            Require(!Owned(11, 0, 11, 11), "Missing actual-hit PID fails closed even with a stale root.");
            Require(!Owned(11, 11, 11, 11, false), "A missing actual cursor window cannot authorize a stale Unity pointer.");
            Require(NativePointerWindowGuard.LegacyPointerEligibility(true, false), "Non-Windows native-overlay focus semantics remain unchanged.");
            Require(NativePointerWindowGuard.LegacyPointerEligibility(false, true), "Non-Windows focused Unity remains eligible.");
            Require(!NativePointerWindowGuard.LegacyPointerEligibility(false, false), "Non-Windows unfocused legacy UI remains blocked.");
            Require(NativePointerWindowGuard.LegacyPointerEligibility(true, true), "Non-Windows focused native overlay remains eligible.");

            var observation = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11);
            var reads = 0;
            var guard = new NativePointerWindowGuard(() => { reads++; return observation; });
            Require(guard.IsPointerOverApplication(true, false, 100), "Owned native HUD is eligible without Unity keyboard focus.");
            Require(guard.IsPointerOverApplication(false, true, 100) && reads == 1, "Overview/detail and focus changes share one native observation per frame.");
            observation = new NativePointerWindowGuard.WindowObservation(11, 44, 44, 44);
            Require(!guard.IsPointerOverApplication(true, true, 101) && reads == 2, "A new covering window is detected next frame even with a stationary Unity pointer.");
            Require(!guard.IsPointerOverApplication(true, false, 101) && reads == 2, "Blocked ownership is cached for the remaining frame without a new native query.");
            observation = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11);
            Require(guard.IsPointerOverApplication(true, false, 102) && reads == 3, "Native HUD re-entry restores eligibility without requiring Unity focus.");
            var failing = new NativePointerWindowGuard(() => throw new InvalidOperationException("isolated unavailable native query"));
            Require(!failing.IsPointerOverApplication(true, true, 1), "Unavailable Windows ownership fails closed instead of trusting focus or overlay presence.");

            for (var frame = 200; frame < 264; frame++) guard.IsPointerOverApplication(true, false, frame);
            var before = GC.GetAllocatedBytesForCurrentThread();
            var allOwned = true;
            for (var frame = 300; frame < 1324; frame++) allOwned &= guard.IsPointerOverApplication(true, false, frame);
            var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
            Require(allOwned && bytes == 0, "Steady native-ownership observations allocate no managed bytes.");
        }

        private static void NativeOcclusionBlocksOverviewAndDetail()
        {
            var f = CreateFixture(); var c = f.Controller;
            var pointer = f.Camera.WorldToScreenPoint(f.Door.GetComponent<Renderer>().bounds.center);
            var probeReads = 0;
            var guard = new NativePointerWindowGuard(() => {
                probeReads++; return new NativePointerWindowGuard.WindowObservation(11, 44, 44, 44);
            });
            Set(c, "_hoverPointerWindowGuard", guard);
            Call(c, "UpdateDeviceHoverAt", pointer, false);
            Require(Get<string>(c, "_hoveredDeviceId") == "frame-budget-fixture", "Overview starts with a valid actual-mesh hover.");
            var observations = c.HoverRendererObservations;
            for (var index = 0; index < 32; index++) Call(c, "UpdateDeviceHover");
            Require(Get<string>(c, "_hoveredDeviceId") == "" && c.HoverRendererObservations == observations,
                "Native-overlay default overview polling clears an externally occluded pointer without renderer scans.");

            var modeField = typeof(FactoryDashboardController).GetField("_mode", Members);
            Set(c, "_mode", Enum.Parse(modeField.FieldType, "Detail"));
            Set(c, "_selected", f.DeviceView);
            // Normal detail entry goes through SetInspectionStage, which
            // invalidates the overview renderer snapshot. Mirror that here
            // without moving the fixture camera via a view transition.
            Set(f.Runtime, "HoverSnapshotValid", false);
            JObject payload = null; c.InspectionHoverUpdated += value => payload = value;
            void Hover(Vector3 at, bool blocked) => Call(c, "UpdateInspectionHoverAt", at, blocked);
            Hover(pointer, false);
            Require(ReferenceEquals(Get<object>(f.Runtime, "HoveredPart"), f.Part), "Detail initially picks the configured visible native part.");
            observations = c.HoverRendererObservations;
            var queries = Get<int>(f.Runtime, "PickQueryCount");
            for (var index = 0; index < 32; index++) Call(c, "UpdateInspectionHover");
            Require(Get<object>(f.Runtime, "HoveredPart") == null && !Get<bool>(f.Runtime, "HoverHitsSurface")
                && !Get<bool>(f.Runtime, "HoverSnapshotValid"), "Externally occluded default detail polling clears hover and invalidates its snapshot.");
            Require(c.HoverRendererObservations == observations && Get<int>(f.Runtime, "PickQueryCount") == queries,
                "Blocked default detail polling performs zero renderer observations and zero mesh ray queries.");
            Require(payload != null && !payload["inspectionHoverPointer"].Value<bool>("visible"), "Detail publishes the cleared hover once to the HUD.");
            Require(probeReads == 1, "Both default hover paths share a single ownership query within this Editor frame.");

            f.Root.transform.position = Vector3.right * 20; Hover(pointer, true);
            f.Root.transform.position = Vector3.zero; Hover(pointer, true);
            Require(c.HoverRendererObservations == observations && Get<int>(f.Runtime, "PickQueryCount") == queries,
                "CAD moving away and back while covered never makes a blocked pointer scan.");
            Hover(pointer, false);
            Require(ReferenceEquals(Get<object>(f.Runtime, "HoveredPart"), f.Part)
                && c.HoverRendererObservations > observations && Get<int>(f.Runtime, "PickQueryCount") > queries,
                "Detail re-entry repicks a moving native model even when the pointer returned to the same coordinates.");

            var outside = new Vector3(f.Camera.pixelRect.xMax + 1, pointer.y, 0);
            observations = c.HoverRendererObservations; queries = Get<int>(f.Runtime, "PickQueryCount");
            for (var index = 0; index < 32; index++) Hover(outside, false);
            Require(Get<object>(f.Runtime, "HoveredPart") == null && c.HoverRendererObservations == observations
                && Get<int>(f.Runtime, "PickQueryCount") == queries, "Outside-camera detail input clears hover without any CAD scan.");
            Hover(pointer, false);
            observations = c.HoverRendererObservations; queries = Get<int>(f.Runtime, "PickQueryCount");
            Hover(new Vector3(float.NaN, pointer.y, 0), false);
            Hover(new Vector3(float.PositiveInfinity, pointer.y, 0), false);
            Require(Get<object>(f.Runtime, "HoveredPart") == null && c.HoverRendererObservations == observations
                && Get<int>(f.Runtime, "PickQueryCount") == queries, "Non-finite detail coordinates are ineligible before observing renderers.");
        }

        private static void NativeCursorProjection()
        {
            var window = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11,
                clientX: 200, clientY: 100, clientWidth: 1600, clientHeight: 900);
            Require(NativePointerWindowGuard.TryProjectClientPointer(window, 3200, 1800, out var x, out var y)
                && x == 400 && y == 1598, "Owned WebView2 cursor maps client pixels to render pixels with scaling and Y inversion.");
            var reads = 0;
            var guard = new NativePointerWindowGuard(() => { reads++; return window; });
            Require(guard.IsPointerOverApplication(true, false, 10)
                && guard.TryResolvePointer(true, false, 10, 3200, 1800, -9999, -9999, out x, out y)
                && x == 400 && y == 1598 && reads == 1, "Native hover replaces stale Unity coordinates even while Unity is unfocused; ownership and projection share the frame.");
            window = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11,
                clientX: 250, clientY: 150, clientWidth: 1600, clientHeight: 900);
            Require(guard.TryResolvePointer(true, false, 11, 3200, 1800, 0, 0, out x, out y)
                && x == 500 && y == 1498 && reads == 2, "Next-frame native mouse movement does not wait for a Unity WM_MOUSEMOVE or focus change.");
            var topLeft = new NativePointerWindowGuard.WindowObservation(11, 11, 11, 11,
                clientWidth: 1280, clientHeight: 720);
            Require(NativePointerWindowGuard.TryProjectClientPointer(topLeft, 1280, 720, out x, out y)
                && x == 0 && y == 719, "Top client pixel stays inside the Unity camera rectangle.");
            var bottomRight = new NativePointerWindowGuard.WindowObservation(11, 11, 11, 11,
                clientX: 1279, clientY: 719, clientWidth: 1280, clientHeight: 720);
            Require(NativePointerWindowGuard.TryProjectClientPointer(bottomRight, 1280, 720, out x, out y)
                && x == 1279 && y == 0, "Bottom client pixel maps to Unity Y zero without an off-screen hover.");
            var outside = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11,
                clientX: -1, clientY: 100, clientWidth: 1600, clientHeight: 900);
            Require(!NativePointerWindowGuard.TryProjectClientPointer(outside, 3200, 1800, out x, out y), "Owned popups outside the Unity client rectangle cannot authorize a world pick.");
            var farEdge = new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11,
                clientX: 1600, clientY: 100, clientWidth: 1600, clientHeight: 900);
            Require(!NativePointerWindowGuard.TryProjectClientPointer(farEdge, 3200, 1800, out x, out y), "The client rectangle is half-open at its far edge.");
            var missing = new NativePointerWindowGuard(() => new NativePointerWindowGuard.WindowObservation(11, 33, 22, 11));
            Require(!missing.TryResolvePointer(true, false, 1, 1280, 720, 400, 300, out x, out y), "A missing native client projection fails closed rather than using stale Unity input.");
            Require(!NativePointerWindowGuard.TryProjectClientPointer(topLeft, 0, 720, out x, out y), "Unavailable render dimensions are not projected.");
            Require(!NativePointerWindowGuard.TryProjectClientPointer(new NativePointerWindowGuard.WindowObservation(11, 44, 44, 44,
                clientX: 100, clientY: 100, clientWidth: 1600, clientHeight: 900), 1280, 720, out x, out y), "Valid coordinates in a foreign window remain ineligible.");
            for (var frame = 20; frame < 84; frame++) guard.TryResolvePointer(true, false, frame, 3200, 1800, 0, 0, out x, out y);
            var before = GC.GetAllocatedBytesForCurrentThread();
            var allProjected = true;
            for (var frame = 100; frame < 1124; frame++) allProjected &= guard.TryResolvePointer(true, false, frame, 3200, 1800, 0, 0, out x, out y);
            Require(allProjected && GC.GetAllocatedBytesForCurrentThread() == before, "Steady native coordinate projection allocates no managed bytes.");
        }

        public static void Validate()
        {
            var code = 1;
            try {
                _checks = 0; HoverSkipsIneligibleFrames(); PausedPoseKeepsPlcOwnership();
                ExactSubEpsilonUpdates(); ForwardReverseAndReset();
                var originalChecks = _checks;
                Require(originalChecks == 77, "All 77 pre-existing frame-budget checks remain intact.");
                WindowsPointerOwnership(); NativeOcclusionBlocksOverviewAndDetail(); NativeCursorProjection();
                var result = new JObject { ["success"] = true, ["checks"] = _checks,
                    ["originalChecks"] = originalChecks, ["pointerOwnershipChecks"] = _checks - originalChecks,
                    ["realOsCursorMoved"] = false, ["realOsOwnershipQueriesDuringTests"] = 0,
                    ["actualUnityTransformsRenderersAndMaterials"] = true, ["browserOperations"] = 0,
                    ["liveConfigurationWrites"] = 0, ["measuredVisualFps"] = false, ["measuredGpuLatency"] = false,
                    ["checkedAt"] = DateTimeOffset.UtcNow.ToString("o") };
                var destination = Environment.GetEnvironmentVariable("NATIVE_INSPECTION_FRAME_VALIDATION_PATH");
                if (!string.IsNullOrWhiteSpace(destination)) File.WriteAllText(destination, result.ToString());
                Debug.Log("[InspectionFrameBudgetValidation] " + result.ToString(Newtonsoft.Json.Formatting.None)); code = 0;
            }
            catch (Exception error) { Debug.LogException(error is TargetInvocationException && error.InnerException != null ? error.InnerException : error); }
            finally {
                foreach (var controller in Controllers) if (controller != null) controller.ClearFactory();
                Controllers.Clear();
                for (var index = Owned.Count - 1; index >= 0; index--) if (Owned[index] != null) Object.DestroyImmediate(Owned[index]);
                Owned.Clear(); EditorApplication.Exit(code);
            }
        }
    }
}
#endif
