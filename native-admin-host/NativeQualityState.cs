using System.Text.Json;

namespace HeatTreatmentAdminHost;

internal sealed record NativeQualityState(string type, long revision, string profile, bool automatic,
    float renderScale, int msaa, bool enabled, bool hotkeysEnabled, bool notify, string requestId)
{
    public static bool IsProfile(string? profile) => profile is "integrated_gpu" or "balanced" or "showcase" or "auto";
    public static NativeQualityState? Parse(string message)
    {
        try
        {
            var state = JsonSerializer.Deserialize<NativeQualityState>(message);
            return state is { type: "native_quality_state", revision: > 0 }
                && IsProfile(state.profile) && state.profile != "auto"
                && float.IsFinite(state.renderScale) && state.renderScale is >= .5f and <= 2f
                && state.msaa is 2 or 4 && (state.requestId?.Length ?? 0) <= 80 ? state : null;
        }
        catch (JsonException) { return null; }
    }
}
