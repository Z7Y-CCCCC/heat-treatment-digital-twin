using System.Text.Json;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using System.Runtime.InteropServices;

namespace HeatTreatmentAdminHost;

/// <summary>
/// Transparent WebView2 data layer rendered above the Unity client. It remains
/// an owned popup instead of a cross-process Unity child window: DirectComposition
/// preserves per-pixel alpha for owned top-level windows but can flatten it when
/// a WebView2 surface is reparented across processes. Vue-reported rectangles
/// are used only for pointer hit testing.
/// </summary>
internal sealed class DashboardOverlayForm : Form
{
    private readonly HostOptions _options;
    private CoreWebView2CompositionController? _webView;
    private OverlayCompositionSurface? _compositionSurface;
    private readonly List<RectangleF> _cssRegions = new();
    private readonly List<Rectangle> _appliedRegions = new();
    private SizeF _cssViewport = new(1f, 1f);
    private Point _lastParentClientOrigin = new(int.MinValue, int.MinValue);
    private IntPtr _parentHandle;
    private Size _lastParentClientSize = Size.Empty;
    private int _lastChromeHeight;
    private uint _lastDpi = 96;
    private bool _attached;
    private bool _initialized;
    private bool _navigationReady;
    private bool _visibleRequested;
    private bool _presentationMode;
    private bool _forwardingMouse;
    private int _escapeDispatchPending;

    public DashboardOverlayForm(HostOptions options)
    {
        _options = options;
        Text = "数字孪生透明数据层";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        MinimumSize = Size.Empty;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.StandardDoubleClick, true);

