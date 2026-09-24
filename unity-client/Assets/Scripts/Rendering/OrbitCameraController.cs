using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    [RequireComponent(typeof(Camera))]
    public sealed class OrbitCameraController : MonoBehaviour
    {
        [SerializeField] private float rotateSpeed = 0.22f;
        [SerializeField] private float panSpeed = 0.0022f;
        [SerializeField] private float zoomSpeed = 0.11f;
        [SerializeField] private float keyboardPanSpeed = 14f;

        private Vector3 _target;
        private Vector3 _desiredTarget;
        private float _yaw = -35f;
        private float _desiredYaw = -35f;
        private float _pitch = 24f;
        private float _desiredPitch = 24f;
        private float _distance = 48f;
        private float _desiredDistance = 48f;
        private Bounds _lastBounds = new Bounds(Vector3.zero, new Vector3(40f, 8f, 30f));
        private float _transitionSeconds = 0.22f;
        private Vector3 _targetOffset = Vector3.zero;
        private float _minimumDistance = 2.5f;
        private bool _lastPrecise;

        public Vector3 Target => _target;
        public Bounds FramedBounds => _lastBounds;
        public bool InteractionEnabled { get; set; } = true;
        public bool PointerInputBlocked { get; set; }

        public void SetTransitionDuration(float seconds)
        {
            _transitionSeconds = Mathf.Clamp(seconds, 0f, 10f);
        }

        public void SetTargetOffset(Vector3 offset)
        {
            _targetOffset = offset;
        }

        public void StopAutoTransition()
        {
            _desiredTarget = _target;
            _desiredYaw = _yaw;
            _desiredPitch = _pitch;
            _desiredDistance = _distance;
        }

        public void TrackBoundsCenter(Bounds bounds)
        {
            _desiredTarget = bounds.center + _targetOffset;
        }

        public void FrameBounds(Bounds bounds, bool immediate = false)
        {
            FocusBounds(bounds, -35f, 24f, 1.08f, immediate);
        }

        public void FocusBounds(
            Bounds bounds,
            float yaw,
            float pitch,
            float padding = 1.08f,
            bool immediate = false,
            bool precise = false)
        {
            _lastBounds = bounds;
            _lastPrecise = precise;
            _desiredTarget = bounds.center + (precise ? Vector3.zero : Vector3.up * Mathf.Max(0.5f, bounds.extents.y * 0.08f)) + _targetOffset;
            _desiredYaw = yaw;
            _desiredPitch = Mathf.Clamp(pitch, precise ? -89f : 6f, precise ? 89f : 82f);
            var camera = GetComponent<Camera>();
            var radius = Mathf.Max(precise ? .01f : 3f, bounds.extents.magnitude);
            var verticalFov = Mathf.Max(12f, camera.fieldOfView * .5f) * Mathf.Deg2Rad;
            var horizontalFov = Mathf.Atan(Mathf.Tan(verticalFov) * Mathf.Max(.1f, camera.aspect));
            var halfFov = Mathf.Min(verticalFov, horizontalFov);
            _minimumDistance = precise ? Mathf.Max(.0005f, radius * .05f) : 2.5f;
            _desiredDistance = Mathf.Clamp(radius / Mathf.Sin(halfFov) * Mathf.Max(precise ? .05f : .65f, padding), precise ? .001f : 6f, 1000f);
            // Large authored halls can legitimately need more than the original
            // placeholder scene's fixed 600 m far plane. Keep the full bounds
            // renderable after a workshop resize instead of clipping the entire
            // environment into an apparently empty background.
            camera.farClipPlane = Mathf.Max(camera.farClipPlane, _desiredDistance + radius + Mathf.Max(40f, radius * .35f));
            // Small assemblies must not disappear into the old 6 m framing floor or
            // the normal factory near plane. Keep depth precision proportional to scale.
            camera.nearClipPlane = precise ? Mathf.Clamp(_desiredDistance * .005f, .002f, .3f) : .1f;
            if (!immediate) return;
            _target = _desiredTarget;
            _yaw = _desiredYaw;
            _pitch = _desiredPitch;
            _distance = _desiredDistance;
            ApplyTransform();
        }

        public void NudgeYaw(float degrees)
        {
            _desiredYaw += degrees;
        }

        public void ZoomBy(float multiplier)
        {
            _desiredDistance = Mathf.Clamp(_desiredDistance * Mathf.Max(0.1f, multiplier), _minimumDistance, 1000f);
        }

        private void Awake()
        {
            _target = _desiredTarget = new Vector3(0f, 2f, 0f);
            ApplyTransform();
        }

        private void Update()
        {
            var allowPointer = InteractionEnabled && !PointerInputBlocked;
            if (allowPointer && Input.GetMouseButton(0))
            {
                _desiredYaw += Input.GetAxisRaw("Mouse X") * rotateSpeed * 14f;
                _desiredPitch -= Input.GetAxisRaw("Mouse Y") * rotateSpeed * 14f;
                _desiredPitch = Mathf.Clamp(_desiredPitch, _lastPrecise ? -89f : 6f, _lastPrecise ? 89f : 82f);
            }

            if (allowPointer && (Input.GetMouseButton(2) || Input.GetMouseButton(1)))
            {
                var rotation = Quaternion.Euler(0f, _yaw, 0f);
                var right = rotation * Vector3.right;
                var forward = rotation * Vector3.forward;
                var amount = Mathf.Max(.05f, _distance) * panSpeed;
                _desiredTarget -= right * (Input.GetAxisRaw("Mouse X") * amount);
                _desiredTarget -= forward * (Input.GetAxisRaw("Mouse Y") * amount);
            }

            var wheel = allowPointer ? Input.mouseScrollDelta.y : 0f;
            if (Mathf.Abs(wheel) > 0.001f)
            {
                _desiredDistance *= Mathf.Exp(-wheel * zoomSpeed);
                _desiredDistance = Mathf.Clamp(_desiredDistance, _minimumDistance, 1000f);
            }

            var keyboard = InteractionEnabled
                ? new Vector2(Input.GetAxisRaw("Horizontal"), Input.GetAxisRaw("Vertical"))
                : Vector2.zero;
            if (keyboard.sqrMagnitude > 0.001f)
            {
                var rotation = Quaternion.Euler(0f, _yaw, 0f);
                var move = rotation * new Vector3(keyboard.x, 0f, keyboard.y);
                _desiredTarget += move * (keyboardPanSpeed * Time.unscaledDeltaTime);
            }
            if (InteractionEnabled && Input.GetKey(KeyCode.Q)) _desiredTarget += Vector3.down * (keyboardPanSpeed * Time.unscaledDeltaTime);
            if (InteractionEnabled && Input.GetKey(KeyCode.E)) _desiredTarget += Vector3.up * (keyboardPanSpeed * Time.unscaledDeltaTime);
            if (Input.GetKeyDown(KeyCode.Home)) FocusBounds(_lastBounds, _desiredYaw, _desiredPitch, 1.08f, false, _lastPrecise);
        }

        private void LateUpdate()
        {
            var response = _transitionSeconds <= 0.001f ? 1000f : 4.6f / _transitionSeconds;
            var blend = 1f - Mathf.Exp(-response * Time.unscaledDeltaTime);
            _target = Vector3.Lerp(_target, _desiredTarget, blend);
            _yaw = Mathf.LerpAngle(_yaw, _desiredYaw, blend);
            _pitch = Mathf.Lerp(_pitch, _desiredPitch, blend);
            _distance = Mathf.Lerp(_distance, _desiredDistance, blend);
            ApplyTransform();
        }

        private void ApplyTransform()
        {
            var rotation = Quaternion.Euler(_pitch, _yaw, 0f);
            transform.SetPositionAndRotation(_target - rotation * Vector3.forward * _distance, rotation);
        }
    }
}
