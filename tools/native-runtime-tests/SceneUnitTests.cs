using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static Task SceneUnitsRespectDeclaredLineCalibration()
    {
        void Valid(JObject movement, JObject line, float expected)
        {
            if (!SceneUnitPolicy.TryResolve(movement, line, out var units, out var reason) || units != expected || reason != null)
                throw new Exception("Valid scene calibration was rejected or silently replaced: " + reason);
        }
        void Invalid(JObject movement, JObject line)
        {
            if (SceneUnitPolicy.TryResolve(movement, line, out var units, out var reason) || !float.IsNaN(units) || string.IsNullOrEmpty(reason))
                throw new Exception("Invalid scene calibration manufactured a default or usable scale.");
        }
        Valid(null, null, 1);
        Valid(new JObject(), new JObject(), 1);
        foreach (var units in new[] { .8, 1.25, 2d })
        {
            var line = new JObject { ["sceneUnitsPerMeter"] = units };
            var movement = new JObject { ["sceneUnitsPerMeter"] = units };
            var baseline = line.ToString();
            Valid(null, line, (float)units); Valid(new JObject(), line, (float)units);
            Valid(movement, line, (float)units);
            Valid(movement, null, (float)units); // Existing layouts are not migrated on read.
            Valid(new JObject { ["scene_units_per_meter"] = units }, line, (float)units);
            Valid(new JObject { ["sceneUnitsPerMeter"] = units.ToString(System.Globalization.CultureInfo.InvariantCulture) }, line, (float)units);
            if (line.ToString() != baseline || movement.Properties().Count() != 1) throw new Exception("Inheritance wrote into authored calibration.");
            Invalid(new JObject { ["sceneUnitsPerMeter"] = units + 1 }, line);
        }
        Valid(JObject.Parse("{sceneUnitsPerMeter:1.25,scene_units_per_meter:2}"), JObject.Parse("{sceneUnitsPerMeter:1.25}"), 1.25f);
        Valid(new JObject { ["sceneUnitsPerMeter"] = "\u00a0\ufeff+1.25e0\ufeff\u00a0" }, null, 1.25f);
        foreach (var bad in new JToken[] { JValue.CreateNull(), new JValue(false), new JValue(true), new JValue(""), new JValue(" "),
            new JValue("bad"), new JValue("0x10"), new JValue("0b10"), new JValue("0o10"), new JValue("\u00851\u0085"), new JValue("1e-50"),
            new JValue("1e-320"), new JValue(1e-320), new JValue(Math.Pow(2, -150)),
            new JValue(0), new JValue(-1), new JValue(1e-50), new JValue(100001), new JValue(double.NaN), new JValue(double.PositiveInfinity), new JObject(), new JArray() })
        {
            Invalid(new JObject { ["sceneUnitsPerMeter"] = bad.DeepClone(), ["scene_units_per_meter"] = .8 }, null);
            Invalid(new JObject { ["sceneUnitsPerMeter"] = .8, ["scene_units_per_meter"] = bad.DeepClone() }, null);
            Invalid(null, new JObject { ["sceneUnitsPerMeter"] = bad.DeepClone() });
        }
        Invalid(null, new JObject { ["sceneUnitsPerMeter"] = "1.25" }); // New line fields have a strict numeric schema.
        Invalid(JObject.Parse("{sceneUnitsPerMeter:0.80000000001}"), JObject.Parse("{sceneUnitsPerMeter:0.8}"));
        return Task.CompletedTask;
    }
}
