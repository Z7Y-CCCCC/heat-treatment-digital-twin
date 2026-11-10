using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Fixed storage; Add is allocation-free. Overflow invalidates percentiles
    // rather than presenting a truncated sample as an exact whole-window result.
    public sealed class RuntimeFrameStatistics
    {
        private readonly double[] _samples;
        private readonly double[] _sort;
        private int _sampleCount;
        public long Frames { get; private set; }
        public long InvalidSamples { get; private set; }
        public long PercentileOverflow { get; private set; }
        public long Over33Ms { get; private set; }
        public long Over50Ms { get; private set; }
        public double MaximumMs { get; private set; }
        public double TotalSeconds { get; private set; }

        public RuntimeFrameStatistics(int capacity = 4096)
        {
            if (capacity < 1 || capacity > 65536) throw new ArgumentOutOfRangeException(nameof(capacity));
            _samples = new double[capacity]; _sort = new double[capacity];
        }

        public void Add(double seconds)
        {
            if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds <= 0)
            {
                InvalidSamples++; return;
            }
            var ms = seconds * 1000d;
            if (double.IsInfinity(ms)) { InvalidSamples++; return; }
            Frames++; TotalSeconds += seconds;
            if (ms > 33d) Over33Ms++;
            if (ms > 50d) Over50Ms++;
            if (ms > MaximumMs) MaximumMs = ms;
            if (_sampleCount < _samples.Length) _samples[_sampleCount++] = ms;
            else PercentileOverflow++;
        }

        public void SortForSummary()
        {
            Array.Copy(_samples, _sort, _sampleCount);
            Array.Sort(_sort, 0, _sampleCount);
        }

        // Export once per completed window, never from the frame hot path.
        // Keeping source order lets a CLI compute exact whole-run percentiles
        // by concatenating all eligible windows instead of averaging p95 values.
        public double[] CopyFrameIntervalsMs()
        {
            if (_sampleCount == 0 || PercentileOverflow != 0) return null;
            var result = new double[_sampleCount];
            Array.Copy(_samples, result, _sampleCount);
            return result;
        }

        // Linear interpolation: rank=(N-1)*p; even-size median is the mean.
        public double? Percentile(double p)
        {
            if (double.IsNaN(p) || p < 0 || p > 1) throw new ArgumentOutOfRangeException(nameof(p));
            if (_sampleCount == 0 || PercentileOverflow != 0) return null;
            var rank = (_sampleCount - 1) * p;
            var lower = (int)Math.Floor(rank); var upper = (int)Math.Ceiling(rank);
            return _sort[lower] + (_sort[upper] - _sort[lower]) * (rank - lower);
        }

        public double? FramesPerSecond(double elapsedSeconds)
        {
            return elapsedSeconds > 0 && !double.IsNaN(elapsedSeconds) && !double.IsInfinity(elapsedSeconds) && Frames > 0
                ? Frames / elapsedSeconds : (double?)null;
        }

        public void Reset()
        {
            _sampleCount = 0; Frames = InvalidSamples = PercentileOverflow = Over33Ms = Over50Ms = 0;
            MaximumMs = TotalSeconds = 0;
        }
    }

    // The only filesystem operations run on this background thread. At most
    // capacity completed window records can be waiting; an unavailable/slow disk
    // drops telemetry instead of stalling animation or growing memory forever.
    public sealed class RuntimeMetricLog
    {
        private readonly ConcurrentQueue<string> _queue = new ConcurrentQueue<string>();
        private readonly AutoResetEvent _wake = new AutoResetEvent(false);
        private readonly Thread _worker;
        private readonly string _path;
        private readonly int _capacity;
        private int _pending;
        private int _stopping;
        private long _dropped;
        private long _written;
        private string _error;
        public long DroppedRecords => Interlocked.Read(ref _dropped);
        public long WrittenRecords => Interlocked.Read(ref _written);
        public int PendingRecords => Volatile.Read(ref _pending);
        public string Error => Volatile.Read(ref _error);

        public RuntimeMetricLog(string path, int capacity = 8)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Metrics path is required.", nameof(path));
            if (capacity < 1 || capacity > 256) throw new ArgumentOutOfRangeException(nameof(capacity));
            _path = path; _capacity = capacity;
            _worker = new Thread(Write) { IsBackground = true, Name = "DigitalTwinFrameMetrics" };
            _worker.Start();
        }

        public bool TryEnqueue(string record)
        {
            if (string.IsNullOrEmpty(record) || record.Length > 65536 || Volatile.Read(ref _stopping) != 0) return false;
            if (Interlocked.Increment(ref _pending) > _capacity)
            {
                Interlocked.Decrement(ref _pending); Interlocked.Increment(ref _dropped); return false;
            }
            if (Volatile.Read(ref _stopping) != 0) { Interlocked.Decrement(ref _pending); return false; }
            _queue.Enqueue(record);
            try { _wake.Set(); } catch (ObjectDisposedException) { }
            return true;
        }

        // Never joins on the Unity main thread. Tests/CLI may explicitly await
        // completion with a finite timeout; application shutdown is best effort.
        public void RequestStop()
        {
            Interlocked.Exchange(ref _stopping, 1);
            try { _wake.Set(); } catch (ObjectDisposedException) { }
        }

        public bool WaitForStop(int milliseconds)
        {
            if (milliseconds < 0) throw new ArgumentOutOfRangeException(nameof(milliseconds));
            return _worker.Join(milliseconds);
        }

        private void Write()
        {
            try
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(_path));
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                using (var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false), 8192))
                {
                    while (Volatile.Read(ref _stopping) == 0 || Volatile.Read(ref _pending) > 0)
                    {
                        var wrote = false;
                        while (_queue.TryDequeue(out var record))
                        {
                            Interlocked.Decrement(ref _pending);
                            writer.WriteLine(record); Interlocked.Increment(ref _written); wrote = true;
                        }
                        if (wrote) writer.Flush();
                        if (Volatile.Read(ref _stopping) == 0) _wake.WaitOne(1000);
                        else if (Volatile.Read(ref _pending) > 0) Thread.Yield();
                    }
                }
            }
            catch (Exception error)
            {
                Volatile.Write(ref _error, error.GetType().Name + ": " + error.Message);
                Interlocked.Exchange(ref _stopping, 1);
                while (_queue.TryDequeue(out _)) { Interlocked.Decrement(ref _pending); Interlocked.Increment(ref _dropped); }
            }
            finally { Interlocked.Exchange(ref _stopping, 1); _wake.Dispose(); }
        }
    }
}
