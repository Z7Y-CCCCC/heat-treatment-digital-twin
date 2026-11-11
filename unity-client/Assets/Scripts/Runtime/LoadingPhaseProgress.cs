using System;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public readonly struct LoadingPhaseState
    {
        public readonly double Progress;
        public readonly bool Complete, Current;
        public LoadingPhaseState(double progress, bool complete, bool current)
        { Progress = progress; Complete = complete; Current = current; }
    }

    // Matches shared/loadingPhaseProgress.mjs. Time never confirms completion.
    public static class LoadingPhaseProgress
    {
        private static readonly double[] Bounds = { 0, 18, 32, 90, 100 };
        public static LoadingPhaseState State(double value, double phase, int index)
        {
            var progress = double.IsNaN(value) || double.IsInfinity(value) ? 0 : Math.Max(0, Math.Min(100, value));
            var current = double.IsNaN(phase) || double.IsInfinity(phase)
                ? (progress < 18 ? 0 : progress < 32 ? 1 : progress < 90 ? 2 : 3) : (int)Math.Max(0, Math.Min(3, Math.Truncate(phase)));
            var complete = index < current || progress >= 100;
            var fraction = complete ? 1 : index == current ? Math.Min(.99, Math.Max(0, (progress - Bounds[index]) / (Bounds[index + 1] - Bounds[index]))) : 0;
            return new LoadingPhaseState(fraction, complete, index == current && !complete);
        }
    }
}
