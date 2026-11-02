using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Own the presentation materials separately from imported/shared glTF assets.
    // One clone per source material, not per renderer; devices are never modified.
    public sealed class FactoryHallPresentation : MonoBehaviour
    {
        public const float DefaultOpacity = .10f;
        private readonly Dictionary<Material, Material> _materials = new Dictionary<Material, Material>();
        public int MaterialCount => _materials.Count;

        public static bool IsFloor(Renderer renderer)
        {
            var name = renderer.name.ToLowerInvariant();
            return name.Contains("floor") || name.Contains("ground") || name.Contains("apron")
                || renderer.sharedMaterials.Any(m => m != null && m.name.ToLowerInvariant().Contains("floor"));
        }

        public static FactoryHallPresentation Apply(GameObject hall)
        {
            if (hall == null) return null;
            var owner = hall.GetComponent<FactoryHallPresentation>();
            if (owner != null) return owner;
            owner = hall.AddComponent<FactoryHallPresentation>();
            var shader = Resources.Load<Shader>("RuntimeShaders/FactoryHallGhost");
            if (shader == null) throw new InvalidOperationException("Factory hall transparency shader is missing");
            foreach (var renderer in hall.GetComponentsInChildren<Renderer>(true))
            {
                renderer.shadowCastingMode = ShadowCastingMode.Off;
                renderer.receiveShadows = IsFloor(renderer);
                if (IsFloor(renderer)) continue; // Keep the actual ground and pits readable.
                renderer.lightProbeUsage = LightProbeUsage.Off;
                renderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
                renderer.sharedMaterials = renderer.sharedMaterials.Select(source =>
                {
                    if (source == null) return null;
                    if (owner._materials.TryGetValue(source, out var cached)) return cached;
                    var material = new Material(shader) { name = source.name + " / hall ghost", hideFlags = HideFlags.DontSave,
                        enableInstancing = true, renderQueue = (int)RenderQueue.Transparent };
                    var colorKey = new[] { "baseColorFactor", "_BaseColor", "_Color" }.FirstOrDefault(source.HasProperty);
                    if (colorKey != null) material.SetColor("_BaseColor", source.GetColor(colorKey));
                    var mapKey = new[] { "baseColorTexture", "_BaseMap", "_MainTex" }.FirstOrDefault(source.HasProperty);
                    if (mapKey != null && source.GetTexture(mapKey) != null)
                    {
                        material.SetTexture("_BaseMap", source.GetTexture(mapKey));
                        material.SetTextureScale("_BaseMap", source.GetTextureScale(mapKey));
                        material.SetTextureOffset("_BaseMap", source.GetTextureOffset(mapKey));
                    }
                    material.SetFloat("_Opacity", DefaultOpacity);
                    owner._materials[source] = material;
                    return material;
                }).ToArray();
            }
            // The production picker already intersects device meshes only. Also
            // opt the environment out of legacy/physics pointer paths.
            foreach (var collider in hall.GetComponentsInChildren<Collider>(true)) collider.enabled = false;
            return owner;
        }

        private void OnDestroy()
        {
            foreach (var material in _materials.Values)
                if (material != null) { if (Application.isPlaying) Destroy(material); else DestroyImmediate(material); }
            _materials.Clear();
        }
    }
}
