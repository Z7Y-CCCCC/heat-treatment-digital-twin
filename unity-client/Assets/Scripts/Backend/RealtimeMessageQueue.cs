using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    // Serialized byte budget plus message count bound both wire data and object overhead.
    // Controls and quality faults form barriers; only adjacent transient frames coalesce.
    public sealed class RealtimeMessageQueue
    {
        public const int MaxMessageBytes = 4 * 1024 * 1024;
        private readonly object _gate = new object();
        private readonly LinkedList<Entry> _entries = new LinkedList<Entry>();
        private readonly int _maxBytes, _maxMessages;
        private int _bytes, _generation;
        private sealed class Entry
        {
            public JObject Message; public int Bytes; public string Kind;
        }
        public RealtimeMessageQueue(int maxBytes = 16 * 1024 * 1024, int maxMessages = 256)
        { _maxBytes = maxBytes; _maxMessages = maxMessages; }
        public int Count { get { lock (_gate) return _entries.Count; } }
        public int Bytes { get { lock (_gate) return _bytes; } }
        public void Reset(int generation)
        {
            lock (_gate) { _generation = generation; _entries.Clear(); _bytes = 0; }
        }
        public void Clear(int generation)
        {
            lock (_gate) { if (generation == _generation) { _entries.Clear(); _bytes = 0; } }
        }
        public bool TryEnqueue(int generation, JObject message)
        {
            lock (_gate)
            {
                if (generation != _generation) return true; // obsolete producer, not overload
                var type = message.Value<string>("type");
                var patches = message["payload"]?["devices"] as JArray;
                var kind = type == "realtime_frame" && patches != null && !patches.Any(HasDeviceFault)
                    ? patches.All(device => device.Value<bool?>("motionInputOnly") == true) ? "motion-input" : "realtime"
                    : type == "scene_projection" ? "projection" : "reliable";
                var previous = _entries.Last?.Value;
                var realtime = kind == "realtime" || kind == "motion-input";
                var replacing = kind != "reliable" && previous?.Kind == kind
                    && (!realtime || !HasMotionBoundary(previous.Message, message));
                var merged = replacing && realtime ? MergeRealtime(previous.Message, message) : message;
                var size = Encoding.UTF8.GetByteCount(merged.ToString(Formatting.None));
                var bytes = _bytes - (replacing ? previous.Bytes : 0) + size;
                if (size > MaxMessageBytes || bytes > _maxBytes || _entries.Count + (replacing ? 0 : 1) > _maxMessages) return false;
                var entry = new Entry { Message = merged, Bytes = size, Kind = kind };
                if (replacing) _entries.Last.Value = entry; else _entries.AddLast(entry);
                _bytes = bytes; return true;
            }
        }
        public bool TryDequeue(int generation, out JObject message)
        {
            lock (_gate)
            {
                message = null;
                if (generation != _generation || _entries.First == null) return false;
                var entry = _entries.First.Value; _entries.RemoveFirst(); _bytes -= entry.Bytes;
                message = entry.Message; return true;
            }
        }
        private static bool HasFault(JToken token)
        {
            if (token is JContainer container) { foreach (var child in container.Children()) if (HasFault(child)) return true; }
            return token is JValue value && (value.Value as string == "bad" || value.Value as string == "stale");
        }
        private static bool HasDeviceFault(JToken device)
        {
            if (HasFault(device?["quality"])) return true;
            if (!(device?["motionInputs"] is JObject inputs)) return false;
            foreach (var property in inputs.Properties())
            {
                var input = property.Value;
                if (HasFault(input?["quality"])) return true;
                if (input?["endpointFeedback"] is JObject endpoints)
                    foreach (var endpoint in endpoints.Properties()) if (HasFault(endpoint.Value?["quality"])) return true;
            }
            return false;
        }
        private static string Scope(JToken value) => value?.Value<string>("factoryId") ?? value?.Value<string>("factory_id") ?? string.Empty;
        private static bool DiscreteChange(JToken before, JToken after) =>
            (before?.Type != JTokenType.Integer && before?.Type != JTokenType.Float
             || after?.Type != JTokenType.Integer && after?.Type != JTokenType.Float) && !JToken.DeepEquals(before, after);
        private static bool DeviceMotionBoundary(JObject previous, JObject next)
        {
            if ((previous.Value<bool?>("motionInputOnly") == true) != (next.Value<bool?>("motionInputOnly") == true)) return true;
            if (HasDeclaredMotionBoundary(previous, next)) return true;
            var a = previous["motionInputs"] as JObject; var b = next["motionInputs"] as JObject;
            if (a != null || b != null)
            {
                if (a == null || b == null || !a.Properties().Select(p => p.Name).OrderBy(k => k, StringComparer.Ordinal)
                    .SequenceEqual(b.Properties().Select(p => p.Name).OrderBy(k => k, StringComparer.Ordinal))) return true;
                foreach (var property in b.Properties())
                {
                    var before = a[property.Name]; var after = property.Value;
                    if (!JToken.DeepEquals(before?["dataItemId"], after?["dataItemId"]) || !JToken.DeepEquals(before?["stage"], after?["stage"])
                        || DiscreteChange(before?["value"], after?["value"])) return true;
                    foreach (var endpoint in new[] { "extended", "retracted" })
                    {
                        var old = before?["endpointFeedback"]?[endpoint]; var current = after?["endpointFeedback"]?[endpoint];
                        if (!JToken.DeepEquals(old?["dataItemId"], current?["dataItemId"]) || !JToken.DeepEquals(old?["value"], current?["value"])) return true;
                    }
                }
            }
            // PLC category names are user-configurable. Preserve primitive
            // BOOL/text edges in motors/doors/custom groups too, but do not
            // turn metadata clocks or every numeric WORD into a barrier.
            foreach (var group in next.Properties().Where(property => property.Value is JObject
                && property.Name != "pointMeta" && property.Name != "quality"
                && property.Name != "plc" && property.Name != "motionInputs" && property.Name != "motionSemantics").Select(property => property.Name))
            {
                if (!(previous[group] is JObject prior) || !(next[group] is JObject incoming)) continue;
                foreach (var property in incoming.Properties())
                    if (prior.Property(property.Name) != null && !(prior[property.Name] is JContainer)
                        && !(property.Value is JContainer) && DiscreteChange(prior[property.Name], property.Value)) return true;
            }
            return false;
        }
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static bool Numeric(JToken token) => token?.Type == JTokenType.Integer || token?.Type == JTokenType.Float;
        private static bool Number(JToken token, out double value, bool allowBoolean = false)
        {
            value = 0;
            if (allowBoolean && token?.Type == JTokenType.Boolean) { value = token.Value<bool>() ? 1 : 0; return true; }
            return (Numeric(token) || token?.Type == JTokenType.String)
                && double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value) && Finite(value);
        }
        private static bool Text(JToken token, int maximum = 240, bool allowEmpty = false)
        {
            if (token?.Type != JTokenType.String) return false;
            var value = token.Value<string>();
            return (allowEmpty || value.Length > 0) && value.Length <= maximum && !value.Any(character => character <= 31 || character == 127);
        }
        private static bool Only(JObject value, params string[] keys) => value.Properties().All(property => keys.Contains(property.Name));
        private static bool Good(JToken value) => value == null || value.Type == JTokenType.Null
            || value.Type == JTokenType.String && string.Equals(value.Value<string>(), "good", StringComparison.OrdinalIgnoreCase);
        private static bool ValidSource(JToken token)
        {
            if (!(token is JObject value)) return false;
            if (value.Property("dataItemId") != null) return Only(value, "dataItemId", "actionId") && Text(value["dataItemId"]) && Text(value["actionId"]);
            return Only(value, "pointId", "pointKey") && Text(value["pointId"], 120)
                && (value.Property("pointKey") == null || Text(value["pointKey"]) && value.Value<string>("pointKey").Contains("."));
        }
        private static bool ValidDeclaration(JToken token)
        {
            if (!(token is JObject value) || !Text(value["key"]) || !ValidSource(value["source"]) || !Text(value["kind"])) return false;
            var kind = value.Value<string>("kind");
            if (kind == "condition")
            {
                if (!Only(value, "key", "kind", "source", "operator", "value", "hysteresis") || !Text(value["operator"])) return false;
                var operation = value.Value<string>("operator");
                var numericOperation = operation == "gt" || operation == "gte" || operation == "lt" || operation == "lte";
                if (!numericOperation && operation != "eq" && operation != "ne") return false;
                var expected = value["value"];
                var validValue = Numeric(expected) && Number(expected, out var number) && Math.Abs(number) <= 1e12
                    || expected?.Type == JTokenType.Boolean || Text(expected, 160, true);
                return validValue && Numeric(value["hysteresis"]) && Number(value["hysteresis"], out var h) && h >= 0 && h <= 1e12
                    && (numericOperation ? Numeric(expected) : h == 0);
            }
            if (kind == "running") return Only(value, "key", "kind", "source", "inputMin", "inputMax", "invert")
                && Numeric(value["inputMin"]) && Number(value["inputMin"], out var minimum) && Numeric(value["inputMax"]) && Number(value["inputMax"], out var maximum)
                && Math.Max(Math.Abs(minimum), Math.Abs(maximum)) <= 1e12 && minimum < maximum && value["invert"]?.Type == JTokenType.Boolean;
            if (kind == "signed_speed") return Only(value, "key", "kind", "source", "speedFactor", "speed", "invert")
                && Numeric(value["speedFactor"]) && Number(value["speedFactor"], out var factor) && Finite((float)factor)
                && Numeric(value["speed"]) && Number(value["speed"], out var speed) && speed >= .05 && speed <= 10 && value["invert"]?.Type == JTokenType.Boolean;
            if (kind == "running_gate") return Only(value, "key", "kind", "source") && Text(value["source"]?["pointId"], 120);
            if (kind != "station" || !Only(value, "key", "kind", "source", "values") || !Text(value["source"]?["pointId"], 120)
                || !(value["values"] is JArray values) || values.Count == 0 || values.Count > 500) return false;
            var ids = new HashSet<double>();
            foreach (var item in values) if (!Numeric(item) || !Number(item, out var id) || !ids.Add(id)) return false;
            return true;
        }
        private static bool ValidSnapshot(JObject value)
        {
            if (value == null || !Only(value, "version", "ready", "generation", "revision", "factoryId", "bindings")
                || !Numeric(value["version"]) || value.Value<double>("version") != 1 || value["ready"]?.Type != JTokenType.Boolean || !value.Value<bool>("ready")
                || !Numeric(value["generation"]) || !Number(value["generation"], out var generation) || generation < 0 || generation > 9007199254740991d || generation != Math.Truncate(generation)
                || !Text(value["revision"], 128, true) || !Text(value["factoryId"], 128, true) || !(value["bindings"] is JArray bindings) || bindings.Count > 102) return false;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var binding in bindings) if (!ValidDeclaration(binding) || !keys.Add(binding.Value<string>("key"))) return false;
            return true;
        }
        private static bool Timestamp(JToken token)
        {
            if (Number(token, out var numeric)) return numeric > 0;
            return token?.Type == JTokenType.String && DateTimeOffset.TryParse(token.Value<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time)
                && time.ToUnixTimeMilliseconds() > 0;
        }
        private static bool Observation(JObject frame, JObject declaration, out JToken raw)
        {
            raw = null; var source = (JObject)declaration["source"];
            if (source.Property("dataItemId") != null)
            {
                var item = (frame["motionInputs"] as JObject)?[source.Value<string>("actionId")] as JObject;
                if (item == null || item["dataItemId"]?.Type != JTokenType.String || item.Value<string>("dataItemId") != source.Value<string>("dataItemId")
                    || item["quality"] == null || item["quality"].Type == JTokenType.Null || !Good(item["quality"]) || !Timestamp(item["timestamp"])) return false;
                raw = item["value"]; return true;
            }
            var metadata = frame["pointMeta"] as JObject;
            var matches = metadata?.Properties().Where(property => property.Value is JObject && property.Value["id"]?.ToString() == source.Value<string>("pointId")).ToArray();
            if (matches == null || matches.Length != 1) return false;
            var address = matches[0].Name; var meta = (JObject)matches[0].Value; var separator = address.IndexOf('.');
            if (separator <= 0) return false;
            var group = meta.Value<string>("category") ?? address.Substring(0, separator);
            var field = meta.Value<string>("field_name") ?? address.Substring(separator + 1); var key = group + "." + field;
            var quality = ((frame["quality"] as JObject)?[group] as JObject)?[field];
            raw = (frame[group] as JObject)?[field];
            var kind = declaration.Value<string>("kind");
            return address == key && (source.Property("pointKey") == null || source.Value<string>("pointKey") == key)
                && ReferenceEquals(metadata?[key], meta) && Timestamp(meta["timestamp"]) && Good(meta["quality"]) && Good(quality)
                && !string.Equals(frame["status"]?["online"]?.ToString(), "false", StringComparison.OrdinalIgnoreCase) && Good(frame["status"]?["quality"])
                && raw != null && raw.Type != JTokenType.Null && (!(kind == "running_gate" || kind == "station") || quality != null && quality.Type != JTokenType.Null);
        }
        private static bool? Condition(JToken raw, JObject declaration, bool previous)
        {
            var expected = declaration["value"]; var operation = declaration.Value<string>("operator");
            if (!(Numeric(raw) && Numeric(expected)) && raw?.Type != expected?.Type) return null;
            if (Numeric(raw) && !Number(raw, out _)) return null;
            if (operation == "eq" || operation == "ne")
            {
                if (raw == null || !(Numeric(raw) || raw.Type == JTokenType.Boolean || raw.Type == JTokenType.String)) return null;
                var equal = Numeric(raw) ? Number(raw, out var number) && Number(expected, out var match) && number == match : JToken.DeepEquals(raw, expected);
                return operation == "eq" ? equal : !equal;
            }
            if (!Numeric(raw) || !Number(raw, out var value) || !Number(expected, out var threshold)) return null;
            if (previous) threshold += operation == "gt" || operation == "gte" ? -declaration.Value<double>("hysteresis") : declaration.Value<double>("hysteresis");
            return operation == "gt" ? value > threshold : operation == "gte" ? value >= threshold : operation == "lt" ? value < threshold : value <= threshold;
        }
        private static string DeclaredState(JObject frame, JObject declaration)
        {
            if (!Observation(frame, declaration, out var raw)) return "unavailable";
            var kind = declaration.Value<string>("kind");
            if (kind == "condition")
            {
                var a = Condition(raw, declaration, false); var b = Condition(raw, declaration, true);
                return a.HasValue && b.HasValue ? (a.Value ? "1" : "0") + (b.Value ? "1" : "0") : "invalid";
            }
            if (kind == "running_gate")
            {
                if (raw?.Type == JTokenType.Boolean) return raw.Value<bool>() ? "running" : "stopped";
                if (Number(raw, out var gate)) return Math.Abs(gate) > .0001 ? "running" : "stopped";
                if (raw?.Type != JTokenType.String) return "invalid";
                var text = raw.Value<string>();
                return string.Equals(text, "true", StringComparison.OrdinalIgnoreCase) || string.Equals(text, "on", StringComparison.OrdinalIgnoreCase) ? "running"
                    : string.Equals(text, "false", StringComparison.OrdinalIgnoreCase) || string.Equals(text, "off", StringComparison.OrdinalIgnoreCase) ? "stopped" : "invalid";
            }
            var catalog = declaration["source"]?["dataItemId"] != null;
            if (!Number(raw, out var value, (kind == "running" || kind == "signed_speed") && !catalog)) return "invalid";
            if (kind == "station")
            {
                var matches = declaration["values"].Where(item => Math.Abs(item.Value<double>() - value) <= .0001).ToArray();
                return matches.Length == 1 ? "station:" + matches[0].Value<double>().ToString("R", CultureInfo.InvariantCulture) : "invalid";
            }
            if (catalog && !Numeric(raw)) return "invalid";
            if (kind == "signed_speed")
            {
                // Same float32 expression as ModelBindingDriver. Raw RPM is
                // continuous; retain only stop/forward/reverse state changes.
                var angular = (float)value * declaration.Value<float>("speedFactor") * 57.29578f
                    * declaration.Value<float>("speed") * (declaration.Value<bool>("invert") ? -1 : 1);
                return !Finite(angular) ? "invalid" : angular == 0 ? "stopped" : angular < 0 ? "negative" : "positive";
            }
            var minimum = declaration.Value<double>("inputMin"); var maximum = declaration.Value<double>("inputMax");
            var p = Math.Max(0, Math.Min(1, (value - minimum) / (maximum - minimum)));
            if (declaration.Value<bool>("invert")) p = 1 - p;
            return p > .5 ? "running" : "stopped";
        }
        private static bool HasDeclaredMotionBoundary(JObject previous, JObject next)
        {
            var a = previous["motionSemantics"] as JObject; var b = next["motionSemantics"] as JObject;
            if (previous["motionSemantics"] == null && next["motionSemantics"] == null) return false;
            // Pending/malformed declarations are barriers, not a guessed
            // numeric protocol. The queue remains bounded and requests resync.
            if (!ValidSnapshot(a) || !ValidSnapshot(b)) return true;
            if (!JToken.DeepEquals(a["generation"], b["generation"]) || !JToken.DeepEquals(a["revision"], b["revision"])
                || !JToken.DeepEquals(a["factoryId"], b["factoryId"]) || !JToken.DeepEquals(a["bindings"], b["bindings"])) return true;
            foreach (var declaration in b["bindings"].OfType<JObject>())
                if (DeclaredState(previous, declaration) != DeclaredState(next, declaration)) return true;
            return false;
        }
        private static bool HasMotionBoundary(JObject previous, JObject next)
        {
            if (Scope(previous["payload"]) != Scope(next["payload"])) return true;
            var byId = new Dictionary<string, JObject>(StringComparer.Ordinal);
            foreach (var device in previous["payload"]["devices"].OfType<JObject>()) byId[device.Value<string>("furnace_id") ?? string.Empty] = device;
            foreach (var device in next["payload"]["devices"].OfType<JObject>())
                if (byId.TryGetValue(device.Value<string>("furnace_id") ?? string.Empty, out var prior)
                    && (Scope(prior) != Scope(device) || DeviceMotionBoundary(prior, device))) return true;
            return false;
        }
        private static JObject MergePatch(JObject previous, JObject patch)
        {
            var result = (JObject)previous.DeepClone();
            foreach (var property in patch.Properties())
                result[property.Name] = property.Name != "motionInputs" && property.Name != "motionSemantics" && property.Value is JObject value && result[property.Name] is JObject prior
                    ? MergePatch(prior, value) : property.Value.DeepClone();
            return result;
        }
        private static JObject MergeRealtime(JObject previous, JObject next)
        {
            var devices = new Dictionary<string, JObject>(StringComparer.Ordinal);
            var order = new List<string>();
            foreach (var frame in new[] { previous, next })
            {
                if (!(frame["payload"]?["devices"] is JArray patches)) throw new InvalidOperationException("Invalid realtime patch array");
                foreach (var token in patches)
                {
                    if (!(token is JObject device)) throw new InvalidOperationException("Invalid realtime device");
                    var id = device.Value<string>("furnace_id");
                    if (string.IsNullOrEmpty(id)) throw new InvalidOperationException("Missing realtime device identity");
                    if (!devices.TryGetValue(id, out var prior)) { order.Add(id); prior = new JObject(); }
                    devices[id] = MergePatch(prior, device);
                }
            }
            var result = (JObject)next.DeepClone();
            var array = new JArray(); foreach (var id in order) array.Add(devices[id]);
            result["payload"]["devices"] = array; return result;
        }
    }
}
