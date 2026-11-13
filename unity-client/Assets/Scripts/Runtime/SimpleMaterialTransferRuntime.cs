using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // An explicitly illustrative cargo layer. No PLC writes, production counts,
    // physical velocity/calibration or inferred material-presence feedback.
    public sealed class SimpleMaterialTransferRuntime
    {
        public const float DurationSeconds = 3;
        private const double PendingSeconds = 8;
        private sealed class Port
        {
            public string DeviceId, Kind, Id;
            public LoadingPortPose Pose;
            public TransferBooleanObservation Signal;
            public bool LastValue, HadValue;
            public double PendingAt = double.NegativeInfinity, PendingStamp = double.NegativeInfinity;
            public double ConsumedStamp = double.NegativeInfinity;
        }
        private sealed class Pair
        {
            public string CartId, TargetId;
            public Port Source, Target;
            public bool Pickup;
            public bool Pending(double now) => Fresh(Source, now) || Fresh(Target, now);
            private static bool Fresh(Port port, double now) => port != null && port.Signal != null && port.Signal.Usable
                && port.PendingStamp > port.ConsumedStamp && now - port.PendingAt <= PendingSeconds;
        }
        private sealed class Trip
        {
            public Pair Pair;
            public GameObject Cargo;
            public float Elapsed;
            public Vector3[] Path;
            public string Starter;
            public bool SourceParticipated, TargetParticipated;
        }
        private readonly Dictionary<string, DeviceDto> _devices = new Dictionary<string, DeviceDto>();
        private readonly Dictionary<string, Port> _ports = new Dictionary<string, Port>();
        private readonly Dictionary<string, GameObject> _cargo = new Dictionary<string, GameObject>();
        private readonly List<Trip> _trips = new List<Trip>();
        private readonly List<Material> _materials = new List<Material>();
        private readonly Dictionary<string, double> _partnerEcho = new Dictionary<string, double>();
        private readonly Dictionary<string, string> _reasons = new Dictionary<string, string>();
        private readonly Dictionary<string, CartTransferPresentation> _carts = new Dictionary<string, CartTransferPresentation>();
        private IReadOnlyDictionary<string, Transform> _roots;
        private IReadOnlyDictionary<string, MobileDeviceMotion> _motions;
        private Transform _parent;
        private JToken _identity;
        private bool _suspended;

        public static bool HasSignals(DeviceDto device) => device?.InstanceConfigObject["loadingPortSignals"] is JObject signals && signals.Value<int?>("version") == 1
            && new[] { "inletPointId", "outletPointId" }.Any(key => signals[key]?.Type == JTokenType.String && !string.IsNullOrWhiteSpace(signals.Value<string>(key)));
        public static bool UsesSimpleTransfer(DeviceDto device) => HasSignals(device) || CartTransferPresentation.IsRotating(device);
        public void Configure(IEnumerable<DeviceDto> devices, IEnumerable<ModelAssetDto> models,
            IReadOnlyDictionary<string, Transform> roots, IReadOnlyDictionary<string, MobileDeviceMotion> motions, Transform parent)
        {
            var rows = (devices ?? Enumerable.Empty<DeviceDto>()).Where(device => device != null).ToArray();
            var assets = (models ?? Enumerable.Empty<ModelAssetDto>()).Where(model => model != null).GroupBy(model => model.Id).ToDictionary(group => group.Key, group => group.First());
            var identity = new JArray(rows.OrderBy(device => device.Id).Select(device => new JObject {
                ["id"] = device.Id, ["model"] = device.ModelType, ["signals"] = device.InstanceConfigObject["loadingPortSignals"]?.DeepClone(),
                ["root"] = roots != null && roots.TryGetValue(device.Id, out var root) && root != null ? root.GetInstanceID() : 0,
                ["placement"] = new JArray(device.PositionX, device.PositionY, device.PositionZ, device.RotationY, device.Scale, device.CoordinateSpace),
                ["ports"] = assets.TryGetValue(device.ModelType ?? "", out var model) ? model.MetadataObject["loadingPorts"]?.DeepClone() : null,
                ["overrides"] = device.InstanceConfigObject["loadingPortOverrides"]?.DeepClone(), ["movement"] = device.InstanceConfigObject["movement"]?.DeepClone(),
                ["cart"] = device.InstanceConfigObject["cartTransfer"]?.DeepClone(),
                ["points"] = JArray.FromObject(device.DataPoints ?? new List<DataPointDto>()),
                ["legacy"] = device.InstanceConfigObject["animationBindings"]?["transferLink"]?.DeepClone()
            }));
            _roots = roots; _motions = motions; _parent = parent;
            _devices.Clear(); foreach (var device in rows) _devices[device.Id] = device;
            if (JToken.DeepEquals(_identity, identity)) return;
            Dispose(); _identity = identity;
            foreach (var device in rows) foreach (var kind in new[] { "inlet", "outlet" }) {
                assets.TryGetValue(device.ModelType ?? "", out var model);
                LoadingPortPolicy.TryResolve(model?.MetadataObject, device.InstanceConfigObject, kind, out var pose, out _);
                var port = new Port { DeviceId = device.Id, Kind = kind, Pose = pose };
                var config = device.InstanceConfigObject["loadingPortSignals"] as JObject;
                var id = config?.Value<int?>("version") == 1 && config?[kind + "PointId"]?.Type == JTokenType.String
                    && (config.Value<string>("inletPointId") == null || config.Value<string>("inletPointId") != config.Value<string>("outletPointId")) ? config.Value<string>(kind + "PointId") : null;
                var matches = device.DataPoints?.Where(point => point != null && point.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) == id).ToArray();
                if (matches?.Length == 1) {
                    var point = matches[0];
                    if ((string.IsNullOrEmpty(point.DeviceId) || point.DeviceId == device.Id)
                        && string.Equals(point.DataType, "BOOL", StringComparison.OrdinalIgnoreCase)
                        && string.Equals(point.AccessType ?? "READ", "READ", StringComparison.OrdinalIgnoreCase)) {
                        port.Id = id; port.Signal = new TransferBooleanObservation(device.Id, id, point.Category ?? "status",
                            string.IsNullOrWhiteSpace(point.ValueRole) ? point.Name : point.ValueRole);
                    }
                }
                _ports[Key(device.Id, kind)] = port;
            }
            foreach (var device in rows) if (CartTransferPresentation.IsRotating(device) && roots.TryGetValue(device.Id, out var root) && root != null) {
                _ports.TryGetValue(Key(device.Id, "outlet"), out var outlet); _ports.TryGetValue(Key(device.Id, "inlet"), out var inlet);
                _carts[device.Id] = new CartTransferPresentation(root, device.InstanceConfigObject["cartTransfer"] as JObject, outlet?.Pose ?? inlet?.Pose);
            }
        }
        private static string Key(string device, string kind) => device + "\n" + kind;
        public void Receive(string id, JObject frame, double now, double wallNow)
        {
            foreach (var kind in new[] { "inlet", "outlet" }) if (_ports.TryGetValue(Key(id, kind), out var port) && port.Signal != null) {
                port.Signal.Receive(frame, now, wallNow);
                if (!port.Signal.Advance(now, 5000)) { port.HadValue = false; port.PendingAt = double.NegativeInfinity; continue; }
                if (port.Signal.Value && (!port.HadValue || !port.LastValue) && port.Signal.Timestamp > port.ConsumedStamp) {
                    port.PendingAt = now; port.PendingStamp = port.Signal.Timestamp;
                }
                port.HadValue = true; port.LastValue = port.Signal.Value;
            }
            _suspended = false;
        }
        public void Suspend()
        {
            _suspended = true;
            foreach (var port in _ports.Values) { port.Signal?.Suspend(); port.HadValue = false; port.PendingAt = double.NegativeInfinity; }
        }
        private IEnumerable<Pair> DockedPairs()
        {
            if (_motions == null || _roots == null) yield break;
            foreach (var cart in _devices.Values) {
                var movement = cart.InstanceConfigObject["movement"] as JObject;
                if (movement?.Value<bool?>("enabled") != true || movement.Value<string>("valueMode") != "station"
                    || !_motions.TryGetValue(cart.Id, out var motion) || !motion.HasConfirmedPosition || !motion.HasReliableSourcePose) continue;
                // Old specialized cycle remains available only when no new cart signals have been chosen.
                if (!UsesSimpleTransfer(cart) && cart.InstanceConfigObject["animationBindings"]?["transferLink"]?.Value<bool?>("enabled") == true) continue;
                var stations = (movement["stations"] as JArray)?.OfType<JObject>().Where(station => station["value"] != null
                    && Math.Abs(station.Value<double>("value") - motion.CurrentPositionValue) < .0001).ToArray();
                if (stations?.Length != 1) continue;
                var target = stations[0].Value<string>("anchorDeviceId");
                if (target == cart.Id || string.IsNullOrEmpty(target) || !_devices.ContainsKey(target) || !_roots.ContainsKey(target)
                    || _devices[target].InstanceConfigObject["movement"]?.Value<bool?>("enabled") == true) continue;
                foreach (var pickup in new[] { false, true }) {
                    _ports.TryGetValue(Key(cart.Id, pickup ? "inlet" : "outlet"), out var cartPort);
                    _ports.TryGetValue(Key(target, pickup ? "outlet" : "inlet"), out var fixedPort);
                    if (cartPort?.Pose == null || fixedPort?.Pose == null) continue;
                    yield return new Pair { CartId = cart.Id, TargetId = target, Pickup = pickup,
                        Source = pickup ? fixedPort : cartPort, Target = pickup ? cartPort : fixedPort };
                }
            }
        }
        private bool Fresh(Port port, double now) => port.Signal != null && port.Signal.Advance(now, 5000);
        private bool Live(Pair pair, double now) => Fresh(pair.Source, now) || Fresh(pair.Target, now);
        private bool Live(Trip trip, double now) => trip.SourceParticipated && Fresh(trip.Pair.Source, now) || trip.TargetParticipated && Fresh(trip.Pair.Target, now);
        private bool SameDock(Pair pair) => DockedPairs().Any(candidate => candidate.CartId == pair.CartId && candidate.TargetId == pair.TargetId && candidate.Pickup == pair.Pickup);
        public void Advance(float delta, double now)
        {
            foreach (var port in _ports.Values) if (port.Signal != null && !port.Signal.Advance(now, 5000)) port.PendingAt = double.NegativeInfinity;
            if (_suspended) return;
            foreach (var port in _ports.Values) if (Pending(port, now)) Echo(port, now);
            var docked = DockedPairs().ToArray();
            foreach (var item in _carts) {
                var choices = docked.Where(pair => pair.CartId == item.Key).ToArray();
                var pending = choices.Where(pair => pair.Pending(now)).ToArray();
                var active = _trips.Any(trip => trip.Pair.CartId == item.Key);
                if (!active && choices.Length > 0 && pending.Length <= 1) {
                    var pair = pending.FirstOrDefault() ?? choices.FirstOrDefault(candidate => !candidate.Pickup) ?? choices[0];
                    var cartPort = pair.Source.DeviceId == pair.CartId ? pair.Source : pair.Target;
                    var other = pair.Source.DeviceId == pair.CartId ? pair.Target : pair.Source;
                    if (WorldPort(other, out var point, out _)) item.Value.Aim(cartPort.Pose, point);
                    item.Value.Advance(delta, true);
                } else item.Value.Advance(0, false);
            }
            foreach (var trip in _trips.ToArray()) {
                if (!SameDock(trip.Pair)) {
                    if (_motions.TryGetValue(trip.Pair.CartId, out var motion) && !motion.HasFreshPosition) { _reasons[trip.Pair.CartId] = "到位信号过期，保持物料画面"; continue; }
                    // A new destination must not drag an unfinished bridge through the factory.
                    RemoveCargo(trip.Cargo); _trips.Remove(trip); _reasons[trip.Pair.CartId] = "对接已变化"; continue;
                }
                if (!Live(trip, now)) { _reasons[trip.Pair.CartId] = "信号过期，保持物料画面"; continue; }
                if (_carts.TryGetValue(trip.Pair.CartId, out var turning)) turning.Advance(delta, false, true, trip.Pair.Pickup);
                trip.SourceParticipated |= trip.Pair.Source.Signal?.Usable == true && trip.Pair.Source.Signal.Value;
                trip.TargetParticipated |= trip.Pair.Target.Signal?.Usable == true && trip.Pair.Target.Signal.Value;
                Consume(trip.Pair.Source); Consume(trip.Pair.Target);
                trip.Elapsed += Mathf.Max(0, delta);
                var t = Mathf.Clamp01(trip.Elapsed / DurationSeconds);
                trip.Cargo.transform.position = PathPoint(trip.Path, t);
                if (t < 1) continue;
                var target = trip.Pair.Target.DeviceId;
                if (_cargo.TryGetValue(target, out var old) && old != trip.Cargo) RemoveCargo(old);
                _cargo[target] = trip.Cargo;
                trip.Cargo.transform.SetParent(_carts.TryGetValue(target, out var carrier) ? carrier.CargoParent : _roots[target], true);
                var partner = trip.Starter == Key(trip.Pair.Source.DeviceId, trip.Pair.Source.Kind) ? trip.Pair.Target : trip.Pair.Source;
                if (partner.Signal != null && !(partner == trip.Pair.Source ? trip.SourceParticipated : trip.TargetParticipated))
                    _partnerEcho[Key(partner.DeviceId, partner.Kind)] = now + PendingSeconds;
                _trips.Remove(trip); _reasons[trip.Pair.CartId] = "物料示意完成";
            }
            var pairs = DockedPairs().ToArray();
            foreach (var pair in pairs) {
                if (!pair.Pending(now) || !Live(pair, now)) continue;
                if (_carts.TryGetValue(pair.CartId, out var turntable) && !turntable.Aligned) {
                    _reasons[pair.CartId] = turntable.Ready ? "转台朝向目标工位" : turntable.Reason; continue;
                }
                if (_trips.Any(trip => trip.Pair.CartId == pair.CartId || trip.Pair.TargetId == pair.TargetId)) continue;
                // Fixed-device-only signals cannot choose between two simultaneously docked carts.
                if (!HasPendingCartSignal(pair, now) && pairs.Count(other => other.TargetId == pair.TargetId && other.Pickup == pair.Pickup) != 1) continue;
                var sourcePending = Pending(pair.Source, now); var targetPending = Pending(pair.Target, now);
                if (sourcePending && Echo(pair.Source, now)) sourcePending = false;
                if (targetPending && Echo(pair.Target, now)) targetPending = false;
                if (!sourcePending && !targetPending) continue;
                // Opposing commands are ambiguous. Do not invent a direction.
                if (pairs.Any(other => other.CartId == pair.CartId && other.Pickup != pair.Pickup && other.Pending(now))) {
                    _reasons[pair.CartId] = "进出料信号同时有效"; continue;
                }
                if (!TryPath(pair, out var path, out var size)) continue;
                var cargo = GetCargo(pair.Source.DeviceId, size);
                cargo.transform.SetParent(_parent, true); cargo.transform.position = path[0]; cargo.SetActive(true);
                _cargo.Remove(pair.Source.DeviceId);
                var starter = sourcePending ? pair.Source : pair.Target;
                _partnerEcho.Remove(Key(pair.Source.DeviceId, pair.Source.Kind)); _partnerEcho.Remove(Key(pair.Target.DeviceId, pair.Target.Kind));
                _trips.Add(new Trip { Pair = pair, Cargo = cargo, Path = path, Starter = Key(starter.DeviceId, starter.Kind),
                    SourceParticipated = sourcePending || pair.Source.Signal?.Usable == true && pair.Source.Signal.Value,
                    TargetParticipated = targetPending || pair.Target.Signal?.Usable == true && pair.Target.Signal.Value });
                Consume(pair.Source); Consume(pair.Target);
                _reasons[pair.CartId] = pair.Pickup ? "取料示意" : "送料示意";
            }
        }
        private static bool Pending(Port port, double now) => port.Signal != null && port.Signal.Usable && port.PendingStamp > port.ConsumedStamp && now - port.PendingAt <= PendingSeconds;
        private static void Consume(Port port) { if (port.Signal != null && !double.IsNaN(port.Signal.Timestamp)) port.ConsumedStamp = Math.Max(port.ConsumedStamp, port.Signal.Timestamp); }
        private bool HasPendingCartSignal(Pair pair, double now) => Pending(pair.Source.DeviceId == pair.CartId ? pair.Source : pair.Target, now);
        private bool Echo(Port port, double now)
        {
            var key = Key(port.DeviceId, port.Kind);
            if (!_partnerEcho.TryGetValue(key, out var until) || now > until) return false;
            Consume(port); _partnerEcho.Remove(key); return true;
        }
        private static bool BoundsOf(Transform root, out Bounds bounds)
        {
            bounds = new Bounds(); var initialized = false;
            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true)) {
                if (!renderer.enabled || renderer.gameObject.layer == 2 || renderer is LineRenderer || renderer is ParticleSystemRenderer) continue;
                if (!initialized) { bounds = renderer.bounds; initialized = true; } else bounds.Encapsulate(renderer.bounds);
            }
            return initialized && bounds.size.sqrMagnitude > .0000001f;
        }
        private bool TryPath(Pair pair, out Vector3[] path, out Vector3 size)
        {
            path = null; size = Vector3.zero;
            if (!_roots.TryGetValue(pair.Source.DeviceId, out var source) || source == null || !_roots.TryGetValue(pair.Target.DeviceId, out var target) || target == null
                || !BoundsOf(source, out var a) || !BoundsOf(target, out var b)) return false;
            var span = Mathf.Min(Mathf.Max(a.size.x, a.size.z), Mathf.Max(b.size.x, b.size.z));
            var height = Mathf.Min(Mathf.Min(a.size.y, b.size.y) * .12f, span * .08f);
            if (!float.IsFinite(span) || !float.IsFinite(height) || span <= 0 || height <= 0) return false;
            size = new Vector3(span * .18f, height, span * .18f);
            if (!WorldPort(pair.Source, out var sourceMouth, out var sourceDirection) || !WorldPort(pair.Target, out var targetMouth, out var targetDirection)) return false;
            var outward = targetMouth - sourceMouth; outward.y = 0;
            if (outward.sqrMagnitude < .00000001f) outward = -targetDirection;
            outward.Normalize();
            if (Vector3.Dot(sourceDirection, outward) <= .05f || Vector3.Dot(targetDirection, -outward) <= .05f) {
                _reasons[pair.CartId] = "料口未朝向对接设备"; return false;
            }
            Vector3 Mouth(Port port) => (port == pair.Source ? sourceMouth : targetMouth) + Vector3.up * height / 2;
            Vector3 Seat(Transform root, Port port, Bounds bounds, Vector3 mouth) {
                var direction = port == pair.Source ? sourceDirection : targetDirection;
                if (_carts.TryGetValue(port.DeviceId, out var cart)) return cart.Seat(mouth, direction, height);
                var depth = Mathf.Max(span * .18f, Vector3.Dot(mouth - bounds.center, direction));
                return mouth - direction * depth;
            }
            var p = Mouth(pair.Source); var q = Mouth(pair.Target);
            path = new[] { Seat(source, pair.Source, a, p), p, q, Seat(target, pair.Target, b, q) };
            return path.All(value => float.IsFinite(value.x) && float.IsFinite(value.y) && float.IsFinite(value.z));
        }
        private bool WorldPort(Port port, out Vector3 position, out Vector3 direction)
        {
            position = direction = Vector3.zero;
            if (_carts.TryGetValue(port.DeviceId, out var cart)) return cart.WorldPort(port.Pose, out position, out direction);
            if (!_roots.TryGetValue(port.DeviceId, out var root) || root == null || port.Pose == null) return false;
            position = root.TransformPoint(new Vector3(-(float)port.Pose.Position[0], (float)port.Pose.Position[1], (float)port.Pose.Position[2]));
            direction = root.TransformVector(new Vector3(-(float)port.Pose.Direction[0], 0, (float)port.Pose.Direction[2])).normalized;
            return true;
        }
        private static Vector3 PathPoint(Vector3[] path, float t)
        {
            var lengths = new[] { Vector3.Distance(path[0], path[1]), Vector3.Distance(path[1], path[2]), Vector3.Distance(path[2], path[3]) };
            var distance = lengths.Sum() * Mathf.SmoothStep(0, 1, t);
            for (var i = 0; i < 3; i++) { if (distance <= lengths[i] || i == 2) return Vector3.Lerp(path[i], path[i + 1], lengths[i] > 0 ? distance / lengths[i] : 1); distance -= lengths[i]; }
            return path[3];
        }
        private GameObject GetCargo(string owner, Vector3 size)
        {
            if (_cargo.TryGetValue(owner, out var cargo)) return cargo;
            cargo = GameObject.CreatePrimitive(PrimitiveType.Cube); cargo.name = "Illustrative cargo " + owner; cargo.layer = 2;
            var collider = cargo.GetComponent<Collider>(); if (collider != null) Destroy(collider);
            var material = RuntimeShaderLibrary.CreateLitMaterial(cargo.name); material.color = new Color(.9f, .55f, .18f);
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", material.color);
            cargo.GetComponent<Renderer>().sharedMaterial = material; _materials.Add(material); cargo.transform.localScale = size;
            return cargo;
        }
        private void RemoveCargo(GameObject cargo) {
            if (cargo == null) return;
            var renderer = cargo.GetComponent<Renderer>();
            if (renderer != null && renderer.sharedMaterial != null) { var material = renderer.sharedMaterial; _materials.Remove(material); Destroy(material); }
            Destroy(cargo);
        }
        private static void Destroy(UnityEngine.Object value) { if (Application.isPlaying) UnityEngine.Object.Destroy(value); else UnityEngine.Object.DestroyImmediate(value); }
        public JObject Describe() => new JObject { ["activeTransfers"] = _trips.Count, ["estimatedCargoDevices"] = new JArray(_cargo.Keys.OrderBy(id => id)),
            ["reasons"] = JObject.FromObject(_reasons), ["turntables"] = JObject.FromObject(_carts.ToDictionary(item => item.Key, item => item.Value.Describe())), ["displayOnly"] = true };
        public void Dispose()
        {
            foreach (var cargo in _cargo.Values.Concat(_trips.Select(trip => trip.Cargo)).Distinct()) RemoveCargo(cargo);
            foreach (var material in _materials) if (material != null) Destroy(material);
            foreach (var cart in _carts.Values) cart.Dispose(); _carts.Clear();
            _ports.Clear(); _cargo.Clear(); _trips.Clear(); _materials.Clear(); _partnerEcho.Clear(); _reasons.Clear(); _suspended = false; _identity = null;
        }
    }
}
