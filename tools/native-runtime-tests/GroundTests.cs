using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static Task IndustrialGroundMatchesContract()
    {
        var fixtures = JArray.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "industrial-ground-fixtures.json")));
        foreach (var fixture in fixtures)
        {
            var workshop = fixture["workshop"].ToObject<WorkshopDto>();
            var devices = workshop.Devices.Concat(workshop.Lines.SelectMany(l => l.Devices)).ToList();
            var mesh = IndustrialGroundPlan.Resolve(workshop, devices).Build();
            Check(mesh.Positions.Count > 0 && mesh.Indices.Count > 0, "ground mesh must not be empty");
            foreach (var sample in (JArray)fixture["samples"])
            {
                float x = sample[0].Value<float>(), z = sample[1].Value<float>(), expected = sample[2].Value<float>();
                var found = false;
                // Each quad's first 4 vertices describe either a horizontal
                // surface or a wall. Only horizontal surfaces can cover X/Z.
                for (int i = 0; i < mesh.Positions.Count; i += 12)
                {
                    var ys = new[] { mesh.Positions[i + 1], mesh.Positions[i + 4], mesh.Positions[i + 7], mesh.Positions[i + 10] };
                    if (ys.Max() - ys.Min() > .0001f) continue;
                    var xs = new[] { mesh.Positions[i], mesh.Positions[i + 3], mesh.Positions[i + 6], mesh.Positions[i + 9] };
                    var zs = new[] { mesh.Positions[i + 2], mesh.Positions[i + 5], mesh.Positions[i + 8], mesh.Positions[i + 11] };
                    if (x >= xs.Min() && x < xs.Max() && z >= zs.Min() && z < zs.Max()) { Check(Math.Abs(ys[0] - expected) < .0001f, $"{fixture["name"]}: {x}/{z} ground height"); found = true; break; }
                }
                Check(found, "sample must lie over a floor surface");
            }
        }
        return Task.CompletedTask;
    }
}
