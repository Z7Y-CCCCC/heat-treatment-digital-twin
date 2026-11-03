using System;
using System.Globalization;
using Newtonsoft.Json.Linq;
namespace HeatTreatment.DigitalTwin.Rendering
{
    // Read-only signal interpretation, shared by native playback and deterministic checks.
    public sealed class MotionSignalState
    {
        public double Position, Target, Seconds, ReceivedAt = double.NegativeInfinity;
        public bool HasSample, Usable, Running;
        public string Reason = "等待数据";
        public void Receive(JObject frame, JObject binding, double now)
        {
            var group = binding.Value<string>("sourceGroup") ?? "analog";
            var key = binding.Value<string>("sourceKey") ?? "";
            var meta = frame?["pointMeta"]?[group + "." + key];
            var token = frame?[group]?[key];
            bool Good(JToken q) => q == null || string.Equals(q.ToString(), "good", StringComparison.OrdinalIgnoreCase);
            Usable = frame != null && !string.Equals(frame["status"]?["online"]?.ToString(), "false", StringComparison.OrdinalIgnoreCase)
                && Good(frame["status"]?["quality"]) && Good(frame["quality"] is JObject quality ? quality["overall"] : frame["quality"])
                && Good((frame["quality"] as JObject)?[group]?[key])
                && (meta?["id"] == null || string.Equals(meta.Value<string>("id"), binding.Value<string>("pointId"), StringComparison.Ordinal));
            double value = 0;
            if (token?.Type == JTokenType.Boolean) value = token.Value<bool>() ? 1 : 0;
            else if (token == null || token.Type == JTokenType.Null || string.IsNullOrWhiteSpace(token.ToString())
                || !double.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value) || double.IsNaN(value) || double.IsInfinity(value)) Usable = false;
            ReceivedAt = now;
            if (!Usable) { Running = false; Reason = "数据无效"; return; }
            var minimum = binding.Value<double?>("inputMin") ?? 0; var maximum = binding.Value<double?>("inputMax") ?? 1;
            var p = maximum > minimum ? Math.Max(0, Math.Min(1, (value - minimum) / (maximum - minimum))) : 0;
            if (binding.Value<bool?>("invert") == true) p = 1 - p;
            Target = p;
            if (!HasSample || (binding.Value<double?>("transitionSeconds") ?? 0) <= 0) Position = p;
            Running = p > .5; HasSample = true; Reason = Running ? "运行" : "停止";
        }
        public void Step(double delta, double now, double staleMs, JObject binding)
        {
            if (now - ReceivedAt > staleMs / 1000) { Usable = false; Running = false; Reason = "数据超时"; }
            if (!Usable || delta <= 0 || double.IsNaN(delta) || double.IsInfinity(delta)) return;
            var duration = binding.Value<double?>("transitionSeconds") ?? 0; var step = duration > 0 ? delta / duration : double.PositiveInfinity;
            Position += Math.Sign(Target - Position) * Math.Min(Math.Abs(Target - Position), step);
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
