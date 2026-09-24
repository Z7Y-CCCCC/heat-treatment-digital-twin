using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HeatTreatmentAdminHost;

internal sealed class AdminPanelForm : Form
{
    private const int HeaderHeight = 46;
    private const int MinimumPanelWidth = 860;
    private const int MinimumPanelHeight = 560;
    private const int DragDetachDistance = 34;
    private const int WindowMoveStartDistance = 5;
    private const int ParentDockStripHeight = 92;
    private const int ResizeBorderThickness = 8;
    private const int RoundedCornerRadius = 12;
    private static readonly HttpClient DesktopControlClient = new() { Timeout = TimeSpan.FromSeconds(1.5) };
    private static readonly HttpClient DashboardSessionClient = new(new HttpClientHandler
    {
        UseProxy = false,
        UseCookies = false
    }) { Timeout = TimeSpan.FromSeconds(6) };
    private readonly HostOptions _options;
    private readonly WebView2 _webView = new();
    private readonly Panel _header = new();
    private readonly Label _title = new();
    private readonly Label _status = new();
    private readonly Button _maximizeButton = new();
    private readonly Button _closeButton = new();
    private readonly Panel _resizeGrip = new();
    private readonly System.Windows.Forms.Timer _parentTimer = new() { Interval = 33 };
    private readonly CancellationTokenSource _pipeCancellation = new();
    private DashboardChromeForm? _dashboardChrome;
    private DashboardOverlayForm? _dashboardOverlay;
    private WebViewNavigationRetry? _navigationRetry;
    private readonly Rectangle _defaultDetachedBounds;
    private Rectangle _embeddedBounds;
    private Rectangle _savedDetachedBounds;
    private Rectangle _parentRestoreBounds;
    private bool _attached;
    private bool _adminVisible;
    private bool _parentMaximized;
    private bool _maximized;
    private bool _panelHidden;
    private bool _castPresentationMode;
    private bool _dashboardAccessCheckInProgress;
    private string _dashboardAccessError = string.Empty;
    private bool _returnToDashboardAfterUnlock;
    private bool _initialMapPending = true;
    private bool _dragging;
    private bool _draggingParentWindow;
    private bool _parentDragStarted;
    private bool _nativeDetachedMovePending;
    private bool _resizing;
    private bool _dockReady;
    private bool _closeChoiceOpen;
    private Point _dragStart;
    private Point _dragPointerOffset;
    private Rectangle _dragStartBounds;
    private IntPtr _parentHandle;
    private readonly DateTime? _parentProcessStartTimeUtc;
    private bool _waitingForParentWindow;
    private bool _closing;
    private bool _webViewDisposeAttempted;
    private bool _startupReadyReported;
    private bool _startupReadyReportInProgress;
    private readonly TaskCompletionSource<bool> _adminPageReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _exitRequested;
    private Task? _pipeTask;

    public AdminPanelForm(HostOptions options)
    {
        _options = options;
        _parentHandle = options.ParentWindowHandle;
        _parentProcessStartTimeUtc = ReadProcessStartTimeUtc(options.ParentProcessId);
        _defaultDetachedBounds = new Rectangle(120, 90, 1320, 820);
        _embeddedBounds = Rectangle.Empty;
        _savedDetachedBounds = _defaultDetachedBounds;
        _parentRestoreBounds = Rectangle.Empty;
        _attached = _parentHandle != IntPtr.Zero;
        _adminVisible = !options.StartInDashboardMode;

        Text = "后台管理";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        BackColor = Color.FromArgb(15, 23, 42);
        MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        ClientSize = _defaultDetachedBounds.Size;
        Location = _defaultDetachedBounds.Location;

        BuildChrome();
        _parentTimer.Tick += (_, _) => MaintainParentWindow();
        Shown += async (_, _) =>
        {
            _pipeTask = ListenForCommandsAsync(_pipeCancellation.Token);
            // 先把宿主窗口嵌入 Unity 正确位置，再创建/导航 WebView2。
            // 否则 WebView2 会以默认窗体尺寸短暂闪现成一块黑色矩形。
            ApplyInitialPlacement();
            await InitializeWebViewAsync();
        };
        FormClosed += (_, _) =>
        {
            _parentTimer.Stop();
            _pipeCancellation.Cancel();
        };
    }

    private void BuildChrome()
    {
        _header.Dock = DockStyle.Top;
        _header.Height = 0;
        _header.Visible = false;
        _header.BackColor = Color.FromArgb(15, 31, 53);
        _header.Padding = new Padding(14, 0, 8, 0);
        _header.Cursor = Cursors.SizeAll;
        _header.MouseDown += BeginDrag;
        _header.MouseMove += ContinueDrag;
        _header.MouseUp += EndDrag;
        _header.DoubleClick += (_, _) => ToggleMaximize();

        _title.Text = "后台管理";
        _title.AutoSize = false;
        _title.Dock = DockStyle.Left;
        _title.Width = 250;
        _title.TextAlign = ContentAlignment.MiddleLeft;
        _title.ForeColor = Color.White;
        _title.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
        _title.Cursor = Cursors.SizeAll;
        _title.MouseDown += BeginDrag;
        _title.MouseMove += ContinueDrag;
        _title.MouseUp += EndDrag;

        _status.Text = "正在加载管理后台…";
        _status.AutoSize = true;
        _status.Dock = DockStyle.Left;
        _status.Padding = new Padding(8, 0, 0, 0);
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.ForeColor = Color.FromArgb(161, 181, 201);
        _status.Font = new Font("Microsoft YaHei UI", 9f);

        ConfigureButton(_maximizeButton, "最大化", ToggleMaximize);
        ConfigureButton(_closeButton, "关闭", (_, _) => HidePanel());
        _closeButton.BackColor = Color.FromArgb(160, 54, 54);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            Width = 164,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Padding = new Padding(0, 7, 0, 7),
            BackColor = Color.Transparent
        };
        buttons.Controls.Add(_closeButton);
        buttons.Controls.Add(_maximizeButton);

        _header.Controls.Add(buttons);
        _header.Controls.Add(_status);
        _header.Controls.Add(_title);

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(246, 247, 249);
        _webView.Visible = false;

