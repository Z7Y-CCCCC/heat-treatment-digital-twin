using System;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Presentation only: two owned PLC points, no metre calibration, speed,
    // acceleration or invented intermediate feedback. The renderer supplies
    // the path and clock; completion of that visual path is never confirmation.
    public sealed class SimpleStationMotionState
    {
        public const double TravelSeconds = 3;
        public const double ArrivalSeconds = .6;
        private readonly MobileMotionSignalState _target = new MobileMotionSignalState();
        private readonly TransferBooleanObservation _arrival;
        private readonly DeviceDto _device;
        private readonly string _targetId;
        private bool _hasTarget, _canConfirm, _confirmed;
        private double _commandTimestamp;
        public double Value { get; private set; }
        public bool TargetChanged { get; private set; }
        public bool ArrivalChanged { get; private set; }
        public bool Usable { get; private set; }
        public bool Confirmed => Usable && _confirmed;
        public string Reason { get; private set; } = "等待目标工位与到位信号";

        public SimpleStationMotionState(DeviceDto device, string targetId, string arrivalId)
        {
            _device = device; _targetId = targetId;
            var target = device?.DataPoints?.FirstOrDefault(row => row != null && row.Id.ToString(CultureInfo.InvariantCulture) == targetId);
            if (target == null || !string.IsNullOrEmpty(target.DeviceId) && target.DeviceId != device.Id
                || !string.Equals(target.AccessType ?? "READ", "READ", StringComparison.OrdinalIgnoreCase)
                || new[] { "BOOL", "STRING", "CHAR", "DT", "DTZ", "DTL", "DTLZ", "DATE", "TIME", "TOD" }.Contains((target.DataType ?? "").ToUpperInvariant())) return;
            var point = device?.DataPoints?.FirstOrDefault(row => row != null && row.Id.ToString(CultureInfo.InvariantCulture) == arrivalId);
            if (point != null && (string.IsNullOrEmpty(point.DeviceId) || point.DeviceId == device.Id)
                && string.Equals(point.DataType, "BOOL", StringComparison.OrdinalIgnoreCase)
                && string.Equals(point.AccessType ?? "READ", "READ", StringComparison.OrdinalIgnoreCase) && arrivalId != targetId)
                _arrival = new TransferBooleanObservation(device.Id, arrivalId, point.Category ?? "status",
                    string.IsNullOrWhiteSpace(point.ValueRole) ? point.Name : point.ValueRole);
        }
        public bool Receive(JObject frame, double now, double wallNow, double staleMs, Func<double, double, bool> samePhysicalDock = null)
        {
            TargetChanged = ArrivalChanged = false;
            if (_arrival == null) { Suspend("目标须为本设备只读数值，到位须为本设备只读 BOOL"); return false; }
            if (!_target.Receive(_device, frame, _targetId, "", now, wallNow, staleMs, StationInputMeaning.Target))
            { Usable = false; Reason = _target.Reason; return false; }
            _arrival.Receive(frame, now, wallNow);
            if (!_arrival.Advance(now, staleMs)) { Usable = false; Reason = _arrival.Reason; return false; }
            var wasConfirmed = _confirmed;
            TargetChanged = !_hasTarget || Value != _target.Value;
            if (TargetChanged)
            {
                var retainedDock = _hasTarget && wasConfirmed && Usable && samePhysicalDock?.Invoke(Value, _target.Value) == true;
                // A held true bit from the previous dock must not confirm a
                // newly issued target. First startup may establish a real dock.
                _canConfirm = !_hasTarget || retainedDock;
                _confirmed = retainedDock;
                _commandTimestamp = _target.SourceTimestamp;
                Value = _target.Value; _hasTarget = true;
            }
            if (_arrival.Timestamp >= _commandTimestamp)
            {
                // Latch arrival for this target, so a captured arrival pulse
                // works as well as a maintained bit. Only a new target clears
                // the completed trip; a falling pulse is not another journey.
                if (!_arrival.Value) _canConfirm = true;
                else if (_canConfirm) _confirmed = true;
            }
            Usable = true;
            ArrivalChanged = _confirmed && (!wasConfirmed || TargetChanged);
            Reason = _confirmed ? "PLC 到位信号已确认；画面按显示选项对齐" : "目标工位有效，途中仅为示意，等待 PLC 到位";
            return true;
        }
        public bool Advance(double now, double staleMs)
        {
            if (!_target.Advance(now, staleMs, false) || _arrival == null || !_arrival.Advance(now, staleMs))
            { Usable = false; Reason = "目标或到位信号过期，保持当前画面"; }
            return Usable;
        }
        public void Suspend(string reason)
        { Usable = false; Reason = reason; _target.Suspend(reason); _arrival?.Suspend(reason); }
    }
}
