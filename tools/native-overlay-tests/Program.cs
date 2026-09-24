using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using HeatTreatmentAdminHost;

internal static class Program
{
    private static int _passed;

    [STAThread]
    private static void Main()
    {
        var retry = new NavigationRetryPolicy("http://127.0.0.1:3001/overlay?embedded=unity");
        Check(retry.Started(1, "http://127.0.0.1:3001/overlay?embedded=unity"), "Local app navigation is retryable");
        Check(retry.Completed(1, false, 0) == 1000, "Connection refusal schedules the first retry");
        retry.Started(2, retry.Url);
        Check(retry.Completed(1, false, 0) == null, "An old navigation failure cannot schedule a stale retry");
        Check(retry.Completed(2, false, 0) == 2000, "Repeated failure backs off");
        retry.Started(3, retry.Url);
        Check(retry.Completed(3, true, 200) == null, "A successful document stops retrying");
        retry.Started(4, retry.Url);
        Check(retry.Completed(4, true, 503) == 1000, "HTTP 503 retries even when navigation transport succeeds");
        retry.Started(5, retry.Url);
        Check(retry.Completed(5, false, 0, cancelled: true) == null, "Cancelled navigations are not retried");
        Check(!retry.Started(6, "https://example.com/"), "Retries cannot bypass the same-origin policy");
        Check(!retry.Started(7, "http://user:secret@127.0.0.1:3001/admin"), "Credential URLs are not retained as retry targets");
        Check(NavigationRetryPolicy.IsUsable(true, 401), "Authentication failures are left for user attention");
        for (ulong id = 8; id < 18; id++) { retry.Started(id, retry.Url); Check(retry.Completed(id, false, 0) <= 15000, "Retry delay is bounded"); }

        Check(DashboardAccessPolicy.HasLaunchAndViewPermission("{\"authenticated\":true,\"permissions\":{\"launch\":true,\"view\":true}}"),
            "An authenticated launch/view account can switch to the dashboard");
        Check(!DashboardAccessPolicy.HasLaunchAndViewPermission("{\"authenticated\":true,\"permissions\":{\"launch\":false,\"view\":true}}"),
            "A signed-in account without launch permission remains blocked");
        Check(!DashboardAccessPolicy.HasLaunchAndViewPermission("{\"authenticated\":false,\"permissions\":{\"launch\":true,\"view\":true}}"),
            "A locked session cannot switch to the dashboard");
        Check(!DashboardAccessPolicy.HasLaunchAndViewPermission("not-json"), "An invalid session response is denied safely");

        Check(OverlayInteractionGeometry.ToPixels(new(10.25f, 20.5f, 99.5f, 39.25f), new(1920,1080), new(1920,1080))
            == Rectangle.FromLTRB(10,20,110,60), "Subpixel borders are rounded out, not cut off");
        foreach (var scale in new[] { 1f, 1.25f, 1.5f, 2f })
        {
            var actual = OverlayInteractionGeometry.ToPixels(new(100,50,300,200), new(1920,1080), new((int)(1920*scale),(int)(1080*scale)));
            Check(actual == new Rectangle((int)(100*scale),(int)Math.Floor(50*scale),(int)(300*scale),(int)Math.Ceiling(250*scale)-(int)Math.Floor(50*scale)), $"DPI {scale}: pointer bounds and painting agree");
        }
        Check(OverlayInteractionGeometry.ToPixels(new(-10,-20,50,70),new(100,100),new(100,100)) == new Rectangle(0,0,40,50), "Off-canvas bounds are clipped");
        Check(OverlayInteractionGeometry.ToPixels(new(120,120,20,20),new(100,100),new(100,100)).IsEmpty, "Off-screen widgets do not intercept input");
        Check(OverlayInteractionGeometry.ToPixels(new(float.NaN,0,10,10),new(100,100),new(100,100)).IsEmpty, "Invalid geometry is rejected");
        Check(OverlayInteractionGeometry.ToPixels(new(1,1,10,10),new(0,100),new(100,100)).IsEmpty, "Empty viewport is rejected");
        Check(OverlayInteractionGeometry.ToPixels(new(-float.MaxValue,0,float.MaxValue,20),new(1,1),new(1920,1080)).IsEmpty, "Extreme coordinates do not overflow");
        var panels = new[] { new RectangleF(1536,142,344,196), new RectangleF(28,822,400,206) };
        Check(panels.All(rect => !OverlayInteractionGeometry.ToPixels(rect,new(1920,1080),new(1280,720)).Contains(640,360)), "Center of Unity remains outside the Web input region");
        var inputRegions = panels.Select(rect => OverlayInteractionGeometry.ToPixels(rect, new(1920, 1080), new(1280, 720))).ToArray();
        Check(OverlayInteractionGeometry.ContainsPoint(inputRegions, new Point(1160, 160)), "Widget area is interactive without clipping the composition surface");
        Check(!OverlayInteractionGeometry.ContainsPoint(inputRegions, new Point(640, 360)), "Unity center remains pointer-transparent without a window region");

        var device = typeof(OverlayCompositionSurface).GetNestedType("IDCompositionDevice", BindingFlags.NonPublic)!;
        Check(device.GetMethods().OrderBy(method => method.MetadataToken).Select(method => method.Name).SequenceEqual(
            new[] { "Commit", "WaitForCommitCompletion", "GetFrameStatistics", "CreateTargetForHwnd", "CreateVisual" }), "DirectComposition COM vtable matches Windows SDK");

        // Create an invisible test HWND only. No user window is driven, moved,
        // captured or shown; this checks the actual Windows composition API.
        using var window = new TransparentTestWindow();
        using var surface = new OverlayCompositionSurface(window.Handle);
        Check(surface.RootVisual != null, "GPU composition root is created");
        surface.Commit();
        surface.Dispose();
        surface.Dispose();
        var disposed = false;
        try { _ = surface.RootVisual; } catch (ObjectDisposedException) { disposed = true; }
        Check(disposed, "Composition resources dispose idempotently");
        Console.WriteLine($"Native overlay: {_passed} checks passed.");
    }

    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException(name);
        _passed++;
        Console.WriteLine($"PASS {name}");
    }

    private sealed class TransparentTestWindow : Form
    {
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.ExStyle |= OverlayCompositionSurface.NoRedirectionBitmap; return parameters; }
        }
    }
}
