using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal static class DashboardAccessPolicy
{
    internal static bool HasLaunchAndViewPermission(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("authenticated", out var authenticated)
                && authenticated.ValueKind == JsonValueKind.True
                && root.TryGetProperty("permissions", out var permissions)
                && permissions.ValueKind == JsonValueKind.Object
                && permissions.TryGetProperty("launch", out var launch)
                && launch.ValueKind == JsonValueKind.True
                && permissions.TryGetProperty("view", out var view)
                && view.ValueKind == JsonValueKind.True;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
