using Microsoft.Web.WebView2.Core;

namespace HeatTreatmentAdminHost;

/// <summary>Recover when the local backend becomes ready after the WebView starts.</summary>
internal sealed class WebViewNavigationRetry : IDisposable
{
    private readonly CoreWebView2 _webView;
    private readonly NavigationRetryPolicy _policy;
    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly Action<int>? _onRetry;
    private bool _disposed;
    private int _attempt;

    public WebViewNavigationRetry(CoreWebView2 webView, string applicationUrl, Action<int>? onRetry = null)
    {
        _webView = webView;
        _policy = new NavigationRetryPolicy(applicationUrl);
        _onRetry = onRetry;
        _webView.NavigationStarting += Starting;
        _webView.NavigationCompleted += Completed;
        _timer.Tick += Retry;
    }

    public static bool IsUsable(CoreWebView2NavigationCompletedEventArgs args) =>
        NavigationRetryPolicy.IsUsable(args.IsSuccess, args.HttpStatusCode);
    public bool IsCurrentNavigation(ulong id) => _policy.IsCurrentNavigation(id);

    private void Starting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (_disposed) return;
        if (_policy.Started(args.NavigationId, args.Uri, args.Cancel)) _timer.Stop();
    }

    private void Completed(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (_disposed) return;
        var delay = _policy.Completed(args.NavigationId, args.IsSuccess, args.HttpStatusCode,
            args.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled);
        if (delay is { } milliseconds)
        {
            _timer.Interval = milliseconds;
            _timer.Start();
        }
        else if (IsUsable(args)) _attempt = 0;
    }

    private void Retry(object? sender, EventArgs args)
    {
        _timer.Stop();
        if (_disposed) return;
        try
        {
            _onRetry?.Invoke(++_attempt);
            _webView.Navigate(_policy.Url);
        }
        catch (ObjectDisposedException) { Dispose(); }
        catch (InvalidOperationException) { Dispose(); }
        catch (System.Runtime.InteropServices.COMException) { Dispose(); }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _timer.Dispose();
        try { _webView.NavigationStarting -= Starting; _webView.NavigationCompleted -= Completed; }
        catch { /* The parent controller can already have closed during shutdown. */ }
    }
}
