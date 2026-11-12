using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static FactoryConfigDto RefreshFixture() => JsonConvert.DeserializeObject<FactoryConfigDto>("{factoryId:'one',settings:{factory_name:'Factory'},models:[{id:'m',file_path:'/assets/a.glb',metadata:{optimization:{mode:'off'}}}],platform:{activeScene:{id:'scene'},document:{scene:{views:[]}}},workshops:[{id:'w',name:'Workshop',layout_json:{},lines:[{id:'l',name:'Line',layout_json:{},devices:[{id:'a',name:'A',line_id:'l',model_type:'m',pos_x:4,instance_config:{movement:{enabled:false},animationBindings:{bindings:[]}},dataPoints:[]},{id:'b',name:'B',line_id:'l',model_type:'m',pos_x:8}]}]}]}");
    private static T CopyRefresh<T>(T value) => JsonConvert.DeserializeObject<T>(JsonConvert.SerializeObject(value));
    private static Task ConfigurationRefreshIsScoped()
    {
        var before = RefreshFixture(); var after = CopyRefresh(before); var original = JsonConvert.SerializeObject(before);
        Check(ConfigurationRefreshPolicy.CanApplyInPlace(before, after), "Identical configuration still requires a scene rebuild");
        Check(!ConfigurationRefreshPolicy.ActionUpdateRequired(before, after), "No-op save invented a model update");
        var a = ModelHotRefreshPolicy.Devices(after).First(); a.Name = "Renamed"; a.PositionX = 15;
        a.DataPoints.Add(new DataPointDto { Id = 1, DeviceId = "a", Name = "new", Category = "analog", ValueRole = "temperature" });
        a.InstanceConfig = JObject.Parse("{movement:{enabled:false,maxSpeed:3},animationBindings:{bindings:[]}}");
        after.Workshops[0].Name = "Renamed workshop"; after.Workshops[0].Lines[0].Name = "Renamed line";
        after.Settings["factory_name"] = "Renamed factory"; after.Platform["document"]["version"] = 2;
        Check(ConfigurationRefreshPolicy.CanApplyInPlace(before, after), "Names, point definitions, device transforms or display publishing rebuilt the scene");
        Check(!ConfigurationRefreshPolicy.ActionUpdateRequired(before, after), "Movement/point edit invalidated model data");
        Check(!ConfigurationRefreshPolicy.SamePlacement(ModelHotRefreshPolicy.Devices(before).First(), a), "Saved transform changes were lost");
        a.InstanceConfigObject["animationBindings"]["bindings"] = new JArray(JObject.Parse("{actionId:'clip:door'}"));
        Check(ConfigurationRefreshPolicy.ActionUpdateRequired(before, after), "Action changes were ignored");
        var retained = ConfigurationRefreshPolicy.InstanceWithoutActionUpdate(ModelHotRefreshPolicy.Devices(before).First(), a);
        Check(retained["animationBindings"]["bindings"].Count() == 0 && retained["movement"].Value<int>("maxSpeed") == 3, "A staged action update overwrote current inputs or lost movement");
        Check(JsonConvert.SerializeObject(before) == original, "Planning modified the active configuration");
        foreach (var mutate in new Action<FactoryConfigDto>[] {
            c=>c.FactoryId="other", c=>c.Platform["activeScene"]["id"]="other", c=>c.Settings["native_environment_config"]="{width:30}",
            c=>c.Workshops[0].Layout=JObject.Parse("{width:40}"), c=>c.Workshops[0].Lines[0].Layout=JObject.Parse("{offset:3}"),
            c=>c.Workshops[0].Lines.Add(new LineDto{Id="new"}), c=>c.Workshops[0].Lines[0].Devices.RemoveAt(0),
            c=>c.Workshops[0].Lines[0].Devices.Add(CopyRefresh(c.Workshops[0].Lines[0].Devices[0])), c=>c.Workshops[0].Lines[0].Devices[0].ModelType="other"
        }) { var structural = CopyRefresh(before); mutate(structural); Check(!ConfigurationRefreshPolicy.CanApplyInPlace(before, structural), "A structural edit was silently ignored"); }
        var nullScene = CopyRefresh(before); nullScene.Platform["activeScene"] = JValue.CreateNull();
        Check(!ConfigurationRefreshPolicy.CanApplyInPlace(before, nullScene), "Changing to no active scene was ignored");
        var representation = CopyRefresh(before); var old = ModelHotRefreshPolicy.Devices(before).First(); var normalized = ModelHotRefreshPolicy.Devices(representation).First();
        normalized.InstanceConfig = new JValue(normalized.InstanceConfigObject.ToString());
        Check(ConfigurationRefreshPolicy.SameDevice(old, normalized), "String/object representation tails created a fake device edit");
        return Task.CompletedTask;
    }
    private static Task GeometryCacheIsStable()
    {
        var asset = new ModelAssetDto { Id = "m", FilePath = "/assets/a.glb", Metadata = JObject.Parse("{optimization:{mode:'off',mergeStatic:false},sourceAsset:{sha256:'source'},partBindings:[{node_name:'door'}],note:'old'}"),
            MotionPackage = JObject.Parse("{sourceSha256:'source',rigPath:'/assets/motions/rig.glb',rigSha256:'rig',clipPath:'/assets/motions/clips.json',clipSha256:'clips-one'}") };
        string Key(ModelAssetDto value, bool motion = false, params string[] nodes) => ModelCacheIdentity.GeometryKey(value, value.Id, motion, motion, nodes);
        var key = Key(asset, false, "door", "fan"); var changed = CopyRefresh(asset);
        changed.Metadata = JObject.Parse("{note:'new',sourceAsset:{sha256:'source'},partBindings:[{node_name:'door',output_max:3}],optimization:{mergeStatic:false,mode:'off'}}"); changed.Name = "renamed"; changed.DefaultScale = 2;
        Check(Key(changed, false, "fan", "door", "fan") == key, "Names, action parameters or property/protection order caused a geometry cache miss");
        Check(Key(changed, false, "new-door") != key, "Changed protected node set reused optimized geometry");
        var motionKey = Key(asset, true); changed.MotionPackage["clipSha256"] = "clips-two"; changed.MotionPackage["clipPath"] = "/assets/motions/new.json";
        Check(Key(changed, true) == motionKey, "Track JSON update imported the same rig again");
        changed.MotionPackage["rigSha256"] = "changed-rig"; Check(Key(changed, true) != motionKey, "A changed rig reused old geometry");
        changed = CopyRefresh(asset); changed.MetadataObject["optimization"]["mergeStatic"] = true; Check(Key(changed, false, "door", "fan") != key, "Changed geometry optimization reused its previous template");
        changed = CopyRefresh(asset); changed.MotionPackage = null; Check(Key(changed, false, "door", "fan") != key, "Losing a verified source association retained stale geometry");
        var before = JsonConvert.SerializeObject(asset); Key(asset, true); Check(JsonConvert.SerializeObject(asset) == before, "Cache identity calculation rewrote model metadata");
        var annotations = RefreshFixture(); var next = CopyRefresh(annotations); next.Models[0].MetadataObject["note"] = "non-rendering edit";
        ModelHotRefreshPolicy.Merge(annotations, next, out var affected); Check(affected.Count == 0, "An annotation selected every instance for replacement");
        var motionBefore = RefreshFixture(); motionBefore.Models[0] = CopyRefresh(asset);
        ModelHotRefreshPolicy.Devices(motionBefore).First().InstanceConfigObject["animationBindings"] = JObject.Parse("{bindings:[{kind:'clip',enabled:true,clipId:'door'}]}");
        var motionAfter = CopyRefresh(motionBefore); motionAfter.Models[0].MotionPackage["clipSha256"] = "new-clips";
        ModelHotRefreshPolicy.Merge(motionBefore, motionAfter, out var motionAffected);
        Check(motionAffected.SetEquals(new[] { "a" }), "Track-only changes replaced static instances that do not use motion");
        return Task.CompletedTask;
    }
}
