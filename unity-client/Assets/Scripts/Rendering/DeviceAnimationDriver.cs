using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json.Linq;
using UnityEngine;
namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class DeviceAnimationDriver : MonoBehaviour
    {
        private enum ChannelKind { Position, Rotation, Scale, Visibility, Emission, Color }
        private sealed class TrackState
        {
            public CompiledMotionTrack Sampler;
            public Transform Node;
            public Renderer Renderer;
            public ChannelKind Kind;
            public int MaterialSlot;
            public double[] Samples, RestSamples;
            public Vector3 PositionRest, MaximumPositionDisplacement;
            public bool HasSampledValues, HasRotationValue, HasAppliedRotation;
            public double SampleTime;
            public Quaternion RotationInput, RotationRequested, RotationApplied;
            public Vector3 ConveyorAxis;
            public double ConveyorSeconds;
            public int ConveyorSign = 1;
            public bool HasColorSnapshot;
            public Color ColorRequested, PrimaryColorApplied, SecondaryColorApplied, FactorColorApplied;
            public ColorSpace ColorSnapshotSpace;
        }
        private sealed class Entry
        {
            public JObject Binding;
            public string ActionId, DefinitionReason;
            public bool Valid, RunningMode, PresentationOnly, Conveyor;
            public double Duration;
            public TrackState[] Tracks = Array.Empty<TrackState>();
            public readonly Dictionary<string, TrackState> PositionTracks = new Dictionary<string, TrackState>(StringComparer.Ordinal);
            public MotionSignalState Signal = new MotionSignalState();
            public long SignalChangedAt, FirstTransformAt;
            public bool DiagnosticPending;
        }
        private readonly List<Entry> _entries = new List<Entry>();
        private readonly Dictionary<string, Entry> _actionEntries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly Dictionary<string, Transform> _nodes = new Dictionary<string, Transform>();
        private readonly Dictionary<string, JObject> _base = new Dictionary<string, JObject>();
        private double _staleMs = 5000;
        private MaterialPropertyBlock _block;
        private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");
        private static readonly int ColorId = Shader.PropertyToID("_Color");
        private static readonly int BaseColorFactorId = Shader.PropertyToID("baseColorFactor");
        private static readonly int EmissionColorId = Shader.PropertyToID("_EmissionColor");
        private static readonly int EmissiveFactorId = Shader.PropertyToID("emissiveFactor");
#if UNITY_EDITOR
        public long PoseSampleEvaluations { get; private set; }
        public long PropertyBlockApplications { get; private set; }
#endif
        private readonly Dictionary<string, double[]> _restSamples = new Dictionary<string, double[]>();
        // Opt-in, read-only evidence for an isolated player/collector acceptance run.
        // Never enabled by the installer or by an ordinary dashboard account.
        private bool _diagnostics = Environment.GetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS") == "1";
        private double _diagnosticIntervalSeconds = 5;
        private string _deviceId;
        private double _nextDiagnostic;
        private bool _presentationControlled;
        private int _presentationSide;
        public int ActiveBindings => _entries.Count;
        public JObject TransferDiagnostic { get; set; }
        public void SetConveyorTravel(Vector3 worldTravel)
        {
            foreach (var entry in _entries) if (entry.Conveyor) foreach (var track in entry.Tracks) {
                if (track.Kind != ChannelKind.Rotation || track.Node?.parent == null) continue;
                var parent = track.Node.parent;
                // Transport a point on the roller's upper surface, not a guessed
                // model-local sign. This includes authored quaternion axes,
                // glTF handedness, mirrored scale and device/workshop rotation.
                var radial = parent.InverseTransformVector(Vector3.up);
                var tangent = parent.TransformVector(Vector3.Cross(track.ConveyorAxis, radial));
                var dot = Vector3.Dot(tangent.normalized, worldTravel.normalized);
                track.ConveyorSign = worldTravel.sqrMagnitude < .00000001f || Mathf.Abs(dot) < .05f ? 0 : dot > 0 ? 1 : -1;
            }
        }
        public bool TryGetTransferDrive(string actionId, string nodeName, out Transform node, out Vector3 rest,
            out Vector3 maximumDisplacement, out string reason)
        {
            node = null; rest = maximumDisplacement = Vector3.zero; reason = "送料动作未启用";
            if (actionId == null || !_actionEntries.TryGetValue(actionId, out var entry)) return false;
            if (!entry.Valid) { reason = entry.DefinitionReason; return false; }
            if (!entry.Signal.Usable || !entry.Signal.HasSample) { reason = entry.Signal.Reason; return false; }
            if (nodeName == null || !entry.PositionTracks.TryGetValue(nodeName, out var track)) { reason = "送料参考节点不属于该动作的位置通道"; return false; }
            node = track.Node; rest = track.PositionRest; maximumDisplacement = track.MaximumPositionDisplacement;
            reason = "送料动作数据正常"; return maximumDisplacement.sqrMagnitude > .00000001f;
        }
        public void SuspendInputs(string reason = "采集连接中断")
        {
            foreach (var entry in _entries) entry.Signal.Suspend(reason);
        }
        public JObject CaptureEndpointDisplayStates()
        {
            var result = new JObject();
            foreach (var entry in _entries) { var snapshot = entry.Signal.CaptureDisplayState(entry.Binding); if (snapshot != null) result[entry.Binding.Value<string>("actionId")] = snapshot; }
            return result;
        }
        public void RestoreEndpointDisplayStates(JObject snapshots)
        {
            foreach (var entry in _entries)
                if (entry.Signal.RestoreDisplayState(entry.Binding, snapshots?[entry.Binding.Value<string>("actionId")] as JObject)) ApplyEntryPose(entry);
        }
        public void Configure(DeviceDto device, JObject package)
        {
            _deviceId = device.Id;
            _entries.Clear(); _actionEntries.Clear(); _nodes.Clear(); _base.Clear(); _restSamples.Clear();
#if UNITY_EDITOR
            PoseSampleEvaluations = PropertyBlockApplications = 0;
#endif
            if (package == null) return;
            foreach (var node in GetComponentsInChildren<Transform>(true)) if (!_nodes.ContainsKey(node.name)) _nodes[node.name] = node;
            foreach (var row in package["nodes"].OfType<JObject>()) _base[row.Value<string>("name")] = row;
            foreach (var row in _base.Values) if (_nodes.TryGetValue(row.Value<string>("name"), out var node)) node.gameObject.SetActive(row["v"]?[0]?.Value<int>() != 0);
            foreach (var row in _base.Values) foreach(var p in row.Properties()) if(p.Value is JArray a) _restSamples[row.Value<string>("name")+":"+p.Name]=a.Values<double>().ToArray();
            var config = device.InstanceConfigObject?["animationBindings"]; _staleMs = config?.Value<double?>("staleMs") ?? 5000;
            _diagnostics = config?.Value<bool?>("diagnosticLogging") ?? Environment.GetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS") == "1";
            _diagnosticIntervalSeconds = Math.Max(1, Math.Min(60, config?.Value<double?>("diagnosticIntervalSeconds") ?? 5));
            _presentationControlled=config?["transferLink"]?["cycle"]?.Value<bool?>("enabled")==true
                && !HeatTreatment.DigitalTwin.Runtime.SimpleMaterialTransferRuntime.UsesSimpleTransfer(device);
            _presentationSide=0;
            var configured=(config?["bindings"]?.OfType<JObject>()??Enumerable.Empty<JObject>()).ToList();
            if(_presentationControlled)foreach(var name in new[]{"feed","hook","feed_opposite","hook_opposite"})
                configured.Add(new JObject{["actionId"]="clip:"+name,["clipId"]=name,["kind"]="clip",["mode"]="position",["enabled"]=true,["presentationOnly"]=true});
            foreach (var binding in configured)
            {
                if (binding.Value<bool?>("enabled") != true || binding.Value<string>("kind") != "clip") continue;
                if(_presentationControlled&&binding.Value<bool?>("presentationOnly")!=true&&new[]{"clip:feed","clip:hook","clip:feed_opposite","clip:hook_opposite"}.Contains(binding.Value<string>("actionId")))continue;
                var clip = package["clips"].OfType<JObject>().FirstOrDefault(c => c.Value<string>("id") == binding.Value<string>("clipId"));
                if (clip == null) throw new InvalidOperationException("Motion clip missing: " + binding["actionId"]);
                var entry = new Entry { Binding = binding, ActionId = binding.Value<string>("actionId"), RunningMode = binding.Value<string>("mode") == "running", Valid = true,PresentationOnly=binding.Value<bool?>("presentationOnly")==true };
                entry.Conveyor = HeatTreatment.DigitalTwin.Runtime.SimpleMaterialTransferRuntime.UsesSimpleTransfer(device)
                    && entry.RunningMode && new[] { "rollers", "hot_rollers" }.Contains(binding.Value<string>("clipId"));
                var tracks = new List<TrackState>();
                var definitions = clip["tracks"] as JArray;
                if (definitions == null || definitions.Count == 0) { entry.Valid = false; entry.DefinitionReason = "动画轨迹未配置"; }
                foreach (var definition in definitions?.OfType<JObject>() ?? Enumerable.Empty<JObject>())
                {
                    if (!CompiledMotionTrack.TryCompile(clip, definition, out var sampler, out var reason))
                    { entry.Valid = false; entry.DefinitionReason = reason; continue; }
                    if (!_nodes.TryGetValue(sampler.NodeName, out var node))
                    { entry.Valid = false; entry.DefinitionReason = "动画节点未加载：" + sampler.NodeName; continue; }
                    var kind = sampler.Channel == "p" ? ChannelKind.Position : sampler.Channel == "q" ? ChannelKind.Rotation
                        : sampler.Channel == "s" ? ChannelKind.Scale : sampler.Channel == "v" ? ChannelKind.Visibility
                        : sampler.Channel[0] == 'e' ? ChannelKind.Emission : ChannelKind.Color;
                    var state = new TrackState { Sampler = sampler, Node = node, Kind = kind, Samples = new double[sampler.Size] };
                    if (entry.Conveyor && kind == ChannelKind.Rotation) {
                        var a = new double[4]; var b = new double[4];
                        if (sampler.SampleInto(0, a) && sampler.SampleInto(sampler.Duration * .001, b)) {
                            Quaternion Q(double[] v) => new Quaternion((float)v[0], -(float)v[1], -(float)v[2], (float)v[3]).normalized;
                            var step = Q(b) * Quaternion.Inverse(Q(a)); step.ToAngleAxis(out var angle, out var axis);
                            state.ConveyorAxis = Mathf.Abs(angle) < .00001f ? Vector3.zero : axis * (angle > 180 ? -1 : 1);
                        }
                        state.ConveyorSign = 0;
                    }
                    _restSamples.TryGetValue(sampler.NodeName + ":" + sampler.Channel, out state.RestSamples);
                    if (kind == ChannelKind.Emission || kind == ChannelKind.Color)
                    {
                        state.MaterialSlot = int.Parse(sampler.Channel.Substring(1));
                        var renderer = node.GetComponent<Renderer>(); var materials = renderer?.sharedMaterials;
                        if (materials != null && state.MaterialSlot < materials.Length) state.Renderer = renderer;
                        if (kind == ChannelKind.Emission)
                            foreach (var material in materials ?? Array.Empty<Material>()) { material.EnableKeyword("_EMISSIVE"); material.EnableKeyword("_EMISSION"); }
                    }
                    if (kind == ChannelKind.Position)
                    {
                        var p = sampler.PositionRest; var displacement = sampler.MaximumPositionDisplacement;
                        state.PositionRest = new Vector3(-(float)p[0], (float)p[1], (float)p[2]);
                        state.MaximumPositionDisplacement = new Vector3(-(float)displacement[0], (float)displacement[1], (float)displacement[2]);
                        if (!entry.PositionTracks.ContainsKey(sampler.NodeName)) entry.PositionTracks[sampler.NodeName] = state;
                    }
                    entry.Duration = sampler.Duration; tracks.Add(state);
                }
                if (definitions != null && tracks.Count != definitions.Count) { entry.Valid = false; entry.DefinitionReason ??= "动画轨迹定义无效"; }
                entry.Tracks = tracks.ToArray();
                if (!entry.Valid) { entry.Signal.Suspend(entry.DefinitionReason); Debug.LogWarning("[DeviceAnimation] " + _deviceId + "/" + entry.ActionId + ": " + entry.DefinitionReason); }
                _entries.Add(entry);
                if (!string.IsNullOrEmpty(entry.ActionId) && !_actionEntries.ContainsKey(entry.ActionId)) _actionEntries[entry.ActionId] = entry;
            }
        }
        public void ApplyRealtime(JObject data, double? now = null)
        {
            ReceiveInputs(data, now, false);
        }
        public void ApplyMotionInputs(JObject data, double? now = null)
        {
            ReceiveInputs(data, now, true);
        }
        private void ReceiveInputs(JObject data, double? now, bool catalogOnly)
        {
            foreach (var entry in _entries)
            {
                if(entry.PresentationOnly)continue;
                if (!entry.Valid) { entry.Signal.Suspend(entry.DefinitionReason); continue; }
                if (catalogOnly && !MotionSignalState.IsCatalogBinding(entry.Binding)) continue;
                var priorTarget=entry.Signal.Target; var priorUsable=entry.Signal.Usable; var priorSample=entry.Signal.HasSample;
                entry.Signal.Receive(data, entry.Binding, now ?? Time.realtimeSinceStartupAsDouble,
                    now.HasValue ? (double?)null : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                if (_diagnostics && (priorTarget!=entry.Signal.Target || priorUsable!=entry.Signal.Usable || priorSample!=entry.Signal.HasSample))
                { entry.SignalChangedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); entry.FirstTransformAt=0; entry.DiagnosticPending=true; }
            }
        }
        private void Update() { Advance(Time.unscaledDeltaTime, Time.realtimeSinceStartupAsDouble); }
        public void Advance(double delta, double now)
        {
            using var work = HeatTreatment.DigitalTwin.Runtime.RuntimeWorkMetrics.Measure(HeatTreatment.DigitalTwin.Runtime.RuntimeWorkMetrics.Section.ClipAdvance);
            var eventDiagnostic=false;
            foreach (var entry in _entries)
            {
                if(entry.PresentationOnly)continue;
                var priorPosition=entry.Signal.Position; var priorSeconds=entry.Signal.Seconds;
                var signal = entry.Signal; signal.Step(delta, now, _staleMs, entry.Binding);
                if (!signal.HasSample || !signal.Usable) continue;
                if (entry.Conveyor) foreach (var track in entry.Tracks)
                    track.ConveyorSeconds += (signal.Seconds - priorSeconds) * track.ConveyorSign;
                ApplyEntryPose(entry);
                // Timestamp the first actual phase/transform application after a target
                // change, not the test process's later log polling time.
                if (entry.DiagnosticPending && (signal.Position!=priorPosition || signal.Seconds!=priorSeconds || !signal.Usable || signal.Position==signal.Target))
                { entry.FirstTransformAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); entry.DiagnosticPending=false; eventDiagnostic=true; }
            }
            if (_diagnostics && eventDiagnostic) Debug.Log("[DeviceAnimation] " + CaptureDiagnostic().ToString(Newtonsoft.Json.Formatting.None));
            if (_diagnostics && _entries.Count > 0 && now >= _nextDiagnostic)
            {
                _nextDiagnostic = now + _diagnosticIntervalSeconds;
                Debug.Log("[DeviceAnimation] " + CaptureDiagnostic().ToString(Newtonsoft.Json.Formatting.None));
            }
        }
        private void ApplyEntryPose(Entry entry)
        {
            var signal = entry.Signal;
            if (!entry.Valid) return;
            var running = entry.RunningMode; var duration = entry.Duration;
            var time = running ? signal.Seconds % duration : signal.Position * duration;
            if (double.IsNaN(time) || double.IsInfinity(time)) { signal.Suspend("动画采样时间无效"); return; }
            ApplyEntryPoseAt(entry,time,running&&!signal.Running);
        }
        private void ApplyEntryPoseAt(Entry entry,double time,bool effectsOff=false)
        {
            foreach (var track in entry.Tracks)
            {
                var sampleTime = entry.Conveyor && track.Kind == ChannelKind.Rotation
                    ? ((track.ConveyorSeconds % entry.Duration) + entry.Duration) % entry.Duration : time;
                var off = effectsOff && (track.Kind == ChannelKind.Visibility || track.Kind == ChannelKind.Emission || track.Kind == ChannelKind.Color);
                var values = off ? track.RestSamples : track.Samples;
                // Keep checking source freshness and the actual native pose on
                // every frame. Only typed sampling at an identical time is
                // redundant; a stopped visual may not have been sampled yet.
                if (!off && (!track.HasSampledValues || !track.SampleTime.Equals(sampleTime)))
                {
#if UNITY_EDITOR
                    PoseSampleEvaluations++;
#endif
                    if (!track.Sampler.SampleInto(sampleTime, values)) { entry.Signal.Suspend("动画采样数据无效"); return; }
                    track.SampleTime = sampleTime; track.HasSampledValues = true;
                }
                if (values != null) ApplyChannel(track, values);
            }
        }
        public bool SetTransferPresentation(int side,double feed,double hook,out string reason)
        {
            reason="双侧同源动作包尚未配置";
            if(!_presentationControlled||!double.IsFinite(feed)||!double.IsFinite(hook)||feed<0||feed>1||hook<0||hook>1)return false;
            var suffix=side<0?"_opposite":"";
            if(!_actionEntries.TryGetValue("clip:feed"+suffix,out var f)||!f.Valid||!_actionEntries.TryGetValue("clip:hook"+suffix,out var h)||!h.Valid)return false;
            if(_presentationSide!=side){
                foreach(var name in new[]{"feed","hook","feed_opposite","hook_opposite"})if(_actionEntries.TryGetValue("clip:"+name,out var entry)&&entry.Valid)ApplyEntryPoseAt(entry,0);
                _presentationSide=side;
            }
            ApplyEntryPoseAt(f,feed*f.Duration);ApplyEntryPoseAt(h,hook*h.Duration);
            if(_nodes.TryGetValue("preview_feed_primary",out var primary))primary.gameObject.SetActive(side>=0);
            if(_nodes.TryGetValue("preview_feed_opposite",out var opposite))opposite.gameObject.SetActive(side<0);
            reason="双侧同源动作包显示估算";return true;
        }
        public bool TryGetPresentationDrive(int side,out Transform node,out Vector3 rest,out Vector3 maximum)
        {
            node=null;rest=maximum=Vector3.zero;
            var action="clip:feed"+(side<0?"_opposite":"");var name=(side<0?"opposite__":"")+"cad_transfer_cart_v1_feed_carriage";
            if(!_presentationControlled||!_actionEntries.TryGetValue(action,out var entry)||!entry.Valid||!entry.PositionTracks.TryGetValue(name,out var track))return false;
            node=track.Node;rest=track.PositionRest;maximum=track.MaximumPositionDisplacement;return node!=null;
        }
        public JObject CaptureDiagnostic()
        {
            var actions = new JArray();
            foreach (var entry in _entries)
            {
                var tracks = new JArray();
                foreach (var track in entry.Tracks)
                {
                    var name = track.Sampler.NodeName; var channel = track.Sampler.Channel;
                    var node = track.Node; var values = new JArray();
                    if (channel == "p") values = new JArray(node.localPosition.x, node.localPosition.y, node.localPosition.z);
                    else if (channel == "q") values = new JArray(node.localRotation.x, node.localRotation.y, node.localRotation.z, node.localRotation.w);
                    else if (channel == "s") values = new JArray(node.localScale.x, node.localScale.y, node.localScale.z);
                    else if (channel == "v") values = new JArray(node.gameObject.activeSelf ? 1 : 0);
                    else if (int.TryParse(channel.Substring(1), out var slot))
                    {
                        var renderer = node.GetComponent<Renderer>();
                        if (renderer == null || slot >= renderer.sharedMaterials.Length)
                            throw new InvalidOperationException("Motion material renderer missing: " + name + "/" + channel);
                        var block = new MaterialPropertyBlock(); renderer.GetPropertyBlock(block, slot);
                        var color = block.GetColor(channel[0] == 'e' ? "emissiveFactor" : "baseColorFactor");
                        values = new JArray(color.r, color.g, color.b, color.a);
                    }
                    tracks.Add(new JObject { ["node"] = name, ["channel"] = channel, ["actual"] = values });
                }
                actions.Add(new JObject { ["actionId"] = entry.Binding["actionId"], ["clipId"] = entry.Binding["clipId"],
                    ["conveyorDirections"] = entry.Conveyor ? new JArray(entry.Tracks.Where(track => track.Kind == ChannelKind.Rotation).Select(track => track.ConveyorSign)) : null,
                    ["target"] = entry.Signal.Target, ["sourceTimestamp"] = entry.Signal.SourceTimestamp, ["signalChangedAt"] = entry.SignalChangedAt, ["firstTransformAt"] = entry.FirstTransformAt,
                    ["usable"] = entry.Signal.Usable, ["running"] = entry.Signal.Running,
                    ["reason"] = entry.Signal.Reason, ["endpointStage"] = entry.Signal.EndpointStage, ["position"] = entry.Signal.Position, ["seconds"] = entry.Signal.Seconds, ["tracks"] = tracks });
            }
            return new JObject { ["capturedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["deviceId"] = _deviceId, ["actions"] = actions,
                ["partActions"] = GetComponent<ModelBindingDriver>()?.CaptureDiagnosticActions() ?? new JArray(),
                ["transferLink"] = TransferDiagnostic?.DeepClone() };
        }
        private void ApplyChannel(TrackState track, double[] v)
        {
            var target = track.Node;
            // glTFast mirrors X from glTF's right-handed coordinates.
            // Equals compares each Float32 field exactly; Unity's approximate
            // vector/quaternion == would suppress small real PLC movements.
            if (track.Kind == ChannelKind.Position)
            {
                var position = new Vector3(-(float)v[0], (float)v[1], (float)v[2]);
                if (!target.localPosition.Equals(position)) target.localPosition = position;
            }
            else if (track.Kind == ChannelKind.Rotation)
            {
                var input = new Quaternion((float)v[0], -(float)v[1], -(float)v[2], (float)v[3]);
                if (!track.HasRotationValue || !track.RotationInput.Equals(input))
                {
                    track.RotationInput = input; track.RotationRequested = input.normalized;
                    track.HasRotationValue = true; track.HasAppliedRotation = false;
                }
                var actual = target.localRotation;
                // The native setter can normalize again. Remember its exact
                // result, but reread it to detect external inspection edits.
                if (track.HasAppliedRotation && actual.Equals(track.RotationApplied)) return;
                if (!actual.Equals(track.RotationRequested))
                { target.localRotation = track.RotationRequested; actual = target.localRotation; }
                track.RotationApplied = actual; track.HasAppliedRotation = true;
            }
            else if (track.Kind == ChannelKind.Scale)
            {
                var scale = new Vector3((float)v[0], (float)v[1], (float)v[2]);
                if (!target.localScale.Equals(scale)) target.localScale = scale;
            }
            else if (track.Kind == ChannelKind.Visibility)
            {
                var visible = v[0] > .5;
                if (target.gameObject.activeSelf != visible) target.gameObject.SetActive(visible);
            }
            else
            {
                var renderer = track.Renderer; var slot = track.MaterialSlot; if (renderer == null) return;
                _block ??= new MaterialPropertyBlock(); renderer.GetPropertyBlock(_block, slot);
                var colorSpace = QualitySettings.activeColorSpace;
                if (track.Kind == ChannelKind.Emission)
                {
                    var emission = new Color((float)(v[0]*v[3]), (float)(v[1]*v[3]), (float)(v[2]*v[3]));
                    if (track.HasColorSnapshot && track.ColorSnapshotSpace == colorSpace && track.ColorRequested.Equals(emission)
                        && HasExactColor(_block, EmissionColorId, track.PrimaryColorApplied)
                        && HasExactColor(_block, EmissiveFactorId, track.SecondaryColorApplied)) return;
                    _block.SetColor(EmissionColorId, emission); _block.SetColor(EmissiveFactorId, emission);
                    track.ColorRequested = emission;
                    track.PrimaryColorApplied = _block.GetColor(EmissionColorId); track.SecondaryColorApplied = _block.GetColor(EmissiveFactorId);
                }
                else
                {
                    var color = new Color((float)v[0], (float)v[1], (float)v[2], (float)v[3]);
                    if (track.HasColorSnapshot && track.ColorSnapshotSpace == colorSpace && track.ColorRequested.Equals(color)
                        && HasExactColor(_block, BaseColorId, track.PrimaryColorApplied)
                        && HasExactColor(_block, ColorId, track.SecondaryColorApplied)
                        && HasExactColor(_block, BaseColorFactorId, track.FactorColorApplied)) return;
                    _block.SetColor(BaseColorId, color); _block.SetColor(ColorId, color); _block.SetColor(BaseColorFactorId, color);
                    track.ColorRequested = color;
                    track.PrimaryColorApplied = _block.GetColor(BaseColorId); track.SecondaryColorApplied = _block.GetColor(ColorId);
                    track.FactorColorApplied = _block.GetColor(BaseColorFactorId);
                }
                // Linear SetColor/GetColor can round-trip to slightly different
                // Float32 fields. Compare future frames to these native values,
                // not a tolerance or the original gamma-space request.
                track.ColorSnapshotSpace = colorSpace; track.HasColorSnapshot = true;
                // Preserve properties supplied by other owners. A missing
                // alias is not equivalent to an explicitly authored black.
                renderer.SetPropertyBlock(_block,slot);
#if UNITY_EDITOR
                PropertyBlockApplications++;
#endif
            }
        }
        private static bool HasExactColor(MaterialPropertyBlock block, int property, Color color)
            => block.HasColor(property) && block.GetColor(property).Equals(color);
    }
}
