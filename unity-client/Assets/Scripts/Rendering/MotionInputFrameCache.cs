using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Catalog-only replay cache. Deliberately contains no PLC groups, status or transport receipt time.
    public sealed class MotionInputFrameCache
    {
        private readonly Dictionary<string, JObject> _frames = new Dictionary<string, JObject>();
        private readonly Dictionary<string, double> _receivedAt = new Dictionary<string, double>();
        public void Remember(string deviceId, JObject frame, double? now = null)
        {
            if (string.IsNullOrEmpty(deviceId) || !(frame?["motionInputs"] is JObject incoming)) return;
            if (!_frames.TryGetValue(deviceId, out var cached))
                cached = new JObject { ["furnace_id"] = deviceId, ["motionInputOnly"] = true, ["motionInputs"] = new JObject() };
            var inputs = (JObject)cached["motionInputs"];
            // Each packet is a complete catalog snapshot for this device, not a
            // delta. An omitted action must never fall back to a cached good value.
            foreach (var prior in inputs.Properties().ToArray()) if (incoming.Property(prior.Name) == null) prior.Remove();
            foreach (var item in incoming.Properties())
            {
                var prior = inputs[item.Name] as JObject; var next = item.Value as JObject;
                var priorPair = prior?["endpointFeedback"] as JObject; var nextPair = next?["endpointFeedback"] as JObject;
                var pairOlder = false;
                if (priorPair != null && nextPair != null)
                {
                    foreach (var endpoint in new[] { "extended", "retracted" })
                    {
                        var before = priorPair[endpoint] as JObject; var after = nextPair[endpoint] as JObject;
                        if (before?.Value<string>("dataItemId") != after?.Value<string>("dataItemId")) continue;
                        var beforeStamp = before?.Value<double?>("timestamp"); var afterStamp = after?.Value<double?>("timestamp");
                        if (beforeStamp.HasValue && afterStamp.HasValue && afterStamp < beforeStamp) pairOlder = true;
                    }
                    // Reject the complete old pair; merging endpoint values would
                    // manufacture a combination that was never actually observed.
                    if (pairOlder && string.Equals(next.Value<string>("quality"), "good", StringComparison.OrdinalIgnoreCase)) continue;
                }
                var priorStamp = prior?.Value<double?>("timestamp"); var nextStamp = next?.Value<double?>("timestamp");
                var replacement = next == null ? new JObject { ["dataItemId"] = prior?["dataItemId"]?.DeepClone(), ["value"] = null, ["quality"] = "bad" } : (JObject)next.DeepClone();
                if (pairOlder)
                {
                    foreach (var endpoint in new[] { "extended", "retracted" })
                    {
                        var before = priorPair[endpoint] as JObject; var after = replacement["endpointFeedback"]?[endpoint] as JObject;
                        if (before?.Value<string>("dataItemId") != after?.Value<string>("dataItemId")) continue;
                        var beforeStamp = before?.Value<double?>("timestamp"); var afterStamp = after?.Value<double?>("timestamp");
                        if (beforeStamp.HasValue && (!afterStamp.HasValue || afterStamp < beforeStamp)) { after["timestamp"] = beforeStamp.Value; after["quality"] = "bad"; }
                    }
                    replacement["quality"] = "bad";
                }
                if (priorStamp.HasValue && (next == null || prior?.Value<string>("dataItemId") == next.Value<string>("dataItemId")))
                {
                    if (nextStamp.HasValue && nextStamp < priorStamp)
                    {
                        if (string.Equals(next.Value<string>("quality"), "good", StringComparison.OrdinalIgnoreCase)) continue;
                        replacement["timestamp"] = priorStamp.Value;
                    }
                    else if (!nextStamp.HasValue) { replacement["timestamp"] = priorStamp.Value; replacement["quality"] = "bad"; }
                }
                inputs[item.Name] = replacement;
            }
            var priorEnvelope = cached.Value<double?>("timestamp") ?? 0; var nextEnvelope = frame.Value<double?>("timestamp") ?? 0;
            cached["timestamp"] = Math.Max(priorEnvelope, nextEnvelope);
            if (!_receivedAt.ContainsKey(deviceId) || nextEnvelope > priorEnvelope) _receivedAt[deviceId] = now ?? Time.realtimeSinceStartupAsDouble;
            _frames[deviceId] = cached;
        }
        public bool TryGet(string deviceId, out JObject frame, double? now = null)
        {
            frame = null;
            if (!_frames.TryGetValue(deviceId, out var cached)) return false;
            frame = (JObject)cached.DeepClone();
            // Recreating a model is not a source refresh. Advance only the envelope's
            // clock bridge, retaining every original source-read timestamp and quality.
            frame["timestamp"] = (cached.Value<double?>("timestamp") ?? 0) + Math.Max(0, (now ?? Time.realtimeSinceStartupAsDouble) - _receivedAt[deviceId]) * 1000;
            return true;
        }
        public void Clear() { _frames.Clear(); _receivedAt.Clear(); }
    }
}
