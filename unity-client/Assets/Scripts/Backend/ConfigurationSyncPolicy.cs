using System;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    public static class ConfigurationSyncPolicy
    {
        public static string ChangeAction(JObject payload, string currentFactoryId)
        {
            if (payload == null) return "ignore";
            var activated = payload.Value<string>("activeFactoryId");
            if (!string.IsNullOrWhiteSpace(activated))
                return string.Equals(activated, currentFactoryId, StringComparison.Ordinal) ? "ignore" : "reload";
            var factoryId = payload.Value<string>("factoryId");
            if (!string.IsNullOrWhiteSpace(factoryId) && !string.IsNullOrWhiteSpace(currentFactoryId)
                && !string.Equals(factoryId, currentFactoryId, StringComparison.Ordinal)) return "ignore";
            // Model definitions and resolved action inputs do not alter the hall,
            // hierarchy or view. Both specific and generic notifications share a
            // single authoritative, diff-based refresh in FactoryRuntime.
            var resource = payload.Value<string>("resource");
            if (resource == "models" || resource == "device-animations") return "models";
            if (payload.Value<bool?>("reloadRequired") == true) return "reload";
            if (!(payload["settings"] is JObject settings)) return "reload";
            // Environment dimensions/floors depend on the complete hierarchy.
            return settings.Property("native_environment_config") != null ? "reload" : "settings";
        }

        public static bool MatchesFactory(JObject command, string currentFactoryId)
        {
            var requested = command?.Value<string>("factoryId");
            return string.IsNullOrWhiteSpace(requested)
                || string.Equals(requested, currentFactoryId, StringComparison.Ordinal);
        }
    }
}
