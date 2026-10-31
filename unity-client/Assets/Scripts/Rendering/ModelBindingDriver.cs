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
        }

        private readonly List<BindingState> _states = new List<BindingState>();
        private MaterialPropertyBlock _propertyBlock;

        public void Configure(IEnumerable<PartBindingDto> bindings)
        {
            _states.Clear();
            var transforms = GetComponentsInChildren<Transform>(true);
            var pathMap = BuildPathMap(transform);
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
                    BaseRotation = target.localRotation
                });
            }
        }

        public void ApplyRealtime(JObject deviceData)
        {
            foreach (var state in _states)
            {
                var binding = state.Binding;
                var token = ReadBindingValue(deviceData, binding, out var group);
                state.Suspended = !IsUsable(deviceData, group, binding.SourceKey)
                    || token == null || token.Type == JTokenType.Null;
                if (state.Suspended) { state.AngularSpeedDegrees = 0; continue; }
                var action = binding.Action ?? "rotate_speed";
                var numeric = action == "rotate_speed" || action == "rotate_angle" || action == "translate";
                var value = 0f;
                if (numeric && !TryFloat(token, out value))
                { state.Suspended = true; state.AngularSpeedDegrees = 0; continue; }
                if (action == "rotate_speed")
                {
                    state.AngularSpeedDegrees = value * binding.SpeedFactor * Mathf.Rad2Deg;
                }
                else if (action == "rotate_angle" || action == "translate")
                {
                    state.TargetOffset = Map(value, binding.InputMin, binding.InputMax, binding.OutputMin, binding.OutputMax);
                    // First acquisition establishes the observed pose, without replaying a fictitious opening.
                    if (!state.HasPose || binding.TransitionDuration <= 0)
                    { state.Offset = state.TargetOffset; ApplyPose(state); }
                    state.HasPose = true;
                }
                else if (action == "visibility")
                {
                    var visible = ToBool(token);
                    state.Target.gameObject.SetActive(binding.Invert ? !visible : visible);
                }
                else if (action == "color")
                {
                    ApplyColor(state.Target, ToBool(token) ? binding.OnColor : binding.OffColor);
                }
            }
        }

        private void Update()
        {
            AdvanceMotion(Time.deltaTime);
        }

        public void AdvanceMotion(float deltaTime)
        {
            if (float.IsNaN(deltaTime) || float.IsInfinity(deltaTime) || deltaTime <= 0) return;
            foreach (var state in _states)
            {
                if (state.Suspended || state.Target == null) continue;
                if ((state.Binding.Action ?? "rotate_speed") == "rotate_speed")
                    state.Target.Rotate(Axis(state.Binding.Axis), state.AngularSpeedDegrees * deltaTime, Space.Self);
                else if (state.HasPose && state.Binding.TransitionDuration > 0)
                {
                    var range = Mathf.Abs(state.Binding.OutputMax - state.Binding.OutputMin);
                    var duration = Mathf.Clamp(state.Binding.TransitionDuration, .001f, 60f);
                    state.Offset = Mathf.MoveTowards(state.Offset, state.TargetOffset, range / duration * deltaTime);
                    ApplyPose(state);
                }
            }
        }

        private static void ApplyPose(BindingState state)
        {
            if (state.Binding.Action == "translate")
                state.Target.localPosition = state.BasePosition + Axis(state.Binding.Axis) * state.Offset;
            else
                state.Target.localRotation = state.BaseRotation * Quaternion.AngleAxis(state.Offset, Axis(state.Binding.Axis));
        }

        private void ApplyColor(Transform target, string htmlColor)
        {
            if (!ColorUtility.TryParseHtmlString(htmlColor, out var color)) return;
            _propertyBlock ??= new MaterialPropertyBlock();
            foreach (var renderer in target.GetComponentsInChildren<Renderer>(true))
            {
                renderer.GetPropertyBlock(_propertyBlock);
                _propertyBlock.SetColor("_BaseColor", color);
                _propertyBlock.SetColor("_Color", color);
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
