using Microsoft.Web.WebView2.Core;

namespace HeatTreatmentAdminHost;

// Recover a failed page, not the Unity scene or its account. Repeated crashes
// and a failed browser process require a new native host/controller.
internal sealed class WebViewProcessRecovery : IDisposable
{
    private readonly CoreWebView2 _view;
    private readonly Control _owner;
    private readonly Action<string> _log;
    private readonly Action _recreate;
    private readonly Queue<DateTime> _attempts = new();
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 500 };
    private bool _disposed;
    public WebViewProcessRecovery(CoreWebView2 view, Control owner, Action<string> log, Action recreate)
    {
        _view=view;_owner=owner;_log=log;_recreate=recreate;
        view.ProcessFailed+=Failed;_timer.Tick+=Retry;
    }
    private void Failed(object? sender, CoreWebView2ProcessFailedEventArgs args)
    {
        if(_disposed || _owner.IsDisposed)return;
        _log($"WebView2 进程异常：{args.ProcessFailedKind}；保留 Unity，恢复界面");
        if(args.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        { _owner.BeginInvoke(_recreate);return; }
        if(args.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.FrameRenderProcessExited)
        { _timer.Stop();_timer.Start(); }
    }
    private void Retry(object? sender, EventArgs args)
    {
        _timer.Stop();if(_disposed || _owner.IsDisposed)return;
        while(_attempts.Count>0 && DateTime.UtcNow-_attempts.Peek()>TimeSpan.FromMinutes(1))_attempts.Dequeue();
        if(_attempts.Count>=3){_recreate();return;}
        _attempts.Enqueue(DateTime.UtcNow);
        try{_view.Reload();}catch(Exception exception){_log($"WebView2 重新加载失败：{exception.Message}");_recreate();}
    }
    public void Dispose()
    {
        if(_disposed)return;_disposed=true;_timer.Stop();_timer.Dispose();
        try{_view.ProcessFailed-=Failed;}catch{ }
    }
}
