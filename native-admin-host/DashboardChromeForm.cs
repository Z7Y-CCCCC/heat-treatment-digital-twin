using System.Drawing.Drawing2D;

namespace HeatTreatmentAdminHost;

internal sealed class DashboardChromeForm : Form
{
    internal const int ChromeHeight = 46;

    private readonly ChromeSurface _surface;
    private IntPtr _parentHandle;
    private Size _lastParentClientSize = Size.Empty;
    private int _lastChromeHeight;

    public DashboardChromeForm(Action<string, int, int> action)
    {
        Text = "实时大屏";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        MinimumSize = Size.Empty;
        BackColor = Color.FromArgb(237, 242, 247);
        Height = ChromeHeight;

        _surface = new ChromeSurface(action) { Dock = DockStyle.Fill };
        Controls.Add(_surface);
    }

    protected override bool ShowWithoutActivation => true;

    public void ShowForParent(IntPtr parentHandle, bool maximized)
    {
        if (IsDisposed || parentHandle == IntPtr.Zero) return;
        _parentHandle = parentHandle;

        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsPopup | NativeMethods.WsCaption | NativeMethods.WsThickFrame | NativeMethods.WsMinimizeBox | NativeMethods.WsMaximizeBox | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsChild | NativeMethods.WsVisible | NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        NativeMethods.SetParent(Handle, _parentHandle);

        UpdateParentBounds(force: true);
        UpdateState(maximized);
        Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
    }

    public void UpdateParentBounds(bool force = false)
    {
        if (_parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!NativeMethods.GetClientRect(_parentHandle, out var client)) return;
        var clientSize = new Size(Math.Max(1, client.Width), Math.Max(1, client.Height));
        var chromeHeight = GetChromeHeightPixels(_parentHandle);
        if (!force && clientSize == _lastParentClientSize && chromeHeight == _lastChromeHeight) return;
        _lastParentClientSize = clientSize;
        _lastChromeHeight = chromeHeight;
        NativeMethods.SetWindowPos(
            Handle,
            NativeMethods.HwndTop,
            0,
            0,
            clientSize.Width,
            chromeHeight,
            NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
        );
    }

    internal static int GetChromeHeightPixels(IntPtr parentHandle)
    {
        return NativeMethods.Scale96(
            ChromeHeight,
            NativeMethods.GetWindowDpiOrDefault(parentHandle)
        );
    }

    public void UpdateState(bool maximized)
    {
        _surface.Maximized = maximized;
    }

    private sealed class ChromeSurface : Control
    {
        private readonly Action<string, int, int> _action;
        private readonly Font _tabFont = new("Microsoft YaHei UI", 9f, FontStyle.Bold);
        private readonly Font _hintFont = new("Microsoft YaHei UI", 8.2f, FontStyle.Regular);
        private int _hoverZone;
        private bool _maximized;

        public ChromeSurface(Action<string, int, int> action)
        {
            _action = action;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw
                | ControlStyles.UserPaint,
                true
            );
            Cursor = Cursors.SizeAll;
        }

        public bool Maximized
        {
            get => _maximized;
            set
            {
                if (_maximized == value) return;
                _maximized = value;
                Invalidate();
            }
        }

        private Rectangle DashboardTabRect => LogicalRectangle(8, 6, 108, 35);
        private Rectangle DetachedChipRect => LogicalRectangle(126, 10, 204, 29);
        private Rectangle RefreshRect => WindowActionRect(4);
        private Rectangle MinimizeRect => WindowActionRect(3);
        private Rectangle MaximizeRect => WindowActionRect(2);
        private Rectangle CloseRect => WindowActionRect(1);

        private int ScaleMetric(int value) => NativeMethods.Scale96(value, (uint)Math.Max(96, DeviceDpi));
        private float ScaleMetric(float value) => value * Math.Max(96, DeviceDpi) / 96f;

