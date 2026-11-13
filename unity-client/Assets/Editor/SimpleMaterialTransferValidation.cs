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
    public static class SimpleMaterialTransferValidation
    {
        private static int _checks;
        private static long _at;
        private static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); _checks++; }
        private static DataPointDto Point(long id, string device, string role, string type = "BOOL") => new DataPointDto { Id = id, DeviceId = device, Category = "status", ValueRole = role, Name = role, AccessType = "READ", DataType = type };
        private static JObject Frame(string id, Dictionary<string, object> values, Dictionary<string, int> ids)
        {
            var at = ++_at; var status = new JObject { ["online"] = true }; var quality = new JObject(); var meta = new JObject();
            foreach (var value in values) {
                status[value.Key] = JToken.FromObject(value.Value); quality[value.Key] = "good";
                meta["status." + value.Key] = new JObject { ["id"] = ids[value.Key], ["category"] = "status", ["field_name"] = value.Key, ["timestamp"] = at };
            }
            return new JObject { ["furnace_id"] = id, ["timestamp"] = at, ["status"] = status, ["quality"] = new JObject { ["status"] = quality }, ["pointMeta"] = meta };
        }
        public static void Run()
        {
            GameObject scene = null; SimpleMaterialTransferRuntime runtime = null;
            try {
                _checks = 0; _at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 500;
                scene = new GameObject("Isolated material-flow acceptance");
                var cartRoot = GameObject.CreatePrimitive(PrimitiveType.Cube); cartRoot.name = "Generic cart"; cartRoot.transform.SetParent(scene.transform); cartRoot.transform.localScale = new Vector3(2, 2, 2);
                var fixedRoot = GameObject.CreatePrimitive(PrimitiveType.Cube); fixedRoot.name = "Generic furnace"; fixedRoot.transform.SetParent(scene.transform); fixedRoot.transform.position = new Vector3(10, 0, 0); fixedRoot.transform.localScale = new Vector3(4, 4, 4);
                var movement = JObject.Parse("{enabled:true,displayMode:'simple',valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'1',arrivalSignalPointId:'2',arrivalSmoothing:false,start:{x:0,y:0,z:0},end:{x:20,y:0,z:0},stations:[{value:1,anchorDeviceId:'fixed',position:{x:0,y:0,z:0}},{value:2,anchorDeviceId:'other',position:{x:20,y:0,z:0}}]}");
                var cart = new DeviceDto { Id = "cart", ModelType = "any_imported_cart", InstanceConfig = new JObject { ["movement"] = movement,
                    ["loadingPortSignals"] = JObject.Parse("{version:1,inletPointId:'3',outletPointId:'4'}") }, DataPoints = new List<DataPointDto> { Point(1,"cart","target","WORD"), Point(2,"cart","arrived"), Point(3,"cart","take"), Point(4,"cart","feed") } };
                var fixedDevice = new DeviceDto { Id = "fixed", ModelType = "any_imported_furnace", InstanceConfig = new JObject {
                    ["loadingPortSignals"] = JObject.Parse("{version:1,inletPointId:'5',outletPointId:'6'}") }, DataPoints = new List<DataPointDto> { Point(5,"fixed","receiving"), Point(6,"fixed","sending") } };
                var models = new[] {
                    new ModelAssetDto { Id=cart.ModelType, Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[-0.5,0,0],direction:[-1,0,0],nodeName:''},outlet:{position:[-0.5,0,0],direction:[-1,0,0],nodeName:''}}}") },
                    new ModelAssetDto { Id=fixedDevice.ModelType, Metadata=JObject.Parse("{loadingPorts:{version:1,inlet:{position:[0.5,0,0],direction:[1,0,0],nodeName:''},outlet:{position:[0.5,0,0],direction:[1,0,0],nodeName:''}}}") }
                };
                var roots = new Dictionary<string, Transform> { ["cart"] = cartRoot.transform, ["fixed"] = fixedRoot.transform };
                var motion = cartRoot.AddComponent<MobileDeviceMotion>(); motion.Initialize(cart);
                var motions = new Dictionary<string, MobileDeviceMotion> { ["cart"] = motion };
                runtime = new SimpleMaterialTransferRuntime(); runtime.Configure(new[] { cart, fixedDevice }, models, roots, motions, scene.transform);
                var clock = Time.realtimeSinceStartupAsDouble;
                var cartIds = new Dictionary<string, int> { ["target"]=1, ["arrived"]=2, ["take"]=3, ["feed"]=4 };
                var fixedIds = new Dictionary<string, int> { ["receiving"]=5, ["sending"]=6 };
                JObject Cart(int target, bool arrived, bool take, object feed) => Frame("cart", new Dictionary<string, object> { ["target"]=target, ["arrived"]=arrived, ["take"]=take, ["feed"]=feed }, cartIds);
                JObject Fixed(bool receiving, bool sending) => Frame("fixed", new Dictionary<string, object> { ["receiving"]=receiving, ["sending"]=sending }, fixedIds);
                void Send(JObject frame) { if (frame.Value<string>("furnace_id") == "cart") motion.ApplyRealtime(frame); runtime.Receive(frame.Value<string>("furnace_id"), frame, clock, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); }
                int Active() => runtime.Describe().Value<int>("activeTransfers");
                bool Owns(string id) => runtime.Describe()["estimatedCargoDevices"].Values<string>().Contains(id);
                Send(Cart(1,true,false,false)); Check(motion.HasConfirmedPosition,"Actual dock required");
                runtime.Advance(0, clock); Check(Active()==0&&!Owns("cart")&&!Owns("fixed"),"No imaginary cargo before a transfer command");
                Send(Cart(1,true,false,true)); runtime.Advance(0, clock); Check(Active()==1,"Cart outfeed alone must start without synchronous receiving signal");
                var cargo=scene.GetComponentsInChildren<Transform>().First(item=>item.name.StartsWith("Illustrative cargo ")); var start=cargo.position;
                Send(Cart(1,true,false,false)); runtime.Advance(1.5f,clock+.1); var middle=cargo.position;
                Check(middle.x>start.x&&middle.x<fixedRoot.transform.position.x,"Continuous cargo pose missing between ports");
                Send(Fixed(true,false)); runtime.Advance(1.6f,clock+.2); Check(Active()==0&&Owns("fixed")&&cargo.parent==fixedRoot.transform,"Cargo did not enter and stay in target");
                runtime.Advance(.1f,clock+.3); Check(Active()==0,"Held receiving signal replayed transfer");
                Send(Fixed(false,false)); Send(Cart(1,true,true,false)); runtime.Advance(0,clock+.4); Check(Active()==1,"Pickup requires no synchronized opposite-side signal");
                runtime.Advance(1.5f,clock+.5); Check(cargo.position.x>0&&cargo.position.x<middle.x+5,"No continuous reverse cargo path");
                runtime.Advance(1.6f,clock+.6); Check(Owns("cart")&&!Owns("fixed")&&cargo.parent==cartRoot.transform,"Pickup did not return cargo to moving cart");
                Send(Cart(1,true,false,false)); Send(Fixed(false,true)); runtime.Advance(0,clock+.7);
                Check(Active()==0,"Late counterpart edge duplicated already completed pickup");
                Send(Fixed(false,false)); Send(Cart(2,false,false,false)); var beforeTravel=cargo.position; motion.AdvanceMotion(1,Time.realtimeSinceStartupAsDouble+1);
                Check(cargo.position.x>beforeTravel.x,"Picked-up material does not travel with cart");
                Send(Fixed(true,false)); runtime.Advance(0,clock+.8); Check(Active()==0,"Old station signal started while cart moving to another target");
                Send(Cart(1,false,false,false)); Send(Cart(1,true,false,false));
                var unavailable=Fixed(false,false);unavailable["quality"]["status"]["receiving"]="bad";Send(unavailable);
                Send(Cart(1,true,false,true)); runtime.Advance(0,clock+.9); Check(Active()==1,"New captured edge did not start next transfer");
                runtime.Advance(.8f,clock+1); var frozen=cargo.position;
                Send(Cart(1,true,false,"1")); runtime.Advance(.8f,clock+1.1);
                Check((cargo.position-frozen).sqrMagnitude<.0000001f,"Wrong BOOL type continued the active transfer");
                Send(Cart(1,true,false,false)); runtime.Advance(.5f,clock+1.2); Check((cargo.position-frozen).sqrMagnitude>.000001f,"Fresh valid source could not resume pulse-driven transfer");
                frozen=cargo.position; runtime.Suspend(); runtime.Advance(1,clock+1.3); Check((cargo.position-frozen).sqrMagnitude<.0000001f,"Disconnect continued material movement");
                runtime.Configure(new[]{cart,fixedDevice},models,roots,motions,scene.transform); Check(Active()==1,"Unchanged refresh erased transfer state");
                runtime.Dispose();runtime.Configure(new[]{cart,fixedDevice},models,roots,motions,scene.transform);
                Send(Cart(1,true,false,false));Send(Fixed(false,false));Send(Fixed(true,false));runtime.Advance(0,clock);
                Check(Active()==1,"Fixed infeed alone cannot initiate the same handoff");runtime.Advance(3.1f,clock+.1);
                Check(Owns("fixed")&&Active()==0,"Fixed-only signal did not finish a continuous handoff");
                runtime.Dispose();runtime.Configure(new[]{cart,fixedDevice},models,roots,motions,scene.transform);
                Send(Cart(1,true,true,true));Send(Fixed(false,false));runtime.Advance(0,clock);
                Check(Active()==0,"Conflicting feed/take commands invented a material direction");
                runtime.Dispose();var noPorts=new[]{new ModelAssetDto{Id=cart.ModelType,Metadata=new JObject()},models[1]};
                runtime.Configure(new[]{cart,fixedDevice},noPorts,roots,motions,scene.transform);Send(Cart(1,true,false,true));runtime.Advance(0,clock);
                Check(Active()==0&&!Owns("cart"),"Missing authored ports fabricated a handoff position");
                var directory=Environment.GetEnvironmentVariable("SIMPLE_MATERIAL_CHECK_DIRECTORY");
                if(!string.IsNullOrEmpty(directory)){Directory.CreateDirectory(directory);File.WriteAllText(Path.Combine(directory,"result.json"),new JObject{["success"]=true,["checks"]=_checks,["actualUnityTransforms"]=true,["genericImportedModels"]=true,["oneSidedAsynchronousSignals"]=true,["displayOnly"]=true}.ToString());}
                Debug.Log("Simple material transfer passed: "+_checks+" checks"); EditorApplication.Exit(0);
            } catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);} finally {runtime?.Dispose();if(scene!=null)UnityEngine.Object.DestroyImmediate(scene);}
        }
    }
}
