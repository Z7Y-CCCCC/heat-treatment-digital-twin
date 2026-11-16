using System;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class LoadingPortPose { public double[] Position, Direction; }
    public static class LoadingPortPolicy
    {
        private static bool Number(JToken token) => (token?.Type == JTokenType.Integer || token?.Type == JTokenType.Float)
            && !double.IsNaN(token.Value<double>()) && !double.IsInfinity(token.Value<double>());
        private static double[] Vector(JToken token) => token is JArray array && array.Count == 3 && array.All(Number) ? array.Values<double>().ToArray() : null;
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static double Length(double[] vector)
        {
            var scale = vector.Max(value => Math.Abs(value));
            if (scale == 0) return 0;
            return scale * Math.Sqrt(vector.Sum(value => (value / scale) * (value / scale)));
        }
        private static double[] Horizontal(double[] direction)
        {
            var magnitude = Math.Max(Math.Abs(direction[0]), Math.Abs(direction[2]));
            if (magnitude == 0 || !Finite(magnitude)) return null;
            var x = direction[0] / magnitude; var z = direction[2] / magnitude; var length = Math.Sqrt(x * x + z * z);
            return new[] { x / length, 0d, z / length };
        }
        private static double[] Minus(double[] a, double[] b) => a.Select((value, axis) => value - b[axis]).ToArray();
        private static double Dot(double[] a, double[] b) => a.Select((value, axis) => value * b[axis]).Sum();

        // A saved rectangle is an absolute glTF root-local measurement. Validate
        // the same real vertical rectangle contract as shared/loadingPorts.mjs;
        // do not turn malformed corners into a made-up transfer point.
        private static bool TryRegion(JToken token, out double[] datum, out double[] direction, out double scale)
        {
            datum = null; direction = null; scale = 1;
            if (!(token is JObject region) || region.Properties().Any(property => !new[] { "version", "corners", "surfaceNormal", "nodeName" }.Contains(property.Name))
                || !Number(region["version"]) || region.Value<double>("version") != 1
                || !(region["corners"] is JArray points) || points.Count != 4) return false;
            if (region.Property("nodeName") != null && (region["nodeName"].Type != JTokenType.String
                || region.Value<string>("nodeName").Length > 512 || region.Value<string>("nodeName").Any(value => value < 32 || value == 127))) return false;
            var corners = points.Select(Vector).ToArray(); var normal = Vector(region["surfaceNormal"]);
            if (corners.Any(corner => corner == null) || normal == null) return false;
            var magnitude = Length(normal);
            if (!Finite(magnitude) || magnitude < 1e-12) return false;
            normal = normal.Select(value => value / magnitude).ToArray();
            if (Math.Abs(normal[1]) > .25) return false;
            var bottom = Minus(corners[1], corners[0]); var side = Minus(corners[3], corners[0]);
            var top = Minus(corners[2], corners[3]); var right = Minus(corners[2], corners[1]);
            var width = Length(bottom); var height = Length(side); var tolerance = Math.Max(1, Math.Max(width, height)) * 1e-6;
            var bottomSide = Dot(bottom, side); var bottomNormal = Dot(bottom, normal); var sideNormal = Dot(side, normal);
            if (!new[] { width, height, bottomSide, bottomNormal, sideNormal }.Concat(top).Concat(right).All(Finite)
                || width <= 1e-9 || height <= 1e-9 || Math.Abs(bottom[1]) > tolerance || side[1] <= tolerance
                || Math.Abs(bottomSide) > width * height * 1e-5 || Math.Abs(bottomNormal) > tolerance || Math.Abs(sideNormal) > tolerance
                || top.Where((value, axis) => Math.Abs(value - bottom[axis]) > tolerance).Any()
                || right.Where((value, axis) => Math.Abs(value - side[axis]) > tolerance).Any()) return false;
            datum = corners[0].Select((value, axis) => (value + corners[1][axis]) / 2).ToArray();
            direction = Horizontal(normal);
            scale = Math.Max(1, corners.SelectMany(corner => corner).Max(value => Math.Abs(value)));
            return datum.All(Finite) && direction != null;
        }
        public static bool TryResolve(JObject metadata, JObject instance, string kind, out LoadingPortPose pose, out string reason)
        {
            pose = null; reason = "进出料口未配置";
            if (kind != "inlet" && kind != "outlet") { reason = "进出料口类型无效"; return false; }
            var ports = metadata?["loadingPorts"] as JObject;
            if (!Number(ports?["version"]) || ports.Value<double>("version") != 1 || !(ports[kind] is JObject port)) return false;
            var position = Vector(port["position"]); var direction = Vector(port["direction"]);
            if (position == null || direction == null || direction[1] != 0) { reason = "进出料口基准无效"; return false; }
            direction = Horizontal(direction);
            if (direction == null) { reason = "进出料口方向无效"; return false; }
            var modelRegion = port.Property("region") != null;
            if (modelRegion)
            {
                if (!TryRegion(port["region"], out var datum, out var outward, out var scale)
                    || position.Where((value, axis) => Math.Abs(value - datum[axis]) > scale * 1e-6).Any()
                    || Dot(direction, outward) < .9999) { reason = "型号进出料口区域无效"; return false; }
                // Even a scalar value within the validation tolerance is not a
                // second geometry source: the selected corners/normal are exact.
                position = datum; direction = outward;
            }
            var overrides = instance?["loadingPortOverrides"] as JObject;
            JObject adjustment = null; double[] offset = null;
            if (overrides?.Property(kind) != null && overrides[kind]?.Type != JTokenType.Null)
            {
                if (!Number(overrides["version"]) || overrides.Value<double>("version") != 1 || !(overrides[kind] is JObject candidate)) { reason = "设备进出料口校准无效"; return false; }
                adjustment = candidate;
                offset = Vector(adjustment["offset"]);
                if (offset == null || !Number(adjustment["yawDegrees"])) { reason = "设备进出料口校准无效"; return false; }
            }
            if (adjustment?.Property("region") != null)
            {
                // The saved device rectangle itself is the actual geometry,
                // independent of its historical offset/yaw or later model edits.
                if (!TryRegion(adjustment["region"], out position, out direction, out _)) { reason = "设备进出料口区域无效"; return false; }
            }
            else if (!modelRegion && adjustment != null)
            {
                // Relative point calibration survives only for point-only legacy
                // documents. A model rectangle is never shifted or flipped by it.
                for (var axis = 0; axis < 3; axis++) position[axis] += offset[axis];
                var radians = (adjustment.Value<double>("yawDegrees") % 360) * Math.PI / 180; var c = Math.Cos(radians); var s = Math.Sin(radians);
                direction = new[] { direction[0] * c + direction[2] * s, 0d, -direction[0] * s + direction[2] * c };
            }
            if (position.Any(value => double.IsNaN(value) || double.IsInfinity(value))) { reason = "进出料口位置无效"; return false; }
            direction = Horizontal(direction);
            if (direction == null) { reason = "进出料口方向无效"; return false; }
            pose = new LoadingPortPose { Position = position, Direction = direction };
            reason = "进出料口已配置"; return true;
        }
    }
}
