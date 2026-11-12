using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    // Geometry/resources and action JSON have separate lifetimes. Presentation
    // labels, inspection cameras, point mappings and JSON key order are not GLBs.
    public static class ModelCacheIdentity
    {
        public static bool UsesMotion(ModelAssetDto asset, DeviceDto device)
        {
            if (asset?.MotionPackage == null || !(device?.InstanceConfigObject["animationBindings"] is JObject config)) return false;
            return config["bindings"]?.OfType<JObject>().Any(binding => binding.Value<bool?>("enabled") == true && binding.Value<string>("kind") == "clip") == true
                || config["transferLink"]?["cycle"]?.Value<bool?>("enabled") == true;
        }
        public static JToken Canonical(JToken value)
        {
            if (value is JObject obj) return new JObject(obj.Properties().OrderBy(p => p.Name, StringComparer.Ordinal)
                .Select(p => new JProperty(p.Name, Canonical(p.Value))));
            if (value is JArray array) return new JArray(array.Select(Canonical));
            return value?.DeepClone() ?? JValue.CreateNull();
        }
        public static string GeometryKey(ModelAssetDto asset, string modelType, bool useMotion, bool preserveAllNodes, IEnumerable<string> protectedNodes)
        {
            if (asset == null) return "fallback:" + modelType;
            var value = new JObject {
                ["id"] = asset.Id, ["file"] = useMotion ? asset.MotionPackage?.Value<string>("rigPath") : asset.FilePath,
                ["sourceSha"] = (asset.MetadataObject["sourceAsset"] as JObject)?["sha256"] ?? asset.MotionPackage?["sourceSha256"],
                ["packageSourceSha"] = asset.MotionPackage?["sourceSha256"],
                ["rigSha"] = useMotion ? asset.MotionPackage?["rigSha256"] : null,
                ["motion"] = useMotion, ["preserveAll"] = preserveAllNodes,
                ["optimization"] = asset.MetadataObject["optimization"],
                ["protectedNodes"] = preserveAllNodes ? null : new JArray((protectedNodes ?? Enumerable.Empty<string>()).Distinct().OrderBy(name => name, StringComparer.Ordinal))
            };
            return Canonical(value).ToString(Formatting.None);
        }
        public static JToken RenderDefinition(ModelAssetDto asset)
        {
            if (asset == null) return null;
            var metadata = asset.MetadataObject;
            return new JObject {
                ["id"] = asset.Id, ["file"] = asset.FilePath, ["scale"] = asset.DefaultScale,
                ["parts"] = metadata["partBindings"], ["inspection"] = metadata["inspection"],
                ["optimization"] = metadata["optimization"], ["runtime"] = metadata["runtime"],
                ["sourceSha"] = (metadata["sourceAsset"] as JObject)?["sha256"], ["packageSourceSha"] = asset.MotionPackage?["sourceSha256"], ["motion"] = asset.MotionPackage
            };
        }
        public static JToken DeviceRenderDefinition(ModelAssetDto asset, DeviceDto device)
        {
            var value = RenderDefinition(asset) as JObject;
            if (value != null && !UsesMotion(asset, device)) value.Remove("motion");
            return value;
        }
    }
}
