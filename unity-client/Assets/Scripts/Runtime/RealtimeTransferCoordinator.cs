using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    [DefaultExecutionOrder(600)]
    public sealed class RealtimeTransferCoordinator : MonoBehaviour
    {
        private sealed class Link
        {
            public DeviceDto Device;
            public JObject Config, Instance, PresenceBinding;
            public readonly MotionSignalState Presence = new MotionSignalState();
            public GameObject Payload;
            public Material Material;
            public double StaleMs, NextDiagnostic;
            public bool Diagnostics;
            public double DiagnosticInterval;
            public string LastReason;
            public string LastPresenceReason, PresenceDisplayReason;
            public string TargetMode, FixedTargetId, ActionId, DriveNodeName;
            public bool MovementEnabled, SourceInlet, TargetInlet, PortsValid;
            public bool SourcePortValid, TargetPortValid, LastSourceVisible, LastHandoffEligible;
            public float SceneUnitsPerMeter;
            public string SceneUnitsReason;
            public Vector3 MaterialSizeMetres;
            public double HeightTolerance, LateralTolerance, AngleTolerance;
            public StationTarget[] StationTargets = Array.Empty<StationTarget>();
            public readonly double[] SourceMetres = new double[3], SourceDirection = new double[3], TargetMetres = new double[3], TargetDirection = new double[3], MaximumDriveMetres = new double[3];
            public readonly TransferReachResult Reach = new TransferReachResult();
        }
        private sealed class StationTarget { public double Value; public string DeviceId; }
        private sealed class Port { public LoadingPortPose Pose; public string Reason; }
        private readonly Dictionary<string, Link> _links = new Dictionary<string, Link>();
        private readonly Dictionary<string, Port> _inletPorts = new Dictionary<string, Port>();
        private readonly Dictionary<string, Port> _outletPorts = new Dictionary<string, Port>();
        private readonly Dictionary<string, DeviceDto> _devices = new Dictionary<string, DeviceDto>();
        private readonly HashSet<string> _movingDevices = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, JObject> _lineLayouts = new Dictionary<string, JObject>(StringComparer.Ordinal);
        private IReadOnlyDictionary<string, Transform> _roots;
        private IReadOnlyDictionary<string, MobileDeviceMotion> _motions;
        private readonly BidirectionalTransferRuntime _bidirectional=new BidirectionalTransferRuntime();
        private readonly SimpleMaterialTransferRuntime _simpleMaterial = new SimpleMaterialTransferRuntime();

        public void Configure(IEnumerable<DeviceDto> devices, IEnumerable<ModelAssetDto> models,
            IReadOnlyDictionary<string, Transform> roots, IReadOnlyDictionary<string, MobileDeviceMotion> motions, IEnumerable<LineDto> lines = null)
        {
            _roots = roots; _motions = motions; _devices.Clear(); _movingDevices.Clear(); _inletPorts.Clear(); _outletPorts.Clear();
            var deviceRows = (devices ?? Enumerable.Empty<DeviceDto>()).ToArray();
            _simpleMaterial.Configure(deviceRows, models, roots, motions, transform);
            _bidirectional.Configure(deviceRows,models,roots,motions,lines);
            _lineLayouts.Clear();
            foreach (var line in lines ?? Enumerable.Empty<LineDto>())
                if (line != null && !string.IsNullOrEmpty(line.Id)) _lineLayouts[line.Id] = line.LayoutObject;
            var modelMap = (models ?? Enumerable.Empty<ModelAssetDto>()).Where(model => model != null && !string.IsNullOrEmpty(model.Id)).GroupBy(model => model.Id).ToDictionary(group => group.Key, group => group.First());
            var metadataMap = modelMap.ToDictionary(item => item.Key, item => item.Value.MetadataObject);
            var retained = new HashSet<string>();
            foreach (var device in devices ?? Enumerable.Empty<DeviceDto>())
            {
                if (device == null || string.IsNullOrWhiteSpace(device.Id)) continue;
                _devices[device.Id] = device;
                if (device.InstanceConfigObject["movement"]?.Value<bool?>("enabled") == true) _movingDevices.Add(device.Id);
                foreach (var kind in new[] { "inlet", "outlet" })
                {
                    metadataMap.TryGetValue(device.ModelType ?? "", out var metadata);
                    LoadingPortPolicy.TryResolve(metadata, device.InstanceConfigObject, kind, out var pose, out var reason);
                    (kind == "inlet" ? _inletPorts : _outletPorts)[device.Id] = new Port { Pose = pose, Reason = reason };
                }
                var animation = device.InstanceConfigObject["animationBindings"] as JObject;
                var config = animation?["transferLink"] as JObject;
                if (SimpleMaterialTransferRuntime.UsesSimpleTransfer(device)) continue;
                if (config?.Value<bool?>("enabled") != true) continue;
                if(config["cycle"]?.Value<bool?>("enabled")==true)continue;
                retained.Add(device.Id);
                if (_links.TryGetValue(device.Id, out var prior) && JToken.DeepEquals(prior.Config, config))
                {
                    prior.Device = device; prior.Instance = device.InstanceConfigObject; prior.StaleMs = animation?.Value<double?>("staleMs") ?? 5000;
                    prior.Diagnostics = animation?.Value<bool?>("diagnosticLogging") == true;
                    prior.DiagnosticInterval = Math.Max(1, Math.Min(60, animation?.Value<double?>("diagnosticIntervalSeconds") ?? 5));
                    CompileLink(prior);
                    continue;
                }
                if (prior != null) DisposeLink(prior);
                var link = new Link { Device = device, Instance = device.InstanceConfigObject, Config = (JObject)config.DeepClone(), StaleMs = animation?.Value<double?>("staleMs") ?? 5000,
                    Diagnostics = animation?.Value<bool?>("diagnosticLogging") == true,
                    DiagnosticInterval = Math.Max(1, Math.Min(60, animation?.Value<double?>("diagnosticIntervalSeconds") ?? 5)),
                    PresenceBinding = new JObject { ["actionId"] = "__transfer_presence", ["dataItemId"] = config.Value<string>("presenceDataItemId"),
                        ["trigger"] = new JObject { ["mode"] = "condition", ["operator"] = "eq", ["value"] = true } }
                };
                _links[device.Id] = link;
                CompileLink(link);
                CreatePayload(link);
            }
            foreach (var key in _links.Keys.Where(id => !retained.Contains(id)).ToArray()) { DisposeLink(_links[key]); _links.Remove(key); }
            // A hot target/meter-scale change takes effect immediately, before
            // another PLC packet. It never manufactures a fresh observation.
            Advance(0, Time.realtimeSinceStartupAsDouble);
        }
        private static double ConfigNumber(JToken token, double fallback)
        {
            if (token == null) return fallback;
            return double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                && !double.IsNaN(value) && !double.IsInfinity(value) ? value : double.NaN;
        }
        private void CompileLink(Link link)
        {
            var config = link.Config; var movement = link.Instance["movement"] as JObject;
            link.TargetMode = config.Value<string>("targetMode"); link.FixedTargetId = config.Value<string>("targetDeviceId");
            link.ActionId = config.Value<string>("actionId"); link.DriveNodeName = config.Value<string>("driveNodeName");
            var sourcePort = config.Value<string>("sourcePort"); var targetPort = config.Value<string>("targetPort");
            link.SourcePortValid = sourcePort == "inlet" || sourcePort == "outlet";
            link.TargetPortValid = targetPort == "inlet" || targetPort == "outlet";
            link.PortsValid = link.SourcePortValid && link.TargetPortValid;
            link.SourceInlet = sourcePort == "inlet"; link.TargetInlet = targetPort == "inlet";
            link.MovementEnabled = movement?.Value<bool?>("enabled") == true;
            var lineId = !string.IsNullOrWhiteSpace(link.Device.LineId) ? link.Device.LineId
                : link.Instance.Value<string>("railLineId") ?? link.Instance.Value<string>("laneLineId") ?? string.Empty;
            _lineLayouts.TryGetValue(lineId, out var lineLayout);
            SceneUnitPolicy.TryResolve(movement, lineLayout, out link.SceneUnitsPerMeter, out link.SceneUnitsReason);
            link.HeightTolerance = ConfigNumber(config["heightToleranceMeters"], 0); link.LateralTolerance = ConfigNumber(config["lateralToleranceMeters"], 0);
            link.AngleTolerance = ConfigNumber(config["angleToleranceDegrees"], 0);
            var stations = new List<StationTarget>();
            foreach (var station in (movement?["stations"] as JArray)?.OfType<JObject>() ?? Enumerable.Empty<JObject>())
            {
                var value = ConfigNumber(station["value"], double.NaN);
                if (double.IsNaN(value) || station["anchorDeviceId"]?.Type != JTokenType.String) continue;
                stations.Add(new StationTarget { Value = value, DeviceId = station.Value<string>("anchorDeviceId") });
            }
            link.StationTargets = stations.ToArray();
        }
        private void CreatePayload(Link link)
        {
            var size = link.Config["materialSize"] as JArray;
            if (size == null || size.Count != 3 || size.Any(value => (value.Type != JTokenType.Integer && value.Type != JTokenType.Float)
                || !float.IsFinite(value.Value<float>()) || value.Value<float>() <= 0)
                || !ColorUtility.TryParseHtmlString(link.Config.Value<string>("materialColor"), out var color)) return;
            var cargo = GameObject.CreatePrimitive(PrimitiveType.Cube); cargo.name = "Configured transfer material " + link.Device.Id;
            link.MaterialSizeMetres = new Vector3(size[0].Value<float>(), size[1].Value<float>(), size[2].Value<float>());
            cargo.layer = 2; cargo.transform.SetParent(transform, false);
            var collider = cargo.GetComponent<Collider>(); if (collider != null) { if (Application.isPlaying) Destroy(collider); else DestroyImmediate(collider); }
            var material = RuntimeShaderLibrary.CreateLitMaterial(cargo.name); material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            cargo.GetComponent<Renderer>().sharedMaterial = material; cargo.SetActive(false); link.Payload = cargo; link.Material = material;
        }
        private static bool ApplyPayloadMetrics(Link link, Transform sourceRoot, out float worldHeight)
        {
            worldHeight = 0;
            // A source's own reflected/degenerate support is not represented by
            // Transform.rotation. Validate the actual source-up vector as well
            // as the presentation parent's axes before declaring a load pose.
            var supportUp = sourceRoot.TransformVector(Vector3.up);
            var supportLength = supportUp.magnitude;
            if (!FinitePositive(supportLength) || Vector3.Dot(supportUp / supportLength, Vector3.up) < .9999f) return false;
            var units = link.SceneUnitsPerMeter; var desired = link.MaterialSizeMetres * units;
            if (!float.IsFinite(units) || units <= 0 || !FinitePositive(desired.x) || !FinitePositive(desired.y) || !FinitePositive(desired.z)) return false;
            var cargo = link.Payload.transform; cargo.rotation = sourceRoot.rotation;
            var parent = cargo.parent; var rotation = cargo.localRotation;
            // Parent transforms can be nonuniform, rotated or mirrored. Solve
            // actual transformed local axes rather than treating localScale as
            // metres or assuming the coordinator's parent has unit scale.
            var xAxis = parent == null ? rotation * Vector3.right : parent.TransformVector(rotation * Vector3.right);
            var yAxis = parent == null ? rotation * Vector3.up : parent.TransformVector(rotation * Vector3.up);
            var zAxis = parent == null ? rotation * Vector3.forward : parent.TransformVector(rotation * Vector3.forward);
            var xScale = xAxis.magnitude; var yScale = yAxis.magnitude; var zScale = zAxis.magnitude;
            if (!FinitePositive(xScale) || !FinitePositive(yScale) || !FinitePositive(zScale)) return false;
            var xUnit = xAxis / xScale; var yUnit = yAxis / yScale; var zUnit = zAxis / zScale;
            // Per-axis lengths alone cannot undo affine shear. A skewed box or
            // upside-down/tilted support would fabricate a metric load shape;
            // refuse that invalid layout rather than silently distorting it.
            if (Mathf.Abs(Vector3.Dot(xUnit, yUnit)) > .0001f || Mathf.Abs(Vector3.Dot(xUnit, zUnit)) > .0001f
                || Mathf.Abs(Vector3.Dot(yUnit, zUnit)) > .0001f || Vector3.Dot(yUnit, Vector3.up) < .9999f) return false;
            var local = new Vector3(desired.x / xScale, desired.y / yScale, desired.z / zScale);
            if (!FinitePositive(local.x) || !FinitePositive(local.y) || !FinitePositive(local.z)) return false;
            cargo.localScale = local; worldHeight = cargo.TransformVector(Vector3.up).magnitude;
            return FinitePositive(worldHeight);
        }
        private static bool FinitePositive(float value) => float.IsFinite(value) && value > 0;
        public void ApplyInputs(string deviceId, JObject frame)
        {
            _simpleMaterial.Receive(deviceId, frame, Time.realtimeSinceStartupAsDouble, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _bidirectional.ApplyInputs(deviceId,frame);
            if (_links.TryGetValue(deviceId ?? "", out var link))
                link.Presence.Receive(frame, link.PresenceBinding, Time.realtimeSinceStartupAsDouble, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
        public void SuspendInputs()
        {
            _simpleMaterial.Suspend();
            _bidirectional.Suspend();
            foreach (var link in _links.Values) { link.Presence.Suspend(); Hide(link, "采集连接中断"); }
        }
        private string Target(Link link)
        {
            if (link.TargetMode == "fixed") return link.FixedTargetId;
            if (link.TargetMode != "station" || _motions == null || !_motions.TryGetValue(link.Device.Id, out var motion) || !motion.HasConfirmedPosition) return null;
            StationTarget match = null;
            foreach (var station in link.StationTargets)
            {
                if (Math.Abs(station.Value - motion.CurrentPositionValue) > .0001) continue;
                if (match != null) return null;
                match = station;
            }
            return match?.DeviceId;
        }
        private bool PortWorld(string deviceId, bool inlet, Transform root, out Vector3 position, out Vector3 direction, out string reason)
        {
            position = direction = Vector3.zero; reason = "进出料口未配置";
            if (!(inlet ? _inletPorts : _outletPorts).TryGetValue(deviceId, out var port) || port.Pose == null) { if (port != null) reason = port.Reason; return false; }
            var p = port.Pose.Position; var d = port.Pose.Direction;
            // Saved datums are untouched glTF root-local coordinates; glTFast
            // reflects X once, before the device's actual scale/yaw/hierarchy.
            position = root.TransformPoint(new Vector3(-(float)p[0], (float)p[1], (float)p[2]));
            direction = root.TransformVector(new Vector3(-(float)d[0], (float)d[1], (float)d[2])).normalized;
            return true;
        }
        private static void Metres(Vector3 value, float sceneUnitsPerMeter, double[] buffer)
        { buffer[0] = (double)value.x / sceneUnitsPerMeter; buffer[1] = (double)value.y / sceneUnitsPerMeter; buffer[2] = (double)value.z / sceneUnitsPerMeter; }
        private void LateUpdate()
        {
            Advance(Time.unscaledDeltaTime, Time.realtimeSinceStartupAsDouble);
        }
        public void Advance(float deltaTime, double now)
        {
            _simpleMaterial.Advance(deltaTime, now);
            _bidirectional.Advance(deltaTime,now);
            foreach (var link in _links.Values)
            {
                link.Presence.Step(deltaTime, now, link.StaleMs, link.PresenceBinding);
                if (!link.Presence.Usable || !link.Presence.HasSample)
                {
                    if (link.LastPresenceReason != link.Presence.Reason) { link.LastPresenceReason = link.Presence.Reason; link.PresenceDisplayReason = "物料信号：" + link.Presence.Reason; }
                    Hide(link, link.PresenceDisplayReason); continue;
                }
                if (!link.Presence.Running) { Hide(link, "当前无物料"); continue; }
                if (link.Payload == null) { Hide(link, "物料显示尺寸或颜色未配置"); continue; }
                if (_roots == null || !_roots.TryGetValue(link.Device.Id, out var sourceRoot) || sourceRoot == null) { Hide(link, "来源设备尚未加载"); continue; }
                if (!sourceRoot.gameObject.activeInHierarchy) { Hide(link, "来源设备不在当前场景"); continue; }
                if (link.MovementEnabled
                    && (_motions == null || !_motions.TryGetValue(link.Device.Id, out var mobile) || !mobile.HasReliableSourcePose)) { Hide(link, "来源料车实测位置不足"); continue; }
                if (!link.SourcePortValid) { Hide(link, "来源进出料口未配置"); continue; }
                if (!PortWorld(link.Device.Id, link.SourceInlet, sourceRoot, out var source, out var direction, out var reason)) { Hide(link, reason); continue; }
                var driver = sourceRoot.GetComponent<DeviceAnimationDriver>(); var parts = sourceRoot.GetComponent<ModelBindingDriver>();
                var node = (Transform)null; var rest = Vector3.zero; var maximum = Vector3.zero;
                var action = link.ActionId; var nodeName = link.DriveNodeName;
                reason = "送料动作未配置";
                var usable = action?.StartsWith("clip:", StringComparison.Ordinal) == true
                    ? driver != null && driver.TryGetTransferDrive(action, nodeName, out node, out rest, out maximum, out reason)
                    : parts != null && parts.TryGetTransferDrive(action, nodeName, out node, out rest, out maximum, out reason);
                if (!usable || node?.parent == null) { Hide(link, reason ?? "送料动作未配置"); continue; }
                var units = link.SceneUnitsPerMeter;
                if (!ApplyPayloadMetrics(link, sourceRoot, out var worldHeight)) { Hide(link, link.SceneUnitsReason ?? "来源承料面、米制比例或物料尺寸无效"); continue; }
                // Showing observed source material is not declaring successful
                // docking or transfer. Its location follows only the rendered
                // source root plus the real drive-node displacement, including
                // continuously measured motion. Target failures never stretch
                // that node, teleport a cart or make healthy material disappear.
                var displacement = node.parent.TransformVector(node.localPosition - rest);
                link.Payload.transform.position = source + displacement + Vector3.up * (worldHeight * .5f);
                link.Payload.SetActive(true);
                if (link.MovementEnabled && (!_motions.TryGetValue(link.Device.Id, out var confirmedMobile) || !confirmedMobile.HasConfirmedPosition))
                { Diagnose(link, "来源物料显示，料车尚未确认停靠", null, false); continue; }
                var targetId = Target(link);
                if (string.IsNullOrEmpty(targetId) || targetId == link.Device.Id || !_devices.ContainsKey(targetId))
                { Diagnose(link, "来源物料显示，目标设备或当前工位未配置", null, false); continue; }
                if (_movingDevices.Contains(targetId)) { Diagnose(link, "来源物料显示，目标设备启用了移动，不能作为固定交接设备", null, false); continue; }
                if (!_roots.TryGetValue(targetId, out var targetRoot) || targetRoot == null)
                { Diagnose(link, "来源物料显示，目标设备尚未加载", null, false); continue; }
                if (!targetRoot.gameObject.activeInHierarchy)
                { Diagnose(link, "来源物料显示，目标设备不在当前场景", null, false); continue; }
                if (!link.TargetPortValid || !PortWorld(targetId, link.TargetInlet, targetRoot, out var target, out var targetDirection, out reason))
                { Diagnose(link, "来源物料显示，目标进出料口无效", null, false); continue; }
                var maximumWorld = node.parent.TransformVector(maximum);
                Metres(source, units, link.SourceMetres); Metres(direction, 1, link.SourceDirection); Metres(target, units, link.TargetMetres);
                Metres(targetDirection, 1, link.TargetDirection); Metres(maximumWorld, units, link.MaximumDriveMetres);
                var reach = TransferReachPolicy.EvaluateInto(link.Reach, link.SourceMetres, link.SourceDirection, link.TargetMetres, link.TargetDirection, link.MaximumDriveMetres,
                    link.HeightTolerance, link.LateralTolerance, link.AngleTolerance);
                Diagnose(link, reach.Usable ? "来源物料显示，交接几何与到位条件满足" : reach.Reason, reach, reach.Usable);
            }
        }
        private void Hide(Link link, string reason, TransferReachResult reach = null)
        {
            if (link.Payload != null) link.Payload.SetActive(false); Diagnose(link, reason, reach, false);
        }
        private void Diagnose(Link link, string reason, TransferReachResult reach, bool handoffEligible)
        {
            var sourceVisible = link.Payload != null && link.Payload.activeSelf;
            var changed = link.LastReason != reason || link.LastSourceVisible != sourceVisible || link.LastHandoffEligible != handoffEligible;
            link.LastReason = reason; link.LastSourceVisible = sourceVisible; link.LastHandoffEligible = handoffEligible;
            if (!changed && (!link.Diagnostics || Time.realtimeSinceStartupAsDouble < link.NextDiagnostic)) return;
            var record = new JObject { ["deviceId"] = link.Device.Id, ["reason"] = reason, ["visible"] = sourceVisible,
                ["sourceMaterialVisible"] = sourceVisible, ["handoffEligible"] = handoffEligible,
                ["presenceSourceTimestamp"] = link.Presence.SourceTimestamp, ["presenceUsable"] = link.Presence.Usable, ["targetDeviceId"] = Target(link) };
            if (reach != null) record["reach"] = new JObject { ["usable"] = reach.Usable, ["distanceMeters"] = reach.Distance, ["maximumTravelMeters"] = reach.MaximumTravel,
                ["heightErrorMeters"] = reach.HeightError, ["lateralErrorMeters"] = reach.LateralError, ["angleErrorDegrees"] = reach.AngleErrorDegrees };
            if (_roots != null && _roots.TryGetValue(link.Device.Id, out var root) && root != null)
            { var driver = root.GetComponent<DeviceAnimationDriver>(); if (driver != null) driver.TransferDiagnostic = record; var parts = root.GetComponent<ModelBindingDriver>(); if (parts != null) parts.TransferDiagnostic = record; }
            if (link.Diagnostics && (changed || Time.realtimeSinceStartupAsDouble >= link.NextDiagnostic))
            { link.NextDiagnostic = Time.realtimeSinceStartupAsDouble + link.DiagnosticInterval; Debug.Log("[DeviceTransfer] " + record.ToString(Newtonsoft.Json.Formatting.None)); }
        }
        private void DisposeLink(Link link)
        {
            Hide(link, "来源联动配置已停用或更新");
            if (link.Payload != null) { if (Application.isPlaying) Destroy(link.Payload); else DestroyImmediate(link.Payload); }
            if (link.Material != null) { if (Application.isPlaying) Destroy(link.Material); else DestroyImmediate(link.Material); }
        }
        public JObject SimpleMaterialDiagnostics() => _simpleMaterial.Describe();
        private void OnDestroy() { _simpleMaterial.Dispose();_bidirectional.Dispose();foreach (var link in _links.Values) DisposeLink(link); _links.Clear(); }
    }
}
