#nullable enable
namespace HeatTreatmentAdminHost;

internal static class WebContentPolicy
{
    // Navigation and native bridge messages must come from the configured app
    // origin, not a prefix match or an external page opened by target="_blank".
    public static bool IsSameOrigin(string? target, string? applicationUrl)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)
            || !Uri.TryCreate(applicationUrl, UriKind.Absolute, out var application)) return false;
        return (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            && string.IsNullOrEmpty(uri.UserInfo)
            && uri.Scheme.Equals(application.Scheme, StringComparison.OrdinalIgnoreCase)
            && uri.IdnHost.Equals(application.IdnHost, StringComparison.OrdinalIgnoreCase)
            && uri.Port == application.Port;
    }
}
