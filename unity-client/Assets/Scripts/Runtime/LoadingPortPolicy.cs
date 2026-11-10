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
        public static bool TryResolve(JObject metadata, JObject instance, string kind, out LoadingPortPose pose, out string reason)
        {
            pose = null; reason = "进出料口未配置";
            if (kind != "inlet" && kind != "outlet") { reason = "进出料口类型无效"; return false; }
            var ports = metadata?["loadingPorts"] as JObject;
            if (!Number(ports?["version"]) || ports.Value<double>("version") != 1 || !(ports[kind] is JObject port)) return false;
            var position = Vector(port["position"]); var direction = Vector(port["direction"]);
            if (position == null || direction == null || direction[1] != 0) { reason = "进出料口基准无效"; return false; }
            var overrides = instance?["loadingPortOverrides"] as JObject;
            if (overrides?.Property(kind) != null && overrides[kind]?.Type != JTokenType.Null)
            {
                if (!Number(overrides["version"]) || overrides.Value<double>("version") != 1 || !(overrides[kind] is JObject adjustment)) { reason = "设备进出料口校准无效"; return false; }
                var offset = Vector(adjustment["offset"]);
                if (offset == null || !Number(adjustment["yawDegrees"])) { reason = "设备进出料口校准无效"; return false; }
                for (var axis = 0; axis < 3; axis++) position[axis] += offset[axis];
                var radians = (adjustment.Value<double>("yawDegrees") % 360) * Math.PI / 180; var c = Math.Cos(radians); var s = Math.Sin(radians);
                direction = new[] { direction[0] * c + direction[2] * s, 0d, -direction[0] * s + direction[2] * c };
            }
            if (position.Any(value => double.IsNaN(value) || double.IsInfinity(value))) { reason = "进出料口位置无效"; return false; }
            var magnitude = Math.Max(Math.Abs(direction[0]), Math.Abs(direction[2]));
            if (magnitude == 0) { reason = "进出料口方向无效"; return false; }
            var x = direction[0] / magnitude; var z = direction[2] / magnitude; var length = Math.Sqrt(x * x + z * z);
            pose = new LoadingPortPose { Position = position, Direction = new[] { x / length, 0, z / length } };
            reason = "进出料口已配置"; return true;
        }
    }
}
