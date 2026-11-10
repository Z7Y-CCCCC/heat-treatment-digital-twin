using System;
using System.Runtime.InteropServices;

namespace HeatTreatment.DigitalTwin.Runtime
{
    /// <summary>
    /// Resolves the actual window below the Windows cursor, not Unity's last
    /// mouse position or its keyboard focus. The native HUD is an owned popup
    /// (with cross-process WebView2 children), so its root/owner chain belongs
    /// to the Unity application even while Unity itself is unfocused.
    /// </summary>
    public sealed class NativePointerWindowGuard
    {
        public readonly struct WindowObservation
        {
            public readonly bool WindowFound;
            public readonly uint ApplicationProcessId, HitProcessId, RootProcessId, RootOwnerProcessId;
            public readonly int ClientX, ClientY, ClientWidth, ClientHeight;

            public WindowObservation(uint applicationProcessId, uint hitProcessId,
                uint rootProcessId, uint rootOwnerProcessId, bool windowFound = true,
                int clientX = 0, int clientY = 0, int clientWidth = 0, int clientHeight = 0)
            {
                ApplicationProcessId = applicationProcessId;
                HitProcessId = hitProcessId;
                RootProcessId = rootProcessId;
                RootOwnerProcessId = rootOwnerProcessId;
                WindowFound = windowFound;
                ClientX = clientX;
                ClientY = clientY;
                ClientWidth = clientWidth;
                ClientHeight = clientHeight;
            }
        }

        private readonly Func<WindowObservation> _observeWindow;
        private bool _hasCachedFrame, _cachedOwned;
        private int _cachedFrame;
        private WindowObservation _cachedWindow;

        // The optional observer permits isolated regression tests without
        // moving the user's cursor, creating windows, or changing OS focus.
        public NativePointerWindowGuard(Func<WindowObservation> observeWindow = null)
        {
#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
            _observeWindow = observeWindow ?? ObserveWindowsCursorWindow;
#else
            // An Editor HWND also contains inspectors/toolbars, not only the
            // Game View render surface. Preserve its existing Unity input
            // coordinates rather than mapping the entire Editor client area.
            _observeWindow = observeWindow;
#endif
        }

        public bool IsPointerOverApplication(bool webOverlayActive, bool applicationIsFocused, int frame)
        {
            if (_observeWindow == null) return LegacyPointerEligibility(webOverlayActive, applicationIsFocused);
            ObserveFrame(frame);
            return _cachedOwned;
        }

        public bool TryResolvePointer(bool webOverlayActive, bool applicationIsFocused, int frame,
            int renderWidth, int renderHeight, float legacyX, float legacyY, out float x, out float y)
        {
            x = legacyX;
            y = legacyY;
            if (_observeWindow == null) return LegacyPointerEligibility(webOverlayActive, applicationIsFocused);
            ObserveFrame(frame);
            // Never fall back to stale Unity coordinates for an owned Windows
            // HUD when client projection is temporarily unavailable.
            return _cachedOwned && TryProjectClientPointer(_cachedWindow, renderWidth, renderHeight, out x, out y);
        }

        private void ObserveFrame(int frame)
        {
            // Both overview/detail polling share one observation per frame.
            // Recheck every new frame even with a stationary pointer: another
            // application can cover our window without any Unity mouse event.
            if (!_hasCachedFrame || _cachedFrame != frame)
            {
                _hasCachedFrame = true;
                _cachedFrame = frame;
                try {
                    _cachedWindow = _observeWindow();
                    _cachedOwned = BelongsToApplication(_cachedWindow);
                }
                catch {
                    _cachedWindow = default;
                    _cachedOwned = false;
                } // Unknown Windows ownership is not a valid CAD pointer.
            }
        }

        public static bool TryProjectClientPointer(WindowObservation window, int renderWidth, int renderHeight,
            out float x, out float y)
        {
            x = y = 0;
            if (!BelongsToApplication(window) || window.ClientWidth <= 0 || window.ClientHeight <= 0
                || renderWidth <= 0 || renderHeight <= 0 || window.ClientX < 0 || window.ClientY < 0
                || window.ClientX >= window.ClientWidth || window.ClientY >= window.ClientHeight) return false;
            // Client and render sizes can differ with DPI/resolution scaling.
            // Both use pixel coordinates; flip the top-origin client Y to
            // Unity's bottom-origin render pixels while keeping edges inside.
            x = window.ClientX * ((float)renderWidth / window.ClientWidth);
            y = (window.ClientHeight - 1 - window.ClientY) * ((float)renderHeight / window.ClientHeight);
            return true;
        }

        public static bool LegacyPointerEligibility(bool webOverlayActive, bool applicationIsFocused)
            => webOverlayActive || applicationIsFocused;

        public static bool BelongsToApplication(WindowObservation window)
            => window.WindowFound && window.ApplicationProcessId != 0 && window.HitProcessId != 0
                && (window.HitProcessId == window.ApplicationProcessId
                    || window.RootProcessId == window.ApplicationProcessId
                    || window.RootOwnerProcessId == window.ApplicationProcessId);

#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
        private const uint GaRoot = 2, GaRootOwner = 3;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetCursorPos(out NativePoint point);

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(NativePoint point);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetClientRect(IntPtr window, out NativeRect rect);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ScreenToClient(IntPtr window, ref NativePoint point);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();

        private static uint WindowProcess(IntPtr window)
        {
            if (window == IntPtr.Zero) return 0;
            return GetWindowThreadProcessId(window, out var processId) != 0 ? processId : 0;
        }

        private static WindowObservation ObserveWindowsCursorWindow()
        {
            var applicationProcess = GetCurrentProcessId();
            if (!GetCursorPos(out var cursor)) return new WindowObservation(applicationProcess, 0, 0, 0, false);
            var hit = WindowFromPoint(cursor);
            if (hit == IntPtr.Zero) return new WindowObservation(applicationProcess, 0, 0, 0, false);
            var root = GetAncestor(hit, GaRoot);
            var owner = GetAncestor(hit, GaRootOwner);
            var hitProcess = WindowProcess(hit);
            var rootProcess = root == hit ? hitProcess : WindowProcess(root);
            var ownerProcess = owner == hit ? hitProcess : owner == root ? rootProcess : WindowProcess(owner);
            var identity = new WindowObservation(applicationProcess, hitProcess, rootProcess, ownerProcess, hitProcess != 0);
            // A foreign covering window must never be projected onto the
            // hidden Unity client just because Unity retained mouse/focus data.
            if (!BelongsToApplication(identity)) return identity;
            // No process-name match, stale HWND, MainWindowHandle enumeration
            // or remembered native-host PID can accidentally authorize a reused
            // process. Ownership comes from the actual HWND below this cursor.
            var clientWindow = ownerProcess == applicationProcess ? owner
                : rootProcess == applicationProcess ? root
                : hitProcess == applicationProcess ? hit : IntPtr.Zero;
            var clientPoint = cursor;
            if (clientWindow != IntPtr.Zero && GetClientRect(clientWindow, out var clientRect)
                && ScreenToClient(clientWindow, ref clientPoint))
                return new WindowObservation(applicationProcess, hitProcess, rootProcess, ownerProcess, hitProcess != 0,
                    clientPoint.X - clientRect.Left, clientPoint.Y - clientRect.Top,
                    clientRect.Right - clientRect.Left, clientRect.Bottom - clientRect.Top);
            return identity;
        }
#endif
    }
}
