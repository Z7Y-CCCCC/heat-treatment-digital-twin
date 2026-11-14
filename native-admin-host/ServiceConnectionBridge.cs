using System.IO.Pipes;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal sealed partial class AdminPanelForm
{
    private readonly SemaphoreSlim _serviceConnectionGate = new(1, 1);
    private static readonly HttpClient ServiceControlClient = new(new HttpClientHandler { UseProxy = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(8) };

    private async Task HandleServiceConnectionActionAsync(JsonElement root)
    {
        var requestId = root.TryGetProperty("requestId", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null;
        var action = root.TryGetProperty("action", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
        if (!ServiceConnectionPolicy.IsRequestId(requestId)) return;
        if (!await _serviceConnectionGate.WaitAsync(0))
        { PostServiceResult(new { type = "service_connection_result", requestId, success = false, error = "已有服务操作正在执行", code = "BUSY" }); return; }
        try
        {
            var (cookie, session) = await ReadServiceSessionAsync();
            if (!ServiceConnectionPolicy.Allows(session, action)) throw new InvalidOperationException("当前会话未登录或没有此服务操作权限");
            object result;
            if (action == "unity_reconnect")
            {
                if (_options.ParentProcessId <= 0 || _parentProcess == null || _parentProcess.HasExited)
                    throw new InvalidOperationException("当前本机 Unity 进程不可用，请先启动大屏");
                var csrf = session.GetProperty("csrfToken").GetString() ?? "";
                var grant = await CallServiceApiAsync("/api/admin-auth/native-ticket", cookie, csrf, new { });
                var ticket = grant.GetProperty("ticket").GetString();
                if (ticket is not { Length: 64 } || !ticket.All(Uri.IsHexDigit)) throw new InvalidOperationException("大屏会话票据未确认");
                await _unityCommandSender.WaitAsync(_pipeCancellation.Token);
                try
                {
                    await using var pipe = new NamedPipeClientStream(".", $"HeatTreatmentUnityAuth_{_options.ParentProcessId}",
                        PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await pipe.ConnectAsync(1800, _pipeCancellation.Token);
                    await NativeSessionCommandTransport.SendAsync(pipe,
                        JsonSerializer.Serialize(new { action = "sync_unity_session", ticket }), _pipeCancellation.Token);
                }
                finally { _unityCommandSender.Release(); }
                var deadline = DateTime.UtcNow.AddSeconds(24);
                var connected = false;
                do
                {
                    await Task.Delay(350, _pipeCancellation.Token);
                    var status = await CallServiceApiAsync("/api/admin-auth/native-confirm", cookie, csrf, new { ticket });
                    connected = status.TryGetProperty("connected", out var opened) && opened.ValueKind == JsonValueKind.True;
                    if (connected) break; // The server matches this ticket's NEW child session, never aggregate clients.
                } while (DateTime.UtcNow < deadline);
                if (!connected) throw new InvalidOperationException("Unity 新实时通道握手未确认，请检查服务连接");
                result = new { type = "service_connection_result", requestId, success = true, connected = true };
            }
            else if (action == "data_reconnect")
            {
                if (_dashboardOverlay == null) throw new InvalidOperationException("当前大屏没有透明数据层");
                var count = await _dashboardOverlay.ReconnectActiveChannelsAsync(requestId!);
                result = new { type = "service_connection_result", requestId, success = true, connected = true, channels = count };
            }
            else if (action == "unity_restart")
            {
                if (MessageBox.Show(this, "将重启当前电脑的大屏和后台窗口，不会重启采集服务。请确认所有表单与布局已保存。继续吗？",
                    "重启当前大屏", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                    throw new InvalidOperationException("已取消大屏重启");
                var renewed = await ReadServiceSessionAsync();
                if (!ServiceConnectionPolicy.Allows(renewed.Session, action)) throw new InvalidOperationException("重启确认期间权限已改变");
                var status = await CallDesktopServiceControlAsync("service/unity-restart");
                var operationId = status.GetProperty("operationId").GetString();
                if (!ServiceConnectionPolicy.IsOperationId(operationId)) throw new InvalidOperationException("重启操作未受理");
                result = new { type = "service_connection_result", requestId, success = true, accepted = true, operationId };
            }
            else if (action == "restart_status")
            {
                var operationId = root.TryGetProperty("operationId", out var operation) ? operation.GetString() : null;
                if (!ServiceConnectionPolicy.IsOperationId(operationId)) throw new InvalidOperationException("重启确认编号无效");
                var status = await CallDesktopServiceControlAsync("service/unity-restart/" + operationId, HttpMethod.Get);
                result = new { type = "service_connection_result", requestId, success = true, state = status.GetProperty("state").GetString() };
            }
            else
            {
                var center = await CallDesktopServiceControlAsync("service/collector-center");
                if (!center.TryGetProperty("opened", out var opened) || opened.ValueKind != JsonValueKind.True)
                    throw new InvalidOperationException("运行中心尚未确认打开");
                result = new { type = "service_connection_result", requestId, success = true, opened = true };
            }
            PostServiceResult(result);
        }
        catch (Exception)
        {
            // Do not forward HTTP/cookie/ticket-bearing exception details to the page or log.
            PostServiceResult(new { type = "service_connection_result", requestId, success = false,
                error = "服务操作未确认、被拒绝或已取消，请重新检测并检查权限 / 运行日志", code = "SERVICE_ACTION_UNCONFIRMED" });
        }
        finally { _serviceConnectionGate.Release(); }
    }

    private void PostServiceResult(object result)
    {
        if (_closing || !_webViewReadyForMessages()) return;
        try { _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(result)); }
        catch { /* A restarted/navigating page reconciles the receipt on startup. */ }
    }
    private async Task<(string Cookie, JsonElement Session)> ReadServiceSessionAsync()
    {
        if (_webView.CoreWebView2 == null) throw new InvalidOperationException("后台尚未就绪");
        var uri = new Uri(new Uri(_options.Url), "/api/admin-auth/session");
        var cookies = await _webView.CoreWebView2.CookieManager.GetCookiesAsync(uri.AbsoluteUri);
        var header = string.Join("; ", cookies.Where(c => !string.IsNullOrWhiteSpace(c.Name)).Select(c => $"{c.Name}={c.Value}"));
        var session = await CallServiceApiAsync("/api/admin-auth/session", header);
        return (header, session);
    }
    private async Task<JsonElement> CallServiceApiAsync(string path, string cookie, string? csrf = null, object? payload = null)
    {
        using var request = new HttpRequestMessage(payload == null ? HttpMethod.Get : HttpMethod.Post, new Uri(new Uri(_options.Url), path));
        request.Headers.TryAddWithoutValidation("Cookie", cookie);
        request.Headers.TryAddWithoutValidation("X-Admin-Request", "1");
        request.Headers.TryAddWithoutValidation("Origin", new Uri(_options.Url).GetLeftPart(UriPartial.Authority));
        if (csrf != null) request.Headers.TryAddWithoutValidation("X-CSRF-Token", csrf);
        if (payload != null) request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var response = await ServiceControlClient.SendAsync(request, _pipeCancellation.Token);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync(_pipeCancellation.Token);
        if (body.Length > 65536) throw new InvalidOperationException("服务响应过大");
        using var document = JsonDocument.Parse(body);
        return document.RootElement.Clone();
    }
    private async Task<JsonElement> CallDesktopServiceControlAsync(string path, HttpMethod? method = null)
    {
        if (!Uri.TryCreate(_options.DesktopControlUrl, UriKind.Absolute, out var origin)
            || origin.Scheme != "http" || !origin.IsLoopback || string.IsNullOrEmpty(_options.DesktopControlToken))
            throw new InvalidOperationException("本机桌面控制通道不可用");
        using var request = new HttpRequestMessage(method ?? HttpMethod.Post, new Uri(origin, path));
        request.Headers.TryAddWithoutValidation("x-desktop-control-token", _options.DesktopControlToken);
        using var response = await ServiceControlClient.SendAsync(request, _pipeCancellation.Token);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(_pipeCancellation.Token));
        if (!document.RootElement.TryGetProperty("success", out var success) || success.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException("桌面操作未确认");
        return document.RootElement.Clone();
    }
}
