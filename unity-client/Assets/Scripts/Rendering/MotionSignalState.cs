using System;
using System.Globalization;
using Newtonsoft.Json.Linq;
namespace HeatTreatment.DigitalTwin.Rendering
{
    // Read-only signal interpretation, shared by native playback and deterministic checks.
    public sealed class MotionSignalState
    {
        public double Position, Target, Seconds, NumericValue, ReceivedAt = double.NegativeInfinity;
        public double SourceTimestamp = double.NaN, SourceStaleMs = double.PositiveInfinity;
        public bool HasSample, Usable, Running, Recovering;
        public string EndpointStage;
        private double _extendedTimestamp = double.NaN, _retractedTimestamp = double.NaN;
        private double _extendedReceivedAt = double.NegativeInfinity, _retractedReceivedAt = double.NegativeInfinity;
        private double _extendedStaleMs = double.PositiveInfinity, _retractedStaleMs = double.PositiveInfinity;
        private bool _endpointNeedsResync = true;
        private bool? _condition;
        public string Reason = "等待数据";
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static bool Good(JToken value) => value == null || string.Equals(value.ToString(), "good", StringComparison.OrdinalIgnoreCase);
        private static double Timestamp(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Boolean) return double.NaN;
            if (double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return Finite(number) && number > 0 ? number : double.NaN;
            return token.Type == JTokenType.String && DateTimeOffset.TryParse(token.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date.ToUnixTimeMilliseconds() : double.NaN;
        }
        private static bool Number(JToken token, out double number)
        {
            number = 0;
            if (token?.Type == JTokenType.Boolean) { number = token.Value<bool>() ? 1 : 0; return true; }
            return token != null && (token.Type == JTokenType.Integer || token.Type == JTokenType.Float || token.Type == JTokenType.String)
                && double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && Finite(number);
        }
        private void Freeze(string reason) { Usable = false; Running = false; Reason = reason; }
        private void FreezeEndpoint(string reason, string stage = "invalid") { EndpointStage = stage; if (stage != "waiting") _endpointNeedsResync = true; Freeze(reason); }
        public static bool IsEndpointBinding(JObject binding) => binding?["trigger"]?.Value<string>("mode") == "endpoints";
        public static bool IsCatalogBinding(JObject binding) => IsEndpointBinding(binding) || !string.IsNullOrEmpty(binding?.Value<string>("dataItemId"));
        public JObject CaptureEndpointDisplayState(JObject binding)
        {
            return IsEndpointBinding(binding) ? CaptureDisplayState(binding) : null;
        }
        public JObject CaptureDisplayState(JObject binding)
        {
            if (binding == null || !HasSample) return null;
            return new JObject {
                ["binding"] = binding.DeepClone(), ["position"] = Position, ["target"] = Target, ["numericValue"] = NumericValue,
                ["usable"] = Usable, ["receivedAt"] = ReceivedAt, ["sourceTimestamp"] = SourceTimestamp, ["sourceStaleMs"] = SourceStaleMs,
                ["extendedTimestamp"] = _extendedTimestamp, ["retractedTimestamp"] = _retractedTimestamp,
                ["extendedReceivedAt"] = _extendedReceivedAt, ["retractedReceivedAt"] = _retractedReceivedAt,
                ["extendedStaleMs"] = _extendedStaleMs, ["retractedStaleMs"] = _retractedStaleMs,
                ["needsResync"] = _endpointNeedsResync, ["reason"] = Reason, ["stage"] = EndpointStage,
                ["seconds"] = Seconds, ["running"] = Running, ["recovering"] = Recovering,
                ["condition"] = _condition
            };
        }
        public bool RestoreEndpointDisplayState(JObject binding, JObject snapshot)
        {
            return IsEndpointBinding(binding) && RestoreDisplayState(binding, snapshot);
        }
        public bool RestoreDisplayState(JObject binding, JObject snapshot)
        {
            if (binding == null || snapshot == null || !JToken.DeepEquals(binding, snapshot["binding"])) return false;
            var position = snapshot.Value<double?>("position") ?? double.NaN; var target = snapshot.Value<double?>("target") ?? double.NaN;
            if (!Finite(position) || !Finite(target) || position < 0 || position > 1 || target < 0 || target > 1) return false;
            Position = position; Target = target; NumericValue = snapshot.Value<double>("numericValue"); HasSample = true;
            Usable = snapshot.Value<bool>("usable"); Running = !IsEndpointBinding(binding) && snapshot.Value<bool>("running"); Recovering = !IsEndpointBinding(binding) && snapshot.Value<bool>("recovering");
            Seconds = IsEndpointBinding(binding) ? 0 : snapshot.Value<double>("seconds"); _condition = snapshot.Value<bool?>("condition");
            ReceivedAt = snapshot.Value<double>("receivedAt"); SourceTimestamp = snapshot.Value<double>("sourceTimestamp"); SourceStaleMs = snapshot.Value<double>("sourceStaleMs");
            _extendedTimestamp = snapshot.Value<double>("extendedTimestamp"); _retractedTimestamp = snapshot.Value<double>("retractedTimestamp");
            _extendedReceivedAt = snapshot.Value<double>("extendedReceivedAt"); _retractedReceivedAt = snapshot.Value<double>("retractedReceivedAt");
            _extendedStaleMs = snapshot.Value<double>("extendedStaleMs"); _retractedStaleMs = snapshot.Value<double>("retractedStaleMs");
            _endpointNeedsResync = snapshot.Value<bool>("needsResync"); Reason = snapshot.Value<string>("reason"); EndpointStage = snapshot.Value<string>("stage");
            return true;
        }
        private void ReceiveEndpoints(JObject frame, JObject binding, double now, double? wallNow)
        {
            var trigger = binding["trigger"] as JObject;
            var item = frame?["motionInputs"]?[binding.Value<string>("actionId") ?? ""] as JObject;
            var feedback = item?["endpointFeedback"] as JObject;
            var extended = feedback?["extended"] as JObject; var retracted = feedback?["retracted"] as JObject;
            var extendedId = trigger?["extended"]?.Value<string>("dataItemId"); var retractedId = trigger?["retracted"]?.Value<string>("dataItemId");
            if (string.IsNullOrEmpty(extendedId) || string.IsNullOrEmpty(retractedId) || extendedId == retractedId
                || extended?.Value<string>("dataItemId") != extendedId || retracted?.Value<string>("dataItemId") != retractedId
                || extended?["value"]?.Type != JTokenType.Boolean || retracted?["value"]?.Type != JTokenType.Boolean)
            { FreezeEndpoint("到位反馈无效"); return; }
            var extendedStamp = Timestamp(extended["timestamp"]); var retractedStamp = Timestamp(retracted["timestamp"]);
            var envelope = Timestamp(frame?["timestamp"]); var reference = Finite(envelope) ? envelope : wallNow ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var sourceStale = string.Equals(extended.Value<string>("quality"), "stale", StringComparison.OrdinalIgnoreCase)
                || string.Equals(retracted.Value<string>("quality"), "stale", StringComparison.OrdinalIgnoreCase);
            if (!Finite(extendedStamp) || !Finite(retractedStamp) || extended["quality"] == null || retracted["quality"] == null || !Good(extended["quality"]) || !Good(retracted["quality"]))
            { FreezeEndpoint(sourceStale ? "数据超时" : "到位反馈无效"); return; }
            if (extendedStamp > reference + 1000 || retractedStamp > reference + 1000) { FreezeEndpoint("数据时间无效"); return; }
            // A newer read of one endpoint cannot make an older read of the other
            // endpoint fresh, or splice two incompatible observations together.
            if (Finite(_extendedTimestamp) && extendedStamp < _extendedTimestamp || Finite(_retractedTimestamp) && retractedStamp < _retractedTimestamp) return;
            var extendedAt = now - Math.Max(0, (reference - extendedStamp) / 1000); var retractedAt = now - Math.Max(0, (reference - retractedStamp) / 1000);
            _extendedReceivedAt = extendedStamp != _extendedTimestamp ? extendedAt : Math.Min(_extendedReceivedAt, extendedAt);
            _retractedReceivedAt = retractedStamp != _retractedTimestamp ? retractedAt : Math.Min(_retractedReceivedAt, retractedAt);
            _extendedTimestamp = extendedStamp; _retractedTimestamp = retractedStamp;
            ReceivedAt = Math.Min(_extendedReceivedAt, _retractedReceivedAt); SourceTimestamp = Math.Min(extendedStamp, retractedStamp);
            Number(extended["staleMs"], out var extendedStale); Number(retracted["staleMs"], out var retractedStale);
            _extendedStaleMs = Finite(extendedStale) && extendedStale > 0 ? extendedStale : 5000;
            _retractedStaleMs = Finite(retractedStale) && retractedStale > 0 ? retractedStale : 5000;
            SourceStaleMs = Math.Min(_extendedStaleMs, _retractedStaleMs);
            if (now - _extendedReceivedAt > _extendedStaleMs / 1000 || now - _retractedReceivedAt > _retractedStaleMs / 1000) { FreezeEndpoint("数据超时"); return; }
            var isExtended = extended.Value<bool>("value"); var isRetracted = retracted.Value<bool>("value");
            Recovering = false; Running = false;
            if (isExtended && isRetracted) { FreezeEndpoint("到位反馈冲突", "conflict"); return; }
            if (item?["quality"] == null || !Good(item["quality"])) { FreezeEndpoint(string.Equals(item.Value<string>("quality"), "stale", StringComparison.OrdinalIgnoreCase) ? "数据超时" : "到位反馈无效"); return; }
            if (!isExtended && !isRetracted) { FreezeEndpoint("等待到位反馈", "waiting"); return; }
            EndpointStage = isExtended ? "extended" : "retracted";
            Target = isExtended ? 1 : 0; if (binding.Value<bool?>("invert") == true) Target = 1 - Target;
            // Endpoint bits confirm the target. Healthy updates may visually
            // smooth that confirmed change, not estimate an actual intermediate
            // position. Initial acquisition/reconnect aligns directly to the
            // latest endpoint and never continues a pre-disconnect timer.
            if (!HasSample || _endpointNeedsResync || (binding.Value<double?>("transitionSeconds") ?? 0) <= 0) Position = Target;
            _endpointNeedsResync = false;
            NumericValue = Target; HasSample = true; Usable = true;
            Reason = isExtended ? "推料到位" : "退回到位";
        }
        public static bool? EvaluateCondition(JToken raw, JObject trigger, bool? previous = null)
        {
            var expected = trigger?["value"]; var operation = trigger?.Value<string>("operator") ?? "eq";
            bool Numeric(JToken value) => value?.Type == JTokenType.Integer || value?.Type == JTokenType.Float;
            if (raw == null || expected == null || (!Numeric(raw) && raw.Type != JTokenType.Boolean && raw.Type != JTokenType.String)) return null;
            if (operation == "eq" || operation == "ne")
            {
                if (Numeric(raw) != Numeric(expected) || !Numeric(raw) && raw.Type != expected.Type) return null;
                if (Numeric(raw) && (!Number(raw, out _) || !Number(expected, out _))) return null;
                var equal = Numeric(raw) ? raw.Value<double>() == expected.Value<double>() : JToken.DeepEquals(raw, expected);
                return operation == "eq" ? equal : !equal;
            }
            if (!Numeric(raw) || !Numeric(expected) || !Number(raw, out var value) || !Number(expected, out var threshold)) return null;
            var hysteresis = trigger.Value<double?>("hysteresis") ?? 0; if (!Finite(hysteresis) || hysteresis < 0) hysteresis = 0;
            var greater = operation == "gt" || operation == "gte";
            if (previous == true) threshold += greater ? -hysteresis : hysteresis;
            switch (operation) { case "gt": return value > threshold; case "gte": return value >= threshold; case "lt": return value < threshold; case "lte": return value <= threshold; default: return null; }
        }
        public void Receive(JObject frame, JObject binding, double now, double? wallNow = null)
        {
            if (!Finite(now)) return;
            if (IsEndpointBinding(binding)) { ReceiveEndpoints(frame, binding, now, wallNow); return; }
            var group = binding.Value<string>("sourceGroup") ?? "analog";
            var key = binding.Value<string>("sourceKey") ?? "";
            var meta = frame?["pointMeta"]?[group + "." + key];
            var catalog = IsCatalogBinding(binding);
            if (!catalog && (frame?.Value<bool?>("motionInputOnly") == true || frame?["motionInputs"] != null && frame[group] == null && frame["pointMeta"] == null && frame["status"] == null && frame["quality"] == null)) return;
            var item = catalog ? frame?["motionInputs"]?[binding.Value<string>("actionId") ?? ""] as JObject : null;
            var token = catalog ? item?["value"] : frame?[group]?[key];
            var stamp = Timestamp(catalog ? item?["timestamp"] : meta?["timestamp"]); var envelope = Timestamp(frame?["timestamp"]);
            var wasUsable = Usable;
            var identity = catalog ? item != null && item.Value<string>("dataItemId") == binding.Value<string>("dataItemId")
                : meta?["id"] == null || meta.Value<string>("id") == binding.Value<string>("pointId");
            // A valid catalog observation (e.g. online=false) is independent of PLC connectivity.
            var qualityGood = catalog ? item?["quality"] != null && Good(item["quality"])
                : frame != null && !string.Equals(frame["status"]?["online"]?.ToString(), "false", StringComparison.OrdinalIgnoreCase)
                    && Good(frame["status"]?["quality"]) && Good(frame["quality"] is JObject quality ? quality["overall"] : frame["quality"])
                    && Good((frame["quality"] as JObject)?[group]?[key]);
            if (!identity || !qualityGood || catalog && !Finite(stamp)) { Freeze(string.Equals(item?["quality"]?.ToString(), "stale", StringComparison.OrdinalIgnoreCase) ? "数据超时" : "数据无效"); return; }
            if (Finite(stamp) && Finite(SourceTimestamp) && stamp < SourceTimestamp) return;
            var reference = Finite(envelope) ? envelope : wallNow ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (Finite(stamp) && stamp > reference + 1000) { Freeze("数据时间无效"); return; }
            var sourceAt = now - (Finite(stamp) ? Math.Max(0, (reference - stamp) / 1000) : 0);
            if (!Finite(stamp) || stamp != SourceTimestamp) { ReceivedAt = sourceAt; SourceTimestamp = stamp; }
            else ReceivedAt = Math.Min(ReceivedAt, sourceAt);
            Number(item?["staleMs"], out var stale); SourceStaleMs = catalog && Finite(stale) && stale > 0 ? stale : double.PositiveInfinity;
            if (now - ReceivedAt > SourceStaleMs / 1000) { Freeze("数据超时"); return; }
            var minimum = binding.Value<double?>("inputMin") ?? 0; var maximum = binding.Value<double?>("inputMax") ?? 1;
            var condition = binding["trigger"] is JObject trigger && trigger.Value<string>("mode") == "condition";
            double p; double value = 0;
            if (condition)
            {
                var result = EvaluateCondition(token, (JObject)binding["trigger"], _condition);
                if (!result.HasValue) { Freeze("数据类型无效"); return; }
                _condition = result; p = result.Value ? 1 : 0;
            }
            else
            {
                if (catalog && token?.Type != JTokenType.Integer && token?.Type != JTokenType.Float) { Freeze("数据类型无效"); return; }
                if (!Number(token, out value) || !Finite(minimum) || !Finite(maximum) || maximum <= minimum) { Freeze("数据无效"); return; }
                p = Math.Max(0, Math.Min(1, (value - minimum) / (maximum - minimum)));
            }
            if (binding.Value<bool?>("invert") == true) p = 1 - p;
            Target = p; NumericValue = condition ? p : value;
            Recovering = HasSample && !wasUsable || Recovering;
            if (!HasSample || (binding.Value<double?>("transitionSeconds") ?? 0) <= 0 && !Recovering) Position = p;
            Usable = true; Running = p > .5; HasSample = true; Reason = Running ? "运行" : "停止";
        }
        public void Step(double delta, double now, double staleMs, JObject binding)
        {
            if (IsEndpointBinding(binding))
            {
                var configTimeout = Finite(staleMs) && staleMs > 0 ? staleMs : 5000;
                if (now - _extendedReceivedAt > Math.Min(configTimeout, _extendedStaleMs) / 1000 || now - _retractedReceivedAt > Math.Min(configTimeout, _retractedStaleMs) / 1000) FreezeEndpoint("数据超时");
                if (Usable && delta > 0 && Finite(delta))
                {
                    var displayDuration = binding.Value<double?>("transitionSeconds") ?? 0;
                    var displayStep = displayDuration > 0 ? delta / displayDuration : double.PositiveInfinity;
                    Position += Math.Sign(Target - Position) * Math.Min(Math.Abs(Target - Position), displayStep);
                }
                return;
            }
            var timeout = Math.Min(Finite(staleMs) && staleMs > 0 ? staleMs : 5000, SourceStaleMs);
            if (now - ReceivedAt > timeout / 1000) Freeze("数据超时");
            if (!Usable || delta <= 0 || double.IsNaN(delta) || double.IsInfinity(delta)) return;
            var duration = binding.Value<double?>("transitionSeconds") ?? 0; if (duration <= 0 && Recovering) duration = .2;
            var step = duration > 0 ? delta / duration : double.PositiveInfinity;
            Position += Math.Sign(Target - Position) * Math.Min(Math.Abs(Target - Position), step);
            if (Position == Target) Recovering = false;
            if (Running) Seconds += delta * (binding.Value<double?>("speed") ?? 1);
        }
        public static double[] Sample(JObject clip, JObject track, double seconds)
        {
            var result = new double[track.Value<int>("size")]; SampleInto(clip,track,seconds,result); return result;
        }
        public static void SampleInto(JObject clip, JObject track, double seconds, double[] result)
        {
            var count = clip.Value<int>("count"); var duration = clip.Value<double>("duration"); var size = track.Value<int>("size"); var values = (JArray)track["values"];
            if (count < 2 || duration <= 0 || size < 1 || size > 4 || values == null || values.Count != count * size) throw new InvalidOperationException("Invalid animation track");
            var offset = Math.Max(0, Math.Min(1, seconds / duration)) * (count - 1);
            var left = Math.Min(count - 1, (int)Math.Floor(offset)); var right = Math.Min(count - 1, left + 1); var t = offset - left;
            if (track.Value<string>("channel") == "v") t = 0;
            var sign = 1d;
            if (track.Value<string>("channel") == "q") { double dot = 0; for (var i = 0; i < 4; i++) dot += values[left * size + i].Value<double>() * values[right * size + i].Value<double>(); if (dot < 0) sign = -1; }
            for (var i = 0; i < size; i++) result[i] = values[left * size + i].Value<double>() * (1 - t) + sign * values[right * size + i].Value<double>() * t;
        }
    }
}
