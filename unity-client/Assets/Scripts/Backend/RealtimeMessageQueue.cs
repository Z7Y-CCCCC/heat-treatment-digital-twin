using System;
using System.Collections.Generic;
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
                var kind = type == "realtime_frame" && !HasFault(message["payload"]?["devices"])
                    ? "realtime" : type == "scene_projection" ? "projection" : "reliable";
                var previous = _entries.Last?.Value;
                var replacing = kind != "reliable" && previous?.Kind == kind;
                var merged = replacing && kind == "realtime" ? MergeRealtime(previous.Message, message) : message;
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
            if (token is JObject device && device["furnace_id"] != null) return HasFault(device["quality"]);
            if (token is JContainer container) { foreach (var child in container.Children()) if (HasFault(child)) return true; }
            return token is JValue value && (value.Value as string == "bad" || value.Value as string == "stale");
        }
        private static JObject MergePatch(JObject previous, JObject patch)
        {
            var result = (JObject)previous.DeepClone();
            foreach (var property in patch.Properties())
                result[property.Name] = property.Value is JObject value && result[property.Name] is JObject prior
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
