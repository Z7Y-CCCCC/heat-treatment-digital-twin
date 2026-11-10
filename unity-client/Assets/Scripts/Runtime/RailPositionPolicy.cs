using System;
using System.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public static class RailPositionPolicy
    {
        // In station mode start/end define an axis, not a clamp to two hidden
        // legacy positions. Explicit stations may extend beyond those samples.
        public static double[] ProjectStation(double[] source, double[] start, double[] end)
        {
            bool Valid(double[] values) => values?.Length == 3 && values.All(value => !double.IsNaN(value) && !double.IsInfinity(value));
            if (!Valid(source) || !Valid(start) || !Valid(end)) return null;
            var dx = end[0] - start[0]; var dz = end[2] - start[2]; var scale = Math.Max(Math.Abs(dx), Math.Abs(dz));
            // A degenerate/missing horizontal axis cannot establish a dock.
            // Never fabricate a station at the configured start position.
            if (scale <= 0 || double.IsNaN(scale) || double.IsInfinity(scale)) return null;
            var x = dx / scale; var z = dz / scale;
            var along = ((source[0] - start[0]) * x + (source[2] - start[2]) * z) / (x * x + z * z);
            var projected = new[] { start[0] + x * along, start[1], start[2] + z * along };
            return Valid(projected) ? projected : null;
        }
    }
}
