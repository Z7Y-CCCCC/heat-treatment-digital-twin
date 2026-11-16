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
    // These identifiers predate the visible service names: data is the PLC
    // configuration permission; runtime is the API/database diagnostics page.
    internal static string? CenterView(string action) => action switch
    {
        "collector_center_data" => "points",
        "collector_center_runtime" => "overview",
        _ => null
    };
    internal static string? CenterControlPath(string action) => action switch
    {
        "collector_center_data" => "service/collector-center/data",
        "collector_center_runtime" => "service/collector-center/runtime",
        _ => null
    };
    // Only a fixed stage code crosses the page bridge; never HTTP bodies,
    // URLs, cookie values, tickets or raw exception messages.
    internal static string FailureCode(string stage, int? httpStatus = null) => httpStatus switch
    {
        401 => "AUTH_REQUIRED",
        403 => "PERMISSION_DENIED",
        _ => stage is "SESSION_CHECK_FAILED" or "PERMISSION_DENIED" or "UNITY_PROCESS_UNAVAILABLE"
            or "UNITY_TICKET_FAILED" or "UNITY_PIPE_UNAVAILABLE" or "UNITY_HANDSHAKE_TIMEOUT"
            or "CENTER_VIEW_UNCONFIRMED" or "DATA_HANDSHAKE_UNCONFIRMED" or "DESKTOP_CONTROL_UNCONFIRMED"
            ? stage : "SERVICE_ACTION_UNCONFIRMED"
    };
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
