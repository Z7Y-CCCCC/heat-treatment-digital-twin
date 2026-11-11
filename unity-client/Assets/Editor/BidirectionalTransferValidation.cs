using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEngine;
namespace HeatTreatment.DigitalTwin.Editor
{
    public static class BidirectionalTransferValidation
    {
        private static GameObject Rig(JObject gltf)
        {
            var rows=(JArray)gltf["nodes"];var nodes=rows.OfType<JObject>().Select(n=>new GameObject(n.Value<string>("name"))).ToArray();
            for(var i=0;i<nodes.Length;i++){
                var r=rows[i];var t=nodes[i].transform;var p=r["translation"] as JArray;var q=r["rotation"] as JArray;var s=r["scale"] as JArray;
                t.localPosition=p==null?Vector3.zero:new Vector3(-p[0].Value<float>(),p[1].Value<float>(),p[2].Value<float>());
                t.localRotation=q==null?Quaternion.identity:new Quaternion(q[0].Value<float>(),-q[1].Value<float>(),-q[2].Value<float>(),q[3].Value<float>());
                t.localScale=s==null?Vector3.one:new Vector3(s[0].Value<float>(),s[1].Value<float>(),s[2].Value<float>());
            }
            for(var i=0;i<nodes.Length;i++)foreach(var child in rows[i]["children"]?.Values<int>()??Enumerable.Empty<int>())nodes[child].transform.SetParent(nodes[i].transform,false);
            var root=new GameObject("Dual-sided cart fixture");foreach(var i in gltf["scenes"][gltf.Value<int?>("scene")??0]["nodes"].Values<int>())nodes[i].transform.SetParent(root.transform,false);return root;
        }
        public static void Validate()
        {
            var checks=0;void Check(bool c,string why){if(!c)throw new InvalidOperationException(why);checks++;}
            var project=Path.GetFullPath(Path.Combine(Application.dataPath,"../.."));var bytes=File.ReadAllBytes(Path.Combine(project,"backend/assets/motions/cad_transfer_cart_101300.glb"));
            var gltf=JObject.Parse(System.Text.Encoding.UTF8.GetString(bytes,20,BitConverter.ToInt32(bytes,12)));var package=JObject.Parse(File.ReadAllText(Path.Combine(project,"backend/assets/motions/cad_transfer_cart_101300.json")));
            var root=Rig(gltf);var east=new GameObject("east fixture");var west=new GameObject("west fixture");var runtime=new BidirectionalTransferRuntime();
            try{
                east.transform.position=Vector3.right*1.6f;west.transform.position=Vector3.left*1.6f;
                foreach(var r in new[]{east,west})new GameObject("seat").transform.SetParent(r.transform,false);
                var cycle=JObject.Parse("{version:1,enabled:true,startDataItemId:'start',pickupDataItemId:'pickup',cartHome:[0,1.25,0],extendSeconds:1,latchSeconds:.2,retractSeconds:1,conveySeconds:.5,confirmTimeoutSeconds:1,stations:[{value:1,targetDeviceId:'east',side:'primary',presencePointId:'201',seatNodeName:'seat',seatNodeLocal:[0,1.25,0]},{value:2,targetDeviceId:'west',side:'opposite',presencePointId:'202',seatNodeName:'seat',seatNodeLocal:[0,1.25,0]}]}");
                var transfer=JObject.Parse("{enabled:true,sourcePort:'outlet',targetPort:'inlet',presenceDataItemId:'load',materialSize:[.4,.1,.4],materialColor:'#E5A34A',heightToleranceMeters:.01,lateralToleranceMeters:.01,angleToleranceDegrees:2}");transfer["cycle"]=cycle;
                var movement=JObject.Parse("{enabled:true,valueMode:'station',stationInputMeaning:'target',simulationEnabled:true,currentPositionPointId:'101',arrivalPositionPointId:'103',startActionPointId:'102',staleMs:60000,sceneUnitsPerMeter:1,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:0,y:0,z:0}}]}");
                var source=new DeviceDto{Id="cart",ModelType="cad_transfer_cart_101300",InstanceConfig=new JObject{["movement"]=movement,["animationBindings"]=new JObject{["version"]=1,["staleMs"]=60000,["bindings"]=new JArray(),["transferLink"]=transfer}},DataPoints=new List<DataPointDto>{
                    new DataPointDto{Id=101,DeviceId="cart",Category="analog",ValueRole="target",DataType="WORD",AccessType="READ"},new DataPointDto{Id=103,DeviceId="cart",Category="analog",ValueRole="arrival",DataType="WORD",AccessType="READ"},new DataPointDto{Id=102,DeviceId="cart",Category="motors",ValueRole="moving",DataType="BOOL",AccessType="READ"}}};
                DeviceDto Target(string id,int point)=>new DeviceDto{Id=id,ModelType=id,InstanceConfig=new JObject(),DataPoints=new List<DataPointDto>{new DataPointDto{Id=point,DeviceId=id,Category="mechanisms",ValueRole="present",DataType="BOOL",AccessType="READ"}}};
                var targets=new[]{Target("east",201),Target("west",202)};
                ModelAssetDto Model(string id,double x,double direction)=>new ModelAssetDto{Id=id,Metadata=new JObject{["loadingPorts"]=new JObject{["version"]=1,["inlet"]=new JObject{["position"]=new JArray(x,1.25,0),["direction"]=new JArray(direction,0,0),["nodeName"]=""},["outlet"]=new JObject{["position"]=new JArray(x,1.25,0),["direction"]=new JArray(direction,0,0),["nodeName"]=""}}}};
                var driver=root.AddComponent<DeviceAnimationDriver>();driver.Configure(source,package);var mobile=root.AddComponent<MobileDeviceMotion>();mobile.Initialize(source);
                var body=root.GetComponentsInChildren<Transform>(true).First(t=>t.name=="cad_transfer_cart_v1");var bodyMatrix=body.localToWorldMatrix;
                foreach(var side in new[]{1,-1}){
                    Check(driver.SetTransferPresentation(side,.5,.5,out _),"Missing same-source side action");Check(driver.TryGetPresentationDrive(side,out var node,out var rest,out var max),"Missing directional carriage track");
                    Check(Vector3.Distance(node.localPosition,rest+max*.5f)<.0001f,"Native carriage differs from baked Three position");Check(body.localToWorldMatrix.Equals(bodyMatrix),"Selecting a feed side rotated/moved the rail chassis");
                }
                driver.SetTransferPresentation(1,0,0,out _);
                var roots=new Dictionary<string,Transform>{{"cart",root.transform},{"east",east.transform},{"west",west.transform}};
                runtime.Configure(new[]{source}.Concat(targets),new[]{Model(source.ModelType,-.7,-1),Model("east",.7,1),Model("west",-.7,-1)},roots,new Dictionary<string,MobileDeviceMotion>{{"cart",mobile}},null);
                var stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-200;
                JObject TargetFrame(string id,int point,bool present)=>new JObject{["furnace_id"]=id,["timestamp"]=++stamp,["mechanisms"]=new JObject{["present"]=present},["quality"]=new JObject{["mechanisms"]=new JObject{["present"]="good"}},["pointMeta"]=new JObject{["mechanisms.present"]=new JObject{["id"]=point,["category"]="mechanisms",["field_name"]="present",["timestamp"]=stamp}}};
                void SourceFrame(int station,bool load,bool start,bool pickup){
                    var frame=new JObject{["furnace_id"]="cart",["timestamp"]=++stamp,["status"]=new JObject{["online"]=true,["quality"]="good"},["analog"]=new JObject{["target"]=station,["arrival"]=station},["motors"]=new JObject{["moving"]=false},
                        ["quality"]=new JObject{["overall"]="good",["analog"]=new JObject{["target"]="good",["arrival"]="good"},["motors"]=new JObject{["moving"]="good"}},["pointMeta"]=new JObject{
                            ["analog.target"]=new JObject{["id"]=101,["category"]="analog",["field_name"]="target",["timestamp"]=stamp},["analog.arrival"]=new JObject{["id"]=103,["category"]="analog",["field_name"]="arrival",["timestamp"]=stamp},["motors.moving"]=new JObject{["id"]=102,["category"]="motors",["field_name"]="moving",["timestamp"]=stamp}},["motionInputs"]=new JObject()};
                    foreach(var item in new[]{("presence","load",load),("start","start",start),("pickup","pickup",pickup)})frame["motionInputs"]["__transfer_"+item.Item1]=new JObject{["dataItemId"]=item.Item2,["value"]=item.Item3,["timestamp"]=stamp,["quality"]="good",["staleMs"]=60000};
                    mobile.ApplyRealtime(frame);runtime.ApplyInputs("cart",frame);
                }
                runtime.ApplyInputs("east",TargetFrame("east",201,false));runtime.ApplyInputs("west",TargetFrame("west",202,false));
                void Tick(double delta)=>runtime.Advance(delta,Time.realtimeSinceStartupAsDouble);
                foreach(var station in new[]{1,2}){
                    var id=station==1?"east":"west";var point=station==1?201:202;var sign=station==1?1:-1;
                    SourceFrame(station,true,false,false);SourceFrame(station,true,true,false);Tick(.5);
                    Check(driver.TransferDiagnostic.Value<string>("phase")=="extend","BOOL command edge was not consumed");
                    var cargo=GameObject.Find("车上物料 cart");Check(cargo!=null&&cargo.transform.position.x*sign>0&&cargo.transform.position.x*sign<1.6f,"Cargo has no continuous infeed pose");
                    Tick(.5);Tick(2);Check(driver.TransferDiagnostic.Value<string>("phase")=="wait"&&!driver.TransferDiagnostic.Value<bool>("bothPresenceConfirmed"),"Animation time fabricated transfer confirmation");
                    SourceFrame(station,false,true,false);runtime.ApplyInputs(id,TargetFrame(id,point,true));Tick(.2);Tick(1);
                    Check(driver.TransferDiagnostic.Value<string>("phase")=="done"&&driver.TransferDiagnostic.Value<bool>("bothPresenceConfirmed"),"Deposit did not finish after independent endpoint feedback");
                    var targetCargo=GameObject.Find("设备内物料 "+id);Check(targetCargo!=null&&Math.Abs(targetCargo.transform.position.x-sign*1.6)<.0001,"Deposited cargo is not on the actual inside seat");
                    SourceFrame(station,false,false,false);SourceFrame(station,false,true,true);Tick(1);
                    runtime.ApplyInputs(id,TargetFrame(id,point,false));SourceFrame(station,true,true,true);Tick(.2);Tick(1);
                    cargo=GameObject.Find("车上物料 cart");Check(driver.TransferDiagnostic.Value<string>("phase")=="done"&&cargo!=null&&Math.Abs(cargo.transform.position.x)<.0001,"Pickup did not return cargo to the cart");
                    Check(GameObject.Find("设备内物料 "+id)==null,"Pickup duplicated target material");
                    Check(body.localToWorldMatrix.Equals(bodyMatrix),"Transfer moved or turned the rail chassis");
                    SourceFrame(station,true,false,true);
                }
                runtime.Suspend();Check(driver.TransferDiagnostic.Value<bool>("paused"),"Disconnected transfer retained usable feedback");
                Debug.Log("[BidirectionalTransferValidation] PASS "+checks+" real Unity dual-side drive/cargo/endpoint checks");
                File.WriteAllText(Path.Combine(project,"output/bidirectional-unity-proof.json"),new JObject{["success"]=true,["checks"]=checks,["actualUnityTransforms"]=true,["guiUsed"]=false,["physicalPLCWrites"]=0}.ToString());
            }finally{runtime.Dispose();UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(east);UnityEngine.Object.DestroyImmediate(west);}
        }
    }
}
