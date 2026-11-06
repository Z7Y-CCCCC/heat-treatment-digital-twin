using System;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public static class LoadingThemePolicy
    {
        public static bool TryResolve(JToken config, out string theme)
        {
            theme = null;
            if (config?.Type == JTokenType.String)
            {
                try { config = JObject.Parse(config.Value<string>() ?? string.Empty); }
                catch { return false; }
            }
            if (!(config is JObject document)) return false;
            if (document.TryGetValue("theme", out var selected))
            {
                if (selected.Type != JTokenType.String) return false;
                var name = selected.Value<string>();
                if (name != "light" && name != "dark") return false;
                theme = name;
                return true;
            }
            if (document["background"]?.Type != JTokenType.String) return false;
            var background = document.Value<string>("background");
            theme = string.Equals(background, "#28282b", StringComparison.OrdinalIgnoreCase)
                || string.Equals(background, "#29292c", StringComparison.OrdinalIgnoreCase) ? "dark" : "light";
            return true;
        }
    }
}
