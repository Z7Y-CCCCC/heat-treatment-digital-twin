using System;
using System.Collections.Generic;
using System.IO;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.EditorTests
{
    public static class SimpleStationMotionValidation
    {
        private static int _checks;
        private static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); _checks++; }
        private static JObject Frame(long at, int target, bool arrived) => new JObject {
            ["furnace_id"]="cart",["timestamp"]=at,["analog"]=new JObject{["target"]=target},["status"]=new JObject{["online"]=true,["arrived"]=arrived},
            ["quality"]=new JObject{["analog"]=new JObject{["target"]="good"},["status"]=new JObject{["arrived"]="good"}},
            ["pointMeta"]=new JObject{["analog.target"]=new JObject{["id"]=1,["category"]="analog",["field_name"]="target",["timestamp"]=at},
                ["status.arrived"]=new JObject{["id"]=2,["category"]="status",["field_name"]="arrived",["timestamp"]=at}}
        };
        public static void Run()
        {
            GameObject cart = null, parent = null, anchor = null;
            try {
                _checks=0;
                var movement=JObject.Parse("{enabled:true,displayMode:'simple',valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'1',arrivalSignalPointId:'2',start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:10,y:0,z:0}}]}");
                var device=new DeviceDto{Id="cart",ModelType="transfer_cart",InstanceConfig=new JObject{["movement"]=movement},DataPoints=new List<DataPointDto>{
                    new DataPointDto{Id=1,DeviceId="cart",Category="analog",ValueRole="target",DataType="WORD",AccessType="READ"},
                    new DataPointDto{Id=2,DeviceId="cart",Category="status",ValueRole="arrived",DataType="BOOL",AccessType="READ"}}};
                cart=new GameObject("Isolated simple station cart");var driver=cart.AddComponent<MobileDeviceMotion>();driver.Initialize(device);
                var at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();driver.ApplyRealtime(Frame(at,1,true));
                Check(driver.HasConfirmedPosition,"Initial actual dock not established");
                driver.ApplyRealtime(Frame(at+1,2,true));var started=Time.realtimeSinceStartupAsDouble;
                driver.AdvanceMotion(1,(started+1));
                Check(cart.transform.localPosition.x>0&&cart.transform.localPosition.x<10&&!driver.HasConfirmedPosition,"Held old arrival confirmed new target, or no parameter-free movement");
                driver.ApplyRealtime(Frame(at+2,2,false));var before=cart.transform.localPosition;
                driver.ApplyRealtime(Frame(at+3,2,true));var arrivedAt=Time.realtimeSinceStartupAsDouble;
                Check((cart.transform.localPosition-before).sqrMagnitude<.000001f&&!driver.HasConfirmedPosition,"Default checked smoothing snapped to the dock");
                driver.AdvanceMotion(.3f,arrivedAt+.3);
                Check(cart.transform.localPosition.x>before.x&&cart.transform.localPosition.x<10,"No intermediate alignment pose");
                driver.AdvanceMotion(.4f,arrivedAt+.7);Check(Mathf.Abs(cart.transform.localPosition.x-10)<.0001f&&driver.HasConfirmedPosition,"Alignment failed to complete and confirm dock");
                driver.ApplyRealtime(Frame(at+4,2,false));Check(driver.HasConfirmedPosition,"Falling arrival pulse erased a confirmed dock");
                movement["arrivalSmoothing"]=false;driver.Reconfigure(device,true);driver.ApplyRealtime(Frame(at+5,1,false));driver.ApplyRealtime(Frame(at+6,1,true));
                Check(cart.transform.localPosition.sqrMagnitude<.000001f&&driver.HasConfirmedPosition,"Unchecked alignment did not snap immediately");
                driver.ApplyRealtime(Frame(at+7,2,false));before=cart.transform.localPosition;driver.AdvanceMotion(1,Time.realtimeSinceStartupAsDouble+6);
                Check((cart.transform.localPosition-before).sqrMagnitude<.000001f&&!driver.HasConfirmedPosition,"Stale source continued guessed movement");
                parent = new GameObject("Rotated station frame"); parent.transform.position = new Vector3(30, 4, -12); parent.transform.rotation = Quaternion.Euler(0, 37, 0); parent.transform.localScale = new Vector3(2, 1, 2);
                cart.transform.SetParent(parent.transform, false); anchor = new GameObject("Current selected station"); anchor.transform.SetParent(parent.transform, false); anchor.transform.localPosition = new Vector3(22, 9, 6);
                movement["stations"][1]["anchorDeviceId"] = "furnace"; driver.Reconfigure(device, false);
                driver.ResolveSimpleStationAnchors(new Dictionary<string, Transform> { ["furnace"] = anchor.transform });
                driver.ApplyRealtime(Frame(at+8,2,true)); driver.AdvanceMotion(1,Time.realtimeSinceStartupAsDouble+1);
                Check((cart.transform.localPosition-new Vector3(22,0,0)).sqrMagnitude<.000001f&&driver.HasConfirmedPosition,"Stale station coordinate overrode current equipment, or rail plane/parent transform was lost");
                anchor.transform.localPosition = new Vector3(-7, 8, -15); driver.ResolveSimpleStationAnchors(new Dictionary<string, Transform> { ["furnace"] = anchor.transform });
                driver.ApplyRealtime(Frame(at+9,2,true)); driver.AdvanceMotion(1,Time.realtimeSinceStartupAsDouble+1);
                Check((cart.transform.localPosition-new Vector3(-7,0,0)).sqrMagnitude<.000001f,"An edited layout did not refresh its existing station without PLC renumbering");
                driver.ResolveSimpleStationAnchors(new Dictionary<string, Transform>()); driver.ApplyRealtime(Frame(at+10,2,true));
                Check(!driver.HasConfirmedPosition,"Missing selected equipment fell back to stale station coordinates");
                var directory=Environment.GetEnvironmentVariable("SIMPLE_STATION_CHECK_DIRECTORY");
                if(!string.IsNullOrEmpty(directory)){Directory.CreateDirectory(directory);File.WriteAllText(Path.Combine(directory,"result.json"),new JObject{["success"]=true,["checks"]=_checks,["actualUnityTransforms"]=true,["physicalParametersRequired"]=false}.ToString());}
                Debug.Log("Simple station motion passed: "+_checks+" checks");EditorApplication.Exit(0);
            }catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);}finally{if(cart!=null)UnityEngine.Object.DestroyImmediate(cart);if(anchor!=null)UnityEngine.Object.DestroyImmediate(anchor);if(parent!=null)UnityEngine.Object.DestroyImmediate(parent);}
        }
    }
}
