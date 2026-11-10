using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Conservative rejection only, never a selectable hit. Ordinary CPU mesh
    // bounds transformed by the same-frame affine matrix enclose its triangles.
    // Skinned/static-batched renderers keep the original renderer-bounds path.
    public static class HoverRayBroadphase
    {
        public static bool Intersects(Bounds local, Matrix4x4 matrix, Ray ray)
        {
            var center = matrix.MultiplyPoint3x4(local.center); var e = local.extents;
            var extent = new Vector3(
                Mathf.Abs(matrix.m00) * e.x + Mathf.Abs(matrix.m01) * e.y + Mathf.Abs(matrix.m02) * e.z,
                Mathf.Abs(matrix.m10) * e.x + Mathf.Abs(matrix.m11) * e.y + Mathf.Abs(matrix.m12) * e.z,
                Mathf.Abs(matrix.m20) * e.x + Mathf.Abs(matrix.m21) * e.y + Mathf.Abs(matrix.m22) * e.z);
            var padding = .00001f * (1 + Mathf.Max(Mathf.Abs(center.x), Mathf.Max(Mathf.Abs(center.y), Mathf.Abs(center.z))) + Mathf.Max(extent.x, Mathf.Max(extent.y, extent.z)));
            if (!float.IsFinite(padding) || !Finite(ray.origin) || !Finite(ray.direction)) return true;
            extent += Vector3.one * padding;
            var min = center - extent; var max = center + extent;
            var near = 0f; var far = float.PositiveInfinity;
            return Axis(ray.origin.x, ray.direction.x, min.x, max.x, ref near, ref far)
                && Axis(ray.origin.y, ray.direction.y, min.y, max.y, ref near, ref far)
                && Axis(ray.origin.z, ray.direction.z, min.z, max.z, ref near, ref far);
        }
        private static bool Finite(Vector3 v) => float.IsFinite(v.x) && float.IsFinite(v.y) && float.IsFinite(v.z);
        private static bool Axis(float origin, float direction, float min, float max, ref float near, ref float far)
        {
            if (direction == 0) return origin >= min && origin <= max;
            var a = (min - origin) / direction; var b = (max - origin) / direction;
            near = Mathf.Max(near, Mathf.Min(a, b)); far = Mathf.Min(far, Mathf.Max(a, b));
            return far >= near;
        }
    }
}
