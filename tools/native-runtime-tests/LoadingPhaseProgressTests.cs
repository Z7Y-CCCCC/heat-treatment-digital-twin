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
        Check(LoadingPhaseProgress.State(62, double.NaN, 2).Progress == .48, "Native fallback phase fraction mismatch");
        Check(LoadingPhaseProgress.State(double.PositiveInfinity, 0, 0).Progress == 0, "Nonfinite progress is not completion");
        for (var index = 0; index < 4; index++) Check(LoadingPhaseProgress.State(100, 3, index).Complete, "Final phase needs a check at 100%");
        return Task.CompletedTask;
    }
}
