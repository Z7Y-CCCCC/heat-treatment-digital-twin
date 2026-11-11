using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed partial class FactoryDashboardController
    {
        private sealed class InspectionTargetState
        {
            public Transform Target;
            public Transform Parent;
            public Transform OffsetRoot;
            public int SiblingIndex;
            public Vector3 PivotInParent;
            public bool HasAppliedPose;
            public Vector3 RequestedPosition, AppliedPosition;
            public Quaternion RequestedRotation, AppliedRotation;
        }

        private sealed class InspectionPartState
        {
            public DeviceInspectionPartDto Config;
            public int EnabledIndex;
            public readonly List<InspectionTargetState> Targets = new List<InspectionTargetState>();
            public Renderer[] Renderers = Array.Empty<Renderer>();
            public Bounds WorldBounds;
            public Vector3 PivotInModel;
        }

        private sealed class InspectionRendererState
        {
            public Renderer Renderer;
            public Material[] OriginalMaterials;
            public Material[] RuntimeMaterials;
            public Material[] FrostedMaterials;
            public bool OriginalForceOff;
            public ShadowCastingMode OriginalShadowCasting;
            public bool OriginalReceiveShadows;
            public bool IsShell;
            public bool IsViewShell;
            public bool SurfaceApplied;
            public bool FrostedApplied;
            public InspectionPartState Part;
            public InspectionTargetState Target;
            public InspectionMeshSurface Surface;
            public Matrix4x4 HoverMatrix;
            public Mesh HoverGeometry;
            public bool HoverVisible;
            public bool HoverRayRelevant;
            public int HoverMatrixBatchIndex = -1;
            public Bounds HoverLocalBounds;
            public bool PickProjectionValid, PickProjectionFine;
            public Matrix4x4 PickProjectionMatrix;
            public Mesh PickProjectionGeometry;
            public Rect PickScreenBounds;
            public Vector2 PickNarrowNormal;
            public float PickNormalMin, PickNormalMax, PickTangentMin, PickTangentMax;
        }

        private sealed class DeviceInspectionRuntime
        {
            public DeviceInspectionConfigDto Config;
            public Transform ModelRoot;
            public Dictionary<string, Transform> OriginalPaths;
            public Transform[] OriginalNodes;
            public readonly List<InspectionPartState> Parts = new List<InspectionPartState>();
            public readonly List<InspectionRendererState> Renderers = new List<InspectionRendererState>();
            public readonly JArray Issues = new JArray();
            public InspectionPartState SelectedPart;
            public InspectionPartState HoveredPart;
            public InspectionStage Stage = InspectionStage.Solid;
            public bool Prepared;
            public bool Valid = true;
            public bool Paused;
            public bool Isolated;
            public bool LabelsEnabled = true;
            public float Clock;
            public float TargetClock;
            public float TotalDuration = 1f;
            public float XrayAmount;
            public float XrayTarget;
            public bool ShellTransparent;
            public bool ShellTransparencyControlled;
            public bool HasAuthoredShell;
            public float ShellTransparencyAmount;
            public int ViewShellCount;
            public float NextContextAt;
            public InspectionContextCache ContextCache;
            public bool HoverSnapshotValid;
            public Vector3 HoverPointer;
            public Matrix4x4 HoverCameraView, HoverCameraProjection;
            public Rect HoverCameraRect;
            public float HoverClock, HoverXray;
            public bool HoverRaySnapshotValid;
            public Matrix4x4 OverviewRootMatrix;
            public bool OverviewRootValid, OverviewRootActive;
            public bool HoverBlocked;
            public bool HoverHitsSurface;
            public int PickQueryCount;
            public bool PickCameraValid;
            public Matrix4x4 PickCameraView, PickCameraProjection;
            public Rect PickCameraRect;
            public Bounds ShellLocalBounds;
            public bool TransitionActive => (!Paused && (Mathf.Abs(Clock - TargetClock) > .0001f || Mathf.Abs(XrayAmount - XrayTarget) > .0001f))
                || Mathf.Abs(ShellTransparencyAmount - (ShellTransparent ? 1f : 0f)) > .0001f;
        }

        private readonly List<Rect> _inspectionHitRects = new List<Rect>();
        private Material _inspectionOutlineMaterial;
        private static readonly int InspectionWorldToModelId = Shader.PropertyToID("_InspectionWorldToModel");
        private static readonly int InspectionClipAxisId = Shader.PropertyToID("_ClipAxis");
        private static readonly int InspectionClipRangeId = Shader.PropertyToID("_ClipRange");
        private static readonly int InspectionOpacityId = Shader.PropertyToID("_Opacity");
        private static readonly int InspectionWireframeId = Shader.PropertyToID("_Wireframe");
        private static readonly int InspectionZWriteId = Shader.PropertyToID("_ZWrite");
#if UNITY_EDITOR
        public long InspectionOffsetWrites { get; private set; }
        public long InspectionVisibilityWrites { get; private set; }
        public long InspectionMaterialWrites { get; private set; }
        public long HoverRendererObservations { get; private set; }
#endif

        public bool RefitInspectionCamera()
        {
            if (_mode != DashboardMode.Detail || _selected?.Inspection == null) return false;
            var runtime = _selected.Inspection;
            FocusInspectionCamera(_selected, runtime.Stage, _activeViewId, false, runtime.Paused ? runtime.Clock : (float?)null);
            return true;
        }

        /// <summary>Read-only view commands. Never modifies model metadata or PLC state.</summary>
        public bool ApplyInspectionCommand(string deviceId, JObject command, out string error)
        {
            error = string.Empty;
            if (string.IsNullOrWhiteSpace(deviceId)) deviceId = SelectedDeviceId;
            if (!_devices.TryGetValue(deviceId ?? string.Empty, out var device))
            {
                error = "Inspection device not found.";
                return false;
            }
            var action = command?.Value<string>("command") ?? string.Empty;
            if (!new[] { "stage", "select", "clear", "progress", "isolate", "labels", "pause", "resume", "shell_transparency" }.Contains(action))
            {
                error = "Unknown inspection command.";
                return false;
            }
            var stageName = command.Value<string>("stage") ?? string.Empty;
            if (action == "stage" && stageName != "solid" && stageName != "xray" && stageName != "exploded")
            {
                error = "Unknown inspection stage.";
                return false;
            }
            if (action == "shell_transparency" && (_selected != device || _mode != DashboardMode.Detail))
            {
                error = "Shell transparency requires the currently focused device.";
                return false;
            }
            if (_selected != device || _mode != DashboardMode.Detail) ShowDetail(device);
            PrepareInspection(device);
            var runtime = device.Inspection;
            if (!runtime.Config.Enabled || !runtime.Valid)
            {
                error = runtime.Config.Enabled ? "Inspection configuration has target conflicts; fix the reported issues." : "Inspection is disabled for this model.";
                PublishInspectionContext(device);
                return false;
            }
            switch (action)
            {
                case "shell_transparency":
                    if (command["enabled"]?.Type != JTokenType.Boolean || runtime.ViewShellCount == 0
                        || (runtime.Stage != InspectionStage.Solid && runtime.Stage != InspectionStage.Xray)
                        || Resources.Load<Shader>("RuntimeShaders/InspectionShell") == null)
                    {
                        error = "Shell transparency requires an assembled view and configured cover meshes.";
                        return false;
                    }
                    runtime.ShellTransparent = command.Value<bool>("enabled");
                    runtime.ShellTransparencyControlled = true;
                    runtime.HoverSnapshotValid = false;
                    PublishInspectionContext(device);
                    return true; // No camera, timeline, animation or PLC changes.
                case "stage":
                    SetInspectionStage(device, ParseInspectionStage(stageName));
                    return true;
                case "select":
                    var id = command.Value<string>("partId") ?? string.Empty;
                    if (!runtime.Parts.Any(part => string.Equals(part.Config.Id, id, StringComparison.Ordinal)))
                    {
                        error = "Inspection part not found.";
                        return false;
                    }
                    SetInspectionStage(device, InspectionStage.PartDetail, false, id);
                    return true;
                case "clear":
                    runtime.SelectedPart = null;
                    runtime.Isolated = false;
                    if (runtime.Stage == InspectionStage.PartDetail) runtime.Stage = InspectionStage.Exploded;
                    _activeViewId = InspectionViewId(runtime, runtime.Stage, null);
                    FocusInspectionCamera(device, runtime.Stage, _activeViewId, false);
                    break;
                case "progress":
                    var progress = command.Value<float?>("progress") ?? float.NaN;
                    if (!float.IsFinite(progress) || progress < 0f || progress > 1f)
                    {
                        error = "Inspection progress must be between 0 and 1.";
                        return false;
                    }
                    runtime.ShellTransparent = runtime.ShellTransparencyControlled = false;
                    runtime.ShellTransparencyAmount = 0f;
                    var reversing = runtime.TargetClock < runtime.Clock;
                    runtime.Paused = true;
                    runtime.Clock = progress * runtime.TotalDuration;
                    runtime.TargetClock = reversing ? 0f : runtime.TotalDuration;
                    runtime.XrayAmount = runtime.XrayTarget = 0f;
                    runtime.Stage = runtime.SelectedPart == null ? (reversing ? InspectionStage.Solid : InspectionStage.Exploded) : InspectionStage.PartDetail;
                    _activeViewId = InspectionViewId(runtime, runtime.Stage, runtime.SelectedPart);
                    ApplyInspectionPose(runtime);
                    FocusInspectionCamera(device, runtime.Stage, _activeViewId, false, runtime.Clock);
                    break;
                case "pause": runtime.Paused = true; _orbit?.StopAutoTransition(); break;
                case "resume":
                    runtime.Paused = false;
                    FocusInspectionCamera(device, runtime.Stage, _activeViewId, false);
                    break;
                case "labels": runtime.LabelsEnabled = command.Value<bool?>("enabled") ?? true; break;
                case "isolate":
                    var enabled = command.Value<bool?>("enabled") ?? true;
                    if (enabled && runtime.SelectedPart == null)
                    {
                        error = "Select a part before isolating it.";
                        return false;
                    }
                    runtime.Isolated = enabled;
                    break;
            }
            ApplyInspectionPose(runtime);
            PublishInspectionContext(device);
            return true;
        }

        public bool ApplyInspectionPreview(string deviceId, JObject configuration, out string error)
        {
            error = string.Empty;
            if (!_devices.TryGetValue(deviceId ?? string.Empty, out var device) || configuration == null)
            {
                error = "Inspection preview requires an existing device and configuration.";
                return false;
            }
            DeviceInspectionConfigDto config;
            try { config = configuration.ToObject<DeviceInspectionConfigDto>(); }
            catch (Exception exception) { error = exception.Message; return false; }
            config ??= new DeviceInspectionConfigDto();
            config.Normalize();
            // Resolve and validate against the original paths before altering any wrappers.
            // An invalid engineer preview must leave the previous presentation intact.
            var candidate = BuildInspectionPlan(device, config);
            if (!candidate.Valid)
            {
                device.Inspection.Issues.Clear();
                foreach (var issue in candidate.Issues) device.Inspection.Issues.Add(issue.DeepClone());
                PublishInspectionContext(device);
                error = "Inspection preview rejected: duplicate, ancestor, or unresolved target(s).";
                DisposeInspectionResources(candidate);
                return false;
            }
            ResetInspection(device, true);
            device.Inspection = candidate;
            BindInspectionPlan(candidate);
            ShowDetail(device);
            SetInspectionStage(device, config.Enabled ? InspectionStage.Exploded : InspectionStage.Solid);
            return true;
        }

        private void PrepareInspection(DeviceView device)
        {
            if (device?.Root == null || device.Inspection?.Prepared == true) return;
            var config = device.Inspection?.Config ?? ResolveInspectionConfig(device.Device);
            config.Normalize();
            device.Inspection = BuildInspectionPlan(device, config);
            BindInspectionPlan(device.Inspection);
            Debug.Log($"[Inspection] {device.Device?.Id ?? string.Empty} model={device.Device?.ModelType ?? string.Empty} enabled={config.Enabled} parts={device.Inspection.Parts.Count} valid={device.Inspection.Valid} issues={device.Inspection.Issues.Count}");
        }

        private static DeviceInspectionRuntime BuildInspectionPlan(DeviceView device, DeviceInspectionConfigDto config)
        {
            var runtime = new DeviceInspectionRuntime
            {
                Config = config,
                ModelRoot = device.Root.transform,
                OriginalPaths = device.Inspection?.OriginalPaths ?? BuildTransformPathMap(device.Root.transform),
                OriginalNodes = device.Inspection?.OriginalNodes ?? device.Root.GetComponentsInChildren<Transform>(true),
                LabelsEnabled = config.Labels.Enabled,
                TotalDuration = InspectionTimeline.Duration(config)
            };
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var claimed = new List<(Transform node, InspectionPartState part)>();
            var enabledIndex = 0;
            foreach (var partConfig in config.Parts)
            {
                if (partConfig == null || !partConfig.Enabled) continue;
                var part = new InspectionPartState { Config = partConfig, EnabledIndex = enabledIndex++ };
                if (!ids.Add(partConfig.Id)) AddInspectionIssue(runtime, "duplicate_part_id", partConfig.Id, "部件 ID 重复，请为每个装配组设置唯一 ID。", true);
                var nodes = ResolveInspectionTargets(runtime, partConfig.NodePath, partConfig.NodeName, partConfig.NodePaths, partConfig.NodeNames, partConfig.Id);
                // Selecting an assembly and one of its children in the SAME group is redundant,
                // but selecting overlapping assemblies in DIFFERENT groups is an error.
                nodes.RemoveAll(node => nodes.Any(other => other != node && node.IsChildOf(other)));
                foreach (var node in nodes)
                {
                    if (node == runtime.ModelRoot)
                    {
                        AddInspectionIssue(runtime, "root_target", partConfig.Id, "设备根节点不能作为拆解部件，请选择其下的实际装配组。", true);
                        continue;
                    }
                    if (runtime.Config.OffsetSpace == "model" && partConfig.ExplodeRotation.Any(value => Mathf.Abs(value) > .0001f))
                    {
                        var basis = node.parent.worldToLocalMatrix * runtime.ModelRoot.localToWorldMatrix;
                        var x = basis.MultiplyVector(Vector3.right); var y = basis.MultiplyVector(Vector3.up); var z = basis.MultiplyVector(Vector3.forward);
                        var scale = Mathf.Max(x.magnitude, y.magnitude, z.magnitude, .00001f);
                        if (Mathf.Abs(x.magnitude - y.magnitude) > scale * .001f || Mathf.Abs(x.magnitude - z.magnitude) > scale * .001f
                            || Mathf.Abs(Vector3.Dot(x.normalized, y.normalized)) > .001f || Mathf.Abs(Vector3.Dot(x.normalized, z.normalized)) > .001f || Mathf.Abs(Vector3.Dot(y.normalized, z.normalized)) > .001f)
                            AddInspectionIssue(runtime, "nonuniform_rotation_parent", partConfig.Id, $"部件 {partConfig.Name} 的父级包含非均匀缩放；请先在模型中应用缩放，或将拆解转角设为零。", true);
                    }
                    foreach (var previous in claimed)
                    {
                        if (node == previous.node || node.IsChildOf(previous.node) || previous.node.IsChildOf(node))
                            AddInspectionIssue(runtime, "overlapping_part_targets", partConfig.Id,
                                $"部件 {partConfig.Name} 与 {previous.part.Config.Name} 重复或父子重叠，不能执行两次位移。", true);
                    }
                    part.Targets.Add(new InspectionTargetState { Target = node });
                    claimed.Add((node, part));
                }
                part.Renderers = nodes.SelectMany(node => node.GetComponentsInChildren<Renderer>(true)).Distinct().ToArray();
                if (part.Renderers.Length == 0) AddInspectionIssue(runtime, "empty_part", partConfig.Id, $"部件 {partConfig.Name} 没有可展示的网格。", false);
                if (nodes.Count == 0) AddInspectionIssue(runtime, "missing_part_target", partConfig.Id, $"部件 {partConfig.Name} 未指定可解析的模型节点。", true);
                runtime.Parts.Add(part);
            }
            var shellNodes = ResolveInspectionTargets(runtime, "", "", config.Shell.NodePaths, config.Shell.NodeNames, "");
            var retained = new HashSet<Renderer>(runtime.Parts.SelectMany(part => part.Renderers));
            var shells = new HashSet<Renderer>();
            foreach (var shell in shellNodes)
            {
                // A shell may be an assembly parent of configured parts. Its own
                // meshes can disappear while retained part meshes remain visible.
                // Only the same node or a shell nested *inside* a part is invalid.
                if (claimed.Any(item => item.node == shell || shell.IsChildOf(item.node)))
                {
                    AddInspectionIssue(runtime, "shell_part_overlap", "", $"外壳节点 {shell.name} 与部件节点重复，或被部件包含；请在后台改选外壳节点。", true);
                    continue;
                }
                var children = shell.GetComponentsInChildren<Renderer>(true);
                foreach (var renderer in children) if (!retained.Contains(renderer)) shells.Add(renderer);
            }
            // Capture originals only; planning is read-only so rejected previews cannot leak materials.
            foreach (var renderer in device.Root.GetComponentsInChildren<Renderer>(true))
            {
                var oldState = device.Inspection?.Renderers.FirstOrDefault(state => state.Renderer == renderer);
                var owner = claimed.FirstOrDefault(item => renderer.transform == item.node || renderer.transform.IsChildOf(item.node));
                runtime.Renderers.Add(new InspectionRendererState
                {
                    Renderer = renderer,
                    OriginalMaterials = oldState?.OriginalMaterials ?? renderer.sharedMaterials,
                    OriginalForceOff = oldState?.OriginalForceOff ?? renderer.forceRenderingOff,
                    OriginalShadowCasting = oldState?.OriginalShadowCasting ?? renderer.shadowCastingMode,
                    OriginalReceiveShadows = oldState?.OriginalReceiveShadows ?? renderer.receiveShadows,
                    IsShell = shells.Contains(renderer),
                    IsViewShell = IsPackagedCoverRenderer(renderer.transform, runtime.ModelRoot, shells.Contains(renderer)),
                    Part = owner.part,
                    Target = owner.part?.Targets.FirstOrDefault(target => target.Target == owner.node),
                    Surface = new InspectionMeshSurface(renderer)
                });
            }
            runtime.ViewShellCount = runtime.Renderers.Count(state => state.IsViewShell);
            runtime.HasAuthoredShell = runtime.Renderers.Any(state => state.IsShell);
            return runtime;
        }

        private static bool IsPackagedCoverRenderer(Transform node, Transform root, bool authoredShell)
        {
            for (var current = node; current != null && current != root; current = current.parent)
            {
                if (ShellTransparencyTargets.IsOpaqueNode(current.name)) return false;
                if (ShellTransparencyTargets.IsCoverNode(current.name)) return true;
            }
            return authoredShell;
        }

        private static List<Transform> ResolveInspectionTargets(DeviceInspectionRuntime runtime, string legacyPath, string legacyName,
            IEnumerable<string> paths, IEnumerable<string> names, string partId)
        {
            var targets = new HashSet<Transform>();
            void ResolvePath(string path)
            {
                if (runtime.OriginalPaths.TryGetValue(path, out var target) && target != null) targets.Add(target);
                else AddInspectionIssue(runtime, "node_not_found", partId, $"模型中找不到节点路径：{path}", true);
            }
            void ResolveName(string name)
            {
                var matches = runtime.OriginalNodes.Where(node => node != null && string.Equals(node.name, name, StringComparison.Ordinal)).ToArray();
                if (matches.Length == 1) targets.Add(matches[0]);
                else AddInspectionIssue(runtime, matches.Length == 0 ? "node_not_found" : "ambiguous_node_name", partId,
                    matches.Length == 0 ? $"模型中找不到节点名称：{name}" : $"节点名称 {name} 不唯一，请使用完整路径。", true);
            }
            if (!string.IsNullOrWhiteSpace(legacyPath)) ResolvePath(legacyPath);
            if (!string.IsNullOrWhiteSpace(legacyName)) ResolveName(legacyName);
            foreach (var path in paths ?? Array.Empty<string>()) ResolvePath(path);
            foreach (var name in names ?? Array.Empty<string>()) ResolveName(name);
            return targets.ToList();
        }

        private static void AddInspectionIssue(DeviceInspectionRuntime runtime, string code, string partId, string message, bool error)
        {
            runtime.Issues.Add(new JObject { ["code"] = code, ["partId"] = partId, ["message"] = message, ["severity"] = error ? "error" : "warning" });
            if (error) runtime.Valid = false;
        }

        private static Dictionary<string, Transform> BuildTransformPathMap(Transform root)
        {
            var result = new Dictionary<string, Transform>(StringComparer.Ordinal);
            void Visit(Transform parent, string parentPath)
            {
                for (var index = 0; index < parent.childCount; index++)
                {
                    var child = parent.GetChild(index);
                    if (child.name.StartsWith("__Inspection", StringComparison.Ordinal)) continue;
                    var segment = $"{child.name.Replace("/", "_")}#{index}";
                    var path = string.IsNullOrEmpty(parentPath) ? segment : $"{parentPath}/{segment}";
                    result[path] = child;
                    Visit(child, path);
                }
            }
            Visit(root, string.Empty);
            return result;
        }

        private static void BindInspectionPlan(DeviceInspectionRuntime runtime)
        {
            runtime.Prepared = true;
            if (!runtime.Valid || !runtime.Config.Enabled) return;
            foreach (var state in runtime.Renderers) state.Surface.PrepareForPicking();
            foreach (var part in runtime.Parts)
            {
                part.WorldBounds = InspectionBounds(part.Renderers, runtime.ModelRoot.position, true);
                var pivot = part.WorldBounds.center;
                if (runtime.Config.OffsetSpace == "model")
                {
                    var modelBounds = new Bounds();
                    var hasBounds = false;
                    foreach (var state in runtime.Renderers)
                    {
                        if (state.Part != part || state.Renderer == null) continue;
                        var bounds = TransformInspectionBounds(state.Surface.LocalBounds, runtime.ModelRoot.worldToLocalMatrix * state.Renderer.localToWorldMatrix);
                        if (hasBounds) modelBounds.Encapsulate(bounds); else { modelBounds = bounds; hasBounds = true; }
                    }
                    if (hasBounds) pivot = runtime.ModelRoot.TransformPoint(modelBounds.center);
                }
                part.PivotInModel = runtime.ModelRoot.InverseTransformPoint(pivot);
                foreach (var target in part.Targets)
                {
                    target.Parent = target.Target.parent;
                    target.SiblingIndex = target.Target.GetSiblingIndex();
                    target.PivotInParent = target.Parent.InverseTransformPoint(pivot);
                    var wrapper = new GameObject($"__InspectionOffset_{part.Config.Id}").transform;
                    wrapper.SetParent(target.Parent, false);
                    wrapper.SetSiblingIndex(target.SiblingIndex);
                    target.OffsetRoot = wrapper;
                    // Keep the original local TRS untouched: ModelBindingDriver continues
                    // to own translation/rotation on this node throughout the inspection.
                    target.Target.SetParent(wrapper, false);
                }
            }
            var shellBounds = new Bounds(Vector3.zero, Vector3.zero);
            var hasShell = false;
            foreach (var state in runtime.Renderers.Where(state => state.IsShell))
            {
                var bounds = TransformInspectionBounds(state.Surface.LocalBounds, runtime.ModelRoot.worldToLocalMatrix * state.Renderer.localToWorldMatrix);
                if (hasShell) shellBounds.Encapsulate(bounds); else { shellBounds = bounds; hasShell = true; }
            }
            runtime.ShellLocalBounds = shellBounds;
        }

        private static Vector3 InspectionVector(IEnumerable<float> values)
        {
            var array = (values ?? Enumerable.Empty<float>()).Take(3).ToArray();
            return new Vector3(array.Length > 0 ? array[0] : 0f, array.Length > 1 ? array[1] : 0f, array.Length > 2 ? array[2] : 0f);
        }

        private static void InspectionOffsetPose(DeviceInspectionRuntime runtime, InspectionPartState part, InspectionTargetState target,
            float amount, out Vector3 position, out Quaternion rotation)
        {
            var offset = InspectionAuthorVector(runtime, part.Config.ExplodeOffset) * amount;
            var authoredRotation = InspectionAuthorRotation(runtime, part.Config.ExplodeRotation, amount);
            var pivot = target.PivotInParent;
            if (runtime.Config.OffsetSpace == "model")
            {
                offset = target.Parent.InverseTransformVector(runtime.ModelRoot.TransformVector(offset));
                // Matrix conjugation keeps mirrored model instances in the authored
                // coordinate handedness; quaternion-only bases discard negative scale.
                var basis = target.Parent.worldToLocalMatrix * runtime.ModelRoot.localToWorldMatrix;
                rotation = (basis * Matrix4x4.Rotate(authoredRotation) * basis.inverse).rotation;
                pivot = target.Parent.InverseTransformPoint(runtime.ModelRoot.TransformPoint(part.PivotInModel));
            }
            else rotation = authoredRotation;
            position = offset + pivot - rotation * pivot;
        }

        private static Vector3 InspectionAuthorVector(DeviceInspectionRuntime runtime, IEnumerable<float> values)
        {
            var value = InspectionVector(values);
            // glTFast imports right-handed glTF by mirroring X. Legacy parent offsets
            // were authored for Unity and must not be migrated implicitly.
            return runtime.Config.OffsetSpace == "model" ? new Vector3(-value.x, value.y, value.z) : value;
        }

        private static Quaternion InspectionAuthorRotation(DeviceInspectionRuntime runtime, IEnumerable<float> values, float amount)
        {
            var value = InspectionVector(values) * amount;
            if (runtime.Config.OffsetSpace != "model") return Quaternion.Euler(value);
            // Three's XYZ Euler order, conjugated by the same X reflection as glTFast.
            return Quaternion.AngleAxis(value.x, Vector3.right) * Quaternion.AngleAxis(-value.y, Vector3.up) * Quaternion.AngleAxis(-value.z, Vector3.forward);
        }

        private static int InspectionShellDirection(DeviceInspectionRuntime runtime)
            => runtime.Config.Shell.Direction * (runtime.Config.OffsetSpace == "model" && runtime.Config.Shell.Axis == "x" ? -1 : 1);

        private void SetInspectionStage(DeviceView device, InspectionStage stage, bool immediate = false, string partId = "")
        {
            PrepareInspection(device);
            var runtime = device?.Inspection;
            if (runtime == null) return;
            if (!runtime.Config.Enabled || !runtime.Valid) stage = InspectionStage.Solid;
            var selectedPart = stage == InspectionStage.PartDetail
                ? runtime.Parts.FirstOrDefault(part => string.Equals(part.Config.Id, partId, StringComparison.Ordinal)) : null;
            if (stage == InspectionStage.PartDetail && selectedPart == null) stage = InspectionStage.Exploded;
            // Selecting the already focused part is not a new transition.
            // Preserve its pause/isolation state and the user's camera instead
            // of restarting animation, geometry picking and overlay traffic.
            if (!immediate && stage == InspectionStage.PartDetail && runtime.Stage == stage
                && runtime.SelectedPart == selectedPart) return;
            runtime.SelectedPart = selectedPart;
            runtime.Stage = stage;
            runtime.ShellTransparent = runtime.ShellTransparencyControlled = false;
            runtime.ShellTransparencyAmount = 0f;
            runtime.Isolated = false;
            runtime.HoveredPart = null;
            runtime.HoverSnapshotValid = false;
            runtime.Paused = false;
            runtime.TargetClock = stage == InspectionStage.Exploded || stage == InspectionStage.PartDetail ? runtime.TotalDuration : 0f;
            runtime.XrayTarget = stage == InspectionStage.Xray ? 1f : 0f;
            if (immediate)
            {
                runtime.Clock = runtime.TargetClock;
                runtime.XrayAmount = runtime.XrayTarget;
            }
            ApplyInspectionPose(runtime);
            _activeViewId = InspectionViewId(runtime, stage, runtime.SelectedPart);
            FocusInspectionCamera(device, stage, _activeViewId, immediate);
            PublishInspectionContext(device);
        }

        private void UpdateInspectionTransition()
        {
            var runtime = _selected?.Inspection;
            if (_mode != DashboardMode.Detail || runtime == null || !runtime.Prepared) return;
            var wasAnimating = runtime.TransitionActive;
            // Presentation fade is independent of inspection pause and live motion.
            runtime.ShellTransparencyAmount = Mathf.MoveTowards(runtime.ShellTransparencyAmount,
                runtime.ShellTransparent ? 1f : 0f, Time.unscaledDeltaTime / .2f);
            if (!runtime.Paused)
            {
                var playbackSeconds = Time.unscaledDeltaTime * Mathf.Clamp(runtime.Config.PlaybackSpeed, .25f, 3f);
                runtime.Clock = InspectionTimeline.Advance(runtime.Clock, runtime.TargetClock, playbackSeconds);
                var fadeSeconds = runtime.Stage == InspectionStage.Xray ? runtime.Config.Xray.TransitionSeconds : runtime.Config.Solid.TransitionSeconds;
                var xrayTarget = runtime.Stage == InspectionStage.Xray && runtime.Clock > 0f ? 0f : runtime.XrayTarget;
                runtime.XrayAmount = Mathf.MoveTowards(runtime.XrayAmount, xrayTarget, Time.unscaledDeltaTime / Mathf.Max(.05f, fadeSeconds));
            }
            ApplyInspectionPose(runtime);
            if (runtime.SelectedPart != null && !runtime.Paused && (wasAnimating || runtime.TransitionActive))
                _orbit?.TrackBoundsCenter(runtime.SelectedPart.WorldBounds);
            // Camera framing is computed once from destination geometry at the command,
            // never a second time at animation completion (the old double camera jump).
        }

        private void ApplyInspectionPose(DeviceInspectionRuntime runtime)
        {
            if (!runtime.Valid || !runtime.Config.Enabled) return;
            foreach (var part in runtime.Parts)
            {
                var amount = InspectionTimeline.PartProgress(runtime.Config, part.Config, part.EnabledIndex, runtime.Clock);
                foreach (var target in part.Targets)
                {
                    if (target.OffsetRoot == null || target.Parent == null) continue;
                    InspectionOffsetPose(runtime, part, target, amount, out var position, out var rotation);
                    ApplyInspectionTargetPose(target, position, rotation);
                }
                part.WorldBounds = InspectionBounds(part.Renderers, runtime.ModelRoot.position);
            }
            var shellProgress = InspectionTimeline.ShellProgress(runtime.Config, runtime.Clock);
            foreach (var state in runtime.Renderers)
            {
                if (state.Renderer == null) continue;
                var isolatedAway = runtime.Isolated && runtime.SelectedPart != null && state.Part != runtime.SelectedPart;
                SetInspectionForceOff(state.Renderer, state.OriginalForceOff || isolatedAway || (state.IsShell && shellProgress >= .99999f));
                if (state.IsShell) ApplyInspectionShell(runtime, state, shellProgress);
                else if (state.IsViewShell && (runtime.ShellTransparencyAmount > 0f || state.SurfaceApplied))
                    ApplyInspectionShell(runtime, state, 0f);
                if (state.Part != null && !state.IsShell) ApplyInspectionFocusMaterials(runtime, state);
            }
        }

        private void ApplyInspectionTargetPose(InspectionTargetState target, Vector3 position, Quaternion rotation)
        {
            var actualPosition = target.OffsetRoot.localPosition;
            var actualRotation = target.OffsetRoot.localRotation;
            // Exact Float32 inputs, not approximate Unity ==. Remember the
            // native quaternion normalization result but always reread actual
            // pose, so external edits are corrected and moving PLC children
            // retain ownership of their own local TRS below this offset root.
            if (target.HasAppliedPose && target.RequestedPosition.Equals(position) && target.RequestedRotation.Equals(rotation)
                && target.AppliedPosition.Equals(actualPosition) && target.AppliedRotation.Equals(actualRotation)) return;
            target.RequestedPosition = position; target.RequestedRotation = rotation;
            if (!actualPosition.Equals(position) || !actualRotation.Equals(rotation))
            {
                target.OffsetRoot.SetLocalPositionAndRotation(position, rotation);
#if UNITY_EDITOR
                InspectionOffsetWrites++;
#endif
            }
            target.AppliedPosition = target.OffsetRoot.localPosition; target.AppliedRotation = target.OffsetRoot.localRotation;
            target.HasAppliedPose = true;
        }

        private void SetInspectionForceOff(Renderer renderer, bool value)
        {
            if (renderer.forceRenderingOff == value) return;
            renderer.forceRenderingOff = value;
#if UNITY_EDITOR
            InspectionVisibilityWrites++;
#endif
        }

        private void ApplyInspectionFocusMaterials(DeviceInspectionRuntime runtime, InspectionRendererState state)
        {
            var renderer = state.Renderer;
            var shouldFrost = runtime.SelectedPart != null && state.Part != runtime.SelectedPart && !state.Renderer.forceRenderingOff;
            if (!shouldFrost)
            {
                if (!state.FrostedApplied) return;
                renderer.sharedMaterials = state.OriginalMaterials;
                renderer.shadowCastingMode = state.OriginalShadowCasting;
                renderer.receiveShadows = state.OriginalReceiveShadows;
                state.FrostedApplied = false;
                return;
            }
            if (state.FrostedMaterials == null)
            {
                var shader = Resources.Load<Shader>("RuntimeShaders/InspectionFrosted");
                if (shader == null)
                {
                    if (!runtime.Issues.OfType<JObject>().Any(issue => issue.Value<string>("code") == "frosted_shader_missing"))
                        AddInspectionIssue(runtime, "frosted_shader_missing", "", "关键部件聚焦材质缺失，请重新构建播放器。", false);
                    return;
                }
                state.FrostedMaterials = state.OriginalMaterials
                    .Select(original => CreateInspectionFrostedMaterial(original, shader))
                    .ToArray();
            }
            if (state.FrostedApplied) return;
            renderer.sharedMaterials = state.FrostedMaterials;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            state.FrostedApplied = true;
        }

        private void ApplyInspectionShell(DeviceInspectionRuntime runtime, InspectionRendererState state, float progress)
        {
            var needsSurface = progress > 0f || (!runtime.ShellTransparencyControlled && state.IsShell && runtime.XrayAmount > 0f)
                || (state.IsViewShell && runtime.ShellTransparencyAmount > 0f);
            if (!needsSurface)
            {
                if (!state.SurfaceApplied) return;
                state.Renderer.sharedMaterials = state.OriginalMaterials;
                state.Renderer.shadowCastingMode = state.OriginalShadowCasting;
                state.Renderer.receiveShadows = state.OriginalReceiveShadows;
                state.SurfaceApplied = false;
                return;
            }
            if (state.RuntimeMaterials == null)
            {
                var shader = Resources.Load<Shader>("RuntimeShaders/InspectionShell");
                if (shader == null)
                {
                    if (!runtime.Issues.OfType<JObject>().Any(issue => issue.Value<string>("code") == "shell_shader_missing"))
                        AddInspectionIssue(runtime, "shell_shader_missing", "", "原生外壳裁切着色器缺失，请重新构建播放器。", false);
                    return;
                }
                state.RuntimeMaterials = state.OriginalMaterials.Select(original => CreateInspectionShellMaterial(original, shader)).ToArray();
            }
            if (!state.SurfaceApplied)
            {
                state.Renderer.sharedMaterials = state.RuntimeMaterials;
                state.Renderer.shadowCastingMode = ShadowCastingMode.Off;
                state.Renderer.receiveShadows = false;
                state.SurfaceApplied = true;
            }
            var shell = runtime.Config.Shell;
            var alpha = state.IsShell ? Mathf.Lerp(1f, shell.Opacity, InspectionTimeline.Ease(runtime.XrayAmount, runtime.Config.Easing)) : 1f;
            if (state.IsViewShell && runtime.ShellTransparencyControlled)
                alpha = Mathf.Lerp(1f, ShellTransparencyTargets.GhostOpacity, InspectionTimeline.Ease(runtime.ShellTransparencyAmount, "smoothstep"));
            var clipProgress = shell.Transition == "clip" ? progress : 0f;
            if (shell.Transition == "fade") alpha *= 1f - progress;
            var axis = shell.Axis == "x" ? Vector3.right : shell.Axis == "z" ? Vector3.forward : Vector3.up;
            var minimum = Vector3.Dot(runtime.ShellLocalBounds.min, axis);
            var maximum = Vector3.Dot(runtime.ShellLocalBounds.max, axis);
            foreach (var material in state.RuntimeMaterials)
            {
                if (material == null) continue;
                SetInspectionMaterialMatrix(material, InspectionWorldToModelId, runtime.ModelRoot.worldToLocalMatrix);
                SetInspectionMaterialVector(material, InspectionClipAxisId, axis);
                SetInspectionMaterialVector(material, InspectionClipRangeId, new Vector4(minimum, maximum, InspectionShellDirection(runtime), clipProgress));
                SetInspectionMaterialFloat(material, InspectionOpacityId, alpha);
                SetInspectionMaterialFloat(material, InspectionWireframeId, shell.Wireframe && runtime.XrayAmount > .5f ? 1f : 0f);
                SetInspectionMaterialFloat(material, InspectionZWriteId, alpha >= .999f ? 1f : 0f);
                var queue = alpha >= .999f ? (int)RenderQueue.Geometry + 1 : (int)RenderQueue.Transparent;
                if (material.renderQueue != queue)
                {
                    material.renderQueue = queue;
#if UNITY_EDITOR
                    InspectionMaterialWrites++;
#endif
                }
            }
        }

        // Shader uniforms need not occur in ShaderLab Properties. Read their
        // actual native values, never use HasProperty to suppress an override.
        private void SetInspectionMaterialFloat(Material material, int property, float value)
        {
            if (material.GetFloat(property).Equals(value)) return;
            material.SetFloat(property, value);
#if UNITY_EDITOR
            InspectionMaterialWrites++;
#endif
        }
        private void SetInspectionMaterialVector(Material material, int property, Vector4 value)
        {
            if (material.GetVector(property).Equals(value)) return;
            material.SetVector(property, value);
#if UNITY_EDITOR
            InspectionMaterialWrites++;
#endif
        }
        private void SetInspectionMaterialMatrix(Material material, int property, Matrix4x4 value)
        {
            if (material.GetMatrix(property).Equals(value)) return;
            material.SetMatrix(property, value);
#if UNITY_EDITOR
            InspectionMaterialWrites++;
#endif
        }

        private static Material CreateInspectionShellMaterial(Material original, Shader shader)
        {
            if (original == null) return null;
            var material = new Material(shader) { name = $"{original.name} / inspection", hideFlags = HideFlags.DontSave };
            // Matrix uniforms are not ShaderLab Properties. Seed the native
            // override before the first read (GetMatrix otherwise logs an error).
            material.SetMatrix(InspectionWorldToModelId, Matrix4x4.identity);
            string First(params string[] names) => names.FirstOrDefault(original.HasProperty);
            var color = First("baseColorFactor", "_BaseColor", "_Color");
            if (color != null) material.SetColor("_BaseColor", original.GetColor(color));
            var map = First("baseColorTexture", "_BaseMap", "_MainTex");
            if (map != null && original.GetTexture(map) != null)
            {
                material.SetTexture("_BaseMap", original.GetTexture(map));
                material.SetTextureScale("_BaseMap", original.GetTextureScale(map));
                material.SetTextureOffset("_BaseMap", original.GetTextureOffset(map));
            }
            var metallic = First("metallicFactor", "_Metallic");
            if (metallic != null) material.SetFloat("_Metallic", original.GetFloat(metallic));
            var roughness = First("roughnessFactor");
            var smoothness = First("_Smoothness", "_Glossiness");
            material.SetFloat("_Smoothness", roughness != null ? 1f - original.GetFloat(roughness) : smoothness != null ? original.GetFloat(smoothness) : .45f);
            var emission = First("emissiveFactor", "_EmissionColor");
            if (emission != null) material.SetColor("_EmissionColor", original.GetColor(emission));
            return material;
        }

        private static Material CreateInspectionFrostedMaterial(Material original, Shader shader)
        {
            if (original == null) return null;
            var material = new Material(shader) { name = $"{original.name} / frosted inspection", hideFlags = HideFlags.DontSave };
            string First(params string[] names) => names.FirstOrDefault(original.HasProperty);
            var color = First("baseColorFactor", "_BaseColor", "_Color");
            if (color != null) material.SetColor("_BaseColor", original.GetColor(color));
            var map = First("baseColorTexture", "_BaseMap", "_MainTex");
            if (map != null && original.GetTexture(map) != null)
            {
                material.SetTexture("_BaseMap", original.GetTexture(map));
                material.SetTextureScale("_BaseMap", original.GetTextureScale(map));
                material.SetTextureOffset("_BaseMap", original.GetTextureOffset(map));
            }
            var emission = First("emissiveFactor", "_EmissionColor");
            if (emission != null) material.SetColor("_EmissionColor", original.GetColor(emission) * .16f);
            material.SetFloat("_FrostAmount", .9f);
            material.SetFloat("_Desaturation", .78f);
            material.SetFloat("_Opacity", .38f);
            material.SetFloat("_NoiseScale", 2.4f);
            material.SetFloat("_NoiseStrength", .08f);
            material.SetColor("_Tint", new Color(.54f, .66f, .75f, 1f));
            return material;
        }

        private void ResetInspection(DeviceView device, bool dispose)
        {
            var runtime = device?.Inspection;
            if (runtime == null) return;
            runtime.Clock = runtime.TargetClock = runtime.XrayAmount = runtime.XrayTarget = 0f;
            runtime.ShellTransparent = false;
            runtime.ShellTransparencyControlled = false;
            runtime.ShellTransparencyAmount = 0f;
            runtime.Paused = runtime.Isolated = false;
            runtime.SelectedPart = runtime.HoveredPart = null;
            runtime.HoverSnapshotValid = false;
            runtime.Stage = InspectionStage.Solid;
            foreach (var state in runtime.Renderers)
            {
                if (state.Renderer == null) continue;
                if (state.SurfaceApplied || state.FrostedApplied) state.Renderer.sharedMaterials = state.OriginalMaterials;
                SetInspectionForceOff(state.Renderer, state.OriginalForceOff);
                state.Renderer.shadowCastingMode = state.OriginalShadowCasting;
                state.Renderer.receiveShadows = state.OriginalReceiveShadows;
                state.SurfaceApplied = false;
                state.FrostedApplied = false;
            }
            foreach (var part in runtime.Parts)
            {
                foreach (var target in part.Targets)
                {
                    if (target.OffsetRoot == null) continue;
                    ApplyInspectionTargetPose(target, Vector3.zero, Quaternion.identity);
                    if (!dispose) continue;
                    if (target.Target != null)
                    {
                        target.Target.SetParent(target.Parent, false);
                        target.Target.SetSiblingIndex(target.SiblingIndex);
                    }
                    // Destroy is deferred to end-of-frame. Detach first so a same-frame
                    // preview rebuild cannot pick up dead wrappers or altered child indices.
                    target.OffsetRoot.SetParent(null, false);
                    target.OffsetRoot.gameObject.SetActive(false);
                    DestroyInspectionObject(target.OffsetRoot.gameObject);
                    target.OffsetRoot = null;
                }
            }
            if (!dispose) return;
            DisposeInspectionResources(runtime);
            device.Inspection = null;
        }

        private static void DisposeInspectionResources(DeviceInspectionRuntime runtime)
        {
            foreach (var state in runtime.Renderers)
            {
                foreach (var material in state.RuntimeMaterials ?? Array.Empty<Material>()) DestroyInspectionObject(material);
                foreach (var material in state.FrostedMaterials ?? Array.Empty<Material>()) DestroyInspectionObject(material);
                state.Surface?.Dispose();
            }
            runtime.Renderers.Clear();
        }

        private static void DestroyInspectionObject(UnityEngine.Object value)
        {
            if (value == null) return;
#if UNITY_EDITOR
            if (!Application.isPlaying) { DestroyImmediate(value); return; }
#endif
            Destroy(value);
        }

        private static Bounds InspectionBounds(IEnumerable<Renderer> renderers, Vector3 fallback, bool includeInactive = false)
        {
            var hasBounds = false;
            var result = new Bounds(fallback, Vector3.one * .02f);
            foreach (var renderer in renderers)
            {
                if (renderer == null || !renderer.enabled || (!includeInactive && !renderer.gameObject.activeInHierarchy)) continue;
                if (!hasBounds) { result = renderer.bounds; hasBounds = true; }
                else result.Encapsulate(renderer.bounds);
            }
            return result;
        }

        private static Bounds TransformInspectionBounds(Bounds bounds, Matrix4x4 matrix)
        {
            var result = new Bounds(matrix.MultiplyPoint3x4(bounds.center), Vector3.zero);
            for (var index = 0; index < 8; index++)
                result.Encapsulate(matrix.MultiplyPoint3x4(bounds.center + Vector3.Scale(bounds.extents,
                    new Vector3((index & 1) == 0 ? -1 : 1, (index & 2) == 0 ? -1 : 1, (index & 4) == 0 ? -1 : 1))));
            return result;
        }

        private static Bounds InspectionDestinationBounds(DeviceInspectionRuntime runtime, float clock, InspectionPartState onlyPart)
        {
            var result = new Bounds(runtime.ModelRoot.position, Vector3.one * .02f);
            var hasBounds = false;
            foreach (var state in runtime.Renderers)
            {
                if (state.Renderer == null || !state.Renderer.enabled || state.OriginalForceOff || !state.Renderer.gameObject.activeInHierarchy) continue;
                if (onlyPart != null && state.Part != onlyPart) continue;
                if (state.IsShell && InspectionTimeline.ShellProgress(runtime.Config, clock) >= .99999f) continue;
                var matrix = state.Renderer.localToWorldMatrix;
                if (state.Target?.OffsetRoot != null)
                {
                    var amount = InspectionTimeline.PartProgress(runtime.Config, state.Part.Config, state.Part.EnabledIndex, clock);
                    InspectionOffsetPose(runtime, state.Part, state.Target, amount, out var offset, out var rotation);
                    matrix = state.Target.Parent.localToWorldMatrix * Matrix4x4.TRS(offset, rotation, Vector3.one)
                        * state.Target.OffsetRoot.worldToLocalMatrix * state.Renderer.localToWorldMatrix;
                }
                var bounds = TransformInspectionBounds(state.Surface.LocalBounds, matrix);
                if (!hasBounds) { result = bounds; hasBounds = true; } else result.Encapsulate(bounds);
            }
            return result;
        }

        private string InspectionViewId(DeviceInspectionRuntime runtime, InspectionStage stage, InspectionPartState part)
        {
            if (stage == InspectionStage.PartDetail) return string.IsNullOrWhiteSpace(part?.Config.DetailViewId) ? "device_part" : part.Config.DetailViewId;
            var configured = stage == InspectionStage.Xray ? runtime.Config.Xray : stage == InspectionStage.Exploded ? runtime.Config.Exploded : runtime.Config.Solid;
            if (!string.IsNullOrWhiteSpace(configured.ViewId)) return configured.ViewId;
            return stage == InspectionStage.Xray ? "device_xray" : stage == InspectionStage.Exploded ? "device_exploded" : "device_detail";
        }

        private void FocusInspectionCamera(DeviceView device, InspectionStage stage, string viewId, bool immediate, float? destinationClock = null)
        {
            if (_orbit == null || device?.Inspection == null) return;
            var runtime = device.Inspection;
            var stageConfig = stage == InspectionStage.Xray ? runtime.Config.Xray : stage == InspectionStage.Exploded || stage == InspectionStage.PartDetail ? runtime.Config.Exploded : runtime.Config.Solid;
            var camera = runtime.SelectedPart == null ? stageConfig.Camera
                : runtime.SelectedPart.Config.Camera ?? new DeviceInspectionCameraDto
                {
                    Yaw = stageConfig.Camera.Yaw,
                    Pitch = stageConfig.Camera.Pitch,
                    DistanceScale = 1.12f,
                    // A factory-sized target offset would place a small component offscreen.
                    TargetOffset = new List<float> { 0f, 0f, 0f }
                };
            var authoredViewId = stage == InspectionStage.PartDetail ? runtime.SelectedPart?.Config.DetailViewId : stageConfig.ViewId;
            var useView = runtime.SelectedPart?.Config.Camera == null && !string.IsNullOrWhiteSpace(authoredViewId)
                && _configuredViews.TryGetValue(authoredViewId, out _);
            var view = useView ? _configuredViews[authoredViewId] : null;
            var yaw = camera.Yaw;
            if (view == null || view.RelativeToTarget) yaw += runtime.ModelRoot.eulerAngles.y;
            if (view != null) yaw = view.RelativeToTarget ? runtime.ModelRoot.eulerAngles.y + view.Yaw : view.Yaw;
            var pitch = view?.Pitch ?? camera.Pitch;
            if (view == null && runtime.Config.OffsetSpace == "model")
            {
                var a = camera.Yaw * Mathf.Deg2Rad;
                var p = camera.Pitch * Mathf.Deg2Rad;
                var direction = runtime.ModelRoot.TransformVector(new Vector3(-Mathf.Sin(a) * Mathf.Cos(p), Mathf.Sin(p), Mathf.Cos(a) * Mathf.Cos(p))).normalized;
                yaw = Mathf.Atan2(-direction.x, -direction.z) * Mathf.Rad2Deg;
                pitch = Mathf.Asin(Mathf.Clamp(direction.y, -1f, 1f)) * Mathf.Rad2Deg;
            }
            var clock = destinationClock ?? runtime.TargetClock;
            var bounds = InspectionDestinationBounds(runtime, clock, runtime.SelectedPart);
            var seconds = useView ? view.TransitionSeconds : stageConfig.TransitionSeconds;
            if (runtime.SelectedPart == null && !destinationClock.HasValue) seconds = Mathf.Max(seconds, Mathf.Abs(clock - runtime.Clock));
            if (destinationClock.HasValue) seconds = .18f;
            _orbit.SetTransitionDuration(seconds);
            _orbit.SetTargetOffset(view?.TargetOffset ?? runtime.ModelRoot.TransformVector(InspectionAuthorVector(runtime, camera.TargetOffset)));
            _orbit.FocusBounds(bounds, Mathf.DeltaAngle(0f, yaw), pitch, view?.DistanceScale ?? camera.DistanceScale, immediate, true);
            if (runtime.SelectedPart != null && runtime.TransitionActive) _orbit.TrackBoundsCenter(runtime.SelectedPart.WorldBounds);
        }

        private InspectionPartState PickInspectionPart(DeviceInspectionRuntime runtime, Ray ray)
        {
            return PickInspectionSurface(runtime, ray, out _, out _);
        }

        private InspectionPartState PickInspectionSurface(DeviceInspectionRuntime runtime, Ray ray, out float distance, out InspectionRendererState hitState)
        {
            runtime.PickQueryCount++;
            InspectionPartState closest = null;
            distance = float.PositiveInfinity;
            hitState = null;
            var reveal = InspectionTimeline.ShellProgress(runtime.Config, runtime.Clock);
            Func<Vector3, bool> acceptShell = null;
            if (runtime.Config.Shell.Transition == "clip" && reveal > 0f)
            {
                var inverse = runtime.ModelRoot.worldToLocalMatrix;
                var axis = runtime.Config.Shell.Axis == "x" ? 0 : runtime.Config.Shell.Axis == "z" ? 2 : 1;
                var minimum = runtime.ShellLocalBounds.min[axis];
                var maximum = runtime.ShellLocalBounds.max[axis];
                var forward = InspectionShellDirection(runtime) > 0;
                acceptShell = world => {
                    var normalized = Mathf.InverseLerp(minimum, maximum, inverse.MultiplyPoint3x4(world)[axis]);
                    return (forward ? normalized : 1f - normalized) >= reveal;
                };
            }
            foreach (var state in runtime.Renderers)
            {
                if (!state.Surface.Raycast(ray, out var hit, state.IsShell ? acceptShell : null, distance)) continue;
                distance = hit;
                hitState = state;
                closest = state.Part; // An unselectable visible mesh correctly occludes a part behind it.
            }
            return closest;
        }

        private static readonly Vector2[] InspectionPickOffsets = {
            new Vector2(3, 0), new Vector2(-3, 0), new Vector2(0, 3), new Vector2(0, -3),
            new Vector2(6, 0), new Vector2(-6, 0), new Vector2(0, 6), new Vector2(0, -6),
            new Vector2(4.25f, 4.25f), new Vector2(-4.25f, 4.25f),
            new Vector2(4.25f, -4.25f), new Vector2(-4.25f, -4.25f)
        };

        private InspectionPartState PickInspectionPartAt(DeviceInspectionRuntime runtime, Vector3 pointer)
        {
            var exact = PickInspectionSurface(runtime, _camera.ScreenPointToRay(pointer), out var distance, out var exactState);
            runtime.HoverHitsSurface = !float.IsPositiveInfinity(distance);
            // An exact thin part wins. An unselectable visible surface is an
            // occluder, not empty space through which to select hidden parts.
            if (exact == null && !float.IsPositiveInfinity(distance)) return null;
            var rect = _camera.pixelRect;
            if (!rect.Contains(pointer)) return null;
            RefreshInspectionPickProjections(runtime);
            if (exactState?.PickProjectionFine == true) return exact;
            var candidateNearby = false;
            foreach (var state in runtime.Renderers)
            {
                if (state.Part == null || !state.PickProjectionValid || (exact != null && !state.PickProjectionFine)) continue;
                var area = state.PickScreenBounds;
                area.xMin -= 6.1f; area.xMax += 6.1f; area.yMin -= 6.1f; area.yMax += 6.1f;
                if (area.Contains(pointer)) { candidateNearby = true; break; }
            }
            if (!candidateNearby) return exact;
            // Aim at the projected thin strip itself, rather than hoping that
            // a fixed angular sampling pattern happens to cross a diagonal pipe.
            InspectionRendererState first = null, second = null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                InspectionRendererState candidate = null; var target = Vector2.zero; var nearest = 6.1f;
                foreach (var state in runtime.Renderers)
                {
                    if (state == first || state == second || state.Part == null || !state.PickProjectionValid || !state.PickProjectionFine) continue;
                    var normal = state.PickNarrowNormal; var tangent = new Vector2(-normal.y, normal.x);
                    var point = normal * ((state.PickNormalMin + state.PickNormalMax) * .5f)
                        + tangent * Mathf.Clamp(Vector2.Dot(tangent, pointer), state.PickTangentMin + .001f, state.PickTangentMax - .001f);
                    var delta = Vector2.Distance(point, pointer);
                    if (delta >= nearest) continue;
                    nearest = delta; candidate = state; target = point;
                }
                if (candidate == null) break;
                var part = PickInspectionSurface(runtime, _camera.ScreenPointToRay(target), out var hitDistance, out var hitState);
                if (part != null && hitState.PickProjectionFine && (exact == null || hitDistance <= distance * 1.002f + .0001f))
                {
                    runtime.HoverHitsSurface = true;
                    return part;
                }
                if (attempt == 0) first = candidate; else second = candidate;
            }
            if (exact != null) return exact;
            // Small, bounded screen-pixel assistance only when the center ray
            // missed. Every sample still has to hit a real visible triangle.
            foreach (var offset in InspectionPickOffsets)
            {
                var point = pointer + new Vector3(offset.x, offset.y, 0);
                if (!rect.Contains(point)) continue;
                var nearby = PickInspectionSurface(runtime, _camera.ScreenPointToRay(point), out var nearbyDistance, out var nearbyState);
                if (nearby == null || nearby == exact) continue;
                if (exact == null || (nearbyState.PickProjectionFine && nearbyDistance <= distance * 1.002f + .0001f))
                {
                    runtime.HoverHitsSurface = true;
                    return nearby;
                }
            }
            return exact;
        }

        private readonly Vector2[] _inspectionPickCorners = new Vector2[8];
        private static readonly int[] InspectionBoxEdges = { 0,1, 0,2, 0,4, 1,3, 1,5, 2,3, 2,6, 3,7, 4,5, 4,6, 5,7, 6,7 };

        private void RefreshInspectionPickProjections(DeviceInspectionRuntime runtime)
        {
            var view = _camera.worldToCameraMatrix; var projection = _camera.projectionMatrix; var rect = _camera.pixelRect;
            var cameraChanged = !runtime.PickCameraValid || !runtime.PickCameraView.Equals(view)
                || !runtime.PickCameraProjection.Equals(projection) || !runtime.PickCameraRect.Equals(rect);
            runtime.PickCameraValid = true; runtime.PickCameraView = view; runtime.PickCameraProjection = projection; runtime.PickCameraRect = rect;
            foreach (var state in runtime.Renderers)
            {
                if (state.Part == null || !state.Surface.IsVisible) { state.PickProjectionValid = false; continue; }
                var matrix = state.Renderer.localToWorldMatrix; var mesh = state.Surface.Geometry;
                if (!cameraChanged && state.PickProjectionValid && state.PickProjectionMatrix.Equals(matrix)
                    && ReferenceEquals(mesh, state.PickProjectionGeometry) && !state.Surface.HasDynamicGeometry) continue;
                state.PickProjectionMatrix = matrix; state.PickProjectionGeometry = mesh;
                state.PickProjectionValid = false; state.PickProjectionFine = false;
                var bounds = state.Surface.LocalBounds; var cameraLocal = view * matrix; var clipLocal = projection * cameraLocal;
                var min = new Vector2(float.PositiveInfinity, float.PositiveInfinity);
                var max = new Vector2(float.NegativeInfinity, float.NegativeInfinity);
                var valid = true;
                for (var index = 0; index < 8; index++)
                {
                    var local = bounds.center + Vector3.Scale(bounds.extents,
                        new Vector3((index & 1) == 0 ? -1 : 1, (index & 2) == 0 ? -1 : 1, (index & 4) == 0 ? -1 : 1));
                    if (-cameraLocal.MultiplyPoint3x4(local).z <= _camera.nearClipPlane) { valid = false; break; }
                    var clip = clipLocal * new Vector4(local.x, local.y, local.z, 1);
                    if (Mathf.Abs(clip.w) < 1e-6f) { valid = false; break; }
                    var point = new Vector2(rect.x + (clip.x / clip.w + 1) * rect.width * .5f,
                        rect.y + (clip.y / clip.w + 1) * rect.height * .5f);
                    _inspectionPickCorners[index] = point; min = Vector2.Min(min, point); max = Vector2.Max(max, point);
                }
                if (!valid) continue;
                state.PickScreenBounds = Rect.MinMaxRect(min.x, min.y, max.x, max.y);
                var narrowest = Mathf.Min(max.x - min.x, max.y - min.y);
                var narrowNormal = max.x - min.x <= max.y - min.y ? Vector2.right : Vector2.up;
                var normalMin = narrowNormal.x > 0 ? min.x : min.y;
                var normalMax = narrowNormal.x > 0 ? max.x : max.y;
                // Check oriented widths too: a diagonal pipe must not be
                // mistaken for a large part just because its axis-aligned box is wide.
                for (var edge = 0; edge < InspectionBoxEdges.Length; edge += 2)
                {
                    var direction = _inspectionPickCorners[InspectionBoxEdges[edge + 1]] - _inspectionPickCorners[InspectionBoxEdges[edge]];
                    if (direction.sqrMagnitude < .01f) continue;
                    var normal = new Vector2(-direction.y, direction.x).normalized;
                    var low = float.PositiveInfinity; var high = float.NegativeInfinity;
                    for (var index = 0; index < 8; index++) { var d = Vector2.Dot(normal, _inspectionPickCorners[index]); low = Mathf.Min(low, d); high = Mathf.Max(high, d); }
                    if (high - low < narrowest) { narrowest = high - low; narrowNormal = normal; normalMin = low; normalMax = high; }
                }
                state.PickProjectionFine = narrowest <= 12f;
                state.PickNarrowNormal = narrowNormal; state.PickNormalMin = normalMin; state.PickNormalMax = normalMax;
                var along = new Vector2(-narrowNormal.y, narrowNormal.x);
                var alongMin = float.PositiveInfinity; var alongMax = float.NegativeInfinity;
                for (var index = 0; index < 8; index++) { var d = Vector2.Dot(along, _inspectionPickCorners[index]); alongMin = Mathf.Min(alongMin, d); alongMax = Mathf.Max(alongMax, d); }
                state.PickTangentMin = alongMin; state.PickTangentMax = alongMax;
                state.PickProjectionValid = true;
            }
        }

        private void SelectInspectionTargetAt(Vector3 pointer)
        {
            var runtime = _selected?.Inspection;
            if (_camera == null || runtime == null || !runtime.Valid || !runtime.Config.Enabled
                || !_camera.pixelRect.Contains(pointer)) return;
            // Validate the cached rendered hover against pointer/camera/PLC
            // transforms. A stationary click reuses it instead of repeating up
            // to sixteen full-model ray queries and then a fallback query.
            UpdateInspectionHoverAt(pointer, false);
            var part = runtime.HoveredPart;
            if (runtime.Stage == InspectionStage.Solid || runtime.Stage == InspectionStage.Xray)
            {
                if (runtime.HoverHitsSurface)
                    SetInspectionStage(_selected, runtime.Stage == InspectionStage.Solid ? InspectionStage.Xray : InspectionStage.Exploded);
                return;
            }
            if (part != null) SetInspectionStage(_selected, InspectionStage.PartDetail, false, part.Config.Id);
        }

        private bool InspectionHoverChanged(DeviceInspectionRuntime runtime, Vector3 pointer, bool blocked)
            => ObserveHoverInputs(runtime, pointer, blocked, false);

        private bool OverviewHoverChanged(DeviceInspectionRuntime runtime, Vector3 pointer)
            => ObserveHoverInputs(runtime, pointer, false, true);

        private bool ObserveHoverInputs(DeviceInspectionRuntime runtime, Vector3 pointer, bool blocked, bool rayRelevantOnly)
        {
            if (blocked)
            {
                // Occluded/outside pointers must not observe any CAD renderer.
                // Invalidate the snapshot, so re-entry still repicks geometry
                // which moved away and back while another window covered us.
                var blockedChanged = runtime.HoverSnapshotValid || !runtime.HoverBlocked
                    || !runtime.HoverPointer.Equals(pointer) || runtime.HoveredPart != null || runtime.HoverHitsSurface;
                runtime.HoverPointer = pointer;
                runtime.HoverBlocked = true;
                runtime.HoverSnapshotValid = false;
                runtime.HoverRaySnapshotValid = false;
                return blockedChanged;
            }
            var changed = !runtime.HoverSnapshotValid || !runtime.HoverPointer.Equals(pointer)
                || !runtime.HoverCameraView.Equals(_camera.worldToCameraMatrix)
                || !runtime.HoverCameraProjection.Equals(_camera.projectionMatrix)
                || !runtime.HoverCameraRect.Equals(_camera.pixelRect)
                || runtime.HoverBlocked != blocked || runtime.HoverClock != runtime.Clock
                || runtime.HoverXray != runtime.XrayAmount;
            var rayChanged = changed || !runtime.HoverRaySnapshotValid;
            var ray = rayRelevantOnly ? _camera.ScreenPointToRay(pointer) : default;
            if (rayRelevantOnly && rayChanged) changed = true;
            runtime.HoverPointer = pointer;
            runtime.HoverCameraView = _camera.worldToCameraMatrix;
            runtime.HoverCameraProjection = _camera.projectionMatrix;
            runtime.HoverCameraRect = _camera.pixelRect;
            runtime.HoverBlocked = blocked; runtime.HoverClock = runtime.Clock; runtime.HoverXray = runtime.XrayAmount;
            foreach (var state in runtime.Renderers)
            {
#if UNITY_EDITOR
                HoverRendererObservations++;
#endif
                // The opposite cart mechanism is a real exported subtree but
                // only one side is displayed at a time. An inactive subtree
                // cannot affect any ray; keep its old pose snapshot and observe
                // the current matrix/mesh immediately when it becomes active.
                if(state.Renderer!=null&&!state.Renderer.gameObject.activeInHierarchy){
                    changed|=rayRelevantOnly?state.HoverRayRelevant:state.HoverVisible;
                    state.HoverVisible=false;state.HoverRayRelevant=false;continue;
                }
                var matrix = state.Renderer == null ? Matrix4x4.identity
                    : rayRelevantOnly && _overviewMatricesActive && state.HoverMatrixBatchIndex >= 0
                        ? _overviewMatrices.Get(state.HoverMatrixBatchIndex) : state.Renderer.localToWorldMatrix;
                var geometry = state.Renderer != null ? state.Surface.Geometry : null;
                var localBounds = rayRelevantOnly && geometry != null ? geometry.bounds : default;
                // A mesh wholly outside the ray cannot affect selection even
                // if its enabled/force-off/active flags change. Avoid thousands
                // of native visibility queries for those irrelevant surfaces.
                // Keep observing actual mesh bounds and transforms every frame.
                var candidate = !rayRelevantOnly || state.Surface.HasDynamicGeometry
                    || state.Renderer != null && state.Renderer.isPartOfStaticBatch
                    || geometry != null && HoverRayBroadphase.Intersects(localBounds, matrix, ray);
                var visible = candidate && state.Surface.IsVisible;
                var surfaceChanged = visible != state.HoverVisible || !matrix.Equals(state.HoverMatrix)
                    || !ReferenceEquals(geometry, state.HoverGeometry)
                    || rayRelevantOnly && !localBounds.Equals(state.HoverLocalBounds)
                    // Skinned deformation may change even with a stationary transform.
                    || (visible && state.Surface.HasDynamicGeometry);
                if (rayRelevantOnly)
                {
                    // Still observe every real transform/visibility/mesh, but a
                    // fan moving away from this stationary ray cannot alter its
                    // nearest triangle hit. Test current AND previous bounds so
                    // entering/leaving the ray always forces an exact repick.
                    if (rayChanged || surfaceChanged)
                    {
                        var relevant = visible && state.Renderer != null && state.Renderer.bounds.IntersectRay(ray);
                        changed |= surfaceChanged && (state.HoverRayRelevant || relevant);
                        state.HoverRayRelevant = relevant;
                    }
                }
                else changed |= surfaceChanged;
                state.HoverVisible = visible; state.HoverMatrix = matrix; state.HoverGeometry = geometry; state.HoverLocalBounds = localBounds;
            }
            runtime.HoverSnapshotValid = true;
            runtime.HoverRaySnapshotValid = rayRelevantOnly;
            return changed;
        }

        private void UpdateInspectionHover()
        {
            var runtime = _selected?.Inspection;
            if (_mode != DashboardMode.Detail || runtime == null || _camera == null || !runtime.Valid) return;
            var pointerOwned = TryGetHoverPointer(out var pointer);
            var blocked = !pointerOwned
                || (!_webOverlayActive && IsPointerOverDashboard(ScreenToDesign(pointer)))
                || pointer.x < 0 || pointer.y < 0 || pointer.x > Screen.width || pointer.y > Screen.height;
            UpdateInspectionHoverAt(pointer, blocked);
        }

        private void UpdateInspectionHoverAt(Vector3 pointer, bool blocked)
        {
            var runtime = _selected?.Inspection;
            if (_mode != DashboardMode.Detail || runtime == null || _camera == null || !runtime.Valid) return;
            blocked |= !float.IsFinite(pointer.x) || !float.IsFinite(pointer.y)
                || !_camera.pixelRect.Contains(new Vector2(pointer.x, pointer.y));
            // Keep drawing the last outline every frame. Only the expensive
            // exact picking is skipped when every input to the pick is unchanged.
            var previousPointer = runtime.HoverPointer;
            if (!InspectionHoverChanged(runtime, pointer, blocked)) return;
            if (blocked) runtime.HoverHitsSurface = false;
            var hovered = blocked ? null : PickInspectionPartAt(runtime, pointer);
            var partChanged = runtime.HoveredPart != hovered;
            runtime.HoveredPart = hovered;
            if (!partChanged && (hovered == null || previousPointer.Equals(pointer))) return;
            InspectionHoverUpdated?.Invoke(new JObject {
                ["viewId"] = _activeViewId ?? string.Empty, ["deviceId"] = _selected.Device?.Id ?? string.Empty,
                ["inspectionStage"] = InspectionStageKey(runtime.Stage),
                ["inspectionHoveredPartId"] = hovered?.Config.Id ?? string.Empty,
                ["inspectionHoverPointer"] = HoverPointerProjection(runtime)
            });
        }

        private static JObject HoverPointerProjection(DeviceInspectionRuntime runtime)
        {
            return new JObject { ["x"] = runtime.HoverPointer.x / Mathf.Max(1, Screen.width),
                ["y"] = 1f - runtime.HoverPointer.y / Mathf.Max(1, Screen.height),
                ["visible"] = runtime.HoveredPart != null && !runtime.HoverBlocked };
        }

        private void LateUpdate()
        {
            using var work = RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.Inspection);
            using (RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.Occlusion)) {
                _occlusionFader.SetFocus(_camera, _mode == DashboardMode.Detail ? _selected?.Root?.transform : null, transform);
                _occlusionFader.Tick(Time.unscaledTimeAsDouble, Time.unscaledDeltaTime);
            }
            if (_mode == DashboardMode.Overview) { UpdateDeviceHover(); DrawDeviceHover(); return; }
            UpdateDeviceHoverAt(Input.mousePosition, true);
            var runtime = _selected?.Inspection;
            if (runtime == null) return;
            // This controller executes after OrbitCameraController. Pick against
            // the camera/animated part transforms that will be rendered now.
            UpdateInspectionHover();
            DrawInspectionHover(runtime);
            if (Time.unscaledTime >= runtime.NextContextAt) PublishInspectionContext(_selected);
        }

        private void DrawInspectionHover(DeviceInspectionRuntime runtime)
        {
            InspectionOutlineRenderer.Begin(_camera);
            if (runtime.HoveredPart == null || _camera == null) return;
            if (EnsureHoverOutlineMaterial() == null) return;
            foreach (var state in runtime.Renderers)
            {
                if (state.Part != runtime.HoveredPart || state.Surface == null) continue;
                state.Surface.DrawOutline(_inspectionOutlineMaterial, _camera, new Color(.72f, .78f, 1f, .95f), 2f);
            }
        }

        private Material EnsureHoverOutlineMaterial()
        {
            if (_inspectionOutlineMaterial == null)
            {
                var shader = Resources.Load<Shader>("RuntimeShaders/InspectionOutline");
                if (shader == null) return null;
                _inspectionOutlineMaterial = new Material(shader)
                {
                    name = "Equipment and part hover outline",
                    hideFlags = HideFlags.DontSave
                };
            }
            return _inspectionOutlineMaterial;
        }

        private void DisposeInspectionHighlight()
        {
            InspectionOutlineRenderer.Release(_camera);
            DestroyInspectionObject(_inspectionOutlineMaterial);
            _inspectionOutlineMaterial = null;
        }

        private sealed class InspectionContextCache
        {
            public JObject Context;
            public InspectionPartState SelectedPart;
        }

        private static void SetInspectionContextValue(JObject target, string key, object value)
        {
            if (target[key] is JValue token) token.Value = value;
            else target[key] = new JValue(value);
        }

        private void UpdateInspectionProjection(JObject projection, Vector3 point, bool shown)
        {
            var viewport = _camera != null ? _camera.WorldToViewportPoint(point) : new Vector3(0f, 0f, -1f);
            var finite = float.IsFinite(viewport.x) && float.IsFinite(viewport.y) && float.IsFinite(viewport.z);
            SetInspectionContextValue(projection, "x", finite ? viewport.x : 0f);
            SetInspectionContextValue(projection, "y", finite ? 1f - viewport.y : 0f);
            SetInspectionContextValue(projection, "visible", shown && finite && viewport.z > (_camera?.nearClipPlane ?? .01f)
                && viewport.x >= 0f && viewport.x <= 1f && viewport.y >= 0f && viewport.y <= 1f);
        }

        private void PublishInspectionContext(DeviceView device)
        {
            if (device?.Inspection == null || _selected != device || _mode != DashboardMode.Detail) return;
            var runtime = device.Inspection;
            runtime.NextContextAt = Time.unscaledTime + .1f;
            var cache = runtime.ContextCache;
            if (cache == null)
            {
                var descriptors = new JArray();
                foreach (var part in runtime.Parts)
                    descriptors.Add(new JObject
                    {
                        ["id"] = part.Config.Id, ["name"] = part.Config.Name, ["group"] = part.Config.Group, ["description"] = part.Config.Description,
                        ["pointIds"] = new JArray(part.Config.PointIds), ["pointKeys"] = new JArray(part.Config.PointKeys),
                        ["selected"] = false, ["anchor"] = new JObject(), ["label"] = new JObject()
                    });
                cache = runtime.ContextCache = new InspectionContextCache { Context = new JObject
                {
                    ["viewMode"] = "device", ["deviceId"] = device.Device?.Id ?? string.Empty,
                    ["inspectionEnabled"] = runtime.Config.Enabled, ["inspectionLeaderLines"] = runtime.Config.Labels.LeaderLines,
                    ["inspectionParts"] = descriptors,
                    ["partId"] = string.Empty, ["partName"] = string.Empty, ["partDescription"] = string.Empty,
                    ["partPointIds"] = new JArray(), ["partPointKeys"] = new JArray(), ["partDetailViewId"] = string.Empty
                } };
            }
            var context = cache.Context;
            // Reproject the device bounds as the camera moves; never pin this
            // control to the hierarchy toolbar or to a fixed screen position.
            if (!(context["shellControlAnchor"] is JObject controlAnchor))
                context["shellControlAnchor"] = controlAnchor = new JObject();
            var controlLeft = float.PositiveInfinity; var controlRight = float.NegativeInfinity;
            var controlTop = float.NegativeInfinity; var controlVisible = false;
            var controlBounds = device.WorldBounds;
            for (var corner = 0; corner < 8 && _camera != null; corner++)
            {
                var point = _camera.WorldToViewportPoint(controlBounds.center + Vector3.Scale(controlBounds.extents,
                    new Vector3((corner & 1) == 0 ? -1 : 1, (corner & 2) == 0 ? -1 : 1, (corner & 4) == 0 ? -1 : 1)));
                if (!float.IsFinite(point.x) || !float.IsFinite(point.y) || point.z <= _camera.nearClipPlane) continue;
                controlVisible = true;
                controlLeft = Mathf.Min(controlLeft, point.x); controlRight = Mathf.Max(controlRight, point.x); controlTop = Mathf.Max(controlTop, point.y);
            }
            SetInspectionContextValue(controlAnchor, "x", controlVisible ? Mathf.Clamp01((controlLeft + controlRight) * .5f) : .5f);
            SetInspectionContextValue(controlAnchor, "y", controlVisible ? Mathf.Clamp01(1f - controlTop) : 0f);
            SetInspectionContextValue(controlAnchor, "visible", controlVisible && controlRight >= 0 && controlLeft <= 1);
            var parts = (JArray)context["inspectionParts"];
            for (var index = 0; index < runtime.Parts.Count; index++)
            {
                var part = runtime.Parts[index];
                var descriptor = (JObject)parts[index];
                var anchor = InspectionBounds(part.Renderers, runtime.ModelRoot.position).center;
                var labelOffset = InspectionAuthorVector(runtime, part.Config.LabelOffset);
                var labelBasis = runtime.Config.OffsetSpace == "model" ? runtime.ModelRoot : part.Targets.FirstOrDefault()?.Parent ?? runtime.ModelRoot;
                var shown = runtime.Config.Enabled && runtime.Valid
                    && part.Renderers.Any(renderer => renderer != null && renderer.enabled && !renderer.forceRenderingOff && renderer.gameObject.activeInHierarchy);
                var labelShown = shown && runtime.LabelsEnabled
                    && InspectionTimeline.PartProgress(runtime.Config, part.Config, part.EnabledIndex, runtime.Clock) > .02f;
                SetInspectionContextValue(descriptor, "selected", part == runtime.SelectedPart);
                UpdateInspectionProjection((JObject)descriptor["anchor"], anchor, shown);
                UpdateInspectionProjection((JObject)descriptor["label"], anchor + labelBasis.TransformVector(labelOffset), labelShown);
            }
            var progressing = Mathf.Abs(runtime.Clock - runtime.TargetClock) > .0001f;
            var pending = progressing || Mathf.Abs(runtime.XrayAmount - runtime.XrayTarget) > .0001f;
            var phase = runtime.Paused && pending ? "paused" : !runtime.TransitionActive ? "idle"
                : runtime.Clock <= runtime.Config.ShellDuration && progressing ? "shell"
                : runtime.TargetClock >= runtime.Clock && progressing ? "exploding" : progressing ? "assembling" : "xray";
            if (cache.SelectedPart != runtime.SelectedPart)
            {
                cache.SelectedPart = runtime.SelectedPart;
                var selected = runtime.SelectedPart?.Config;
                SetInspectionContextValue(context, "partId", selected?.Id ?? string.Empty);
                SetInspectionContextValue(context, "partName", selected?.Name ?? string.Empty);
                SetInspectionContextValue(context, "partDescription", selected?.Description ?? string.Empty);
                SetInspectionContextValue(context, "partDetailViewId", selected?.DetailViewId ?? string.Empty);
                context["partPointIds"] = selected == null ? new JArray() : new JArray(selected.PointIds);
                context["partPointKeys"] = selected == null ? new JArray() : new JArray(selected.PointKeys);
            }
            if (!JToken.DeepEquals(context["inspectionIssues"], runtime.Issues))
            {
                context["inspectionIssues"] = runtime.Issues.DeepClone();
            }
            SetInspectionContextValue(context, "viewId", _activeViewId ?? string.Empty);
            SetInspectionContextValue(context, "inspectionStage", InspectionStageKey(runtime.Stage));
            SetInspectionContextValue(context, "shellTransparencyAvailable", runtime.Config.Enabled && runtime.Valid && runtime.ViewShellCount > 0
                && (runtime.Stage == InspectionStage.Solid || runtime.Stage == InspectionStage.Xray));
            SetInspectionContextValue(context, "shellTransparent", runtime.ShellTransparencyControlled ? runtime.ShellTransparent : runtime.Stage == InspectionStage.Xray && runtime.HasAuthoredShell);
            SetInspectionContextValue(context, "inspectionProgress", Mathf.Clamp01(runtime.Clock / runtime.TotalDuration));
            SetInspectionContextValue(context, "inspectionAnimating", runtime.TransitionActive);
            SetInspectionContextValue(context, "inspectionPhase", phase);
            SetInspectionContextValue(context, "inspectionIsolated", runtime.Isolated);
            SetInspectionContextValue(context, "inspectionLabelsEnabled", runtime.LabelsEnabled);
            SetInspectionContextValue(context, "inspectionHoveredPartId", runtime.HoveredPart?.Config.Id ?? string.Empty);
            context["inspectionHoverPointer"] = HoverPointerProjection(runtime);
            // Synchronous borrowed context: the runtime subscriber clones it before
            // storing/sending. A replacement inspection plan owns a fresh cache.
            InspectionContextChanged?.Invoke(context);
        }

        private void DrawInspectionControlsAndLabels(DeviceView device)
        {
            _inspectionHitRects.Clear();
            var runtime = device?.Inspection;
            if (runtime == null || !runtime.Config.Enabled) return;
            var y = _dashboardConfig.Detail.Trends.Visible ? DetailTrendRect().y - 66f : DesignHeight - 90f;
            var controls = new Rect(DesignWidth * .5f - 260f, y, 520f, 58f);
            _inspectionHitRects.Add(controls);
            DrawSolid(controls, PanelStrong);
            var stages = new[] { InspectionStage.Solid, InspectionStage.Xray, InspectionStage.Exploded };
            var names = new[] { "完整组装", "外壳透视", "拆解部件" };
            for (var index = 0; index < 3; index++)
                if (GUI.Button(new Rect(controls.x + 8 + index * 116, y + 5, 110, 29), names[index], _buttonStyle)) SetInspectionStage(device, stages[index]);
            if (GUI.Button(new Rect(controls.x + 360, y + 5, 150, 29), runtime.Paused ? "继续动画" : "暂停动画", _buttonStyle))
                ApplyInspectionCommand(device.Device.Id, new JObject { ["command"] = runtime.Paused ? "resume" : "pause" }, out _);
            var progress = runtime.Clock / runtime.TotalDuration;
            var next = GUI.HorizontalSlider(new Rect(controls.x + 16, y + 42, 488, 12), progress, 0f, 1f);
            if (Mathf.Abs(next - progress) > .0001f) ApplyInspectionCommand(device.Device.Id, new JObject { ["command"] = "progress", ["progress"] = next }, out _);
            if (!runtime.LabelsEnabled || runtime.Clock <= 0f) return;
            foreach (var part in runtime.Parts)
            {
                if (InspectionTimeline.PartProgress(runtime.Config, part.Config, part.EnabledIndex, runtime.Clock) <= .02f) continue;
                if (!part.Renderers.Any(renderer => renderer != null && renderer.enabled && !renderer.forceRenderingOff && renderer.gameObject.activeInHierarchy)) continue;
                var anchor = part.WorldBounds.center;
                var basis = runtime.Config.OffsetSpace == "model" ? runtime.ModelRoot : part.Targets.FirstOrDefault()?.Parent ?? runtime.ModelRoot;
                var screen = _camera.WorldToScreenPoint(anchor + basis.TransformVector(InspectionAuthorVector(runtime, part.Config.LabelOffset)));
                if (screen.z <= _camera.nearClipPlane) continue;
                var position = ScreenToDesign(screen);
                var rect = new Rect(position.x - 70, position.y - 14, 140, 28);
                if (rect.x < 0 || rect.y < 0 || rect.xMax > DesignWidth || rect.yMax > DesignHeight) continue;
                if (runtime.Config.Labels.LeaderLines) DrawLine(ScreenToDesign(_camera.WorldToScreenPoint(anchor)), position, new Color(.7f, .85f, 1f, .65f), 1f);
                _inspectionHitRects.Add(rect);
                if (GUI.Button(rect, part.Config.Name, _buttonStyle)) SetInspectionStage(device, InspectionStage.PartDetail, false, part.Config.Id);
            }
        }

        private static string InspectionStageKey(InspectionStage stage)
            => stage == InspectionStage.Xray ? "xray" : stage == InspectionStage.Exploded ? "exploded" : stage == InspectionStage.PartDetail ? "part" : "solid";

        private static string InspectionStageLabel(InspectionStage stage)
            => stage == InspectionStage.Xray ? "设备透视" : stage == InspectionStage.Exploded ? "设备拆解" : stage == InspectionStage.PartDetail ? "部件详情" : "设备运行详情";

        private static InspectionStage ParseInspectionStage(string value)
            => value == "xray" ? InspectionStage.Xray : value == "exploded" ? InspectionStage.Exploded : value == "part" || value == "partDetail" ? InspectionStage.PartDetail : InspectionStage.Solid;
    }
}
