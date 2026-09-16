using System.Runtime.InteropServices;

namespace HeatTreatmentAdminHost;

/// <summary>
/// A GPU visual, not a GDI/WinForms background. WebView's premultiplied alpha
/// reaches DWM unchanged, so translucent CSS blends with the Unity window.
/// The owning HWND must use WS_EX_NOREDIRECTIONBITMAP from its creation.
/// </summary>
internal sealed class OverlayCompositionSurface : IDisposable
{
    internal const int NoRedirectionBitmap = 0x00200000;
    private IDCompositionDevice? _device;
    private IDCompositionTarget? _target;
    private IDCompositionVisual? _rootVisual;

    public object RootVisual => _rootVisual ?? throw new ObjectDisposedException(nameof(OverlayCompositionSurface));

    public OverlayCompositionSurface(IntPtr window)
    {
        try
        {
            var deviceId = typeof(IDCompositionDevice).GUID;
            // Chromium supplies the rendering surfaces; no extra D3D device or
            // CPU screenshot/copy of the Unity scene is necessary.
            Marshal.ThrowExceptionForHR(DCompositionCreateDevice(IntPtr.Zero, ref deviceId, out _device));
            Marshal.ThrowExceptionForHR(_device.CreateTargetForHwnd(window, true, out _target));
            Marshal.ThrowExceptionForHR(_device.CreateVisual(out _rootVisual));
            Marshal.ThrowExceptionForHR(_target.SetRoot(_rootVisual));
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public void Commit()
    {
        if (_device != null) Marshal.ThrowExceptionForHR(_device.Commit());
    }

    public void Dispose()
    {
        // Disconnect the WebView controller before disposing this surface.
        // Release only our COM references; never FinalRelease a shared visual.
        if (_target != null) _target.SetRoot(null);
        if (_device != null) _device.Commit();
        Release(ref _rootVisual);
        Release(ref _target);
        Release(ref _device);
    }

    private static void Release<T>(ref T? value) where T : class
    {
        var instance = value;
        value = null;
        if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance);
    }

    [DllImport("dcomp.dll", ExactSpelling = true)]
    private static extern int DCompositionCreateDevice(
        IntPtr renderingDevice, ref Guid iid, out IDCompositionDevice device);

    // These are the first five methods, in SDK dcomp.h vtable order. The
    // remaining factory methods are intentionally unused by this host.
    [ComImport, Guid("C37EA93A-E7AA-450D-B16F-9746CB0407F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDCompositionDevice
    {
        [PreserveSig] int Commit();
        [PreserveSig] int WaitForCommitCompletion();
        [PreserveSig] int GetFrameStatistics(IntPtr statistics);
        [PreserveSig] int CreateTargetForHwnd(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IDCompositionTarget target);
        [PreserveSig] int CreateVisual(out IDCompositionVisual visual);
    }

    [ComImport, Guid("EACDD04C-117E-4E17-88F4-D1B12B0E3D89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDCompositionTarget
    {
        [PreserveSig] int SetRoot(IDCompositionVisual? visual);
    }

    // Only interface identity is needed: WebView2 owns the visual's children.
    [ComImport, Guid("4D93059D-097B-4651-9A60-F0F25116E2F3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDCompositionVisual { }
}
