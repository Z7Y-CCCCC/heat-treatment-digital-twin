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
