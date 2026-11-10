using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static void LinkageCheck(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    private static DeviceDto LinkageMobile() => new DeviceDto { Id = "cart", DataPoints = new List<DataPointDto> {
        new DataPointDto { Id = 1, DeviceId = "cart", Category = "analog", ValueRole = "position" },
        new DataPointDto { Id = 2, DeviceId = "cart", Category = "motors", ValueRole = "start" }
    } };
    private static JObject LinkageFrame(double stamp, double value = 1, bool start = true) => new JObject {
        ["furnace_id"] = "cart", ["timestamp"] = stamp,
        ["analog"] = new JObject { ["position"] = value }, ["motors"] = new JObject { ["start"] = start },
        ["status"] = new JObject { ["online"] = true, ["quality"] = "good" },
        ["quality"] = new JObject { ["overall"] = "good", ["analog"] = new JObject { ["position"] = "good" }, ["motors"] = new JObject { ["start"] = "good" } },
        ["pointMeta"] = new JObject {
            ["analog.position"] = new JObject { ["id"] = 1, ["timestamp"] = stamp, ["category"] = "analog", ["field_name"] = "position" },
            ["motors.start"] = new JObject { ["id"] = 2, ["timestamp"] = stamp, ["category"] = "motors", ["field_name"] = "start" }
        }
    };
    private static Task MobileMotionStopsOnInvalidInputs()
    {
        var device = LinkageMobile(); var signal = new MobileMotionSignalState();
        LinkageCheck(signal.Receive(device, LinkageFrame(1000000), "1", "2", 0, 1000000, 5000) && signal.SnapOnReceive && signal.Value == 1, "First real sample did not establish the pose directly.");
        LinkageCheck(signal.Receive(device, LinkageFrame(1000100, 2), "1", "2", .1, 1000100, 5000) && !signal.SnapOnReceive, "Healthy sample unexpectedly resynchronizes.");
        LinkageCheck(!signal.Receive(device, LinkageFrame(1000200, 2, false), "1", "2", .2, 1000200, 5000) && !signal.Usable, "Start=false did not stop the pending travel.");
        LinkageCheck(!signal.Receive(device, LinkageFrame(1000100, 3), "1", "2", .3, 1000300, 5000) && !signal.Usable, "An older true gate restarted travel after a newer stop.");
        LinkageCheck(signal.Receive(device, LinkageFrame(1000400, 3), "1", "2", .4, 1000400, 5000) && signal.SnapOnReceive && signal.Value == 3, "Recovery did not use the fresh confirmed position.");
        var bad = LinkageFrame(1000500, 4); bad["quality"]["analog"]["position"] = "bad";
        LinkageCheck(!signal.Receive(device, bad, "1", "2", .5, 1000500, 5000) && !signal.Usable && signal.Value == 3, "Bad quality moved or zeroed the held pose.");
        var wrong = LinkageFrame(1000600); wrong["pointMeta"]["analog.position"]["id"] = "other";
        LinkageCheck(!signal.Receive(device, wrong, "1", "2", .6, 1000600, 5000), "Wrong point identity moved the cart.");
        var offline = LinkageFrame(1000700); offline["status"]["online"] = false;
        LinkageCheck(!signal.Receive(device, offline, "1", "2", .7, 1000700, 5000), "Offline telemetry was treated as good position.");
        var missing = LinkageFrame(1000800); missing["analog"]["position"] = null;
        LinkageCheck(!signal.Receive(device, missing, "1", "2", .8, 1000800, 5000), "Missing position became zero.");
        var future = LinkageFrame(1010000);
        LinkageCheck(!signal.Receive(device, future, "1", "2", .9, 1000900, 5000), "Future-dated point was treated as fresh.");
        LinkageCheck(signal.Receive(device, LinkageFrame(1001000, 4), "1", "", 1, 1001000, 1000), "Valid position without a gate was rejected.");
        LinkageCheck(!signal.Receive(device, LinkageFrame(1000000, 8), "1", "", 1.1, 1001100, 1000) && signal.Value == 4, "Old position reversed the newer pose.");
        var duplicate = LinkageFrame(1001000, 4); duplicate["timestamp"] = 1001800;
        LinkageCheck(signal.Receive(device, duplicate, "1", "", 1.8, 1001800, 1000) && signal.ReceivedAt == 1, "Repeated source read was made fresh by a transport packet.");
        LinkageCheck(!signal.Advance(2.1, 1000, false), "Silent timeout did not stop pending travel.");
        var delayed = LinkageFrame(1000000, 9);
        LinkageCheck(!signal.Receive(device, delayed, "1", "", 10, 1010000, 1000), "Queued old position was freshened on dispatch.");
        var catalogOnly = LinkageFrame(1011000); catalogOnly["motionInputOnly"] = true;
        LinkageCheck(!signal.Receive(device, catalogOnly, "1", "", 11, 1011000, 5000) && !signal.Usable, "A catalog-only packet restarted PLC movement.");
        signal.Reset(); LinkageCheck(!signal.HasSample && !signal.Usable, "Reset leaked the old cart pose source.");
        LinkageCheck(MobileMotionSignalState.ParseStationInputMeaning(null) == StationInputMeaning.Legacy
            && MobileMotionSignalState.ParseStationInputMeaning(new JValue("current")) == StationInputMeaning.Current
            && MobileMotionSignalState.ParseStationInputMeaning(new JValue("target")) == StationInputMeaning.Target
            && MobileMotionSignalState.ParseStationInputMeaning(new JValue("guess")) == StationInputMeaning.Invalid,
            "Station signal meaning was guessed or changed the absent legacy contract.");
        var current = new MobileMotionSignalState();
        LinkageCheck(current.Receive(device, LinkageFrame(2000000, 1, false), "1", "2", 0, 2000000, 1000, StationInputMeaning.Current)
            && current.SnapOnReceive && current.HasConfirmedPosition, "A stopped cart's confirmed current station was rejected or delayed.");
        LinkageCheck(current.Receive(device, LinkageFrame(2000100, 2, false), "1", "2", .1, 2000100, 1000, StationInputMeaning.Current)
            && current.SnapOnReceive && current.Value == 2, "Fresh arrival feedback replayed a synthetic journey instead of confirming station 2.");
        LinkageCheck(current.Advance(.9, 1000, true) && current.HasConfirmedPosition, "A current-station observation depends on an unrelated motion gate age.");
        LinkageCheck(current.Receive(device, LinkageFrame(2001000, 2, true), "1", "2", 1, 2001000, 1000, StationInputMeaning.Current)
            && current.SnapOnReceive && !current.HasConfirmedPosition, "A PLC's retained current station was treated as docked while its movement bit was true.");
        current.Suspend();
        LinkageCheck(!current.Receive(device, LinkageFrame(2000000, 1, false), "1", "2", 1.2, 2001200, 1000, StationInputMeaning.Current)
            && !current.HasConfirmedPosition, "Old arrival feedback revived a confirmed pose after disconnect.");
        LinkageCheck(current.Receive(device, LinkageFrame(2001300, 2, false), "1", "2", 1.3, 2001300, 1000, StationInputMeaning.Current)
            && current.SnapOnReceive && current.HasConfirmedPosition, "Fresh measured arrival did not immediately recover a stopped cart.");
        LinkageCheck(!current.Advance(2.31, 1000, true) && !current.HasConfirmedPosition, "A stationary current-station pose remained confirmed after source timeout.");
        var command = new MobileMotionSignalState();
        LinkageCheck(command.Receive(device, LinkageFrame(3000000, 2), "1", "2", 0, 3000000, 1000, StationInputMeaning.Target)
            && !command.SnapOnReceive && !command.HasConfirmedPosition, "An initial target command was promoted to measured arrival.");
        command.Suspend();
        LinkageCheck(command.Receive(device, LinkageFrame(3000100, 1), "1", "2", .1, 3000100, 1000, StationInputMeaning.Target)
            && !command.SnapOnReceive && !command.HasConfirmedPosition, "A recovered target command teleported or confirmed the cart.");
        LinkageCheck(!command.Receive(device, LinkageFrame(3000200, 1, false), "1", "2", .2, 3000200, 1000, StationInputMeaning.Target)
            && !command.Usable && !command.HasConfirmedPosition, "A false movement gate left target-command estimation actionable.");
        LinkageCheck(!command.Receive(device, LinkageFrame(3000100, 2), "1", "2", .3, 3000300, 1000, StationInputMeaning.Target)
            && !command.Usable, "An older command/gate restarted an explicitly stopped estimate.");
        LinkageCheck(!command.Receive(device, LinkageFrame(3000400, 2), "1", "2", .4, 3000400, 1000, StationInputMeaning.Invalid),
            "Invalid signal meaning was silently interpreted as real position.");
        MobileExplicitObservationsAndContinuousFeedback();
        return Task.CompletedTask;
    }
    private static Task LastConfirmedStationIsObservationOnly()
    {
        LinkageCheck(MobileMotionSignalState.ParseStationInputMeaning(new JValue("last-confirmed")) == StationInputMeaning.LastConfirmed,
            "Retained last-arrival meaning was not parsed explicitly.");
        var device = LinkageMobile(); device.DataPoints[0].DataType = "WORD"; device.DataPoints[1].DataType = "BOOL";
        var held = new MobileMotionSignalState();
        for (var i = 0; i < 20; i++)
        {
            var stamp = 8000000 + i * 200;
            LinkageCheck(held.Receive(device, LinkageFrame(stamp, 1), "1", "", i * .2, stamp, 5000, StationInputMeaning.LastConfirmed)
                && held.Usable && held.SnapOnReceive && held.Value == 1 && !held.HasConfirmedPosition,
                "A repeated last-arrival number invented a percentage trajectory or current docking without feedback.");
            LinkageCheck(held.Advance(i * .2 + .1, 5000, false) && held.Value == 1 && !held.HasConfirmedPosition,
                "Render time invented a new intermediate station or confirmed a stale last-arrival number.");
        }
        LinkageCheck(held.Receive(device, LinkageFrame(8004000, 2), "1", "", 4, 8004000, 5000, StationInputMeaning.LastConfirmed)
            && held.SnapOnReceive && held.Value == 2 && !held.HasConfirmedPosition,
            "A new last-arrival feedback failed to update the observed station, or guessed ongoing docking.");
        var old = LinkageFrame(8003000, 1); old["timestamp"] = 8004100;
        LinkageCheck(!held.Receive(device, old, "1", "", 4.1, 8004100, 5000, StationInputMeaning.LastConfirmed) && held.Value == 2,
            "Older last-arrival feedback rewound the observed station.");
        var duplicate = LinkageFrame(8004000, 2); duplicate["timestamp"] = 8004800;
        LinkageCheck(held.Receive(device, duplicate, "1", "", 4.8, 8004800, 1000, StationInputMeaning.LastConfirmed) && held.ReceivedAt == 4,
            "Retained source feedback renewed its lifetime from the wrapper clock.");
        LinkageCheck(!held.Advance(5.1, 1000, false) && !held.HasConfirmedPosition, "Expired held feedback remained a docking observation.");
        held.Suspend();
        LinkageCheck(held.Receive(device, LinkageFrame(8006000, 3, true), "1", "2", 6, 8006000, 1000, StationInputMeaning.LastConfirmed)
            && held.Value == 3 && held.SnapOnReceive && !held.HasConfirmedPosition,
            "A held last station became docked while the actual movement feedback was true.");
        LinkageCheck(held.Receive(device, LinkageFrame(8006100, 3, false), "1", "2", 6.1, 8006100, 1000, StationInputMeaning.LastConfirmed)
            && held.Value == 3 && held.SnapOnReceive && held.HasConfirmedPosition,
            "Good owned actual BOOL stopped feedback did not confirm the known station.");
        var bad = LinkageFrame(8006200, 3, false); bad["quality"]["motors"]["start"] = "bad";
        LinkageCheck(!held.Receive(device, bad, "1", "2", 6.2, 8006200, 1000, StationInputMeaning.LastConfirmed)
            && !held.Usable && !held.HasConfirmedPosition, "Faulted movement feedback confirmed docking in retained-station mode.");
        var wordGate = LinkageMobile(); wordGate.DataPoints[1].DataType = "WORD";
        LinkageCheck(!new MobileMotionSignalState().Receive(wordGate, LinkageFrame(9000000, 1, false), "1", "2", 0, 9000000, 1000, StationInputMeaning.LastConfirmed),
            "A numeric start command was substituted for actual BOOL movement feedback.");
        foreach (var raw in new JToken[] { new JValue(0), new JValue(1), new JValue("false"), new JValue("true"), new JValue("0"), new JValue("1"), JValue.CreateNull() })
        {
            var nonBoolean = LinkageFrame(9000000, 1, false); nonBoolean["motors"]["start"] = raw;
            LinkageCheck(!new MobileMotionSignalState().Receive(device, nonBoolean, "1", "2", 0, 9000000, 1000, StationInputMeaning.LastConfirmed),
                "A non-Boolean value was coerced into actual movement/stopped BOOL feedback.");
        }
        foreach (var mutate in new Action<DeviceDto>[] {
            row => row.DataPoints[1].DeviceId = "other-cart",
            row => row.DataPoints[1].AccessType = "WRITE",
            row => row.DataPoints[1].DataType = "INT"
        })
        {
            var invalidSource = LinkageMobile(); invalidSource.DataPoints[1].DataType = "BOOL"; mutate(invalidSource);
            LinkageCheck(!new MobileMotionSignalState().Receive(invalidSource, LinkageFrame(9000000, 1, false), "1", "2", 0, 9000000, 1000, StationInputMeaning.LastConfirmed),
                "A foreign, writable or non-BOOL point confirmed held-station docking.");
        }
        foreach (var fault in new Action<JObject>[] {
            frame => frame["motors"]["start"] = 0,
            frame => frame["quality"]["motors"]["start"] = "bad",
            frame => frame["quality"]["analog"]["position"] = "bad",
            frame => frame["status"]["online"] = false
        })
        {
            var recovery = new MobileMotionSignalState();
            LinkageCheck(recovery.Receive(device, LinkageFrame(9100000, 2, true), "1", "2", 0, 9100000, 1000, StationInputMeaning.LastConfirmed),
                "Held-station recovery fixture did not establish its first actual observation.");
            var faulted = LinkageFrame(9100200, 2, true); fault(faulted);
            LinkageCheck(!recovery.Receive(device, faulted, "1", "2", .2, 9100200, 1000, StationInputMeaning.LastConfirmed) && !recovery.Usable,
                "A typed/quality/offline held-station fault did not immediately suspend the observation.");
            LinkageCheck(recovery.ReceivedAt == 0 && recovery.SourceTimestamp == 9100000 && recovery.Value == 2,
                "A fault watermark changed the accepted position or renewed its source lifetime.");
            LinkageCheck(!recovery.Receive(device, LinkageFrame(9100100, 1, false), "1", "2", .3, 9100300, 1000, StationInputMeaning.LastConfirmed)
                && !recovery.Usable && !recovery.HasConfirmedPosition && recovery.Value == 2,
                "A delayed valid BOOL/source read older than a newer held-station fault revived docking or rewound the observed station.");
            var oldGate = LinkageFrame(9100350, 2, false); oldGate["pointMeta"]["motors.start"]["timestamp"] = 9100100;
            LinkageCheck(!recovery.Receive(device, oldGate, "1", "2", .35, 9100350, 1000, StationInputMeaning.LastConfirmed)
                && !recovery.Usable && !recovery.HasConfirmedPosition && recovery.Value == 2,
                "A fresh position wrapper hid an actual BOOL read older than the held-station fault.");
            var oldPosition = LinkageFrame(9100375, 1, false); oldPosition["pointMeta"]["analog.position"]["timestamp"] = 9100100;
            LinkageCheck(!recovery.Receive(device, oldPosition, "1", "2", .375, 9100375, 1000, StationInputMeaning.LastConfirmed)
                && !recovery.Usable && !recovery.HasConfirmedPosition && recovery.Value == 2,
                "A fresh actual BOOL wrapper hid a position read older than the held-station fault.");
            LinkageCheck(recovery.Receive(device, LinkageFrame(9100400, 3, false), "1", "2", .4, 9100400, 1000, StationInputMeaning.LastConfirmed)
                && recovery.SnapOnReceive && recovery.HasConfirmedPosition && recovery.Value == 3,
                "A fresh owned stopped feedback could not directly recover beyond the held-station fault watermark.");
            recovery.Reset();
            LinkageCheck(recovery.Receive(device, LinkageFrame(9000000, 1, false), "1", "2", 0, 9000000, 1000, StationInputMeaning.LastConfirmed)
                && recovery.HasConfirmedPosition && recovery.Value == 1,
                "A reset inherited another scene/configuration's held-station fault watermark.");
        }
        var staleMoving = new MobileMotionSignalState();
        LinkageCheck(staleMoving.Receive(device, LinkageFrame(9200000, 1, false), "1", "2", 0, 9200000, 1000, StationInputMeaning.LastConfirmed)
            && staleMoving.HasConfirmedPosition, "Held-station gate-age fixture did not confirm its fresh stopped read.");
        var freshPositionOldGate = LinkageFrame(9202000, 2, false); freshPositionOldGate["pointMeta"]["motors.start"]["timestamp"] = 9200000;
        LinkageCheck(!staleMoving.Receive(device, freshPositionOldGate, "1", "2", 2, 9202000, 1000, StationInputMeaning.LastConfirmed)
            && !staleMoving.HasConfirmedPosition && staleMoving.Value == 1,
            "Fresh station reads renewed an independently expired stopped BOOL feedback.");
        foreach (var untrusted in new Action<JObject>[] {
            frame => frame["pointMeta"]["analog.position"]["id"] = 999,
            frame => frame.Remove("pointMeta"),
            frame => { var meta = frame["pointMeta"]["analog.position"]; ((JObject)frame["pointMeta"]).Remove("analog.position"); frame["pointMeta"]["analog.unowned"] = meta; },
            frame => frame["pointMeta"]["analog.duplicate"] = frame["pointMeta"]["analog.position"].DeepClone(),
            frame => frame["pointMeta"]["analog.position"]["timestamp"] = 9310000,
            frame => { frame["status"]["online"] = false; frame["pointMeta"]["analog.position"]["category"] = new JArray("analog"); },
            frame => { frame["status"]["online"] = false; frame["pointMeta"]["analog.position"]["field_name"] = new JObject { ["unknown"] = "position" }; }
        })
        {
            var known = new MobileMotionSignalState();
            LinkageCheck(known.Receive(device, LinkageFrame(9300000, 2), "1", "", 0, 9300000, 5000, StationInputMeaning.LastConfirmed),
                "Untrusted-metadata fixture did not establish its owned station observation.");
            var unknown = LinkageFrame(9301000, 1); untrusted(unknown);
            LinkageCheck(!known.Receive(device, unknown, "1", "", 1, 9301000, 5000, StationInputMeaning.LastConfirmed)
                && !known.Usable && known.Value == 2,
                "Unknown, missing, misaddressed, duplicate or future point metadata became a held-station read.");
            LinkageCheck(known.Receive(device, LinkageFrame(9300200, 3), "1", "", 1.2, 9301200, 5000, StationInputMeaning.LastConfirmed)
                && known.SnapOnReceive && known.Value == 3 && !known.HasConfirmedPosition && Math.Abs(known.ReceivedAt - .2) < 1e-9,
                "Untrusted point metadata poisoned the held-station watermark or manufactured a new source receipt clock.");
        }
        var ownedGate = new MobileMotionSignalState();
        LinkageCheck(ownedGate.Receive(device, LinkageFrame(9400000, 2, true), "1", "2", 0, 9400000, 5000, StationInputMeaning.LastConfirmed),
            "Unknown gate-metadata fixture did not establish its owned moving read.");
        var unknownGate = LinkageFrame(9401000, 1, false);
        unknownGate["pointMeta"]["analog.position"]["timestamp"] = 9400000; unknownGate["pointMeta"]["motors.start"]["id"] = 999;
        LinkageCheck(!ownedGate.Receive(device, unknownGate, "1", "2", 1, 9401000, 5000, StationInputMeaning.LastConfirmed) && !ownedGate.HasConfirmedPosition,
            "Unknown actual moving feedback metadata confirmed docking.");
        LinkageCheck(ownedGate.Receive(device, LinkageFrame(9400200, 3, false), "1", "2", 1.2, 9401200, 5000, StationInputMeaning.LastConfirmed)
            && ownedGate.HasConfirmedPosition && ownedGate.Value == 3,
            "Unknown actual moving feedback metadata poisoned a later owned stopped read.");
        return Task.CompletedTask;
    }
    private static void MobileExplicitObservationsAndContinuousFeedback()
    {
        var device = LinkageMobile();
        foreach (var mutation in new Action<JObject>[] {
            frame => frame.Remove("pointMeta"),
            frame => ((JObject)frame["pointMeta"]["analog.position"]).Remove("id"),
            frame => ((JObject)frame["pointMeta"]["motors.start"]).Remove("id"),
            frame => ((JObject)frame["pointMeta"]["analog.position"]).Remove("timestamp"),
            frame => ((JObject)frame["pointMeta"]["motors.start"]).Remove("timestamp"),
            frame => frame["pointMeta"]["analog.position"]["timestamp"] = 0,
            frame => frame["pointMeta"]["analog.position"]["timestamp"] = null,
            frame => frame["pointMeta"]["analog.position"]["timestamp"] = true,
            frame => frame["pointMeta"]["motors.start"]["timestamp"] = double.NaN,
            frame => ((JObject)frame["quality"]["analog"]).Remove("position"),
            frame => ((JObject)frame["quality"]["motors"]).Remove("start"),
            frame => { var metadata = frame["pointMeta"]["analog.position"]; ((JObject)frame["pointMeta"]).Remove("analog.position"); frame["pointMeta"]["analog.other"] = metadata; },
            frame => frame["cachedAgeMs"] = -1,
            frame => frame["cachedAgeMs"] = double.NaN
        })
        {
            var frame = LinkageFrame(6000000, 2); mutation(frame);
            var signal = new MobileMotionSignalState();
            LinkageCheck(!signal.Receive(device, frame, "1", "2", 0, 6000000, 1000, actualPositionFeedback: true)
                && !signal.Usable && !signal.HasConfirmedPosition && !signal.HasSample,
                "A missing/misowned/invalid real point observation was replaced by its transport wrapper.");
        }
        var cached = LinkageFrame(6000000, 2); cached["cachedAgeMs"] = 10000;
        var expired = new MobileMotionSignalState();
        LinkageCheck(!expired.Receive(device, cached, "1", "2", 10, 6000000, 1000, actualPositionFeedback: true)
            && !expired.Usable && expired.Value == 0, "Fresh wrapper/source timestamps ignored ten seconds of cached observation age.");
        var aged = new MobileMotionSignalState(); var partial = LinkageFrame(6000000, 2); partial["cachedAgeMs"] = 200;
        LinkageCheck(aged.Receive(device, partial, "1", "2", 1, 6000100, 1000, actualPositionFeedback: true)
            && Math.Abs(aged.ReceivedAt - .8) < 1e-9, "Mobile freshness did not use max(actual source age, cached age).");
        var actual = new MobileMotionSignalState();
        LinkageCheck(actual.Receive(device, LinkageFrame(7000000, .2, true), "1", "2", 0, 7000000, 1000, actualPositionFeedback: true)
            && actual.Usable && actual.SnapOnReceive && !actual.HasConfirmedPosition, "Initial moving actual coordinates were not displayed, or falsely confirmed docking.");
        LinkageCheck(actual.Receive(device, LinkageFrame(7000100, .8, true), "1", "2", .1, 7000100, 1000, actualPositionFeedback: true)
            && actual.Value == .8 && !actual.HasConfirmedPosition, "A moving cart lost new actual continuous feedback or became docked.");
        LinkageCheck(actual.Receive(device, LinkageFrame(7000200, 1, false), "1", "2", .2, 7000200, 1000, actualPositionFeedback: true)
            && actual.SnapOnReceive && actual.HasConfirmedPosition && actual.Value == 1,
            "Fresh continuous position plus a false movement bit did not stop the old target and immediately confirm measured arrival.");
        LinkageCheck(!actual.Receive(device, LinkageFrame(7000100, .8, true), "1", "2", .3, 7000300, 1000, actualPositionFeedback: true)
            && actual.Value == 1 && actual.HasConfirmedPosition, "An older moving observation undid a newer measured stop.");
        actual.Suspend();
        var replay = LinkageFrame(7000400, .5, false); replay["cachedAgeMs"] = 10000;
        LinkageCheck(!actual.Receive(device, replay, "1", "2", .4, 7000400, 1000, actualPositionFeedback: true)
            && actual.Value == 1 && !actual.HasConfirmedPosition, "A recovered cached wrapper revived a stale continuous cart pose.");
        LinkageCheck(actual.Receive(device, LinkageFrame(7000500, .5, false), "1", "2", .5, 7000500, 1000, actualPositionFeedback: true)
            && actual.SnapOnReceive && actual.HasConfirmedPosition, "Fresh stopped actual feedback failed to recover after rejecting cached data.");
        LinkageCheck(!actual.Advance(1.51, 1000, true) && !actual.HasConfirmedPosition, "Stationary continuous feedback did not expire at its source deadline.");
    }
    private static Task ReplayDoesNotRefreshObservations()
    {
        var cache = new RealtimeDeviceFrameCache(); var original = LinkageFrame(1000000, 2);
        cache.Remember("cart", original, 0); original["analog"]["position"] = 99;
        LinkageCheck(cache.TryGet("cart", out var replay, 6) && replay.Value<double>("timestamp") == 1006000 && replay["analog"]["position"].Value<double>() == 2, "Replay was mutated or its envelope was not aged.");
        LinkageCheck(replay["pointMeta"]["analog.position"].Value<double>("timestamp") == 1000000, "Replay invented a new source read timestamp.");
        var signal = new MotionSignalState(); var binding = JObject.Parse("{sourceGroup:'analog',sourceKey:'position',pointId:'1',inputMin:0,inputMax:10}");
        signal.Receive(replay, binding, 6); signal.Step(0, 6, 5000, binding);
        LinkageCheck(!signal.Usable, "Model recreation revived stale PLC data.");
        replay["analog"]["position"] = 42; cache.TryGet("cart", out var independent, 6);
        LinkageCheck(independent["analog"]["position"].Value<double>() == 2, "A replay mutated its cache.");
        var catalogOnly = LinkageFrame(2000000, 8); catalogOnly["motionInputOnly"] = true;
        cache.Remember("cart", catalogOnly, 7); cache.TryGet("cart", out var afterCatalog, 7);
        LinkageCheck(afterCatalog["analog"]["position"].Value<double>() == 2 && afterCatalog.Value<double>("timestamp") == 1007000, "Catalog refresh replaced or freshened PLC telemetry.");
        cache.Remember("cart", LinkageFrame(999000, 1), 8); cache.TryGet("cart", out var afterOlder, 8);
        LinkageCheck(afterOlder["analog"]["position"].Value<double>() == 2, "Old good telemetry replaced the latest cache.");
        var legacy = LinkageFrame(1000000); legacy.Remove("timestamp"); legacy.Remove("pointMeta"); cache.Clear(); cache.Remember("cart", legacy, 0);
        cache.TryGet("cart", out var legacyReplay, 6); var legacySignal = new MotionSignalState(); legacySignal.Receive(legacyReplay, binding, 6); legacySignal.Step(0, 6, 5000, binding);
        LinkageCheck(!legacySignal.Usable, "Legacy cache replay erased its receipt age.");
        cache.Clear(); LinkageCheck(!cache.TryGet("cart", out _, 10), "Factory clear retained a previous cart cache.");
        return Task.CompletedTask;
    }
    private static Task MotionSignalsCountTransportAge()
    {
        var binding = JObject.Parse("{actionId:'clip:feed',dataItemId:'point:feed',inputMin:0,inputMax:1,transitionSeconds:1}");
        JObject Frame(double stamp) => JObject.Parse("{timestamp:" + stamp.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",motionInputOnly:true,motionInputs:{'clip:feed':{dataItemId:'point:feed',value:1,quality:'good',timestamp:" + stamp.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",staleMs:1000}}}");
        var state = new MotionSignalState(); state.Receive(Frame(1000000), binding, 10, 1010000);
        LinkageCheck(!state.Usable, "Catalog motion ignored the actual queue/transport delay.");
        state.Receive(Frame(1010000), binding, 10, 1010000); LinkageCheck(state.Usable, "Fresh catalog motion failed after stale data.");
        var pose = state.Position; state.Suspend(); state.Step(2, 10.5, 1000, binding);
        LinkageCheck(!state.Usable && state.Position == pose && !state.Running, "Disconnect continued an old animation timer.");
        var pair = JObject.Parse("{actionId:'clip:feed',trigger:{mode:'endpoints',extended:{dataItemId:'a'},retracted:{dataItemId:'b'}}}");
        var endpointFrame = JObject.Parse("{timestamp:1000000,motionInputs:{'clip:feed':{quality:'good',endpointFeedback:{extended:{dataItemId:'a',quality:'good',value:true,timestamp:1000000,staleMs:1000},retracted:{dataItemId:'b',quality:'good',value:false,timestamp:1000000,staleMs:1000}}}}}");
        var endpoint = new MotionSignalState(); endpoint.Receive(endpointFrame, pair, 10, 1010000);
        LinkageCheck(!endpoint.Usable, "Endpoint bits ignored queued observation age.");
        var legacyBinding = JObject.Parse("{pointId:'1',sourceGroup:'analog',sourceKey:'position',inputMin:0,inputMax:10}");
        var legacy = new MotionSignalState();
        var absentMeta = LinkageFrame(4000000, 2); absentMeta.Remove("pointMeta");
        legacy.Receive(absentMeta, legacyBinding, 0, 4000000);
        LinkageCheck(!legacy.Usable, "A live explicitly assigned point was made usable by the transport wrapper without source confirmation.");
        var absentStamp = LinkageFrame(4000100, 2); absentStamp["pointMeta"]["analog.position"]["timestamp"].Parent.Remove();
        legacy.Receive(absentStamp, legacyBinding, .1, 4000100);
        LinkageCheck(!legacy.Usable, "A live point without its observed timestamp was made fresh on dispatch.");
        var metaBad = LinkageFrame(4000200, 2); metaBad["pointMeta"]["analog.position"]["quality"] = "bad";
        legacy.Receive(metaBad, legacyBinding, .2, 4000200); LinkageCheck(!legacy.Usable, "Bad live pointMeta quality was ignored.");
        legacy.Receive(LinkageFrame(4000300, 2), legacyBinding, .3, 4000300);
        LinkageCheck(legacy.Usable && legacy.ReceivedAt == .3, "Fresh owned live point failed after confirmation returned.");
        var wrapperOnly = LinkageFrame(4000300, 2); wrapperOnly["timestamp"] = 4000800;
        legacy.Receive(wrapperOnly, legacyBinding, .8, 4000800);
        LinkageCheck(legacy.ReceivedAt == .3, "Repeating a live wrapper extended the point observation lifetime.");
        legacy.Step(0, 1.4, 1000, legacyBinding); LinkageCheck(!legacy.Usable, "A live legacy action outlived its observed point timestamp.");
        var controlled = new MotionSignalState(); controlled.Receive(absentMeta, legacyBinding, 0);
        LinkageCheck(controlled.Usable, "Controlled mock preview without wall clock lost its legacy compatibility.");
        var unbound = (JObject)legacyBinding.DeepClone(); unbound.Remove("pointId");
        var oldModel = new MotionSignalState(); oldModel.Receive(absentMeta, unbound, 0, 4000000);
        LinkageCheck(oldModel.Usable, "An older unbound model-level definition was silently made incompatible.");
        CompiledTrackSamplingMatchesReference();
        return Task.CompletedTask;
    }

    private static void CompiledTrackSamplingMatchesReference()
    {
        var clip = JObject.Parse("{count:3,duration:2}");
        var tracks = new[] {
            JObject.Parse("{node:'p',size:3,channel:'p',values:[0,1,2,2,4,6,4,5,8]}"),
            JObject.Parse("{node:'q',size:4,channel:'q',values:[0,0,0,1,0,0,-1,-1,0,0,0,1]}"),
            JObject.Parse("{node:'s',size:3,channel:'s',values:[1,1,1,2,3,4,3,4,5]}"),
            JObject.Parse("{node:'v',size:1,channel:'v',values:[0,1,0]}"),
            JObject.Parse("{node:'c',size:4,channel:'c0',values:[0,0,0,1,1,0,0,.5,0,1,0,1]}"),
            JObject.Parse("{node:'e',size:4,channel:'e0',values:[0,0,0,1,1,0,0,2,0,1,0,1]}")
        };
        foreach (var track in tracks)
        {
            LinkageCheck(CompiledMotionTrack.TryCompile(clip, track, out var compiled, out _), "A valid authoring channel did not compile.");
            var reference = new double[compiled.Size]; var sampled = new double[compiled.Size];
            foreach (var seconds in new[] { -10d, 0, .1, .999, 1, 1.4, 2, 20 })
            {
                MotionSignalState.SampleInto(clip, track, seconds, reference);
                LinkageCheck(compiled.SampleInto(seconds, sampled) && sampled.SequenceEqual(reference), "Compiled track changed position/rotation/scale/visibility/material interpolation.");
            }
            var held = (double[])sampled.Clone();
            LinkageCheck(!compiled.SampleInto(double.NaN, sampled) && sampled.SequenceEqual(held), "Bad sampling time modified the held pose.");
            LinkageCheck(!compiled.SampleInto(double.PositiveInfinity, sampled) && !compiled.SampleInto(1, new double[compiled.Size + 1]), "Invalid sample input was silently applied.");
        }
        var position = tracks[0]; CompiledMotionTrack.TryCompile(clip, position, out var frozen, out _); var output = new double[3];
        frozen.SampleInto(1, output); var original = (double[])output.Clone(); position["values"][3] = 999;
        LinkageCheck(frozen.SampleInto(1, output) && output.SequenceEqual(original), "A mutable JSON definition changed a compiled track without reconfiguration.");
        LinkageCheck(frozen.PositionRest.SequenceEqual(new[] { 0d, 1, 2 }) && frozen.MaximumPositionDisplacement.SequenceEqual(new[] { 4d, 4, 6 }), "Compiled physical travel no longer follows the authored p-node samples.");
        foreach (var invalid in new[] { JObject.Parse("{node:'p',size:3,channel:'p',values:[0,0,0]}") ,
            JObject.Parse("{node:'q',size:3,channel:'q',values:[0,0,0,0,0,0,0,0,0]}"),
            JObject.Parse("{node:'p',size:3,channel:'p',values:[0,0,0,0,0,0,0,0,1e300]}") })
            LinkageCheck(!CompiledMotionTrack.TryCompile(clip, invalid, out _, out _), "Malformed/non-renderable portable track became live motion.");
        var bad = (JObject)tracks[2].DeepClone(); bad["values"][0] = double.NaN;
        LinkageCheck(!CompiledMotionTrack.TryCompile(clip, bad, out _, out _), "Nonfinite authored sample was compiled as a real transform.");
        for (var index = 0; index < 2000; index++) frozen.SampleInto((index % 200) / 100d, output);
        var before = GC.GetAllocatedBytesForCurrentThread(); var clock = System.Diagnostics.Stopwatch.StartNew();
        for (var index = 0; index < 100000; index++) frozen.SampleInto((index % 200) / 100d, output);
        clock.Stop(); var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        // Stopwatch itself is outside the sampler and allocated once above.
        LinkageCheck(allocated <= 128, "Steady compiled sampling allocated per frame: " + allocated);
        Console.WriteLine("MEASURED: 100000 compiled samples=" + clock.Elapsed.TotalMilliseconds.ToString("F3", System.Globalization.CultureInfo.InvariantCulture) + " ms, allocation=" + allocated + " bytes including one Stopwatch.");
    }
    private static Task TransferReachUsesPhysicalNodeTravel()
    {
        TransferReachResult Reach(double[] target, double[] direction = null, double[] drive = null) => TransferReachPolicy.Evaluate(new[] { 0d, 0, 0 }, new[] { 1d, 0, 0 }, target,
            direction ?? new[] { -1d, 0, 0 }, drive ?? new[] { 1.085d, 0, 0 }, .02, .02, 1);
        var reachable = Reach(new[] { .8, 0, 0 });
        LinkageCheck(reachable.Usable && Math.Abs(reachable.Distance - .8) < 1e-9 && Math.Abs(reachable.MaximumTravel - 1.085) < 1e-9, "Real cart pusher stroke did not reach an aligned loading port.");
        LinkageCheck(!Reach(new[] { 1.09, 0, 0 }).Usable, "An unreachable gap stretched the feed mechanism.");
        LinkageCheck(!Reach(new[] { .8, .1, 0 }).Usable, "Mismatched tray/loading height was silently corrected.");
        LinkageCheck(!Reach(new[] { .8, 0, .1 }).Usable, "Lateral misalignment relocated the cart to a fake dock.");
        LinkageCheck(!Reach(new[] { .8, 0, 0 }, new[] { 1d, 0, 0 }).Usable, "Back-to-back port normals were treated as facing.");
        LinkageCheck(!Reach(new[] { -.3, 0, 0 }).Usable, "A target behind the pusher was accepted.");
        LinkageCheck(!Reach(new[] { .8, 0, 0 }, drive: new[] { 0d, 0, 1 }).Usable, "The chosen node moved in another axis.");
        LinkageCheck(Reach(new[] { 1.6, 0, 0 }, drive: new[] { 2.17, 0, 0 }).Usable, "Actual model scaling was omitted from travel reach.");
        var turned = TransferReachPolicy.Evaluate(new[] { 3d, 1, 4 }, new[] { 0d, 0, 1 }, new[] { 3d, 1, 4.8 }, new[] { 0d, 0, -1 }, new[] { 0d, 0, 1.085 }, .02, .02, 1);
        LinkageCheck(turned.Usable, "An already rotated/world-transformed rail used the wrong axis.");
        var diagonal = TransferReachPolicy.Evaluate(new[] { 0d, 0, 0 }, new[] { 1d, 0, 1 }, new[] { .7, 0, .7 }, new[] { -1d, 0, -1 }, new[] { .8, 0, .8 }, .02, .02, 1);
        LinkageCheck(diagonal.Usable, "Diagonal loading geometry was reduced to a largest component axis.");
        LinkageCheck(!Reach(new[] { double.NaN, 0, 0 }).Usable && !Reach(new[] { .8, 0, 0 }, drive: new[] { 0d, 0, 0 }).Usable, "Nonfinite/zero travel became a real transfer.");
        var reusable = new TransferReachResult();
        var origin = new[] { 0d, 0, 0 }; var outward = new[] { 1d, 0, 0 }; var inward = new[] { -1d, 0, 0 }; var drive = new[] { 1.085d, 0, 0 };
        for (var index = 0; index < 1000; index++)
        {
            var target = new[] { (index % 150) / 100d, (index % 3) / 100d, (index % 5) / 100d };
            var allocatedResult = TransferReachPolicy.Evaluate(origin, outward, target, inward, drive, .02, .02, 1);
            var buffered = TransferReachPolicy.EvaluateInto(reusable, origin, outward, target, inward, drive, .02, .02, 1);
            LinkageCheck(ReferenceEquals(buffered, reusable) && allocatedResult.Usable == buffered.Usable && allocatedResult.Reason == buffered.Reason
                && allocatedResult.Distance == buffered.Distance && allocatedResult.MaximumTravel == buffered.MaximumTravel
                && allocatedResult.HeightError == buffered.HeightError && allocatedResult.LateralError == buffered.LateralError
                && allocatedResult.AngleErrorDegrees == buffered.AngleErrorDegrees, "Reusable handoff geometry changed the physical reach predicate.");
        }
        var reachableTarget = new[] { .8, 0, 0 };
        TransferReachPolicy.EvaluateInto(reusable, origin, outward, reachableTarget, inward, drive, .02, .02, 1);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var index = 0; index < 10000; index++) TransferReachPolicy.EvaluateInto(reusable, origin, outward, reachableTarget, inward, drive, .02, .02, 1);
        LinkageCheck(GC.GetAllocatedBytesForCurrentThread() == before, "Steady handoff geometry allocated per-frame arrays/results.");
        TransferReachPolicy.EvaluateInto(reusable, origin, outward, new[] { double.NaN, 0, 0 }, inward, drive, .02, .02, 1);
        LinkageCheck(!reusable.Usable && reusable.Distance == 0 && reusable.MaximumTravel == 0, "Invalid reuse retained the previous valid reach result.");
        return Task.CompletedTask;
    }
    private static Task LoadingPortsPreserveSavedCoordinates()
    {
        var metadata = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[1,2,3],direction:[2,0,0],nodeName:'door'},outlet:null}}");
        var instance = JObject.Parse("{loadingPortOverrides:{version:1,inlet:{offset:[.1,.2,-.3],yawDegrees:90},outlet:null}}");
        var original = metadata.ToString();
        LinkageCheck(LoadingPortPolicy.TryResolve(metadata, instance, "inlet", out var port, out _), "Saved model and instance loading datum did not resolve.");
        LinkageCheck(Math.Abs(port.Position[0] - 1.1) < 1e-9 && Math.Abs(port.Position[1] - 2.2) < 1e-9 && Math.Abs(port.Position[2] - 2.7) < 1e-9
            && Math.Abs(port.Direction[0]) < 1e-9 && Math.Abs(port.Direction[2] + 1) < 1e-9, "Native loading datum differs from the shared authoring yaw/offset contract.");
        LinkageCheck(metadata.ToString() == original, "Resolving a loading datum changed authored metadata.");
        LinkageCheck(!LoadingPortPolicy.TryResolve(metadata, instance, "outlet", out _, out _), "An explicit null port was inferred from geometry.");
        var bad = (JObject)metadata.DeepClone(); bad["loadingPorts"]["version"] = "invalid";
        LinkageCheck(!LoadingPortPolicy.TryResolve(bad, instance, "inlet", out _, out _), "Invalid datum version was accepted.");
        bad = (JObject)metadata.DeepClone(); bad["loadingPorts"]["inlet"]["position"][0] = "1";
        LinkageCheck(!LoadingPortPolicy.TryResolve(bad, instance, "inlet", out _, out _), "String position became a real coordinate.");
        bad = (JObject)metadata.DeepClone(); bad["loadingPorts"]["inlet"]["direction"][1] = .1;
        LinkageCheck(!LoadingPortPolicy.TryResolve(bad, instance, "inlet", out _, out _), "A vertical loading normal was silently flattened.");
        var overrideOnly = JObject.Parse("{loadingPortOverrides:{version:1,inlet:null,outlet:{offset:[1,2,3],yawDegrees:0}}}");
        LinkageCheck(!LoadingPortPolicy.TryResolve(metadata, overrideOnly, "outlet", out _, out _), "An instance override resurrected a missing model port.");
        return Task.CompletedTask;
    }
    private static Task RailProjectionPreservesStationCalibration()
    {
        var before = RailPositionPolicy.ProjectStation(new[] { 7d, 0, 2.5 }, new[] { -20d, 0, 2.5 }, new[] { -10d, 0, 2.5 });
        var after = RailPositionPolicy.ProjectStation(new[] { 7d, 0, 5.5 }, new[] { -20d, 0, 5.5 }, new[] { -10d, 0, 5.5 });
        LinkageCheck(before[0] == 7 && before[2] == 2.5 && after[0] == 7 && after[2] == 5.5, "A gap change or legacy station axis pulled a real station onto the old track/end point.");
        var diagonal = RailPositionPolicy.ProjectStation(new[] { 2d, 8, 0 }, new[] { 0d, 1, 0 }, new[] { 4d, 1, 4 });
        LinkageCheck(diagonal[0] == 1 && diagonal[1] == 1 && diagonal[2] == 1, "Oblique rail projection used the dominant axis or altered its height datum.");
        LinkageCheck(RailPositionPolicy.ProjectStation(new[] { double.NaN, 0, 0 }, new[] { 0d, 0, 0 }, new[] { 1d, 0, 0 }) == null, "Invalid station became a valid rail pose.");
        LinkageCheck(RailPositionPolicy.ProjectStation(new[] { 8d, 1, 3 }, new[] { 2d, 1, 3 }, new[] { 2d, 7, 3 }) == null,
            "A degenerate horizontal axis invented a station at the start point.");
        LinkageCheck(RailPositionPolicy.ProjectStation(new[] { 8d, 3 }, new[] { 2d, 1, 3 }, new[] { 4d, 1, 3 }) == null,
            "Incomplete XYZ calibration was completed with hidden fallback coordinates.");
        LinkageCheck(RailPositionPolicy.ProjectStation(new[] { 0d, 0, 0 }, new[] { -double.MaxValue, 0, 0 }, new[] { double.MaxValue, 0, 0 }) == null,
            "An overflowing rail axis became a nonfinite rendered pose.");
        return Task.CompletedTask;
    }
}
