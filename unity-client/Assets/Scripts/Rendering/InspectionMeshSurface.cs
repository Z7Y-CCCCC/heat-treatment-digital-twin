using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
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

        public void PrepareForPicking()
        {
            // Static CAD indexes are prepared while the device is loading, not
            // lazily on the first hover. Animated/skinned meshes stay per-frame.
            if (_skinned != null) return;
            EnsureIndex(_filter?.sharedMesh);
        }

        public static async Task PrepareStaticIndexesAsync(GameObject root, CancellationToken cancellationToken, Action<int, int> progress = null)
        {
            // Copy Unity mesh data on its owning thread. Only the CPU-only BVH
            // build runs on a worker, keeping the loading screen responsive.
            var meshes = new List<Mesh>(); var unique = new HashSet<Mesh>();
            foreach (var filter in root.GetComponentsInChildren<MeshFilter>(true))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (filter == null) continue;
                var mesh = filter.sharedMesh;
                if (mesh == null || !mesh.isReadable || StaticIndexes.TryGetValue(mesh, out _) || !unique.Add(mesh)) continue;
                meshes.Add(mesh);
            }
            var started = System.Diagnostics.Stopwatch.StartNew(); var batches = 0; var completed = 0;
            progress?.Invoke(0, meshes.Count);
            while (completed < meshes.Count) {
                cancellationToken.ThrowIfCancellationRequested();
                var selected = new List<Mesh>(64); var vertices = new List<Vector3[]>(64); var triangles = new List<int[]>(64); var indices = 0;
                // One await per tiny CAD mesh used to consume one Unity frame
                // per mesh. Batch exact, unchanged geometry; Unity API access
                // stays on its owning thread, CPU indexes stay on the worker.
                while (completed + selected.Count < meshes.Count && selected.Count < 64 && indices < 300000) {
                    var mesh = meshes[completed + selected.Count];
                    selected.Add(mesh); vertices.Add(mesh.vertices); var data = mesh.triangles; triangles.Add(data); indices += data.Length;
                }
                var built = await Task.Run(() => {
                    var result = new TriangleRayIndex[selected.Count];
                    for (var i = 0; i < result.Length; i++) { cancellationToken.ThrowIfCancellationRequested(); result[i] = new TriangleRayIndex(vertices[i], triangles[i]); }
                    return result;
                }, cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                for (var i = 0; i < selected.Count; i++) { var index = built[i]; if (selected[i] != null) StaticIndexes.GetValue(selected[i], _ => index); }
                completed += selected.Count; batches++; progress?.Invoke(completed, meshes.Count);
            }
            if (meshes.Count > 0) Debug.Log($"[InspectionIndexes] meshes={meshes.Count}, workerBatches={batches}, elapsedMs={started.ElapsedMilliseconds}");
        }

        private void EnsureIndex(Mesh mesh)
        {
            if (mesh == null || !mesh.isReadable || (_cachedMesh == mesh && _index != null)) return;
            _cachedMesh = mesh;
            _index = _skinned != null
                ? new TriangleRayIndex(mesh.vertices, mesh.triangles, false)
                : StaticIndexes.GetValue(mesh, source => new TriangleRayIndex(source.vertices, source.triangles));
        }

        public bool Raycast(Ray ray, out float distance, Func<Vector3, bool> acceptWorldPoint = null, float maxDistance = float.PositiveInfinity)
        {
            distance = float.PositiveInfinity;
            return IsVisible && RaycastGeometry(ray, out distance, acceptWorldPoint, maxDistance);
        }

        // Physical presentation checks must not change when a camera hides a
        // renderer or an inspection view fades its material.
        public bool RaycastGeometry(Ray ray, out float distance, Func<Vector3, bool> acceptWorldPoint = null, float maxDistance = float.PositiveInfinity)
        {
            distance = float.PositiveInfinity;
            if (Renderer == null || !Renderer.bounds.IntersectRay(ray)) return false;
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
            EnsureIndex(mesh);
            // Do not normalize this direction: its parameter remains a world-ray distance,
            // including mirrored or non-unit-scaled equipment instances.
            var inverse = Renderer.localToWorldMatrix.inverse;
            var origin = inverse.MultiplyPoint3x4(ray.origin);
            var direction = inverse.MultiplyVector(ray.direction);
            return _index.Raycast(origin, direction, out distance,
                acceptWorldPoint == null ? (Func<float, bool>)null : hit => acceptWorldPoint(ray.GetPoint(hit)), maxDistance);
        }

        public void DrawOutline(Material material, Camera camera, Color color, float widthPixels)
        {
            if (!IsVisible || material == null || camera == null) return;
            var mesh = CurrentMesh();
            if (mesh == null) return;
            InspectionOutlineRenderer.Submit(mesh, Renderer.localToWorldMatrix, Renderer.gameObject.layer, camera, material, color, widthPixels);
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
