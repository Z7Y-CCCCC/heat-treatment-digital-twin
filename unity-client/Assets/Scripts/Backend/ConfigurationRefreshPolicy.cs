using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    public static class ConfigurationRefreshPolicy
    {
        private static string Setting(FactoryConfigDto config, string key) => config?.Settings != null && config.Settings.TryGetValue(key, out var value) ? value : null;
        private static JToken JsonValue(string text) { try { return text == null ? null : JToken.Parse(text); } catch { return text == null ? null : new JValue(text); } }
        private static bool SameIds<T>(IEnumerable<T> before, IEnumerable<T> after, Func<T, string> id)
        {
            var a = (before ?? Enumerable.Empty<T>()).Select(id).ToArray();
            var b = (after ?? Enumerable.Empty<T>()).Select(id).ToArray();
            return a.All(value => !string.IsNullOrEmpty(value)) && b.All(value => !string.IsNullOrEmpty(value))
                && a.Distinct(StringComparer.Ordinal).Count() == a.Length && b.Distinct(StringComparer.Ordinal).Count() == b.Length
                && new HashSet<string>(a, StringComparer.Ordinal).SetEquals(b);
        }
        public static bool CanApplyInPlace(FactoryConfigDto before, FactoryConfigDto after)
        {
            if (before == null || after == null || string.IsNullOrWhiteSpace(before.FactoryId) || before.FactoryId != after.FactoryId) return false;
            if (!JToken.DeepEquals(ModelCacheIdentity.RenderDefinition(before.EnvironmentModel), ModelCacheIdentity.RenderDefinition(after.EnvironmentModel))) return false;
            if (!JToken.DeepEquals(JsonValue(Setting(before, "native_environment_config")), JsonValue(Setting(after, "native_environment_config")))) return false;
            if (!JToken.DeepEquals((before.Platform?["activeScene"] as JObject)?["id"], (after.Platform?["activeScene"] as JObject)?["id"])) return false;
            if (!SameIds(before.Workshops, after.Workshops, row => row?.Id)) return false;
            if (!SameIds(ModelHotRefreshPolicy.Devices(before), ModelHotRefreshPolicy.Devices(after), row => row?.Id)) return false;
            foreach (var workshop in before.Workshops ?? new List<WorkshopDto>())
            {
                var next = after.Workshops.First(row => row.Id == workshop.Id);
                if (!JToken.DeepEquals(workshop.LayoutObject, next.LayoutObject) || !SameIds(workshop.Lines, next.Lines, row => row?.Id)
                    || !SameDevices(workshop.Devices, next.Devices)) return false;
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    var nextLine = next.Lines.First(row => row.Id == line.Id);
                    if (!JToken.DeepEquals(line.LayoutObject, nextLine.LayoutObject) || !SameDevices(line.Devices, nextLine.Devices)) return false;
                }
            }
            return true;
        }
        private static bool SameDevices(IEnumerable<DeviceDto> before, IEnumerable<DeviceDto> after)
        {
            if (!SameIds(before, after, row => row?.Id)) return false;
            var next = (after ?? Enumerable.Empty<DeviceDto>()).ToDictionary(row => row.Id, StringComparer.Ordinal);
            return (before ?? Enumerable.Empty<DeviceDto>()).All(row => row.ModelType == next[row.Id].ModelType && row.LineId == next[row.Id].LineId);
        }
        public static bool SamePlacement(DeviceDto before, DeviceDto after) => before.PositionX == after.PositionX && before.PositionY == after.PositionY
            && before.PositionZ == after.PositionZ && before.RotationY == after.RotationY && before.Scale == after.Scale && before.CoordinateSpace == after.CoordinateSpace
            && new[] { "scaleMultiplier", "mirrorX", "mirror_x", "mirrorAxis", "mirror_axis" }.All(key => JToken.DeepEquals(before.InstanceConfigObject[key], after.InstanceConfigObject[key]));
        private static JObject DeviceValue(DeviceDto device)
        {
            var value = JObject.FromObject(device); value["instance_config"] = device.InstanceConfigObject;
            value["dataPoints"] = JArray.FromObject((device.DataPoints ?? new List<DataPointDto>()).OrderBy(point => point.Id));
            return value;
        }
        public static bool SameDevice(DeviceDto before, DeviceDto after) => JToken.DeepEquals(DeviceValue(before), DeviceValue(after));
        private static JArray ModelsValue(FactoryConfigDto config) => new JArray((config.Models ?? new List<ModelAssetDto>()).Where(model => model != null).OrderBy(model => model.Id, StringComparer.Ordinal).Select(model => {
            var value = JObject.FromObject(model); value["metadata"] = model.MetadataObject; return value;
        }));
        public static bool SameModels(FactoryConfigDto before, FactoryConfigDto after) => JToken.DeepEquals(ModelsValue(before), ModelsValue(after));
        public static JObject InstanceWithoutActionUpdate(DeviceDto before, DeviceDto after)
        {
            var config = (JObject)after.InstanceConfigObject.DeepClone();
            if (before.InstanceConfigObject.TryGetValue("animationBindings", out var bindings)) config["animationBindings"] = bindings.DeepClone();
            else config.Remove("animationBindings");
            return config;
        }
        public static bool ActionUpdateRequired(FactoryConfigDto before, FactoryConfigDto after)
        {
            if (!SameModels(before, after)) return true;
            var previous = ModelHotRefreshPolicy.Devices(before).ToDictionary(row => row.Id, StringComparer.Ordinal);
            return ModelHotRefreshPolicy.Devices(after).Any(row => !previous.TryGetValue(row.Id, out var prior)
                || !JToken.DeepEquals(prior.InstanceConfigObject["animationBindings"], row.InstanceConfigObject["animationBindings"])
                || (prior.InstanceConfigObject["animationBindings"]?["transferLink"]?["cycle"]?.Value<bool?>("enabled") == true
                    && HasLoadingSignals(prior) != HasLoadingSignals(row)));
        }
        private static bool HasLoadingSignals(DeviceDto device) => device.InstanceConfigObject["cartTransfer"]?["kind"]?.Value<string>() == "rotating"
            || device.InstanceConfigObject["loadingPortSignals"] is JObject signals
                && signals.Value<int?>("version") == 1 && new[] { "inletPointId", "outletPointId" }.Any(key => signals[key]?.Type == JTokenType.String && !string.IsNullOrWhiteSpace(signals.Value<string>(key)));
    }
}
