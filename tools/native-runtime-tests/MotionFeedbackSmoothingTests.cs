using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private const double FeedbackEpoch = 1000000;
    private static JObject FeedbackBinding(double delay = 200, double transition = 10) => new JObject
    {
        ["actionId"] = "clip:pose", ["kind"] = "clip", ["mode"] = "position", ["dataItemId"] = "point:pose",
        ["inputMin"] = 0d, ["inputMax"] = 100d, ["speed"] = 1d,
        ["transitionSeconds"] = transition, ["feedbackSmoothingMs"] = delay, ["trigger"] = new JObject { ["mode"] = "range" }
    };
    private static JObject FeedbackFrame(JToken raw, double source, double now, string quality = "good") => new JObject
    {
        ["timestamp"] = FeedbackEpoch + now * 1000, ["motionInputOnly"] = true,
        ["motionInputs"] = new JObject { ["clip:pose"] = new JObject
        {
            ["dataItemId"] = "point:pose", ["value"] = raw, ["quality"] = quality,
            ["timestamp"] = FeedbackEpoch + source * 1000, ["staleMs"] = 10000000d
        } }
    };
    private static void FeedbackRead(MotionSignalState state, JObject binding, double value, double source, double? now = null)
    {
        var at = now ?? source;
        state.Receive(FeedbackFrame(new JValue(value), source, at), binding, at, FeedbackEpoch + at * 1000);
    }
    private static void FeedbackNear(double actual, double expected, string message)
        => Check(Math.Abs(actual - expected) < 1e-9, message + $" (actual={actual:R}, expected={expected:R})");
    private static Task FeedbackSmoothingFollowsSourceSegments()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState();
        FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 2, .2);
        FeedbackNear(state.Target, .02, "display delay changed the newest real target");
        FeedbackNear(state.Position, 0, "a new 200ms sample jumped the pose immediately");
        for (var i = 1; i <= 20; i++)
        {
            var now = .2 + i * .01; state.Step(.01, now, 10000, binding);
            FeedbackNear(state.Position, (now - .2) * .1, "continuous 2% PLC step was not interpolated per render frame");
        }
        FeedbackRead(state, binding, 4, .4); state.Step(.01, .5, 10000, binding);
        FeedbackNear(state.Position, .03, "next observed segment did not join its predecessor");
        FeedbackRead(state, binding, 2, .6); state.Step(.01, .7, 10000, binding);
        FeedbackNear(state.Position, .03, "actual reversal was rounded away or replayed backward");
        FeedbackRead(state, binding, 80, .8);
        FeedbackNear(state.NumericValue, 80, "raw numeric value was replaced by the delayed pose");
        Check(state.Running, "running interpretation waited for display interpolation");
        state.Step(.01, .9, 10000, binding); FeedbackNear(state.Position, .41, "a large source step stacked the old 10s full-span slew");
        state.Step(.01, 1, 10000, binding); FeedbackNear(state.Position, .8, "latest stable target was not reached within 200ms");

        var peak = new MotionSignalState(); FeedbackRead(peak, binding, 0, 0); FeedbackRead(peak, binding, 100, .2); FeedbackRead(peak, binding, 0, .4);
        peak.Step(.01, .3, 10000, binding); FeedbackNear(peak.Position, .5, "buffered peak ascent was lost");
        peak.Step(.01, .4, 10000, binding); FeedbackNear(peak.Position, 1, "brief observed peak was skipped");
        peak.Step(.01, .5, 10000, binding); FeedbackNear(peak.Position, .5, "brief observed peak reversal was skipped");
        peak.Step(.01, .6, 10000, binding); FeedbackNear(peak.Position, 0, "peak replay grew beyond the configured bound");
        Check(!peak.Running && peak.NumericValue == 0 && peak.Target == 0, "source decisions used the delayed observed peak");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingUsesSourceAge()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState();
        FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 100, .2, .3);
        state.Step(.01, .3, 10000, binding);
        FeedbackNear(state.ReceivedAt, .2, "transport age was removed from the observation clock");
        FeedbackNear(state.Position, .5, "200ms feedback delay was added after transport rather than to the source timeline");
        state.Step(.01, .4, 10000, binding); FeedbackNear(state.Position, 1, "transport-aged target accumulated extra lag");
        state.Step(.01, 2, 10000, binding); FeedbackNear(state.Position, 1, "display predicted beyond the latest actual sample");
        var cached = new MotionSignalState(); FeedbackRead(cached, binding, 0, 0);
        var frame = FeedbackFrame(new JValue(100d), .4, .4); frame["cachedAgeMs"] = 200d;
        cached.Receive(frame, binding, .4, FeedbackEpoch + 400); cached.Step(.01, .4, 10000, binding);
        FeedbackNear(cached.ReceivedAt, .2, "cached age was discarded by display history");
        FeedbackNear(cached.Position, 1, "cached packet was treated as a newly acquired PLC position");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingRejectsInventedTime()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState();
        FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 80, .2); state.Step(.01, .3, 10000, binding);
        FeedbackRead(state, binding, 80, .2, .31); FeedbackNear(state.Position, .4, "duplicate source time reset the displayed history");
        FeedbackNear(state.ReceivedAt, .2, "duplicate source time renewed freshness");
        state.Step(.01, .32, 10000, binding); FeedbackNear(state.Position, .48, "duplicate packet created a second interpolation segment");
        state.Step(.01, .30, 10000, binding); FeedbackNear(state.Position, .48, "a regressed render clock replayed the display history backwards");
        FeedbackRead(state, binding, 0, .1, .33); FeedbackNear(state.Target, .8, "older source time replaced the real target");
        state.Step(.01, .34, 10000, binding); FeedbackNear(state.Position, .56, "older source time invalidated a usable display segment");
        FeedbackRead(state, binding, 20, .2, .35); FeedbackNear(state.Position, .2, "changed value with identical source time invented a slope");
        FeedbackNear(state.NumericValue, 20, "same-time raw observation semantics changed");
        FeedbackNear(state.ReceivedAt, .2, "same-time changed value renewed freshness");
        FeedbackRead(state, binding, 40, .4); state.Step(.01, .5, 10000, binding); FeedbackNear(state.Position, .3, "same-time fallback did not accept the next actual source segment");

        var clipped = new MotionSignalState(); FeedbackRead(clipped, binding, 0, 0); FeedbackRead(clipped, binding, 100, .2); clipped.Step(.01, .3, 10000, binding);
        FeedbackRead(clipped, binding, 120, .2, .31);
        FeedbackNear(clipped.Position, 1, "normalization hid a conflicting raw value with duplicate source time");
        FeedbackNear(clipped.NumericValue, 120, "out-of-range source value was overwritten by normalized display data");
        state.Step(.01, 5.401, 5000, binding); Check(!state.Usable && !state.Running, "buffer kept source data fresh after timeout");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingFreezesAndRecovers()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState();
        FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 80, .2); state.Step(.01, .3, 10000, binding);
        var bad = FeedbackFrame(new JValue(100d), .35, .35, "bad");
        state.Receive(bad, binding, .35, FeedbackEpoch + 350); state.Step(.01, .36, 10000, binding);
        Check(!state.Usable && !state.Running, "bad quality was masked by the smoothing history"); FeedbackNear(state.Position, .4, "bad quality continued stale motion");
        FeedbackRead(state, binding, 50, .4); FeedbackNear(state.Position, .5, "recovery replayed a stale pre-fault history");
        FeedbackRead(state, binding, 70, .6); state.Step(.01, .7, 10000, binding); FeedbackNear(state.Position, .6, "recovered source did not start a new valid segment");
        state.Suspend(); state.Step(.01, .8, 10000, binding); FeedbackNear(state.Position, .6, "disconnect continued interpolation");
        FeedbackRead(state, binding, 10, .9); FeedbackNear(state.Position, .1, "reconnect did not directly align the first real feedback");
        var wrong = FeedbackFrame(new JValue(100d), 1, 1); wrong["motionInputs"]["clip:pose"]["dataItemId"] = "point:other";
        state.Receive(wrong, binding, 1, FeedbackEpoch + 1000); state.Step(.01, 1.1, 10000, binding);
        Check(!state.Usable, "smoothing accepted another device's input"); FeedbackNear(state.Position, .1, "another source moved the display");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingKeepsLegacySemantics()
    {
        var legacy = FeedbackBinding(0, 2); var absent = (JObject)legacy.DeepClone(); absent.Remove("feedbackSmoothingMs");
        var a = new MotionSignalState(); var b = new MotionSignalState();
        foreach (var pair in new[] { (0d, 0d), (100d, .2), (20d, .4), (80d, .6) })
        {
            FeedbackRead(a, legacy, pair.Item1, pair.Item2); FeedbackRead(b, absent, pair.Item1, pair.Item2);
            a.Step(.1, pair.Item2 + .1, 10000, legacy); b.Step(.1, pair.Item2 + .1, 10000, absent);
            Check(a.Position == b.Position && a.Target == b.Target && a.NumericValue == b.NumericValue && a.Seconds == b.Seconds && a.Running == b.Running && a.Recovering == b.Recovering,
                "default zero changed the original full-span transition or signal interpretation");
        }
        foreach (var malformed in new JToken[] { new JValue(-1), new JValue(1001), new JValue(true), new JValue("200"), JValue.CreateNull() })
        {
            var binding = FeedbackBinding(0, 2); binding["feedbackSmoothingMs"] = malformed;
            var state = new MotionSignalState(); FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 100, .2); state.Step(.5, .7, 10000, binding);
            FeedbackNear(state.Position, .25, "malformed smoothing setting silently enabled interpolation");
        }
        var boolBinding = JObject.Parse("{mode:'position',sourceGroup:'doors',sourceKey:'open',inputMin:0,inputMax:1,transitionSeconds:2,feedbackSmoothingMs:200}");
        var boolState = new MotionSignalState(); boolState.Receive(JObject.Parse("{doors:{open:false}}"), boolBinding, 0); boolState.Receive(JObject.Parse("{doors:{open:true}}"), boolBinding, .2); boolState.Step(.5, .7, 10000, boolBinding);
        FeedbackNear(boolState.Position, .25, "numeric smoothing converted BOOL feedback into invented intermediate travel");
        var textState = new MotionSignalState(); textState.Receive(JObject.Parse("{doors:{open:'0'}}"), boolBinding, 0); textState.Receive(JObject.Parse("{doors:{open:'1'}}"), boolBinding, .2); textState.Step(.5, .7, 10000, boolBinding);
        FeedbackNear(textState.Position, .25, "numeric smoothing retyped a legacy text source");
        var condition = FeedbackBinding(200, 2); condition["trigger"] = JObject.Parse("{mode:'condition',operator:'gte',value:50}");
        var conditional = new MotionSignalState(); FeedbackRead(conditional, condition, 0, 0); FeedbackRead(conditional, condition, 100, .2); conditional.Step(.5, .7, 10000, condition);
        FeedbackNear(conditional.Position, .25, "condition action inherited numeric feedback smoothing"); Check(conditional.Running && conditional.NumericValue == 1, "condition output waited on pose delay");
        var running = FeedbackBinding(200, 2); running["mode"] = "running";
        var loop = new MotionSignalState(); FeedbackRead(loop, running, 0, 0); FeedbackRead(loop, running, 100, .2); loop.Step(.5, .7, 10000, running);
        FeedbackNear(loop.Position, .25, "running action inherited position feedback smoothing"); FeedbackNear(loop.Seconds, .5, "running clip's clock was delayed");
        // The complete endpoint suite runs separately; an authored extra field
        // must not alter its confirmed target/transition semantics here either.
        var endpoint = FeedbackBinding(200, 2); endpoint["trigger"] = JObject.Parse("{mode:'endpoints',extended:{dataItemId:'point:e'},retracted:{dataItemId:'point:r'}}");
        JObject EndpointFrame(bool extended, double at) => new JObject
        {
            ["timestamp"] = FeedbackEpoch + at * 1000, ["motionInputs"] = new JObject { ["clip:pose"] = new JObject
            {
                ["quality"] = "good", ["endpointFeedback"] = new JObject
                {
                    ["extended"] = new JObject { ["dataItemId"] = "point:e", ["value"] = extended, ["quality"] = "good", ["timestamp"] = FeedbackEpoch + at * 1000 },
                    ["retracted"] = new JObject { ["dataItemId"] = "point:r", ["value"] = !extended, ["quality"] = "good", ["timestamp"] = FeedbackEpoch + at * 1000 }
                }
            } }
        };
        var ends = new MotionSignalState(); ends.Receive(EndpointFrame(false, 0), endpoint, 0, FeedbackEpoch); ends.Receive(EndpointFrame(true, .2), endpoint, .2, FeedbackEpoch + 200); ends.Step(.5, .7, 10000, endpoint);
        FeedbackNear(ends.Position, .25, "endpoint confirmation was reinterpreted as measured intermediate position"); Check(ends.Target == 1 && !ends.Running && ends.EndpointStage == "extended", "endpoint semantics changed");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingIsBounded()
    {
        var binding = FeedbackBinding(1000); var state = new MotionSignalState(); FeedbackRead(state, binding, 0, 0);
        for (var i = 1; i < 64; i++) FeedbackRead(state, binding, i, i * .001);
        Check(((JArray)state.CaptureDisplayState(binding)["feedbackHistory"]).Count == 64, "fixed source history did not retain each unshown observation");
        FeedbackRead(state, binding, 64, .064); FeedbackNear(state.Position, .64, "full unshown history was silently shifted instead of safely aligning");
        Check(((JArray)state.CaptureDisplayState(binding)["feedbackHistory"]).Count == 1 && state.Target == .64 && state.NumericValue == 64, "overflow grew history or changed the newest source observation");
        for (var i = 65; i < 1000; i++)
        {
            FeedbackRead(state, binding, i % 101, i * .01); state.Step(.01, i * .01, 100000, binding);
            var history = (JArray)state.CaptureDisplayState(binding)["feedbackHistory"];
            Check(history.Count <= 64, "feedback queue grew beyond its fixed bound");
        }
        state.Step(.01, 10.99, 100000, binding); FeedbackNear(state.Position, state.Target, "high-rate display history accumulated unbounded replay lag");
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingSnapshotsAreScoped()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState(); FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 80, .2); state.Step(.01, .3, 10000, binding);
        var snapshot = state.CaptureDisplayState(binding); var restored = new MotionSignalState();
        Check(restored.RestoreDisplayState(binding, snapshot), "unchanged action lost native display state");
        Check(restored.Position == state.Position && restored.NumericValue == state.NumericValue && restored.SourceTimestamp == state.SourceTimestamp && restored.ReceivedAt == state.ReceivedAt,
            "native refresh changed the raw observation or displayed pose");
        restored.Step(.01, .32, 10000, binding); state.Step(.01, .32, 10000, binding); Check(restored.Position == state.Position, "native refresh lost the in-flight source interpolation history");
        foreach (var key in new[] { "dataItemId", "actionId", "inputMax", "invert", "feedbackSmoothingMs" })
        {
            var changed = (JObject)binding.DeepClone(); changed[key] = key == "invert" ? new JValue(true) : key == "inputMax" ? new JValue(200) : key == "feedbackSmoothingMs" ? new JValue(400) : new JValue("other");
            Check(!new MotionSignalState().RestoreDisplayState(changed, snapshot), "changed binding inherited old interpolation: " + key);
        }
        foreach (var corrupt in new JArray[] { new JArray(), new JArray(new JArray(.2, .8), new JArray(.1, 0)), new JArray(new JArray(true, .8)), new JArray(Enumerable.Range(0, 65).Select(i => new JArray(i, .8))) })
        {
            var damaged = (JObject)snapshot.DeepClone(); damaged["feedbackHistory"] = corrupt;
            var fallback = new MotionSignalState(); Check(fallback.RestoreDisplayState(binding, damaged), "invalid display-only history prevented restoration of valid raw state");
            FeedbackNear(fallback.Position, fallback.Target, "malformed snapshot history was replayed instead of directly aligning");
            FeedbackNear(fallback.NumericValue, 80, "malformed display history changed the captured source value");
        }
        foreach (var corrupt in new JToken[] { null, JValue.CreateNull(), new JValue("invalid"), new JObject() })
        {
            var damaged = (JObject)snapshot.DeepClone(); if (corrupt == null) damaged.Remove("feedbackHistory"); else damaged["feedbackHistory"] = corrupt;
            var fallback = new MotionSignalState(); Check(fallback.RestoreDisplayState(binding, damaged), "missing display history prevented restoration of raw state");
            fallback.Step(.01, .34, 10000, binding); FeedbackNear(fallback.Position, fallback.Target, "missing display history enabled an unbounded legacy slew after numeric restoration");
        }
        return Task.CompletedTask;
    }
    private static Task FeedbackSmoothingStepDoesNotAllocate()
    {
        var binding = FeedbackBinding(); var state = new MotionSignalState(); FeedbackRead(state, binding, 0, 0); FeedbackRead(state, binding, 80, .2);
        for (var i = 0; i < 2048; i++) state.Step(.00001, .21, 10000000, binding);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 8192; i++) state.Step(.00001, .21 + i * .00001, 10000000, binding);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Check(allocated == 0, "per-frame feedback interpolation allocated " + allocated + " managed bytes");
        FeedbackNear(state.Position, .36764, "zero-allocation loop did not actually exercise an in-flight interpolation segment");
        return Task.CompletedTask;
    }
}
