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
        private StationInputMeaning _stationInputMeaning;
        private bool _hasTarget;
        private bool _hasPositionSample;
        private bool _snapNextPositionSample;
        private Vector3 _targetPosition;
        private Transform _motionIndicator;
        private Material _motionIndicatorMaterial;
        private float _motionIndicatorUntil;
        private float _lastLoggedPositionValue = float.NaN;
        private bool _diagnosticLogging;
        private float _diagnosticIntervalSeconds = 5f;
        private float _nextDiagnosticLogAt;
        private readonly MobileMotionSignalState _positionSignal = new MobileMotionSignalState();
        private string _movementIdentity;
        private string _lineCalibrationIdentity = "absent";
        private double _staleMs = 5000;
        private Vector3 _interpolationStart;
        private double _interpolationStartedAt;

        private sealed class StationAnchor
        {
            public float Value;
            public Vector3 Position;
            public float DistanceMeters;
        }

        public void Initialize(DeviceDto device, JObject lineLayout = null)
        {
            Reconfigure(device, false, lineLayout);
        }

        public void Reconfigure(DeviceDto device, bool preserveCurrentPosition, JObject lineLayout = null)
        {
            _lineCalibrationIdentity = lineLayout?["sceneUnitsPerMeter"]?.ToString(Newtonsoft.Json.Formatting.None) ?? "absent";
            var movementIdentity = device?.InstanceConfigObject?["movement"]?.ToString(Newtonsoft.Json.Formatting.None)
                + "|lineUnits:" + _lineCalibrationIdentity;
            if (!preserveCurrentPosition || _device?.Id != device?.Id || _movementIdentity != movementIdentity) _positionSignal.Reset();
            _movementIdentity = movementIdentity;
            _device = device;
            EnsureMotionIndicator();
            var fallback = new Vector3(device?.PositionX ?? 0f, device?.PositionY ?? 0f, device?.PositionZ ?? 0f);
            var movement = device?.InstanceConfigObject?["movement"] as JObject;
            _staleMs = movement?.Value<double?>("staleMs") ?? device?.InstanceConfigObject?["animationBindings"]?.Value<double?>("staleMs") ?? 5000;
            // Explicit opt-in diagnostics; sampling never gates position/animation updates.
            _diagnosticLogging = movement?.Value<bool?>("diagnosticLogging")
                ?? device?.InstanceConfigObject?["animationBindings"]?.Value<bool?>("diagnosticLogging")
                ?? string.Equals(Environment.GetEnvironmentVariable("MOBILE_DEVICE_MOTION_DIAGNOSTICS"), "1", StringComparison.Ordinal);
            _diagnosticIntervalSeconds = Mathf.Clamp(ReadNumber(movement?["diagnosticIntervalSeconds"]
                ?? device?.InstanceConfigObject?["animationBindings"]?["diagnosticIntervalSeconds"], 5f), 1f, 60f);
            _enabled = movement?.Value<bool?>("enabled") == true;
            _currentPointId = ReadId(movement?["currentPositionPointId"] ?? movement?["current_position_point_id"]);
            _startActionPointId = ReadId(movement?["startActionPointId"] ?? movement?["start_action_point_id"]);
            _valueMode = string.Equals(movement?.Value<string>("valueMode"), "range", StringComparison.OrdinalIgnoreCase)
                ? "range"
                : string.Equals(movement?.Value<string>("valueMode"), "station", StringComparison.OrdinalIgnoreCase)
                    ? "station"
                    : "normalized";
            _stationMode = string.Equals(_valueMode, "station", StringComparison.OrdinalIgnoreCase);
            _stationInputMeaning = _stationMode ? MobileMotionSignalState.ParseStationInputMeaning(movement?["stationInputMeaning"]) : StationInputMeaning.Legacy;
            if (_stationInputMeaning == StationInputMeaning.Invalid) { _enabled = false; _positionSignal.Suspend("工位信号含义无效"); }
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
            if (!SceneUnitPolicy.TryResolve(movement, lineLayout, out _sceneUnitsPerMeter, out var unitReason))
            { _enabled = false; _positionSignal.Suspend(unitReason); }
            _motionSpeed = 0f;
            _start = ReadVector(movement?["start"] as JObject, fallback);
            _end = ReadVector(movement?["end"] as JObject, new Vector3(_start.x + 10f, _start.y, _start.z));
            _stations.Clear();
            if (string.Equals(_valueMode, "station", StringComparison.OrdinalIgnoreCase))
            {
                var completeAxis = TryReadVector(movement?["start"] as JObject, out _start) && TryReadVector(movement?["end"] as JObject, out _end)
                    && RailPositionPolicy.ProjectStation(new[] { (double)_start.x, _start.y, _start.z },
                        new[] { (double)_start.x, _start.y, _start.z }, new[] { (double)_end.x, _end.y, _end.z }) != null;
                if (!completeAxis)
                { _enabled = false; _positionSignal.Suspend("轨道参考轴未完整配置或已退化"); }
                else _stations.AddRange(ReadStations(movement?["stations"] as JArray));
                if (_stations.Count == 0)
                {
                    // No invented workstation IDs/locations in a real scene.
                    _enabled = false;
                    if (completeAxis && _stationInputMeaning != StationInputMeaning.Invalid) _positionSignal.Suspend("工位坐标未配置");
                }
            }
            _targetPosition = _start;
            _hasTarget = false;
            // The first valid PLC position after startup is the last known
            //现场位置. It must establish the initial pose, not animate from
            // station 1 (or the configured start point) to that pose.
            _hasPositionSample = _positionSignal.HasSample;
            _snapNextPositionSample = !preserveCurrentPosition || !_positionSignal.HasSample;
            _lastLoggedPositionValue = float.NaN;
            _nextDiagnosticLogAt = 0f;

            if (_diagnosticLogging)
                Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} configured: enabled={_enabled}, mode={_valueMode}, stations={_stations.Count}, simulation={_simulationEnabled}, axis={ResolveRailAxis()}");

            if (!_enabled) return;
            if (!preserveCurrentPosition)
            {
                transform.localPosition = _stationMode && _stationInputMeaning == StationInputMeaning.Target ? fallback
                    : _stationMode && _stations.Count > 0
                    ? _stations[0].Position
                    : _start;
                return;
            }

            // A saved movement configuration can be applied without rebuilding
            // the factory. Re-evaluate the latest frame immediately if present.
            if (_latestFrame != null) ApplyRealtime(_latestFrame);
        }

        private JObject _latestFrame;

        public void UpdateLineCalibration(DeviceDto device, JObject lineLayout)
        {
            var identity = lineLayout?["sceneUnitsPerMeter"]?.ToString(Newtonsoft.Json.Formatting.None) ?? "absent";
            if (identity != _lineCalibrationIdentity) Reconfigure(device, true, lineLayout);
        }

        public void ApplyRealtime(JObject deviceData)
        {
            if (deviceData?.Value<bool?>("motionInputOnly") == true) return;
            _latestFrame = deviceData;
            if (!_enabled) return;
            if (deviceData == null || string.IsNullOrWhiteSpace(_currentPointId)) { SuspendInputs("位置采集数据未配置或无效"); return; }
            if (!_positionSignal.Receive(_device, deviceData, _currentPointId, _startActionPointId,
                Time.realtimeSinceStartupAsDouble, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _staleMs, _stationInputMeaning,
                actualPositionFeedback: !_stationMode))
            {
                if (!_positionSignal.Usable) StopAtCurrentPose();
                return;
            }
            if (_stationInputMeaning == StationInputMeaning.Target && !_simulationEnabled)
            { SuspendInputs("目标工位命令未启用运动估算，实际位置未确认"); return; }
            var value = (float)_positionSignal.Value;
            var previousTarget = _targetPosition;

            if (_stationMode)
            {
                if (!TryResolveStationPosition(value, out _targetPosition)) { SuspendInputs("工位编号未配置"); return; }
            }
            else
            {
                var progress = string.Equals(_valueMode, "range", StringComparison.OrdinalIgnoreCase)
                    ? Mathf.InverseLerp(_valueMin, _valueMax, value)
                    : Mathf.Clamp01(value > 1f && value <= 100f ? value / 100f : value);
                _targetPosition = Vector3.LerpUnclamped(_start, _end, progress);
            }
            if (_diagnosticLogging && Time.unscaledTime >= _nextDiagnosticLogAt
                && !Mathf.Approximately(_lastLoggedPositionValue, value))
            {
                _nextDiagnosticLogAt = Time.unscaledTime + _diagnosticIntervalSeconds;
                _lastLoggedPositionValue = value;
                Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} PLC position={value.ToString(CultureInfo.InvariantCulture)} target={_targetPosition}");
            }

            if (_stationInputMeaning != StationInputMeaning.Target
                && (_positionSignal.SnapOnReceive || _snapNextPositionSample || !_hasPositionSample))
            {
                _hasPositionSample = true;
                _snapNextPositionSample = false;
                transform.localPosition = _targetPosition;
                _motionSpeed = 0f;
                _hasTarget = false;
                _motionIndicatorUntil = 0f;
                if (_motionIndicator != null) _motionIndicator.gameObject.SetActive(false);
                if (_diagnosticLogging)
                    Debug.Log($"[MobileDeviceMotion] {_device?.Id ?? string.Empty} initial position snapped to {_targetPosition}");
                return;
            }

            _hasPositionSample = true;
            var changed = (_targetPosition - previousTarget).sqrMagnitude > .00000001f;
            _hasTarget = (_targetPosition - transform.localPosition).sqrMagnitude > .00000001f;
            if (changed)
            {
                _interpolationStart = transform.localPosition;
                _interpolationStartedAt = Time.realtimeSinceStartupAsDouble;
            }
            ShowMotionIndicator();
            if (EstimateStationTravel)
            {
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
            AdvanceMotion(Time.unscaledDeltaTime, Time.realtimeSinceStartupAsDouble);
        }

        public void AdvanceMotion(float deltaTime, double now)
        {
            if (!_enabled) return;
            if (!_positionSignal.Advance(now, _staleMs, !string.IsNullOrWhiteSpace(_startActionPointId)))
            { StopAtCurrentPose(); return; }
            if (!_hasTarget) return;
            if (EstimateStationTravel)
            {
                if (float.IsFinite(deltaTime) && deltaTime > 0) UpdatePhysicalMotion(deltaTime);
                return;
            }
            if (_smoothingMs <= 0) return;
            // A configured 100 ms transition must finish in 100 ms, rather than
            // the former exponential tail lasting many times that delay budget.
            var blend = Mathf.Clamp01((float)((now - _interpolationStartedAt) * 1000 / Math.Max(1, _smoothingMs)));
            transform.localPosition = Vector3.Lerp(_interpolationStart, _targetPosition, blend);
            if (blend >= 1f)
            {
                transform.localPosition = _targetPosition;
                _hasTarget = false;
            }
        }

        public void SuspendInputs(string reason = "采集连接中断")
        {
            _positionSignal.Suspend(reason); StopAtCurrentPose();
        }
        public bool HasFreshPosition => _enabled && _positionSignal.Usable && _positionSignal.HasSample;
        public bool HasConfirmedPosition => _enabled && _positionSignal.HasConfirmedPosition;
        // A continuous position is a measured source pose even while moving.
        // Target commands and legacy station estimates must never manufacture
        // a cargo location between physically unobserved stations.
        public bool HasReliableSourcePose => HasFreshPosition && (!_stationMode
            || _stationInputMeaning == StationInputMeaning.Current && HasConfirmedPosition
            || _stationInputMeaning == StationInputMeaning.Legacy && !_simulationEnabled && !_hasTarget);
        public double CurrentPositionValue => _positionSignal.Value;
        public string PositionReason => _positionSignal.Reason;
        private bool EstimateStationTravel => _stationMode && _simulationEnabled && _stationInputMeaning != StationInputMeaning.Current;
        private void StopAtCurrentPose()
        {
            _hasTarget = false; _motionSpeed = 0f; _motionIndicatorUntil = 0f;
            if (_motionIndicator != null) _motionIndicator.gameObject.SetActive(false);
        }

        private void UpdatePhysicalMotion(float deltaTime)
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

            deltaTime = Mathf.Max(0.0001f, deltaTime);
            var sceneUnitsPerMeter = _sceneUnitsPerMeter;
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
            // This was previously created for every carrier at a hard-coded
            // height, producing an intermittent floating dot during motion.
            // Real model lamps and PLC movement are independent of this debug marker.
            var enabled = _device?.InstanceConfigObject?["movement"]?["showMotionIndicator"];
            if (enabled?.Type != JTokenType.Boolean || !enabled.Value<bool>() || !IsMobileCarrier())
            {
                ClearMotionIndicator();
                return;
            }
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

        private void ClearMotionIndicator()
        {
            if (_motionIndicator != null)
            {
                _motionIndicator.gameObject.SetActive(false);
                if (Application.isPlaying) Destroy(_motionIndicator.gameObject);
                else DestroyImmediate(_motionIndicator.gameObject);
            }
            if (_motionIndicatorMaterial != null)
            {
                if (Application.isPlaying) Destroy(_motionIndicatorMaterial);
                else DestroyImmediate(_motionIndicatorMaterial);
            }
            _motionIndicator = null;
            _motionIndicatorMaterial = null;
            _motionIndicatorUntil = 0f;
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

        private bool TryNormalizeStationPosition(Vector3 source, out Vector3 position)
        {
            position = source;
            if (!IsMobileCarrier()) return true;
            // Project to the actual configured horizontal rail, including a
            // diagonal/rotated line. Choosing its largest X/Z component moved
            // a carrier away from the real loading datum on oblique layouts.
            var projected = RailPositionPolicy.ProjectStation(new[] { (double)source.x, source.y, source.z },
                new[] { (double)_start.x, _start.y, _start.z }, new[] { (double)_end.x, _end.y, _end.z });
            if (projected == null) return false;
            position = new Vector3((float)projected[0], (float)projected[1], (float)projected[2]);
            return float.IsFinite(position.x) && float.IsFinite(position.y) && float.IsFinite(position.z);
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
                if (!TryReadVector(position, out var source) || !TryNormalizeStationPosition(source, out var normalized)) continue;
                result.Add(new StationAnchor
                {
                    Value = value,
                    Position = normalized,
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
            StationAnchor match = null;
            foreach (var station in _stations)
            {
                if (Mathf.Abs(station.Value - value) > .0001f) continue;
                if (match != null) return false;
                match = station;
            }
            // A station ID is discrete feedback, not an invented interpolation
            // between IDs or a clamp to a neighbouring/last known workstation.
            if (match == null) return false;
            position = match.Position; return true;
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

        private static bool TryReadVector(JObject value, out Vector3 position)
        {
            position = Vector3.zero;
            if (value == null || !TryReadNumber(value["x"], out var x) || !TryReadNumber(value["y"], out var y)
                || !TryReadNumber(value["z"], out var z)) return false;
            position = new Vector3(x, y, z); return true;
        }

        private void OnDestroy()
        {
            ClearMotionIndicator();
        }
    }
}