        _resizeGrip.Size = new Size(18, 18);
        _resizeGrip.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
        _resizeGrip.BackColor = Color.Transparent;
        _resizeGrip.Cursor = Cursors.SizeNWSE;
        _resizeGrip.Visible = false;
        _resizeGrip.Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(118, 143, 167), 1f);
            for (var offset = 4; offset <= 12; offset += 4)
            {
                e.Graphics.DrawLine(pen, _resizeGrip.Width - offset, _resizeGrip.Height - 2, _resizeGrip.Width - 2, _resizeGrip.Height - offset);
            }
        };
        _resizeGrip.MouseDown += BeginResize;
        _resizeGrip.MouseMove += ContinueResize;
        _resizeGrip.MouseUp += EndResize;

        Controls.Add(_webView);
        Controls.Add(_header);
        Controls.Add(_resizeGrip);
        _resizeGrip.BringToFront();
    }

    private static void ConfigureButton(Button button, string text, EventHandler click)
    {
        button.Text = text;
        button.Width = 72;
        button.Height = 30;
        button.Margin = new Padding(5, 0, 0, 0);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = Color.FromArgb(38, 70, 101);
        button.ForeColor = Color.White;
        button.Font = new Font("Microsoft YaHei UI", 9f);
        button.Cursor = Cursors.Hand;
        button.Click += click;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userData = _options.UserDataFolder;
            if (string.IsNullOrWhiteSpace(userData))
            {
                userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "heat-treatment-digital-twin-desktop",
                    "webview2"
                );
            }
            Directory.CreateDirectory(userData);
            var fixedRuntime = Directory.Exists(_options.FixedRuntimeFolder)
                ? _options.FixedRuntimeFolder
                : null;
            var environment = await CoreWebView2Environment.CreateAsync(fixedRuntime, userData);
            if (_closing || IsDisposed) return;
            await _webView.EnsureCoreWebView2Async(environment);
            if (_closing || IsDisposed) return;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _webView.CoreWebView2.NewWindowRequested += HandleNewWindow;
            _webView.CoreWebView2.NavigationStarting += (_, args) =>
                args.Cancel = !WebContentPolicy.IsSameOrigin(args.Uri, _options.Url);
            _navigationRetry = new WebViewNavigationRetry(_webView.CoreWebView2, _options.Url,
                attempt => _status.Text = $"正在重新连接现场服务（{attempt}）…");
            _webView.CoreWebView2.DownloadStarting += HandleDownload;
            _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
            _webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                BeginInvoke(() =>
                {
                    if (_closing || IsDisposed) return;
                    if (_navigationRetry?.IsCurrentNavigation(args.NavigationId) != true) return;
                    if (!WebViewNavigationRetry.IsUsable(args))
                    {
                        _webView.Visible = false;
                        WriteHostError(
                            $"后台页面加载失败（{args.WebErrorStatus}）",
                            new InvalidOperationException($"WebView2 navigation failed: {args.WebErrorStatus}")
                        );
                        return;
                    }
                    // 大屏模式只显示这个 WebView 的顶部 46px，承载“实时大屏 / 后台管理”页签。
                    // 不能按 _adminVisible 隐藏，否则只会剩下一条深色空白底。
                    _webView.Visible = !_panelHidden;
                    _status.Text = "已连接现场服务";
                    SendHostState();
                    _adminPageReady.TrySetResult(true);
                });
            };
            _webView.CoreWebView2.Navigate(_options.Url);
            try
            {
                _dashboardOverlay = new DashboardOverlayForm(_options);
                _dashboardOverlay.AdminRequested += ShowAdminFromOverlay;
                await _dashboardOverlay.InitializeAsync(environment);
                if (_closing || IsDisposed)
                {
                    _dashboardOverlay.Dispose();
                    _dashboardOverlay = null;
                    return;
                }
                // The dashboard-mode placement runs before WebView2 finishes
                // initializing, so the first SyncDashboardOverlay call sees a
                // null overlay and cannot show it. Re-sync immediately after
                // the composition controller exists instead of waiting for a
                // parent-timer tick (or leaving the overlay hidden forever).
                SyncDashboardOverlay();
            }
            catch (Exception overlayException)
            {
                if (_closing || IsDisposed) return;
                WriteHostError("透明 WebView2 数据层初始化失败", overlayException);
                _dashboardOverlay?.Dispose();
                _dashboardOverlay = null;
            }
            await _adminPageReady.Task;
            if (_closing || IsDisposed) return;
            // Complete the initial placement before the desktop startup cover
            // is removed. An unsigned-in user must see the existing admin
            // login, never a second login painted on the Unity scene.
            if (!_adminVisible && !await HasDashboardLaunchPermissionAsync())
            {
                _returnToDashboardAfterUnlock = true;
                ShowAdmin();
            }
            await ReportStartupReadyAsync();
            _status.Text = "已嵌入 Unity 大屏 · 可拖动后台管理页签";
        }
        catch (Exception exception)
        {
            if (_closing || IsDisposed) return;
            _status.Text = "后台加载失败";
            var error = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(120, 30, 30),
                BackColor = Color.FromArgb(250, 245, 245),
                Font = new Font("Microsoft YaHei UI", 11f),
                Text = $"无法加载内嵌后台。\n{exception.Message}\n\n请安装 Microsoft Edge WebView2 Runtime，或联系工程师检查日志。"
            };
            Controls.Add(error);
            error.BringToFront();
        }
    }

    private void HandleNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (WebContentPolicy.IsSameOrigin(args.Uri, _options.Url))
        {
            _webView.CoreWebView2.Navigate(args.Uri);
        }
        else if (args.IsUserInitiated && Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception exception) { WriteHostError("外部链接打开失败", exception); }
        }
    }

    private void HandleDownload(object? sender, CoreWebView2DownloadStartingEventArgs args)
    {
        using var dialog = new SaveFileDialog
        {
            Title = "保存后台导出文件",
            FileName = Path.GetFileName(args.ResultFilePath),
            Filter = "备份文件|*.zip;*.db|所有文件|*.*",
            RestoreDirectory = true
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            args.ResultFilePath = dialog.FileName;
            args.Handled = true;
        }
        else
        {
            args.Cancel = true;
            args.Handled = true;
        }
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
            if (type == "close_admin")
            {
                HandleCloseRequest();
                return;
            }
            if (type == "host_action" && root.TryGetProperty("action", out var actionElement))
            {
                var action = actionElement.GetString();
                if (action == "attach" && !_attached) AttachToParent(true);
                else if (action == "detach" && _attached) DetachFromParent();
                else if (action == "toggle_attach") ToggleAttach();
                else if (action == "minimize") MinimizeActiveWindow();
                else if (action == "maximize") ToggleMaximize();
                else if (action == "show_dashboard") ShowDashboard();
                else if (action == "show_admin")
                {
                    if (root.TryGetProperty("returnToDashboard", out var returnToDashboard)
                        && returnToDashboard.ValueKind == JsonValueKind.True)
                        _returnToDashboardAfterUnlock = true;
                    ShowAdmin();
                }
                else if (action == "reload_page") ReloadWebPages();
                else if (action == "close_window") HandleCloseRequest();
                else if (action == "close") HandleCloseRequest();
                else if (action == "clear_unity_session") ForwardUnitySessionCommand("clear_unity_session");
                else if (action == "sync_unity_session"
                    && root.TryGetProperty("ticket", out var ticketElement)
                    && ticketElement.ValueKind == JsonValueKind.String)
                {
                    var ticket = ticketElement.GetString();
                    if (ticket is { Length: 64 } && ticket.All(Uri.IsHexDigit))
                        ForwardUnitySessionCommand("sync_unity_session", ticket);
                }
                else if (action == "state") SendHostState();
                SendHostState();
                return;
            }
            if (type == "host_drag_start")
            {
                var target = root.TryGetProperty("target", out var targetElement)
                    ? targetElement.GetString() ?? "admin"
                    : "admin";
                BeginWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"), target);
                return;
            }
            if (type == "host_window_move_start")
            {
                BeginNativeParentWindowMove(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
                return;
            }
            if (type == "host_drag_move")
            {
                ContinueWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
                return;
            }
            if (type == "host_drag_end")
            {
                EndWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
            }
        }
        catch
        {
            // Messages from the page are advisory; malformed messages do not affect the host.
        }
    }

    private void ForwardUnitySessionCommand(string action, string? ticket = null)
    {
        if (_options.ParentProcessId <= 0 || _closing) return;
        var message = JsonSerializer.Serialize(new { action, ticket });
        _ = Task.Run(async () =>
        {
            var attempts = action == "sync_unity_session" ? 12 : 1;
            for (var attempt = 0; attempt < attempts && !_pipeCancellation.IsCancellationRequested; attempt++)
            {
                try
                {
                    await using var pipe = new NamedPipeClientStream(
                        ".",
                        $"HeatTreatmentUnityAuth_{_options.ParentProcessId}",
                        PipeDirection.Out,
                        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
                    );
                    await pipe.ConnectAsync(350, _pipeCancellation.Token);
                    await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, leaveOpen: true);
                    await writer.WriteLineAsync(message);
                    await writer.FlushAsync();
                    return;
                }
                catch (OperationCanceledException) when (_pipeCancellation.IsCancellationRequested)
                {
                    return;
                }
                catch
                {
                    if (attempt + 1 < attempts)
                    {
                        try { await Task.Delay(180, _pipeCancellation.Token); }
                        catch (OperationCanceledException) { return; }
                    }
                }
            }
        });
    }

    private static int ReadCoordinate(JsonElement element, string key)
    {
        return element.TryGetProperty(key, out var value) && value.TryGetInt32(out var coordinate)
            ? coordinate
            : 0;
    }

    private void SendHostState()
    {
        if (!_webViewReadyForMessages()) return;
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "host_state",
                attached = _attached,
                maximized = _attached ? _parentMaximized : _maximized,
                dockReady = _dockReady,
                adminVisible = _adminVisible,
                returnToDashboardAfterUnlock = _returnToDashboardAfterUnlock,
                dashboardAccessError = _dashboardAccessError
            }));
        }
        catch
        {
            // The page may be navigating; it will request state after the next navigation.
        }
    }

    private bool _webViewReadyForMessages()
    {
        return _webView.CoreWebView2 != null && !IsDisposed;
    }

    private void ReloadWebPages()
    {
        if (_closing || IsDisposed) return;
        try
        {
            // Paint the opaque Unity cover before either WebView starts a
            // navigation. The admin reload can otherwise yield a frame first.
            _dashboardOverlay?.Reload();
        }
        catch (Exception exception)
        {
            WriteHostError("透明数据层刷新失败", exception);
        }

        try
        {
            _webView.CoreWebView2?.Reload();
        }
        catch (Exception exception)
        {
            WriteHostError("后台页面刷新失败", exception);
        }
    }

    private void ApplyInitialPlacement()
    {
        if (TryResolveParentWindow())
        {
            _waitingForParentWindow = false;
            _parentTimer.Interval = 33;
            InitializeParentWindowState();
            AttachToParent(false);
        }
        else
        {
            _attached = false;
            _waitingForParentWindow = _options.ParentProcessId > 0;
            _parentTimer.Interval = 500;
            if (_waitingForParentWindow)
            {
                // Unity 首次启动时 HWND 可能晚几秒出现。此时保持隐藏，避免先闪出一个
                // 独立后台窗口，随后又嵌入 Unity，造成“同时出现两个窗口”的错觉。
                Hide();
            }
            else
            {
                _adminVisible = true;
                Bounds = _defaultDetachedBounds;
                ShowPanel();
            }
        }
        if (_options.ParentProcessId > 0) _parentTimer.Start();
    }

    private static DateTime? ReadProcessStartTimeUtc(int processId)
    {
        if (processId <= 0) return null;
        try
        {
            using var process = Process.GetProcessById(processId);
            if (process.HasExited) return null;
            return process.StartTime.ToUniversalTime();
        }
        catch
        {
            return null;
        }
    }

    private bool IsParentProcessRunning()
    {
        // If the original process could not be identified, never accept a later
        // process that happens to reuse that PID as our parent.
        if (!_parentProcessStartTimeUtc.HasValue) return false;
        var currentStartTime = ReadProcessStartTimeUtc(_options.ParentProcessId);
        if (!currentStartTime.HasValue) return false;
        return currentStartTime.Value == _parentProcessStartTimeUtc.Value;
    }

    private bool TryResolveParentWindow()
    {
        if (_options.ParentProcessId <= 0) return false;
        if (!IsParentProcessRunning()) return false;
        if (IsOwnedParentWindow(_parentHandle)) return true;
        _parentHandle = IntPtr.Zero;
        try
        {
            using var process = Process.GetProcessById(_options.ParentProcessId);
            process.Refresh();
            if (IsOwnedParentWindow(process.MainWindowHandle))
            {
                _parentHandle = process.MainWindowHandle;
                return true;
            }
        }
        catch
        {
            // Parent may still be starting or may have exited.
        }
        return false;
    }

    private bool IsOwnedParentWindow(IntPtr handle)
    {
        if (handle == IntPtr.Zero || !NativeMethods.IsWindow(handle)) return false;
        return NativeMethods.GetWindowThreadProcessId(handle, out var processId) != 0
            && processId == _options.ParentProcessId;
    }

    private void MaintainParentWindow()
    {
        if (_closing || IsDisposed) return;
        if (!IsParentProcessRunning())
        {
            RequestCloseAfterParentExit();
            return;
        }
        if (!TryResolveParentWindow())
        {
            // Unity can take several seconds to create its main HWND (and smoke/
            // batch mode may never create one).  Keep monitoring the process at a
            // low rate instead of becoming an orphan or closing during startup.
            _waitingForParentWindow = true;
            _parentTimer.Interval = 500;
            return;
        }
        if (_waitingForParentWindow)
        {
            _waitingForParentWindow = false;
            _parentTimer.Interval = 33;
            InitializeParentWindowState();
            AttachToParent(false);
            return;
        }
        RefreshParentWindowState();
        _dashboardOverlay?.UpdateParentBounds();
        if (_castPresentationMode)
        {
            // 投屏展示模式下，后台宿主保持隐藏；只维护透明数据层的尺寸。
            SyncDashboardOverlay();
            return;
        }
        if (!_attached)
        {
            _dashboardChrome?.UpdateParentBounds();
            SyncDashboardOverlay();
            return;
        }
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds());
        SyncDashboardOverlay();
    }

    private void RefreshParentWindowState()
    {
        if (_parentHandle == IntPtr.Zero || NativeMethods.IsIconic(_parentHandle)) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var rect)) return;
        var current = rect.ToRectangle();
        if (current.Width <= 0 || current.Height <= 0) return;
        var maximized = NativeMethods.IsZoomed(_parentHandle);
        if (!maximized) _parentRestoreBounds = current;
        if (_parentMaximized == maximized) return;
        _parentMaximized = maximized;
        _dashboardChrome?.UpdateState(maximized);
        SendHostState();
    }

    private Size GetParentClientSize()
    {
        return NativeMethods.GetClientRect(_parentHandle, out var rect)
            ? new Size(Math.Max(1, rect.Width), Math.Max(1, rect.Height))
            : new Size(1600, 900);
    }

    private Rectangle GetParentClientScreenBounds()
    {
        var size = GetParentClientSize();
        var origin = new NativeMethods.Point { X = 0, Y = 0 };
        if (NativeMethods.ClientToScreen(_parentHandle, ref origin))
        {
            return new Rectangle(origin.X, origin.Y, size.Width, size.Height);
        }
        return NativeMethods.GetWindowRect(_parentHandle, out var rect)
            ? rect.ToRectangle()
            : Rectangle.Empty;
    }

    private bool IsParentDockPoint(int screenX, int screenY)
    {
        if (!TryResolveParentWindow()) return false;
        var parent = GetParentClientScreenBounds();
        if (parent == Rectangle.Empty) return false;
        var dockStripHeight = NativeMethods.Scale96(
            ParentDockStripHeight,
            NativeMethods.GetWindowDpiOrDefault(_parentHandle)
        );
        var dockBottom = parent.Top + Math.Min(dockStripHeight, parent.Height);
        return screenX >= parent.Left
            && screenX < parent.Right
            && screenY >= parent.Top - 8
            && screenY < dockBottom;
    }

    private void SetDockReady(bool value)
    {
        if (_dockReady == value) return;
        _dockReady = value;
        SendHostState();
    }

    private void InitializeParentWindowState()
    {
        if (!NativeMethods.GetWindowRect(_parentHandle, out var rect)) return;
        var current = rect.ToRectangle();
        var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
        _parentMaximized = NativeMethods.IsZoomed(_parentHandle);
        _parentRestoreBounds = _parentMaximized ? GetDefaultParentRestoreBounds(workingArea) : current;
    }

    private static Rectangle GetDefaultParentRestoreBounds(Rectangle workingArea)
    {
        var width = Math.Min(workingArea.Width, Math.Min(1600, Math.Max(720, workingArea.Width - 120)));
        var height = Math.Min(workingArea.Height, Math.Min(900, Math.Max(520, workingArea.Height - 100)));
        return new Rectangle(
            workingArea.Left + Math.Max(0, (workingArea.Width - width) / 2),
            workingArea.Top + Math.Max(0, (workingArea.Height - height) / 2),
            width,
            height
        );
    }

    private void ToggleParentMaximize()
    {
        if (!TryResolveParentWindow()) return;
        var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
        var maximized = NativeMethods.IsZoomed(_parentHandle);
        if (!maximized)
        {
            if (NativeMethods.GetWindowRect(_parentHandle, out var rect)) _parentRestoreBounds = rect.ToRectangle();
            NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwMaximize);
            _parentMaximized = true;
        }
        else
        {
            NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwRestore);
            if (_parentRestoreBounds.Width <= 0)
            {
                var restore = GetDefaultParentRestoreBounds(workingArea);
                NativeMethods.SetWindowPos(
                    _parentHandle,
                    NativeMethods.HwndTop,
                    restore.Left,
                    restore.Top,
                    restore.Width,
                    restore.Height,
                    NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
                );
            }
            _parentMaximized = false;
        }
        BeginInvoke(() => MaintainParentWindow());
        _dashboardChrome?.UpdateState(_parentMaximized);
        SendHostState();
    }

    private async void ShowDashboard()
    {
        if (_dashboardAccessCheckInProgress || _closing || IsDisposed) return;
        _dashboardAccessCheckInProgress = true;
        _dashboardAccessError = string.Empty;
        var authorized = await HasDashboardLaunchPermissionAsync();
        _dashboardAccessCheckInProgress = false;
        if (_closing || IsDisposed) return;
        if (!authorized)
        {
            // Unity is always running beneath this window. Keep the opaque
            // login page in front until the local account has launch rights.
            _returnToDashboardAfterUnlock = true;
            _adminVisible = true;
            if (_attached)
            {
                MinimumSize = Size.Empty;
                SetEmbeddedBounds(GetDefaultEmbeddedBounds());
            }
            ShowPanel();
            WriteHostInfo($"实时大屏切换被拒绝：{_dashboardAccessError}");
            return;
        }
        WriteHostInfo("实时大屏切换已授权");
        _returnToDashboardAfterUnlock = false;
        if (_initialMapPending && _dashboardOverlay != null)
        {
            _dashboardOverlay?.OpenMapAtTopLevel();
            _initialMapPending = false;
        }
        _castPresentationMode = false;
        _dashboardOverlay?.SetPresentationMode(false);
        _adminVisible = false;
        if (!_attached)
        {
            AttachToParent(true);
        }
        MinimumSize = Size.Empty;
        SetEmbeddedBounds(GetDashboardChromeBounds());
        ShowPanel(false);
        SyncDashboardOverlay();
        SendHostState();
    }

    private async Task<bool> HasDashboardLaunchPermissionAsync()
    {
        if (_webView.CoreWebView2 == null)
        {
            _dashboardAccessError = "后台登录页面尚未就绪，请稍后重试";
            return false;
        }
        try
        {
            // ExecuteScriptAsync serializes the immediate JavaScript result; an
            // async IIFE returns a Promise (which is serialized as null), so it
            // falsely denies every authenticated user. Reuse the WebView's
            // HttpOnly session cookie and ask the same-origin API directly.
            if (!Uri.TryCreate(_options.Url, UriKind.Absolute, out var pageUri))
            {
                _dashboardAccessError = "后台服务地址无效";
                return false;
            }
            var sessionUri = new Uri(pageUri, "/api/admin-auth/session");
            var cookies = await _webView.CoreWebView2.CookieManager.GetCookiesAsync(sessionUri.AbsoluteUri);
            var cookieHeader = string.Join("; ", cookies
                .Where(cookie => !string.IsNullOrWhiteSpace(cookie.Name))
                .Select(cookie => $"{cookie.Name}={cookie.Value}"));
            if (string.IsNullOrWhiteSpace(cookieHeader))
            {
                _dashboardAccessError = "尚未登录或会话已失效，请在后台管理登录";
                return false;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, sessionUri);
            request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
            using var response = await DashboardSessionClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            if (!response.IsSuccessStatusCode)
            {
                _dashboardAccessError = $"无法核验登录状态（HTTP {(int)response.StatusCode}），请刷新后台管理后重试";
                return false;
            }
            var body = await response.Content.ReadAsStringAsync();
            if (DashboardAccessPolicy.HasLaunchAndViewPermission(body)) return true;
            _dashboardAccessError = "当前账户未登录或没有查看、启动大屏权限";
            return false;
        }
        catch (Exception exception)
        {
            WriteHostError("实时大屏权限检查失败", exception);
            _dashboardAccessError = "登录状态检查失败，请查看 admin-host.log 并重试";
            return false;
        }
    }

    private void PrepareCastPresentation()
    {
        if (!TryResolveParentWindow()) return;
        _castPresentationMode = true;
        _adminVisible = false;
        _panelHidden = true;
        HideDetachedDashboardChrome();
        _dashboardOverlay?.SetPresentationMode(true);
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        SyncDashboardOverlay();
        SendHostState();
    }

    private void RestoreCastPresentation()
    {
        _castPresentationMode = false;
        _dashboardOverlay?.SetPresentationMode(false);
        if (TryResolveParentWindow())
        {
            // 投屏前固定切到了“实时大屏”页，恢复时继续留在这个页签。
            ShowDashboard();
        }
        else
        {
            _panelHidden = false;
            ShowPanel(false);
        }
    }

    private void ShowAdmin()
    {
        _castPresentationMode = false;
        _dashboardOverlay?.SetPresentationMode(false);
        _adminVisible = true;
        if (_attached)
        {
            MinimumSize = Size.Empty;
            SetEmbeddedBounds(GetDefaultEmbeddedBounds());
        }
        else
        {
            MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        }
        ShowPanel();
        SyncDashboardOverlay();
        SendHostState();
    }

    private void ShowAdminFromOverlay(string? focus, bool returnToDashboard)
    {
        if (returnToDashboard) _returnToDashboardAfterUnlock = true;
        if (focus == "factory-location" && _webView.CoreWebView2 != null
            && Uri.TryCreate(_options.Url, UriKind.Absolute, out var adminUri))
        {
            var builder = new UriBuilder(adminUri);
            var query = builder.Query.TrimStart('?')
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Where(part => !part.StartsWith("focus=", StringComparison.OrdinalIgnoreCase))
                .Append("focus=factory-location");
            builder.Query = string.Join("&", query);
            _webView.CoreWebView2.Navigate(builder.Uri.AbsoluteUri);
        }
        ShowAdmin();
    }

    private void SyncDashboardOverlay()
    {
        if (_dashboardOverlay == null || _dashboardOverlay.IsDisposed) return;
        if (!TryResolveParentWindow())
        {
            _dashboardOverlay.HideOverlay();
            return;
        }

        var dashboardExposed = !_attached || !_adminVisible || _panelHidden;
        if (dashboardExposed)
        {
            _dashboardOverlay.ShowForParent(_parentHandle);
        }
        else
        {
            _dashboardOverlay.HideOverlay();
        }
    }

    private async void HandleCloseRequest()
    {
        if (_closeChoiceOpen) return;
        _closeChoiceOpen = true;
        _dashboardOverlay?.HideOverlay();
        try
        {
            var choice = ShowCloseChoiceDialog();
            if (choice == CloseChoice.MinimizeToTray)
            {
                await MinimizeToTrayAsync();
            }
            else if (choice == CloseChoice.ExitApplication)
            {
                await ExitApplicationAsync();
            }
            else
            {
                SyncDashboardOverlay();
            }
        }
        catch (Exception exception)
        {
            SyncDashboardOverlay();
            WriteHostError("关闭选择弹窗创建失败", exception);
            try
            {
                MessageBox.Show(
                    this,
                    "关闭选项暂时无法显示，请重试。主程序仍在运行。",
                    "关闭操作",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
            }
            catch
            {
                // A UI fallback must never terminate the host process.
            }
        }
        finally
        {
            _closeChoiceOpen = false;
        }
    }

    private void ShowDetachedDashboardChrome()
    {
        if (_attached || !TryResolveParentWindow()) return;
        if (_dashboardChrome == null || _dashboardChrome.IsDisposed)
        {
            _dashboardChrome = new DashboardChromeForm(HandleDashboardChromeAction);
        }
        _dashboardChrome.ShowForParent(_parentHandle, _parentMaximized);
    }

    private void HideDetachedDashboardChrome()
    {
        if (_dashboardChrome == null || _dashboardChrome.IsDisposed) return;
        NativeMethods.ShowWindow(_dashboardChrome.Handle, NativeMethods.SwHide);
        _dashboardChrome.Hide();
    }

    private void HandleDashboardChromeAction(string action, int screenX, int screenY)
    {
        switch (action)
        {
            case "show_dashboard":
                ShowDashboard();
                break;
            case "focus_admin":
                ShowPanel();
                break;
            case "move_parent_native":
                BeginNativeParentWindowMove(screenX, screenY);
                break;
            case "move_parent_start":
                BeginParentWindowDrag(screenX, screenY);
                break;
            case "move_parent_move":
                ContinueWindowDrag(screenX, screenY);
                break;
            case "move_parent_end":
                EndWindowDrag(screenX, screenY);
                break;
            case "minimize":
                MinimizeActiveWindow();
                break;
            case "maximize":
                ToggleParentMaximize();
                break;
            case "reload":
                ReloadWebPages();
                break;
            case "close":
                HandleCloseRequest();
                break;
        }
    }

    private Rectangle GetDefaultEmbeddedBounds()
    {
        var client = GetParentClientSize();
        return new Rectangle(0, 0, client.Width, client.Height);
    }

    private Rectangle GetDashboardChromeBounds()
    {
        var client = GetParentClientSize();
        return new Rectangle(0, 0, client.Width, GetParentChromeHeightPixels());
    }

    private int GetParentChromeHeightPixels()
    {
        return DashboardChromeForm.GetChromeHeightPixels(_parentHandle);
    }

    private int GetCurrentChromeHeightPixels()
    {
        return _attached
            ? GetParentChromeHeightPixels()
            : NativeMethods.Scale96(HeaderHeight, (uint)Math.Max(96, DeviceDpi));
    }

    private void AttachToParent(bool preserveScreenPosition)
    {
        if (!TryResolveParentWindow()) return;
        HideDetachedDashboardChrome();
        if (!_attached && preserveScreenPosition && NativeMethods.GetWindowRect(Handle, out var screenRect))
        {
            _savedDetachedBounds = screenRect.ToRectangle();
        }
        if (_embeddedBounds == Rectangle.Empty) _embeddedBounds = GetDefaultEmbeddedBounds();
        _attached = true;
        _maximized = false;
        _dockReady = false;
        MinimumSize = Size.Empty;
        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsPopup | NativeMethods.WsCaption | NativeMethods.WsThickFrame | NativeMethods.WsMinimizeBox | NativeMethods.WsMaximizeBox | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsChild | NativeMethods.WsVisible | NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        NativeMethods.SetParent(Handle, _parentHandle);
        UpdateDetachedWindowAppearance();
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds(), force: true);
        ShowPanel(_adminVisible);
        SyncDashboardOverlay();
        SendHostState();
    }

    private void DetachFromParent(Rectangle? requestedBounds = null, bool activate = true)
    {
        var embeddedScreenBounds = Rectangle.Empty;
        if (_attached && NativeMethods.GetWindowRect(Handle, out var screenRect)) embeddedScreenBounds = screenRect.ToRectangle();
        _attached = false;
        _adminVisible = true;
        _maximized = false;
        _dockReady = false;
        MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        NativeMethods.SetParent(Handle, IntPtr.Zero);
        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~NativeMethods.WsChild;
        style |= NativeMethods.WsPopup
            | NativeMethods.WsVisible
            | NativeMethods.WsClipChildren
            | NativeMethods.WsClipSiblings
            | NativeMethods.WsThickFrame
            | NativeMethods.WsMinimizeBox
            | NativeMethods.WsMaximizeBox
            | NativeMethods.WsSysMenu;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExToolWindow;
        exStyle |= NativeMethods.WsExAppWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        var bounds = requestedBounds
            ?? (_savedDetachedBounds.Width >= MinimumPanelWidth
                ? _savedDetachedBounds
                : embeddedScreenBounds.Width >= MinimumPanelWidth
                    ? embeddedScreenBounds
                    : _defaultDetachedBounds);
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop, bounds.X, bounds.Y, bounds.Width, bounds.Height, NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow);
        Bounds = bounds;
        UpdateDetachedWindowAppearance();
        _panelHidden = false;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (activate)
        {
            NativeMethods.SetForegroundWindow(Handle);
            _webView.Focus();
        }
        ShowDetachedDashboardChrome();
        SyncDashboardOverlay();
        SendHostState();
    }

    private void ToggleAttach(object? sender = null, EventArgs? e = null)
    {
        if (_attached) DetachFromParent();
        else AttachToParent(true);
    }

    private void ToggleMaximize(object? sender = null, EventArgs? e = null)
    {
        if (_attached)
        {
            ToggleParentMaximize();
            return;
        }
        if (!_maximized)
        {
            _savedDetachedBounds = Bounds;
            var screen = Screen.FromHandle(Handle).WorkingArea;
            Bounds = screen;
            _maximized = true;
        }
        else
        {
            _maximized = false;
            Bounds = _savedDetachedBounds.Width >= MinimumPanelWidth ? _savedDetachedBounds : _defaultDetachedBounds;
        }
        _maximizeButton.Text = _maximized ? "还原" : "最大化";
        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void MinimizeActiveWindow()
    {
        if (_attached)
        {
            if (TryResolveParentWindow()) NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwMinimize);
            return;
        }

        if (!_maximized) _savedDetachedBounds = Bounds;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwMinimize);
    }

    private CloseChoice ShowCloseChoiceDialog()
    {
        using var dialog = new CloseChoiceDialog();
        // The Unity HWND is in another process, so it cannot be used as the
        // WinForms modal owner. Disable both underlying windows explicitly and
        // use an ownerless, topmost dialog so no click can fall through to the
        // 3D scene while the close choice is visible.
        var hostWasEnabled = NativeMethods.IsWindowEnabled(Handle);
        var parentCanBeDisabled = _parentHandle != IntPtr.Zero && NativeMethods.IsWindow(_parentHandle);
        var parentWasEnabled = parentCanBeDisabled && NativeMethods.IsWindowEnabled(_parentHandle);
        if (hostWasEnabled) NativeMethods.EnableWindow(Handle, false);
        if (parentWasEnabled) NativeMethods.EnableWindow(_parentHandle, false);
        try
        {
            dialog.ShowDialog();
        }
        finally
        {
            if (parentWasEnabled) NativeMethods.EnableWindow(_parentHandle, true);
            if (hostWasEnabled) NativeMethods.EnableWindow(Handle, true);
        }
        return dialog.Choice;
    }

    private async Task MinimizeToTrayAsync()
    {
        if (!HasDesktopControl)
        {
            MinimizeActiveWindow();
            return;
        }

        if (await PostDesktopControlAsync("minimize-to-tray"))
        {
            HideApplicationToTray();
            return;
        }

        MessageBox.Show(
            this,
            "暂时无法连接桌面托盘服务，窗口将改为最小化到任务栏。",
            "托盘服务不可用",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning
        );
        MinimizeActiveWindow();
    }

    private async Task ExitApplicationAsync()
    {
        if (_exitRequested) return;
        _exitRequested = true;

        if (HasDesktopControl)
        {
            if (await PostDesktopControlAsync("quit", TimeSpan.FromMilliseconds(900)))
            {
                HideForExit();
                return;
            }
            _exitRequested = false;
            MessageBox.Show(
                this,
                "无法连接桌面管理服务。为避免绕过退出备份，本次没有强制结束程序；请稍后重试或从右下角托盘菜单退出。",
                "安全退出失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        if (TryResolveParentWindow())
        {
            // WM_CLOSE can take a few frames while Unity releases its render
            // resources. Hide the native controls immediately so the close
            // choice never remains visible during that teardown.
            HideForExit();
            NativeMethods.PostMessage(_parentHandle, NativeMethods.WmClose, IntPtr.Zero, IntPtr.Zero);
        }
        else
        {
            _exitRequested = false;
            Close();
        }
    }

    private bool HasDesktopControl => !string.IsNullOrWhiteSpace(_options.DesktopControlUrl)
        && !string.IsNullOrWhiteSpace(_options.DesktopControlToken);

    private static void WriteHostInfo(string message)
    {
        try
        {
            var logDirectory = Program.LogDirectory;
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(Path.Combine(logDirectory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {message}\n");
        }
        catch { /* Diagnostics must never block tab switching. */ }
    }

    private static void WriteHostError(string message, Exception exception)
    {
        try
        {
            var logDirectory = Program.LogDirectory;
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {message}: {exception}\n"
            );
        }
        catch
        {
            // Diagnostics must not affect the UI host.
        }
    }

    private async Task<bool> PostDesktopControlAsync(string action, TimeSpan? timeout = null)
    {
        if (!HasDesktopControl) return false;
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"{_options.DesktopControlUrl!.TrimEnd('/')}/{action}"
            );
            request.Headers.TryAddWithoutValidation("x-desktop-control-token", _options.DesktopControlToken);
            using var timeoutSource = timeout.HasValue ? new CancellationTokenSource(timeout.Value) : null;
            using var response = await DesktopControlClient.SendAsync(
                request,
                timeoutSource?.Token ?? CancellationToken.None
            );
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void HideForExit()
    {
        _webView.Visible = false;
        _dashboardOverlay?.HideOverlay();
        if (_dashboardChrome != null && !_dashboardChrome.IsDisposed)
        {
            NativeMethods.ShowWindow(_dashboardChrome.Handle, NativeMethods.SwHide);
            _dashboardChrome.Hide();
        }
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
    }

    private async Task ReportStartupReadyAsync()
    {
        if (_startupReadyReported || _startupReadyReportInProgress || !HasDesktopControl) return;
        _startupReadyReportInProgress = true;
        try
        {
            for (var attempt = 0; attempt < 6 && !_closing; attempt += 1)
            {
                if (await PostDesktopControlAsync("startup-ready"))
                {
                    _startupReadyReported = true;
                    return;
                }
                await Task.Delay(250);
            }
        }
        finally
        {
            _startupReadyReportInProgress = false;
        }
    }

    private void HideApplicationToTray()
    {
        _panelHidden = true;
        HideDetachedDashboardChrome();
        _dashboardOverlay?.HideOverlay();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        if (TryResolveParentWindow()) NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwHide);
    }

    private void RestoreDashboardFromTray()
    {
        if (!TryResolveParentWindow()) return;
        NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwRestore);
        NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwShow);
        ShowDashboard();
        SyncDashboardOverlay();
        NativeMethods.SetForegroundWindow(_parentHandle);
    }

    private void SetEmbeddedBounds(Rectangle bounds, bool force = false)
    {
        var previous = _embeddedBounds;
        _embeddedBounds = bounds;
        ClampEmbeddedBounds();
        if (!force && previous == _embeddedBounds) return;
        var flags = NativeMethods.SwpFrameChanged;
        if (!_panelHidden) flags |= NativeMethods.SwpShowWindow;
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop, _embeddedBounds.X, _embeddedBounds.Y, _embeddedBounds.Width, _embeddedBounds.Height, flags);
    }

    private void ClampEmbeddedBounds()
    {
        // An embedded child must always use the complete Unity client area.
        // Windows clips the part that is outside the monitor naturally. Using
        // the visible monitor intersection here makes the child narrower than
        // its parent whenever the borderless Unity window is moved partly off
        // screen, leaving an exposed strip of the Unity background on the
        // right/bottom (the top-bar gap seen in the field screenshot).
        var client = GetParentClientSize();
        var minimumWidth = _adminVisible ? Math.Min(MinimumPanelWidth, client.Width) : 1;
        var minimumHeight = _adminVisible
            ? Math.Min(MinimumPanelHeight, client.Height)
            : (_attached ? GetParentChromeHeightPixels() : HeaderHeight);
        var width = Math.Min(Math.Max(minimumWidth, _embeddedBounds.Width), client.Width);
        var height = Math.Min(Math.Max(minimumHeight, _embeddedBounds.Height), client.Height);
        var x = Math.Clamp(_embeddedBounds.X, 0, Math.Max(0, client.Width - width));
        var y = Math.Clamp(_embeddedBounds.Y, 0, Math.Max(0, client.Height - height));
        _embeddedBounds = new Rectangle(x, y, width, height);
    }

    private void ShowPanel(bool focus = true)
    {
        if (_closing || IsDisposed) return;
        _panelHidden = false;
        _webView.Visible = _webView.CoreWebView2 != null;
        Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (focus)
        {
            NativeMethods.SetForegroundWindow(Handle);
            _webView.Focus();
        }
        SyncDashboardOverlay();
        SendHostState();
    }

    private void HidePanel()
    {
        _panelHidden = true;
        _webView.Visible = false;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        SyncDashboardOverlay();
    }

    private void RequestCloseAfterParentExit()
    {
        if (_closing || IsDisposed) return;
        _closing = true;
        _parentTimer.Stop();
        try
        {
            BeginInvoke(() =>
            {
                if (!IsDisposed) Close();
            });
        }
        catch
        {
            Application.ExitThread();
        }
    }

    private void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var pointer = Cursor.Position;
        BeginWindowDrag(pointer.X, pointer.Y);
    }

    private void ContinueDrag(object? sender, MouseEventArgs e)
    {
        if (!_dragging || e.Button != MouseButtons.Left) return;
        var pointer = Cursor.Position;
        ContinueWindowDrag(pointer.X, pointer.Y);
    }

    private void EndDrag(object? sender, MouseEventArgs e)
    {
        var pointer = Cursor.Position;
        EndWindowDrag(pointer.X, pointer.Y);
    }

    private void BeginWebDrag(int screenX, int screenY, string target)
    {
        BeginWindowDrag(screenX, screenY, target);
    }

    private void ContinueWebDrag(int screenX, int screenY)
    {
        ContinueWindowDrag(screenX, screenY);
    }

    private void EndWebDrag(int screenX, int screenY)
    {
        EndWindowDrag(screenX, screenY);
    }

    private void BeginWindowDrag(int screenX, int screenY, string target = "admin")
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        _draggingParentWindow = false;
        if (_attached && target.Equals("dashboard", StringComparison.OrdinalIgnoreCase))
        {
            BeginNativeParentWindowMove(screenX, screenY);
            return;
        }
        if (!_attached)
        {
            BeginNativeDetachedWindowMove(screenX, screenY);
            return;
        }
        _dragging = true;
        _dragStart = new Point(screenX, screenY);
        _dragStartBounds = _attached ? _embeddedBounds : Bounds;
        if (NativeMethods.GetWindowRect(Handle, out var windowRect))
        {
            _dragPointerOffset = new Point(
                Math.Clamp(screenX - windowRect.Left, 0, Math.Max(0, windowRect.Width - 1)),
                Math.Clamp(screenY - windowRect.Top, 0, Math.Max(0, windowRect.Height - 1))
            );
        }
        else
        {
            _dragPointerOffset = new Point(Math.Max(0, screenX - Bounds.Left), Math.Max(0, screenY - Bounds.Top));
        }
        SetDockReady(false);
    }

    private void ContinueWindowDrag(int screenX, int screenY)
    {
        if (!_dragging) return;
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (_draggingParentWindow)
        {
            if (!_parentDragStarted)
            {
                var deltaX = screenX - _dragStart.X;
                var deltaY = screenY - _dragStart.Y;
                if ((deltaX * deltaX) + (deltaY * deltaY) < WindowMoveStartDistance * WindowMoveStartDistance)
                {
                    return;
                }
                StartParentWindowMove(screenX, screenY);
            }
            var bounds = new Rectangle(
                screenX - _dragPointerOffset.X,
                screenY - _dragPointerOffset.Y,
                _dragStartBounds.Width,
                _dragStartBounds.Height
            );
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                bounds.X,
                bounds.Y,
                bounds.Width,
                bounds.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentRestoreBounds = bounds;
            _dashboardOverlay?.UpdateParentBounds(force: true);
            BeginInvoke(MaintainParentWindow);
            return;
        }
        if (_attached)
        {
            var deltaX = screenX - _dragStart.X;
            var deltaY = screenY - _dragStart.Y;
            if ((deltaX * deltaX) + (deltaY * deltaY) >= DragDetachDistance * DragDetachDistance)
            {
                DetachForDrag(screenX, screenY);
            }
            return;
        }

        Bounds = new Rectangle(
            screenX - _dragPointerOffset.X,
            screenY - _dragPointerOffset.Y,
            _dragStartBounds.Width,
            _dragStartBounds.Height
        );
        SetDockReady(IsParentDockPoint(screenX, screenY));
    }

    private void EndWindowDrag(int screenX, int screenY)
    {
        if (!_dragging) return;
        ResolvePointerCoordinates(ref screenX, ref screenY);
        _dragging = false;
        if (_draggingParentWindow)
        {
            _draggingParentWindow = false;
            _parentDragStarted = false;
            if (NativeMethods.GetWindowRect(_parentHandle, out var parentRect))
            {
                _parentRestoreBounds = parentRect.ToRectangle();
            }
            _dashboardOverlay?.UpdateParentBounds(force: true);
            SendHostState();
            return;
        }
        if (!_attached)
        {
            _savedDetachedBounds = Bounds;
            if (IsParentDockPoint(screenX, screenY))
            {
                AttachToParent(true);
                return;
            }
        }
        SetDockReady(false);
    }

    private void BeginParentWindowDrag(int screenX, int screenY)
    {
        if (!TryResolveParentWindow()) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var currentRect)) return;
        var currentBounds = currentRect.ToRectangle();

        _dragging = true;
        _draggingParentWindow = true;
        _parentDragStarted = false;
        _dragStart = new Point(screenX, screenY);
        _dragStartBounds = currentBounds;
        _dragPointerOffset = new Point(
            Math.Clamp(screenX - currentBounds.Left, 0, Math.Max(0, currentBounds.Width - 1)),
            Math.Clamp(screenY - currentBounds.Top, 0, Math.Max(0, currentBounds.Height - 1))
        );
        SetDockReady(false);
    }

    private void BeginNativeParentWindowMove(int screenX, int screenY)
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (!TryResolveParentWindow()) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var currentRect)) return;
        var currentBounds = currentRect.ToRectangle();

        if (_parentMaximized)
        {
            var restore = _parentRestoreBounds.Width > 0
                ? _parentRestoreBounds
                : GetDefaultParentRestoreBounds(Screen.FromHandle(_parentHandle).WorkingArea);
            var horizontalRatio = currentBounds.Width > 0
                ? Math.Clamp((screenX - currentBounds.Left) / (double)currentBounds.Width, 0.08d, 0.92d)
                : 0.5d;
            var gripX = (int)Math.Round(restore.Width * horizontalRatio);
            var gripY = Math.Clamp(screenY - currentBounds.Top, 0, GetParentChromeHeightPixels() - 1);
            NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwRestore);
            currentBounds = new Rectangle(screenX - gripX, screenY - gripY, restore.Width, restore.Height);
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                currentBounds.X,
                currentBounds.Y,
                currentBounds.Width,
                currentBounds.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentMaximized = false;
            _dashboardOverlay?.UpdateParentBounds(force: true);
        }

        NativeMethods.ReleaseCapture();
        NativeMethods.PostMessage(
            _parentHandle,
            NativeMethods.WmNcLButtonDown,
            new IntPtr(NativeMethods.HtCaption),
            NativeMethods.PackScreenPoint(screenX, screenY)
        );

        if (NativeMethods.GetWindowRect(_parentHandle, out var movedRect))
        {
            var moved = movedRect.ToRectangle();
            _parentMaximized = NativeMethods.IsZoomed(_parentHandle);
            if (!_parentMaximized) _parentRestoreBounds = moved;
        }
        _dashboardOverlay?.UpdateParentBounds(force: true);
        _dashboardChrome?.UpdateState(_parentMaximized);
        BeginInvoke(MaintainParentWindow);
        SendHostState();
    }

    private void BeginNativeDetachedWindowMove(int screenX, int screenY)
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (_attached || !IsHandleCreated || IsDisposed) return;
        if (_maximized) RestoreDetachedWindowForDrag(screenX, screenY);

        _dragging = false;
        _draggingParentWindow = false;
        _parentDragStarted = false;
        SetDockReady(false);
        NativeMethods.SetForegroundWindow(Handle);
        NativeMethods.ReleaseCapture();
        _nativeDetachedMovePending = true;
        NativeMethods.PostMessage(
            Handle,
            NativeMethods.WmNcLButtonDown,
            new IntPtr(NativeMethods.HtCaption),
            NativeMethods.PackScreenPoint(screenX, screenY)
        );

        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void FinishNativeDetachedWindowMove()
    {
        if (_attached || IsDisposed) return;
        if (NativeMethods.GetWindowRect(Handle, out var movedRect))
        {
            _savedDetachedBounds = movedRect.ToRectangle();
        }
        var pointer = Cursor.Position;
        if (IsParentDockPoint(pointer.X, pointer.Y))
        {
            AttachToParent(true);
            return;
        }
        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void StartParentWindowMove(int screenX, int screenY)
    {
        _parentDragStarted = true;
        if (!_parentMaximized) return;

        var currentBounds = _dragStartBounds;
        var restore = _parentRestoreBounds.Width > 0
            ? _parentRestoreBounds
            : GetDefaultParentRestoreBounds(Screen.FromHandle(_parentHandle).WorkingArea);
        var horizontalRatio = currentBounds.Width > 0
            ? Math.Clamp((_dragStart.X - currentBounds.Left) / (double)currentBounds.Width, 0.08d, 0.92d)
            : 0.5d;
        var gripX = (int)Math.Round(restore.Width * horizontalRatio);
        var gripY = Math.Clamp(_dragStart.Y - currentBounds.Top, 0, GetParentChromeHeightPixels() - 1);
        _dragStartBounds = new Rectangle(screenX - gripX, screenY - gripY, restore.Width, restore.Height);
        _dragPointerOffset = new Point(gripX, gripY);
        NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwRestore);
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                _dragStartBounds.X,
                _dragStartBounds.Y,
            _dragStartBounds.Width,
            _dragStartBounds.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentMaximized = false;
            _dashboardOverlay?.UpdateParentBounds(force: true);
            _dashboardChrome?.UpdateState(false);
    }

    private void DetachForDrag(int screenX, int screenY)
    {
        var wasMaximized = _maximized;
        var wasDashboardMode = _attached && !_adminVisible;
        var sourceSize = NativeMethods.GetWindowRect(Handle, out var windowRect)
            ? new Size(windowRect.Width, windowRect.Height)
            : _embeddedBounds.Size;
        var workingArea = Screen.FromPoint(new Point(screenX, screenY)).WorkingArea;
        var fillsMainWindow = _attached
            && (sourceSize.Width >= workingArea.Width * 0.9f || sourceSize.Height >= workingArea.Height * 0.9f);
        if (wasMaximized || wasDashboardMode || fillsMainWindow)
        {
            sourceSize = _savedDetachedBounds.Width >= MinimumPanelWidth
                ? _savedDetachedBounds.Size
                : _defaultDetachedBounds.Size;
        }
        _adminVisible = true;
        var detachedSize = FitDetachedSize(sourceSize, screenX, screenY);
        var gripX = Math.Clamp(_dragPointerOffset.X, 48, Math.Max(48, detachedSize.Width - 48));
        var gripY = Math.Clamp(
            _dragPointerOffset.Y,
            0,
            Math.Min(GetCurrentChromeHeightPixels() - 1, detachedSize.Height - 1)
        );
        var bounds = new Rectangle(screenX - gripX, screenY - gripY, detachedSize.Width, detachedSize.Height);
        DetachFromParent(bounds, false);
        _dragging = false;
        BeginNativeDetachedWindowMove(screenX, screenY);
    }

    private void RestoreDetachedWindowForDrag(int screenX, int screenY)
    {
        var maximizedBounds = Bounds;
        var requested = _savedDetachedBounds.Width >= MinimumPanelWidth
            ? _savedDetachedBounds.Size
            : _defaultDetachedBounds.Size;
        var restoredSize = FitDetachedSize(requested, screenX, screenY);
        var horizontalRatio = maximizedBounds.Width > 0
            ? Math.Clamp((screenX - maximizedBounds.Left) / (double)maximizedBounds.Width, 0.08d, 0.92d)
            : 0.5d;
        var gripX = (int)Math.Round(restoredSize.Width * horizontalRatio);
        var gripY = Math.Clamp(screenY - maximizedBounds.Top, 0, GetCurrentChromeHeightPixels() - 1);
        _maximized = false;
        Bounds = new Rectangle(screenX - gripX, screenY - gripY, restoredSize.Width, restoredSize.Height);
        SendHostState();
    }

    private static void ResolvePointerCoordinates(ref int screenX, ref int screenY)
    {
        if (!NativeMethods.GetCursorPos(out var pointer)) return;
        screenX = pointer.X;
        screenY = pointer.Y;
    }

    private static Size FitDetachedSize(Size requested, int screenX, int screenY)
    {
        var workingArea = Screen.FromPoint(new Point(screenX, screenY)).WorkingArea;
        var width = Math.Min(Math.Max(MinimumPanelWidth, requested.Width), Math.Max(MinimumPanelWidth, workingArea.Width));
        var height = Math.Min(Math.Max(MinimumPanelHeight, requested.Height), Math.Max(MinimumPanelHeight, workingArea.Height));
        return new Size(width, height);
    }

    private void BeginResize(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _resizing = true;
        _dragStart = Cursor.Position;
        _dragStartBounds = _attached ? _embeddedBounds : Bounds;
    }

    private void ContinueResize(object? sender, MouseEventArgs e)
    {
        if (!_resizing || e.Button != MouseButtons.Left) return;
        var current = Cursor.Position;
        var delta = new Size(current.X - _dragStart.X, current.Y - _dragStart.Y);
        var width = Math.Max(MinimumPanelWidth, _dragStartBounds.Width + delta.Width);
        var height = Math.Max(MinimumPanelHeight, _dragStartBounds.Height + delta.Height);
        if (_attached) SetEmbeddedBounds(new Rectangle(_dragStartBounds.X, _dragStartBounds.Y, width, height));
        else Bounds = new Rectangle(_dragStartBounds.X, _dragStartBounds.Y, width, height);
    }

    private void EndResize(object? sender, MouseEventArgs e) => _resizing = false;

    private async Task ListenForCommandsAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(_options.PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(cancellationToken);
                using var reader = new StreamReader(server, Encoding.UTF8);
                using var commandTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                commandTimeout.CancelAfter(TimeSpan.FromSeconds(2));
                var command = await reader.ReadLineAsync(commandTimeout.Token);
                if (!string.IsNullOrWhiteSpace(command) && !IsDisposed)
                {
                    BeginInvoke(() =>
                    {
                        if (command.Equals("show", StringComparison.OrdinalIgnoreCase)) ShowAdmin();
                        else if (command.Equals("detach", StringComparison.OrdinalIgnoreCase) && _attached) DetachFromParent();
                        else if (command.Equals("attach", StringComparison.OrdinalIgnoreCase) && !_attached) AttachToParent(true);
                        else if (command.Equals("minimize", StringComparison.OrdinalIgnoreCase)) MinimizeActiveWindow();
                        else if (command.Equals("maximize", StringComparison.OrdinalIgnoreCase)) ToggleMaximize();
                        else if (command.Equals("hide_to_tray", StringComparison.OrdinalIgnoreCase)) HideApplicationToTray();
                        else if (command.Equals("restore_dashboard", StringComparison.OrdinalIgnoreCase)) RestoreDashboardFromTray();
                        else if (command.Equals("prepare_cast", StringComparison.OrdinalIgnoreCase)) PrepareCastPresentation();
                        else if (command.Equals("restore_cast", StringComparison.OrdinalIgnoreCase)) RestoreCastPresentation();
                        else if (command.Equals("close", StringComparison.OrdinalIgnoreCase)) Close();
                    });
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (OperationCanceledException) { /* Incomplete pipe command timed out; accept the next client. */ }
            catch
            {
                try { await Task.Delay(200, cancellationToken); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == NativeMethods.WmExitSizeMove && _nativeDetachedMovePending)
        {
            _nativeDetachedMovePending = false;
            BeginInvoke(FinishNativeDetachedWindowMove);
        }

        if (message.Msg == NativeMethods.WmNcHitTest && !_attached && !_maximized && WindowState == FormWindowState.Normal)
        {
            var packed = message.LParam.ToInt64();
            var screenPoint = new Point(
                unchecked((short)(packed & 0xffff)),
                unchecked((short)((packed >> 16) & 0xffff))
            );
            var clientPoint = PointToClient(screenPoint);
            var border = Math.Max(ResizeBorderThickness, DeviceDpi * ResizeBorderThickness / 96);
            var left = clientPoint.X >= 0 && clientPoint.X < border;
            var right = clientPoint.X < ClientSize.Width && clientPoint.X >= ClientSize.Width - border;
            var top = clientPoint.Y >= 0 && clientPoint.Y < border;
            var bottom = clientPoint.Y < ClientSize.Height && clientPoint.Y >= ClientSize.Height - border;

            var hit = top && left
                ? NativeMethods.HtTopLeft
                : top && right
                    ? NativeMethods.HtTopRight
                    : bottom && left
                        ? NativeMethods.HtBottomLeft
                        : bottom && right
                            ? NativeMethods.HtBottomRight
                            : left
                                ? NativeMethods.HtLeft
                                : right
                                    ? NativeMethods.HtRight
                                    : top
                                        ? NativeMethods.HtTop
                                        : bottom
                                            ? NativeMethods.HtBottom
                                            : NativeMethods.HtClient;
            if (hit != NativeMethods.HtClient)
            {
                message.Result = new IntPtr(hit);
                return;
            }
        }

        base.WndProc(ref message);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        BeginInvoke(UpdateDetachedWindowAppearance);
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (IsHandleCreated) UpdateDetachedWindowAppearance();
    }

    private void UpdateDetachedWindowAppearance()
    {
        if (!IsHandleCreated || IsDisposed) return;
        var shouldRound = !_attached && !_maximized && WindowState == FormWindowState.Normal;
        var preference = shouldRound
            ? NativeMethods.DwmWindowCornerRound
            : NativeMethods.DwmWindowCornerDoNotRound;
        try
        {
            NativeMethods.DwmSetWindowAttribute(
                Handle,
                NativeMethods.DwmWindowCornerPreference,
                ref preference,
                sizeof(int)
            );
        }
        catch
        {
            // The native window region below still guarantees visible rounding.
        }

        if (!shouldRound)
        {
            ClearNativeWindowRegion();
            return;
        }

        ApplyNativeRoundedWindowRegion();
    }

    private void ApplyNativeRoundedWindowRegion()
    {
        if (!NativeMethods.GetWindowRect(Handle, out var bounds) || bounds.Width <= 0 || bounds.Height <= 0) return;
        var radius = Math.Max(RoundedCornerRadius, DeviceDpi * RoundedCornerRadius / 96);
        var region = NativeMethods.CreateRoundRectRgn(
            0,
            0,
            bounds.Width + 1,
            bounds.Height + 1,
            radius * 2,
            radius * 2
        );
        if (region == IntPtr.Zero) return;
        if (NativeMethods.SetWindowRgn(Handle, region, true) == 0)
        {
            NativeMethods.DeleteObject(region);
        }
    }

    private void ClearNativeWindowRegion()
    {
        NativeMethods.SetWindowRgn(Handle, IntPtr.Zero, true);
    }

    private sealed class WindowHandleOwner(IntPtr handle) : IWin32Window
    {
        public IntPtr Handle { get; } = handle;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _closing = true;
        _navigationRetry?.Dispose();
        _parentTimer.Stop();
        _pipeCancellation.Cancel();
        try
        {
            if (_dashboardChrome != null && !_dashboardChrome.IsDisposed) _dashboardChrome.Close();
        }
        catch (Exception exception)
        {
            WriteHostError("顶部栏窗口关闭失败", exception);
        }
        try
        {
            if (_dashboardOverlay != null && !_dashboardOverlay.IsDisposed) _dashboardOverlay.Close();
        }
        catch (Exception exception)
        {
            WriteHostError("透明数据层关闭失败", exception);
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_webViewDisposeAttempted)
        {
            _webViewDisposeAttempted = true;
            _navigationRetry?.Dispose();
            try { Controls.Remove(_webView); } catch { /* best-effort detach */ }
            try
            {
                _webView.Dispose();
            }
            catch (Exception exception)
            {
                // WebView2 may already have torn down its controller when Unity exits.
                // The host must still terminate cleanly instead of leaving an orphan process.
                WriteHostError("后台 WebView2 关闭失败（已安全忽略）", exception);
            }
        }
        base.Dispose(disposing);
    }
}
