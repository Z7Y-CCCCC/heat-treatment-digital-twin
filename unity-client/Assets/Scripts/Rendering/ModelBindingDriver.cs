using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class ModelBindingDriver : MonoBehaviour
    {
        private sealed class BindingState
        {
            public PartBindingDto Binding;
            public Transform Target;
            public Vector3 BasePosition;
            public Quaternion BaseRotation;
            public float AngularSpeedDegrees;
            public float Offset;
            public float TargetOffset;
            public bool HasPose;
            public bool Suspended;
            public JObject RuntimeBinding;
            public JObject LegacyObservationBinding;
            public MotionSignalState Signal;
        }

        private readonly List<BindingState> _states = new List<BindingState>();
        private MaterialPropertyBlock _propertyBlock;
        private float _lastRealtimeAt = float.NegativeInfinity;
        public float DataTimeoutSeconds { get; set; } = 10f;
        public JObject TransferDiagnostic { get; set; }
        public bool TryGetTransferDrive(string actionId, string nodeName, out Transform node, out Vector3 rest,
            out Vector3 maximumDisplacement, out string reason)
        {
            node = null; rest = maximumDisplacement = Vector3.zero; reason = "送料动作未启用";
            var state = _states.FirstOrDefault(item => item.RuntimeBinding?.Value<string>("actionId") == actionId);
            if (state == null) return false;
            if (state.Binding.Action != "translate" || state.Target?.name != nodeName) { reason = "送料参考节点不属于该动作的位置通道"; return false; }
            if (!state.Signal.Usable || !state.Signal.HasSample) { reason = state.Signal.Reason; return false; }
            node = state.Target;
            var axis = state.Binding.AuthoringSpace && state.Binding.Axis == "x" ? Vector3.left : Axis(state.Binding.Axis);
            rest = state.BasePosition + axis * state.Binding.OutputMin;
            maximumDisplacement = axis * (state.Binding.OutputMax - state.Binding.OutputMin);
            reason = "送料动作数据正常"; return maximumDisplacement.sqrMagnitude > .00000001f;
        }
        public void SuspendInputs(string reason = "采集连接中断")
        {
            foreach (var state in _states) { state.Signal.Suspend(reason); state.Suspended = true; state.AngularSpeedDegrees = 0; }
        }
        public JObject CaptureEndpointDisplayStates()
        {
            var result = new JObject();
            foreach (var state in _states) {
                var snapshot = state.Signal.CaptureDisplayState(state.RuntimeBinding);
                if (snapshot == null) continue;
                snapshot["definition"] = JObject.FromObject(state.Binding);
                var p = state.Target.localPosition; var q = state.Target.localRotation;
                snapshot["actualPosition"] = new JArray(p.x, p.y, p.z); snapshot["actualRotation"] = new JArray(q.x, q.y, q.z, q.w);
                result[state.RuntimeBinding.Value<string>("actionId")] = snapshot;
            }
            return result;
        }
        public void RestoreEndpointDisplayStates(JObject snapshots)
        {
            foreach (var state in _states)
            {
                var snapshot = snapshots?[state.RuntimeBinding?.Value<string>("actionId") ?? ""] as JObject;
                if (snapshot == null || !state.Signal.RestoreDisplayState(state.RuntimeBinding, snapshot)) continue;
                if (state.Binding.Action == "rotate_speed" && JToken.DeepEquals(snapshot["definition"], JObject.FromObject(state.Binding)))
                {
                    var p = snapshot["actualPosition"].Values<float>().ToArray(); var q = snapshot["actualRotation"].Values<float>().ToArray();
                    state.Target.localPosition = new Vector3(p[0], p[1], p[2]); state.Target.localRotation = new Quaternion(q[0], q[1], q[2], q[3]);
                }
                ApplyRuntimeState(state, true);
            }
        }
        public JArray CaptureDiagnosticActions()
        {
            var actions = new JArray();
            foreach (var state in _states)
            {
                if (state.RuntimeBinding == null || state.Target == null) continue;
                var p = state.Target.localPosition; var q = state.Target.localRotation;
                actions.Add(new JObject { ["actionId"] = state.RuntimeBinding["actionId"], ["node"] = state.Target.name,
                    ["position"] = state.Signal.Position, ["target"] = state.Signal.Target, ["usable"] = state.Signal.Usable, ["reason"] = state.Signal.Reason,
                    ["actualPosition"] = new JArray(p.x, p.y, p.z), ["actualRotation"] = new JArray(q.x, q.y, q.z, q.w) });
            }
            return actions;
        }

        public void Configure(IEnumerable<PartBindingDto> bindings, JObject runtimeConfig = null)
        {
            _states.Clear();
            var transforms = GetComponentsInChildren<Transform>(true);
            var pathMap = BuildPathMap(transform);
            var rows = runtimeConfig?["bindings"]?.OfType<JObject>().ToArray() ?? Array.Empty<JObject>();
            foreach (var binding in bindings ?? Array.Empty<PartBindingDto>())
            {
                Transform target = null;
                if (!string.IsNullOrWhiteSpace(binding.NodePath)) pathMap.TryGetValue(binding.NodePath, out target);
                target = target ?? transforms.FirstOrDefault(item => item.name == binding.NodeName);
                if (target == null)
                {
                    Debug.LogWarning($"[ModelBindingDriver] Node not found: {binding.NodePath} / {binding.NodeName}");
                    continue;
                }
                _states.Add(new BindingState
                {
                    Binding = binding,
                    Target = target,
                    BasePosition = target.localPosition,
                    BaseRotation = target.localRotation,
                    RuntimeBinding = rows.FirstOrDefault(row => row.Value<bool?>("enabled") == true && row.Value<string>("actionId") == "part:" + binding.Id),
                    LegacyObservationBinding = string.IsNullOrWhiteSpace(binding.PointId) ? null : new JObject {
                        ["pointId"] = binding.PointId, ["sourceGroup"] = binding.SourceGroup ?? "analog", ["sourceKey"] = binding.SourceKey ?? "" },
                    Signal = new MotionSignalState()
                });
            }
        }

        public void ApplyRealtime(JObject deviceData, double? now = null)
        {
            var receivedAt = now ?? Time.realtimeSinceStartupAsDouble;
            _lastRealtimeAt = (float)receivedAt;
            foreach (var state in _states)
            {
                var binding = state.Binding;
                if (state.RuntimeBinding != null)
                {
                    state.Signal.Receive(deviceData, state.RuntimeBinding, receivedAt, now.HasValue ? (double?)null : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    state.Signal.Step(0, receivedAt, DataTimeoutSeconds * 1000, state.RuntimeBinding);
                    ApplyRuntimeState(state);
                    continue;
                }
                if (deviceData?.Value<bool?>("motionInputOnly") == true) continue;
                var freshAcquisition = state.LegacyObservationBinding != null && (!state.Signal.HasSample || !state.Signal.Usable);
                if (state.LegacyObservationBinding != null)
                {
                    var accepted = state.Signal.ReceiveObservationOnly(deviceData, state.LegacyObservationBinding, receivedAt,
                        now.HasValue ? (double?)null : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    state.Signal.Step(0, receivedAt, DataTimeoutSeconds * 1000, state.LegacyObservationBinding);
                    if (!accepted || !state.Signal.Usable)
                    {
                        if (!state.Signal.Usable) { state.Suspended = true; state.AngularSpeedDegrees = 0; }
                        continue;
                    }
                }
                var token = ReadBindingValue(deviceData, binding, out var group);
                state.Suspended = !IsUsable(deviceData, group, binding.SourceKey)
                    || (!string.IsNullOrEmpty(binding.PointId) && deviceData?["pointMeta"]?[group + "." + binding.SourceKey]?["id"] != null && deviceData["pointMeta"][group + "." + binding.SourceKey].Value<string>("id") != binding.PointId)
                    || token == null || token.Type == JTokenType.Null;
                if (state.Suspended) { state.AngularSpeedDegrees = 0; if (state.LegacyObservationBinding != null) state.Signal.Suspend("部件来源数据无效"); continue; }
                var action = binding.Action ?? "rotate_speed";
                var numeric = action == "rotate_speed" || action == "rotate_angle" || action == "translate";
                var value = 0f;
                if (numeric && !TryFloat(token, out value))
                { state.Suspended = true; state.AngularSpeedDegrees = 0; if (state.LegacyObservationBinding != null) state.Signal.Suspend("部件来源数据类型无效"); continue; }
                if (action == "rotate_speed")
                {
                    SetAngularSpeed(state, value * binding.SpeedFactor * Mathf.Rad2Deg);
                }
                else if (action == "rotate_angle" || action == "translate")
                {
                    state.TargetOffset = Map(value, binding.InputMin, binding.InputMax, binding.OutputMin, binding.OutputMax);
                    // First acquisition establishes the observed pose, without replaying a fictitious opening.
                    if (!state.HasPose || binding.TransitionDuration <= 0 || freshAcquisition)
                    { state.Offset = state.TargetOffset; ApplyPose(state); }
                    state.HasPose = true;
                }
                else if (action == "visibility")
                {
                    if (binding.AuthoringSpace && !TryFloat(token, out value)) { state.Suspended = true; if (state.LegacyObservationBinding != null) state.Signal.Suspend("部件来源数据类型无效"); continue; }
                    var visible = binding.AuthoringSpace ? Map(value, binding.InputMin, binding.InputMax, 0, 1) > .5f : ToBool(token);
                    state.Target.gameObject.SetActive(binding.Invert ? !visible : visible);
                }
                else if (action == "color")
                {
                    if (binding.AuthoringSpace && !TryFloat(token, out value)) { state.Suspended = true; if (state.LegacyObservationBinding != null) state.Signal.Suspend("部件来源数据类型无效"); continue; }
                    var active = binding.AuthoringSpace ? Map(value, binding.InputMin, binding.InputMax, 0, 1) > .5f : ToBool(token);
                    ApplyColor(state.Target, (active != binding.Invert) ? binding.OnColor : binding.OffColor, binding.AuthoringSpace);
                }
            }
        }

        public void ApplyMotionInputs(JObject deviceData, double? now = null)
        {
            var receivedAt = now ?? Time.realtimeSinceStartupAsDouble;
            foreach (var state in _states)
            {
                if (!MotionSignalState.IsCatalogBinding(state.RuntimeBinding)) continue;
                state.Signal.Receive(deviceData, state.RuntimeBinding, receivedAt, now.HasValue ? (double?)null : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                state.Signal.Step(0, receivedAt, DataTimeoutSeconds * 1000, state.RuntimeBinding);
                ApplyRuntimeState(state);
            }
        }

        private void Update()
        {
            if (Time.realtimeSinceStartup - _lastRealtimeAt > DataTimeoutSeconds) foreach (var state in _states) { state.Suspended = true; state.AngularSpeedDegrees = 0; }
            AdvanceMotion(Time.unscaledDeltaTime);
        }

        public void AdvanceMotion(float deltaTime, double? now = null)
        {
            if (float.IsNaN(deltaTime) || float.IsInfinity(deltaTime) || deltaTime <= 0) return;
            foreach (var state in _states)
            {
                if (state.RuntimeBinding != null)
                {
                    state.Signal.Step(deltaTime, now ?? Time.realtimeSinceStartupAsDouble, DataTimeoutSeconds * 1000, state.RuntimeBinding);
                    ApplyRuntimeState(state);
                    if (!state.Suspended && state.Binding.Action == "rotate_speed") RotateAtSpeed(state, deltaTime);
                    continue;
                }
                if (state.LegacyObservationBinding != null)
                {
                    state.Signal.Step(0, now ?? Time.realtimeSinceStartupAsDouble, DataTimeoutSeconds * 1000, state.LegacyObservationBinding);
                    if (!state.Signal.Usable) { state.Suspended = true; state.AngularSpeedDegrees = 0; }
                }
                if (state.Suspended || state.Target == null) continue;
                if ((state.Binding.Action ?? "rotate_speed") == "rotate_speed")
                    RotateAtSpeed(state, deltaTime);
                else if (state.HasPose && state.Binding.TransitionDuration > 0)
                {
                    var range = Mathf.Abs(state.Binding.OutputMax - state.Binding.OutputMin);
                    var duration = Mathf.Clamp(state.Binding.TransitionDuration, .001f, 60f);
                    state.Offset = Mathf.MoveTowards(state.Offset, state.TargetOffset, range / duration * deltaTime);
                    ApplyPose(state);
                }
            }
        }

        private void ApplyRuntimeState(BindingState state, bool restoreFrozenPose = false)
        {
            state.Suspended = !state.Signal.Usable || !state.Signal.HasSample || state.Target == null;
            if (state.Target == null) return;
            if (state.Suspended && !restoreFrozenPose) { state.AngularSpeedDegrees = 0; return; }
            var binding = state.Binding; var action = binding.Action ?? "rotate_speed";
            if (action == "rotate_speed")
            {
                var condition = state.RuntimeBinding["trigger"]?.Value<string>("mode") == "condition";
                var direction = !condition && state.RuntimeBinding.Value<bool?>("invert") == true ? -1 : 1;
                SetAngularSpeed(state, (float)state.Signal.NumericValue * binding.SpeedFactor * Mathf.Rad2Deg * (state.RuntimeBinding.Value<float?>("speed") ?? 1) * direction);
            }
            else if (action == "translate" || action == "rotate_angle")
            {
                state.Offset = binding.OutputMin + (binding.OutputMax - binding.OutputMin) * (float)state.Signal.Position;
                state.HasPose = true; ApplyPose(state);
            }
            else if (action == "visibility") state.Target.gameObject.SetActive(state.Signal.Position > .5);
            else if (action == "color") ApplyColor(state.Target, state.Signal.Position > .5 ? binding.OnColor : binding.OffColor, binding.AuthoringSpace);
        }

        private static void SetAngularSpeed(BindingState state, float speed)
        {
            if (!float.IsNaN(speed) && !float.IsInfinity(speed)) { state.AngularSpeedDegrees = speed; return; }
            state.AngularSpeedDegrees = 0; state.Suspended = true;
            state.Signal.Suspend("部件转速超出可显示范围");
        }

        private static void RotateAtSpeed(BindingState state, float deltaTime)
        {
            var angle = state.AngularSpeedDegrees * deltaTime;
            if (float.IsNaN(angle) || float.IsInfinity(angle))
            {
                state.AngularSpeedDegrees = 0; state.Suspended = true;
                state.Signal.Suspend("部件旋转步长超出可显示范围"); return;
            }
            state.Target.Rotate(RotationAxis(state.Binding), angle, Space.Self);
        }

        private static void ApplyPose(BindingState state)
        {
            if (state.Binding.Action == "translate")
                state.Target.localPosition = state.BasePosition + (state.Binding.AuthoringSpace && state.Binding.Axis == "x" ? Vector3.left : Axis(state.Binding.Axis)) * state.Offset;
            else
                state.Target.localRotation = state.BaseRotation * Quaternion.AngleAxis(state.Offset, RotationAxis(state.Binding));
        }
        private static Vector3 RotationAxis(PartBindingDto binding) => binding.AuthoringSpace && binding.Axis != "x" ? -Axis(binding.Axis) : Axis(binding.Axis);

        private void ApplyColor(Transform target, string htmlColor, bool authoringSpace)
        {
            if (!ColorUtility.TryParseHtmlString(htmlColor, out var color)) return;
            if (authoringSpace && QualitySettings.activeColorSpace == ColorSpace.Linear) color = color.linear;
            _propertyBlock ??= new MaterialPropertyBlock();
            foreach (var renderer in target.GetComponentsInChildren<Renderer>(true))
            {
                renderer.GetPropertyBlock(_propertyBlock);
                _propertyBlock.SetColor("_BaseColor", color);
                _propertyBlock.SetColor("_Color", color);
                _propertyBlock.SetColor("baseColorFactor", color);
                renderer.SetPropertyBlock(_propertyBlock);
            }
        }

        private static float Map(float value, float inputMin, float inputMax, float outputMin, float outputMax)
        {
            var t = Mathf.Abs(inputMax - inputMin) < 0.0001f
                ? 0f
                : Mathf.Clamp01((value - inputMin) / (inputMax - inputMin));
            return Mathf.Lerp(outputMin, outputMax, t);
        }

        private static bool TryFloat(JToken token, out float value)
        {
            if (token.Type == JTokenType.Boolean) { value = token.Value<bool>() ? 1f : 0f; return true; }
            if (token.Type != JTokenType.String && token.Type != JTokenType.Integer && token.Type != JTokenType.Float)
            { value = 0; return false; }
            return float.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value)
                && !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private static bool ToBool(JToken token)
        {
            if (token.Type == JTokenType.Boolean) return token.Value<bool>();
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) return Math.Abs(token.Value<double>()) > double.Epsilon;
            var value = token.Value<string>()?.ToLowerInvariant();
            return value == "1" || value == "true" || value == "on" || value == "open" || value == "running" || value == "yes";
        }

        private static Vector3 Axis(string axis)
        {
            return axis == "x" ? Vector3.right : axis == "z" ? Vector3.forward : Vector3.up;
        }

        private static bool IsUsable(JObject data, string group, string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return false;
            bool Invalid(JToken token) => token != null && token.Type == JTokenType.String
                && !string.Equals(token.Value<string>(), "good", StringComparison.OrdinalIgnoreCase);
            return data != null && !string.Equals(data["status"]?["online"]?.ToString(), "false", StringComparison.OrdinalIgnoreCase)
                && !Invalid(data["status"]?["quality"])
                && !Invalid(data["quality"] is JObject quality ? quality["overall"] : data["quality"])
                && !Invalid(((data["quality"] as JObject)?[group] as JObject)?[key]);
        }

        private static JToken ReadBindingValue(JObject deviceData, PartBindingDto binding, out string sourceGroup)
        {
            sourceGroup = binding.SourceGroup ?? "analog";
            if (deviceData == null || string.IsNullOrWhiteSpace(binding.SourceKey)) return null;
            var direct = deviceData[sourceGroup]?[binding.SourceKey];
            if (direct != null) return direct;
            if (!string.IsNullOrEmpty(binding.PointId)) return null; // Explicit assignment cannot fall through to another group.

            var groups = new[] { "analog", "motors", "doors", "gas", "mechanisms", "status" };
            foreach (var group in groups)
            {
                var token = deviceData[group]?[binding.SourceKey];
                if (token != null) { sourceGroup = group; return token; }
            }
            return null;
        }

        private static Dictionary<string, Transform> BuildPathMap(Transform root)
        {
            var result = new Dictionary<string, Transform>();
            AddChildren(root, string.Empty, result);
            return result;
        }

        private static void AddChildren(Transform parent, string parentPath, IDictionary<string, Transform> result)
        {
            for (var index = 0; index < parent.childCount; index += 1)
            {
                var child = parent.GetChild(index);
                var segment = $"{child.name.Replace("/", "_")}#{index}";
                var path = string.IsNullOrEmpty(parentPath) ? segment : $"{parentPath}/{segment}";
                result[path] = child;
                AddChildren(child, path, result);
            }
        }
    }
}
