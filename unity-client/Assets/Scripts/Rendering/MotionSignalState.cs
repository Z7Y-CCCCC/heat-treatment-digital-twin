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
        private bool _observationAccepted;
        // A bounded, display-only source history. Target/NumericValue/Running
        // continue to describe the newest real observation, never this buffer.
        private const int FeedbackHistoryCapacity = 64;
        private readonly double[] _feedbackTimes = new double[FeedbackHistoryCapacity];
        private readonly double[] _feedbackPositions = new double[FeedbackHistoryCapacity];
        private int _feedbackStart, _feedbackCount;
        private bool _feedbackNumeric;
        private double _feedbackDelay, _feedbackPlayhead = double.NegativeInfinity;
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
        private void ClearFeedbackHistory()
        {
            _feedbackStart = _feedbackCount = 0;
            _feedbackNumeric = false; _feedbackDelay = 0; _feedbackPlayhead = double.NegativeInfinity;
        }
        private static double FeedbackDelay(JObject binding)
        {
            var mode = binding?.Value<string>("mode"); var triggerMode = binding?["trigger"]?.Value<string>("mode");
            if (mode != "position" || triggerMode == "condition" || triggerMode == "endpoints") return 0;
            var token = binding?["feedbackSmoothingMs"];
            if (token?.Type != JTokenType.Integer && token?.Type != JTokenType.Float) return 0;
            var milliseconds = (double)token;
            return Finite(milliseconds) && milliseconds > 0 && milliseconds <= 1000 ? milliseconds / 1000 : 0;
        }
        private int FeedbackIndex(int offset) => (_feedbackStart + offset) % FeedbackHistoryCapacity;
        private void SeedFeedback(double sourceAt, double position, double delay)
        {
            ClearFeedbackHistory(); _feedbackNumeric = true; _feedbackDelay = delay;
            _feedbackTimes[0] = sourceAt; _feedbackPositions[0] = position; _feedbackCount = 1;
            Position = position;
        }
        private void PruneFeedback(double playhead)
        {
            // Retain the last sample on the left of the displayed time. A full
            // buffer must not discard an unshown peak/reversal to make room.
            while (_feedbackCount > 1 && _feedbackTimes[FeedbackIndex(1)] <= playhead)
            { _feedbackStart = FeedbackIndex(1); _feedbackCount--; }
        }
        private void ReceiveFeedback(double position, double numeric, double priorNumeric, double stamp, double priorStamp,
            double sourceAt, double delay, bool align)
        {
            if (align || !_feedbackNumeric || _feedbackDelay != delay || _feedbackCount == 0)
            { SeedFeedback(sourceAt, position, delay); Recovering = false; return; }
            if (Finite(stamp) && stamp == priorStamp)
            {
                // Duplicate wrappers neither add invented samples nor renew
                // freshness. Conflicting values with the same source time
                // retain the old raw interpretation but cannot form a slope.
                if (numeric != priorNumeric) SeedFeedback(sourceAt, position, delay);
                return;
            }
            if (sourceAt <= _feedbackTimes[FeedbackIndex(_feedbackCount - 1)])
            { SeedFeedback(sourceAt, position, delay); return; }
            if (_feedbackCount == FeedbackHistoryCapacity) PruneFeedback(_feedbackPlayhead);
            if (_feedbackCount == FeedbackHistoryCapacity)
            { SeedFeedback(sourceAt, position, delay); return; }
            var index = FeedbackIndex(_feedbackCount++);
            _feedbackTimes[index] = sourceAt; _feedbackPositions[index] = position;
        }
        private void StepFeedback(double now)
        {
            if (!Finite(now) || _feedbackCount == 0) return;
            var playhead = now - _feedbackDelay;
            if (playhead < _feedbackPlayhead) return;
            PruneFeedback(playhead); _feedbackPlayhead = Math.Max(_feedbackPlayhead, playhead);
            var left = _feedbackStart; var leftAt = _feedbackTimes[left];
            if (_feedbackCount == 1 || playhead <= leftAt) { Position = _feedbackPositions[left]; return; }
            var right = FeedbackIndex(1); var rightAt = _feedbackTimes[right];
            var t = Math.Max(0, Math.Min(1, (playhead - leftAt) / (rightAt - leftAt)));
            Position = _feedbackPositions[left] + (_feedbackPositions[right] - _feedbackPositions[left]) * t;
        }
        private void Freeze(string reason) { Usable = false; Running = false; Reason = reason; ClearFeedbackHistory(); }
        private void FreezeEndpoint(string reason, string stage = "invalid") { EndpointStage = stage; if (stage != "waiting") _endpointNeedsResync = true; Freeze(reason); }
        public void Suspend(string reason = "采集连接中断")
        {
            if (HasSample) Recovering = true;
            _endpointNeedsResync = true; Freeze(reason);
        }
        public static bool IsEndpointBinding(JObject binding) => binding?["trigger"]?.Value<string>("mode") == "endpoints";
        public static bool IsCatalogBinding(JObject binding) => IsEndpointBinding(binding) || !string.IsNullOrEmpty(binding?.Value<string>("dataItemId"));
        public JObject CaptureEndpointDisplayState(JObject binding)
        {
            return IsEndpointBinding(binding) ? CaptureDisplayState(binding) : null;
        }
        public JObject CaptureDisplayState(JObject binding)
        {
            if (binding == null || !HasSample) return null;
            var snapshot = new JObject {
                ["binding"] = binding.DeepClone(), ["position"] = Position, ["target"] = Target, ["numericValue"] = NumericValue,
                ["usable"] = Usable, ["receivedAt"] = ReceivedAt, ["sourceTimestamp"] = SourceTimestamp, ["sourceStaleMs"] = SourceStaleMs,
                ["extendedTimestamp"] = _extendedTimestamp, ["retractedTimestamp"] = _retractedTimestamp,
                ["extendedReceivedAt"] = _extendedReceivedAt, ["retractedReceivedAt"] = _retractedReceivedAt,
                ["extendedStaleMs"] = _extendedStaleMs, ["retractedStaleMs"] = _retractedStaleMs,
                ["needsResync"] = _endpointNeedsResync, ["reason"] = Reason, ["stage"] = EndpointStage,
                ["seconds"] = Seconds, ["running"] = Running, ["recovering"] = Recovering,
                ["condition"] = _condition, ["feedbackNumeric"] = _feedbackNumeric
            };
            if (_feedbackNumeric && _feedbackCount > 0 && FeedbackDelay(binding) == _feedbackDelay)
            {
                var history = new JArray();
                for (var i = 0; i < _feedbackCount; i++)
                { var index = FeedbackIndex(i); history.Add(new JArray(_feedbackTimes[index], _feedbackPositions[index])); }
                snapshot["feedbackHistory"] = history; snapshot["feedbackDelay"] = _feedbackDelay;
                snapshot["feedbackPlayhead"] = _feedbackPlayhead;
            }
            return snapshot;
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
            ClearFeedbackHistory();
            var delay = FeedbackDelay(binding);
            var history = snapshot["feedbackHistory"] as JArray;
            if (Usable && delay > 0 && snapshot.Value<bool?>("feedbackNumeric") == true)
            {
                var valid = snapshot.Value<double?>("feedbackDelay") == delay && history != null && history.Count > 0 && history.Count <= FeedbackHistoryCapacity;
                var lastAt = double.NegativeInfinity;
                for (var i = 0; valid && i < history.Count; i++)
                {
                    var token = history[i];
                    var pair = token as JArray;
                    if (pair == null || pair.Count != 2
                        || pair[0].Type != JTokenType.Integer && pair[0].Type != JTokenType.Float
                        || pair[1].Type != JTokenType.Integer && pair[1].Type != JTokenType.Float
                        || !Number(pair[0], out var at) || !Number(pair[1], out var p) || at <= lastAt || p < 0 || p > 1)
                    { valid = false; break; }
                    _feedbackTimes[_feedbackCount] = at; _feedbackPositions[_feedbackCount++] = p; lastAt = at;
                }
                if (valid && _feedbackPositions[_feedbackCount - 1] == Target)
                {
                    _feedbackNumeric = true; _feedbackDelay = delay;
                    var playhead = snapshot.Value<double?>("feedbackPlayhead") ?? double.NegativeInfinity;
                    _feedbackPlayhead = Finite(playhead) ? playhead : double.NegativeInfinity;
                }
                else { ClearFeedbackHistory(); SeedFeedback(ReceivedAt, Target, delay); }
            }
            return true;
        }
        private void ReceiveEndpoints(JObject frame, JObject binding, double now, double? wallNow)
        {
            ClearFeedbackHistory();
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
            if (wallNow.HasValue && Finite(wallNow.Value) && Finite(envelope) && envelope > wallNow.Value + 1000) { FreezeEndpoint("数据时间无效"); return; }
            if (wallNow.HasValue && Finite(wallNow.Value)) reference = Math.Max(reference, wallNow.Value);
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
            ReceiveCore(frame, binding, now, wallNow, false);
        }
        // Old part definitions retain their original value/action mapping.
        // They can still share strict source identity, age and ordering without
        // coercing visibility/color text into a numeric animation position.
        public bool ReceiveObservationOnly(JObject frame, JObject binding, double now, double? wallNow = null)
        {
            ReceiveCore(frame, binding, now, wallNow, true);
            return _observationAccepted;
        }
        private void ReceiveCore(JObject frame, JObject binding, double now, double? wallNow, bool observationOnly)
        {
            _observationAccepted = false;
            if (!Finite(now)) return;
            if (IsEndpointBinding(binding)) { ReceiveEndpoints(frame, binding, now, wallNow); return; }
            var group = binding.Value<string>("sourceGroup") ?? "analog";
            var key = binding.Value<string>("sourceKey") ?? "";
            var meta = frame?["pointMeta"]?[group + "." + key];
            var catalog = IsCatalogBinding(binding);
            if (catalog && !(frame?["motionInputs"] is JObject) && frame?.Value<bool?>("motionInputOnly") != true) return;
            if (!catalog && (frame?.Value<bool?>("motionInputOnly") == true || frame?["motionInputs"] != null && frame[group] == null && frame["pointMeta"] == null && frame["status"] == null && frame["quality"] == null)) return;
            var item = catalog ? frame?["motionInputs"]?[binding.Value<string>("actionId") ?? ""] as JObject : null;
            var token = catalog ? item?["value"] : frame?[group]?[key];
            var stamp = Timestamp(catalog ? item?["timestamp"] : meta?["timestamp"]); var envelope = Timestamp(frame?["timestamp"]);
            // Real, explicitly assigned point IDs require an owned source
            // observation. The transport wrapper is not a PLC read. Controlled
            // local preview (no wall clock) and older unbound model definitions
            // retain their previous protocol without weakening live bindings.
            if (!catalog && wallNow.HasValue && Finite(wallNow.Value) && !string.IsNullOrWhiteSpace(binding.Value<string>("pointId"))
                && (!(meta is JObject) || meta.Value<string>("id") != binding.Value<string>("pointId") || !Finite(stamp) || !Good(meta["quality"])))
            { Freeze("数据无效"); return; }
            if (wallNow.HasValue && Finite(wallNow.Value) && Finite(envelope) && envelope > wallNow.Value + 1000) { Freeze("数据时间无效"); return; }
            var wasUsable = Usable;
            var priorStamp = SourceTimestamp; var priorNumeric = NumericValue;
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
            if (wallNow.HasValue && Finite(wallNow.Value)) reference = Math.Max(reference, wallNow.Value);
            if (Finite(stamp) && stamp > reference + 1000) { Freeze("数据时间无效"); return; }
            var cachedAge = frame?.Value<double?>("cachedAgeMs") ?? 0;
            var age = Finite(stamp) ? Math.Max(0, (reference - stamp) / 1000) : 0;
            if (Finite(cachedAge) && cachedAge > 0) age = Math.Max(age, cachedAge / 1000);
            var sourceAt = now - age;
            if (!Finite(stamp) || stamp != SourceTimestamp) { ReceivedAt = sourceAt; SourceTimestamp = stamp; }
            else ReceivedAt = Math.Min(ReceivedAt, sourceAt);
            Number(item?["staleMs"], out var stale); SourceStaleMs = catalog && Finite(stale) && stale > 0 ? stale : double.PositiveInfinity;
            if (now - ReceivedAt > SourceStaleMs / 1000) { Freeze("数据超时"); return; }
            if (observationOnly)
            {
                ClearFeedbackHistory();
                Usable = true; HasSample = true; Reason = "来源数据正常"; _observationAccepted = true; return;
            }
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
            var delay = FeedbackDelay(binding);
            if (delay > 0 && !condition && (token?.Type == JTokenType.Integer || token?.Type == JTokenType.Float))
                ReceiveFeedback(p, value, priorNumeric, stamp, priorStamp, ReceivedAt, delay, !HasSample || !wasUsable || Recovering);
            else
            {
                ClearFeedbackHistory();
                if (!HasSample || (binding.Value<double?>("transitionSeconds") ?? 0) <= 0 && !Recovering) Position = p;
            }
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
            var feedbackDelay = FeedbackDelay(binding);
            if (_feedbackNumeric && feedbackDelay > 0)
            {
                if (_feedbackDelay != feedbackDelay) SeedFeedback(ReceivedAt, Target, feedbackDelay);
                // Do not stack the old full-span slew on top of the bounded
                // source interpolation: that could add seconds of lag.
                StepFeedback(now);
            }
            else
            {
                ClearFeedbackHistory();
                var duration = binding.Value<double?>("transitionSeconds") ?? 0; if (duration <= 0 && Recovering) duration = .2;
                var step = duration > 0 ? delta / duration : double.PositiveInfinity;
                Position += Math.Sign(Target - Position) * Math.Min(Math.Abs(Target - Position), step);
            }
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

    // Immutable, validated track data compiled once when the motion package is
    // configured. The hot sampling path neither traverses JSON nor allocates.
    // Its interpolation is intentionally identical to SampleInto above.
    public sealed class CompiledMotionTrack
    {
        public string NodeName { get; private set; }
        public string Channel { get; private set; }
        public int Size { get; private set; }
        public int Count { get; private set; }
        public double Duration { get; private set; }
        private double[] _values;
        public readonly double[] PositionRest = new double[3];
        public readonly double[] MaximumPositionDisplacement = new double[3];
        public bool HasPositionTravel { get; private set; }
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);

        public static bool TryCompile(JObject clip, JObject track, out CompiledMotionTrack compiled, out string reason)
        {
            compiled = null; reason = "动画轨迹定义无效";
            if (clip?["count"]?.Type != JTokenType.Integer || track?["size"]?.Type != JTokenType.Integer
                || (clip["duration"]?.Type != JTokenType.Integer && clip["duration"]?.Type != JTokenType.Float)) return false;
            if (!long.TryParse(clip["count"].ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var countValue)
                || !long.TryParse(track["size"].ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var sizeValue)) return false;
            var duration = clip.Value<double>("duration");
            if (countValue < 2 || countValue > int.MaxValue || sizeValue < 1 || sizeValue > 4 || !Finite(duration) || duration <= 0) return false;
            var count = (int)countValue; var size = (int)sizeValue;
            if (track["channel"]?.Type != JTokenType.String || track["node"]?.Type != JTokenType.String) return false;
            var values = track["values"] as JArray; var channel = track.Value<string>("channel"); var name = track.Value<string>("node");
            if (values == null || values.Count != (long)count * size || string.IsNullOrEmpty(channel) || string.IsNullOrEmpty(name)
                || channel == "q" && size != 4 || channel == "p" && size != 3 || channel == "s" && size != 3 || channel == "v" && size != 1) return false;
            if (channel != "p" && channel != "q" && channel != "s" && channel != "v"
                && (channel.Length < 2 || channel[0] != 'e' && channel[0] != 'c' || size != 4
                    || !int.TryParse(channel.Substring(1), NumberStyles.None, CultureInfo.InvariantCulture, out var slot) || slot < 0)) return false;
            var typed = new double[values.Count];
            for (var index = 0; index < values.Count; index++)
            {
                if (values[index].Type != JTokenType.Integer && values[index].Type != JTokenType.Float) return false;
                var value = values[index].Value<double>(); if (!Finite(value) || Math.Abs(value) > float.MaxValue) return false;
                typed[index] = value;
            }
            compiled = new CompiledMotionTrack { NodeName = name, Channel = channel, Size = size, Count = count, Duration = duration, _values = typed };
            if (channel == "p")
            {
                for (var index = 0; index < 3; index++) compiled.PositionRest[index] = typed[index];
                double maximumSquared = 0;
                for (var index = 3; index < typed.Length; index += 3)
                {
                    var x = typed[index] - typed[0]; var y = typed[index + 1] - typed[1]; var z = typed[index + 2] - typed[2];
                    var squared = x * x + y * y + z * z;
                    if (!Finite(squared)) { compiled = null; return false; }
                    if (squared <= maximumSquared) continue;
                    maximumSquared = squared;
                    compiled.MaximumPositionDisplacement[0] = x; compiled.MaximumPositionDisplacement[1] = y; compiled.MaximumPositionDisplacement[2] = z;
                }
                compiled.HasPositionTravel = maximumSquared > .00000001;
            }
            reason = "动画轨迹定义正常"; return true;
        }

        public bool SampleInto(double seconds, double[] result)
        {
            if (!Finite(seconds) || result == null || result.Length != Size) return false;
            var offset = Math.Max(0, Math.Min(1, seconds / Duration)) * (Count - 1);
            var left = Math.Min(Count - 1, (int)Math.Floor(offset)); var right = Math.Min(Count - 1, left + 1); var t = offset - left;
            if (Channel == "v") t = 0;
            var sign = 1d;
            if (Channel == "q")
            {
                double dot = 0;
                for (var index = 0; index < 4; index++) dot += _values[left * Size + index] * _values[right * Size + index];
                if (dot < 0) sign = -1;
            }
            for (var index = 0; index < Size; index++) result[index] = _values[left * Size + index] * (1 - t) + sign * _values[right * Size + index] * t;
            return true;
        }
    }
}
