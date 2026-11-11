using System;
using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal static class StartupReadiness
{
    public static bool CanFinish(string source, JsonElement message)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)) return false;
        if (uri.AbsolutePath == "/group") return true; // The map owns its own ready condition.
        if (uri.AbsolutePath != "/overlay") return false;
        var pageReady = message.TryGetProperty("pageReady", out var page) && page.ValueKind == JsonValueKind.True;
        if (!pageReady) return false;
        foreach (var part in uri.Query.TrimStart('?').Split('&'))
            if (part == "noVisibleFactory=1") return true;
        return message.TryGetProperty("nativeSceneReady", out var ready) && ready.ValueKind == JsonValueKind.True
            && message.TryGetProperty("loadId", out var id) && id.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(id.GetString());
    }
}
