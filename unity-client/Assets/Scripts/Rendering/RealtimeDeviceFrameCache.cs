using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Full PLC telemetry replay cache; separate from catalog-only motion packets.
    // Preserve original point observations and advance only their clock envelope.
    public sealed class RealtimeDeviceFrameCache
    {
        private readonly Dictionary<string, JObject> _frames = new Dictionary<string, JObject>();
        private readonly Dictionary<string, double> _receivedAt = new Dictionary<string, double>();
        public void Remember(string deviceId, JObject frame, double now)
            => RememberCore(deviceId, frame, now, false);

        // The socket inbox transfers this parsed packet to the runtime; all
        // consumers only read it. Retain that immutable packet instead of making
        // a second full telemetry tree on Unity's render thread for every scan.
        // TryGet still returns a defensive copy with the original source ages.
        public void RememberOwned(string deviceId, JObject frame, double now)
            => RememberCore(deviceId, frame, now, true);

        private void RememberCore(string deviceId, JObject frame, double now, bool owned)
        {
            if (string.IsNullOrWhiteSpace(deviceId) || frame == null || frame.Value<bool?>("motionInputOnly") == true
                || double.IsNaN(now) || double.IsInfinity(now)) return;
            var stamp = Timestamp(frame["timestamp"]);
            var priorStamp = _frames.TryGetValue(deviceId, out var prior) ? Timestamp(prior["timestamp"]) : 0;
            if (stamp > 0 && priorStamp > stamp && !Invalid(frame)) return;
            _frames[deviceId] = owned ? frame : (JObject)frame.DeepClone();
            if (!_receivedAt.ContainsKey(deviceId) || stamp > priorStamp || stamp == 0 && priorStamp == 0) _receivedAt[deviceId] = now;
        }
        private static bool Invalid(JObject frame)
        {
            return frame["status"]?["online"]?.ToString().Equals("false", StringComparison.OrdinalIgnoreCase) == true
                || InvalidQuality(frame["quality"]) || InvalidQuality(frame["status"]?["quality"]);
        }
        private static bool InvalidQuality(JToken token)
        {
            if (token is JObject obj) foreach (var field in obj.Properties()) if (InvalidQuality(field.Value)) return true;
            return token?.Type == JTokenType.String && (token.Value<string>().Equals("bad", StringComparison.OrdinalIgnoreCase) || token.Value<string>().Equals("stale", StringComparison.OrdinalIgnoreCase));
        }
        public bool TryGet(string deviceId, out JObject frame, double now)
        {
            frame = null;
            if (!_frames.TryGetValue(deviceId, out var cached)) return false;
            frame = (JObject)cached.DeepClone();
            var stamp = Timestamp(cached["timestamp"]);
            if (stamp > 0) frame["timestamp"] = stamp + Math.Max(0, now - _receivedAt[deviceId]) * 1000;
            // Legacy packets have no source timestamps. Make their age explicit
            // too; an old full frame cannot become fresh merely by rebuilding.
            frame["cachedAgeMs"] = Math.Max(0, now - _receivedAt[deviceId]) * 1000;
            return true;
        }
        private static double Timestamp(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Boolean) return 0;
            if (double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return !double.IsNaN(number) && !double.IsInfinity(number) && number > 0 ? number : 0;
            return token.Type == JTokenType.String && DateTimeOffset.TryParse(token.Value<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time) ? time.ToUnixTimeMilliseconds() : 0;
        }
        public void Clear() { _frames.Clear(); _receivedAt.Clear(); }
    }
}
