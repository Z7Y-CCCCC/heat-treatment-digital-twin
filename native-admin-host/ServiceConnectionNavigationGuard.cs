using Microsoft.Web.WebView2.Core;

namespace HeatTreatmentAdminHost;

internal static class ServiceConnectionNavigationGuard
{
    // NavigationStarting alone can allow a speculative document request before
    // cancellation. Never load a foreign document into a privileged WebView,
    // including same-host/different-port iframes. Normal remote assets and links
    // explicitly opened in the system browser retain their existing behavior.
    internal static void Install(CoreWebView2 view, string applicationUrl)
    {
        view.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.Document);
        view.WebResourceRequested += (_, args) =>
        {
            if (!WebContentPolicy.IsSameOrigin(args.Request.Uri, applicationUrl))
                args.Response = view.Environment.CreateWebResourceResponse(new MemoryStream(), 403,
                    "Forbidden", "Content-Type: text/plain\r\nCache-Control: no-store");
        };
    }
}
