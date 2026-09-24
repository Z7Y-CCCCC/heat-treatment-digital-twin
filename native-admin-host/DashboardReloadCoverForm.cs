namespace HeatTreatmentAdminHost;

/// <summary>
/// An opaque Unity child window beneath the transparent WebView popup. WebView2
/// can submit a transparent frame during Reload before document-created scripts
/// run; this native surface must already be painted before navigation starts.
/// </summary>
internal sealed class DashboardReloadCoverForm : Form
{
    private IntPtr _parentHandle;
    private string _failure = string.Empty;

    public DashboardReloadCoverForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimumSize = Size.Empty;
        BackColor = Color.FromArgb(40, 40, 43);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);

    }

    protected override bool ShowWithoutActivation => true;

    public void ShowForParent(IntPtr parentHandle, int chromeHeight)
    {
        if (IsDisposed || parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(parentHandle)) return;
        _failure = string.Empty;
        if (_parentHandle != parentHandle)
        {
            var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
            style &= ~(NativeMethods.WsPopup | NativeMethods.WsCaption | NativeMethods.WsThickFrame |
                       NativeMethods.WsMinimizeBox | NativeMethods.WsMaximizeBox | NativeMethods.WsSysMenu);
            style |= NativeMethods.WsChild | NativeMethods.WsVisible |
                     NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
            NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
            var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
            exStyle &= ~NativeMethods.WsExAppWindow;
            exStyle |= NativeMethods.WsExToolWindow;
            NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
            NativeMethods.SetParent(Handle, parentHandle);
            _parentHandle = parentHandle;
        }

        UpdateParentBounds(chromeHeight);
        if (!Visible) Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        Refresh();
        // Ensure DWM has received the painted cover before WebView2 is told
        // to reload; otherwise one Unity scene frame can still escape.
        NativeMethods.DwmFlush();
    }

    public void UpdateParentBounds(int chromeHeight)
    {
        if (_parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!NativeMethods.GetClientRect(_parentHandle, out var client)) return;
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop,
            0, chromeHeight, Math.Max(1, client.Width), Math.Max(1, client.Height - chromeHeight),
            NativeMethods.SwpNoActivate | NativeMethods.SwpFrameChanged |
            (Visible ? NativeMethods.SwpShowWindow : 0));
    }

    public void HideCover()
    {
        if (IsDisposed || !IsHandleCreated) return;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
    }

    public void ShowFailure(string message)
    {
        if (IsDisposed) return;
        _failure = string.IsNullOrWhiteSpace(message) ? "现场画面载入失败，请重试。" : message.Trim();
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        if (string.IsNullOrEmpty(_failure)) return;
        using var font = new Font("Microsoft YaHei UI", 12f);
        using var brush = new SolidBrush(Color.FromArgb(238, 177, 165));
        var bounds = new RectangleF(ClientSize.Width * .15f, ClientSize.Height * .4f,
            ClientSize.Width * .7f, ClientSize.Height * .2f);
        using var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        e.Graphics.DrawString(_failure, font, brush, bounds, format);
    }
}
