using System;
using System.Collections.Generic;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEngine;
namespace HeatTreatment.DigitalTwin.Editor
{
    public static class IndependentArrivalValidation
    {
        public static void Validate()
        {
            var root = new GameObject("Independent arrival validation"); var checks = 0;
            void Check(bool value, string why) { if (!value) throw new InvalidOperationException(why); checks++; }
            try
            {
                var movement = JObject.Parse("{enabled:true,valueMode:'station',stationInputMeaning:'target',simulationEnabled:true,currentPositionPointId:'101',arrivalPositionPointId:'103',startActionPointId:'102',maxSpeed:2,acceleration:1,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:10,y:0,z:0}}]}");
                var device = new DeviceDto { Id = "arrival", InstanceConfig = new JObject { ["movement"] = movement }, DataPoints = new List<DataPointDto> {
                    new DataPointDto { Id=101,DeviceId="arrival",DataType="WORD",AccessType="READ",Category="analog",ValueRole="target" },
                    new DataPointDto { Id=102,DeviceId="arrival",DataType="BOOL",AccessType="READ",Category="motors",ValueRole="moving" },
                    new DataPointDto { Id=103,DeviceId="arrival",DataType="WORD",AccessType="READ",Category="analog",ValueRole="arrival" } } };
                var motion=root.AddComponent<MobileDeviceMotion>(); motion.Initialize(device);
                long stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-100;
                JObject Frame(int target,int arrived,bool moving,string quality="good") {
                    stamp++;
                    return new JObject { ["timestamp"]=stamp,["status"]=new JObject{["online"]=true,["quality"]="good"},
                        ["analog"]=new JObject{["target"]=target,["arrival"]=arrived},["motors"]=new JObject{["moving"]=moving},
                        ["quality"]=new JObject{["overall"]="good",["analog"]=new JObject{["target"]="good",["arrival"]=quality},["motors"]=new JObject{["moving"]="good"}},
                        ["pointMeta"]=new JObject{
                            ["analog.target"]=new JObject{["id"]=101,["category"]="analog",["field_name"]="target",["timestamp"]=stamp},
                            ["analog.arrival"]=new JObject{["id"]=103,["category"]="analog",["field_name"]="arrival",["timestamp"]=stamp},
                            ["motors.moving"]=new JObject{["id"]=102,["category"]="motors",["field_name"]="moving",["timestamp"]=stamp}} };
                }
                Check(!motion.HasConfirmedPosition,"Missing feedback confirmed a dock");
                motion.ApplyRealtime(Frame(2,1,false));
                Check(motion.HasConfirmedPosition && motion.CurrentPositionValue==1 && root.transform.localPosition.Equals(Vector3.zero),"A target replaced the independently observed current dock");
                motion.ApplyRealtime(Frame(2,1,true)); motion.AdvanceMotion(.5f,Time.realtimeSinceStartupAsDouble+.5);
                Check(root.transform.localPosition.x>0 && root.transform.localPosition.x<10 && !motion.HasConfirmedPosition,"Independent arrival suppressed estimated travel or confirmed transit");
                for(var i=0;i<100;i++)motion.AdvanceMotion(.05f,Time.realtimeSinceStartupAsDouble+.5+i*.001);
                Check(!motion.HasConfirmedPosition,"Finishing estimated movement manufactured an arrival observation");
                motion.ApplyRealtime(Frame(2,2,false));
                Check(motion.HasConfirmedPosition && motion.HasReliableSourcePose && motion.CurrentPositionValue==2 && root.transform.localPosition.x==10,"Fresh independent arrival failed to confirm the correct endpoint");
                motion.ApplyRealtime(Frame(1,2,true));
                Check(!motion.HasConfirmedPosition && !motion.HasReliableSourcePose,"Held last station confirmed a moving cart");
                motion.ApplyRealtime(Frame(1,1,false,"bad"));
                Check(!motion.HasConfirmedPosition,"Bad arrival quality confirmed docking");
                motion.ApplyRealtime(Frame(1,99,false));
                Check(!motion.HasConfirmedPosition,"Unknown arrival station confirmed docking");
                motion.ApplyRealtime(Frame(1,1,false)); motion.AdvanceMotion(.01f,Time.realtimeSinceStartupAsDouble+10);
                Check(!motion.HasConfirmedPosition && !motion.HasReliableSourcePose,"Expired independent feedback kept docking alive");
                motion.ApplyRealtime(Frame(1,1,false)); motion.SuspendInputs();
                Check(!motion.HasConfirmedPosition && !motion.HasReliableSourcePose,"Disconnect retained independent docking");
                movement.Remove("arrivalPositionPointId"); motion.Initialize(device); motion.ApplyRealtime(Frame(2,2,false));
                Check(!motion.HasConfirmedPosition,"An unbound target-only configuration gained docking permission");
                Debug.Log("[IndependentArrivalValidation] PASS "+checks+" checks");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
    }
}
