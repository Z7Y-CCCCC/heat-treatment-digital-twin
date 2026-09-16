using Microsoft.Web.WebView2.Core;

namespace HeatTreatmentAdminHost;

/// <summary>Opt-in local QA artifacts. Disabled unless a diagnostic directory is supplied.</summary>
internal static class OverlayPresentationDiagnostics
{
    private static int _captured;

    public static async Task CaptureAsync(CoreWebView2CompositionController controller)
    {
        var directory = Environment.GetEnvironmentVariable("DIGITAL_TWIN_OVERLAY_DIAGNOSTICS_DIR");
        if (string.IsNullOrWhiteSpace(directory)) return;
        if (Interlocked.Exchange(ref _captured, 1) != 0) return;
        try
        {
            await Task.Delay(1500);
            directory = Path.GetFullPath(directory);
            Directory.CreateDirectory(directory);
            var json = await controller.CoreWebView2.ExecuteScriptAsync("""
                (() => ({
                  viewport: [innerWidth, innerHeight, devicePixelRatio],
                  sheets: [...document.styleSheets].map(sheet => sheet.href).filter(Boolean),
                  elements: [...document.querySelectorAll('html,body,#app,.dashboard-overlay-root,.overlay-canvas,.widget-shell')].slice(0,24).map(element => {
                    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
                    return { element: element.className || element.tagName, background: style.background, opacity: style.opacity,
                      bounds: [rect.x,rect.y,rect.width,rect.height] };
                  })
                }))()
                """);
            await File.WriteAllTextAsync(Path.Combine(directory, "overlay-presentation.json"), json);
            await using var stream = File.Create(Path.Combine(directory, "overlay-webview.png"));
            await controller.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        }
        catch (Exception exception)
        {
            // Closing/reloading during capture must not affect the dashboard.
            System.Diagnostics.Debug.WriteLine($"Overlay QA capture skipped: {exception.Message}");
        }
    }
}