        ApplyEmptyInteractionRegion();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ExStyle |= OverlayCompositionSurface.NoRedirectionBitmap;
            return parameters;
        }
    }

    // There must be no WinForms/GDI backing plate beneath the composition tree.
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    public async Task InitializeAsync(CoreWebView2Environment environment)
    {
        if (_initialized || IsDisposed) return;
        var controller = await environment.CreateCoreWebView2CompositionControllerAsync(Handle);
        if (IsDisposed || Disposing)
        {
            controller.Close();
            return;
        }
        _webView = controller;
        _webView.IsVisible = false;
        _webView.DefaultBackgroundColor = Color.Transparent;
        _webView.BoundsMode = CoreWebView2BoundsMode.UseRawPixels;
        _webView.ShouldDetectMonitorScaleChanges = false;
        _webView.RasterizationScale = 1d;
        _webView.ZoomFactor = 1d;
        _compositionSurface = new OverlayCompositionSurface(Handle);
        _webView.RootVisualTarget = _compositionSurface.RootVisual;
        _compositionSurface.Commit();
        _webView.AcceleratorKeyPressed += HandleAcceleratorKey;
        _webView.CursorChanged += HandleCursorChanged;
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        UpdateDpiState();
        UpdateWebViewBounds();
        _webView.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
        _webView.CoreWebView2.NavigationStarting += (_, args) =>
        {
            args.Cancel = !WebContentPolicy.IsSameOrigin(args.Uri, _options.Url);
            if (args.Cancel || _webView == null) return;
            _navigationReady = false;
            _webView.IsVisible = false;
            ApplyEmptyInteractionRegion();
        };
        _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
        _webView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (IsDisposed || Disposing || _webView == null) return;
            if (!args.IsSuccess)
            {
                WriteOverlayError($"透明数据层导航失败：{args.WebErrorStatus}");
                return;
            }
            // Do not expose the native WebView2 surface while it still has a
            // blank navigation frame. Showing it only after the first
            // successful navigation prevents the white compositor flash seen
            // at dashboard startup.
            _navigationReady = true;
            _webView.IsVisible = _visibleRequested;
            UpdateWebViewBounds();
            PostHostState();
            _ = OverlayPresentationDiagnostics.CaptureAsync(_webView);
        };
        _webView.CoreWebView2.Navigate(BuildOverlayUrl(_options.Url));
        _initialized = true;
    }

    private void HandleAcceleratorKey(object? sender, CoreWebView2AcceleratorKeyPressedEventArgs args)
    {
        if (args.VirtualKey != (uint)Keys.Escape) return;
        args.Handled = true;
        if (args.KeyEventKind is CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown)
            DispatchEscapeIntoPage();
    }

    private void HandleCursorChanged(object? sender, object args)
    {
        if (_webView != null && Visible && ClientRectangle.Contains(PointToClient(MousePosition)))
            SetCursor(_webView.Cursor);
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if ((keyData & Keys.KeyCode) == Keys.Escape)
        {
            DispatchEscapeIntoPage();
            return true;
        }
        return base.ProcessCmdKey(ref message, keyData);
    }

    /// <summary>
    /// The transparent WebView2 is a child of the Unity window. When it owns
    /// keyboard focus, replay Escape into the page so the same hierarchy-aware
    /// Vue handler is used regardless of which child owns focus.
    /// </summary>
    private void DispatchEscapeIntoPage()
    {
        if (Interlocked.Exchange(ref _escapeDispatchPending, 1) != 0) return;
        try
        {
            BeginInvoke(new Action(async () =>
            {
                try
                {
                    if (_webView?.CoreWebView2 == null || IsDisposed) return;
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){const target=document.activeElement||document.body;target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));})();"
                    );
                }
                catch
                {
                    // The WebView can be navigating or closing. Unity still
                    // has its own native keyboard fallback for this case.
                }
                finally
                {
                    Interlocked.Exchange(ref _escapeDispatchPending, 0);
                }
            }));
        }
        catch
        {
            Interlocked.Exchange(ref _escapeDispatchPending, 0);
        }
    }

    public void ShowForParent(IntPtr parentHandle)
    {
        if (IsDisposed || parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(parentHandle)) return;
        _visibleRequested = true;
        AttachToParent(parentHandle);
        UpdateParentBounds(force: true);
        if (!Visible) Show();
        NativeMethods.EnableWindow(Handle, true);
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (_webView != null) _webView.IsVisible = _navigationReady;
        PostHostState();
    }

    public void HideOverlay()
    {
        if (IsDisposed) return;
        _visibleRequested = false;
        Capture = false;
        if (IsHandleCreated) NativeMethods.EnableWindow(Handle, false);
        if (_webView != null) _webView.IsVisible = false;
        if (IsHandleCreated) NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        PostHostState();
    }

    public void Reload()
    {
        if (IsDisposed || _webView?.CoreWebView2 == null) return;
        ApplyEmptyInteractionRegion();
        _navigationReady = false;
        _webView.IsVisible = false;
        _webView.CoreWebView2.Reload();
    }

    /// <summary>
    /// 投屏时隐藏 AdminHost 顶部页签，透明数据层需要随之扩展到 Unity
    /// 客户区的最上方；停止投屏后恢复正常的嵌入布局。
    /// </summary>
    public void SetPresentationMode(bool enabled)
    {
        if (_presentationMode == enabled) return;
        _presentationMode = enabled;
        _lastParentClientSize = Size.Empty;
        _lastChromeHeight = -1;
        UpdateParentBounds(force: true);
        PostHostState();
    }

    public void UpdateParentBounds(bool force = false)
    {
        if (!_attached || _parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!NativeMethods.GetClientRect(_parentHandle, out var client)) return;
        var clientSize = new Size(Math.Max(1, client.Width), Math.Max(1, client.Height));
        var chromeHeight = _presentationMode
            ? 0
            : DashboardChromeForm.GetChromeHeightPixels(_parentHandle);
        var origin = new NativeMethods.Point { X = 0, Y = chromeHeight };
        if (!NativeMethods.ClientToScreen(_parentHandle, ref origin)) return;
        UpdateDpiState();
        var parentOrigin = new Point(origin.X, origin.Y);
        if (!force
            && clientSize == _lastParentClientSize
            && chromeHeight == _lastChromeHeight
            && parentOrigin == _lastParentClientOrigin) return;
        _lastParentClientSize = clientSize;
        _lastChromeHeight = chromeHeight;
        _lastParentClientOrigin = parentOrigin;

        var height = Math.Max(1, clientSize.Height - chromeHeight);

        // The overlay is already owned by Unity. Re-applying HwndTop on every
        // movement tick causes unnecessary z-order churn while the parent is
        // being dragged, which presents as a subtle HUD wobble. Keep its
        // existing order and only update its screen position/size.
        var flags = NativeMethods.SwpFrameChanged
            | NativeMethods.SwpNoActivate
            | NativeMethods.SwpNoZOrder;
        if (_visibleRequested) flags |= NativeMethods.SwpShowWindow;
        NativeMethods.SetWindowPos(
            Handle,
            NativeMethods.HwndTop,
            origin.X,
            origin.Y,
            clientSize.Width,
            height,
            flags
        );
        UpdateWebViewBounds();
        UpdateInteractionRegion();
        PostHostState();
    }

    /// <summary>
    /// The composition controller uses physical pixel bounds, with one CSS
    /// pixel per Unity pixel. Do not combine implicit WebView monitor scaling
    /// with inverse browser zoom: that used two differently sized surfaces at
    /// 125/150% DPI and exposed white strips after native region clipping.
    /// </summary>
    private void UpdateDpiState()
    {
        if (_webView == null || IsDisposed) return;
        var dpi = _parentHandle != IntPtr.Zero
            ? NativeMethods.GetDpiForWindow(_parentHandle)
            : (uint)Math.Max(96, DeviceDpi);
        if (dpi == 0) dpi = 96;
        _lastDpi = dpi;
    }

    private void UpdateWebViewBounds()
    {
        if (_webView == null || IsDisposed || Disposing) return;
        var bounds = new Rectangle(0, 0, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height));
        if (_webView.Bounds == bounds) return;
        _webView.Bounds = bounds;
        _webView.NotifyParentWindowPositionChanged();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateWebViewBounds();
        UpdateInteractionRegion();
    }

    private static CoreWebView2MouseEventVirtualKeys MouseKeyState()
    {
        var keys = CoreWebView2MouseEventVirtualKeys.None;
        if ((MouseButtons & MouseButtons.Left) != 0) keys |= CoreWebView2MouseEventVirtualKeys.LeftButton;
        if ((MouseButtons & MouseButtons.Right) != 0) keys |= CoreWebView2MouseEventVirtualKeys.RightButton;
        if ((MouseButtons & MouseButtons.Middle) != 0) keys |= CoreWebView2MouseEventVirtualKeys.MiddleButton;
        if ((MouseButtons & MouseButtons.XButton1) != 0) keys |= CoreWebView2MouseEventVirtualKeys.XButton1;
        if ((MouseButtons & MouseButtons.XButton2) != 0) keys |= CoreWebView2MouseEventVirtualKeys.XButton2;
        if ((ModifierKeys & Keys.Control) != 0) keys |= CoreWebView2MouseEventVirtualKeys.Control;
        if ((ModifierKeys & Keys.Shift) != 0) keys |= CoreWebView2MouseEventVirtualKeys.Shift;
        return keys;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        // Once a drag starts on the Unity scene, keep the entire gesture on
        // Unity even when the pointer crosses a HUD widget. Switching the
        // destination based on the current hit-test rectangle makes orbiting
        // stutter or stop as soon as the cursor reaches a panel.
        if (_forwardingMouse)
        {
            ForwardMouseMessage(NativeMethods.WmMouseMove, e.Button, e.Location);
            return;
        }
        if (Capture || IsInteractivePoint(e.Location))
            _webView?.SendMouseInput(CoreWebView2MouseEventKind.Move, MouseKeyState(), 0, e.Location);
        else
            ForwardMouseMessage(NativeMethods.WmMouseMove, e.Button, e.Location);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        _webView?.SendMouseInput(CoreWebView2MouseEventKind.Leave, CoreWebView2MouseEventVirtualKeys.None, 0, Point.Empty);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (_webView == null) return;
        if (!IsInteractivePoint(e.Location))
        {
            _forwardingMouse = true;
            // The transparent overlay is a full-size owned popup. Without
            // capture, a drag can be retargeted when it crosses one of the
            // interactive HUD rectangles (or briefly leaves the client area).
            Capture = true;
            ForwardMouseMessage(MouseDownMessage(e.Button, e.Clicks > 1), e.Button, e.Location, buttonIsDown: true);
            return;
        }
        Capture = true;
        _webView.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
        var kind = e.Button switch
        {
            MouseButtons.Right => e.Clicks > 1 ? CoreWebView2MouseEventKind.RightButtonDoubleClick : CoreWebView2MouseEventKind.RightButtonDown,
            MouseButtons.Middle => e.Clicks > 1 ? CoreWebView2MouseEventKind.MiddleButtonDoubleClick : CoreWebView2MouseEventKind.MiddleButtonDown,
            MouseButtons.XButton1 or MouseButtons.XButton2 => e.Clicks > 1 ? CoreWebView2MouseEventKind.XButtonDoubleClick : CoreWebView2MouseEventKind.XButtonDown,
            _ => e.Clicks > 1 ? CoreWebView2MouseEventKind.LeftButtonDoubleClick : CoreWebView2MouseEventKind.LeftButtonDown
        };
        _webView.SendMouseInput(kind, MouseKeyState(), XButtonData(e.Button), e.Location);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (_forwardingMouse)
        {
            ForwardMouseMessage(MouseUpMessage(e.Button), e.Button, e.Location, buttonIsDown: false);
            _forwardingMouse = false;
            Capture = false;
            return;
        }
        var kind = e.Button switch
        {
            MouseButtons.Right => CoreWebView2MouseEventKind.RightButtonUp,
            MouseButtons.Middle => CoreWebView2MouseEventKind.MiddleButtonUp,
            MouseButtons.XButton1 or MouseButtons.XButton2 => CoreWebView2MouseEventKind.XButtonUp,
            _ => CoreWebView2MouseEventKind.LeftButtonUp
        };
        _webView?.SendMouseInput(kind, MouseKeyState(), XButtonData(e.Button), e.Location);
        if (MouseButtons == MouseButtons.None) Capture = false;
    }

    private static uint XButtonData(MouseButtons button) => button switch
    {
        MouseButtons.XButton1 => 1u,
        MouseButtons.XButton2 => 2u,
        _ => 0u
    };

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        // The composition WebView has no HWND to receive wheel messages.
        if (IsInteractivePoint(e.Location))
            _webView?.SendMouseInput(CoreWebView2MouseEventKind.Wheel, MouseKeyState(), unchecked((uint)e.Delta), e.Location);
        else
            ForwardMouseWheel(NativeMethods.WmMouseWheel, e.Delta, e.Location);
    }

    private void ForwardMouseMessage(uint message, MouseButtons button, Point overlayPoint, bool? buttonIsDown = null)
    {
        if (_parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!TryGetParentClientPoint(overlayPoint, out var parentPoint)) return;
        if (message is NativeMethods.WmLButtonDown
            or NativeMethods.WmRButtonDown
            or NativeMethods.WmMButtonDown
            or NativeMethods.WmXButtonDown)
        {
            NativeMethods.SetForegroundWindow(_parentHandle);
        }
        var buttonState = MouseMessageKeyState(button, buttonIsDown ?? true);
        var xButton = button switch
        {
            MouseButtons.XButton1 => 1,
            MouseButtons.XButton2 => 2,
            _ => 0
        };
        var wParam = buttonState | (xButton << 16);
        NativeMethods.PostMessage(
            _parentHandle,
            message,
            new IntPtr(wParam),
            NativeMethods.PackClientPoint(parentPoint.X, parentPoint.Y)
        );
    }

    private void ForwardMouseWheel(uint message, int delta, Point overlayPoint)
    {
        if (_parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        var screenPoint = PointToScreen(overlayPoint);
        var wParam = (MouseMessageKeyState(MouseButtons.None) & 0xffff)
            | (unchecked((ushort)delta) << 16);
        NativeMethods.PostMessage(
            _parentHandle,
            message,
            new IntPtr(wParam),
            NativeMethods.PackScreenPoint(screenPoint.X, screenPoint.Y)
        );
    }

    private bool TryGetParentClientPoint(Point overlayPoint, out NativeMethods.Point parentPoint)
    {
        var screenPoint = PointToScreen(overlayPoint);
        parentPoint = new NativeMethods.Point { X = screenPoint.X, Y = screenPoint.Y };
        return NativeMethods.ScreenToClient(_parentHandle, ref parentPoint);
    }

    private static int MouseMessageKeyState(MouseButtons button, bool buttonIsDown = true)
    {
        var buttons = MouseButtons;
        if (buttonIsDown) buttons |= button;
        else buttons &= ~button;
        var keys = 0;
        if ((buttons & MouseButtons.Left) != 0) keys |= NativeMethods.MkLButton;
        if ((buttons & MouseButtons.Right) != 0) keys |= NativeMethods.MkRButton;
        if ((buttons & MouseButtons.Middle) != 0) keys |= NativeMethods.MkMButton;
        if ((buttons & MouseButtons.XButton1) != 0) keys |= NativeMethods.MkXButton1;
        if ((buttons & MouseButtons.XButton2) != 0) keys |= NativeMethods.MkXButton2;
        if ((ModifierKeys & Keys.Control) != 0) keys |= NativeMethods.MkControl;
        if ((ModifierKeys & Keys.Shift) != 0) keys |= NativeMethods.MkShift;
        return keys;
    }

    private static uint MouseDownMessage(MouseButtons button, bool doubleClick) => button switch
    {
        MouseButtons.Right => NativeMethods.WmRButtonDown,
        MouseButtons.Middle => NativeMethods.WmMButtonDown,
        MouseButtons.XButton1 or MouseButtons.XButton2 => NativeMethods.WmXButtonDown,
        _ => doubleClick ? NativeMethods.WmLButtonDblClk : NativeMethods.WmLButtonDown
    };

    private static uint MouseUpMessage(MouseButtons button) => button switch
    {
        MouseButtons.Right => NativeMethods.WmRButtonUp,
        MouseButtons.Middle => NativeMethods.WmMButtonUp,
        MouseButtons.XButton1 or MouseButtons.XButton2 => NativeMethods.WmXButtonUp,
        _ => NativeMethods.WmLButtonUp
    };

    protected override void WndProc(ref Message message)
    {
        // This is a cross-process owned popup. HTTRANSPARENT only searches
        // windows on the same UI thread, so returning it here would drop
        // clicks instead of passing them to Unity. Mouse messages are routed
        // explicitly by the handlers below; the composition surface remains
        // a full rectangle and is never clipped by Form.Region.
        if (message.Msg == 0x0014) // WM_ERASEBKGND: no opaque backing surface.
        {
            message.Result = new IntPtr(1);
            return;
        }
        if (message.Msg == 0x0020 && _webView?.Cursor is { } cursor && cursor != IntPtr.Zero)
        {
            SetCursor(cursor);
            message.Result = new IntPtr(1);
            return;
        }
        if (message.Msg == 0x020E && _webView != null) // WM_MOUSEHWHEEL
        {
            var packed = message.LParam.ToInt64();
            var screenPoint = new Point(unchecked((short)packed), unchecked((short)(packed >> 16)));
            var point = PointToClient(screenPoint);
            var delta = unchecked((short)(message.WParam.ToInt64() >> 16));
            if (IsInteractivePoint(point))
                _webView.SendMouseInput(CoreWebView2MouseEventKind.HorizontalWheel, MouseKeyState(), unchecked((uint)delta), point);
            else
                ForwardMouseWheel(0x020E, delta, point);
            message.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref message);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetCursor(IntPtr cursor);

    private void AttachToParent(IntPtr parentHandle)
    {
        if (_attached && _parentHandle == parentHandle) return;
        _parentHandle = parentHandle;

        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsChild
            | NativeMethods.WsCaption
            | NativeMethods.WsThickFrame
            | NativeMethods.WsMinimizeBox
            | NativeMethods.WsMaximizeBox
            | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsPopup | NativeMethods.WsVisible;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);

        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        // Setting an owner keeps the HUD above Unity and hides it with Unity,
        // without turning the DirectComposition target into a child HWND.
        NativeMethods.SetWindowOwner(Handle, _parentHandle);
        _attached = true;
        _lastParentClientSize = Size.Empty;
    }

    private void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!WebContentPolicy.IsSameOrigin(args.Source, _options.Url)) return;
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString();
            if (type == "overlay_ready")
            {
                PostHostState();
                return;
            }
            if (type == "overlay_regions") ReadInteractionRegions(root);
            if (type == "dashboard_action") HandleDashboardAction(root);
        }
        catch (Exception exception)
        {
            WriteOverlayError("透明数据层消息解析失败", exception);
        }
    }

    private static void HandleDashboardAction(JsonElement root)
    {
        if (!root.TryGetProperty("action", out var actionElement)) return;
        var action = actionElement.GetString();
        if (action != "open_link" || !root.TryGetProperty("url", out var urlElement)) return;
        var url = urlElement.GetString();
        if (string.IsNullOrWhiteSpace(url)
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return;
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    private void ReadInteractionRegions(JsonElement root)
    {
        var viewportWidth = 1f;
        var viewportHeight = 1f;
        if (root.TryGetProperty("viewport", out var viewport))
        {
            viewportWidth = ReadPositiveSingle(viewport, "width", 1f);
            viewportHeight = ReadPositiveSingle(viewport, "height", 1f);
        }

        _cssViewport = new SizeF(viewportWidth, viewportHeight);
        _cssRegions.Clear();
        if (root.TryGetProperty("regions", out var regions) && regions.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in regions.EnumerateArray())
            {
                var x = ReadSingle(item, "x", 0f);
                var y = ReadSingle(item, "y", 0f);
                var width = ReadPositiveSingle(item, "width", 0f);
                var height = ReadPositiveSingle(item, "height", 0f);
                if (width < 1f || height < 1f) continue;
                _cssRegions.Add(new RectangleF(x, y, width, height));
            }
        }
        UpdateInteractionRegion();
    }

    private static float ReadSingle(JsonElement element, string name, float fallback)
    {
        if (!element.TryGetProperty(name, out var value) || !value.TryGetSingle(out var result)) return fallback;
        return float.IsFinite(result) ? result : fallback;
    }

    private static float ReadPositiveSingle(JsonElement element, string name, float fallback)
    {
        var value = ReadSingle(element, name, fallback);
        return value > 0f ? value : fallback;
    }

    private void UpdateInteractionRegion()
    {
        if (IsDisposed || ClientSize.Width < 1 || ClientSize.Height < 1)
        {
            return;
        }

        var pixelRegions = new List<Rectangle>();
        foreach (var item in _cssRegions)
        {
            var bounds = OverlayInteractionGeometry.ToPixels(item, _cssViewport, ClientSize);
            if (!bounds.IsEmpty) pixelRegions.Add(bounds);
        }

        if (_appliedRegions.SequenceEqual(pixelRegions)) return;
        _appliedRegions.Clear();
        _appliedRegions.AddRange(pixelRegions);

    }

    private void ApplyEmptyInteractionRegion()
    {
        _cssRegions.Clear();
        _appliedRegions.Clear();
    }

    private bool IsInteractivePoint(Point point) => OverlayInteractionGeometry.ContainsPoint(_appliedRegions, point);

    private void PostHostState()
    {
        if (!_initialized || _webView?.CoreWebView2 == null || IsDisposed) return;
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "overlay_host_state",
                visible = _visibleRequested,
                attached = _attached,
                width = ClientSize.Width,
                height = ClientSize.Height,
                dpi = _lastDpi,
                zoomFactor = _webView.ZoomFactor,
                renderer = "direct-composition",
                presentationMode = _presentationMode
            }));
        }
        catch
        {
            // The page can be between navigations; it reports its regions again after loading.
        }
    }

    private static string BuildOverlayUrl(string sourceUrl)
    {
        try
        {
            var source = new Uri(sourceUrl, UriKind.Absolute);
            var builder = new UriBuilder(source)
            {
                Path = "/overlay",
                Query = "embedded=unity&release=current"
            };
            return builder.Uri.AbsoluteUri;
        }
        catch
        {
            return "http://127.0.0.1:3001/overlay?embedded=unity&release=current";
        }
    }

    private static void WriteOverlayError(string message, Exception? exception = null)
    {
        try
        {
            var directory = Program.LogDirectory;
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {message}{(exception == null ? string.Empty : $": {exception}")}\n"
            );
        }
        catch
        {
            // Overlay diagnostics must not affect the dashboard.
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            try
            {
                var controller = _webView;
                _webView = null;
                if (controller != null)
                {
                    controller.AcceleratorKeyPressed -= HandleAcceleratorKey;
                    controller.CursorChanged -= HandleCursorChanged;
                    try { controller.RootVisualTarget = null; }
                    finally { controller.Close(); }
                }
            }
            catch (Exception exception)
            {
                WriteOverlayError("透明数据层 WebView2 已提前关闭", exception);
            }
            try { _compositionSurface?.Dispose(); }
            catch (Exception exception) { WriteOverlayError("透明数据层合成资源已提前关闭", exception); }
            finally { _compositionSurface = null; }
        }
        base.Dispose(disposing);
    }
}
