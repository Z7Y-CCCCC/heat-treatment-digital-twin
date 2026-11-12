using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    /// <summary>Refresh only model/action definitions; never import layout from a model event.</summary>
    public static class ModelHotRefreshPolicy
    {
        public static float ScaleRatio(ModelAssetDto before, ModelAssetDto after)
        {
            var oldScale = before?.DefaultScale ?? 1f; var newScale = after?.DefaultScale ?? 1f;
            if (!float.IsFinite(oldScale) || oldScale <= 0) oldScale = 1f;
            if (!float.IsFinite(newScale) || newScale <= 0) newScale = 1f;
            return newScale / oldScale;
        }
        public static IEnumerable<DeviceDto> Devices(FactoryConfigDto config) =>
            (config?.Workshops ?? new List<WorkshopDto>()).SelectMany(workshop =>
                (workshop.Devices ?? new List<DeviceDto>()).Concat(
                    (workshop.Lines ?? new List<LineDto>()).SelectMany(line => line.Devices ?? new List<DeviceDto>())));

        private static JToken ModelSignature(ModelAssetDto model) => ModelCacheIdentity.RenderDefinition(model);

        public static FactoryConfigDto Merge(FactoryConfigDto current, FactoryConfigDto latest, out HashSet<string> affected)
        {
            affected = new HashSet<string>(StringComparer.Ordinal);
            if (current == null || latest == null || !string.Equals(current.FactoryId, latest.FactoryId, StringComparison.Ordinal)) return null;
            var merged = JsonConvert.DeserializeObject<FactoryConfigDto>(JsonConvert.SerializeObject(current));
            var previousModels = (current.Models ?? new List<ModelAssetDto>()).ToDictionary(model => model.Id);
            var nextModels = (latest.Models ?? new List<ModelAssetDto>()).ToDictionary(model => model.Id);
            var changedModels = new HashSet<string>(previousModels.Keys.Concat(nextModels.Keys).Where(id => {
                previousModels.TryGetValue(id, out var before); nextModels.TryGetValue(id, out var after);
                return !JToken.DeepEquals(ModelSignature(before), ModelSignature(after));
            }), StringComparer.Ordinal);
            merged.Models = JsonConvert.DeserializeObject<List<ModelAssetDto>>(JsonConvert.SerializeObject(latest.Models)) ?? new List<ModelAssetDto>();
            var nextDevices = Devices(latest).Where(device => device != null && !string.IsNullOrEmpty(device.Id)).ToDictionary(device => device.Id);
            foreach (var device in Devices(merged))
            {
                if (device == null || string.IsNullOrEmpty(device.Id)) continue;
                if (changedModels.Contains(device.ModelType ?? string.Empty))
                {
                    previousModels.TryGetValue(device.ModelType ?? string.Empty, out var beforeAsset);
                    nextModels.TryGetValue(device.ModelType ?? string.Empty, out var afterAsset);
                    if (!JToken.DeepEquals(ModelCacheIdentity.DeviceRenderDefinition(beforeAsset, device), ModelCacheIdentity.DeviceRenderDefinition(afterAsset, device))) affected.Add(device.Id);
                }
                if (!nextDevices.TryGetValue(device.Id, out var next) || next.ModelType != device.ModelType) continue;
                var config = device.InstanceConfigObject;
                var before = config["animationBindings"]; var after = next.InstanceConfigObject["animationBindings"];
                if (JToken.DeepEquals(before, after)) continue;
                if (after == null) config.Remove("animationBindings"); else config["animationBindings"] = after.DeepClone();
                device.InstanceConfig = config; affected.Add(device.Id);
            }
            return merged;
        }
    }
}
