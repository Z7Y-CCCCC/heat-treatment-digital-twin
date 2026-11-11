using System;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Input carries a direction and a winding count. Only authored navigation
    // takes the shortest route; a user's +240 degree drag must never become -120.
    public static class OrbitCameraMotion
    {
        // Unity supplies wheel detents, including fractional high-resolution
        // samples. Never round them or multiply by frame time: both lose input.
        public static float WheelDistance(float distance, float detents, float sensitivity, float minimum, float maximum)
        {
            if (float.IsNaN(detents) || float.IsInfinity(detents)
                || float.IsNaN(sensitivity) || float.IsInfinity(sensitivity)) return distance;
            var exponent = Math.Max(-1.5d, Math.Min(1.5d, -detents * Math.Max(0f, sensitivity)));
            return (float)Math.Max(minimum, Math.Min(maximum, distance * Math.Exp(exponent)));
        }

        public static float NearestYaw(float current, float authored)
        {
            var delta = authored - current;
            delta -= (float)(Math.Floor((delta + 180d) / 360d) * 360d);
            return current + delta;
        }

        public static void StepYaw(ref float current, ref float desired, float blend, float maximumStep = 90f)
        {
            var step = (desired - current) * Math.Max(0f, Math.Min(1f, blend));
            // A coarse/low-FPS input sample must not visually skip more than a
            // half turn in one frame. Keep the remainder; never discard winding.
            current += Math.Max(-maximumStep, Math.Min(maximumStep, step));
            // Rebase BOTH values together, keeping the pending input unchanged
            // and retaining float precision even after many full revolutions.
            var turns = (float)(Math.Floor((current + 180d) / 360d) * 360d);
            current -= turns;
            desired -= turns;
        }
    }

    // A drag remains a drag even when the pointer returns to its starting point.
    // Pixel coordinates, not the scaled HUD coordinate system, define a click.
    public sealed class PointerClickGesture
    {
        private float _x, _y;
        private readonly float _thresholdSquared;
        public bool Active { get; private set; }
        public bool Dragged { get; private set; }

        public PointerClickGesture(float thresholdPixels = 5f)
        {
            _thresholdSquared = thresholdPixels * thresholdPixels;
        }

        public void Begin(float x, float y, bool allowed)
        {
            _x = x; _y = y; Active = allowed; Dragged = false;
        }

        public void Move(float x, float y)
        {
            if (!Active) return;
            var dx = x - _x; var dy = y - _y;
            Dragged |= dx * dx + dy * dy > _thresholdSquared;
        }

        public bool End(float x, float y, bool allowed)
        {
            Move(x, y);
            var click = Active && allowed && !Dragged;
            Active = false;
            return click;
        }

        public void Cancel() { Active = false; Dragged = false; }
    }
}
