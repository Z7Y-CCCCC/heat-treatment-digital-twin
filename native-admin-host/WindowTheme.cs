using System.Text.Json;

namespace HeatTreatmentAdminHost;

// A cached cosmetic choice, never an extra request on the close-button path.
internal sealed record WindowTheme(bool Dark)
{
    public string Name => Dark ? "dark" : "light";
    public static WindowTheme FromName(string? name) => new(name == "dark");
    public static WindowTheme FromConfig(JsonElement config)
    {
        if (config.TryGetProperty("theme", out var theme) && theme.ValueKind == JsonValueKind.String)
            return FromName(theme.GetString());
        return new(config.TryGetProperty("background", out var background)
            && background.ValueKind == JsonValueKind.String
            && background.GetString()?.ToLowerInvariant() is "#28282b" or "#29292c");
    }
    public Color Color(int r, int g, int b)
    {
        var light = System.Drawing.Color.FromArgb(r, g, b);
        return Dark && DarkColors.TryGetValue(light.ToArgb(), out var dark) ? dark : light;
    }
    private static readonly Dictionary<int, Color> DarkColors = BuildDarkColors();
    private static Dictionary<int, Color> BuildDarkColors()
    {
        var pairs = new (int[] light, int[] dark)[] {
            ([245,247,251],[40,41,43]), ([29,41,57],[234,235,229]),
            ([72,100,145],[166,177,169]), ([102,112,133],[158,161,158]),
            ([208,219,236],[84,87,86]), ([248,250,255],[48,49,51]),
            ([240,245,255],[42,43,45]), ([37,99,235],[152,189,169]),
            ([222,231,244],[70,73,73]), ([243,247,255],[43,44,46]),
            ([226,235,252],[68,70,71]), ([255,241,240],[62,54,52]),
            ([255,255,255],[49,52,51]), ([235,242,255],[55,61,57]),
            ([242,143,137],[166,126,109]), ([222,229,240],[81,74,72]),
            ([72,129,244],[138,175,154]), ([208,222,245],[77,86,81]),
            ([255,235,232],[76,61,56]), ([232,240,255],[59,77,67]),
            ([208,70,60],[220,167,142]), ([130,147,174],[130,140,133])
        };
        return pairs.ToDictionary(pair => System.Drawing.Color.FromArgb(pair.light[0],pair.light[1],pair.light[2]).ToArgb(),
            pair => System.Drawing.Color.FromArgb(pair.dark[0],pair.dark[1],pair.dark[2]));
    }
}
