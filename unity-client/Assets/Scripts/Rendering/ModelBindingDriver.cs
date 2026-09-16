using System;
using System.Collections.Generic;
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
                var token = ReadBindingValue(deviceData, binding);
                if (token == null || token.Type == JTokenType.Null) continue;
                var action = binding.Action ?? "rotate_speed";
                if (action == "rotate_speed")
                {
                    state.AngularSpeedDegrees = ToFloat(token) * binding.SpeedFactor * Mathf.Rad2Deg;
                }
                else if (action == "rotate_angle")
                {
                    var degrees = Map(ToFloat(token), binding.InputMin, binding.InputMax, binding.OutputMin, binding.OutputMax);
                    state.Target.localRotation = state.BaseRotation * Quaternion.AngleAxis(degrees, Axis(binding.Axis));
                }
                else if (action == "translate")
                {
                    var offset = Map(ToFloat(token), binding.InputMin, binding.InputMax, binding.OutputMin, binding.OutputMax);
                    state.Target.localPosition = state.BasePosition + Axis(binding.Axis) * offset;
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
            foreach (var state in _states)
            {
                if (state.Binding.Action != "rotate_speed" || Mathf.Abs(state.AngularSpeedDegrees) < 0.001f) continue;
                state.Target.Rotate(Axis(state.Binding.Axis), state.AngularSpeedDegrees * Time.deltaTime, Space.Self);
            }
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

        private static float ToFloat(JToken token)
        {
            if (token.Type == JTokenType.Boolean) return token.Value<bool>() ? 1f : 0f;
            return token.Value<float>();
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

        private static JToken ReadBindingValue(JObject deviceData, PartBindingDto binding)
        {
            if (deviceData == null || string.IsNullOrWhiteSpace(binding.SourceKey)) return null;
            var direct = deviceData[binding.SourceGroup]?[binding.SourceKey];
            if (direct != null) return direct;

            var groups = new[] { "analog", "motors", "doors", "gas", "mechanisms", "status" };
            foreach (var group in groups)
            {
                var token = deviceData[group]?[binding.SourceKey];
                if (token != null) return token;
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
