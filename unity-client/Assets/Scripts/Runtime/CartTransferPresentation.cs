using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // The base stays on its rail. Only an explicitly configured upper platform,
    // its physical loading mouth and any estimated cargo turn toward the dock.
    public sealed class CartTransferPresentation : IDisposable
    {
        private readonly Transform _root;
        private Transform _anchor;
        private GameObject _simple;
        private Quaternion _restRotation, _currentRotation, _fromRotation, _targetRotation;
        private Matrix4x4 _restToRoot, _rootToRest;
        private float _elapsed = 1;
        private readonly List<KeyValuePair<Renderer, bool>> _hidden = new List<KeyValuePair<Renderer, bool>>();
        private readonly List<Material> _materials = new List<Material>();
        private readonly List<Transform> _rollers = new List<Transform>();
        public const float TurnSeconds = 1;
        public bool Ready { get; private set; }
        public bool Aligned => Ready && Quaternion.Angle(_currentRotation, _targetRotation) < .1f;
        public Transform CargoParent => Ready ? _anchor : _root;
        public string Reason { get; private set; }
        public static bool IsRotating(DeviceDto device) => device?.InstanceConfigObject["cartTransfer"] is JObject config
            && config.Value<int?>("version") == 1 && config.Value<string>("kind") == "rotating";

        public CartTransferPresentation(Transform root, JObject config, LoadingPortPose mouth)
        {
            _root = root; Reason = "转台未配置";
            if (root == null || mouth == null || config?.Value<string>("kind") != "rotating") return;
            if (config.Value<string>("presentation") == "simple") {
                if (!TryLocalBounds(root, out var bounds)) { Reason = "简模缺少可用的设备尺寸"; return; }
                BuildSimple(bounds, mouth);
            } else if (config.Value<string>("presentation") == "model") {
                var name = config.Value<string>("turntableNodeName");
                var matches = root.GetComponentsInChildren<Transform>(true).Where(node => node != root && !string.IsNullOrEmpty(name) && node.name == name).ToArray();
                if (matches.Length != 1) { Reason = "上转台节点缺失或重名"; return; }
                _anchor = matches[0];
            } else { Reason = "转台显示类型无效"; return; }
            _restRotation = _currentRotation = _fromRotation = _targetRotation = _anchor.localRotation;
            _restToRoot = root.worldToLocalMatrix * _anchor.localToWorldMatrix;
            if (Mathf.Abs(_restToRoot.determinant) < .0000001f) { Reason = "转台坐标无效"; return; }
            _rootToRest = _restToRoot.inverse;
            Ready = true; Reason = "转台示意就绪";
        }
        public void Aim(LoadingPortPose port, Vector3 target)
        {
            if (!Ready || port == null) return;
            // Work in the anchor parent's coordinates, preserving its authored
            // rest pose/pivot and all device/workshop rotations and scales.
            var parent = _anchor.parent;
            var pivot = parent.InverseTransformPoint(_anchor.position);
            var targetDirection = parent.InverseTransformPoint(target) - pivot; targetDirection.y = 0;
            var rootDirection = new Vector3(-(float)port.Direction[0], 0, (float)port.Direction[2]);
            var restDirection = parent.InverseTransformVector(_root.TransformVector(rootDirection)); restDirection.y = 0;
            if (restDirection.sqrMagnitude < .000001f || targetDirection.sqrMagnitude < .000001f) return;
            var desired = Quaternion.AngleAxis(Vector3.SignedAngle(restDirection, targetDirection, Vector3.up), Vector3.up) * _restRotation;
            if (Quaternion.Angle(desired, _targetRotation) < .1f) return;
            _fromRotation = _currentRotation; _targetRotation = desired; _elapsed = 0;
        }
        public void Advance(float delta, bool canTurn, bool conveying = false, bool pickup = false)
        {
            if (!Ready) return;
            if (canTurn && !Aligned) {
                _elapsed = Mathf.Min(TurnSeconds, _elapsed + Mathf.Max(0, delta));
                _currentRotation = Quaternion.Slerp(_fromRotation, _targetRotation, Mathf.SmoothStep(0, 1, _elapsed / TurnSeconds));
            }
            _anchor.localRotation = _currentRotation;
            if (conveying) foreach (var roller in _rollers) roller.Rotate(Vector3.up, Mathf.Max(0, delta) * (pickup ? -180 : 180), Space.Self);
        }
        public bool WorldPort(LoadingPortPose port, out Vector3 point, out Vector3 direction)
        {
            point = direction = Vector3.zero;
            if (!Ready || port == null) return false;
            point = _anchor.TransformPoint(_rootToRest.MultiplyPoint3x4(new Vector3(-(float)port.Position[0], (float)port.Position[1], (float)port.Position[2])));
            direction = _anchor.TransformVector(_rootToRest.MultiplyVector(new Vector3(-(float)port.Direction[0], 0, (float)port.Direction[2]))).normalized;
            return true;
        }
        public Vector3 Seat(Vector3 mouth, Vector3 direction, float height)
        {
            var center = _anchor.position; center.y = mouth.y;
            return mouth - direction * Mathf.Max(height, Vector3.Dot(mouth - center, direction));
        }
        public JObject Describe() => new JObject { ["ready"] = Ready, ["aligned"] = Aligned, ["reason"] = Reason,
            ["angleDegrees"] = Ready ? Quaternion.Angle(_restRotation, _currentRotation) : 0, ["displayOnly"] = true };

        private static bool TryLocalBounds(Transform root, out Bounds bounds)
        {
            bounds = new Bounds(); var found = false;
            foreach (var mesh in root.GetComponentsInChildren<MeshFilter>(true)) {
                if (mesh.sharedMesh == null || mesh.gameObject.layer == 2) continue;
                var b = mesh.sharedMesh.bounds; var matrix = root.worldToLocalMatrix * mesh.transform.localToWorldMatrix;
                for (var i = 0; i < 8; i++) {
                    var p = matrix.MultiplyPoint3x4(b.center + Vector3.Scale(b.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1)));
                    if (!found) { bounds = new Bounds(p, Vector3.zero); found = true; } else bounds.Encapsulate(p);
                }
            }
            return found && bounds.size.sqrMagnitude > .00000001f;
        }
        private Material Material(string name, Color color)
        {
            var material = RuntimeShaderLibrary.CreateLitMaterial(name); material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            _materials.Add(material); return material;
        }
        private Transform Part(PrimitiveType type, string name, Transform parent, Vector3 position, Vector3 size, Material material, Quaternion? rotation = null)
        {
            var part = GameObject.CreatePrimitive(type); part.name = name; part.transform.SetParent(parent, false);
            part.transform.localPosition = position; part.transform.localScale = size; part.transform.localRotation = rotation ?? Quaternion.identity;
            part.GetComponent<Renderer>().sharedMaterial = material;
            var collider = part.GetComponent<Collider>(); if (collider != null) Destroy(collider);
            return part.transform;
        }
        private void BuildSimple(Bounds bounds, LoadingPortPose mouth)
        {
            var point = new Vector3(-(float)mouth.Position[0], (float)mouth.Position[1], (float)mouth.Position[2]);
            var direction = new Vector3(-(float)mouth.Direction[0], 0, (float)mouth.Direction[2]).normalized;
            var center = new Vector3(bounds.center.x, point.y, bounds.center.z);
            var span = Mathf.Max(bounds.size.x, bounds.size.z);
            var length = Mathf.Max(Vector3.Distance(center, point) * 2, span * .65f);
            var width = Mathf.Max(Mathf.Min(bounds.size.x, bounds.size.z) * .8f, span * .3f);
            var depth = Mathf.Max(point.y - bounds.min.y, span * .18f);
            foreach (var renderer in _root.GetComponentsInChildren<Renderer>(true)) {
                if (renderer.gameObject.layer == 2 || renderer is LineRenderer || renderer is ParticleSystemRenderer) continue;
                _hidden.Add(new KeyValuePair<Renderer, bool>(renderer, renderer.enabled)); renderer.enabled = false;
            }
            _simple = new GameObject("__SimpleRotatingCart"); _simple.transform.SetParent(_root, false);
            var body = Material("Simple cart base", new Color(.12f, .2f, .3f));
            var upper = Material("Simple cart turntable", new Color(.08f, .55f, .68f));
            var steel = Material("Simple cart rollers", new Color(.65f, .72f, .78f));
            var accent = Material("Simple cart mouth", new Color(1, .65f, .12f));
            Part(PrimitiveType.Cube, "Rail chassis", _simple.transform, center - Vector3.up * depth * .65f, new Vector3(bounds.size.x * .85f, depth * .25f, bounds.size.z * .85f), body);
            var wheel = Mathf.Min(width, length) * .12f;
            for (var x = -1; x <= 1; x += 2) for (var z = -1; z <= 1; z += 2)
                Part(PrimitiveType.Cylinder, "Rail wheel", _simple.transform, center + new Vector3(x * bounds.size.x * .36f, -depth + wheel, z * bounds.size.z * .36f), new Vector3(wheel * 2, wheel * .35f, wheel * 2), steel, Quaternion.Euler(90, 0, 0));
            Part(PrimitiveType.Cylinder, "Fixed turntable bearing", _simple.transform, center - Vector3.up * depth * .25f, new Vector3(width * .85f, depth * .12f, width * .85f), body);
            _anchor = new GameObject("__SimpleCartUpper").transform; _anchor.SetParent(_simple.transform, false); _anchor.localPosition = center; _anchor.localRotation = Quaternion.LookRotation(direction, Vector3.up);
            var radius = Mathf.Min(width, length) * .035f;
            Part(PrimitiveType.Cube, "Upper rotating deck", _anchor, Vector3.down * radius * 3, new Vector3(width, radius * 2, length), upper);
            for (var i = 0; i < 7; i++) _rollers.Add(Part(PrimitiveType.Cylinder, "Upper roller " + i, _anchor, new Vector3(0, -radius, (i / 6f - .5f) * length * .85f), new Vector3(radius * 2, width * .45f, radius * 2), steel, Quaternion.Euler(0, 0, 90)));
            var mouthLocal = _anchor.InverseTransformPoint(_root.TransformPoint(point));
            Part(PrimitiveType.Cube, "Physical shared loading mouth", _anchor, mouthLocal - Vector3.up * radius, new Vector3(width, radius * 2, radius * 2), accent);
            Part(PrimitiveType.Cube, "Upper direction marker", _anchor, new Vector3(0, radius * .1f, length * .22f), new Vector3(width * .12f, radius * .3f, length * .25f), accent);
        }
        public void Dispose()
        {
            if (_anchor != null && _simple == null) _anchor.localRotation = _restRotation;
            foreach (var entry in _hidden) if (entry.Key != null) entry.Key.enabled = entry.Value;
            if (_simple != null) { _simple.SetActive(false); _simple.transform.SetParent(null, false); Destroy(_simple); }
            foreach (var material in _materials) if (material != null) Destroy(material);
            _hidden.Clear(); _materials.Clear(); _rollers.Clear(); Ready = false;
        }
        private static void Destroy(UnityEngine.Object value) { if (Application.isPlaying) UnityEngine.Object.Destroy(value); else UnityEngine.Object.DestroyImmediate(value); }
    }
}
