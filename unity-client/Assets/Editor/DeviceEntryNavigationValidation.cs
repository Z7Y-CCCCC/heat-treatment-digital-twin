using System;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Runs against real Unity camera components during the batch build. No
    // application, customer database, physical controller or user window opens.
    public static class DeviceEntryNavigationValidation
    {
        public static void Validate()
        {
            var root = new GameObject("__DeviceEntryCameraValidation") { hideFlags = HideFlags.HideAndDontSave };
            try
            {
                var camera = root.AddComponent<Camera>(); var orbit = root.AddComponent<OrbitCameraController>();
                camera.fieldOfView = 47f; camera.aspect = 16f / 9f;
                var sourceBounds = new Bounds(new Vector3(37f, 4f, -11f), new Vector3(24f, 8f, 14f));
                orbit.SetTargetOffset(new Vector3(3f, 1f, -2f));
                orbit.FocusBounds(sourceBounds, 153f, 31f, 1.4f, true);
                var position = root.transform.position; var rotation = root.transform.rotation; var target = orbit.Target;
                var near = camera.nearClipPlane; var far = camera.farClipPlane;
                // Capture while another preset is still in flight: return must
                // restore what the user saw, not the unrendered desired preset.
                orbit.FocusBounds(new Bounds(Vector3.zero, Vector3.one * 3f), -25f, 12f, 1f, false);
                var state = orbit.CaptureViewState();
                orbit.FocusBounds(new Bounds(Vector3.one * 80f, Vector3.one), 240f, 19f, .8f, true, true);
                orbit.RestoreViewState(state, true);
                if (Vector3.Distance(root.transform.position, position) > .001f || Quaternion.Angle(root.transform.rotation, rotation) > .1f
                    || Vector3.Distance(orbit.Target, target) > .001f || Math.Abs(camera.nearClipPlane - near) > .0001f || Math.Abs(camera.farClipPlane - far) > .001f)
                    throw new Exception("Device entry return failed to restore the rendered camera pose and clipping planes.");
                Debug.Log("[DeviceEntryNavigationValidation] PASS: rendered entry camera, not an authored preset, is restored exactly.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
    }
}
