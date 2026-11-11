using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // The opaque loading card is IMGUI/WebView, not this scene camera. Drawing
    // partially imported CAD behind it steals the frame budget from glTF import.
    // Pause rendering, NOT geometry preparation, updates, or loading milestones.
    public sealed class StartupSceneRenderGate
    {
        private readonly Camera _camera;
        private bool _paused, _previouslyEnabled;
        public StartupSceneRenderGate(Camera camera) { _camera = camera; }
        public void Pause()
        {
            if (_paused || _camera == null) return;
            _previouslyEnabled = _camera.enabled;
            _paused = true;
            _camera.enabled = false;
        }
        public void Resume()
        {
            if (!_paused) return;
            _paused = false;
            if (_camera != null) _camera.enabled = _previouslyEnabled;
        }
    }
}
