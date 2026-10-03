using System.Text;
using System.Threading.Channels;

namespace HeatTreatmentAdminHost;

// One bounded queue and one background file owner for every host/overlay/error entry.
// Producers never create directories, open files, wait for a lock or block on disk.
internal static class AdminHostLog
{
    private static AsyncBoundedHostLog? _writer;

    internal static void Configure(string directory) =>
        _writer ??= new AsyncBoundedHostLog(directory);

    internal static void Write(string message) => _writer?.Write(message);

    internal static void Complete(TimeSpan timeout)
    {
        var writer = _writer;
        if (writer == null) return;
        // Only at process shutdown, never while a window is accepting input.
        try { writer.CompleteAsync().Wait(timeout); } catch { }
    }
}

internal sealed class AsyncBoundedHostLog
{
    internal const long DefaultMaxBytes = 10 * 1024 * 1024;
    internal const int DefaultMaxArchives = 5;
    internal const int MaxMessageChars = 8192;
    private readonly Channel<string> _queue;
    private readonly string _directory;
    private readonly string _filename;
    private readonly long _maxBytes;
    private readonly int _maxArchives;
    private readonly Task _worker;
    private long _dropped;
    private long _pendingDropped;
    private long _failures;
    private long _pendingFailures;
    private long _archiveSequence;
    private FileStream? _stream;
    private FileStream? _directoryLock;
    internal long DroppedMessages => Interlocked.Read(ref _dropped);
    internal long WriteFailures => Interlocked.Read(ref _failures);

    internal AsyncBoundedHostLog(string directory, long maxBytes = DefaultMaxBytes,
        int maxArchives = DefaultMaxArchives, int queueCapacity = 512)
    {
        _directory = directory;
        _filename = Path.Combine(directory, "admin-host.log");
        _maxBytes = Math.Max(1, maxBytes);
        _maxArchives = Math.Max(1, maxArchives);
        _queue = Channel.CreateBounded<string>(new BoundedChannelOptions(Math.Max(1, queueCapacity))
        {
            SingleReader = true, SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait, AllowSynchronousContinuations = false
        });
        _worker = Task.Run(RunAsync);
    }

    internal void Write(string message)
    {
        var bounded = message.Length > MaxMessageChars
            ? message[..MaxMessageChars] + " [truncated]" : message;
        if (!_queue.Writer.TryWrite($"[{DateTimeOffset.Now:O}] {bounded}\n"))
        {
            Interlocked.Increment(ref _dropped);
            Interlocked.Increment(ref _pendingDropped);
        }
    }

    internal Task CompleteAsync()
    {
        _queue.Writer.TryComplete();
        return _worker;
    }

    private async Task RunAsync()
    {
        var batchSize = 0;
        try
        {
            await foreach (var message in _queue.Reader.ReadAllAsync())
            {
                try
                {
                    await EnsureOpenAsync();
                    if (_pendingFailures > 0)
                    {
                        await WriteAsync($"[{DateTimeOffset.Now:O}] Log writing recovered after {_pendingFailures} failed entries\n");
                        _pendingFailures = 0;
                    }
                    var dropped = Interlocked.Exchange(ref _pendingDropped, 0);
                    if (dropped > 0)
                    {
                        try { await WriteAsync($"[{DateTimeOffset.Now:O}] Log queue full: skipped {dropped} diagnostic messages\n"); }
                        catch { Interlocked.Add(ref _pendingDropped, dropped); throw; }
                    }
                    await WriteAsync(message);
                    // Release ownership regularly so hosts with different parent
                    // Unity PIDs can share this directory, including during restart.
                    if (++batchSize >= 64 || !_queue.Reader.TryPeek(out _))
                    {
                        await CloseAsync();
                        batchSize = 0;
                    }
                }
                catch
                {
                    Interlocked.Increment(ref _failures);
                    _pendingFailures++;
                    try { await CloseAsync(); } catch { }
                    // Disk full/permissions failure must not turn into a tight retry loop.
                    await Task.Delay(1000);
                }
            }
        }
        finally { await CloseAsync(); }
    }

    private async Task EnsureOpenAsync()
    {
        if (_stream != null) return;
        Directory.CreateDirectory(_directory);
        while (_directoryLock == null)
        {
            try
            {
                // The OS releases this zero-byte lock even if a host crashes.
                // All filesystem work, including contention waits, stays off UI.
                _directoryLock = new FileStream(Path.Combine(_directory, ".admin-host.lock"),
                    FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
            {
                await Task.Delay(25);
            }
        }
        _stream = Open();
    }

    private async Task CloseAsync()
    {
        var stream = _stream;
        var directoryLock = _directoryLock;
        _stream = null;
        _directoryLock = null;
        try { if (stream != null) await stream.DisposeAsync(); }
        finally { if (directoryLock != null) await directoryLock.DisposeAsync(); }
    }

    private FileStream Open()
    {
        Directory.CreateDirectory(_directory);
        Cleanup();
        if (File.Exists(_filename) && new FileInfo(_filename).Length > _maxBytes) RotateFile();
        return new FileStream(_filename, FileMode.Append, FileAccess.Write, FileShare.Read,
            16384, FileOptions.Asynchronous | FileOptions.SequentialScan);
    }

    private async Task WriteAsync(string message)
    {
        var bytes = Encoding.UTF8.GetBytes(message);
        // Keep ordinary entries (including UTF-8 characters) together. Only an
        // entry larger than the entire quota needs to be split across files.
        if (_stream!.Length > 0 && bytes.Length <= _maxBytes && _stream.Length + bytes.Length > _maxBytes)
        {
            await _stream.DisposeAsync();
            _stream = null;
            RotateFile();
            _stream = Open();
        }
        var offset = 0;
        while (offset < bytes.Length)
        {
            if (_stream!.Length >= _maxBytes)
            {
                await _stream.DisposeAsync();
                _stream = null;
                RotateFile();
                _stream = Open();
            }
            var length = (int)Math.Min(bytes.Length - offset, _maxBytes - _stream.Length);
            await _stream.WriteAsync(bytes.AsMemory(offset, length));
            offset += length;
        }
    }

    private void RotateFile()
    {
        // Renames only; no compression or reading the old file into memory.
        var archive = Path.Combine(_directory,
            $"admin-host-{DateTime.UtcNow:yyyyMMddTHHmmssfffffff}-{Environment.ProcessId}-{++_archiveSequence}.log");
        if (File.Exists(_filename)) File.Move(_filename, archive);
        Cleanup();
    }

    private void Cleanup()
    {
        var archives = new DirectoryInfo(_directory).GetFiles("admin-host-*.log")
            .OrderByDescending(file => file.LastWriteTimeUtc).ThenByDescending(file => file.Name).ToArray();
        long total = 0;
        var kept = 0;
        foreach (var archive in archives)
        {
            // Also evicts legacy oversized logs; the total quota is a hard bound.
            if (archive.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-30)
                || kept >= _maxArchives || archive.Length > _maxBytes
                || total + archive.Length > _maxBytes * _maxArchives) archive.Delete();
            else { total += archive.Length; kept++; }
        }
    }
}
