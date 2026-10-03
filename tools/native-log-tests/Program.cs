using System.Diagnostics;
using HeatTreatmentAdminHost;

internal static class Program
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), $"digital-twin-native-logs-{Guid.NewGuid():N}");

    private static async Task Main()
    {
        Directory.CreateDirectory(Root);
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("concurrent producers retain every accepted message and shutdown drains", ConcurrentProducers),
            ("independent host writers share a directory without loss or rotation conflicts", SharedDirectory),
            ("rotation enforces count, byte and age quotas and preserves unrelated files", RotationQuotas),
            ("UTF-8 entries remain readable across rotation", Utf8Entries),
            ("oversized entries are truncated and cannot exceed file quotas", OversizedEntries),
            ("disk outage never blocks producers; overflow and recovery are recorded", DiskRecovery)
        };
        foreach (var test in tests)
        {
            await test.Run();
            Console.WriteLine($"PASS: {test.Name}");
        }
        Console.WriteLine($"Passed {tests.Length}/{tests.Length} native logging checks. Fixtures: {Root}");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static async Task ConcurrentProducers()
    {
        var directory = Path.Combine(Root, "concurrent");
        var writer = new AsyncBoundedHostLog(directory, queueCapacity: 4096);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(producer => Task.Run(() =>
        {
            for (var index = 0; index < 250; index++) writer.Write($"producer-{producer}:entry-{index}");
        })));
        writer.Write("shutdown-marker");
        await writer.CompleteAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await writer.CompleteAsync();
        var lines = await File.ReadAllLinesAsync(Path.Combine(directory, "admin-host.log"));
        Check(writer.DroppedMessages == 0 && writer.WriteFailures == 0, "Unexpected loss under available capacity.");
        Check(lines.Length == 2001 && lines.Last().EndsWith("shutdown-marker"), "Shutdown did not drain accepted entries.");
        Check(lines.Take(2000).Select(line => line[(line.IndexOf("] ", StringComparison.Ordinal) + 2)..]).Distinct().Count() == 2000,
            "Concurrent entries were duplicated or corrupted.");
    }

    private static async Task RotationQuotas()
    {
        var directory = Path.Combine(Root, "quotas");
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "admin-host.log"), new string('L', 20000));
        var aged = Path.Combine(directory, "admin-host-aged.log");
        await File.WriteAllTextAsync(aged, "old");
        File.SetLastWriteTimeUtc(aged, DateTime.UtcNow.AddDays(-31));
        var unrelated = Path.Combine(directory, "unrelated.log");
        await File.WriteAllTextAsync(unrelated, "keep");
        var writer = new AsyncBoundedHostLog(directory, maxBytes: 256, maxArchives: 3, queueCapacity: 512);
        for (var index = 0; index < 100; index++) writer.Write($"entry-{index} {new string('x', 50)}");
        await writer.CompleteAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var files = new DirectoryInfo(directory).GetFiles("admin-host*.log");
        Check(writer.WriteFailures == 0, "Rotation failed.");
        Check(files.Length <= 4 && files.All(file => file.Length <= 256) && files.Sum(file => file.Length) <= 1024,
            "File count or byte quota was exceeded.");
        Check(!File.Exists(aged) && File.Exists(unrelated), "Age cleanup removed the wrong files.");
        Check((await File.ReadAllTextAsync(Path.Combine(directory, "admin-host.log"))).Contains("entry-99"),
            "Active log stopped receiving entries after rotation.");
    }

    private static async Task SharedDirectory()
    {
        var directory = Path.Combine(Root, "shared-hosts");
        var first = new AsyncBoundedHostLog(directory, maxBytes: 1024, maxArchives: 100, queueCapacity: 512);
        var second = new AsyncBoundedHostLog(directory, maxBytes: 1024, maxArchives: 100, queueCapacity: 512);
        for (var index = 0; index < 300; index++)
        {
            first.Write($"host-one-entry-{index}");
            second.Write($"host-two-entry-{index}");
        }
        await Task.WhenAll(first.CompleteAsync(), second.CompleteAsync()).WaitAsync(TimeSpan.FromSeconds(15));
        var files = new DirectoryInfo(directory).GetFiles("*.log");
        var lines = files.SelectMany(file => File.ReadAllLines(file.FullName)).ToArray();
        Check(first.WriteFailures == 0 && second.WriteFailures == 0 && first.DroppedMessages == 0 && second.DroppedMessages == 0,
            "Independent hosts lost entries while competing for the same directory.");
        Check(lines.Length == 600 && files.All(file => file.Length <= 1024), "Shared rotation lost entries or exceeded quotas.");
        for (var index = 0; index < 300; index++)
        {
            Check(lines.Count(line => line.EndsWith($"host-one-entry-{index}")) == 1, "First host entry missing/duplicated.");
            Check(lines.Count(line => line.EndsWith($"host-two-entry-{index}")) == 1, "Second host entry missing/duplicated.");
        }
    }

    private static async Task Utf8Entries()
    {
        var directory = Path.Combine(Root, "utf8");
        var writer = new AsyncBoundedHostLog(directory, maxBytes: 256, maxArchives: 30);
        for (var index = 0; index < 30; index++) writer.Write($"异常与恢复-{index}-位置诊断正常");
        await writer.CompleteAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var lines = Directory.GetFiles(directory, "*.log").SelectMany(File.ReadAllLines).ToArray();
        Check(lines.Length == 30 && lines.All(line => !line.Contains('\uFFFD') && line.EndsWith("位置诊断正常")),
            "UTF-8 entries were split or corrupted.");
    }

    private static async Task OversizedEntries()
    {
        var directory = Path.Combine(Root, "oversized");
        var writer = new AsyncBoundedHostLog(directory, maxBytes: 512, maxArchives: 30);
        writer.Write(new string('x', AsyncBoundedHostLog.MaxMessageChars * 20));
        await writer.CompleteAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var files = new DirectoryInfo(directory).GetFiles("*.log");
        Check(files.All(file => file.Length <= 512) && files.Sum(file => file.Length) < 9000,
            "An oversized entry bypassed message/file bounds.");
        Check((await File.ReadAllTextAsync(Path.Combine(directory, "admin-host.log"))).Contains("[truncated]"),
            "Message truncation was not visible.");
    }

    private static async Task DiskRecovery()
    {
        var directory = Path.Combine(Root, "temporarily-unavailable");
        // A file in place of a directory simulates a deterministic permission/disk failure.
        await File.WriteAllTextAsync(directory, "unavailable");
        var writer = new AsyncBoundedHostLog(directory, queueCapacity: 32);
        writer.Write("entry-during-outage");
        var deadline = Stopwatch.StartNew();
        while (writer.WriteFailures == 0 && deadline.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(10);
        Check(writer.WriteFailures > 0, "Fixture did not trigger a disk failure.");
        var producerTime = Stopwatch.StartNew();
        for (var index = 0; index < 20000; index++) writer.Write($"burst-{index}");
        producerTime.Stop();
        Check(writer.DroppedMessages > 0, "Outage queue did not enforce its capacity.");
        Check(producerTime.Elapsed < TimeSpan.FromSeconds(5), "Producers waited for disk retries.");
        File.Delete(directory);
        Directory.CreateDirectory(directory);
        await writer.CompleteAsync().WaitAsync(TimeSpan.FromSeconds(10));
        var result = await File.ReadAllTextAsync(Path.Combine(directory, "admin-host.log"));
        Check(result.Contains("Log writing recovered") && result.Contains("Log queue full: skipped"),
            "Disk recovery or overflow was silent.");
        Console.WriteLine($"20,000 writes during disk outage returned in {producerTime.Elapsed.TotalMilliseconds:F0} ms; dropped {writer.DroppedMessages} bounded-queue entries.");
    }
}
