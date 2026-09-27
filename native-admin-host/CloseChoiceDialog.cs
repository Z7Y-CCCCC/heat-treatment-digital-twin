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
    private const int CornerRadius = 18;
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
        ClientSize = new Size(270, 252);
        MinimumSize = ClientSize;
        MaximumSize = ClientSize;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(40, 41, 43);
        ForeColor = Color.FromArgb(234, 235, 229);
        Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
        DoubleBuffered = true;
        KeyPreview = true;

        var header = new ChromeHeader
        {
            Dock = DockStyle.Top,
            Height = 37,
            Padding = new Padding(26, 0, 8, 0)
        };
        var title = new Label
        {
            Dock = DockStyle.Left,
            Width = 205,
            Text = "HEAT TREATMENT  /  SYSTEM",
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(166, 177, 169),
            Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
            BackColor = Color.Transparent
        };
        var closeButton = new ChromeCloseButton
        {
            Dock = DockStyle.Right,
            Width = 27,
            AccessibleName = "关闭弹窗"
        };
        closeButton.Click += (_, _) => CancelAndClose();
        header.Controls.Add(closeButton);
        header.Controls.Add(title);
        BindWindowDrag(header);
        BindWindowDrag(title);

        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(14, 6, 14, 10),
            BackColor = Color.FromArgb(40, 41, 43)
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 55f));
        content.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 23f));

        var hero = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent
        };
        var heading = new Label
        {
            Dock = DockStyle.Top,
            Height = 29,
            Text = "要离开大屏吗？",
            ForeColor = Color.FromArgb(239, 240, 235),
            Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
            BackColor = Color.Transparent
        };
        var subtitle = new Label
        {
            Dock = DockStyle.Bottom,
            Height = 23,
            Text = "选择接下来的运行方式",
            ForeColor = Color.FromArgb(158, 161, 158),
            Font = new Font("Microsoft YaHei UI", 8.5f),
            TextAlign = ContentAlignment.MiddleLeft,
            BackColor = Color.Transparent
        };
        hero.Controls.Add(heading);
        hero.Controls.Add(subtitle);

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
            "收起到系统托盘",
            "后台运行，可随时恢复",
            danger: false
        )
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 4),
            AccessibleName = "最小化到系统托盘"
        };
        var exitCard = new ChoiceCard(
            "完全退出程序",
            "安全结束，并按设置备份",
            danger: true
        )
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 4, 0, 0),
            AccessibleName = "完全退出程序"
        };
        _minimizeCard.Click += (_, _) => Complete(CloseChoice.MinimizeToTray);
        exitCard.Click += (_, _) => Complete(CloseChoice.ExitApplication);
        options.Controls.Add(_minimizeCard, 0, 0);
        options.Controls.Add(exitCard, 0, 1);

        var footer = new Label
        {
            Dock = DockStyle.Fill,
            Text = "ESC  ·  继续使用大屏",
            TextAlign = ContentAlignment.BottomLeft,
            ForeColor = Color.FromArgb(130, 136, 133),
            Font = new Font("Microsoft YaHei UI", 7.5f),
            BackColor = Color.Transparent
        };
        content.Controls.Add(hero, 0, 0);
        content.Controls.Add(options, 0, 1);
        content.Controls.Add(footer, 0, 2);
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
        using var pen = new Pen(Color.FromArgb(84, 87, 86));
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
                Color.FromArgb(48, 49, 51),
                Color.FromArgb(42, 43, 45),
                LinearGradientMode.Horizontal
            );
            e.Graphics.FillRectangle(background, ClientRectangle);
            using var accent = new SolidBrush(Color.FromArgb(152, 189, 169));
            e.Graphics.FillRectangle(accent, 14, 12, 2, 11);
            using var border = new Pen(Color.FromArgb(70, 73, 73));
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
            BackColor = Color.FromArgb(43, 44, 46);
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
                using var fill = new SolidBrush(Color.FromArgb(68, 70, 71));
                using var path = RoundedPath(new Rectangle(1, 5, Width - 2, Height - 10), 8);
                e.Graphics.FillPath(fill, path);
            }
            using var pen = new Pen(_hovered ? Color.FromArgb(241, 242, 237) : Color.FromArgb(162, 166, 163), 1.4f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            var centerX = Width / 2;
            var centerY = Height / 2;
            e.Graphics.DrawLine(pen, centerX - 4, centerY - 4, centerX + 4, centerY + 4);
            e.Graphics.DrawLine(pen, centerX + 4, centerY - 4, centerX - 4, centerY + 4);
        }
    }

    private sealed class ChoiceCard : ClickableControl
    {
        private readonly string _title;
        private readonly string _description;
        private readonly bool _danger;
        private readonly Font _titleFont = new("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        private readonly Font _descriptionFont = new("Microsoft YaHei UI", 7.8f, FontStyle.Regular);
        private bool _hovered;

        public ChoiceCard(string title, string description, bool danger)
        {
            _title = title;
            _description = description;
            _danger = danger;
            BackColor = Color.FromArgb(40, 41, 43);
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
            if (Width < 48 || Height < 30) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            var fillColor = _danger
                ? (_hovered ? Color.FromArgb(62, 54, 52) : Color.FromArgb(48, 47, 48))
                : (_hovered ? Color.FromArgb(55, 61, 57) : Color.FromArgb(49, 52, 51));
            var borderColor = _danger
                ? (_hovered || Focused ? Color.FromArgb(166, 126, 109) : Color.FromArgb(81, 74, 72))
                : (_hovered || Focused ? Color.FromArgb(138, 175, 154) : Color.FromArgb(77, 86, 81));
            using var path = RoundedPath(bounds, 9);
            using var fill = new SolidBrush(fillColor);
            using var border = new Pen(borderColor, Focused ? 1.6f : 1f);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(border, path);

            var iconBounds = new Rectangle(11, (Height - 25) / 2, 25, 25);
            using var iconFill = new SolidBrush(_danger ? Color.FromArgb(76, 61, 56) : Color.FromArgb(59, 77, 67));
            e.Graphics.FillEllipse(iconFill, iconBounds);
            using var iconPen = new Pen(_danger ? Color.FromArgb(220, 167, 142) : Color.FromArgb(168, 207, 184), 1.6f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            if (_danger)
            {
                e.Graphics.DrawArc(iconPen, iconBounds.Left + 7, iconBounds.Top + 7, 11, 11, -48, 276);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 12.5f, iconBounds.Top + 5, iconBounds.Left + 12.5f, iconBounds.Top + 13);
            }
            else
            {
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 7, iconBounds.Top + 17, iconBounds.Left + 18, iconBounds.Top + 17);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 12.5f, iconBounds.Top + 7, iconBounds.Left + 12.5f, iconBounds.Top + 14);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 9.5f, iconBounds.Top + 11, iconBounds.Left + 12.5f, iconBounds.Top + 14);
                e.Graphics.DrawLine(iconPen, iconBounds.Left + 15.5f, iconBounds.Top + 11, iconBounds.Left + 12.5f, iconBounds.Top + 14);
            }

            const int titleX = 47;
            TextRenderer.DrawText(
                e.Graphics,
                _title,
                _titleFont,
                new Rectangle(titleX, 7, Width - titleX - 24, 20),
                Color.FromArgb(232, 234, 229),
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis
            );
            TextRenderer.DrawText(
                e.Graphics,
                _description,
                _descriptionFont,
                new Rectangle(titleX, 27, Width - titleX - 24, 18),
                Color.FromArgb(153, 159, 155),
                TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis
            );

            var chevronX = Width - 16;
            var chevronY = Height / 2;
            using var chevron = new Pen(_hovered ? Color.FromArgb(218, 227, 218) : Color.FromArgb(130, 140, 133), 1.4f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            e.Graphics.DrawLine(chevron, chevronX - 3, chevronY - 4, chevronX + 1, chevronY);
            e.Graphics.DrawLine(chevron, chevronX + 1, chevronY, chevronX - 3, chevronY + 4);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _titleFont.Dispose();
                _descriptionFont.Dispose();
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
