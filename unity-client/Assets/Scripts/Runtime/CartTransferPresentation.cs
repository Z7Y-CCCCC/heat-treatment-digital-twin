using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
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
        private Quaternion _restRotation, _currentRotation, _fromRotation, _targetRotation;
        private Matrix4x4 _restToRoot, _rootToRest;
        private float _elapsed = 1;
        public const float TurnSeconds = 1;
        public bool Ready { get; private set; }
        public bool Aligned => Ready && Quaternion.Angle(_currentRotation, _targetRotation) < .1f;
        public Transform CargoParent => Ready ? _anchor : _root;
        public string Reason { get; private set; }
        public static bool IsRotating(DeviceDto device) => device?.InstanceConfigObject["cartTransfer"] is JObject config
            && config.Value<int?>("version") == 1 && config.Value<string>("kind") == "rotating"
            && config.Value<string>("presentation") == "model";

        public CartTransferPresentation(Transform root, JObject config, LoadingPortPose mouth)
        {
            _root = root; Reason = "转台未配置";
            if (root == null || mouth == null || config?.Value<string>("kind") != "rotating") return;
            // A legacy simple flag cannot hide or replace the selected GLB.
            if (config.Value<string>("presentation") != "model") { Reason = "旧简模覆盖已停用，请在模型库选择小车模型"; return; }
            {
                var name = config.Value<string>("turntableNodeName");
                var matches = root.GetComponentsInChildren<Transform>(true).Where(node => node != root && !string.IsNullOrEmpty(name) && node.name == name).ToArray();
                if (matches.Length != 1) { Reason = "上转台节点缺失或重名"; return; }
                _anchor = matches[0];
            }
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
        }
        public bool WorldPort(LoadingPortPose port, out Vector3 point, out Vector3 direction)
        {
            point = direction = Vector3.zero;
            if (!Ready || port == null) return false;
            point = _anchor.TransformPoint(_rootToRest.MultiplyPoint3x4(new Vector3(-(float)port.Position[0], (float)port.Position[1], (float)port.Position[2])));
            direction = _anchor.TransformVector(_rootToRest.MultiplyVector(new Vector3(-(float)port.Direction[0], 0, (float)port.Direction[2]))).normalized;
            return true;
        }
        // Predict the physical mouth after turning, without moving the chassis,
        // rotating the live platform or changing any authored loading datum.
        public Vector3 AlignedPortOffset(LoadingPortPose port, Vector3 worldDirection)
        {
            var parent = _anchor.parent;
            var desiredDirection = parent.InverseTransformVector(worldDirection); desiredDirection.y = 0;
            var restDirection = parent.InverseTransformVector(_root.TransformVector(new Vector3(-(float)port.Direction[0], 0, (float)port.Direction[2]))); restDirection.y = 0;
            var rotation = Quaternion.AngleAxis(Vector3.SignedAngle(restDirection, desiredDirection, Vector3.up), Vector3.up) * _restRotation;
            var local = _rootToRest.MultiplyPoint3x4(new Vector3(-(float)port.Position[0], (float)port.Position[1], (float)port.Position[2]));
            return parent.TransformPoint(_anchor.localPosition + rotation * Vector3.Scale(_anchor.localScale, local)) - _root.position;
        }
        public Vector3 Seat(Vector3 mouth, Vector3 direction, float height)
        {
            var center = _anchor.position; center.y = mouth.y;
            return mouth - direction * Mathf.Max(height, Vector3.Dot(mouth - center, direction));
        }
        public JObject Describe() => new JObject { ["ready"] = Ready, ["aligned"] = Aligned, ["reason"] = Reason,
            ["angleDegrees"] = Ready ? Quaternion.Angle(_restRotation, _currentRotation) : 0, ["displayOnly"] = true };

        public void Dispose()
        {
            if (Ready && _anchor != null) _anchor.localRotation = _restRotation;
            Ready = false;
        }
    }
}
