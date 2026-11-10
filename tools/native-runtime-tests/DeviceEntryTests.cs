using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static JObject EntryContext(string mode) => new JObject
    {
        ["factoryId"] = "factory-a", ["sceneId"] = "scene-a", ["sceneReady"] = true,
        ["viewId"] = mode + "-custom-entry", ["viewMode"] = mode, ["viewName"] = "Original " + mode,
        ["workshopId"] = mode == "factory" ? "" : "workshop-original",
        ["lineId"] = mode == "line" ? "line-original" : ""
    };

    private static Task DeviceEntryReturnsToSource()
    {
        foreach (var mode in new[] { "factory", "workshop", "line" })
        {
            var navigation = new DeviceEntryNavigation<string>();
            var context = EntryContext(mode);
            Check(navigation.Capture(context, "camera-rendered-before-entry"), "valid entry was not recorded");
            context["viewId"] = "mutated-caller";
            var device = EntryContext("device"); device["deviceId"] = "device-one";
            device["workshopId"] = "device-actual-workshop"; device["lineId"] = "device-actual-line";
            navigation.Observe(device);
            Check(!navigation.Capture(device, "device-camera"), "device entry overwrote the source");
            device["deviceId"] = "device-two"; device["inspectionStage"] = "part";
            navigation.Observe(device);
            Check(!navigation.Capture(device, "second-device-camera"), "switching devices created another entry");
            Check(navigation.Current.PublicContext().Value<string>("viewId") == mode + "-custom-entry", "public return label lost actual entry");
            var exposed = navigation.Current.Context; exposed["workshopId"] = "mutated-read";
            Check(navigation.TryTake("factory-a", "scene-a", out var entry), "entry return failed");
            Check(entry.Camera == "camera-rendered-before-entry", "return selected a device preset instead of original camera");
            Check(entry.Context.Value<string>("viewId") == mode + "-custom-entry", "returned to the fixed line hierarchy");
            Check(entry.Context.Value<string>("lineId") == (mode == "line" ? "line-original" : ""), "device ancestry replaced the navigation source");
            Check(entry.Context.Value<string>("workshopId") != "mutated-read", "entry context leaked a mutable reference");
            Check(!navigation.TryTake("factory-a", "scene-a", out _), "one entry was returned twice");
        }
        return Task.CompletedTask;
    }

    private static Task DeviceEntryIsSessionScoped()
    {
        var navigation = new DeviceEntryNavigation<string>();
        Check(!navigation.Capture(null, "invalid"), "startup created a fake entry");
        var loading = EntryContext("workshop"); loading["sceneReady"] = false;
        Check(!navigation.Capture(loading, "loading"), "a loading view became a return target");
        foreach (var key in new[] { "factoryId", "sceneId" })
        {
            navigation.Capture(EntryContext("workshop"), "original");
            var other = EntryContext("device"); other[key] = "another-scope";
            navigation.Observe(other); Check(navigation.Current == null, "origin leaked to " + key);
        }
        navigation.Capture(EntryContext("workshop"), "original");
        Check(!navigation.TryTake("another-factory", "scene-a", out _), "cross-factory return was accepted");
        navigation.Capture(EntryContext("workshop"), "original");
        navigation.Observe(EntryContext("line")); Check(navigation.Current == null, "explicit breadcrumb exit kept old entry");
        navigation.Capture(EntryContext("line"), "new-line-camera");
        Check(navigation.TryTake("factory-a", "scene-a", out var entry) && entry.Camera == "new-line-camera", "new entry did not replace an exited session");
        navigation.Capture(EntryContext("workshop"), "original"); navigation.Clear();
        Check(!navigation.TryTake("factory-a", "scene-a", out _), "reload retained stale camera state");
        return Task.CompletedTask;
    }
}
