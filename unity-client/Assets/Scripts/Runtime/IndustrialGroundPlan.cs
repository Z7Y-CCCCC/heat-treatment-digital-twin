using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using HeatTreatment.DigitalTwin.Backend;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Pure geometry contract, mirrored by shared/industrialGround.mjs and tested
    // without a running Unity player. Coordinates are workshop-local metres.
    public sealed class IndustrialGroundPlan
    {
        public sealed class Area { public double X, Z, Width, Depth, Y; }
        public readonly List<float> Positions = new List<float>();
        public readonly List<int> Indices = new List<int>();
        public readonly List<Area> Areas = new List<Area>();
        public double Width, Depth, Elevation;
        public bool Custom;
        public int Overflow;
        private static double Number(JToken token, double fallback = 0, double min = -10000, double max = 10000)
        {
            var value = token?.Type == JTokenType.Integer || token?.Type == JTokenType.Float ? token.Value<double>() : fallback;
            return double.IsNaN(value) || double.IsInfinity(value) ? fallback : Math.Max(min, Math.Min(max, value));
        }
        private static JObject Object(JToken token)
        {
            if (token is JObject obj) return obj;
            if (token?.Type == JTokenType.String) { try { return JObject.Parse(token.Value<string>()); } catch { } }
            return new JObject();
        }
        public static IndustrialGroundPlan Resolve(WorkshopDto workshop, IReadOnlyList<DeviceDto> devices)
        {
            var layout = workshop.LayoutObject;
            var ground = Object(layout["ground"]);
            var result = new IndustrialGroundPlan { Width = Number(layout["size"]?["width"], 100, 10, 5000), Depth = Number(layout["size"]?["depth"], 80, 10, 5000), Elevation = Number(ground["elevation"], 0, -100, 100), Custom = layout["ground"] != null };
            foreach (var a in (ground["areas"] as JArray ?? new JArray()).Take(32)) result.Areas.Add(new Area {
                X = Number(a["x"]), Z = Number(a["z"]), Width = Number(a["width"], 8, .2, 5000), Depth = Number(a["depth"], 8, .2, 5000), Y = Number(a["elevation"], -2, -100, 100)
            });
            var lines = workshop.Lines ?? new List<LineDto>();
            var count = 0;
            foreach (var device in devices ?? Array.Empty<DeviceDto>())
            {
                var line = lines.FirstOrDefault(item => item.Id == device.LineId);
                var config = device.InstanceConfigObject;
                if (line == null && !(workshop.Devices ?? new List<DeviceDto>()).Any(item => item.Id == device.Id)
                    && (config.Value<string>("workshop_id") ?? config.Value<string>("workshopId")) != workshop.Id) continue;
                var setup = Object(config["ground"]);
                if (setup.Value<bool?>("enabled") != true) continue;
                result.Custom = true;
                if (++count > 64) { result.Overflow++; continue; }
                double x = device.PositionX, y = device.PositionY, z = device.PositionZ;
                double rotation = device.RotationY;
                if (Math.Abs(rotation) > Math.PI * 2 + .01) rotation *= Math.PI / 180;
                if (device.CoordinateSpace == "line_local" && line != null)
                {
                    var t = Object(line.LayoutObject["transform"]);
                    var a = Number(t["rotationY"] ?? t["rotation_y"]) * Math.PI / 180;
                    var nx = x * Math.Cos(a) - z * Math.Sin(a) + Number(t["x"]);
                    z = x * Math.Sin(a) + z * Math.Cos(a) + Number(t["z"]); x = nx; y += Number(t["y"]); rotation += a;
                }
                else if (device.CoordinateSpace != "workshop_local")
                {
                    var t = Object(layout["transform"]); var a = -Number(t["rotationY"] ?? t["rotation_y"]) * Math.PI / 180;
                    x -= Number(t["x"]); z -= Number(t["z"]); y -= Number(t["y"]);
                    var nx = x * Math.Cos(a) - z * Math.Sin(a); z = x * Math.Sin(a) + z * Math.Cos(a); x = nx; rotation += a;
                }
                if (Math.Abs(y - result.Elevation) < .001) continue;
                var scale = Math.Max(.001, Math.Min(1000, device.Scale));
                var width = Number(setup["width"], 8, .2, 500) * scale; var depth = Number(setup["depth"], 8, .2, 500) * scale; var clearance = Number(setup["clearance"], .5, 0, 20);
                var c = Math.Abs(Math.Cos(rotation)); var s = Math.Abs(Math.Sin(rotation));
                result.Areas.Add(new Area { X = x, Z = z, Y = y, Width = c * width + s * depth + 2 * clearance, Depth = s * width + c * depth + 2 * clearance });
            }
            return result;
        }
        private void Quad(double[] p, bool reverse = false)
        {
            int start = Positions.Count / 3;
            if (reverse) for (int i = 3; i >= 0; i--) for (int k = 0; k < 3; k++) Positions.Add((float)p[i * 3 + k]);
            else foreach (var value in p) Positions.Add((float)value);
            Indices.AddRange(new[] { start, start + 1, start + 2, start, start + 2, start + 3 });
        }
        public IndustrialGroundPlan Build()
        {
            Positions.Clear(); Indices.Clear();
            var regions = Areas.Select(a => new { X0 = Math.Max(-Width / 2, a.X - a.Width / 2), X1 = Math.Min(Width / 2, a.X + a.Width / 2), Z0 = Math.Max(-Depth / 2, a.Z - a.Depth / 2), Z1 = Math.Min(Depth / 2, a.Z + a.Depth / 2), a.Y }).Where(a => a.X1 > a.X0 && a.Z1 > a.Z0).ToList();
            Func<IEnumerable<double>, double[]> coordinates = values => values.Select(v => Math.Floor(v * 1e6 + .5) / 1e6).Distinct().OrderBy(v => v).ToArray();
            var xs = coordinates(new[] { -Width / 2, Width / 2 }.Concat(regions.SelectMany(r => new[] { r.X0, r.X1 })));
            var zs = coordinates(new[] { -Depth / 2, Depth / 2 }.Concat(regions.SelectMany(r => new[] { r.Z0, r.Z1 })));
            var heights = new double[zs.Length - 1, xs.Length - 1];
            for (int z = 0; z < zs.Length - 1; z++) for (int x = 0; x < xs.Length - 1; x++)
            {
                double y = Elevation, mx = (xs[x] + xs[x + 1]) / 2, mz = (zs[z] + zs[z + 1]) / 2;
                foreach (var r in regions) if (mx >= r.X0 && mx < r.X1 && mz >= r.Z0 && mz < r.Z1) y = r.Y;
                heights[z, x] = y;
                Quad(new[] { xs[x], y, zs[z], xs[x], y, zs[z + 1], xs[x + 1], y, zs[z + 1], xs[x + 1], y, zs[z] });
            }
            for (int z = 0; z < zs.Length - 1; z++) for (int x = 0; x < xs.Length - 1; x++)
            {
                var y = heights[z, x];
                if (x + 1 < xs.Length - 1 && heights[z, x + 1] != y) { var other = heights[z, x + 1]; Quad(new[] { xs[x + 1], y, zs[z], xs[x + 1], other, zs[z], xs[x + 1], other, zs[z + 1], xs[x + 1], y, zs[z + 1] }, true); }
                if (z + 1 < zs.Length - 1 && heights[z + 1, x] != y) { var other = heights[z + 1, x]; Quad(new[] { xs[x], y, zs[z + 1], xs[x + 1], y, zs[z + 1], xs[x + 1], other, zs[z + 1], xs[x], other, zs[z + 1] }, true); }
            }
            return this;
        }
    }
}
