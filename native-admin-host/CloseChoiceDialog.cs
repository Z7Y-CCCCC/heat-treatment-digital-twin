using System.Drawing.Drawing2D;

namespace HeatTreatmentAdminHost;

internal enum CloseChoice
{
    Cancel,
    MinimizeToTray,
    ExitApplication
}

internal sealed class CloseChoiceDialog : Form
{
    private const int CornerRadius = 14;
    private readonly ChoiceCard _minimizeCard;

    public CloseChoiceDialog()
    {
        Text = "热处理数字孪生大屏";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        TopMost = true;
        MinimizeBox = false;
        MaximizeBox = false;
        ControlBox = false;
        ClientSize = new Size(260, 150);
        MinimumSize = ClientSize;
        MaximumSize = ClientSize;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(248, 250, 252);
        ForeColor = Color.FromArgb(29, 41, 57);
        Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
        DoubleBuffered = true;
        KeyPreview = true;

        var header = new ChromeHeader
        {
            Dock = DockStyle.Top,
            Height = 32,
            Padding = new Padding(10, 0, 4, 0)
        };
        var title = new Label
        {
            Dock = DockStyle.Left,
            Width = 190,
            Text = "热处理数字孪生大屏",
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(23, 43, 63),
            Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold),
            BackColor = Color.Transparent
        };
        var closeButton = new ChromeCloseButton
        {
            Dock = DockStyle.Right,
            Width = 32,
            AccessibleName = "关闭弹窗"
        };
        closeButton.Click += (_, _) => CancelAndClose();
        header.Controls.Add(closeButton);
        header.Controls.Add(title);
        BindWindowDrag(header);
        BindWindowDrag(title);

