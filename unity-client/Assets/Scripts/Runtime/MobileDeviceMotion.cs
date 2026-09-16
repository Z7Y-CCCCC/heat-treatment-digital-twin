using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    /// <summary>
    /// Applies a device's PLC position directly to its model root.
    /// RealtimeWebSocketClient already marshals incoming frames to Unity's main
    /// thread, so this component deliberately has no polling or extra queue.
    /// </summary>
    public sealed class MobileDeviceMotion : MonoBehaviour
    {
        private DeviceDto _device;
        private Vector3 _start;
        private Vector3 _end;
        private readonly List<StationAnchor> _stations = new List<StationAnchor>();
        private string _currentPointId = string.Empty;
        private string _startActionPointId = string.Empty;
        private string _valueMode = "normalized";
        private float _valueMin;
        private float _valueMax = 100f;
        private int _smoothingMs;
        private bool _simulationEnabled;
        private string _speedMode = "fixed";
        private float _maxSpeed = 2f;
        private float _acceleration = 1f;
        private float _sceneUnitsPerMeter = 1f;
        private float _motionSpeed;
        private bool _enabled;
        private bool _stationMode;
        private bool _hasTarget;
        private bool _hasPositionSample;
        private bool _snapNextPositionSample;
        private Vector3 _targetPosition;
        private Transform _motionIndicator;
        private Material _motionIndicatorMaterial;
        private float _motionIndicatorUntil;
        private float _lastLoggedPositionValue = float.NaN;

        private sealed class StationAnchor
        {
            public float Value;
            public Vector3 Position;
            public float DistanceMeters;
        }

        public void Initialize(DeviceDto device)
        {
            Reconfigure(device, false);
        }

        public void Reconfigure(DeviceDto device, bool preserveCurrentPosition)
        {
            _device = device;
            EnsureMotionIndicator();
            var fallback = new Vector3(device?.PositionX ?? 0f, device?.PositionY ?? 0f, device?.PositionZ ?? 0f);
            var movement = device?.InstanceConfigObject?["movement"] as JObject;
            _enabled = movement?.Value<bool?>("enabled") == true;
            _currentPointId = ReadId(movement?["currentPositionPointId"] ?? movement?["current_position_point_id"]);
            _startActionPointId = ReadId(movement?["startActionPointId"] ?? movement?["start_action_point_id"]);
            _valueMode = string.Equals(movement?.Value<string>("valueMode"), "range", StringComparison.OrdinalIgnoreCase)
                ? "range"
                : string.Equals(movement?.Value<string>("valueMode"), "station", StringComparison.OrdinalIgnoreCase)
                    ? "station"
                    : "normalized";
            _stationMode = string.Equals(_valueMode, "station", StringComparison.OrdinalIgnoreCase);
            _valueMin = ReadNumber(movement?["valueMin"] ?? movement?["value_min"], 0f);
            _valueMax = ReadNumber(movement?["valueMax"] ?? movement?["value_max"], 100f);
            _smoothingMs = Mathf.Clamp(Mathf.RoundToInt(ReadNumber(movement?["smoothingMs"] ?? movement?["smoothing_ms"], 0f)), 0, 1000);
            _simulationEnabled = movement?.Value<bool?>("simulationEnabled") == true
                || movement?.Value<bool?>("simulation_enabled") == true;
            var speedMode = movement?["speedMode"] ?? movement?["speed_mode"];
            _speedMode = speedMode == null
                ? "fixed"
                : string.Equals(speedMode.ToString(), "auto", StringComparison.OrdinalIgnoreCase) ? "auto" : "fixed";
            _maxSpeed = Mathf.Max(0.01f, ReadNumber(movement?["maxSpeed"] ?? movement?["max_speed"], 2f));
            _acceleration = Mathf.Max(0.01f, ReadNumber(movement?["acceleration"], 1f));
            _sceneUnitsPerMeter = Mathf.Max(0.0001f, ReadNumber(movement?["sceneUnitsPerMeter"] ?? movement?["scene_units_per_meter"], 1f));
            _motionSpeed = 0f;
            _start = ReadVector(movement?["start"] as JObject, fallback);
            _end = ReadVector(movement?["end"] as JObject, new Vector3(_start.x + 10f, _start.y, _start.z));
            _stations.Clear();
            if (string.Equals(_valueMode, "station", StringComparison.OrdinalIgnoreCase))
            {
                _stations.AddRange(ReadStations(movement?["stations"] as JArray));
                if (_stations.Count == 0)
                {
                    // Keep malformed or older configs usable with the same two-point fallback.
                    _stations.Add(new StationAnchor { Value = 1f, Position = _start });
                    _stations.Add(new StationAnchor { Value = 2f, Position = _end });
                }
            }
            _targetPosition = _start;
            _hasTarget = false;
            // The first valid PLC position after startup is the last known
            //现场位置. It must establish the initial pose, not animate from
            // station 1 (or the configured start point) to that pose.
            _hasPositionSample = preserveCurrentPosition;
            _snapNextPositionSample = !preserveCurrentPosition;
            _lastLoggedPositionValue = float.NaN;

            Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} configured: enabled={_enabled}, mode={_valueMode}, stations={_stations.Count}, simulation={_simulationEnabled}, axis={ResolveRailAxis()}");

            if (!_enabled) return;
            if (!preserveCurrentPosition)
            {
                transform.localPosition = _stationMode && _stations.Count > 0
                    ? _stations[0].Position
                    : _start;
                return;
            }

            // A saved movement configuration can be applied without rebuilding
            // the factory. Re-evaluate the latest frame immediately if present.
            if (_latestFrame != null) ApplyRealtime(_latestFrame);
        }

        private JObject _latestFrame;

        public void ApplyRealtime(JObject deviceData)
        {
            _latestFrame = deviceData;
            if (!_enabled || deviceData == null || string.IsNullOrWhiteSpace(_currentPointId)) return;
            JToken actionValue = null;
            if (!string.IsNullOrWhiteSpace(_startActionPointId)
                && !TryReadPointValue(deviceData, _startActionPointId, out actionValue)) return;
            if (!string.IsNullOrWhiteSpace(_startActionPointId) && !AsBoolean(actionValue)) return;
            if (!TryReadPointValue(deviceData, _currentPointId, out var positionValue)) return;
            if (!TryReadNumber(positionValue, out var value)) return;

            if (_stationMode)
            {
                if (!TryResolveStationPosition(value, out _targetPosition)) return;
            }
            else
            {
                var progress = string.Equals(_valueMode, "range", StringComparison.OrdinalIgnoreCase)
                    ? Mathf.InverseLerp(_valueMin, _valueMax, value)
                    : Mathf.Clamp01(value > 1f && value <= 100f ? value / 100f : value);
                _targetPosition = Vector3.LerpUnclamped(_start, _end, progress);
            }
            if (!Mathf.Approximately(_lastLoggedPositionValue, value))
            {
                _lastLoggedPositionValue = value;
                Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} PLC position={value.ToString(CultureInfo.InvariantCulture)} target={_targetPosition}");
            }

            if (_snapNextPositionSample || !_hasPositionSample)
            {
                _hasPositionSample = true;
                _snapNextPositionSample = false;
                transform.localPosition = _targetPosition;
                _motionSpeed = 0f;
                _hasTarget = false;
                _motionIndicatorUntil = 0f;
                if (_motionIndicator != null) _motionIndicator.gameObject.SetActive(false);
                Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} initial position snapped to {_targetPosition}");
                return;
            }

            _hasPositionSample = true;
            _hasTarget = true;
            ShowMotionIndicator();
            if (_stationMode && _simulationEnabled)
            {
                _hasTarget = true;
                return;
            }
            if (_smoothingMs <= 0)
            {
                transform.localPosition = _targetPosition;
                _hasTarget = false;
            }
        }

        private void Update()
        {
            UpdateMotionIndicator();
            if (!_enabled || !_hasTarget) return;
            if (_stationMode && _simulationEnabled)
            {
                UpdatePhysicalMotion();
                return;
            }
            if (_smoothingMs <= 0) return;
            var blend = 1f - Mathf.Exp(-Time.unscaledDeltaTime * 1000f / Mathf.Max(1f, _smoothingMs));
            transform.localPosition = Vector3.Lerp(transform.localPosition, _targetPosition, blend);
            if ((transform.localPosition - _targetPosition).sqrMagnitude < 0.000001f)
            {
                transform.localPosition = _targetPosition;
                _hasTarget = false;
            }
        }

        private void UpdatePhysicalMotion()
        {
            var delta = _targetPosition - transform.localPosition;
            var distance = delta.magnitude;
            if (distance <= 0.0001f)
            {
                transform.localPosition = _targetPosition;
                _motionSpeed = 0f;
                _hasTarget = false;
                return;
            }

            var deltaTime = Mathf.Max(0.0001f, Time.unscaledDeltaTime);
            var sceneUnitsPerMeter = Mathf.Max(0.0001f, _sceneUnitsPerMeter);
            var distanceMeters = distance / sceneUnitsPerMeter;
            var stoppingDistance = (_motionSpeed * _motionSpeed) / (2f * Mathf.Max(0.01f, _acceleration));
            var desiredSpeed = distanceMeters <= stoppingDistance
                ? Mathf.Sqrt(Mathf.Max(0f, 2f * _acceleration * distanceMeters))
                : (_speedMode == "auto"
                    ? Mathf.Sqrt(Mathf.Max(0f, 2f * _acceleration * distanceMeters))
                    : _maxSpeed);
            _motionSpeed = Mathf.MoveTowards(_motionSpeed, desiredSpeed, _acceleration * deltaTime);
            var step = _motionSpeed * deltaTime * sceneUnitsPerMeter;
            if (step >= distance)
            {
                transform.localPosition = _targetPosition;
                _motionSpeed = 0f;
                _hasTarget = false;
                return;
            }
            transform.localPosition += delta / distance * step;
        }

        private void EnsureMotionIndicator()
        {
            if (_motionIndicator != null || !IsMobileCarrier()) return;
            var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            marker.name = "移动中提示";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = new Vector3(0f, 2.9f, 0f);
            marker.transform.localScale = Vector3.one * 0.2f;
            var collider = marker.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
            _motionIndicatorMaterial = RuntimeShaderLibrary.CreateLitMaterial($"{_device?.Id} motion indicator");
            _motionIndicatorMaterial.EnableKeyword("_EMISSION");
            _motionIndicatorMaterial.color = new Color(0.16f, 0.9f, 1f);
            if (_motionIndicatorMaterial.HasProperty("_BaseColor")) _motionIndicatorMaterial.SetColor("_BaseColor", new Color(0.16f, 0.9f, 1f));
            if (_motionIndicatorMaterial.HasProperty("_EmissionColor")) _motionIndicatorMaterial.SetColor("_EmissionColor", new Color(0.16f, 0.9f, 1f) * 2.6f);
            marker.GetComponent<Renderer>().sharedMaterial = _motionIndicatorMaterial;
            marker.SetActive(false);
            _motionIndicator = marker.transform;
        }

        private bool IsMobileCarrier()
        {
            var config = _device?.InstanceConfigObject;
            var role = config?.Value<string>("role") ?? string.Empty;
            return string.Equals(_device?.ModelType, "transfer_cart", StringComparison.OrdinalIgnoreCase)
                || string.Equals(_device?.ModelType, "photo_transfer_cart_v6", StringComparison.OrdinalIgnoreCase)
                || string.Equals(role, "transfer_cart", StringComparison.OrdinalIgnoreCase)
                || string.Equals(role, "auxiliary", StringComparison.OrdinalIgnoreCase)
                || config?.Value<string>("railId") != null
                || config?.Value<string>("rail_id") != null
                || config?.Value<string>("railLineId") != null
                || config?.Value<string>("rail_line_id") != null;
        }

        private string ResolveRailAxis()
        {
            return Mathf.Abs(_end.x - _start.x) >= Mathf.Abs(_end.z - _start.z) ? "x" : "z";
        }

        private Vector3 NormalizeStationPosition(Vector3 source)
        {
            if (!IsMobileCarrier()) return source;
            return ResolveRailAxis() == "z"
                ? new Vector3(_start.x, _start.y, source.z)
                : new Vector3(source.x, _start.y, _start.z);
        }

        private void ShowMotionIndicator()
        {
            if (_motionIndicator == null) return;
            _motionIndicatorUntil = Time.unscaledTime + 0.9f;
            _motionIndicator.gameObject.SetActive(true);
        }

        private void UpdateMotionIndicator()
        {
            if (_motionIndicator == null) return;
            var visible = _hasTarget || Time.unscaledTime < _motionIndicatorUntil;
            _motionIndicator.gameObject.SetActive(visible);
            if (!visible) return;
            var pulse = 0.88f + Mathf.Sin(Time.unscaledTime * 8f) * 0.16f;
            _motionIndicator.localScale = Vector3.one * (0.2f * pulse);
        }

        private List<StationAnchor> ReadStations(JArray stations)
        {
            var result = new List<StationAnchor>();
            foreach (var token in stations ?? new JArray())
            {
                if (!(token is JObject station) || !TryReadNumber(station["value"], out var value)) continue;
                var position = station["position"] as JObject ?? station;
                result.Add(new StationAnchor
                {
                    Value = value,
                    Position = NormalizeStationPosition(ReadVector(position, _start)),
                    DistanceMeters = ReadNumber(station["distanceMeters"] ?? station["distance_meters"], 0f)
                });
            }
            return result
                .OrderBy(station => station.Value)
                .ToList();
        }

        private bool TryResolveStationPosition(float value, out Vector3 position)
        {
            position = _start;
            if (_stations.Count == 0) return false;
            if (_stations.Count == 1 || value <= _stations[0].Value)
            {
                position = _stations[0].Position;
                return true;
            }

            for (var index = 1; index < _stations.Count; index += 1)
            {
                var previous = _stations[index - 1];
                var next = _stations[index];
                if (value > next.Value) continue;
                var span = next.Value - previous.Value;
                var progress = span <= Mathf.Epsilon ? 1f : Mathf.InverseLerp(previous.Value, next.Value, value);
                position = Vector3.LerpUnclamped(previous.Position, next.Position, progress);
                return true;
            }

            position = _stations[_stations.Count - 1].Position;
            return true;
        }

        private bool TryReadPointValue(JObject frame, string pointId, out JToken value)
        {
            value = null;
            if (_device == null || !long.TryParse(pointId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)) return false;
            var point = (_device.DataPoints ?? Enumerable.Empty<DataPointDto>()).FirstOrDefault(item => item != null && item.Id == id);
            var category = point?.Category;
            var fieldName = point?.ValueRole;
            if (string.IsNullOrWhiteSpace(fieldName)) fieldName = point?.Name;

            // pointMeta contains the collector's resolved category/field, so it
            // remains correct when the point category was inferred from its name.
            var pointMeta = frame["pointMeta"] as JObject;
            foreach (var property in pointMeta?.Properties() ?? Enumerable.Empty<JProperty>())
            {
                var meta = property.Value as JObject;
                if (meta?.Value<long?>("id") != id) continue;
                category = meta.Value<string>("category") ?? category;
                fieldName = meta.Value<string>("field_name") ?? fieldName;
                break;
            }

            if (string.IsNullOrWhiteSpace(category)) category = "analog";
            if (string.IsNullOrWhiteSpace(fieldName)) return false;
            var quality = frame["quality"]?[category]?[fieldName]?.Value<string>();
            if (string.Equals(quality, "bad", StringComparison.OrdinalIgnoreCase)
                || string.Equals(quality, "stale", StringComparison.OrdinalIgnoreCase)) return false;
            value = frame[category]?[fieldName];
            return value != null && value.Type != JTokenType.Null;
        }

        private static bool TryReadNumber(JToken value, out float number)
        {
            number = 0f;
            if (value == null) return false;
            return float.TryParse(value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)
                && float.IsFinite(number);
        }

        private static bool AsBoolean(JToken value)
        {
            if (value == null) return false;
            if (value.Type == JTokenType.Boolean) return value.Value<bool>();
            return TryReadNumber(value, out var number) ? Mathf.Abs(number) > 0.0001f
                : string.Equals(value.ToString(), "true", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(value.ToString(), "on", StringComparison.OrdinalIgnoreCase);
        }

        private static string ReadId(JToken value)
        {
            return value == null || value.Type == JTokenType.Null ? string.Empty : value.ToString();
        }

        private static float ReadNumber(JToken value, float fallback)
        {
            return TryReadNumber(value, out var number) ? number : fallback;
        }

        private static Vector3 ReadVector(JObject value, Vector3 fallback)
        {
            if (value == null) return fallback;
            return new Vector3(
                ReadNumber(value["x"], fallback.x),
                ReadNumber(value["y"], fallback.y),
                ReadNumber(value["z"], fallback.z));
        }

        private void OnDestroy()
        {
            if (_motionIndicatorMaterial != null) Destroy(_motionIndicatorMaterial);
        }
    }
}
