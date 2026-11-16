using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HeatTreatmentAdminHost;

// Offline recovery before business UI creation. No HTTP listener, no requests to either
// origin, no access to site databases, no cookie export, no deletion at source.
internal record Request(string Profile, string OldOrigin, string NewOrigin, string Output, bool SelfTest = false, string? FixedRuntime = null);
internal static class UiOriginStorageMigration
{
    public static bool TryRun(string[] args)
    {
        if (!args.Contains("--migrate-ui-origin")) return false;
        if (args.Length != 2 || args[0] != "--migrate-ui-origin") { Environment.ExitCode = 1; return true; }
        RunRequestFile(args[1]); return true;
    }
    public static void RunRequestFile(string file)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            var request = JsonSerializer.Deserialize<Request>(File.ReadAllText(file)) ?? throw new Exception("Invalid request");
            using var form = new RecoveryForm(request);
            Application.Run(form);
            Environment.ExitCode = form.Success ? 0 : 1;
        }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ": recovery failed"); Environment.ExitCode = 1; }
    }
}
internal sealed class RecoveryForm : Form
{
    private readonly Request request;
    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private readonly string oldUrl, newUrl;
    private readonly System.Windows.Forms.Timer watchdog = new() { Interval = 90000 };
    public bool Success { get; private set; }
    public RecoveryForm(Request value)
    {
        request = value;
        string Validate(string origin)
        {
            if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1"
                || uri.Port < 1024 || uri.AbsolutePath != "/" || uri.Query != "" || uri.Fragment != "" || uri.UserInfo != ""
                || origin != uri.GetLeftPart(UriPartial.Authority)) throw new Exception("Only exact loopback origins allowed");
            return origin + "/__local_origin_recovery__";
        }
        oldUrl = Validate(request.OldOrigin); newUrl = Validate(request.NewOrigin);
        if (oldUrl == newUrl || !Path.IsPathFullyQualified(request.Profile) || !Path.IsPathFullyQualified(request.Output)) throw new Exception("Invalid recovery paths");
        if (request.SelfTest && !Path.GetFullPath(request.Profile).StartsWith(Path.GetFullPath(request.Output) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Fixture profile must stay inside its test output");
#if !DEBUG
        if (request.SelfTest) throw new Exception("Fixture seeding is disabled in installed builds");
#endif
        Opacity = 0; ShowInTaskbar = false; Width = 64; Height = 64;
        Controls.Add(view);
        watchdog.Tick += (_, _) => { Environment.ExitCode = 1; Close(); };
        Shown += async (_, _) => await Run();
    }
    private static string Script(string name)
    {
        using var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream(name)!);
        return reader.ReadToEnd();
    }
    private async Task<JsonElement> Evaluate(string script)
    {
        using var result = JsonDocument.Parse(await view.CoreWebView2.ExecuteScriptAsync(script));
        return result.RootElement.Clone();
    }
    private async Task Navigate(string url)
    {
        var ready = new TaskCompletionSource();
        void Completed(object? _, CoreWebView2NavigationCompletedEventArgs args)
        { if (args.IsSuccess) ready.TrySetResult(); else ready.TrySetException(new Exception("Offline navigation failed")); }
        view.CoreWebView2.NavigationCompleted += Completed;
        try { view.CoreWebView2.Navigate(url); await ready.Task.WaitAsync(TimeSpan.FromSeconds(20)); }
        finally { view.CoreWebView2.NavigationCompleted -= Completed; }
    }
    private async Task<JsonElement> Snapshot()
    {
        // ExecuteScriptAsync does not await JS promises: use a WebMessage for
        // the async IndexedDB enumeration and never send data to a network URL.
        var ready = new TaskCompletionSource<JsonElement>();
        void Message(object? _, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (args.Source != oldUrl && args.Source != newUrl) return;
            using var doc = JsonDocument.Parse(args.WebMessageAsJson);
            ready.TrySetResult(doc.RootElement.Clone());
        }
        view.CoreWebView2.WebMessageReceived += Message;
        try
        {
            await Evaluate($"{Script("snapshot.js")}().then(value=>chrome.webview.postMessage(value),()=>chrome.webview.postMessage({{error:true}})); null;");
            var data = await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (!data.TryGetProperty("entries", out _)) throw new Exception("Snapshot failed");
            return data;
        }
        finally { view.CoreWebView2.WebMessageReceived -= Message; }
    }
    private async Task Run()
    {
        watchdog.Start();
        try
        {
            Directory.CreateDirectory(request.Output);
            var environment = await CoreWebView2Environment.CreateAsync(request.FixedRuntime, request.Profile);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            view.CoreWebView2.WebResourceRequested += (_, args) =>
            {
                var allowed = args.Request.Uri == oldUrl || args.Request.Uri == newUrl;
                args.Response = environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes("<!doctype html><title>Offline local storage recovery</title>")),
                    allowed ? 200 : 403, allowed ? "OK" : "Forbidden", "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; connect-src 'none'\r\n");
            };
            view.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
            view.CoreWebView2.NavigationStarting += (_, args) => args.Cancel = args.Uri != oldUrl && args.Uri != newUrl;
            await Navigate(oldUrl);
#if DEBUG
            if (request.SelfTest) await Evaluate("localStorage.setItem('dashboard-designer-draft:fixture','草稿<\\\"\\\\>'); localStorage.setItem('reading','18'); null;");
#endif
            var source = await Snapshot();
            File.WriteAllText(Path.Combine(request.Output, "source-local-storage.json"), source.GetRawText());
            if (source.GetProperty("indexedDbCount").GetInt32() != 0) throw new Exception("Source has IndexedDB; explicit migration required");
            await Navigate(newUrl);
            var target = await Snapshot();
            File.WriteAllText(Path.Combine(request.Output, "target-local-storage-before.json"), target.GetRawText());
            var entries = source.GetProperty("entries").GetRawText();
            var transfer = await Evaluate($"{Script("transfer.js")}({entries})");
            if (!transfer.TryGetProperty("success", out var ok) || !ok.GetBoolean()) throw new Exception("Destination conflict or write failure");
            var verified = await Snapshot();
            var after = verified.GetProperty("entries").EnumerateArray().ToDictionary(pair => pair[0].GetString()!, pair => pair[1].GetString());
            foreach (var pair in source.GetProperty("entries").EnumerateArray())
                if (!after.TryGetValue(pair[0].GetString()!, out var value) || value != pair[1].GetString()) throw new Exception("Readback mismatch");
            await Navigate(oldUrl);
            var sourceAfter = await Snapshot();
            if (sourceAfter.GetProperty("entries").GetRawText() != entries) throw new Exception("Source changed during recovery");
            File.WriteAllText(Path.Combine(request.Output, "result.json"), JsonSerializer.Serialize(new
            {
                success = true, engine = "WebView2", sourceCount = source.GetProperty("entries").GetArrayLength(),
                verifiedCount = transfer.GetProperty("verified").GetInt32(), sourceUnmodified = true, networkRequests = 0,
                sourceSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(entries)))
            }));
            Success = true;
        }
        catch (Exception error)
        {
            Directory.CreateDirectory(request.Output);
            File.WriteAllText(Path.Combine(request.Output, "failure.json"), JsonSerializer.Serialize(new { success = false, type = error.GetType().Name, reason = error.Message }));
            Console.Error.WriteLine("WebView2 origin migration failed; source retained; inspect local failure report");
        }
        finally { watchdog.Stop(); view.Dispose(); Close(); }
    }
}
