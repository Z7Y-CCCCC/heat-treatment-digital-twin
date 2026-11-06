using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static Task MotionEndpointSignalsAreSafe()
    {
        var binding = JObject.Parse("{actionId:'clip:feed',mode:'position',transitionSeconds:2,trigger:{mode:'endpoints',extended:{dataItemId:'point:front'},retracted:{dataItemId:'point:back'}}}");
        JObject Frame(double now, JToken front, JToken back, string quality = "good", double? frontStamp = null, double? backStamp = null) => new JObject {
            ["timestamp"] = 1000000 + now * 1000, ["motionInputOnly"] = true,
            ["motionInputs"] = new JObject { ["clip:feed"] = new JObject {
                ["quality"] = quality, ["timestamp"] = Math.Min(frontStamp ?? 1000000 + now * 1000, backStamp ?? 1000000 + now * 1000),
                ["endpointFeedback"] = new JObject {
                    ["extended"] = new JObject { ["dataItemId"] = "point:front", ["value"] = front, ["quality"] = quality, ["timestamp"] = frontStamp ?? 1000000 + now * 1000, ["staleMs"] = 5000 },
                    ["retracted"] = new JObject { ["dataItemId"] = "point:back", ["value"] = back, ["quality"] = quality, ["timestamp"] = backStamp ?? 1000000 + now * 1000, ["staleMs"] = 5000 }
                }
            } }
        };
        void Check(bool result, string label) { if (!result) throw new Exception("endpoint feedback: " + label); }
        var signal = new MotionSignalState();
        Check(MotionSignalState.IsCatalogBinding(binding), "dual-endpoint binding is catalog driven even without a top-level dataItemId");
        signal.Receive(Frame(0, false, false), binding, 0);
        Check(!signal.Usable && !signal.HasSample && signal.EndpointStage == "waiting", "unknown initial pose stays unconfirmed");
        signal.Receive(Frame(1, false, true), binding, 1); Check(signal.Usable && signal.Position == 0 && signal.EndpointStage == "retracted", "back endpoint confirms zero");
        signal.Receive(Frame(2, true, false), binding, 2); signal.Step(.5, 2.5, 5000, binding);
        Check(signal.Target == 1 && Math.Abs(signal.Position - .25) < 1e-9 && !signal.Running && signal.Seconds == 0, "healthy confirmed target permits display-only smoothing, not inferred running");
        signal.Receive(Frame(3, false, false), binding, 3); signal.Step(1, 4, 5000, binding);
        Check(!signal.Usable && signal.Position == .25 && signal.EndpointStage == "waiting" && signal.Reason == "等待到位反馈", "both-off cannot complete or reverse a stroke");
        var snapshot = signal.CaptureEndpointDisplayState(binding); var restored = new MotionSignalState();
        Check(restored.RestoreEndpointDisplayState(binding, (JObject)snapshot.DeepClone()), "same action/source identity restores display pose on configuration rebuild");
        Check(restored.Position == .25 && !restored.Usable && restored.EndpointStage == "waiting", "restored waiting pose does not falsely reset to zero");
        var different = (JObject)binding.DeepClone(); different["trigger"]["extended"]["dataItemId"] = "point:other";
        Check(!new MotionSignalState().RestoreEndpointDisplayState(different, snapshot), "changed source cannot inherit old mechanical pose");
        signal.Receive(Frame(4, true, true), binding, 4); signal.Step(.5, 4.5, 5000, binding);
        Check(signal.Position == .25 && !signal.Usable && signal.EndpointStage == "conflict", "both-on conflict freezes");
        signal.Receive(Frame(5, true, false), binding, 5);
        Check(signal.Position == 1 && signal.Usable, "conflict recovery aligns directly to latest confirmed endpoint");
        signal.Receive(Frame(6, false, true, "bad"), binding, 6); signal.Step(.5, 6.5, 5000, binding);
        Check(signal.Position == 1 && !signal.Usable, "bad quality freezes rather than trusting opposite endpoint");
        signal.Receive(Frame(7, false, true), binding, 7); Check(signal.Position == 0, "reconnect follows current endpoint without continuing a saved timer");
        signal.Receive(Frame(8, true, false, frontStamp: 1006000, backStamp: 1008000), binding, 8);
        Check(signal.Position == 0 && signal.EndpointStage == "retracted" && signal.Usable, "one stale/out-of-order endpoint rejects complete pair");
        signal.Receive(Frame(8, 1, false), binding, 8); Check(!signal.Usable && signal.Position == 0, "numeric one is not a boolean feedback");
        var wrong = Frame(9, true, false); wrong["motionInputs"]["clip:feed"]["endpointFeedback"]["extended"]["dataItemId"] = "point:other";
        signal.Receive(wrong, binding, 9); Check(!signal.Usable && signal.Position == 0, "point identity mismatch cannot drive motion");
        signal.Receive(Frame(10, true, false), binding, 10); Check(signal.Position == 1, "fresh recovery confirms current front endpoint");
        signal.Receive(Frame(14, false, true, frontStamp: 1010000, backStamp: 1010000), binding, 14); signal.Step(.5, 16, 5000, binding);
        Check(!signal.Usable && signal.Position == 1 && signal.Reason == "数据超时", "replayed read timestamps cannot extend lifetime");
        signal.Receive(Frame(17, false, false), binding, 17); signal.Step(.5, 17.5, 5000, binding);
        Check(!signal.Usable && signal.Position == 1, "fresh both-off reconnect remains unknown, not complete");
        signal.Receive(Frame(18, false, true), binding, 18); Check(signal.Position == 0, "valid endpoint after unknown recovery snaps current feedback");
        var summaryBad = Frame(19, false, false); summaryBad["motionInputs"]["clip:feed"]["quality"] = "bad";
        var summarySignal = new MotionSignalState(); summarySignal.Receive(summaryBad, binding, 19); Check(!summarySignal.Usable && summarySignal.EndpointStage == "invalid", "bad aggregate quality cannot report ordinary waiting even when inner quality is good");
        var summaryConflict = Frame(19.2, true, true); summaryConflict["motionInputs"]["clip:feed"]["quality"] = "bad";
        summarySignal.Receive(summaryConflict, binding, 19.2); Check(summarySignal.EndpointStage == "conflict", "two healthy true feedbacks retain conflict priority over aggregate quality");
        var ownAge = Frame(20, true, false, frontStamp: 1019500, backStamp: 1018000);
        ownAge["motionInputs"]["clip:feed"]["endpointFeedback"]["extended"]["staleMs"] = 1000;
        signal.Receive(ownAge, binding, 20); Check(signal.Usable, "each source uses its own freshness bound");
        signal.Step(.1, 20.6, 5000, binding); Check(!signal.Usable, "short-lived endpoint expires independently of newer peer");
        binding["invert"] = true; signal.Receive(Frame(21, true, false), binding, 21);
        Check(signal.Position == 0 && signal.EndpointStage == "extended", "display inversion does not change feedback stage semantics");
        return Task.CompletedTask;
    }
}