        var content = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(10, 6, 10, 8),
            BackColor = Color.FromArgb(248, 250, 252)
        };

        var hero = new Panel
        {
            Dock = DockStyle.Top,
            Height = 24,
            BackColor = Color.Transparent
        };
        var info = new InfoGlyph
        {
            Location = new Point(0, 2),
            Size = new Size(20, 20)
        };
        var heading = new Label
        {
            Location = new Point(28, 0),
            Size = new Size(200, 22),
            Text = "请选择关闭方式",
            ForeColor = Color.FromArgb(16, 42, 67),
            Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
            BackColor = Color.Transparent
        };
        hero.Controls.Add(info);
        hero.Controls.Add(heading);

        var options = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            Padding = Padding.Empty,
            BackColor = Color.Transparent
        };
        options.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        options.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
        options.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));

        _minimizeCard = new ChoiceCard(
            "最小化到系统托盘",
            string.Empty,
            recommended: true,
            danger: false
        )
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 2),
            AccessibleName = "最小化到系统托盘（推荐）"
        };
        var exitCard = new ChoiceCard(
            "完全退出程序",
            string.Empty,
            recommended: false,
            danger: true
        )
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 2, 0, 0),
            AccessibleName = "完全退出程序"
        };
        _minimizeCard.Click += (_, _) => Complete(CloseChoice.MinimizeToTray);
        exitCard.Click += (_, _) => Complete(CloseChoice.ExitApplication);
        options.Controls.Add(_minimizeCard, 0, 0);
        options.Controls.Add(exitCard, 0, 1);

        content.Controls.Add(options);
        content.Controls.Add(hero);
        Controls.Add(content);
        Controls.Add(header);

        Shown += (_, _) =>
        {
            ApplyRoundedWindow();
            Activate();
            BringToFront();
            if (IsHandleCreated) NativeMethods.SetForegroundWindow(Handle);
            _minimizeCard.Focus();
        };
        Resize += (_, _) => ApplyRoundedWindow();
        KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.Escape) return;
            e.Handled = true;
            CancelAndClose();
        };
    }

    public CloseChoice Choice { get; private set; } = CloseChoice.Cancel;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.ClassStyle |= 0x00020000; // CS_DROPSHADOW
            return parameters;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (ClientSize.Width < 2 || ClientSize.Height < 2) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = RoundedPath(new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), CornerRadius);
        using var pen = new Pen(Color.FromArgb(203, 213, 223));
        e.Graphics.DrawPath(pen, path);
    }

    private void Complete(CloseChoice choice)
    {
        Choice = choice;
        DialogResult = DialogResult.OK;
        Close();
    }

    private void CancelAndClose()
    {
        Choice = CloseChoice.Cancel;
        DialogResult = DialogResult.Cancel;
        Close();
    }

    private void BindWindowDrag(Control control)
    {
        control.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            var pointer = Cursor.Position;
            NativeMethods.ReleaseCapture();
            NativeMethods.SendMessage(
                Handle,
                NativeMethods.WmNcLButtonDown,
                new IntPtr(NativeMethods.HtCaption),
                NativeMethods.PackScreenPoint(pointer.X, pointer.Y)
            );
        };
    }

    private void ApplyRoundedWindow()
    {
        if (!IsHandleCreated || ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
        var preference = NativeMethods.DwmWindowCornerRound;
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
            // The region below provides the same rounded outline on older systems.
        }

        var radius = Math.Max(CornerRadius, DeviceDpi * CornerRadius / 96);
        var region = NativeMethods.CreateRoundRectRgn(
            0,
            0,
            Width + 1,
            Height + 1,
            radius * 2,
            radius * 2
        );
        if (region == IntPtr.Zero) return;
        if (NativeMethods.SetWindowRgn(Handle, region, true) == 0)
        {
            NativeMethods.DeleteObject(region);
        }
    }

    private sealed class ChromeHeader : Panel
    {
        public ChromeHeader()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (ClientRectangle.Width <= 0 || ClientRectangle.Height <= 0) return;
            using var background = new LinearGradientBrush(
                ClientRectangle,
                Color.FromArgb(237, 242, 247),
                Color.FromArgb(223, 231, 239),
                LinearGradientMode.Vertical
            );
            e.Graphics.FillRectangle(background, ClientRectangle);
            using var border = new Pen(Color.FromArgb(203, 213, 223));
            e.Graphics.DrawLine(border, 0, Height - 1, Width, Height - 1);
        }
    }

    private abstract class ClickableControl : Control
    {
        private bool _pressed;

        protected ClickableControl()
        {
            SetStyle(ControlStyles.Selectable, true);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                _pressed = true;
                Capture = true;
                Focus();
                Invalidate();
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            var shouldClick = _pressed
                && e.Button == MouseButtons.Left
                && ClientRectangle.Contains(e.Location);
            _pressed = false;
            Capture = false;
            Invalidate();
            base.OnMouseUp(e);
            if (shouldClick && !IsDisposed) OnClick(EventArgs.Empty);
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (!Capture) _pressed = false;
            Invalidate();
            base.OnMouseCaptureChanged(e);
        }
    }

    private sealed class ChromeCloseButton : ClickableControl
    {
        private bool _hovered;

        public ChromeCloseButton()
        {
            Cursor = Cursors.Hand;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.Selectable,
                true
            );
            TabStop = true;
            BackColor = Color.FromArgb(226, 234, 242);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            base.OnPaintBackground(e);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hovered = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hovered = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode is Keys.Enter or Keys.Space)
            {
                e.Handled = true;
                OnClick(EventArgs.Empty);
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 2 || Height < 2) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            if (_hovered)
            {
                using var fill = new SolidBrush(Color.FromArgb(229, 72, 77));
                using var path = RoundedPath(new Rectangle(4, 7, Width - 8, Height - 14), 7);
                e.Graphics.FillPath(fill, path);
            }
            using var pen = new Pen(_hovered ? Color.White : Color.FromArgb(71, 84, 103), 1.5f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            var centerX = Width / 2;
            var centerY = Height / 2;
            e.Graphics.DrawLine(pen, centerX - 6, centerY - 6, centerX + 6, centerY + 6);
            e.Graphics.DrawLine(pen, centerX + 6, centerY - 6, centerX - 6, centerY + 6);
        }
    }

    private sealed class InfoGlyph : Control
    {
        public InfoGlyph()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            BackColor = Color.FromArgb(248, 250, 252);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            base.OnPaintBackground(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 12 || Height < 12) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var halo = new SolidBrush(Color.FromArgb(232, 242, 255));
            using var circle = new SolidBrush(Color.FromArgb(21, 112, 239));
            e.Graphics.FillEllipse(halo, 0, 0, Width, Height);
            e.Graphics.FillEllipse(circle, 6, 6, Width - 12, Height - 12);
            using var font = new Font("Segoe UI", 9f, FontStyle.Bold);
            TextRenderer.DrawText(
                e.Graphics,
                "i",
                font,
                ClientRectangle,
                Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
            );
        }
    }

    private sealed class ChoiceCard : ClickableControl
    {
        private readonly string _title;
        private readonly string _description;
        private readonly bool _recommended;
        private readonly bool _danger;
        private readonly Font _titleFont = new("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
        private readonly Font _descriptionFont = new("Microsoft YaHei UI", 8.7f, FontStyle.Regular);
        private readonly Font _badgeFont = new("Microsoft YaHei UI", 7.8f, FontStyle.Bold);
        private bool _hovered;

        public ChoiceCard(string title, string description, bool recommended, bool danger)
        {
            _title = title;
            _description = description;
            _recommended = recommended;
            _danger = danger;
            Cursor = Cursors.Hand;
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw
                | ControlStyles.UserPaint
                | ControlStyles.Selectable,
                true
            );
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hovered = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hovered = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode is Keys.Enter or Keys.Space)
            {
                e.Handled = true;
                OnClick(EventArgs.Empty);
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            var fillColor = _danger
                ? (_hovered ? Color.FromArgb(255, 247, 245) : Color.White)
                : (_hovered ? Color.FromArgb(238, 246, 255) : Color.FromArgb(246, 250, 255));
            var borderColor = _danger
                ? (_hovered ? Color.FromArgb(253, 162, 155) : Color.FromArgb(208, 213, 221))
                : (_hovered || Focused ? Color.FromArgb(82, 139, 255) : Color.FromArgb(178, 204, 255));
            using var path = RoundedPath(bounds, 10);
            using var fill = new SolidBrush(fillColor);
            using var border = new Pen(borderColor, Focused ? 1.8f : 1.2f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            var iconSize = Math.Clamp(Height - 12, 18, 24);
            var iconBounds = new Rectangle(10, Math.Max(4, (Height - iconSize) / 2), iconSize, iconSize);
            using var iconFill = new SolidBrush(_danger ? Color.FromArgb(255, 235, 232) : Color.FromArgb(21, 112, 239));
            e.Graphics.FillEllipse(iconFill, iconBounds);
            using var iconPen = new Pen(_danger ? Color.FromArgb(217, 45, 32) : Color.White, 1.7f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            if (_danger)
            {
                e.Graphics.DrawArc(iconPen, iconBounds.Left + 6, iconBounds.Top + 7, 15, 14, -48, 276);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 14, iconBounds.Top + 5, iconBounds.Left + 14, iconBounds.Top + 14);
            }
            else
            {
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 7, iconBounds.Top + 14, iconBounds.Left + 19, iconBounds.Top + 14);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 14, iconBounds.Top + 8, iconBounds.Left + 20, iconBounds.Top + 14);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 14, iconBounds.Top + 20, iconBounds.Left + 20, iconBounds.Top + 14);
            }

            var titleX = 42;
            var hasDescription = !string.IsNullOrWhiteSpace(_description);
            var titleY = hasDescription ? 8 : Math.Max(5, (Height - 22) / 2);
            TextRenderer.DrawText(
                e.Graphics,
                _title,
                _titleFont,
                new Point(titleX, titleY),
                _danger ? Color.FromArgb(145, 32, 24) : Color.FromArgb(16, 42, 67),
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine
            );
            if (_recommended)
            {
                var titleWidth = TextRenderer.MeasureText(_title, _titleFont, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Width;
                var badge = new Rectangle(titleX + titleWidth + 6, titleY, 36, 19);
                using var badgePath = RoundedPath(badge, 9);
                using var badgeFill = new SolidBrush(Color.FromArgb(220, 235, 255));
                e.Graphics.FillPath(badgeFill, badgePath);
                TextRenderer.DrawText(
                    e.Graphics,
                    "推荐",
                    _badgeFont,
                    badge,
                    Color.FromArgb(23, 92, 211),
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
                );
            }

            if (hasDescription)
            {
                TextRenderer.DrawText(
                    e.Graphics,
                    _description,
                    _descriptionFont,
                    new Rectangle(titleX, 42, Math.Max(40, Width - titleX - 48), Math.Max(24, Height - 48)),
                    Color.FromArgb(102, 112, 133),
                    TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.Top
                );
            }

            var chevronX = Width - 15;
            var chevronY = Height / 2;
            using var chevron = new Pen(_danger ? Color.FromArgb(217, 45, 32) : Color.FromArgb(21, 112, 239), 1.8f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            e.Graphics.DrawLine(chevron, chevronX - 4, chevronY - 6, chevronX + 2, chevronY);
            e.Graphics.DrawLine(chevron, chevronX + 2, chevronY, chevronX - 4, chevronY + 6);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _titleFont.Dispose();
                _descriptionFont.Dispose();
                _badgeFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    private sealed class RoundedActionButton : ClickableControl
    {
        private bool _hovered;

        public RoundedActionButton()
        {
            Cursor = Cursors.Hand;
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint
                | ControlStyles.Selectable,
                true
            );
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hovered = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hovered = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnGotFocus(EventArgs e)
        {
            Invalidate();
            base.OnGotFocus(e);
        }

        protected override void OnLostFocus(EventArgs e)
        {
            Invalidate();
            base.OnLostFocus(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode is Keys.Enter or Keys.Space)
            {
                e.Handled = true;
                OnClick(EventArgs.Empty);
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 4 || Height < 8) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(1, 3, Math.Max(1, Width - 3), Math.Max(1, Height - 6));
            using var path = RoundedPath(bounds, 8);
            using var fill = new SolidBrush(_hovered ? Color.FromArgb(238, 242, 246) : Color.White);
            using var border = new Pen(Focused ? Color.FromArgb(82, 139, 255) : Color.FromArgb(203, 213, 223), Focused ? 1.7f : 1f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);
            TextRenderer.DrawText(
                e.Graphics,
                Text,
                Font,
                bounds,
                Color.FromArgb(71, 84, 103),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
            );
        }
    }

    private static GraphicsPath RoundedPath(Rectangle rect, int radius)
    {
        rect.Width = Math.Max(1, rect.Width);
        rect.Height = Math.Max(1, rect.Height);
        var path = new GraphicsPath();
        if (rect.Width < 2 || rect.Height < 2)
        {
            path.AddRectangle(rect);
            return path;
        }
        var maxRadius = Math.Max(1, Math.Min(rect.Width, rect.Height) / 2);
        radius = Math.Clamp(radius, 1, maxRadius);
        var diameter = Math.Min(Math.Min(rect.Width, rect.Height), Math.Max(2, radius * 2));
        if (diameter < 2)
        {
            path.AddRectangle(rect);
            return path;
        }
        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}
