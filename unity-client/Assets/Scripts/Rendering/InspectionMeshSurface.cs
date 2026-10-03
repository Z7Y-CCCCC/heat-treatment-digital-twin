using System;
using System.Runtime.CompilerServices;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Rendering
{
    /// <summary>Exact triangle picking and an outline draw, without replacing PLC materials.</summary>
    public sealed class InspectionMeshSurface : IDisposable
    {
        public readonly Renderer Renderer;
        private readonly MeshFilter _filter;
        private readonly SkinnedMeshRenderer _skinned;
        private Mesh _baked;
        private Mesh _cachedMesh;
        private static readonly ConditionalWeakTable<Mesh, TriangleRayIndex> StaticIndexes = new ConditionalWeakTable<Mesh, TriangleRayIndex>();
        private TriangleRayIndex _index;
        private int _bakedFrame = -1;
        private bool _unreadableReported;
        private readonly MaterialPropertyBlock _outlineProperties = new MaterialPropertyBlock();

        public InspectionMeshSurface(Renderer renderer)
        {
            Renderer = renderer;
            _filter = renderer.GetComponent<MeshFilter>();
            _skinned = renderer as SkinnedMeshRenderer;
        }

        public bool IsVisible => Renderer != null && Renderer.enabled && !Renderer.forceRenderingOff && Renderer.gameObject.activeInHierarchy;
        public bool HasDynamicGeometry => _skinned != null;
        public Mesh Geometry => _skinned != null ? _skinned.sharedMesh : _filter?.sharedMesh;
        public int LastTriangleTests => _index?.LastTriangleTests ?? 0;

        public Bounds LocalBounds => _skinned != null ? _skinned.localBounds : _filter?.sharedMesh?.bounds ?? new Bounds(Vector3.zero, Vector3.zero);

        private Mesh CurrentMesh()
        {
            if (_skinned == null) return _filter?.sharedMesh;
            if (_baked == null) _baked = new Mesh { name = "__InspectionSkinnedPick", hideFlags = HideFlags.DontSave };
            if (_bakedFrame != Time.frameCount)
            {
                _skinned.BakeMesh(_baked);
                _bakedFrame = Time.frameCount;
                _index = null;
            }
            return _baked;
        }

        public bool Raycast(Ray ray, out float distance, Func<Vector3, bool> acceptWorldPoint = null)
        {
            distance = float.PositiveInfinity;
            if (!IsVisible || !Renderer.bounds.IntersectRay(ray)) return false;
            var mesh = CurrentMesh();
            if (mesh == null) return false;
            if (!mesh.isReadable)
            {
                if (!_unreadableReported)
                {
                    _unreadableReported = true;
                    Debug.LogWarning($"[Inspection] Mesh '{mesh.name}' is not CPU-readable; use its spatial label to select, or re-export with readable geometry. Bounding boxes are never substituted for geometry.");
                }
                return false;
            }
            if (_cachedMesh != mesh || _index == null)
            {
                _cachedMesh = mesh;
                // Imported static geometry is shared between instances. A weak
                // mesh key releases the acceleration data with the model cache.
                // Deforming meshes stay exact and never reuse stale geometry.
                _index = _skinned != null
                    ? new TriangleRayIndex(mesh.vertices, mesh.triangles, false)
                    : StaticIndexes.GetValue(mesh, source => new TriangleRayIndex(source.vertices, source.triangles));
            }
            // Do not normalize this direction: its parameter remains a world-ray distance,
            // including mirrored or non-unit-scaled equipment instances.
            var inverse = Renderer.localToWorldMatrix.inverse;
            var origin = inverse.MultiplyPoint3x4(ray.origin);
            var direction = inverse.MultiplyVector(ray.direction);
            return _index.Raycast(origin, direction, out distance,
                acceptWorldPoint == null ? (Func<float, bool>)null : hit => acceptWorldPoint(ray.GetPoint(hit)));
        }

        public void DrawOutline(Material material, Camera camera, Color color, float widthPixels)
        {
            if (!IsVisible || material == null || camera == null) return;
            var mesh = CurrentMesh();
            if (mesh == null) return;
            _outlineProperties.SetColor("_OutlineColor", color);
            _outlineProperties.SetFloat("_OutlineWidthPixels", widthPixels);
            for (var subMesh = 0; subMesh < mesh.subMeshCount; subMesh++)
                Graphics.DrawMesh(mesh, Renderer.localToWorldMatrix, material, Renderer.gameObject.layer,
                    camera, subMesh, _outlineProperties, ShadowCastingMode.Off, false, null, LightProbeUsage.Off);
        }

        public void Dispose()
        {
            if (_baked != null)
            {
#if UNITY_EDITOR
                if (!Application.isPlaying) UnityEngine.Object.DestroyImmediate(_baked);
                else
#endif
                UnityEngine.Object.Destroy(_baked);
            }
            _baked = null;
            _index = null;
            _cachedMesh = null;
        }
    }
}
