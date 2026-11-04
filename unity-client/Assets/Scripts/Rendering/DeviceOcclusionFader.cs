using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Camera -> selected equipment visibility. Exact mesh intersections, not
    // physics colliders or a single ray at the (possibly above-ground) centre.
    // Materials are presentation-only clones; PLC blocks and shared PBR assets
    // are never rewritten. The selected device is never a fading candidate.
    public sealed class DeviceOcclusionFader : IDisposable
    {
        private sealed class Surface
        {
            public Renderer Renderer;
            public InspectionMeshSurface Geometry;
            public Material[] Original, Ghost;
            public ShadowCastingMode Shadow;
            public bool ReceiveShadows, Applied;
            public float Amount;
            public double LastBlocked = double.NegativeInfinity;
        }
        private readonly Dictionary<Renderer, Surface> _surfaces = new Dictionary<Renderer, Surface>();
        private readonly List<Renderer> _removed = new List<Renderer>();
        private readonly HashSet<Renderer> _seen = new HashSet<Renderer>();
        private readonly List<Renderer> _targets = new List<Renderer>();
        private readonly Vector3[] _samples = new Vector3[27];
        private Camera _camera;
        private Transform _target, _scene;
        private double _nextScan, _nextCheck;
        private Shader _shader;
        public int FadedCount { get; private set; }
        public int CandidateCount => _surfaces.Count;
        public int OwnedMaterialCount { get; private set; }
        public const float OccluderOpacity = .025f;

        public void SetFocus(Camera camera, Transform target, Transform scene)
        {
            if (_camera == camera && _target == target && _scene == scene) return;
            Clear(); _camera = camera; _target = target; _scene = scene;
            if (target != null) _targets.AddRange(target.GetComponentsInChildren<Renderer>(true));
            _nextScan = _nextCheck = double.NegativeInfinity;
        }

        public void Tick(double now, float delta)
        {
            if (_camera == null || _target == null || _scene == null || !_target.gameObject.activeInHierarchy) { Clear(); return; }
            if (now >= _nextScan) { Scan(); _nextScan = now + .75; }
            if (now >= _nextCheck) { Detect(now); _nextCheck = now + .08; }
            FadedCount = 0;
            foreach (var surface in _surfaces.Values)
            {
                if (surface.Renderer == null) continue;
                var blocked = now - surface.LastBlocked <= .18;
                surface.Amount = Mathf.MoveTowards(surface.Amount, blocked ? 1 : 0, Mathf.Max(0, delta) / .12f);
                if (surface.Amount > .001f)
                {
                    Apply(surface); if (!surface.Applied) continue; FadedCount++;
                    for (var i = 0; i < surface.Ghost.Length; i++)
                    {
                        var ghost = surface.Ghost[i]; if (ghost == null) continue;
                        var source = surface.Original[i];
                        var alpha = source != null && source.HasProperty("_Opacity") ? source.GetFloat("_Opacity") : 1f;
                        ghost.SetFloat("_Opacity", Mathf.Lerp(alpha, Mathf.Min(alpha, OccluderOpacity), surface.Amount));
                    }
                }
                else Restore(surface);
            }
        }

        private void Scan()
        {
            _seen.Clear();
            foreach (var renderer in _scene.GetComponentsInChildren<Renderer>(true))
            {
                if (renderer == null || renderer.transform.IsChildOf(_target)
                    || !(renderer is MeshRenderer || renderer is SkinnedMeshRenderer)) continue;
                if (renderer is MeshRenderer && renderer.GetComponent<MeshFilter>()?.sharedMesh == null) continue;
                _seen.Add(renderer);
                if (!_surfaces.ContainsKey(renderer)) _surfaces.Add(renderer, new Surface { Renderer = renderer, Geometry = new InspectionMeshSurface(renderer) });
            }
            _removed.Clear(); foreach (var pair in _surfaces) if (pair.Key == null || !_seen.Contains(pair.Key)) _removed.Add(pair.Key);
            foreach (var renderer in _removed) { Release(_surfaces[renderer]); _surfaces.Remove(renderer); }
        }

        private void Detect(double now)
        {
            var found = false; var bounds = new Bounds();
            foreach (var renderer in _targets)
            {
                if (!Visible(renderer)) continue;
                if (!found) { bounds = renderer.bounds; found = true; } else bounds.Encapsulate(renderer.bounds);
            }
            if (!found) return;
            var extent = bounds.extents * .88f; var index = 0;
            for (var x = -1; x <= 1; x++) for (var y = -1; y <= 1; y++) for (var z = -1; z <= 1; z++)
                _samples[index++] = bounds.center + Vector3.Scale(extent, new Vector3(x, y, z));
            var origin = _camera.transform.position;
            foreach (var surface in _surfaces.Values)
            {
                if (!Visible(surface.Renderer)) continue;
                for (var i = 0; i < _samples.Length; i++)
                {
                    var direction = _samples[i] - origin; var distance = direction.magnitude;
                    if (distance < _camera.nearClipPlane || Vector3.Dot(direction, _camera.transform.forward) <= 0) continue;
                    var ray = new Ray(origin, direction / distance);
                    if (!surface.Renderer.bounds.IntersectRay(ray, out var entry) || entry >= distance - .015f) continue;
                    // Imported non-readable meshes cannot supply CPU triangles.
                    // Conservatively fade their obstruction volume (never use
                    // this approximation for selecting equipment or parts).
                    if (surface.Geometry.Geometry != null && !surface.Geometry.Geometry.isReadable)
                    { surface.LastBlocked = now; break; }
                    // Tests both sides, so the camera may be inside a pit or wall.
                    // Empty pit apertures inside one combined floor AABB do not hit.
                    if (surface.Geometry.Raycast(ray, out _, null, distance - .015f)) { surface.LastBlocked = now; break; }
                }
            }
        }

        private bool Visible(Renderer renderer) => renderer != null && renderer.enabled && !renderer.forceRenderingOff
            && renderer.gameObject.activeInHierarchy && (_camera.cullingMask & 1 << renderer.gameObject.layer) != 0;

        private void Apply(Surface surface)
        {
            if (surface.Applied) return;
            _shader = _shader != null ? _shader : Resources.Load<Shader>("RuntimeShaders/FactoryHallGhost");
            if (_shader == null) return;
            surface.Original = surface.Renderer.sharedMaterials;
            surface.Shadow = surface.Renderer.shadowCastingMode; surface.ReceiveShadows = surface.Renderer.receiveShadows;
            surface.Ghost = new Material[surface.Original.Length];
            for (var i = 0; i < surface.Original.Length; i++)
            {
                var source = surface.Original[i]; if (source == null) continue;
                var material = new Material(_shader) { name = source.name + " / camera occluder", hideFlags = HideFlags.DontSave, renderQueue = (int)RenderQueue.Transparent, enableInstancing = true };
                foreach (var key in new[] { "baseColorFactor", "_BaseColor", "_Color" }) if (source.HasProperty(key)) { material.SetColor("_BaseColor", source.GetColor(key)); break; }
                foreach (var key in new[] { "baseColorTexture", "_BaseMap", "_MainTex" }) if (source.HasProperty(key) && source.GetTexture(key) != null)
                { material.SetTexture("_BaseMap", source.GetTexture(key)); material.SetTextureScale("_BaseMap", source.GetTextureScale(key)); material.SetTextureOffset("_BaseMap", source.GetTextureOffset(key)); break; }
                surface.Ghost[i] = material; OwnedMaterialCount++;
            }
            surface.Renderer.sharedMaterials = surface.Ghost;
            surface.Renderer.shadowCastingMode = ShadowCastingMode.Off; surface.Renderer.receiveShadows = false;
            surface.Applied = true;
        }

        private void Restore(Surface surface)
        {
            if (!surface.Applied) return;
            if (surface.Renderer != null) { surface.Renderer.sharedMaterials = surface.Original; surface.Renderer.shadowCastingMode = surface.Shadow; surface.Renderer.receiveShadows = surface.ReceiveShadows; }
            foreach (var material in surface.Ghost) if (material != null)
            {
                if (Application.isPlaying) UnityEngine.Object.Destroy(material); else UnityEngine.Object.DestroyImmediate(material);
                OwnedMaterialCount--;
            }
            surface.Ghost = surface.Original = null; surface.Applied = false;
        }
        private void Release(Surface surface) { Restore(surface); surface.Geometry.Dispose(); }
        public void Clear()
        {
            foreach (var surface in _surfaces.Values) Release(surface);
            _surfaces.Clear(); _targets.Clear(); _seen.Clear(); _removed.Clear(); FadedCount = 0;
            _target = null; _scene = null; _camera = null;
        }
        public void Dispose() => Clear();
    }
}
