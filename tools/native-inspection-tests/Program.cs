using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

var passed = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new InvalidOperationException(name);
    passed++;
    Console.WriteLine($"PASS {name}");
}
bool Close(float a, float b) => Math.Abs(a - b) < .00005f;

var legacy = JsonConvert.DeserializeObject<DeviceInspectionConfigDto>("{\"parts\":[{\"node_name\":\"Fan\"}]}");
legacy.Normalize();
Check(legacy.OffsetSpace == "parent", "legacy missing offset_space retains parent coordinates");
Check(legacy.Parts[0].Camera == null, "part camera=null retains automatic framing");
var config = JsonConvert.DeserializeObject<DeviceInspectionConfigDto>(@"{
  'version':2,'offset_space':'model','shell_duration':2,'animation_duration':2,'stagger':0.25,'playback_speed':2.25,'easing':'linear',
  'labels':{'enabled':true,'leader_lines':false},
  'shell':{'transition':'clip','axis':'z','direction':-1,'node_names':['Cover','cover',' Cover ']},
  'parts':[
    {'id':'one','node_names':['Motor','motor','Motor'],'explode_rotation':[0,90,0],'group':'Drive','point_keys':['status.Run','status.run']},
    {'id':'off','enabled':false,'node_name':'Disabled','duration':9,'delay':9},
    {'id':'two','node_paths':['Assembly#0/Blade#1'],'delay':0.5,'duration':1,'camera':{'yaw':100,'pitch':15,'distance_scale':1}}
  ]
}");
config.Normalize();
Check(config.OffsetSpace == "model" && config.Version == 2, "v2 model coordinate system survives normalization");
Check(config.Shell.NodeNames.SequenceEqual(new[] { "Cover", "cover", " Cover " }), "GLB names remain opaque and case-sensitive");
Check(config.Parts[0].NodeNames.SequenceEqual(new[] { "Motor", "motor" }), "multi-target names deduplicate ordinally");
Check(config.Parts[0].PointKeys.Count == 2 && config.Parts[0].Group == "Drive", "case-sensitive PLC links and groups survive");
Check(config.Shell.Direction == -1 && config.Shell.Axis == "z" && !config.Labels.LeaderLines, "shell and label authoring preserved");
Check(Close(config.PlaybackSpeed, 2.25f), "saved playback speed is loaded by the native contract");
Check(config.Parts[1].Enabled == false && config.Parts[2].Camera.Yaw == 100, "disabled parts and authored part cameras preserved");
Check(Close(InspectionTimeline.Duration(config), 4), "duration excludes disabled part and uses enabled-part stagger order");
Check(Close(InspectionTimeline.PartStart(config, config.Parts[2], 1), 2.75f), "per-part start includes shell, enabled stagger and authored delay");
Check(Close(InspectionTimeline.ShellProgress(config, 1), .5f), "staged shell reveals before expansion");
Check(Close(InspectionTimeline.PartProgress(config, config.Parts[0], 0, 1.99f), 0), "parts remain assembled throughout shell phase");
Check(Close(InspectionTimeline.PartProgress(config, config.Parts[0], 0, 3), .5f), "fallback duration drives authored part progress");
Check(Close(InspectionTimeline.PartProgress(config, config.Parts[2], 1, 3.25f), .5f), "custom delay and duration are honored");
Check(Close(InspectionTimeline.PartProgress(config, config.Parts[0], 0, 4), 1), "last frame is precisely the authored endpoint");
var clock = 0f;
for (var index = 0; index < 317; index++) clock = InspectionTimeline.Advance(clock, 4, .01f);
var midwayPose = InspectionTimeline.PartProgress(config, config.Parts[0], 0, clock);
clock = InspectionTimeline.Advance(clock, 0, .2f);
Check(InspectionTimeline.PartProgress(config, config.Parts[0], 0, clock) < midwayPose, "mid-transition reverse immediately walks back the same curve");
for (var index = 0; index < 500; index++) clock = InspectionTimeline.Advance(clock, 0, .01f);
Check(clock == 0 && InspectionTimeline.PartProgress(config, config.Parts[0], 0, clock) == 0, "reverse assembly terminates without drift or reset");
Check(InspectionTimeline.Advance(2, 4, 0) == 2 && InspectionTimeline.Advance(2, 4, float.NaN) == 2, "paused or invalid clock steps do not advance");
foreach (var easing in new[] { "linear", "smoothstep", "cubic" })
{
    var previous = -1f;
    for (var index = 0; index <= 100; index++)
    {
        var value = InspectionTimeline.Ease(index / 100f, easing);
        if (value < previous || value < 0 || value > 1) throw new InvalidOperationException("easing monotonicity");
        previous = value;
    }
    Check(InspectionTimeline.Ease(-1, easing) == 0 && InspectionTimeline.Ease(2, easing) == 1, $"{easing} easing is monotonic and clamps endpoints");
    Check(Close(InspectionTimeline.Ease(.27f, easing), 1 - InspectionTimeline.Ease(.73f, easing)), $"{easing} reverse symmetry");
}
var clone = JsonConvert.DeserializeObject<DeviceInspectionConfigDto>(JsonConvert.SerializeObject(config));
clone.Normalize();
Check(JToken.DeepEquals(JObject.FromObject(config), JObject.FromObject(clone)), "normalize/serialize/reload retains v2 canonical behavior");
config.ShellDuration = 0;
Check(InspectionTimeline.ShellProgress(config, 0) == 0 && InspectionTimeline.ShellProgress(config, .01f) == 1, "zero shell duration is deterministic at assembled boundary");
config.AnimationDuration = float.PositiveInfinity;
config.Stagger = 99;
config.PlaybackSpeed = 99;
config.Parts[0].Duration = .001f;
config.Normalize();
Check(config.AnimationDuration == 1.5f && config.Stagger == 1 && config.PlaybackSpeed == 3 && config.Parts[0].Duration == .05f, "invalid and out-of-range numeric configuration is bounded");
var bindings = new JArray
{
    new JObject { ["id"] = "fan-run", ["node_name"] = "Fan", ["source_group"] = "motors", ["source_key"] = "Run" },
    new JObject { ["id"] = "fan-speed", ["node_name"] = "Fan", ["source_group"] = "analog", ["source_key"] = "Speed" }
};
var asset = new ModelAssetDto { Metadata = new JObject { ["partBindings"] = bindings } };
var inferred = InspectionConfigResolver.Resolve(asset, null);
Check(inferred.Parts.Count == 1 && inferred.Parts[0].Id == "fan-run" && inferred.Parts[0].PointKeys.Count == 2, "fallback merges same-node PLC bindings without inventing duplicate assemblies");
asset.MetadataObject["inspection"] = new JObject { ["parts"] = new JArray() };
Check(InspectionConfigResolver.Resolve(asset, null).Parts.Count == 0, "explicitly empty authoring is not repopulated from PLC bindings");
Console.WriteLine($"Native inspection contract: {passed} checks passed.");
