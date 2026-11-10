using System;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public enum StationInputMeaning { Legacy, Current, Target, Invalid, LastConfirmed }

    // Interpretation only: no model transforms, PLC writes, polling, prediction,
    // or Unity clock. The renderer supplies its monotonic and UTC clocks.
    public sealed class MobileMotionSignalState
    {
        public bool Usable { get; private set; }
        public bool HasSample { get; private set; }
        public bool SnapOnReceive { get; private set; }
        public StationInputMeaning InputMeaning { get; private set; }
        // A target command is not an observation of a physically docked cart.
        public bool HasConfirmedPosition => Usable && HasSample && _arrivalConfirmed;
        public double Value { get; private set; }
        public double SourceTimestamp { get; private set; } = double.NaN;
        public double ReceivedAt { get; private set; } = double.NegativeInfinity;
        public string Reason { get; private set; } = "等待位置数据";
        private double _gateTimestamp = double.NaN;
        private double _gateReceivedAt = double.NegativeInfinity;
        private double _lastConfirmedPositionWatermark = double.NaN;
        private double _lastConfirmedGateWatermark = double.NaN;
        private double _sourceTimeoutMs = double.PositiveInfinity;
        private double _gateTimeoutMs = double.PositiveInfinity;
        private bool _resync = true;
        private bool _arrivalConfirmed;

        public static StationInputMeaning ParseStationInputMeaning(JToken token)
        {
            if (token == null) return StationInputMeaning.Legacy;
            if (token.Type != JTokenType.String) return StationInputMeaning.Invalid;
            if (string.Equals(token.Value<string>(), "current", StringComparison.Ordinal)) return StationInputMeaning.Current;
            if (string.Equals(token.Value<string>(), "target", StringComparison.Ordinal)) return StationInputMeaning.Target;
            if (string.Equals(token.Value<string>(), "last-confirmed", StringComparison.Ordinal)) return StationInputMeaning.LastConfirmed;
            return StationInputMeaning.Invalid;
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static bool Good(JToken token) => token == null || token.Type == JTokenType.String && string.Equals(token.Value<string>(), "good", StringComparison.OrdinalIgnoreCase);
        private static double Timestamp(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Boolean) return double.NaN;
            if (double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return Finite(number) && number > 0 ? number : double.NaN;
            return token.Type == JTokenType.String && DateTimeOffset.TryParse(token.Value<string>(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time) ? time.ToUnixTimeMilliseconds() : double.NaN;
        }
        private static bool Number(JToken token, out double number)
        {
            number = 0;
            return token != null && (token.Type == JTokenType.Integer || token.Type == JTokenType.Float || token.Type == JTokenType.String)
                && double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && Finite(number);
        }
        private static bool Boolean(JToken token, out bool value)
        {
            value = false;
            if (token?.Type == JTokenType.Boolean) { value = token.Value<bool>(); return true; }
            if (Number(token, out var number)) { value = Math.Abs(number) > .0001; return true; }
            if (token?.Type != JTokenType.String) return false;
            var text = token.Value<string>();
            if (string.Equals(text, "true", StringComparison.OrdinalIgnoreCase) || string.Equals(text, "on", StringComparison.OrdinalIgnoreCase)) { value = true; return true; }
            return string.Equals(text, "false", StringComparison.OrdinalIgnoreCase) || string.Equals(text, "off", StringComparison.OrdinalIgnoreCase);
        }
        private static double Timeout(JObject metadata)
        {
            return Number(metadata?["staleMs"], out var timeout) && timeout > 0 ? timeout : double.PositiveInfinity;
        }
        public void Suspend(string reason = "采集连接中断")
        {
            Usable = false; SnapOnReceive = false; _resync = true; Reason = reason;
        }
        public void Reset()
        {
            HasSample = false; Value = 0; SourceTimestamp = double.NaN; ReceivedAt = double.NegativeInfinity;
            InputMeaning = StationInputMeaning.Legacy;
            _arrivalConfirmed = false;
            _gateTimestamp = double.NaN; _gateReceivedAt = double.NegativeInfinity;
            _lastConfirmedPositionWatermark = _lastConfirmedGateWatermark = double.NaN;
            _sourceTimeoutMs = _gateTimeoutMs = double.PositiveInfinity; Suspend("等待位置数据");
        }
        private static double LastConfirmedSourceStamp(DeviceDto device, JObject frame, string pointId, double reference)
        {
            if (device == null || !long.TryParse(pointId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)) return double.NaN;
            var point = device.DataPoints?.FirstOrDefault(row => row != null && row.Id == id);
            if (point == null || !string.IsNullOrEmpty(point.DeviceId) && point.DeviceId != device.Id) return double.NaN;
            var category = point.Category ?? "analog"; var key = string.IsNullOrWhiteSpace(point.ValueRole) ? point.Name : point.ValueRole;
            var pointMeta = frame["pointMeta"] as JObject;
            JObject metadata = null;
            foreach (var item in pointMeta?.Properties() ?? Enumerable.Empty<JProperty>())
            {
                if (!(item.Value is JObject candidate) || candidate["id"]?.ToString() != pointId) continue;
                if (metadata != null) return double.NaN;
                if (candidate["category"] is JContainer || candidate["field_name"] is JContainer) return double.NaN;
                metadata = candidate; category = candidate.Value<string>("category") ?? category; key = candidate.Value<string>("field_name") ?? key;
            }
            if (metadata == null || string.IsNullOrWhiteSpace(key) || !ReferenceEquals(metadata, pointMeta?[category + "." + key])) return double.NaN;
            var stamp = Timestamp(metadata["timestamp"]);
            return Finite(stamp) && stamp <= reference + 1000 ? stamp : double.NaN;
        }
        private bool Point(DeviceDto device, JObject frame, string pointId, double reference, double now,
            out JToken value, out double stamp, out double receivedAt, out double timeout)
        {
            value = null; stamp = double.NaN; receivedAt = now; timeout = double.PositiveInfinity;
            if (device == null || !long.TryParse(pointId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)) { Suspend("位置点位未配置"); return false; }
            var point = device.DataPoints?.FirstOrDefault(row => row != null && row.Id == id);
            if (point == null || !string.IsNullOrEmpty(point.DeviceId) && point.DeviceId != device.Id) { Suspend("点位不属于当前设备"); return false; }
            var category = point.Category ?? "analog"; var key = string.IsNullOrWhiteSpace(point.ValueRole) ? point.Name : point.ValueRole;
            var pointMeta = frame["pointMeta"] as JObject;
            JObject metadata = null;
            foreach (var item in pointMeta?.Properties() ?? Enumerable.Empty<JProperty>())
            {
                if (!(item.Value is JObject candidate) || candidate["id"]?.ToString() != pointId) continue;
                if (metadata != null) { Suspend("点位元数据重复"); return false; }
                metadata = candidate; category = candidate.Value<string>("category") ?? category; key = candidate.Value<string>("field_name") ?? key;
            }
            if (string.IsNullOrWhiteSpace(key)) { Suspend("点位字段未配置"); return false; }
            var addressed = pointMeta?[category + "." + key] as JObject;
            // Explicit mobile point IDs require an actual owned source read.
            // Neither a transport timestamp nor a matching value field is a
            // replacement for missing/misaddressed point confirmation.
            if (metadata == null || !ReferenceEquals(metadata, addressed) || metadata["id"]?.ToString() != pointId)
            { Suspend("位置点位确认元数据缺失或不匹配"); return false; }
            var quality = ((frame["quality"] as JObject)?[category] as JObject)?[key];
            // Actual collectors publish per-point quality in the group map;
            // metadata quality is optional, but must be good when supplied.
            if (quality == null || !Good(quality) || !Good(metadata["quality"]))
            { Suspend(quality?.ToString() == "stale" ? "位置数据超时" : "位置数据无效"); return false; }
            value = frame[category]?[key];
            if (value == null || value.Type == JTokenType.Null) { Suspend("位置数据缺失"); return false; }
            stamp = Timestamp(metadata["timestamp"]);
            if (!Finite(stamp) || stamp > reference + 1000) { Suspend("位置数据时间无效"); return false; }
            var cachedAgeMs = 0d;
            if (frame["cachedAgeMs"] != null && (!Number(frame["cachedAgeMs"], out cachedAgeMs) || cachedAgeMs < 0))
            { Suspend("位置缓存数据年龄无效"); return false; }
            var ageMs = Math.Max(Math.Max(0, reference - stamp), cachedAgeMs);
            receivedAt = now - ageMs / 1000;
            timeout = Timeout(metadata);
            return true;
        }
        public bool Receive(DeviceDto device, JObject frame, string positionPointId, string startPointId,
            double now, double wallNow, double staleMs, StationInputMeaning inputMeaning = StationInputMeaning.Legacy,
            bool actualPositionFeedback = false)
        {
            SnapOnReceive = false;
            InputMeaning = inputMeaning;
            if (inputMeaning == StationInputMeaning.Invalid) { Suspend("工位信号含义无效"); return false; }
            // A stopped movement bit is expected at a dock, not permission to
            // replay a journey. When current feedback has an explicit movement
            // bit, a true bit must still deny docking (the PLC may keep its last
            // station number while moving). Its quality/age remains checked.
            if (!Finite(now) || !Finite(wallNow)) { Suspend("位置时间基准无效"); return false; }
            if (frame?.Value<bool?>("motionInputOnly") == true) return false;
            var envelope = Timestamp(frame?["timestamp"]);
            var reference = Math.Max(wallNow, Finite(envelope) ? envelope : wallNow);
            if (inputMeaning == StationInputMeaning.LastConfirmed && frame != null && (!Finite(envelope) || envelope <= wallNow + 1000))
            {
                // A newer typed, quality or offline fault is still an ordering
                // barrier when its owned point timestamp is trustworthy. Keep
                // this separate from accepted values and freshness: it cannot
                // make invalid data usable or renew a previous observation.
                var positionStamp = LastConfirmedSourceStamp(device, frame, positionPointId, reference);
                var movingStamp = LastConfirmedSourceStamp(device, frame, startPointId, reference);
                if (Finite(positionStamp) && (!Finite(_lastConfirmedPositionWatermark) || positionStamp > _lastConfirmedPositionWatermark)) _lastConfirmedPositionWatermark = positionStamp;
                if (Finite(movingStamp) && (!Finite(_lastConfirmedGateWatermark) || movingStamp > _lastConfirmedGateWatermark)) _lastConfirmedGateWatermark = movingStamp;
            }
            if (frame == null || frame["status"]?["online"]?.ToString().Equals("false", StringComparison.OrdinalIgnoreCase) == true
                || !Good(frame["status"]?["quality"]) || !Good(frame["quality"] is JObject quality ? quality["overall"] : frame["quality"]))
            { Suspend("位置采集连接无效"); return false; }
            if (Finite(envelope) && envelope > wallNow + 1000) { Suspend("位置数据时间无效"); return false; }
            // Backend and Unity run on the same local host: count queue/network
            // age as well as time since dispatch. Replaying a cache is not a read.
            if (!Point(device, frame, positionPointId, reference, now, out var position, out var stamp, out var at, out var timeout)) return false;
            if (!Number(position, out var value)) { Suspend("位置数据类型无效"); return false; }
            var gateStamp = double.NaN; var gateAt = now; var gateTimeout = double.PositiveInfinity;
            var running = true;
            if (!string.IsNullOrEmpty(startPointId))
            {
                if (inputMeaning == StationInputMeaning.LastConfirmed)
                {
                    var feedbackPoint = device.DataPoints?.FirstOrDefault(row => row != null && row.Id.ToString(CultureInfo.InvariantCulture) == startPointId);
                    if (feedbackPoint == null || !string.Equals(feedbackPoint.DataType, "BOOL", StringComparison.OrdinalIgnoreCase)
                        || !string.Equals(feedbackPoint.AccessType ?? "READ", "READ", StringComparison.OrdinalIgnoreCase))
                    { Suspend("实际移动状态反馈必须是本设备的只读 BOOL 点位"); return false; }
                }
                if (!Point(device, frame, startPointId, reference, now, out var gate, out gateStamp, out gateAt, out gateTimeout)) return false;
                if (inputMeaning == StationInputMeaning.LastConfirmed && gate.Type != JTokenType.Boolean)
                { Suspend("实际移动状态反馈不是 BOOL 读数"); return false; }
                if (!Boolean(gate, out running)) { Suspend("移动开始信号无效"); return false; }
            }
            if (Finite(stamp) && Finite(SourceTimestamp) && stamp < SourceTimestamp
                || Finite(gateStamp) && Finite(_gateTimestamp) && gateStamp < _gateTimestamp) return false;
            if (inputMeaning == StationInputMeaning.LastConfirmed
                && (Finite(_lastConfirmedPositionWatermark) && stamp < _lastConfirmedPositionWatermark
                    || Finite(gateStamp) && Finite(_lastConfirmedGateWatermark) && gateStamp < _lastConfirmedGateWatermark)) return false;
            ReceivedAt = Finite(stamp) && stamp == SourceTimestamp ? Math.Min(ReceivedAt, at) : at;
            _gateReceivedAt = Finite(gateStamp) && gateStamp == _gateTimestamp ? Math.Min(_gateReceivedAt, gateAt) : gateAt;
            SourceTimestamp = stamp; _gateTimestamp = gateStamp; _sourceTimeoutMs = timeout; _gateTimeoutMs = gateTimeout;
            if (Expired(now, staleMs, !string.IsNullOrEmpty(startPointId))) { Suspend("位置数据超时"); return false; }
            if (!running && !actualPositionFeedback && inputMeaning != StationInputMeaning.Current && inputMeaning != StationInputMeaning.LastConfirmed) { Suspend("移动开始信号关闭"); return false; }
            Value = value;
            SnapOnReceive = inputMeaning == StationInputMeaning.Current || inputMeaning == StationInputMeaning.LastConfirmed
                || inputMeaning != StationInputMeaning.Target && (!HasSample || _resync || actualPositionFeedback && !running);
            HasSample = true; Usable = true; _resync = false;
            // A PLC can retain its last station throughout a journey. That
            // number is a last-known observation, not proof it is still docked.
            // Only an explicitly bound, good actual BOOL movement feedback
            // which is false may confirm docking in this opted-in mode.
            _arrivalConfirmed = inputMeaning == StationInputMeaning.LastConfirmed ? !string.IsNullOrEmpty(startPointId) && !running : inputMeaning != StationInputMeaning.Target
                && (!actualPositionFeedback && inputMeaning != StationInputMeaning.Current || string.IsNullOrEmpty(startPointId) || !running);
            Reason = inputMeaning == StationInputMeaning.LastConfirmed ? string.IsNullOrEmpty(startPointId) ? "最后到位工位有效，途中位置及当前停靠未确认"
                    : running ? "料车移动中，保持最后到位工位" : "当前工位已确认，实际移动反馈停止"
                : inputMeaning == StationInputMeaning.Target ? "目标工位命令有效，实际到位未确认"
                : !_arrivalConfirmed ? actualPositionFeedback ? "实测位置数据有效，料车移动中" : "当前工位反馈有效，料车移动中" : "位置数据正常";
            return true;
        }
        private bool Expired(double now, double staleMs, bool gate)
        {
            var timeout = Finite(staleMs) && staleMs > 0 ? staleMs : 5000;
            return now - ReceivedAt > Math.Min(timeout, _sourceTimeoutMs) / 1000
                || gate && now - _gateReceivedAt > Math.Min(timeout, _gateTimeoutMs) / 1000;
        }
        public bool Advance(double now, double staleMs, bool hasStartPoint)
        {
            if (Usable && (!Finite(now) || Expired(now, staleMs, hasStartPoint))) Suspend("位置数据超时");
            return Usable;
        }
    }
}
