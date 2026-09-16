using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal sealed record HostOptions(
    string Url,
    int ParentProcessId,
    IntPtr ParentWindowHandle,
    string? UserDataFolder,
    string? FixedRuntimeFolder,
    string? DesktopControlUrl,
    string? DesktopControlToken,
    bool StartInDashboardMode
)
{
    public string PipeName => $"HeatTreatmentAdminHost_{ParentProcessId}";
    public string MutexName => $"Local\\HeatTreatmentAdminHost_{ParentProcessId}";

    public static HostOptions Parse(string[] args)
    {
        string url = "http://127.0.0.1:3001/admin?embedded=unity";
        var parentPid = 0;
        var parentHandle = IntPtr.Zero;
        string? userData = null;
        string? fixedRuntime = null;
        string? desktopControlUrl = null;
        string? desktopControlToken = null;
        var startInDashboardMode = false;

        for (var index = 0; index < args.Length; index += 1)
        {
            var key = args[index];
            var value = index + 1 < args.Length ? args[index + 1] : string.Empty;
            switch (key.ToLowerInvariant())
            {
                case "--url": url = value; index += 1; break;
                case "--parent-pid": int.TryParse(value, out parentPid); index += 1; break;
                case "--parent-hwnd":
                    if (long.TryParse(value, out var handleValue)) parentHandle = new IntPtr(handleValue);
                    index += 1;
                    break;
                case "--user-data": userData = value; index += 1; break;
                case "--fixed-runtime": fixedRuntime = value; index += 1; break;
                case "--desktop-control-url": desktopControlUrl = value; index += 1; break;
                case "--desktop-control-token": desktopControlToken = value; index += 1; break;
                case "--dashboard-mode": startInDashboardMode = true; break;
            }
        }

        return new HostOptions(
            url,
            parentPid,
            parentHandle,
            userData,
            fixedRuntime,
            desktopControlUrl,
            desktopControlToken,
            startInDashboardMode
        );
    }
}

internal static class Program
{
    internal const uint ShowMessage = NativeMethods.WmApp + 410;
    internal const uint CloseMessage = NativeMethods.WmApp + 411;
    internal static string LogDirectory { get; private set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "heat-treatment-digital-twin-desktop", "logs");

    [STAThread]
    private static void Main(string[] args)
    {
        EnablePerMonitorDpiAwareness();
        // Prevent the transparent overlay WebView from flashing white before its
        // controller-level background color is applied. Admin pages remain opaque.
        Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00000000");
        var options = HostOptions.Parse(args);
        if (!string.IsNullOrWhiteSpace(options.UserDataFolder))
        {
            var userDataRoot = Path.GetDirectoryName(Path.GetFullPath(options.UserDataFolder));
            if (!string.IsNullOrEmpty(userDataRoot)) LogDirectory = Path.Combine(userDataRoot, "logs");
        }
        using var mutex = new Mutex(true, options.MutexName, out var isOwner);
        if (!isOwner)
        {
            SignalExistingHost(options.PipeName, options.StartInDashboardMode ? "restore_dashboard" : "show");
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, eventArgs) => LogUnhandledException("UI 线程异常", eventArgs.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) =>
        {
            if (eventArgs.ExceptionObject is Exception exception)
            {
                LogUnhandledException("未处理的宿主异常", exception);
            }
        };
        using var form = new AdminPanelForm(options);
        Application.Run(form);
    }

    private static void EnablePerMonitorDpiAwareness()
    {
        // Must run before the first window is created. Unity's player window is
        // per-monitor DPI aware; a system-aware child gets bitmap-stretched into it
        // on scaled displays, which pushes the bottom of the admin page out of view
        // with no way to scroll to it.
        try
        {
            NativeMethods.SetProcessDpiAwarenessContext(NativeMethods.DpiAwarenessContextPerMonitorAwareV2);
        }
        catch
        {
            // Older Windows builds fall back to the manifest-declared awareness.
        }
    }

    private static void SignalExistingHost(string pipeName, string command)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
            client.Connect(1800);
            using var writer = new StreamWriter(client, Encoding.UTF8, leaveOpen: false) { AutoFlush = true };
            writer.WriteLine(command);
        }
        catch
        {
            // A previous process may have exited between mutex acquisition and the pipe connect.
            // The next menu click will start a fresh host.
        }
    }

    private static void LogUnhandledException(string prefix, Exception exception)
    {
        try
        {
            var directory = LogDirectory;
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {prefix}: {exception}\n"
            );
        }
        catch
        {
            // Error reporting must never become a second failure.
        }
    }
}
