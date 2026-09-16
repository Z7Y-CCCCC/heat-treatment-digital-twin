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
            public bool SurfaceApplied;
            public bool FrostedApplied;
            public InspectionPartState Part;
            public InspectionTargetState Target;
            public InspectionMeshSurface Surface;
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
            public float NextContextAt;
            public float NextHoverAt;
            public Bounds ShellLocalBounds;
            public bool TransitionActive => !Paused && (Mathf.Abs(Clock - TargetClock) > .0001f || Mathf.Abs(XrayAmount - XrayTarget) > .0001f);
        }

        private readonly List<Rect> _inspectionHitRects = new List<Rect>();

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
            if (!new[] { "stage", "select", "clear", "progress", "isolate", "labels", "pause", "resume" }.Contains(action))
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
                if (claimed.Any(item => item.node == shell || item.node.IsChildOf(shell) || shell.IsChildOf(item.node)))
                {
                    AddInspectionIssue(runtime, "shell_part_overlap", "", $"外壳节点 {shell.name} 与部件节点重复或存在父子包含关系；已跳过该外壳，避免内部组件被误隐藏。请在后台改选实际外壳网格/节点。", true);
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
                    Part = owner.part,
                    Target = owner.part?.Targets.FirstOrDefault(target => target.Target == owner.node),
                    Surface = new InspectionMeshSurface(renderer)
                });
            }
            return runtime;
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
            runtime.SelectedPart = stage == InspectionStage.PartDetail
                ? runtime.Parts.FirstOrDefault(part => string.Equals(part.Config.Id, partId, StringComparison.Ordinal)) : null;
            if (stage == InspectionStage.PartDetail && runtime.SelectedPart == null) stage = InspectionStage.Exploded;
            runtime.Stage = stage;
            runtime.Isolated = false;
            runtime.HoveredPart = null;
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
                    target.OffsetRoot.SetLocalPositionAndRotation(position, rotation);
                }
                part.WorldBounds = InspectionBounds(part.Renderers, runtime.ModelRoot.position);
            }
            var shellProgress = InspectionTimeline.ShellProgress(runtime.Config, runtime.Clock);
            foreach (var state in runtime.Renderers)
            {
                if (state.Renderer == null) continue;
                var isolatedAway = runtime.Isolated && runtime.SelectedPart != null && state.Part != runtime.SelectedPart;
                state.Renderer.forceRenderingOff = state.OriginalForceOff || isolatedAway || (state.IsShell && shellProgress >= .99999f);
                if (state.Part != null && !state.IsShell) ApplyInspectionFocusMaterials(runtime, state);
                if (!state.IsShell) continue;
                ApplyInspectionShell(runtime, state, shellProgress);
            }
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

        private static void ApplyInspectionShell(DeviceInspectionRuntime runtime, InspectionRendererState state, float progress)
        {
            var needsSurface = progress > 0f || runtime.XrayAmount > 0f;
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
            var alpha = Mathf.Lerp(1f, shell.Opacity, InspectionTimeline.Ease(runtime.XrayAmount, runtime.Config.Easing));
            var clipProgress = shell.Transition == "clip" ? progress : 0f;
            if (shell.Transition == "fade") alpha *= 1f - progress;
            var axis = shell.Axis == "x" ? Vector3.right : shell.Axis == "z" ? Vector3.forward : Vector3.up;
            var minimum = Vector3.Dot(runtime.ShellLocalBounds.min, axis);
            var maximum = Vector3.Dot(runtime.ShellLocalBounds.max, axis);
            foreach (var material in state.RuntimeMaterials)
            {
                if (material == null) continue;
                material.SetMatrix("_InspectionWorldToModel", runtime.ModelRoot.worldToLocalMatrix);
                material.SetVector("_ClipAxis", axis);
                material.SetVector("_ClipRange", new Vector4(minimum, maximum, InspectionShellDirection(runtime), clipProgress));
                material.SetFloat("_Opacity", alpha);
                material.SetFloat("_Wireframe", shell.Wireframe && runtime.XrayAmount > .5f ? 1f : 0f);
                material.SetFloat("_ZWrite", alpha >= .999f ? 1f : 0f);
                material.renderQueue = alpha >= .999f ? (int)RenderQueue.Geometry + 1 : (int)RenderQueue.Transparent;
            }
        }

        private static Material CreateInspectionShellMaterial(Material original, Shader shader)
        {
            if (original == null) return null;
            var material = new Material(shader) { name = $"{original.name} / inspection", hideFlags = HideFlags.DontSave };
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
            runtime.Paused = runtime.Isolated = false;
            runtime.SelectedPart = runtime.HoveredPart = null;
            runtime.Stage = InspectionStage.Solid;
            foreach (var state in runtime.Renderers)
            {
                if (state.Renderer == null) continue;
                if (state.SurfaceApplied || state.FrostedApplied) state.Renderer.sharedMaterials = state.OriginalMaterials;
                state.Renderer.forceRenderingOff = state.OriginalForceOff;
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
                    target.OffsetRoot.SetLocalPositionAndRotation(Vector3.zero, Quaternion.identity);
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
            InspectionPartState closest = null;
            var distance = float.PositiveInfinity;
            var reveal = InspectionTimeline.ShellProgress(runtime.Config, runtime.Clock);
            foreach (var state in runtime.Renderers)
            {
                if (!state.Surface.IsVisible) continue;
                bool AcceptShell(Vector3 world)
                {
                    if (!state.IsShell || runtime.Config.Shell.Transition != "clip" || reveal <= 0f) return true;
                    var local = runtime.ModelRoot.InverseTransformPoint(world);
                    var axis = runtime.Config.Shell.Axis == "x" ? 0 : runtime.Config.Shell.Axis == "z" ? 2 : 1;
                    var normalized = Mathf.InverseLerp(runtime.ShellLocalBounds.min[axis], runtime.ShellLocalBounds.max[axis], local[axis]);
                    return (InspectionShellDirection(runtime) > 0 ? normalized : 1f - normalized) >= reveal;
                }
                if (!state.Surface.Raycast(ray, out var hit, AcceptShell) || hit >= distance) continue;
                distance = hit;
                closest = state.Part; // An unselectable visible mesh correctly occludes a part behind it.
            }
            return closest;
        }

        private void SelectInspectionTarget(Ray ray)
        {
            var runtime = _selected?.Inspection;
            if (runtime == null || !runtime.Valid || !runtime.Config.Enabled) return;
            if (runtime.Stage == InspectionStage.Solid || runtime.Stage == InspectionStage.Xray)
            {
                if (runtime.Renderers.Any(state => state.Surface.Raycast(ray, out _)))
                    SetInspectionStage(_selected, runtime.Stage == InspectionStage.Solid ? InspectionStage.Xray : InspectionStage.Exploded);
                return;
            }
            var closest = PickInspectionPart(runtime, ray);
            if (closest != null) SetInspectionStage(_selected, InspectionStage.PartDetail, false, closest.Config.Id);
        }

        private void UpdateInspectionHover()
        {
            var runtime = _selected?.Inspection;
            if (_mode != DashboardMode.Detail || runtime == null || _camera == null || !runtime.Valid) return;
            if (Time.unscaledTime < runtime.NextHoverAt) return;
            runtime.NextHoverAt = Time.unscaledTime + .05f;
            var pointer = Input.mousePosition;
            var blocked = (!_webOverlayActive && IsPointerOverDashboard(ScreenToDesign(pointer)))
                || (!_webOverlayActive && !Application.isFocused) || pointer.x < 0 || pointer.y < 0 || pointer.x > Screen.width || pointer.y > Screen.height;
            runtime.HoveredPart = blocked || runtime.Stage == InspectionStage.Solid || runtime.Stage == InspectionStage.Xray
                ? null : PickInspectionPart(runtime, _camera.ScreenPointToRay(pointer));
        }

        private void LateUpdate()
        {
            var runtime = _selected?.Inspection;
            if (_mode != DashboardMode.Detail || runtime == null) return;
            if (Time.unscaledTime >= runtime.NextContextAt) PublishInspectionContext(_selected);
        }

        private JObject InspectionProjection(Vector3 point, bool shown)
        {
            var viewport = _camera != null ? _camera.WorldToViewportPoint(point) : new Vector3(0f, 0f, -1f);
            var finite = float.IsFinite(viewport.x) && float.IsFinite(viewport.y) && float.IsFinite(viewport.z);
            return new JObject
            {
                ["x"] = finite ? viewport.x : 0f,
                ["y"] = finite ? 1f - viewport.y : 0f,
                ["visible"] = shown && finite && viewport.z > (_camera?.nearClipPlane ?? .01f)
                    && viewport.x >= 0f && viewport.x <= 1f && viewport.y >= 0f && viewport.y <= 1f
            };
        }

        private void PublishInspectionContext(DeviceView device)
        {
            if (device?.Inspection == null || _selected != device || _mode != DashboardMode.Detail) return;
            var runtime = device.Inspection;
            runtime.NextContextAt = Time.unscaledTime + .1f;
            var selected = runtime.SelectedPart?.Config;
            var parts = new JArray();
            foreach (var part in runtime.Parts)
            {
                var anchor = InspectionBounds(part.Renderers, runtime.ModelRoot.position).center;
                var labelOffset = InspectionAuthorVector(runtime, part.Config.LabelOffset);
                var labelBasis = runtime.Config.OffsetSpace == "model" ? runtime.ModelRoot : part.Targets.FirstOrDefault()?.Parent ?? runtime.ModelRoot;
                var shown = runtime.Config.Enabled && runtime.Valid && runtime.LabelsEnabled
                    && InspectionTimeline.PartProgress(runtime.Config, part.Config, part.EnabledIndex, runtime.Clock) > .02f
                    && part.Renderers.Any(renderer => renderer != null && renderer.enabled && !renderer.forceRenderingOff && renderer.gameObject.activeInHierarchy);
                parts.Add(new JObject
                {
                    ["id"] = part.Config.Id, ["name"] = part.Config.Name, ["group"] = part.Config.Group, ["description"] = part.Config.Description,
                    ["pointIds"] = new JArray(part.Config.PointIds), ["pointKeys"] = new JArray(part.Config.PointKeys),
                    ["selected"] = part == runtime.SelectedPart,
                    ["anchor"] = InspectionProjection(anchor, shown), ["label"] = InspectionProjection(anchor + labelBasis.TransformVector(labelOffset), shown)
                });
            }
            var progressing = Mathf.Abs(runtime.Clock - runtime.TargetClock) > .0001f;
            var pending = progressing || Mathf.Abs(runtime.XrayAmount - runtime.XrayTarget) > .0001f;
            var phase = runtime.Paused && pending ? "paused" : !runtime.TransitionActive ? "idle"
                : runtime.Clock <= runtime.Config.ShellDuration && progressing ? "shell"
                : runtime.TargetClock >= runtime.Clock && progressing ? "exploding" : progressing ? "assembling" : "xray";
            InspectionContextChanged?.Invoke(new JObject
            {
                ["viewId"] = _activeViewId ?? string.Empty, ["viewMode"] = "device", ["deviceId"] = device.Device?.Id ?? string.Empty,
                ["inspectionEnabled"] = runtime.Config.Enabled,
                ["inspectionStage"] = InspectionStageKey(runtime.Stage),
                ["inspectionProgress"] = Mathf.Clamp01(runtime.Clock / runtime.TotalDuration),
                ["inspectionAnimating"] = runtime.TransitionActive, ["inspectionPhase"] = phase,
                ["inspectionIsolated"] = runtime.Isolated, ["inspectionLabelsEnabled"] = runtime.LabelsEnabled,
                ["inspectionLeaderLines"] = runtime.Config.Labels.LeaderLines, ["inspectionHoveredPartId"] = runtime.HoveredPart?.Config.Id ?? string.Empty,
                ["inspectionIssues"] = runtime.Issues.DeepClone(), ["inspectionParts"] = parts,
                ["partId"] = selected?.Id ?? string.Empty, ["partName"] = selected?.Name ?? string.Empty,
                ["partDescription"] = selected?.Description ?? string.Empty, ["partPointIds"] = new JArray(selected?.PointIds ?? new List<string>()),
                ["partPointKeys"] = new JArray(selected?.PointKeys ?? new List<string>()), ["partDetailViewId"] = selected?.DetailViewId ?? string.Empty
            });
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
