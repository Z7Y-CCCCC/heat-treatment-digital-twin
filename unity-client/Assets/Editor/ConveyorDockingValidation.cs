using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    public static class ConveyorDockingValidation
    {
        private static int _checks;
        private static readonly List<GameObject> Owned = new List<GameObject>();
        private static void Check(bool value, string message) { if (!value) throw new Exception(message); _checks++; }
        private static GameObject Node(string name, Transform parent = null)
        { var node = new GameObject(name); node.transform.SetParent(parent, false); Owned.Add(node); return node; }
        private static JObject Package() => JObject.Parse(@"{nodes:[{name:'Roller',q:[0,0,0,1],v:[1]},{name:'Fan',q:[0,0,0,1],v:[1]}],clips:[
            {id:'rollers',count:5,duration:4,tracks:[{node:'Roller',channel:'q',size:4,values:[0,0,0,1,.70710678,0,0,.70710678,1,0,0,0,.70710678,0,0,-.70710678,0,0,0,-1]}]},
            {id:'circulation',count:5,duration:4,tracks:[{node:'Fan',channel:'q',size:4,values:[0,0,0,1,0,.70710678,0,.70710678,0,1,0,0,0,.70710678,0,-.70710678,0,0,0,-1]}]}]}");
        private static JObject Animation() => JObject.Parse(@"{staleMs:5000,bindings:[
            {actionId:'clip:rollers',clipId:'rollers',kind:'clip',enabled:true,mode:'running',speed:1,dataItemId:'point:roll',trigger:{mode:'condition',operator:'eq',value:true}},
            {actionId:'clip:circulation',clipId:'circulation',kind:'clip',enabled:true,mode:'running',speed:1,dataItemId:'point:fan',trigger:{mode:'condition',operator:'eq',value:true}}]}");
        private static void DirectionChecks()
        {
            foreach (var yaw in new[] { 0, 90, 180, 37 }) foreach (var scale in new[] { Vector3.one, new Vector3(-1,1,1), new Vector3(2,1,3) }) {
                var frame = Node("Workshop"); frame.transform.rotation = Quaternion.Euler(0,29,0);
                var root = Node("Conveyor", frame.transform); root.transform.localRotation = Quaternion.Euler(0,yaw,0); root.transform.localScale = scale;
                var roller = Node("Roller", root.transform).transform; var fan = Node("Fan", root.transform).transform;
                var device = new DeviceDto { Id="conveyor", InstanceConfig=new JObject {
                    ["loadingPortSignals"]=JObject.Parse("{version:1,inletPointId:'1',outletPointId:'2'}"), ["animationBindings"]=Animation() } };
                var driver = root.AddComponent<DeviceAnimationDriver>(); driver.Configure(device,Package());
                driver.ApplyMotionInputs(JObject.Parse(@"{timestamp:1000000,motionInputOnly:true,motionInputs:{
                    'clip:rollers':{dataItemId:'point:roll',value:true,quality:'good',timestamp:1000000,staleMs:5000},
                    'clip:circulation':{dataItemId:'point:fan',value:true,quality:'good',timestamp:1000000,staleMs:5000}}}"),0);
                var travel = root.transform.TransformVector(Vector3.forward).normalized; var clock=0d;
                float SurfaceStep(Vector3 wanted) {
                    driver.SetConveyorTravel(wanted);
                    var top=roller.InverseTransformPoint(roller.position+Vector3.up*.2f); var before=roller.TransformPoint(top);
                    clock+=.02; driver.Advance(.02,clock); return Vector3.Dot(roller.TransformPoint(top)-before, wanted.normalized);
                }
                Check(SurfaceStep(travel)>.00001f,"Outfeed upper roller surface travels backwards at yaw "+yaw+" scale "+scale);
                var held=roller.localRotation; driver.SetConveyorTravel(-travel);
                Check(roller.localRotation.Equals(held),"Changing conveyor direction jumped to another animation phase");
                Check(SurfaceStep(-travel)>.00001f,"Infeed did not reverse the actual upper surface at yaw "+yaw+" scale "+scale);
                held=roller.localRotation;var fanBefore=fan.localRotation;
                driver.SetConveyorTravel(Vector3.zero);clock+=.02;driver.Advance(.02,clock);
                Check(roller.localRotation.Equals(held),"Unknown/conflicting transfer direction continued conveyor rotation");
                Check(Quaternion.Angle(fanBefore,fan.localRotation)>.1f,"Conveyor direction changed or stopped the unrelated fan clip");
                driver.SetConveyorTravel(travel);held=roller.localRotation;driver.Advance(.1,clock+6);
                Check(roller.localRotation.Equals(held),"Stale PLC feedback continued signed conveyor motion");
            }
        }
        private static void DockingChecks()
        {
            var frame=Node("Transformed line");frame.transform.position=new Vector3(30,4,-12);frame.transform.rotation=Quaternion.Euler(0,37,0);frame.transform.localScale=new Vector3(2,1,2);
            var cartRoot=GameObject.CreatePrimitive(PrimitiveType.Cube);Owned.Add(cartRoot);cartRoot.transform.SetParent(frame.transform,false);
            var fixedRoot=GameObject.CreatePrimitive(PrimitiveType.Cube);Owned.Add(fixedRoot);fixedRoot.transform.SetParent(frame.transform,false);fixedRoot.transform.localPosition=new Vector3(3,0,5);
            var movement=JObject.Parse("{enabled:true,displayMode:'simple',valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'1',arrivalSignalPointId:'2',arrivalSmoothing:false,start:{x:0,y:0,z:0},end:{x:20,y:0,z:0},stations:[{value:1,anchorDeviceId:'fixed',position:{x:0,y:0,z:0}}]}");
            var cart=new DeviceDto{Id="cart",ModelType="cart_asset",InstanceConfig=new JObject{["movement"]=movement,["loadingPortSignals"]=JObject.Parse("{version:1,inletPointId:'3',outletPointId:'4'}")},DataPoints=new List<DataPointDto>{
                new DataPointDto{Id=1,DeviceId="cart",Category="status",Name="target",ValueRole="target",DataType="WORD",AccessType="READ"},
                new DataPointDto{Id=2,DeviceId="cart",Category="status",Name="arrived",ValueRole="arrived",DataType="BOOL",AccessType="READ"},
                new DataPointDto{Id=3,DeviceId="cart",Category="status",Name="take",ValueRole="take",DataType="BOOL",AccessType="READ"},
                new DataPointDto{Id=4,DeviceId="cart",Category="status",Name="feed",ValueRole="feed",DataType="BOOL",AccessType="READ"}}};
            var fixedDevice=new DeviceDto{Id="fixed",ModelType="fixed_asset",InstanceConfig=new JObject()};
            var models=new[]{new ModelAssetDto{Id="cart_asset",Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[-.25,.5,.5],direction:[0,0,1],nodeName:''},outlet:{position:[-.25,.5,.5],direction:[0,0,1],nodeName:''}}}")},
                new ModelAssetDto{Id="fixed_asset",Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[-.75,.5,-.5],direction:[0,0,-1],nodeName:''},outlet:{position:[-.75,.5,-.5],direction:[0,0,-1],nodeName:''}}}")}};
            var baseline=movement.DeepClone();var fixedMatrix=fixedRoot.transform.localToWorldMatrix;
            var motion=cartRoot.AddComponent<MobileDeviceMotion>();motion.Initialize(cart);var roots=new Dictionary<string,Transform>{{"cart",cartRoot.transform},{"fixed",fixedRoot.transform}};
            var motions=new Dictionary<string,MobileDeviceMotion>{{"cart",motion}};
            using(var runtime=new RuntimeOwner()) {
                runtime.Value.Configure(new[]{cart,fixedDevice},models,roots,motions,frame.transform);
                runtime.Value.ResolveDockingAnchors();
                var stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                JObject F(bool feed) { var status=new JObject{["online"]=true,["target"]=1,["arrived"]=true,["take"]=false,["feed"]=feed};var quality=new JObject();var meta=new JObject();
                    var roles=new[]{"target","arrived","take","feed"};for(var i=0;i<roles.Length;i++){quality[roles[i]]="good";meta["status."+roles[i]]=new JObject{["id"]=i+1,["category"]="status",["field_name"]=roles[i],["timestamp"]=++stamp};}
                    return new JObject{["furnace_id"]="cart",["timestamp"]=stamp,["status"]=status,["quality"]=new JObject{["status"]=quality},["pointMeta"]=meta}; }
                void Send(bool feed){var f=F(feed);motion.ApplyRealtime(f);runtime.Value.Receive("cart",f,Time.realtimeSinceStartupAsDouble,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());}
                Send(false);Check(motion.HasConfirmedPosition&&Mathf.Abs(cartRoot.transform.localPosition.x-3.5f)<.0001f,"Station followed the equipment origin instead of both physical mouths");
                Check(Mathf.Abs(cartRoot.transform.localPosition.y)<.0001f&&Mathf.Abs(cartRoot.transform.localPosition.z)<.0001f,"Mouth alignment moved the cart off its rail plane");
                Send(true);runtime.Value.Advance(0,Time.realtimeSinceStartupAsDouble);
                var path=runtime.Value.Describe()["trips"][0]["path"] as JArray;
                var a=path[1].Values<float>().ToArray();var b=path[2].Values<float>().ToArray();var rail=frame.transform.TransformVector(Vector3.right).normalized;
                Check(Mathf.Abs(Vector3.Dot(new Vector3(b[0]-a[0],b[1]-a[1],b[2]-a[2]),rail))<.0001f,"Transfer still crosses sideways between aligned-height mouths");
                Check(fixedRoot.transform.localToWorldMatrix==fixedMatrix&&JToken.DeepEquals(movement,baseline),"Visual docking rewrote the fixed layout or station configuration");
                runtime.Value.Dispose();fixedRoot.transform.localPosition=new Vector3(8,0,5);
                runtime.Value.Configure(new[]{cart,fixedDevice},models,roots,motions,frame.transform);runtime.Value.ResolveDockingAnchors();Send(false);
                Check(Mathf.Abs(cartRoot.transform.localPosition.x-8.5f)<.0001f,"Live layout/port changes retained a stale docking correction");
            }
        }
        private sealed class RuntimeOwner:IDisposable { public readonly SimpleMaterialTransferRuntime Value=new SimpleMaterialTransferRuntime();public void Dispose()=>Value.Dispose(); }
        public static void Run()
        {
            try {_checks=0;DirectionChecks();DockingChecks();var dir=Environment.GetEnvironmentVariable("CONVEYOR_DOCKING_EVIDENCE");
                if(!string.IsNullOrEmpty(dir)){Directory.CreateDirectory(dir);File.WriteAllText(Path.Combine(dir,"result.json"),new JObject{["success"]=true,["checks"]=_checks,["actualUnityTransforms"]=true,["physicalSurfaceDirection"]=true,["layoutWrites"]=0}.ToString());}
                Debug.Log("Conveyor and docking passed: "+_checks+" checks");EditorApplication.Exit(0);
            }catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);}finally{foreach(var node in Owned)if(node!=null)UnityEngine.Object.DestroyImmediate(node);Owned.Clear();}
        }
    }
}
