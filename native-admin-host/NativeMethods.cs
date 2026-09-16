using System;
using System.Drawing;
using System.Runtime.InteropServices;

namespace HeatTreatmentAdminHost;

internal static class NativeMethods
{
    internal const int GwlStyle = -16;
    internal const int GwlExStyle = -20;
    internal const int GwlHwndParent = -8;
    internal const long WsChild = 0x40000000L;
    internal const long WsVisible = 0x10000000L;
    internal const long WsClipChildren = 0x02000000L;
    internal const long WsClipSiblings = 0x04000000L;
    internal const long WsPopup = unchecked((long)0x80000000);
    internal const long WsCaption = 0x00C00000L;
    internal const long WsThickFrame = 0x00040000L;
    internal const long WsMinimizeBox = 0x00020000L;
    internal const long WsMaximizeBox = 0x00010000L;
    internal const long WsSysMenu = 0x00080000L;
    internal const long WsExAppWindow = 0x00040000L;
    internal const long WsExToolWindow = 0x00000080L;

    internal const uint SwHide = 0;
    internal const uint SwMaximize = 3;
    internal const uint SwShow = 5;
    internal const uint SwMinimize = 6;
    internal const uint SwRestore = 9;
    internal const uint SwpNoActivate = 0x0010;
    internal const uint SwpNoZOrder = 0x0004;
    internal const uint SwpFrameChanged = 0x0020;
    internal const uint SwpShowWindow = 0x0040;
    internal const uint WmApp = 0x8000;
    internal const uint WmClose = 0x0010;
    internal const uint WmMouseMove = 0x0200;
    internal const uint WmLButtonDown = 0x0201;
    internal const uint WmLButtonUp = 0x0202;
    internal const uint WmLButtonDblClk = 0x0203;
    internal const uint WmRButtonDown = 0x0204;
    internal const uint WmRButtonUp = 0x0205;
    internal const uint WmMButtonDown = 0x0207;
    internal const uint WmMButtonUp = 0x0208;
    internal const uint WmMouseWheel = 0x020A;
    internal const uint WmXButtonDown = 0x020B;
    internal const uint WmXButtonUp = 0x020C;
    internal const uint WmNcHitTest = 0x0084;
    internal const uint WmNcLButtonDown = 0x00A1;
    internal const uint WmNcLButtonDblClk = 0x00A3;
    internal const uint WmExitSizeMove = 0x0232;

    internal const int HtClient = 1;
    internal const int HtTransparent = -1;
    internal const int HtCaption = 2;
    internal const int HtLeft = 10;
    internal const int HtRight = 11;
    internal const int HtTop = 12;
    internal const int HtTopLeft = 13;
    internal const int HtTopRight = 14;
    internal const int HtBottom = 15;
    internal const int HtBottomLeft = 16;
    internal const int HtBottomRight = 17;
    internal const int MkLButton = 0x0001;
    internal const int MkRButton = 0x0002;
    internal const int MkShift = 0x0004;
    internal const int MkControl = 0x0008;
    internal const int MkMButton = 0x0010;
    internal const int MkXButton1 = 0x0020;
    internal const int MkXButton2 = 0x0040;

    internal const int DwmWindowCornerPreference = 33;
    internal const int DwmWindowCornerDefault = 0;
    internal const int DwmWindowCornerDoNotRound = 1;
    internal const int DwmWindowCornerRound = 2;

    internal static readonly IntPtr HwndTop = IntPtr.Zero;

    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Without this the host is only
    // system-DPI aware, so on a scaled display Windows stretches the child window
    // inside the per-monitor-aware Unity parent and crops whatever does not fit.
    internal static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new(-4);

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
        public readonly Rectangle ToRectangle() => new(Left, Top, Width, Height);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetParent(IntPtr child, IntPtr parent);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr handle, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr32(IntPtr handle, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr handle, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr32(IntPtr handle, int index, IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool GetClientRect(IntPtr handle, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool GetWindowRect(IntPtr handle, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool ClientToScreen(IntPtr handle, ref Point point);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool ScreenToClient(IntPtr handle, ref Point point);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool EnableWindow(IntPtr handle, bool enable);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsWindowEnabled(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool IsZoomed(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool SetWindowPos(
        IntPtr handle,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool ShowWindow(IntPtr handle, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool ReleaseCapture();

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetDpiForWindow(IntPtr handle);

    [DllImport("dwmapi.dll", PreserveSig = true)]
    internal static extern int DwmSetWindowAttribute(
        IntPtr handle,
        int attribute,
        ref int value,
        int valueSize
    );

    [DllImport("gdi32.dll", SetLastError = true)]
    internal static extern IntPtr CreateRoundRectRgn(
        int left,
        int top,
        int right,
        int bottom,
        int ellipseWidth,
        int ellipseHeight
    );

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int SetWindowRgn(IntPtr handle, IntPtr region, bool redraw);

    [DllImport("gdi32.dll", SetLastError = true)]
    internal static extern bool DeleteObject(IntPtr handle);

    internal static long GetWindowStyle(IntPtr handle, int index)
    {
        var value = IntPtr.Size == 8
            ? GetWindowLongPtr64(handle, index)
            : GetWindowLongPtr32(handle, index);
        return value.ToInt64();
    }

    internal static long SetWindowStyle(IntPtr handle, int index, long value)
    {
        var old = IntPtr.Size == 8
            ? SetWindowLongPtr64(handle, index, new IntPtr(value))
            : SetWindowLongPtr32(handle, index, new IntPtr(value));
        return old.ToInt64();
    }

    internal static IntPtr SetWindowOwner(IntPtr handle, IntPtr owner)
    {
        return IntPtr.Size == 8
            ? SetWindowLongPtr64(handle, GwlHwndParent, owner)
            : SetWindowLongPtr32(handle, GwlHwndParent, owner);
    }

    /// <summary>
    /// Convert a layout metric authored at the Windows 96-DPI baseline to the
    /// physical pixels expected by Win32 positioning APIs. WinForms and WebView2
    /// can expose logical units while SetWindowPos always receives device pixels
    /// for a PerMonitorV2 process, so all shared chrome metrics go through this
    /// helper instead of multiplying ad hoc at each call site.
    /// </summary>
    internal static int Scale96(int value, uint dpi)
    {
        var effectiveDpi = dpi == 0 ? 96u : dpi;
        return Math.Max(1, (int)Math.Round(value * effectiveDpi / 96d, MidpointRounding.AwayFromZero));
    }

    internal static uint GetWindowDpiOrDefault(IntPtr handle, uint fallback = 96)
    {
        var dpi = handle != IntPtr.Zero ? GetDpiForWindow(handle) : 0;
        return dpi == 0 ? Math.Max(96u, fallback) : dpi;
    }

    internal static IntPtr PackScreenPoint(int x, int y)
    {
        var packed = unchecked((int)((uint)(ushort)x | ((uint)(ushort)y << 16)));
        return new IntPtr(packed);
    }

    internal static IntPtr PackClientPoint(int x, int y) => PackScreenPoint(x, y);
}
