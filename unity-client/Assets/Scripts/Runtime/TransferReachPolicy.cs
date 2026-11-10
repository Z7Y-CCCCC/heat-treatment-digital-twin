using System;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class TransferReachResult
    {
        public bool Usable;
        public string Reason;
        public double Distance, MaximumTravel, HeightError, LateralError, AngleErrorDegrees;
    }
    // Pure metre-space predicate, used on real already-rendered transforms.
    // It never relocates a cart, stretches a mechanism or declares arrival.
    public static class TransferReachPolicy
    {
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static bool Vector(double[] value) => value?.Length == 3 && Finite(value[0]) && Finite(value[1]) && Finite(value[2]);
        private static bool Unit(double[] value, out double x, out double y, out double z)
        {
            x = y = z = 0;
            var scale = Math.Max(Math.Abs(value[0]), Math.Max(Math.Abs(value[1]), Math.Abs(value[2])));
            if (scale <= 0 || !Finite(scale)) return false;
            x = value[0] / scale; y = value[1] / scale; z = value[2] / scale;
            var length = Math.Sqrt(x * x + y * y + z * z);
            x /= length; y /= length; z /= length; return true;
        }
        private static double Angle(double cosine) => Math.Acos(Math.Max(-1, Math.Min(1, cosine))) * 180 / Math.PI;
        public static TransferReachResult Evaluate(double[] source, double[] sourceDirection, double[] target, double[] targetDirection,
            double[] maximumDriveDisplacement, double heightTolerance, double lateralTolerance, double angleTolerance)
        {
            return EvaluateInto(new TransferReachResult(), source, sourceDirection, target, targetDirection,
                maximumDriveDisplacement, heightTolerance, lateralTolerance, angleTolerance);
        }
        // A configured live link supplies reusable metre-space buffers/result.
        // Same physical predicate as Evaluate, without frame-by-frame arrays or
        // LINQ allocations that can introduce avoidable render GC stalls.
        public static TransferReachResult EvaluateInto(TransferReachResult result, double[] source, double[] sourceDirection, double[] target, double[] targetDirection,
            double[] maximumDriveDisplacement, double heightTolerance, double lateralTolerance, double angleTolerance)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            result.Usable = false; result.Reason = "进出料口或送料行程配置无效";
            result.Distance = result.MaximumTravel = result.HeightError = result.LateralError = result.AngleErrorDegrees = 0;
            if (!Vector(source) || !Vector(target) || !Vector(sourceDirection) || !Vector(targetDirection) || !Vector(maximumDriveDisplacement)
                || !Finite(heightTolerance) || heightTolerance < 0 || !Finite(lateralTolerance) || lateralTolerance < 0
                || !Finite(angleTolerance) || angleTolerance < 0 || angleTolerance > 90) return result;
            if (!Unit(sourceDirection, out var ox, out var oy, out var oz) || !Unit(targetDirection, out var ix, out var iy, out var iz)
                || !Unit(maximumDriveDisplacement, out var dx, out var dy, out var dz)) return result;
            var deltaX = target[0] - source[0]; var deltaY = target[1] - source[1]; var deltaZ = target[2] - source[2];
            if (!Finite(deltaX) || !Finite(deltaY) || !Finite(deltaZ)) return result;
            result.Distance = deltaX * ox + deltaY * oy + deltaZ * oz;
            result.MaximumTravel = maximumDriveDisplacement[0] * ox + maximumDriveDisplacement[1] * oy + maximumDriveDisplacement[2] * oz;
            result.HeightError = Math.Abs(deltaY);
            var x = deltaX - ox * result.Distance; var z = deltaZ - oz * result.Distance;
            result.LateralError = Math.Sqrt(x * x + z * z);
            result.AngleErrorDegrees = Math.Max(Angle(-(ox * ix + oy * iy + oz * iz)), Angle(ox * dx + oy * dy + oz * dz));
            if (!Finite(result.Distance) || !Finite(result.MaximumTravel) || !Finite(result.LateralError) || !Finite(result.AngleErrorDegrees)) return result;
            if (Math.Abs(oy) > .0001 || Math.Abs(iy) > .0001 || Math.Abs(dy) > .0001)
                result.Reason = "送料方向不是水平直线";
            else if (result.Distance < -.0001 || result.MaximumTravel <= 0) result.Reason = "目标设备在送料方向后方";
            else if (result.Distance > result.MaximumTravel + .0001) result.Reason = "设备距离超过真实送料行程";
            else if (result.HeightError > heightTolerance + .000001) result.Reason = "料车与设备送料高度不一致";
            else if (result.LateralError > lateralTolerance + .000001) result.Reason = "料车与设备存在侧向偏差";
            else if (result.AngleErrorDegrees > angleTolerance + .00001) result.Reason = "进出料口或送料机构方向不相对";
            else { result.Usable = true; result.Reason = "送料位置可达"; }
            return result;
        }
    }
}
