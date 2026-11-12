#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GLTFast;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Object=UnityEngine.Object;
namespace HeatTreatment.DigitalTwin.Editor
{
    // Actual glTFast meshes, baked action driver, BOOL runtime and Unity camera.
    // Unsaved empty scene only. No backend, database, collector or PLC is used.
    [InitializeOnLoad]
    public static class AdaptiveTransferGraphicsValidation
    {
        private const string Pending="AdaptiveTransferGraphicsValidation.Pending";
        static AdaptiveTransferGraphicsValidation(){EditorApplication.playModeStateChanged+=state=>{if(state==PlayModeStateChange.EnteredPlayMode&&SessionState.GetBool(Pending,false)){SessionState.SetBool(Pending,false);RunPlaying();}};}
        public static void Run(){EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);SessionState.SetBool(Pending,true);EditorApplication.EnterPlaymode();}
        private static async void RunPlaying()
        {
            var directory=Environment.GetEnvironmentVariable("ADAPTIVE_TRANSFER_CHECK_DIR");var report=new JObject{["success"]=false,["actualUnityRendering"]=true,["PLCConnections"]=0,["operatorWrites"]=0};var errors=new List<string>();var traces=new JArray();var checks=0;
            void Check(bool value,string why){if(!value)throw new InvalidOperationException(why);checks++;}
            void Error(string message,string stack,LogType type){if(type==LogType.Error||type==LogType.Exception||type==LogType.Assert)errors.Add(message);}
            Application.logMessageReceived+=Error;
            try{
                if(string.IsNullOrWhiteSpace(directory))throw new InvalidOperationException("ADAPTIVE_TRANSFER_CHECK_DIR is required");
                var project=Path.GetFullPath(Path.Combine(Application.dataPath,"../.."));var fixtures=JArray.Parse(File.ReadAllText(Path.Combine(directory,"fixtures.json")));
                var camera=new GameObject("Isolated native transfer camera").AddComponent<Camera>();camera.backgroundColor=new Color32(239,244,247,255);camera.clearFlags=CameraClearFlags.SolidColor;camera.fieldOfView=38;camera.nearClipPlane=.01f;camera.farClipPlane=100;
                RenderSettings.ambientLight=Color.white;RenderSettings.ambientIntensity=1.5f;
                var light=new GameObject("Fixture light").AddComponent<Light>();light.type=LightType.Directional;light.intensity=2.5f;light.transform.rotation=Quaternion.Euler(40,-35,0);
                var fill=new GameObject("Fixture fill").AddComponent<Light>();fill.type=LightType.Directional;fill.intensity=1.5f;fill.transform.rotation=Quaternion.Euler(30,145,0);
                var ground=GameObject.CreatePrimitive(PrimitiveType.Cube);ground.name="Fixture ground";ground.transform.position=new Vector3(0,-.055f,0);ground.transform.localScale=new Vector3(12,.1f,12);ground.GetComponent<Renderer>().sharedMaterial=RuntimeShaderLibrary.CreateLitMaterial("Fixture floor");ground.GetComponent<Renderer>().sharedMaterial.color=new Color32(212,224,232,255);
                foreach(var fixture in fixtures.OfType<JObject>()){
                    var kind=fixture["evidence"].Value<string>("kind");var micro=fixture["evidence"].Value<double>("micro");var units=fixture["evidence"].Value<float>("units");var key=kind+"-"+micro.ToString("0.00",System.Globalization.CultureInfo.InvariantCulture)+(units==1?"":"-units-"+units.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    ground.transform.position=new Vector3(0,-.055f*units,0);ground.transform.localScale=new Vector3(12,.1f,12)*units;
                    var devices=fixture["devices"].ToObject<List<DeviceDto>>();var models=fixture["models"].ToObject<List<ModelAssetDto>>();var layout=fixture["lines"][0]["layout"] as JObject;var source=devices[0];var targets=devices.Skip(1).ToArray();var link=source.InstanceConfigObject["animationBindings"]["transferLink"] as JObject;var cycle=link["cycle"] as JObject;
                    source.DataPoints=new List<DataPointDto>{Point(101,source.Id,"analog","target","WORD"),Point(102,source.Id,"motors","moving","BOOL"),Point(103,source.Id,"analog","arrival","WORD")};
                    for(var i=0;i<targets.Length;i++)targets[i].DataPoints=new List<DataPointDto>{Point(200+i,targets[i].Id,"mechanisms","present","BOOL")};
                    var roots=new Dictionary<string,Transform>();var imports=new List<GltfImport>();var runtime=new BidirectionalTransferRuntime();
                    try{
                        foreach(var device in devices){
                            var model=models.First(m=>m.Id==device.ModelType);var importer=new GltfImport();imports.Add(importer);var root=new GameObject(device.Id);roots[device.Id]=root.transform;
                            var path=Path.Combine(project,"backend/assets/motions",device.ModelType+".glb");
                            Check(await importer.LoadGltfBinary(File.ReadAllBytes(path),new Uri(path),new ImportSettings{NodeNameMethod=NameImportMethod.Original}),"glTFast rejected actual action GLB");
                            Check(await importer.InstantiateMainSceneAsync(new GameObjectInstantiator(importer,root.transform,settings:new InstantiationSettings{SceneObjectCreation=SceneObjectCreation.Never})),"glTFast instantiate failed");
                            root.transform.position=new Vector3(device.PositionX,device.PositionY,device.PositionZ);root.transform.rotation=Quaternion.Euler(0,-device.RotationY*Mathf.Rad2Deg,0);root.transform.localScale=Vector3.one*device.Scale*model.DefaultScale;
                            var package=JObject.Parse(File.ReadAllText(Path.Combine(project,"backend/assets/motions",device.ModelType+".json")));
                            if(device!=source)device.InstanceConfigObject["animationBindings"]=new JObject{["version"]=1,["staleMs"]=60000,["bindings"]=new JArray(JObject.Parse("{enabled:true,kind:'clip',mode:'position',clipId:'door',actionId:'clip:door',dataItemId:'fixture:door',inputMin:0,inputMax:1,transitionSeconds:1,trigger:{mode:'condition',operator:'eq',value:true}}"))};
                            var driver=root.AddComponent<DeviceAnimationDriver>();driver.Configure(device,package);driver.enabled=false;
                        }
                        var cart=roots[source.Id];var driverCart=cart.GetComponent<DeviceAnimationDriver>();var mobile=cart.gameObject.AddComponent<MobileDeviceMotion>();mobile.Initialize(source,layout);mobile.enabled=false;
                        runtime.Configure(devices,models,roots,new Dictionary<string,MobileDeviceMotion>{{source.Id,mobile}},new[]{new LineDto{Id=source.LineId,Layout=layout}});
                        long stamp=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-100;JObject Meta(long id,string group,string field)=>new JObject{["id"]=id,["category"]=group,["field_name"]=field,["timestamp"]=stamp};
                        void TargetFrame(DeviceDto target,bool present){
                            var frame=new JObject{["furnace_id"]=target.Id,["timestamp"]=++stamp,["mechanisms"]=new JObject{["present"]=present},["quality"]=new JObject{["mechanisms"]=new JObject{["present"]="good"}},["pointMeta"]=new JObject{["mechanisms.present"]=Meta(target.DataPoints[0].Id,"mechanisms","present")}};runtime.ApplyInputs(target.Id,frame);
                        }
                        void SourceFrame(int station,bool present,bool start,bool pickup){
                            var frame=new JObject{["furnace_id"]=source.Id,["timestamp"]=++stamp,["status"]=new JObject{["online"]=true,["quality"]="good"},["analog"]=new JObject{["target"]=station,["arrival"]=station},["motors"]=new JObject{["moving"]=false},["quality"]=new JObject{["overall"]="good",["analog"]=new JObject{["target"]="good",["arrival"]="good"},["motors"]=new JObject{["moving"]="good"}},["pointMeta"]=new JObject{["analog.target"]=Meta(101,"analog","target"),["analog.arrival"]=Meta(103,"analog","arrival"),["motors.moving"]=Meta(102,"motors","moving")},["motionInputs"]=new JObject()};
                            foreach(var p in new[]{("presence","fixture:load",present),("start","fixture:start",start),("pickup","fixture:pickup",pickup)})frame["motionInputs"]["__transfer_"+p.Item1]=new JObject{["dataItemId"]=p.Item2,["value"]=p.Item3,["quality"]="good",["timestamp"]=stamp,["staleMs"]=60000};
                            mobile.ApplyRealtime(frame);mobile.AdvanceMotion(10,Time.realtimeSinceStartupAsDouble);runtime.ApplyInputs(source.Id,frame);
                        }
                        foreach(var target in targets)TargetFrame(target,false);
                        for(var i=0;i<targets.Length;i++){
                            var target=targets[i];var station=i+1;var sign=cycle["stations"][i].Value<string>("side")=="opposite"?-1:1;var targetDriver=roots[target.Id].GetComponent<DeviceAnimationDriver>();
                            var doorFrame=new JObject{["furnace_id"]=target.Id,["timestamp"]=++stamp,["motionInputs"]=new JObject{["clip:door"]=new JObject{["dataItemId"]="fixture:door",["value"]=true,["quality"]="good",["timestamp"]=stamp,["staleMs"]=60000}}};targetDriver.ApplyMotionInputs(doorFrame);targetDriver.Advance(1,Time.realtimeSinceStartupAsDouble);
                            var bounds=new Bounds(cart.position,Vector3.one);foreach(var root in roots.Values)foreach(var renderer in root.GetComponentsInChildren<Renderer>())bounds.Encapsulate(renderer.bounds);
                            camera.transform.position=bounds.center+new Vector3(-.7f,.55f,-sign*1.2f).normalized*bounds.size.magnitude*1.4f;camera.transform.LookAt(bounds.center);
                            foreach(var pickup in new[]{false,true}){
                                SourceFrame(station,!pickup,false,pickup);SourceFrame(station,!pickup,true,pickup);var chassis=cart.GetComponentsInChildren<Transform>(true).First(n=>n.name=="cad_transfer_cart_v1");var chassisMatrix=chassis.localToWorldMatrix;
                                Vector3 last=Vector3.zero;var positions=new JArray();
                                for(var frame=0;frame<60;frame++){
                                    runtime.Advance(2d/60,Time.realtimeSinceStartupAsDouble);var d=driverCart.TransferDiagnostic;Check(d!=null&&!d.Value<bool>("paused"),"Native transfer paused: "+d?.ToString());
                                    var cargo=GameObject.Find("车上物料 "+source.Id);Check(cargo!=null,"Native cargo missing");if(frame>0)Check(Vector3.Distance(last,cargo.transform.position)<.2f*units,"Native cargo teleported");last=cargo.transform.position;positions.Add(new JArray(last.x,last.y,last.z));
                                    var p=(frame+1)/60f;var expectedFeed=p*p*(3-2*p);
                                    Check(driverCart.TryGetPresentationDrive(sign,out var node,out var rest,out var maximum),"Actual signed drive missing");Check(Vector3.Distance(node.localPosition,rest+maximum*expectedFeed)<.0002f,"Native drive differs from shared smooth feed: "+node.localPosition+" expected "+(rest+maximum*expectedFeed));Check(chassis.localToWorldMatrix.Equals(chassisMatrix),"Chassis moved during transfer");
                                    if(frame==14){
                                        var targetRest=roots[target.Id].position;var frozenPose=cargo.transform.position;var frozenDrive=node.localPosition;
                                        roots[target.Id].position+=new Vector3(0,0,.005f*units);runtime.Advance(.2,Time.realtimeSinceStartupAsDouble);
                                        Check(driverCart.TransferDiagnostic.Value<bool>("paused")&&driverCart.TransferDiagnostic.Value<string>("reason").Contains("路径已变化"),"Valid but changed path did not freeze");
                                        Check(cargo.transform.position==frozenPose&&node.localPosition==frozenDrive,"Changed geometry moved active cargo or drive");
                                        roots[target.Id].position=targetRest;runtime.Advance(0,Time.realtimeSinceStartupAsDouble);Check(!driverCart.TransferDiagnostic.Value<bool>("paused"),"Restored geometry did not recover");
                                        SourceFrame(station,!pickup,true,!pickup);runtime.Advance(.2,Time.realtimeSinceStartupAsDouble);
                                        Check(driverCart.TransferDiagnostic.Value<bool>("paused")&&cargo.transform.position==frozenPose&&node.localPosition==frozenDrive,"Changed operation command did not freeze");SourceFrame(station,!pickup,true,pickup);
                                    }
                                    if(frame==29)Save(camera,Path.Combine(directory,key+"-"+station+"-"+(pickup?"pickup":"feed")+".png"));
                                }
                                runtime.Advance(1,Time.realtimeSinceStartupAsDouble);Check(driverCart.TransferDiagnostic.Value<string>("phase")=="wait"&&!driverCart.TransferDiagnostic.Value<bool>("bothPresenceConfirmed"),"Native timer fabricated confirmation");
                                var mouthPosition=GameObject.Find("车上物料 "+source.Id).transform.position;Save(camera,Path.Combine(directory,key+"-"+station+"-"+(pickup?"pickup-mouth":"feed-mouth")+".png"));
                                SourceFrame(station,pickup,true,pickup);TargetFrame(target,!pickup);
                                var retractPositions=new JArray();
                                for(var frame=0;frame<75;frame++){
                                    runtime.Advance(2.5d/75,Time.realtimeSinceStartupAsDouble);Check(!driverCart.TransferDiagnostic.Value<bool>("paused"),"Native acknowledged transfer paused");
                                    var cargo=GameObject.Find("车上物料 "+source.Id)??GameObject.Find("设备内物料 "+target.Id);Check(cargo!=null,"Native cargo missing after acknowledgement");var position=cargo.transform.position;
                                    Check(Vector3.Distance(last,position)<.2f*units,"Native cargo teleported at ownership/phase change");last=position;retractPositions.Add(new JArray(last.x,last.y,last.z));
                                }
                                Check(driverCart.TransferDiagnostic.Value<string>("phase")=="done","Native operation failed to finish");Check(GameObject.Find("示意送料桥 "+source.Id)==null,"Native bridge did not retract");
                                var visible=Object.FindObjectsOfType<Transform>().Count(n=>n.name=="车上物料 "+source.Id||n.name=="设备内物料 "+target.Id);Check(visible==1,"Native cargo ownership duplicated");
                                Save(camera,Path.Combine(directory,key+"-"+station+"-"+(pickup?"returned":"seated")+".png"));
                                traces.Add(new JObject{["kind"]=kind,["micro"]=micro,["units"]=units,["station"]=station,["pickup"]=pickup,["positions"]=positions,["mouthPosition"]=new JArray(mouthPosition.x,mouthPosition.y,mouthPosition.z),["retractPositions"]=retractPositions,["diagnostic"]=driverCart.TransferDiagnostic.DeepClone()});
                                SourceFrame(station,pickup,false,pickup);
                            }
                        }
                        SourceFrame(1,true,true,false);runtime.Advance(.5,Time.realtimeSinceStartupAsDouble);var frozen=GameObject.Find("车上物料 "+source.Id)?.transform.position;runtime.Suspend();runtime.Advance(10,Time.realtimeSinceStartupAsDouble);Check(driverCart.TransferDiagnostic.Value<bool>("paused"),"Disconnect failed to freeze");Check(GameObject.Find("车上物料 "+source.Id)?.transform.position==frozen,"Disconnect moved cargo");
                    }finally{runtime.Dispose();foreach(var root in roots.Values)Object.DestroyImmediate(root.gameObject);foreach(var importer in imports)importer.Dispose();}
                }
                Check(errors.Count==0,"Unity load/render errors");report["success"]=true;report["graphicsDevice"]=SystemInfo.graphicsDeviceName;report["graphicsAPI"]=SystemInfo.graphicsDeviceType.ToString();
            }catch(Exception error){report["error"]=error.ToString();Debug.LogException(error);}finally{Application.logMessageReceived-=Error;report["checks"]=checks;report["traces"]=traces;report["errors"]=JArray.FromObject(errors);if(!string.IsNullOrWhiteSpace(directory))File.WriteAllText(Path.Combine(directory,"unity-graphics-result.json"),report.ToString());EditorApplication.Exit(report.Value<bool>("success")?0:1);}
        }
        private static DataPointDto Point(long id,string device,string group,string role,string type)=>new DataPointDto{Id=id,DeviceId=device,Category=group,ValueRole=role,DataType=type,AccessType="READ"};
        private static void Save(Camera camera,string file){var target=RenderTexture.GetTemporary(1600,900,24);var texture=new Texture2D(1600,900,TextureFormat.RGB24,false);var old=RenderTexture.active;try{camera.targetTexture=target;camera.Render();RenderTexture.active=target;texture.ReadPixels(new Rect(0,0,1600,900),0,0);texture.Apply();File.WriteAllBytes(file,texture.EncodeToPNG());}finally{camera.targetTexture=null;RenderTexture.active=old;RenderTexture.ReleaseTemporary(target);Object.Destroy(texture);}}
    }
}
#endif
