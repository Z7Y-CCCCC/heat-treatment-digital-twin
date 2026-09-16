using System;
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
        private Vector3[] _vertices;
        private int[] _triangles;
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

        public Bounds LocalBounds => _skinned != null ? _skinned.localBounds : _filter?.sharedMesh?.bounds ?? new Bounds(Vector3.zero, Vector3.zero);

        private Mesh CurrentMesh()
        {
            if (_skinned == null) return _filter?.sharedMesh;
            if (_baked == null) _baked = new Mesh { name = "__InspectionSkinnedPick", hideFlags = HideFlags.DontSave };
            if (_bakedFrame != Time.frameCount)
            {
                _skinned.BakeMesh(_baked);
                _bakedFrame = Time.frameCount;
                _vertices = null;
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
            if (_cachedMesh != mesh || _vertices == null)
            {
                _cachedMesh = mesh;
                _vertices = mesh.vertices;
                _triangles = mesh.triangles;
            }
            // Do not normalize this direction: its parameter remains a world-ray distance,
            // including mirrored or non-unit-scaled equipment instances.
            var inverse = Renderer.localToWorldMatrix.inverse;
            var origin = inverse.MultiplyPoint3x4(ray.origin);
            var direction = inverse.MultiplyVector(ray.direction);
            for (var index = 0; index + 2 < _triangles.Length; index += 3)
            {
                var a = _vertices[_triangles[index]];
                var edge1 = _vertices[_triangles[index + 1]] - a;
                var edge2 = _vertices[_triangles[index + 2]] - a;
                var cross = Vector3.Cross(direction, edge2);
                var determinant = Vector3.Dot(edge1, cross);
                if (Mathf.Abs(determinant) < 1e-10f) continue;
                var reciprocal = 1f / determinant;
                var fromA = origin - a;
                var u = Vector3.Dot(fromA, cross) * reciprocal;
                if (u < 0f || u > 1f) continue;
                var q = Vector3.Cross(fromA, edge1);
                var v = Vector3.Dot(direction, q) * reciprocal;
                if (v < 0f || u + v > 1f) continue;
                var hit = Vector3.Dot(edge2, q) * reciprocal;
                if (hit < 0f || hit >= distance) continue;
                if (acceptWorldPoint != null && !acceptWorldPoint(ray.GetPoint(hit))) continue;
                distance = hit;
            }
            return !float.IsPositiveInfinity(distance);
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
            _vertices = null;
            _triangles = null;
        }
    }
}
