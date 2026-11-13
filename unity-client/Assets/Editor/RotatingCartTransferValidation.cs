using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    public static class RotatingCartTransferValidation
    {
        private static int _checks, _frame;
        private static long _stamp;
        private static string _directory;
        private static Camera _camera;
        private static void Check(bool value, string reason) { if (!value) throw new Exception(reason); _checks++; }
        private static GameObject Cube(string name, Transform parent, Vector3 position, Vector3 size, Color color)
        {
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube); cube.name = name; cube.transform.SetParent(parent, false); cube.transform.localPosition = position; cube.transform.localScale = size;
            var material = HeatTreatment.DigitalTwin.Rendering.RuntimeShaderLibrary.CreateLitMaterial(name); material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color); cube.GetComponent<Renderer>().sharedMaterial = material;
            return cube;
        }
        private static GameObject Furnace(string name, Transform parent, float z, float yaw)
        {
            var root = new GameObject(name); root.transform.SetParent(parent, false); root.transform.position = new Vector3(0, 0, z); root.transform.rotation = Quaternion.Euler(0, yaw, 0);
            var color = new Color(.32f, .4f, .5f);
            Cube("Lower bed", root.transform, new Vector3(0,.25f,0),new Vector3(2,.5f,2),color);
            Cube("Left wall", root.transform, new Vector3(-.9f,1.1f,0),new Vector3(.2f,1.2f,2),color);
            Cube("Right wall", root.transform, new Vector3(.9f,1.1f,0),new Vector3(.2f,1.2f,2),color);
            Cube("Back wall", root.transform, new Vector3(0,1.1f,.9f),new Vector3(2,1.2f,.2f),color);
            return root;
        }
        private static JObject Frame(string id, Dictionary<string, object> values, Dictionary<string, int> ids)
        {
            var at = _stamp = Math.Max(_stamp + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); var status = new JObject { ["online"] = true }; var quality = new JObject(); var meta = new JObject();
            foreach (var row in values) { status[row.Key] = JToken.FromObject(row.Value); quality[row.Key] = "good"; meta["status."+row.Key] = new JObject { ["id"]=ids[row.Key],["category"]="status",["field_name"]=row.Key,["timestamp"]=at }; }
            return new JObject { ["furnace_id"]=id,["timestamp"]=at,["status"]=status,["quality"]=new JObject{["status"]=quality},["pointMeta"]=meta };
        }
        private static DataPointDto Point(int id, string role, string type="BOOL") => new DataPointDto { Id=id,DeviceId="cart",Name=role,ValueRole=role,Category="status",DataType=type,AccessType="READ" };
        private static void Capture()
        {
            if (_camera == null) return;
            var target = new RenderTexture(1000,700,24); var texture = new Texture2D(1000,700,TextureFormat.RGB24,false); var previous = RenderTexture.active;
            try { _camera.targetTexture=target;_camera.Render();RenderTexture.active=target;texture.ReadPixels(new Rect(0,0,1000,700),0,0);texture.Apply();File.WriteAllBytes(Path.Combine(_directory,"frame-"+(_frame++).ToString("000")+".png"),texture.EncodeToPNG()); }
            finally { _camera.targetTexture=null;RenderTexture.active=previous;UnityEngine.Object.DestroyImmediate(texture);UnityEngine.Object.DestroyImmediate(target); }
        }
        public static void Run()
        {
            GameObject scene=null; SimpleMaterialTransferRuntime runtime=null;
            try {
                _checks=0;_frame=0;_camera=null;_stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-300;
                _directory=Environment.GetEnvironmentVariable("ROTATING_CART_EVIDENCE");if(!string.IsNullOrEmpty(_directory))Directory.CreateDirectory(_directory);
                scene=new GameObject("Isolated two-sided rotating cart");
                var cartRoot=new GameObject("Rail cart");cartRoot.transform.SetParent(scene.transform);
                var original=Cube("Original one-sided model",cartRoot.transform,Vector3.zero,new Vector3(3,1,2),Color.gray);
                var right=Furnace("Side A",scene.transform,5,0);var left=Furnace("Side B",scene.transform,-5,180);
                Cube("Rail A",scene.transform,new Vector3(0,-.58f,-.65f),new Vector3(8,.12f,.12f),Color.gray);
                Cube("Rail B",scene.transform,new Vector3(0,-.58f,.65f),new Vector3(8,.12f,.12f),Color.gray);
                if(Environment.GetEnvironmentVariable("ROTATING_CART_RENDER")=="1"){
                    Cube("Ground",scene.transform,new Vector3(0,-.72f,0),new Vector3(16,.1f,16),new Color(.82f,.87f,.9f));
                    _camera=new GameObject("Acceptance camera").AddComponent<Camera>();_camera.transform.SetParent(scene.transform);_camera.transform.position=new Vector3(12,12,12);_camera.transform.LookAt(new Vector3(0,.2f,0));_camera.orthographic=true;_camera.orthographicSize=7.5f;_camera.clearFlags=CameraClearFlags.SolidColor;_camera.backgroundColor=new Color(.91f,.94f,.97f);
                    var light=new GameObject("Acceptance light").AddComponent<Light>();light.transform.SetParent(scene.transform);light.type=LightType.Directional;light.intensity=2;light.transform.rotation=Quaternion.Euler(45,-30,0);RenderSettings.ambientLight=new Color(.65f,.65f,.65f);
                }
                var movement=JObject.Parse("{enabled:true,displayMode:'simple',valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'1',arrivalSignalPointId:'2',arrivalSmoothing:false,start:{x:0,y:0,z:0},end:{x:8,y:0,z:0},stations:[{value:1,anchorDeviceId:'right',position:{x:0,y:0,z:0}},{value:2,anchorDeviceId:'left',position:{x:0,y:0,z:0}},{value:3,anchorDeviceId:'right',position:{x:8,y:0,z:0}}]}");
                var stationBaseline=movement.DeepClone();
                var cart=new DeviceDto{Id="cart",ModelType="generic_rotating_cart",InstanceConfig=new JObject{["movement"]=movement,["cartTransfer"]=JObject.Parse("{version:1,kind:'rotating',presentation:'simple',turntableNodeName:''}"),["loadingPortSignals"]=JObject.Parse("{version:1,inletPointId:'3',outletPointId:'4'}")},DataPoints=new List<DataPointDto>{Point(1,"target","WORD"),Point(2,"arrived"),Point(3,"take"),Point(4,"feed")}};
                var fixedRight=new DeviceDto{Id="right",ModelType="generic_fixed",InstanceConfig=new JObject()};var fixedLeft=new DeviceDto{Id="left",ModelType="generic_fixed",RotationY=180,InstanceConfig=new JObject()};
                var models=new[]{new ModelAssetDto{Id=cart.ModelType,Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[0,0.5,1],direction:[0,0,1],nodeName:''},outlet:{position:[0,0.5,1],direction:[0,0,1],nodeName:''}}}")},new ModelAssetDto{Id="generic_fixed",Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[0,0.5,-1],direction:[0,0,-1],nodeName:''},outlet:{position:[0,0.5,-1],direction:[0,0,-1],nodeName:''}}}")}};
                var roots=new Dictionary<string,Transform>{["cart"]=cartRoot.transform,["right"]=right.transform,["left"]=left.transform};
                var motion=cartRoot.AddComponent<MobileDeviceMotion>();motion.Initialize(cart);var motions=new Dictionary<string,MobileDeviceMotion>{["cart"]=motion};
                runtime=new SimpleMaterialTransferRuntime();runtime.Configure(new[]{cart,fixedRight,fixedLeft},models,roots,motions,scene.transform);
                var ids=new Dictionary<string,int>{["target"]=1,["arrived"]=2,["take"]=3,["feed"]=4};
                var lastStation=1;var lastTake=false;var lastFeed=false;var lastArrived=true;
                void Send(int station,bool take,bool feed,bool arrived=true){lastStation=station;lastTake=take;lastFeed=feed;lastArrived=arrived;var frame=Frame("cart",new Dictionary<string,object>{["target"]=station,["arrived"]=arrived,["take"]=take,["feed"]=feed},ids);motion.ApplyRealtime(frame);runtime.Receive("cart",frame,Time.realtimeSinceStartupAsDouble,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());}
                void Step(float delta,bool refresh=true){if(refresh)Send(lastStation,lastTake,lastFeed,lastArrived);runtime.Advance(delta,Time.realtimeSinceStartupAsDouble);Capture();}
                int Active()=>runtime.Describe().Value<int>("activeTransfers");
                bool Owns(string id)=>runtime.Describe()["estimatedCargoDevices"].Values<string>().Contains(id);
                float Angle()=>runtime.Describe()["turntables"]?["cart"]?.Value<float>("angleDegrees")??0;
                Send(1,false,false);Step(0);Check(motion.HasConfirmedPosition,"Initial PLC-confirmed parking not available");
                Check(!original.GetComponent<Renderer>().enabled,"Simple cart did not replace the old one-sided appearance");
                var upper=cartRoot.GetComponentsInChildren<Transform>().Single(node=>node.name=="__SimpleCartUpper");var basePose=cartRoot.transform.localToWorldMatrix;
                Send(1,true,false);Step(0);Check(Active()==1,"Could not pick up from side A");Send(1,false,false);
                for(var i=0;i<13;i++)Step(.25f);Check(Owns("cart"),"Pickup did not keep cargo on cart");
                var cargo=upper.GetComponentsInChildren<Transform>().Single(node=>node.name.StartsWith("Illustrative cargo "));Check(cargo.parent==upper,"Cargo is not attached to upper platform");var cargoRotation=cargo.rotation;
                Send(2,false,true);Step(0);Check(motion.HasConfirmedPosition,"Same physical parking on side B wrongly required another translation arrival pulse");Check(Active()==0,"Material started before the upper platform faced side B");
                Step(.5f);Check(Angle()>60&&Angle()<120,"No smooth intermediate turn pose");Check(Quaternion.Angle(cargoRotation,cargo.rotation)>60,"Cargo did not turn with platform");Check(cartRoot.transform.localToWorldMatrix==basePose,"Turning rotated or displaced the rail chassis");
                var frozen=upper.localRotation;runtime.Suspend();Step(.25f,false);Check(Quaternion.Angle(frozen,upper.localRotation)<.01f,"Disconnected source continued turning");
                Send(2,false,true);for(var i=0;i<5;i++)Step(.125f);Check(Angle()>179&&Active()==1,"Side B transfer did not wait for alignment");
                Send(2,false,false);Step(1.5f);Check(cargo.position.z<-.5f&&cargo.position.z>-5,"Side B material did not leave the actual rotated mouth");
                for(var i=0;i<7;i++)Step(.25f);Check(Owns("left")&&!Owns("cart"),"Side B outfeed failed to keep cargo at destination");
                Send(2,true,false);Step(0);Send(2,false,false);for(var i=0;i<13;i++)Step(.25f);Check(Owns("cart")&&cargo.parent==upper,"Side B pickup did not return to upper platform");
                Send(1,false,true);Step(0);Check(Active()==0,"Side A return fed through the chassis before turning");for(var i=0;i<8;i++)Step(.125f);Check(Angle()<.1f&&Active()==1,"Return rotation did not align to side A");
                Send(1,false,false);for(var i=0;i<13;i++)Step(.25f);Check(Owns("right")&&!Owns("cart"),"Side A outfeed failed after rotating back");Check(cartRoot.transform.localToWorldMatrix==basePose,"Full two-sided cycle moved the chassis");
                Send(3,false,false);Check(!motion.HasConfirmedPosition,"Held arrival authorized a genuinely different parking position");
                runtime.Dispose();cart.InstanceConfigObject["cartTransfer"]=JObject.Parse("{version:1,kind:'single',presentation:'model',turntableNodeName:''}");motion.Reconfigure(cart,true);Send(2,false,true,false);Send(2,false,true);runtime.Configure(new[]{cart,fixedRight,fixedLeft},models,roots,motions,scene.transform);Send(2,false,false);Send(2,false,true);Step(0);
                Check(Active()==0&&!Owns("cart")&&runtime.Describe()["reasons"]?["cart"]?.ToString()=="料口未朝向对接设备","Single-sided cart still transferred through its back");
                Check(original.GetComponent<Renderer>().enabled,"Leaving simple mode did not restore original model");
                // Fine models use the very same instance/station/point schema.
                runtime.Dispose();var fineUpper=new GameObject("FineUpper").transform;fineUpper.SetParent(cartRoot.transform,false);fineUpper.localPosition=new Vector3(0,.5f,0);Cube("Fine upper mesh",fineUpper,new Vector3(0,-.1f,0),new Vector3(1.6f,.2f,2),Color.cyan);
                cart.InstanceConfigObject["cartTransfer"]=JObject.Parse("{version:1,kind:'rotating',presentation:'model',turntableNodeName:'FineUpper'}");motion.Reconfigure(cart,true);Send(2,false,false);runtime.Configure(new[]{cart,fixedRight,fixedLeft},models,roots,motions,scene.transform);Send(2,false,true);Step(.5f);Check(Angle()>60&&Angle()<120,"Fine upper-node adapter could not reuse target map");Step(.5f);Check(Active()==1,"Fine model did not use its rotating loading mouth");Check(JToken.DeepEquals(stationBaseline,cart.InstanceConfigObject["movement"]),"Model replacement changed the user's station table");
                if(!string.IsNullOrEmpty(_directory))File.WriteAllText(Path.Combine(_directory,"result.json"),new JObject{["success"]=true,["checks"]=_checks,["actualUnityTransforms"]=true,["twoSidesComplete"]=true,["sameParking"]=true,["baseStayedOnRail"]=true,["cargoFollowsUpper"]=true,["singleSideGuard"]=true,["fineModelAdapter"]=true,["renderedFrames"]=_frame,["liveConfigurationWrites"]=0}.ToString());
                Debug.Log("Rotating cart passed: "+_checks+" checks, frames="+_frame);EditorApplication.Exit(0);
            }catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);}finally{runtime?.Dispose();if(scene!=null)UnityEngine.Object.DestroyImmediate(scene);}
        }
    }
}
