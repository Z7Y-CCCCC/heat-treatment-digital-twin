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
    public static class TransferDoorClearanceValidation
    {
        private static int _checks;
        private static long _stamp;
        private static readonly List<UnityEngine.Object> Owned = new List<UnityEngine.Object>();
        private static void Check(bool value, string message) { if (!value) throw new Exception(message); _checks++; }
        private static GameObject Node(string name, Transform parent, bool cube = false)
        {
            var value = cube ? GameObject.CreatePrimitive(PrimitiveType.Cube) : new GameObject(name);
            value.name = name; value.transform.SetParent(parent, false); Owned.Add(value); return value;
        }
        private static JObject Package(bool reverse)
        {
            var a = reverse ? 1.85 : .65; var b = reverse ? .65 : 1.85;
            return new JObject { ["nodes"]=new JArray(new JObject{["name"]="Door",["v"]=new JArray(1)}),
                ["clips"]=new JArray(new JObject{["id"]="door",["count"]=2,["duration"]=1,
                    ["tracks"]=new JArray(new JObject{["node"]="Door",["channel"]="p",["size"]=3,["values"]=new JArray(0,a,-1,0,b,-1)})}) };
        }
        private static DeviceDto DoorDevice() => new DeviceDto { Id="fixed", ModelType="fixture_door", InstanceConfig=JObject.Parse(@"{animationBindings:{staleMs:5000,bindings:[
            {actionId:'clip:door',clipId:'door',kind:'clip',enabled:true,mode:'position',speed:1,transitionSeconds:1,dataItemId:'point:door',trigger:{mode:'condition',operator:'eq',value:true}}]}}") };
        private static JObject DoorFrame(bool value) => new JObject { ["timestamp"]=++_stamp,["motionInputOnly"]=true,["motionInputs"]=new JObject {
            ["clip:door"]=new JObject{["dataItemId"]="point:door",["value"]=value,["quality"]="good",["timestamp"]=_stamp,["staleMs"]=5000} } };
        private static JObject CartFrame(bool feed)
        {
            var at=++_stamp;var roles=new[]{"target","arrived","take","feed"};var quality=new JObject();var meta=new JObject();
            for(var i=0;i<roles.Length;i++){quality[roles[i]]="good";meta["status."+roles[i]]=new JObject{["id"]=i+1,["category"]="status",["field_name"]=roles[i],["timestamp"]=at};}
            return new JObject{["furnace_id"]="cart",["timestamp"]=at,["status"]=new JObject{["online"]=true,["target"]=1,["arrived"]=true,["take"]=false,["feed"]=feed},
                ["quality"]=new JObject{["status"]=quality},["pointMeta"]=meta};
        }
        private static void Scenario(bool reverse, bool transformed)
        {
            var scene=Node("Isolated door clearance",null);
            if(transformed){scene.transform.position=new Vector3(20,3,-8);scene.transform.rotation=Quaternion.Euler(0,37,0);scene.transform.localScale=new Vector3(-2,1,2);}
            var cartRoot=Node("Cart",scene.transform,true);var fixedRoot=Node("Fixed",scene.transform);fixedRoot.transform.localPosition=new Vector3(0,0,4);
            var panel=Node("Door",fixedRoot.transform,true);panel.transform.localPosition=new Vector3(0,.65f,-1);panel.transform.localScale=new Vector3(2,1,.15f);
            var fixedDevice=DoorDevice();var door=fixedRoot.AddComponent<DeviceAnimationDriver>();door.Configure(fixedDevice,Package(reverse));
            var movement=JObject.Parse("{enabled:true,displayMode:'simple',valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'1',arrivalSignalPointId:'2',arrivalSmoothing:false,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,anchorDeviceId:'fixed',position:{x:0,y:0,z:0}}]}");
            var cart=new DeviceDto{Id="cart",ModelType="fixture_cart",InstanceConfig=new JObject{["movement"]=movement,["loadingPortSignals"]=JObject.Parse("{version:1,inletPointId:'3',outletPointId:'4'}")},DataPoints=new List<DataPointDto>()};
            var roles=new[]{"target","arrived","take","feed"};for(var i=0;i<4;i++)cart.DataPoints.Add(new DataPointDto{Id=i+1,DeviceId="cart",Name=roles[i],ValueRole=roles[i],Category="status",DataType=i==0?"WORD":"BOOL",AccessType="READ"});
            var models=new[]{new ModelAssetDto{Id="fixture_cart",Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[0,.5,1],direction:[0,0,1],nodeName:''},outlet:{position:[0,.5,1],direction:[0,0,1],nodeName:''}}}")},
                new ModelAssetDto{Id="fixture_door",Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[0,.5,-1],direction:[0,0,-1],nodeName:''},outlet:{position:[0,.5,-1],direction:[0,0,-1],nodeName:''}}}")}};
            var motion=cartRoot.AddComponent<MobileDeviceMotion>();motion.Initialize(cart);
            var runtime=new SimpleMaterialTransferRuntime();var roots=new Dictionary<string,Transform>{{"cart",cartRoot.transform},{"fixed",fixedRoot.transform}};
            try {
                runtime.Configure(new[]{cart,fixedDevice},models,roots,new Dictionary<string,MobileDeviceMotion>{{"cart",motion}},scene.transform);
                var now=Time.realtimeSinceStartupAsDouble;var fed=false;var open=false;
                void Receive(){door.ApplyMotionInputs(DoorFrame(open!=reverse),now);var frame=CartFrame(fed);motion.ApplyRealtime(frame);runtime.Receive("cart",frame,now,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());}
                void Tick(float dt){now+=dt;Receive();door.Advance(dt,now);runtime.Advance(dt,now);}
                int Active()=>runtime.Describe().Value<int>("activeTransfers");
                Receive();door.Advance(1,now);runtime.Advance(0,now);
                Check(door.HasTransferDoor,"Imported door definition was not recognized");
                fed=true;Tick(0);Check(Active()==0&&runtime.Describe()["cargo"].Count()==0,"Closed door spawned cargo or started a handoff (reverse="+reverse+")");
                Check(runtime.Describe()["reasons"]?["cart"]?.ToString()=="等待料口门打开","Closed door did not expose a concise waiting reason");
                // A held real command may wait longer than the original pulse
                // window, without renewing or inventing an input observation.
                for(var i=0;i<10;i++)Tick(1);Check(Active()==0,"Held command bypassed the closed door");
                fed=false;open=true;Tick(.2f);Check(Active()==0,"Partially open door moved cargo through its remaining panel");
                Tick(.8f);Check(Active()==1,"Door opening failed to release the existing asynchronous request");
                Tick(.4f);var cargo=scene.GetComponentsInChildren<Transform>().Single(n=>n.name.StartsWith("Illustrative cargo "));var held=cargo.position;
                open=false;Tick(1);Check(Active()==1&&(cargo.position-held).sqrMagnitude<.0000001f,"Door closing during handoff failed to freeze the actual cargo");
                panel.GetComponent<Renderer>().enabled=false;Tick(.2f);Check((cargo.position-held).sqrMagnitude<.0000001f,"Hiding a closed door bypassed its physical mesh check");
                using(var picking=new InspectionMeshSurface(panel.GetComponent<Renderer>()))Check(!picking.Raycast(new Ray(panel.transform.position-Vector3.forward*3,Vector3.forward),out _),"Physical clearance changed the visibility contract of ordinary inspection picking");
                panel.GetComponent<Renderer>().enabled=true;
                open=true;Tick(1);Check((cargo.position-held).sqrMagnitude>.00001f,"Reopened door could not resume the existing cargo");
                Tick(2.1f);Check(Active()==0&&runtime.Describe()["estimatedCargoDevices"].Values<string>().Contains("fixed"),"Cargo never completed its transfer after the door cleared");
                var frameBefore=fixedRoot.transform.localToWorldMatrix;var aperture=fixedRoot.transform.TransformPoint(new Vector3(0,.56f,-1));var direction=fixedRoot.transform.TransformVector(Vector3.forward).normalized;
                Check(door.TransferDoorClear(aperture,direction,new Vector3(.3f,.12f,.3f),out _),"Actually open physical geometry was rejected");
                Check(fixedRoot.transform.localToWorldMatrix==frameBefore,"Door gating changed fixed-device placement");
            }finally{runtime.Dispose();}
        }
        private static void HollowFrame()
        {
            var root=Node("Hollow frame fixture",null);var doorNode=Node("Door",root.transform);doorNode.transform.localPosition=new Vector3(0,.65f,-1);
            var primitive=Node("Temporary source",null,true);var mesh=primitive.GetComponent<MeshFilter>().sharedMesh;var material=primitive.GetComponent<Renderer>().sharedMaterial;
            var pieces=new[]{new Vector3(-1,0,0),new Vector3(1,0,0),new Vector3(0,1,0),new Vector3(0,-1,0)};
            var combined=new Mesh{name="Readable combined door frame"};Owned.Add(combined);
            combined.CombineMeshes(pieces.Select((p,i)=>new CombineInstance{mesh=mesh,transform=Matrix4x4.TRS(p,Quaternion.identity,i<2?new Vector3(.1f,2,.15f):new Vector3(2,.1f,.15f))}).ToArray());
            doorNode.AddComponent<MeshFilter>().sharedMesh=combined;doorNode.AddComponent<MeshRenderer>().sharedMaterial=material;
            var driver=root.AddComponent<DeviceAnimationDriver>();driver.Configure(DoorDevice(),Package(false));
            var center=new Vector3(0,.65f,-1);Check(driver.TransferDoorClear(center,Vector3.forward,new Vector3(.5f,.3f,.5f),out _),"A merged hollow carriage AABB was substituted for actual door triangles");
            driver.Configure(new DeviceDto{Id="open-table",InstanceConfig=new JObject()},JObject.Parse("{nodes:[],clips:[]}"));
            Check(!driver.HasTransferDoor&&driver.TransferDoorClear(center,Vector3.forward,Vector3.one,out _),"Open equipment without a door acquired an artificial door prerequisite");
            doorNode.GetComponent<MeshFilter>().sharedMesh=null;driver.Configure(DoorDevice(),Package(false));
            Check(!driver.TransferDoorClear(center,Vector3.forward,Vector3.one,out _),"A missing door mesh was silently treated as an open door");
            var unreadable=UnityEngine.Object.Instantiate(combined);Owned.Add(unreadable);unreadable.UploadMeshData(true);doorNode.GetComponent<MeshFilter>().sharedMesh=unreadable;
            Check(!driver.TransferDoorClear(center,Vector3.forward,Vector3.one,out _),"An unreadable overlapping door volume was silently treated as an open door");
        }
        public static void Run()
        {
            try {_checks=0;_stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();foreach(var reverse in new[]{false,true})foreach(var transformed in new[]{false,true})Scenario(reverse,transformed);HollowFrame();
                var dir=Environment.GetEnvironmentVariable("TRANSFER_DOOR_EVIDENCE");if(!string.IsNullOrEmpty(dir)){Directory.CreateDirectory(dir);File.WriteAllText(Path.Combine(dir,"result.json"),new JObject{["success"]=true,["checks"]=_checks,["actualDoorTriangles"]=true,["reversedDoorSemantics"]=true,["noExtraPlcPoints"]=true}.ToString());}
                Debug.Log("Transfer door clearance passed: "+_checks+" checks");EditorApplication.Exit(0);
            }catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);}finally{for(var i=Owned.Count-1;i>=0;i--)if(Owned[i]!=null)UnityEngine.Object.DestroyImmediate(Owned[i]);Owned.Clear();}
        }
    }
}