        private Rectangle LogicalRectangle(int x, int y, int width, int height)
        {
            return new Rectangle(ScaleMetric(x), ScaleMetric(y), ScaleMetric(width), ScaleMetric(height));
        }

        private Rectangle WindowActionRect(int distanceFromRight)
        {
            // Keep the four action hit zones contiguous. The old calculation
            // clamped only the left-most button, so a narrow parent window
            // could make the refresh/minimize/maximize zones overlap.
            var rightInset = Math.Min(ScaleMetric(6), Math.Max(0, Width - 4));
            var availableWidth = Math.Max(4, Width - rightInset);
            var actionWidth = Math.Max(1, Math.Min(ScaleMetric(40), availableWidth / 4));
            var actionAreaLeft = Math.Max(0, Width - rightInset - actionWidth * 4);
            return new Rectangle(
                actionAreaLeft + actionWidth * (4 - distanceFromRight),
                0,
                actionWidth,
                Math.Max(1, Math.Min(ScaleMetric(32), Height))
            );
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var graphics = e.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var background = new LinearGradientBrush(ClientRectangle, Color.FromArgb(237, 242, 247), Color.FromArgb(223, 231, 239), LinearGradientMode.Vertical))
            {
                graphics.FillRectangle(background, ClientRectangle);
            }
            using (var border = new Pen(Color.FromArgb(203, 213, 223), ScaleMetric(1f)))
            {
                graphics.DrawLine(border, 0, Height - ScaleMetric(1), Width, Height - ScaleMetric(1));
            }

