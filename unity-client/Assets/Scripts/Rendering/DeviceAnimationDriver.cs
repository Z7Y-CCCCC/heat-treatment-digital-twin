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
        private sealed class Entry { public JObject Binding, Clip; public MotionSignalState Signal = new MotionSignalState(); public long SignalChangedAt, FirstTransformAt; public bool DiagnosticPending; }
        private readonly List<Entry> _entries = new List<Entry>();
        private readonly Dictionary<string, Transform> _nodes = new Dictionary<string, Transform>();
        private readonly Dictionary<string, JObject> _base = new Dictionary<string, JObject>();
        private double _staleMs = 5000;
        private MaterialPropertyBlock _block;
        private readonly Dictionary<JObject, double[]> _samples = new Dictionary<JObject, double[]>();
        private readonly Dictionary<string, double[]> _restSamples = new Dictionary<string, double[]>();
        // Opt-in, read-only evidence for an isolated player/collector acceptance run.
        // Never enabled by the installer or by an ordinary dashboard account.
        private readonly bool _diagnostics = Environment.GetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS") == "1";
        private string _deviceId;
        private double _nextDiagnostic;
        public int ActiveBindings => _entries.Count;
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
            _entries.Clear(); _nodes.Clear(); _base.Clear(); _samples.Clear(); _restSamples.Clear();
            if (package == null) return;
            foreach (var node in GetComponentsInChildren<Transform>(true)) if (!_nodes.ContainsKey(node.name)) _nodes[node.name] = node;
            foreach (var row in package["nodes"].OfType<JObject>()) _base[row.Value<string>("name")] = row;
            foreach (var row in _base.Values) if (_nodes.TryGetValue(row.Value<string>("name"), out var node)) node.gameObject.SetActive(row["v"]?[0]?.Value<int>() != 0);
            foreach (var row in _base.Values) foreach(var p in row.Properties()) if(p.Value is JArray a) _restSamples[row.Value<string>("name")+":"+p.Name]=a.Values<double>().ToArray();
            var config = device.InstanceConfigObject?["animationBindings"]; _staleMs = config?.Value<double?>("staleMs") ?? 5000;
            foreach (var binding in config?["bindings"]?.OfType<JObject>() ?? Enumerable.Empty<JObject>())
            {
                if (binding.Value<bool?>("enabled") != true || binding.Value<string>("kind") != "clip") continue;
                var clip = package["clips"].OfType<JObject>().FirstOrDefault(c => c.Value<string>("id") == binding.Value<string>("clipId"));
                if (clip == null) throw new InvalidOperationException("Motion clip missing: " + binding["actionId"]);
                foreach (var track in clip["tracks"].OfType<JObject>()) if (!_nodes.ContainsKey(track.Value<string>("node"))) throw new InvalidOperationException("Motion rig node missing: " + track["node"]);
                foreach (var track in clip["tracks"].OfType<JObject>()) _samples[track] = new double[track.Value<int>("size")];
                foreach (var track in clip["tracks"].OfType<JObject>().Where(t => t.Value<string>("channel").StartsWith("e")))
                    foreach(var material in _nodes[track.Value<string>("node")].GetComponent<Renderer>()?.sharedMaterials ?? Array.Empty<Material>()) { material.EnableKeyword("_EMISSIVE"); material.EnableKeyword("_EMISSION"); }
                _entries.Add(new Entry { Binding = binding, Clip = clip });
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
                if (catalogOnly && !MotionSignalState.IsCatalogBinding(entry.Binding)) continue;
                var priorTarget=entry.Signal.Target; var priorUsable=entry.Signal.Usable; var priorSample=entry.Signal.HasSample;
                entry.Signal.Receive(data, entry.Binding, now ?? Time.realtimeSinceStartupAsDouble);
                if (_diagnostics && (priorTarget!=entry.Signal.Target || priorUsable!=entry.Signal.Usable || priorSample!=entry.Signal.HasSample))
                { entry.SignalChangedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); entry.FirstTransformAt=0; entry.DiagnosticPending=true; }
            }
        }
        private void Update() { Advance(Time.deltaTime, Time.realtimeSinceStartupAsDouble); }
        public void Advance(double delta, double now)
        {
            var eventDiagnostic=false;
            foreach (var entry in _entries)
            {
                var priorPosition=entry.Signal.Position; var priorSeconds=entry.Signal.Seconds;
                var signal = entry.Signal; signal.Step(delta, now, _staleMs, entry.Binding);
                if (!signal.HasSample || !signal.Usable) continue;
                ApplyEntryPose(entry);
                // Timestamp the first actual phase/transform application after a target
                // change, not the test process's later log polling time.
                if (entry.DiagnosticPending && (signal.Position!=priorPosition || signal.Seconds!=priorSeconds || !signal.Usable || signal.Position==signal.Target))
                { entry.FirstTransformAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); entry.DiagnosticPending=false; eventDiagnostic=true; }
            }
            if (_diagnostics && eventDiagnostic) Debug.Log("[DeviceAnimation] " + CaptureDiagnostic().ToString(Newtonsoft.Json.Formatting.None));
            if (_diagnostics && _entries.Count > 0 && now >= _nextDiagnostic)
            {
                _nextDiagnostic = now + .5;
                Debug.Log("[DeviceAnimation] " + CaptureDiagnostic().ToString(Newtonsoft.Json.Formatting.None));
            }
        }
        private void ApplyEntryPose(Entry entry)
        {
            var signal = entry.Signal;
            var running = entry.Binding.Value<string>("mode") == "running"; var duration = entry.Clip.Value<double>("duration");
            var time = running ? signal.Seconds % duration : signal.Position * duration;
            foreach (var track in entry.Clip["tracks"].OfType<JObject>())
            {
                var name = track.Value<string>("node"); var channel = track.Value<string>("channel");
                var off = running && !signal.Running && (channel == "v" || channel.StartsWith("e") || channel.StartsWith("c"));
                var values = _samples[track];
                if (off) _restSamples.TryGetValue(name + ":" + channel, out values);
                else MotionSignalState.SampleInto(entry.Clip, track, time, values);
                if (values != null) ApplyChannel(name, channel, values);
            }
        }
        public JObject CaptureDiagnostic()
        {
            var actions = new JArray();
            foreach (var entry in _entries)
            {
                var tracks = new JArray();
                foreach (var track in entry.Clip["tracks"].OfType<JObject>())
                {
                    var name = track.Value<string>("node"); var channel = track.Value<string>("channel");
                    var node = _nodes[name]; var values = new JArray();
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
                    ["target"] = entry.Signal.Target, ["sourceTimestamp"] = entry.Signal.SourceTimestamp, ["signalChangedAt"] = entry.SignalChangedAt, ["firstTransformAt"] = entry.FirstTransformAt,
                    ["usable"] = entry.Signal.Usable, ["running"] = entry.Signal.Running,
                    ["reason"] = entry.Signal.Reason, ["endpointStage"] = entry.Signal.EndpointStage, ["position"] = entry.Signal.Position, ["seconds"] = entry.Signal.Seconds, ["tracks"] = tracks });
            }
            return new JObject { ["capturedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["deviceId"] = _deviceId, ["actions"] = actions,
                ["partActions"] = GetComponent<ModelBindingDriver>()?.CaptureDiagnosticActions() ?? new JArray() };
        }
        private void ApplyChannel(string name, string channel, double[] v)
        {
            var target = _nodes[name];
            // glTFast mirrors X from glTF's right-handed coordinates.
            if (channel == "p") target.localPosition = new Vector3(-(float)v[0], (float)v[1], (float)v[2]);
            else if (channel == "q") target.localRotation = new Quaternion((float)v[0], -(float)v[1], -(float)v[2], (float)v[3]).normalized;
            else if (channel == "s") target.localScale = new Vector3((float)v[0], (float)v[1], (float)v[2]);
            else if (channel == "v") target.gameObject.SetActive(v[0] > .5);
            else if (int.TryParse(channel.Substring(1), out var slot))
            {
                var renderer = target.GetComponent<Renderer>(); if (renderer == null || slot >= renderer.sharedMaterials.Length) return;
                _block ??= new MaterialPropertyBlock(); renderer.GetPropertyBlock(_block, slot);
                if (channel[0] == 'e') {var emission=new Color((float)(v[0]*v[3]), (float)(v[1]*v[3]), (float)(v[2]*v[3]));_block.SetColor("_EmissionColor",emission);_block.SetColor("emissiveFactor",emission);}
                else { var color = new Color((float)v[0],(float)v[1],(float)v[2],(float)v[3]); _block.SetColor("_BaseColor",color); _block.SetColor("_Color",color); _block.SetColor("baseColorFactor",color); }
                renderer.SetPropertyBlock(_block,slot);
            }
        }
    }
}
