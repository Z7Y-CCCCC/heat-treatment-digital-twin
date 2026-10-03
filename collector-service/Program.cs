using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text.Json;

namespace HeatTreatmentCollector;

internal static class Program
{
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var index = Array.IndexOf(args, "--config");
        if (index < 0 || index + 1 >= args.Length) { Console.Error.WriteLine("Requires --config <absolute file>"); return 2; }
        try
        {
            // Isolated console acceptance tests must not affect machine power.
            // SCM service launches always retain their production power request.
            var suppressPowerRequest = args.Contains("--console") && args.Contains("--no-power-request");
            using var service = new CollectorService(Path.GetFullPath(args[index + 1]), suppressPowerRequest);
            if (args.Contains("--console"))
            {
                service.StartWorker();
                Console.WriteLine("COLLECTOR_SERVICE_READY");
                Console.ReadLine();
                service.StopWorker();
            }
            else ServiceBase.Run(service);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}

internal sealed class CollectorService : ServiceBase
{
    private readonly string _configFile;
    private readonly bool _suppressPowerRequest;
    private Process? _worker;
    private ProcessJob? _job;
    private PowerRequest? _power;
    private volatile bool _stopping;
    private string? _logFile;
    private readonly object _logLock = new();

    public CollectorService(string configFile, bool suppressPowerRequest = false)
    {
        _configFile = configFile;
        _suppressPowerRequest = suppressPowerRequest;
        ServiceName = "HeatTreatmentCollector";
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        RequestAdditionalTime(240000);
        StartWorker();
    }

    protected override void OnStop() { RequestAdditionalTime(40000); StopWorker(); }
    protected override void OnShutdown() => StopWorker();

    public void StartWorker()
    {
        _stopping = false;
        using var config = JsonDocument.Parse(File.ReadAllText(_configFile));
        var root = Path.GetFullPath(config.RootElement.GetProperty("root").GetString()!);
        var resources = Path.GetFullPath(config.RootElement.GetProperty("resourcesRoot").GetString()!);
        Directory.CreateDirectory(Path.Combine(root, "logs"));
        _logFile = Path.Combine(root, "logs", "service-host.log");
        if (!_suppressPowerRequest)
        {
            try { _power = new PowerRequest(); }
            catch (Exception error) { Log($"Power request unavailable: {error.Message}; verify field power policy."); }
        }
        var info = new ProcessStartInfo(Path.Combine(resources, "runtime", "node.exe"))
        {
            WorkingDirectory = resources, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
            StandardInputEncoding = new System.Text.UTF8Encoding(false)
        };
        info.ArgumentList.Add(Path.Combine(resources, "collector-service", "worker.cjs"));
        info.ArgumentList.Add("--config");
        info.ArgumentList.Add(_configFile);
        info.Environment.Remove("NODE_OPTIONS");
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _worker = new Process { StartInfo = info, EnableRaisingEvents = true };
        _worker.OutputDataReceived += (_, e) =>
        {
            if (e.Data == "COLLECTOR_READY") ready.TrySetResult(true);
            else if (e.Data != null) Log(e.Data);
        };
        _worker.ErrorDataReceived += (_, e) => { if (e.Data != null) Log(e.Data); };
        _worker.Exited += (_, _) =>
        {
            ready.TrySetException(new InvalidOperationException("Collector worker exited during startup; inspect service-host.log"));
            if (!_stopping)
            {
                Log("Collector worker failed. Exiting so Windows Service Recovery can restart the entire collector.");
                // SCM sees a process failure rather than a successful service stop.
                // Closing the job also prevents orphaned MySQL/Node children.
                _job?.Dispose();
                Environment.Exit(1);
            }
        };
        try
        {
            _job = new ProcessJob();
            _worker.Start();
            _job.Assign(_worker);
            _worker.BeginOutputReadLine();
            _worker.BeginErrorReadLine();
            // Node cannot spawn MySQL/backend before assignment to the job.
            _worker.StandardInput.WriteLine("start");
            _worker.StandardInput.Flush();
            if (!ready.Task.Wait(TimeSpan.FromSeconds(220))) throw new System.TimeoutException("Collector initialization timed out");
            ready.Task.GetAwaiter().GetResult();
            Log("Collector ready; Windows session login is not required.");
        }
        catch { StopWorker(); throw; }
    }

    public void StopWorker()
    {
        _stopping = true;
        if (_worker != null)
        {
            try
            {
                if (!_worker.HasExited)
                {
                    _worker.StandardInput.WriteLine("stop");
                    _worker.StandardInput.Flush();
                    if (!_worker.WaitForExit(32000)) Log("Graceful collector shutdown timed out; closing the owned job.");
                }
            }
            catch (Exception error) { Log($"Shutdown: {error.Message}"); }
        }
        _job?.Dispose();
        _job = null;
        _worker?.Dispose();
        _worker = null;
        _power?.Dispose();
        _power = null;
    }

    private void Log(string message)
    {
        if (_logFile == null) return;
        lock (_logLock)
        {
            try
            {
                // Keep service supervision logs bounded too.
                if (File.Exists(_logFile) && new FileInfo(_logFile).Length > 10 * 1024 * 1024)
                    File.Move(_logFile, _logFile + ".previous", true);
                File.AppendAllText(_logFile, $"[{DateTime.UtcNow:O}] {message}{Environment.NewLine}");
            }
            catch { /* The worker also has its independent diagnostic logs. */ }
        }
    }
}

// Process-owned request survives the short-lived SCM OnStart thread. It is
// released when collection stops; it never rewrites Windows power settings.
internal sealed class PowerRequest : IDisposable
{
    private IntPtr _handle;
    public PowerRequest()
    {
        var reason = Marshal.StringToHGlobalUni("Heat treatment PLC collection is running");
        try
        {
            var context = new ReasonContext { Version = 0, Flags = 1, Reason = reason };
            _handle = PowerCreateRequest(ref context);
            if (_handle == IntPtr.Zero || _handle == new IntPtr(-1))
                throw new System.ComponentModel.Win32Exception();
            if (!PowerSetRequest(_handle, 1)) { Dispose(); throw new System.ComponentModel.Win32Exception(); }
        }
        finally { Marshal.FreeHGlobal(reason); }
    }
    public void Dispose()
    {
        var handle = Interlocked.Exchange(ref _handle, IntPtr.Zero);
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) { PowerClearRequest(handle, 1); CloseHandle(handle); }
    }
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct ReasonContext
    {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(4)] public uint Flags;
        [FieldOffset(8)] public IntPtr Reason;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr PowerCreateRequest(ref ReasonContext context);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PowerSetRequest(IntPtr handle, int type);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PowerClearRequest(IntPtr handle, int type);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}

// Children live in Session 0 and remain independent of every desktop client.
// If the SCM host crashes, Windows terminates only this collector's process tree.
internal sealed class ProcessJob : IDisposable
{
    private IntPtr _handle;
    public ProcessJob()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf<ExtendedLimitInformation>();
        var memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, memory, false);
            if (!SetInformationJobObject(_handle, 9, memory, (uint)size))
                throw new System.ComponentModel.Win32Exception();
        }
        catch { Dispose(); throw; }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(_handle, process.Handle)) throw new System.ComponentModel.Win32Exception();
    }
    public void Dispose() { var handle = Interlocked.Exchange(ref _handle, IntPtr.Zero); if (handle != IntPtr.Zero) CloseHandle(handle); }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
