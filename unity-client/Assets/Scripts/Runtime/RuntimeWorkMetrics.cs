using System;
using System.Diagnostics;
using System.Threading;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Opt-in, bounded section timing. No Unity API, allocation or logging in a
    // measured callback; the existing once-per-second metrics writer owns JSON.
    public static class RuntimeWorkMetrics
    {
        public enum Section { QueueProducer, QueueCritical, RealtimeDispatch, RealtimeApply, SceneProjection, ClipAdvance, PartAdvance, Inspection,
            PointerWindow, OverviewSnapshot, OverviewPick, OverviewOutline, Occlusion,
            MotionInputCache, TelemetryCache, ActuatorReceive, DashboardReceive, OverviewMatrixBatch, Count }
        private static readonly long[] Calls = new long[(int)Section.Count];
        private static readonly long[] Ticks = new long[(int)Section.Count];
        private static readonly long[] Maximum = new long[(int)Section.Count];
        private static long _readContentions;
        private static int _enabled;
        private static int _collections;
        public static bool Enabled => Volatile.Read(ref _enabled) != 0;
        public static void Enable()
        {
            for (var i = 0; i < Calls.Length; i++) { Interlocked.Exchange(ref Calls[i], 0); Interlocked.Exchange(ref Ticks[i], 0); Interlocked.Exchange(ref Maximum[i], 0); }
            Interlocked.Exchange(ref _readContentions, 0);
            _collections = GC.CollectionCount(0);
            Volatile.Write(ref _enabled, 1);
        }
        public static void Disable() => Volatile.Write(ref _enabled, 0);
        public static Scope Measure(Section section) => new Scope(section, Enabled);
        public static void ReadContended() { if (Enabled) Interlocked.Increment(ref _readContentions); }
        public readonly struct Scope : IDisposable
        {
            private readonly int _section;
            private readonly long _start;
            public Scope(Section section, bool enabled) { _section = enabled ? (int)section : -1; _start = enabled ? Stopwatch.GetTimestamp() : 0; }
            public void Dispose()
            {
                if (_section < 0) return;
                var elapsed = Stopwatch.GetTimestamp() - _start;
                Interlocked.Increment(ref Calls[_section]); Interlocked.Add(ref Ticks[_section], elapsed);
                var prior = Interlocked.Read(ref Maximum[_section]);
                while (elapsed > prior) { var observed = Interlocked.CompareExchange(ref Maximum[_section], elapsed, prior); if (observed == prior) break; prior = observed; }
            }
        }
        public static JObject CaptureWindow()
        {
            var sections = new JObject();
            for (var i = 0; i < Calls.Length; i++) sections[((Section)i).ToString()] = new JObject {
                ["calls"] = Interlocked.Exchange(ref Calls[i], 0),
                ["totalMs"] = Interlocked.Exchange(ref Ticks[i], 0) * 1000.0 / Stopwatch.Frequency,
                ["maxInvocationMs"] = Interlocked.Exchange(ref Maximum[i], 0) * 1000.0 / Stopwatch.Frequency
            };
            var collections = GC.CollectionCount(0); var delta = collections - _collections; _collections = collections;
            return new JObject { ["sections"] = sections, ["nonblockingQueueReadContentions"] = Interlocked.Exchange(ref _readContentions, 0),
                ["gen0Collections"] = delta, ["scope"] = "wall time per invocation; nested sections overlap; producer runs on I/O threads; collection count is not GC pause time" };
        }
    }
}
