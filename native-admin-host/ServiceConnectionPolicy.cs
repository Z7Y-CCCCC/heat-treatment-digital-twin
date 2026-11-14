using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal static class ServiceConnectionPolicy
{
    internal static bool IsAdminSource(string source, string appUrl) =>
        WebContentPolicy.IsSameOrigin(source, appUrl) && Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.AbsolutePath == "/admin";
    internal static bool IsRequestId(string? value) => value is { Length: > 0 and <= 80 }
        && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    internal static bool IsOperationId(string? value) => value is { Length: 32 } && value.All(Uri.IsHexDigit);
    internal static bool Allows(JsonElement session, string action)
    {
        if (action is not ("unity_reconnect" or "unity_restart" or "data_reconnect" or
            "collector_center_data" or "collector_center_runtime" or "restart_status")) return false;
        if (!True(session, "authenticated")) return false;
        var owner = session.TryGetProperty("user", out var user) && user.TryGetProperty("role", out var role)
            && role.GetString() == "owner";
        var page = action == "collector_center_data" ? "settings.data" : "settings.runtime";
        var edit = owner || session.TryGetProperty("pagePermissions", out var pages)
            && pages.TryGetProperty(page, out var grant) && True(grant, "view") && True(grant, "edit");
        if (!edit) return false;
        return action is not ("unity_reconnect" or "unity_restart")
            || session.TryGetProperty("permissions", out var permissions) && True(permissions, "launch") && True(permissions, "view");
    }
    private static bool True(JsonElement root, string key) => root.ValueKind == JsonValueKind.Object
        && root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;
}
