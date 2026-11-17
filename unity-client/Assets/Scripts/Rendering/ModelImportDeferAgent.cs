using System;
using System.Diagnostics;
using System.Threading.Tasks;
using GLTFast;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Budget actual import work after each continuation, not time since Unity's
    // Update began. The default frame-start budget can already be exhausted by
    // WebView/window work before a glTF continuation gets its first instruction.
    // Still yield every 8 ms: never use uninterrupted import or change quality.
    public sealed class ModelImportDeferAgent : IDeferAgent
    {
        private readonly Func<double> _clock;
        private readonly Func<Task> _yield;
        private readonly double _budgetSeconds;
        private double _sliceStarted;

        public ModelImportDeferAgent(double budgetSeconds = 0.008,
            Func<double> clock = null, Func<Task> yield = null)
        {
            if (double.IsNaN(budgetSeconds) || double.IsInfinity(budgetSeconds)
                || budgetSeconds <= 0 || budgetSeconds > 0.016) throw new ArgumentOutOfRangeException(nameof(budgetSeconds));
            _budgetSeconds = budgetSeconds;
            _clock = clock ?? (() => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency);
            _yield = yield ?? YieldFrame;
            _sliceStarted = _clock();
        }

        public bool ShouldDefer() => ShouldDefer(0);
        public bool ShouldDefer(float duration) => float.IsNaN(duration) || float.IsInfinity(duration)
            || _clock() - _sliceStarted + Math.Max(0, duration) >= _budgetSeconds;
        public Task BreakPoint() => BreakPoint(0);
        public async Task BreakPoint(float duration)
        {
            if (!ShouldDefer(duration)) return;
            await _yield();
            _sliceStarted = _clock();
        }
        private static async Task YieldFrame() { await Task.Yield(); }
    }
}
