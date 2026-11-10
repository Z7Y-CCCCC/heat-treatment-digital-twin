using Newtonsoft.Json.Linq;
using HeatTreatment.DigitalTwin.Backend;
internal static partial class Program
{
 private static Task RealtimeMotionQueueContract()
 {
  var fixtures=JObject.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"realtime-motion-queue-fixtures.json")));
  foreach(var fixture in fixtures["cases"].OfType<JObject>())
  {
   var queue=new RealtimeMessageQueue();queue.Reset(1);
   foreach(var message in fixture["messages"].OfType<JObject>())Check(queue.TryEnqueue(1,(JObject)message.DeepClone()),fixture.Value<string>("name"));
   var actual=new JArray();while(queue.TryDequeue(1,out var message))actual.Add(message);
   var name=fixture.Value<string>("name");
   if(fixture["expected"] is JArray expected)Check(JToken.DeepEquals(actual,expected),name+": source snapshots or clocks were changed: "+actual);
   foreach(var field in new[]{"expectedValues","expectedStages","expectedDataItemIds","expectedStatus"})
   {
    if(!(fixture[field] is JArray wanted))continue;
    var values=new JArray();
    foreach(var token in actual)
    {
     var device=token["payload"]["devices"][0];
     var value=field=="expectedStatus"?device["status"]["start_feed"]:device["motionInputs"]["feed"][field=="expectedValues"?"value":field=="expectedStages"?"stage":"dataItemId"];
     values.Add(value?.DeepClone());
    }
    Check(JToken.DeepEquals(values,wanted),name+": discrete edges/faults were lost: "+values);
   }
   Check(queue.Count==0&&queue.Bytes==0,name+": queue budget leaked");
  }
  return Task.CompletedTask;
 }
 private static JObject MotionQueueSample(object value,int timestamp) => new JObject
 {
  ["type"]="realtime_frame",["payload"]=new JObject {["timestamp"]=timestamp,["devices"]=new JArray(new JObject
  {
   ["furnace_id"]="cart",["timestamp"]=timestamp,["motionInputOnly"]=true,["motionInputs"]=new JObject{["feed"]=new JObject
   {["dataItemId"]="point:feed",["value"]=JToken.FromObject(value),["quality"]="good",["timestamp"]=timestamp,["staleMs"]=5000}}
  })}
 };
 private static Task RealtimeMotionQueueBoundedLoad()
 {
  var queue=new RealtimeMessageQueue();queue.Reset(1);
  for(var i=0;i<5000;i++)Check(queue.TryEnqueue(1,MotionQueueSample((double)i/5000,1000+i)),"numeric stream overloaded");
  Check(queue.Count==1,"numeric telemetry introduced replay latency");
  Check(queue.TryDequeue(1,out var latest)&&latest["payload"]["devices"][0]["motionInputs"]["feed"].Value<int>("timestamp")==5999,"latest exact read clock was not preserved");
  Check(queue.Bytes==0,"latest snapshot did not release byte budget");
  var numericCondition=new JObject{["key"]="action:feed",["kind"]="condition",["source"]=new JObject{["actionId"]="feed",["dataItemId"]="point:feed"},
   ["operator"]="gt",["value"]=50,["hysteresis"]=5};
  JObject Declared(object value,int timestamp,bool ready=true)
  {
   var sample=MotionQueueSample(value,timestamp);
   sample["payload"]["devices"][0]["motionSemantics"]=new JObject{["version"]=1,["ready"]=ready,["generation"]=1,["revision"]="r1",["factoryId"]="factory",
    ["bindings"]=new JArray(numericCondition.DeepClone())};
   return sample;
  }
  var sameCondition=new RealtimeMessageQueue();sameCondition.Reset(1);
  for(var i=0;i<5000;i++)Check(sameCondition.TryEnqueue(1,Declared(i%20,2000+i)),"same-state numeric condition overloaded");
  Check(sameCondition.Count==1,"configured condition retained numeric noise and added replay latency");
  Check(sameCondition.TryDequeue(1,out var exact)&&exact["payload"]["devices"][0]["motionInputs"]["feed"].Value<int>("timestamp")==6999,"configured condition changed the actual source clock");
  var rpmDeclaration=new JObject{["key"]="action:feed",["kind"]="signed_speed",["source"]=new JObject{["actionId"]="feed",["dataItemId"]="point:feed"},
   ["speedFactor"]=.10472f,["speed"]=1,["invert"]=false};
  var sameRpm=new RealtimeMessageQueue();sameRpm.Reset(1);
  for(var i=0;i<5000;i++){var sample=Declared(i+1,11000+i);sample["payload"]["devices"][0]["motionSemantics"]["bindings"]=new JArray(rpmDeclaration.DeepClone());
   Check(sameRpm.TryEnqueue(1,sample),"same-direction raw RPM overloaded");}
  Check(sameRpm.Count==1,"same-direction part RPM added a replay backlog");
  Check(sameRpm.TryDequeue(1,out var exactRpm)&&exactRpm["payload"]["devices"][0]["motionInputs"]["feed"].Value<int>("value")==5000
   &&exactRpm["payload"]["devices"][0]["motionInputs"]["feed"].Value<int>("timestamp")==15999,"part RPM was normalized or its source clock was changed");
  var pending=new RealtimeMessageQueue(maxMessages:32);pending.Reset(1);var pendingCount=0;
  for(var i=0;i<100;i++){if(!pending.TryEnqueue(1,Declared(i,1000+i,ready:false)))break;pendingCount++;}
  Check(pendingCount==32&&pending.Count==32,"cold semantic readiness dropped samples or grew an unbounded queue");
  pending.Clear(1);Check(pending.Count==0&&pending.Bytes==0,"pending-configuration resync did not release its budget");
  var edges=new RealtimeMessageQueue(maxMessages:32);edges.Reset(1);var accepted=0;
  for(var i=0;i<100;i++){if(!edges.TryEnqueue(1,MotionQueueSample(i%2==0,1000+i)))break;accepted++;}
  Check(accepted==32&&edges.Count==32,"discrete transitions are neither preserved nor bounded");
  edges.Clear(1);Check(edges.Count==0&&edges.Bytes==0,"resync did not release queued edges");
  return Task.CompletedTask;
 }
}
