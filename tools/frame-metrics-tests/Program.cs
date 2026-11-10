using System.Diagnostics;
using HeatTreatment.DigitalTwin.Runtime;

internal static class Program
{
    private static int _checks;
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
        _checks++; Console.WriteLine("PASS: " + message);
    }
    private static bool Close(double? value, double expected) => value.HasValue && Math.Abs(value.Value - expected) < 1e-8;
    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; }
    }

    private static void Main()
    {
        CheckPercentiles(); CheckInvalidAndOverflow(); CheckSteadyAllocations(); CheckWriter();
        Console.WriteLine($"Passed {_checks} isolated frame-metric checks; no Unity player, account or application database was opened.");
    }

    private static void CheckPercentiles()
    {
        var samples = new RuntimeFrameStatistics(128);
        for (var i = 1; i <= 100; i++) samples.Add(i / 1000d);
        samples.SortForSummary();
        Require(samples.Frames == 100 && Close(samples.Percentile(.5), 50.5), "median uses both central frames for an even-size window");
        Require(Close(samples.Percentile(.95), 95.05) && Close(samples.Percentile(.99), 99.01), "p95 and p99 use the documented linear-interpolation ranks");
        Require(Close(samples.Percentile(0), 1) && Close(samples.Percentile(1), 100), "minimum and maximum percentile endpoints retain actual samples");
        var raw = samples.CopyFrameIntervalsMs();
        Require(raw.Length == samples.Frames && raw[0] == 1 && raw[99] == 100, "raw frame intervals retain every original frame for exact whole-segment percentile calculations");
        raw[0] = 999; samples.SortForSummary();
        Require(Close(samples.Percentile(0), 1), "exported window evidence cannot mutate the live statistics buffer");
        Require(samples.Over33Ms == 67 && samples.Over50Ms == 50 && samples.MaximumMs == 100, "slow-frame thresholds use strict greater-than 33 ms and 50 ms");
        Require(Close(samples.FramesPerSecond(5.05), 100d / 5.05) && Close(samples.FramesPerSecond(2), 50), "FPS is total frame count divided by actual elapsed wall time, not mean instantaneous FPS");
        Require(Throws<ArgumentOutOfRangeException>(() => samples.Percentile(-.1)) && Throws<ArgumentOutOfRangeException>(() => samples.Percentile(double.NaN)), "invalid percentile requests cannot yield plausible metrics");
        samples.Reset(); samples.SortForSummary();
        Require(samples.Frames == 0 && samples.Percentile(.5) == null && samples.FramesPerSecond(1) == null && samples.MaximumMs == 0 && samples.CopyFrameIntervalsMs() == null, "reset and an empty window expose unavailable metrics rather than fabricated zero FPS");
    }

    private static void CheckInvalidAndOverflow()
    {
        Require(Throws<ArgumentOutOfRangeException>(() => new RuntimeFrameStatistics(0))
            && Throws<ArgumentOutOfRangeException>(() => new RuntimeFrameStatistics(65537)), "sample storage is explicitly bounded");
        var samples = new RuntimeFrameStatistics(2);
        foreach (var invalid in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity, 0, -1d, double.MaxValue }) samples.Add(invalid);
        samples.SortForSummary();
        Require(samples.InvalidSamples == 6 && samples.Frames == 0 && samples.Percentile(.99) == null, "nonfinite, nonpositive and overflowing intervals do not contaminate frame statistics");
        foreach (var elapsed in new[] { double.NaN, double.PositiveInfinity, 0, -1d })
            Require(samples.FramesPerSecond(elapsed) == null, "unavailable or invalid elapsed time cannot become valid FPS");
        samples.Add(.01); samples.Add(.02); samples.Add(.03); samples.SortForSummary();
        Require(samples.Frames == 3 && samples.PercentileOverflow == 1 && samples.Percentile(.5) == null
            && samples.Percentile(.95) == null && samples.Percentile(.99) == null && samples.MaximumMs == 30 && samples.CopyFrameIntervalsMs() == null,
            "storage overflow preserves complete frame/slow-frame counts but invalidates truncated percentiles");
        Require(Close(samples.FramesPerSecond(.06), 50), "sample storage overflow does not discard frames from real FPS");
        samples.Reset(); samples.Add(.016); samples.SortForSummary();
        Require(samples.InvalidSamples == 0 && samples.PercentileOverflow == 0 && Close(samples.Percentile(.99), 16), "a following window recovers cleanly from overflow and malformed input");
    }

    private static void CheckSteadyAllocations()
    {
        var samples = new RuntimeFrameStatistics(32);
        for (var i = 0; i < 2000; i++) samples.Add(.016);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 100000; i++) samples.Add(.016);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Require(allocated == 0, "100000 steady per-frame observations allocate zero managed bytes, even when fixed storage overflows");
    }

    private static void CheckWriter()
    {
        // Unique test-owned directory. Cleanup uses literal known files and
        // non-recursive directory deletion; it never touches a live data root.
        var directory = Path.Combine(Path.GetTempPath(), "codex-frame-metrics-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "metrics.jsonl");
        var boundedFile = Path.Combine(directory, "bounded.jsonl");
        try
        {
            var writer = new RuntimeMetricLog(file);
            var clock = Stopwatch.StartNew();
            Require(!writer.WaitForStop(0) && clock.ElapsedMilliseconds < 1000, "a zero timeout never blocks on an active telemetry worker");
            Require(writer.TryEnqueue("{\"type\":\"metadata\"}") && writer.TryEnqueue("{\"type\":\"window\",\"fps\":60}"), "completed window records can enter the background writer without filesystem calls on the producer");
            writer.RequestStop();
            Require(writer.WaitForStop(5000), "normal telemetry shutdown drains accepted records within a finite timeout");
            Require(writer.Error == null && writer.WrittenRecords == 2 && writer.PendingRecords == 0 && File.ReadAllLines(file).Length == 2, "metadata and window records are complete newline-delimited output");
            Require(!writer.TryEnqueue("after-stop") && Throws<ArgumentOutOfRangeException>(() => writer.WaitForStop(-1)), "a stopped worker rejects new records and infinite waits are disallowed");
            var appended = new RuntimeMetricLog(file); appended.TryEnqueue("{\"type\":\"another-run\"}"); appended.RequestStop();
            Require(appended.WaitForStop(5000) && File.ReadAllLines(file).Length == 3, "reusing an explicit metrics path appends and does not overwrite earlier evidence");

            var blocked = new RuntimeMetricLog(directory);
            blocked.TryEnqueue("cannot-write-to-a-directory");
            Require(blocked.WaitForStop(5000) && blocked.Error != null && !blocked.TryEnqueue("later"), "an invalid output path fails only the optional telemetry sink and stops accepting records");

            var bounded = new RuntimeMetricLog(boundedFile, 1); var record = new string('x', 1024);
            var accepted = 0; clock.Restart();
            for (var i = 0; i < 20000; i++)
            {
                if (bounded.TryEnqueue(record)) accepted++;
                if (bounded.PendingRecords > 1) throw new InvalidOperationException("Completed records exceeded the one-record queue bound.");
            }
            var enqueueMilliseconds = clock.ElapsedMilliseconds;
            bounded.RequestStop();
            Require(bounded.WaitForStop(5000) && bounded.Error == null, "a bounded backlog can shut down without an unbounded replay queue");
            Require(bounded.DroppedRecords > 0 && bounded.WrittenRecords == accepted && bounded.PendingRecords == 0, "backpressure drops excess optional records instead of blocking or losing accepted windows");
            Require(enqueueMilliseconds < 5000 && !bounded.TryEnqueue(new string('z', 65537)), "producer enqueue work stays finite and oversized optional records are rejected");
        }
        finally
        {
            if (File.Exists(file)) File.Delete(file);
            if (File.Exists(boundedFile)) File.Delete(boundedFile);
            Directory.Delete(directory);
        }
    }
}