            DrawDashboardTab(graphics);
            DrawDetachedChip(graphics);
            DrawWindowActions(graphics);
        }

        private void DrawDashboardTab(Graphics graphics)
        {
            var rect = DashboardTabRect;
            using var path = RoundedPath(rect, ScaleMetric(9));
            using var fill = new SolidBrush(Color.FromArgb(248, 250, 252));
            using var border = new Pen(Color.FromArgb(203, 213, 223), ScaleMetric(1f));
            graphics.FillPath(fill, path);
            graphics.DrawPath(border, path);
            using var bottomMask = new Pen(Color.FromArgb(248, 250, 252), ScaleMetric(2f));
            graphics.DrawLine(bottomMask, rect.Left + ScaleMetric(12), rect.Bottom, rect.Right - ScaleMetric(12), rect.Bottom);

            using var iconPen = new Pen(Color.FromArgb(71, 84, 103), ScaleMetric(1.45f));
            var monitor = new Rectangle(rect.Left + ScaleMetric(15), rect.Top + ScaleMetric(10), ScaleMetric(14), ScaleMetric(10));
            graphics.DrawRectangle(iconPen, monitor);
            graphics.DrawLine(iconPen, monitor.Left + ScaleMetric(5), monitor.Bottom + ScaleMetric(3), monitor.Right - ScaleMetric(5), monitor.Bottom + ScaleMetric(3));
            graphics.DrawLine(iconPen, monitor.Left + ScaleMetric(7), monitor.Bottom, monitor.Left + ScaleMetric(7), monitor.Bottom + ScaleMetric(3));

            TextRenderer.DrawText(
                graphics,
                "实时大屏",
                _tabFont,
                new Rectangle(rect.Left + ScaleMetric(39), rect.Top + ScaleMetric(6), rect.Width - ScaleMetric(44), rect.Height - ScaleMetric(8)),
                Color.FromArgb(23, 43, 63),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding
            );
        }

        private void DrawDetachedChip(Graphics graphics)
        {
            var rect = DetachedChipRect;
            var hovered = _hoverZone == 1;
            using var path = RoundedPath(rect, ScaleMetric(7));
            using var fill = new SolidBrush(hovered ? Color.FromArgb(247, 250, 253) : Color.FromArgb(237, 242, 247));
            graphics.FillPath(fill, path);

            using var dot = new SolidBrush(Color.FromArgb(18, 183, 106));
            graphics.FillEllipse(dot, rect.Left + ScaleMetric(10), rect.Top + ScaleMetric(10), ScaleMetric(7), ScaleMetric(7));
            using var halo = new Pen(Color.FromArgb(55, 18, 183, 106), ScaleMetric(3f));
            graphics.DrawEllipse(halo, rect.Left + ScaleMetric(8), rect.Top + ScaleMetric(8), ScaleMetric(11), ScaleMetric(11));

            TextRenderer.DrawText(
                graphics,
                "后台管理已在独立窗口",
                _hintFont,
                new Rectangle(rect.Left + ScaleMetric(27), rect.Top + ScaleMetric(2), rect.Width - ScaleMetric(33), rect.Height - ScaleMetric(4)),
                hovered ? Color.FromArgb(23, 92, 211) : Color.FromArgb(82, 103, 122),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding
            );
        }

        private void DrawWindowActions(Graphics graphics)
        {
            DrawActionBackground(graphics, RefreshRect, _hoverZone == 5, false);
            DrawActionBackground(graphics, MinimizeRect, _hoverZone == 2, false);
            DrawActionBackground(graphics, MaximizeRect, _hoverZone == 3, false);
            DrawActionBackground(graphics, CloseRect, _hoverZone == 4, true);
            var iconColor = _hoverZone == 4 ? Color.White : Color.FromArgb(71, 84, 103);
            using var pen = new Pen(iconColor, ScaleMetric(1.5f)) { StartCap = LineCap.Round, EndCap = LineCap.Round };

            DrawRefreshIcon(graphics, RefreshRect, iconColor);

            var minimize = MinimizeRect;
            var minimizeWidth = Math.Min(ScaleMetric(14), Math.Max(1f, minimize.Width * 0.45f));
            var minimizeY = minimize.Top + minimize.Height * 0.66f;
            graphics.DrawLine(
                pen,
                minimize.Left + (minimize.Width - minimizeWidth) / 2f,
                minimizeY,
                minimize.Left + (minimize.Width + minimizeWidth) / 2f,
                minimizeY
            );

            var max = MaximizeRect;
            if (_maximized)
            {
                var maxSize = ActionIconSize(max, 14);
                var maxLeft = max.Left + (max.Width - maxSize) / 2f;
                var maxTop = max.Top + (max.Height - maxSize) / 2f;
                var maxSmallSize = maxSize * 11f / 14f;
                graphics.DrawRectangle(
                    pen,
                    maxLeft + maxSize * 4f / 14f,
                    maxTop,
                    maxSmallSize,
                    maxSmallSize
                );
                graphics.DrawRectangle(
                    pen,
                    maxLeft,
                    maxTop + maxSize * 4f / 14f,
                    maxSmallSize,
                    maxSmallSize
                );
            }
            else
            {
                var maxSize = ActionIconSize(max, 14);
                graphics.DrawRectangle(
                    pen,
                    max.Left + (max.Width - maxSize) / 2f,
                    max.Top + (max.Height - maxSize) / 2f,
                    maxSize,
                    maxSize
                );
            }

            var close = CloseRect;
            var closeSize = ActionIconSize(close, 14);
            var closeLeft = close.Left + (close.Width - closeSize) / 2f;
            var closeTop = close.Top + (close.Height - closeSize) / 2f;
            var closeInset = closeSize * 0.08f;
            graphics.DrawLine(pen, closeLeft + closeInset, closeTop + closeInset, closeLeft + closeSize - closeInset, closeTop + closeSize - closeInset);
            graphics.DrawLine(pen, closeLeft + closeSize - closeInset, closeTop + closeInset, closeLeft + closeInset, closeTop + closeSize - closeInset);
        }

        private void DrawRefreshIcon(Graphics graphics, Rectangle button, Color color)
        {
            var iconSize = ActionIconSize(button, 17);
            var iconLeft = button.Left + (button.Width - iconSize) / 2f;
            var iconTop = button.Top + (button.Height - iconSize) / 2f;
            var unit = iconSize / 24f;

            // This is the same geometry as the Vue title-bar SVG. Keeping
            // the 24-unit coordinates here makes both window chrome variants
            // render the same refresh mark instead of two similar-looking
            // hand-drawn arrows.
            var center = new PointF(iconLeft + 16.31f * unit, iconTop + 11.76f * unit);
            var radius = 7.5f * unit;
            var arcBounds = new RectangleF(center.X - radius, center.Y - radius, radius * 2f, radius * 2f);
            var strokeWidth = Math.Max(0.75f, ScaleMetric(1.7f) * iconSize / ScaleMetric(24f));
            using var refreshPen = new Pen(color, strokeWidth) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            graphics.DrawArc(refreshPen, arcBounds, -54.4f, -265.6f);

            var arrowTip = new PointF(iconLeft + 19f * unit, iconTop + 8f * unit);
            graphics.DrawLine(refreshPen, iconLeft + 19f * unit, iconTop + 4f * unit, arrowTip.X, arrowTip.Y);
            graphics.DrawLine(refreshPen, arrowTip.X, arrowTip.Y, iconLeft + 15f * unit, arrowTip.Y);
        }

        private float ActionIconSize(Rectangle button, float preferredSize)
        {
            var availableWidth = Math.Max(1f, button.Width - ScaleMetric(8f));
            var availableHeight = Math.Max(1f, button.Height - ScaleMetric(8f));
            return Math.Max(1f, Math.Min(ScaleMetric(preferredSize), Math.Min(availableWidth, availableHeight)));
        }

        private void DrawActionBackground(Graphics graphics, Rectangle rect, bool hovered, bool close)
        {
            if (!hovered) return;
            using var path = RoundedPath(rect, ScaleMetric(7));
            using var brush = new SolidBrush(close ? Color.FromArgb(229, 72, 77) : Color.FromArgb(217, 225, 233));
            graphics.FillPath(brush, path);
        }

        protected override void OnDpiChangedAfterParent(EventArgs e)
        {
            base.OnDpiChangedAfterParent(e);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var zone = DetachedChipRect.Contains(e.Location)
                ? 1
                : RefreshRect.Contains(e.Location)
                    ? 5
                : MinimizeRect.Contains(e.Location)
                    ? 2
                : MaximizeRect.Contains(e.Location)
                    ? 3
                    : CloseRect.Contains(e.Location)
                        ? 4
                        : 0;
            if (_hoverZone != zone)
            {
                _hoverZone = zone;
                Cursor = zone == 0 ? Cursors.SizeAll : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || IsInteractiveZone(e.Location)) return;
            var pointer = Cursor.Position;
            if (e.Clicks >= 2)
            {
                _action("maximize", pointer.X, pointer.Y);
                return;
            }
            _action("move_parent_native", pointer.X, pointer.Y);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            _hoverZone = 0;
            Cursor = Cursors.SizeAll;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (DetachedChipRect.Contains(e.Location)) _action("focus_admin", Cursor.Position.X, Cursor.Position.Y);
            else if (RefreshRect.Contains(e.Location)) _action("reload", Cursor.Position.X, Cursor.Position.Y);
            else if (MinimizeRect.Contains(e.Location)) _action("minimize", Cursor.Position.X, Cursor.Position.Y);
            else if (MaximizeRect.Contains(e.Location)) _action("maximize", Cursor.Position.X, Cursor.Position.Y);
            else if (CloseRect.Contains(e.Location)) _action("close", Cursor.Position.X, Cursor.Position.Y);
        }

        private bool IsInteractiveZone(Point location)
        {
            return DetachedChipRect.Contains(location)
                || RefreshRect.Contains(location)
                || MinimizeRect.Contains(location)
                || MaximizeRect.Contains(location)
                || CloseRect.Contains(location);
        }

        private static GraphicsPath RoundedPath(Rectangle rect, int radius)
        {
            var diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
            path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _tabFont.Dispose();
                _hintFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
