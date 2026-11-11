#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class HoverTransformBatchValidation
    {
        public static void Validate()
        {
            var roots = new List<GameObject>(); var checks = 0;
            void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); checks++; }
            using var batch = new HoverTransformBatch();
            try {
                var parent = new GameObject("__HoverBatchParent"); roots.Add(parent);
                parent.transform.SetPositionAndRotation(new Vector3(3, -2, 5), Quaternion.Euler(13, 29, 7));
                parent.transform.localScale = new Vector3(-2, .7f, 1.3f);
                var transforms = new Transform[192];
                for (var i = 0; i < transforms.Length; i++) {
                    var node = new GameObject("matrix-" + i); node.transform.SetParent(parent.transform, false);
                    node.transform.localPosition = new Vector3(i * .1f, i % 7, i % 3);
                    node.transform.localRotation = Quaternion.Euler(i, i * 3, i * 7);
                    node.transform.localScale = new Vector3(.5f + i * .01f, 2, 1);
                    transforms[i] = node.transform;
                }
                batch.SetTransforms(transforms); batch.Capture();
                for (var i = 0; i < transforms.Length; i++) Check(batch.Get(i).Equals(transforms[i].localToWorldMatrix), "same-frame affine/mirrored matrix differs");
                parent.transform.Rotate(3, 7, 11); transforms[17].localPosition += Vector3.one * .001f;
                batch.Capture();
                for (var i = 0; i < transforms.Length; i++) Check(batch.Get(i).Equals(transforms[i].localToWorldMatrix), "parent/child edit was delayed");
                for (var i = 0; i < 32; i++) batch.Capture();
                var allocated = GC.GetAllocatedBytesForCurrentThread();
                for (var i = 0; i < 128; i++) batch.Capture();
                Check(GC.GetAllocatedBytesForCurrentThread() == allocated, "steady same-frame matrix capture allocated managed memory");
                Object.DestroyImmediate(transforms[0].gameObject); batch.Capture();
                Check(batch.Get(0).Equals(Matrix4x4.identity), "destroyed transform did not fail closed");
                batch.SetTransforms(Array.Empty<Transform>()); Check(batch.Count == 0, "empty model did not release batch");
                var random = new System.Random(20261110);
                float Next(float range) => (float)(random.NextDouble() * 2 - 1) * range;
                var corners = new Vector3[8];
                for (var sample = 0; sample < 600; sample++) {
                    var local = new Bounds(new Vector3(Next(2), Next(2), Next(2)), new Vector3(.1f + Mathf.Abs(Next(4)), .1f + Mathf.Abs(Next(4)), .1f + Mathf.Abs(Next(4))));
                    var matrix = Matrix4x4.TRS(new Vector3(Next(50), Next(50), Next(50)), Quaternion.Euler(Next(180), Next(180), Next(180)), new Vector3(-.2f - Mathf.Abs(Next(3)), .2f + Mathf.Abs(Next(3)), .2f + Mathf.Abs(Next(3))))
                        * Matrix4x4.TRS(new Vector3(Next(2), Next(2), Next(2)), Quaternion.Euler(Next(180), Next(180), Next(180)), new Vector3(1, 2, .3f));
                    var index = 0; var world = new Bounds();
                    for (var x = -1; x <= 1; x += 2) for (var y = -1; y <= 1; y += 2) for (var z = -1; z <= 1; z += 2) {
                        var point = matrix.MultiplyPoint3x4(local.center + Vector3.Scale(local.extents, new Vector3(x, y, z)));
                        corners[index] = point; if (index++ == 0) world = new Bounds(point, Vector3.zero); else world.Encapsulate(point);
                    }
                    var origin = world.center + new Vector3(Next(100), Next(100), Next(100));
                    var ray = new Ray(origin, (sample % 2 == 0 ? world.center : corners[sample % 8]) - origin);
                    Check(!world.IntersectRay(ray) || HoverRayBroadphase.Intersects(local, matrix, ray), "conservative ray rejection missed an affine/mirrored/sheared mesh bound");
                }
                Check(!HoverRayBroadphase.Intersects(new Bounds(Vector3.zero, Vector3.one), Matrix4x4.identity, new Ray(new Vector3(100, 0, -5), Vector3.forward)), "broadphase did not reject an unrelated mesh");
                Check(HoverRayBroadphase.Intersects(new Bounds(Vector3.zero, Vector3.one), Matrix4x4.identity, new Ray(new Vector3(0, 0, -5), Vector3.forward)), "parallel slab hit was rejected");
                Check(HoverRayBroadphase.Intersects(new Bounds(Vector3.zero, Vector3.one), Matrix4x4.identity, new Ray(new Vector3(.5f, 0, -5), Vector3.forward)), "edge ray was rejected");
                var bounds = new Bounds(Vector3.zero, Vector3.one); var testRay = new Ray(new Vector3(100, 0, -5), Vector3.forward);
                for (var i = 0; i < 32; i++) HoverRayBroadphase.Intersects(bounds, Matrix4x4.identity, testRay);
                allocated = GC.GetAllocatedBytesForCurrentThread();
                for (var i = 0; i < 2048; i++) HoverRayBroadphase.Intersects(bounds, Matrix4x4.identity, testRay);
                Check(GC.GetAllocatedBytesForCurrentThread() == allocated, "per-renderer ray rejection allocated managed memory");
                Debug.Log("[HoverTransformBatchValidation] PASS " + checks + " actual Unity matrix/ownership/allocation checks");
            }
            finally { foreach (var root in roots) if (root != null) Object.DestroyImmediate(root); }
        }
    }
}
#endif
