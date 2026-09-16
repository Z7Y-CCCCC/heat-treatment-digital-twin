using System.Drawing;

namespace HeatTreatmentAdminHost;

internal static class OverlayInteractionGeometry
{
    // Pointer hit testing is kept separate from the native window shape. The
    // DirectComposition surface must always remain a full rectangle so its
    // per-pixel alpha can blend correctly over Unity.
    // Outward rounding preserves the thin CSS borders on scaled displays.
    public static Rectangle ToPixels(RectangleF cssBounds, SizeF cssViewport, Size clientSize)
    {
        if (clientSize.Width <= 0 || clientSize.Height <= 0
            || !Finite(cssBounds.X) || !Finite(cssBounds.Y)
            || !Finite(cssBounds.Width) || !Finite(cssBounds.Height)
            || cssBounds.Width <= 0 || cssBounds.Height <= 0
            || !Finite(cssViewport.Width) || !Finite(cssViewport.Height)
            || cssViewport.Width <= 0 || cssViewport.Height <= 0) return Rectangle.Empty;

        var scaleX = clientSize.Width / (double)cssViewport.Width;
        var scaleY = clientSize.Height / (double)cssViewport.Height;
        var left = (int)Math.Clamp(Math.Floor(cssBounds.X * scaleX), 0, clientSize.Width);
        var top = (int)Math.Clamp(Math.Floor(cssBounds.Y * scaleY), 0, clientSize.Height);
        var right = (int)Math.Clamp(Math.Ceiling(((double)cssBounds.X + cssBounds.Width) * scaleX), 0, clientSize.Width);
        var bottom = (int)Math.Clamp(Math.Ceiling(((double)cssBounds.Y + cssBounds.Height) * scaleY), 0, clientSize.Height);
        return right > left && bottom > top ? Rectangle.FromLTRB(left, top, right, bottom) : Rectangle.Empty;
    }

    public static bool ContainsPoint(IEnumerable<Rectangle> regions, Point point)
    {
        foreach (var region in regions)
        {
            if (region.Contains(point)) return true;
        }
        return false;
    }

    private static bool Finite(float value) => float.IsFinite(value);
}
