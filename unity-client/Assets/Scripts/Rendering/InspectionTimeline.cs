using System;
using HeatTreatment.DigitalTwin.Backend;

namespace HeatTreatment.DigitalTwin.Rendering
{
    /// <summary>
    /// A single absolute clock drives both directions. Reversing, scrubbing or
    /// pausing never captures a new transform and cannot accumulate drift.
    /// Kept independent of Unity so the contract can be regression tested.
    /// </summary>
    public static class InspectionTimeline
    {
        public static float PartStart(DeviceInspectionConfigDto config, DeviceInspectionPartDto part, int enabledIndex)
            => config.ShellDuration + enabledIndex * config.Stagger + part.Delay;

        public static float PartDuration(DeviceInspectionConfigDto config, DeviceInspectionPartDto part)
            => Math.Max(.05f, part.Duration > 0f ? part.Duration : config.AnimationDuration);

        public static float Duration(DeviceInspectionConfigDto config)
        {
            var duration = Math.Max(.05f, config.ShellDuration);
            var enabledIndex = 0;
            foreach (var part in config.Parts)
            {
                if (part == null || !part.Enabled) continue;
                duration = Math.Max(duration, PartStart(config, part, enabledIndex++) + PartDuration(config, part));
            }
            return duration;
        }

        public static float PartProgress(DeviceInspectionConfigDto config, DeviceInspectionPartDto part, int enabledIndex, float clock)
            => Ease((clock - PartStart(config, part, enabledIndex)) / PartDuration(config, part), config.Easing);

        public static float ShellProgress(DeviceInspectionConfigDto config, float clock)
            => config.ShellDuration <= 0f ? (clock > 0f ? 1f : 0f) : Ease(clock / config.ShellDuration, config.Easing);

        public static float Advance(float clock, float target, float elapsed)
        {
            if (!float.IsFinite(elapsed) || elapsed <= 0f) return clock;
            return target >= clock ? Math.Min(target, clock + elapsed) : Math.Max(target, clock - elapsed);
        }

        public static float Ease(float value, string easing)
        {
            var t = Math.Max(0f, Math.Min(1f, float.IsFinite(value) ? value : 0f));
            if (easing == "linear") return t;
            if (easing == "cubic") return t < .5f ? 4f * t * t * t : 1f - (float)Math.Pow(-2f * t + 2f, 3) * .5f;
            return t * t * (3f - 2f * t);
        }
    }
}
