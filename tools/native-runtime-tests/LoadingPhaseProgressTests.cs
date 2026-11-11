using HeatTreatment.DigitalTwin.Runtime;

internal static partial class Program
{
    private static Task LoadingPhaseRingsMatch()
    {
        for (var phase = 0; phase < 4; phase++) for (var percent = 0; percent <= 200; percent++) for (var index = 0; index < 4; index++) {
            var p = percent / 2.0; var state = LoadingPhaseProgress.State(p, phase, index);
            Check(state.Complete == (index < phase || p == 100), "Ring invented phase completion");
            Check(state.Progress >= 0 && state.Progress <= (state.Complete ? 1 : .99), "Invalid ring fraction");
            Check(state.Current == (index == phase && !state.Complete), "Wrong active ring");
        }
        Check(LoadingPhaseProgress.State(72, 1, 1).Progress == .99, "Overshooting a phase must wait for confirmation");
        Check(!LoadingPhaseProgress.State(72, 1, 1).Complete, "Held phase was marked complete");
        Check(LoadingPhaseProgress.State(61, double.NaN, 2).Progress == .5, "Native fallback phase fraction mismatch");
        Check(LoadingPhaseProgress.State(32, double.NaN, 2).Current, "Equipment ring must start when model loading actually starts");
        Check(LoadingPhaseProgress.State(18, double.NaN, 1).Current, "Scene ring must start at the actual hierarchy milestone");
        Check(LoadingPhaseProgress.State(double.PositiveInfinity, 0, 0).Progress == 0, "Nonfinite progress is not completion");
        for (var index = 0; index < 4; index++) Check(LoadingPhaseProgress.State(100, 3, index).Complete, "Final phase needs a check at 100%");
        return Task.CompletedTask;
    }

    private static Task StartupCoverRequiresBothLayers()
    {
        bool Ready(string path, string body) { using var json = System.Text.Json.JsonDocument.Parse(body); return HeatTreatmentAdminHost.StartupReadiness.CanFinish("http://127.0.0.1:3001"+path,json.RootElement); }
        Check(!Ready("/overlay", "{}"), "Legacy web-only readiness removed the native cover");
        Check(!Ready("/overlay", "{\"pageReady\":true}"), "Web setup alone completed a factory startup");
        Check(!Ready("/overlay", "{\"pageReady\":true,\"nativeSceneReady\":true}"), "Missing load identity completed startup");
        Check(Ready("/overlay", "{\"pageReady\":true,\"nativeSceneReady\":true,\"loadId\":\"real-load\"}"), "Both completed layers did not finish startup");
        Check(Ready("/group", "{}"), "Map readiness acquired an unrelated Unity dependency");
        Check(Ready("/overlay?noVisibleFactory=1", "{\"pageReady\":true}"), "An explicitly empty factory surface waited for a nonexistent scene");
        Check(!Ready("/admin", "{\"pageReady\":true}"), "Unrelated page removed the loading cover");
        return Task.CompletedTask;
    }
}
