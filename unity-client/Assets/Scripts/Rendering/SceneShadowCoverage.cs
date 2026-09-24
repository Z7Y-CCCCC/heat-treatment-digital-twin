using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    /// <summary>Cover the focused receiver bounds without raising shadow-map resolution.</summary>
    public static class SceneShadowCoverage
    {
        public static float Distance(Bounds bounds, Vector3 position, Vector3 forward, float farClip, float minimum)
        {
            forward.Normalize();
            var extents = bounds.extents;
            var radius = Mathf.Abs(forward.x) * extents.x
                + Mathf.Abs(forward.y) * extents.y + Mathf.Abs(forward.z) * extents.z;
            var farReceiver = Vector3.Dot(bounds.center - position, forward) + radius;
            // URP fades shadows before shadowDistance; reserve room beyond the
            // farthest receiver so the far wall doesn't sit inside that fade.
            var requested = Mathf.Max(minimum, (farReceiver + 2f) / 0.8f);
            // Small quantization avoids continuously rescaling the atlas for
            // subpixel orbit damping. The camera clip remains authoritative.
            return Mathf.Min(Mathf.Max(0.01f, farClip), Mathf.Ceil(requested / 5f) * 5f);
        }
    }
}
