using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
internal static partial class Program
{
    private static Task TransferCycleMatchesSharedTraces()
    {
        var fixture=JObject.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"transfer-cycle-fixtures.json")));
        foreach(var trace in fixture["traces"]){
            var c=trace["config"];var config=new TransferCycleConfig{ExtendSeconds=c.Value<double>("extendSeconds"),LatchSeconds=c.Value<double>("latchSeconds"),RetractSeconds=c.Value<double>("retractSeconds"),ConveySeconds=c.Value<double>("conveySeconds"),ConfirmTimeoutSeconds=c.Value<double>("confirmTimeoutSeconds")};var state=new TransferCycleState();
            foreach(var row in trace["steps"]){var i=row["input"];state.Advance(new TransferCycleInput{Valid=i.Value<bool>("valid"),Docked=i.Value<bool>("docked"),Start=i.Value<bool>("start"),Pickup=i.Value<bool>("pickup"),SourcePresent=i.Value<bool>("sourcePresent"),TargetPresent=i.Value<bool>("targetPresent"),MouthFraction=i.Value<double>("mouthFraction")},row.Value<double>("delta"),config);
                var e=row["expected"];Check(state.Phase==e.Value<string>("phase")&&state.Confirmed==e.Value<bool>("confirmed")&&state.Paused==e.Value<bool>("paused")&&state.Armed==e.Value<bool>("armed"),"Native/Three cycle phase/ownership mismatch");
                foreach(var pair in new[]{("feed",state.Feed),("hook",state.Hook),("cargo",state.Cargo),("elapsed",state.Elapsed),("convey",state.Convey)})Check(Math.Abs(pair.Item2-e.Value<double>(pair.Item1))<1e-10,"Native/Three intermediate "+pair.Item1+" mismatch");
            }
        }
        return Task.CompletedTask;
    }
    private static Task TransferBoolObservationsAreOwnedAndOrdered()
    {
        var state=new TransferBooleanObservation("cart","__transfer_start","start");const double wall=1000000;
        JObject F(JToken value,double stamp,string quality="good")=>new JObject{["furnace_id"]="cart",["timestamp"]=stamp,["motionInputs"]=new JObject{["__transfer_start"]=new JObject{["dataItemId"]="start",["value"]=value,["timestamp"]=stamp,["quality"]=quality,["staleMs"]=1000}}};
        state.Receive(F(true,wall),1,wall);Check(state.Advance(1,5000)&&state.Value,"Owned BOOL true was not accepted");
        state.Receive(F(1,wall+100),1.1,wall+100);Check(!state.Usable,"Numeric 1 became a BOOL transfer command");
        state.Receive(F(true,wall+50),1.2,wall+100);Check(!state.Usable,"Old pre-fault source revived transfer after a typed fault");
        state.Receive(F(false,wall+200),1.3,wall+200);Check(state.Advance(1.3,5000)&&!state.Value,"Fresh BOOL recovery failed");
        state.Receive(F(false,wall+200),2.2,wall+200);Check(!state.Advance(2.31,5000),"Replay renewed original transfer feedback age");
        var raw=new TransferBooleanObservation("furnace","4","mechanisms","present");
        var frame=new JObject{["furnace_id"]="furnace",["timestamp"]=wall,["mechanisms"]=new JObject{["present"]=true},["quality"]=new JObject{["mechanisms"]=new JObject{["present"]="good"}},["pointMeta"]=new JObject{["mechanisms.present"]=new JObject{["id"]="4",["category"]="mechanisms",["field_name"]="present",["timestamp"]=wall}}};
        raw.Receive(frame,1,wall);Check(raw.Advance(1,5000)&&raw.Value,"Owned target BOOL was not accepted");frame["pointMeta"]=new JArray();raw.Receive(frame,1.1,wall);Check(!raw.Usable,"Malformed target metadata was accepted");
        return Task.CompletedTask;
    }
}
