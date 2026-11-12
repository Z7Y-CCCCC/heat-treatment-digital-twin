using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Runtime half of the existing admin transfer workspace. Mechanism poses
    // come from its exported Three rig; the cycle is trace-tested against JS.
    // This class never writes a PLC and never uses an estimated dock as proof.
    public sealed class BidirectionalTransferRuntime : IDisposable
    {
        private sealed class Target
        {
            public string Id;public double Value;public int Side;public Transform Root,Seat;
            public Vector3 SeatLocal;public LoadingPortPose Port;
            public TransferBooleanObservation Presence;public GameObject Cargo;
        }
        private sealed class Link
        {
            public string Id,LastRecord;public JObject Config;public Transform Root;public MobileDeviceMotion Motion;public DeviceAnimationDriver Driver;
            public LoadingPortPose Port;public Vector3 Home;public float Units,Height;public double Stale,NextLog;
            public bool Logs;public int Side=1;public Target ActiveTarget;
            public Material Material;public GameObject Cargo;
            public readonly AdaptiveTransferPath Path=new AdaptiveTransferPath(),CandidatePath=new AdaptiveTransferPath();
            public readonly double[] HomeBuffer=new double[3],SeatBuffer=new double[3],CargoBuffer=new double[3];
            public TransferBooleanObservation Presence,Start,Pickup;
            public TransferCycleConfig Timing=new TransferCycleConfig();public TransferCycleState Cycle=new TransferCycleState();
            public readonly List<Target> Targets=new List<Target>();
            public readonly double[] A=new double[3],B=new double[3],C=new double[3],D=new double[3],E=new double[3];
        }
        private readonly List<Link> _links=new List<Link>();
        private static Vector3 V(JToken a)=>new Vector3(-(float)a[0].Value<double>(),(float)a[1].Value<double>(),(float)a[2].Value<double>());
        private static bool Finite(double n)=>!double.IsNaN(n)&&!double.IsInfinity(n);
        private static double TimeValue(JObject c,string key){var n=c.Value<double?>(key)??double.NaN;if(!Finite(n)||n<.1||n>120)throw new InvalidOperationException("显示时长无效");return n;}
        private static TransferBooleanObservation Catalog(string id,JObject c,string name)=>new TransferBooleanObservation(id,"__transfer_"+name,c.Value<string>(name+"DataItemId"));
        public void Configure(IEnumerable<DeviceDto> devices,IEnumerable<ModelAssetDto> models,IReadOnlyDictionary<string,Transform> roots,IReadOnlyDictionary<string,MobileDeviceMotion> motions,IEnumerable<LineDto> lines)
        {
            Dispose();var deviceMap=(devices??Enumerable.Empty<DeviceDto>()).Where(d=>d!=null&&!string.IsNullOrEmpty(d.Id)).GroupBy(d=>d.Id).ToDictionary(g=>g.Key,g=>g.First());var modelMap=(models??Enumerable.Empty<ModelAssetDto>()).Where(m=>m!=null&&!string.IsNullOrEmpty(m.Id)).GroupBy(m=>m.Id).ToDictionary(g=>g.Key,g=>g.First());
            var lineMap=(lines??Enumerable.Empty<LineDto>()).Where(l=>l!=null&&!string.IsNullOrEmpty(l.Id)).GroupBy(l=>l.Id).ToDictionary(g=>g.Key,g=>g.First().LayoutObject);
            foreach(var source in deviceMap.Values){
                var a=source.InstanceConfigObject["animationBindings"] as JObject;var c=a?["transferLink"] as JObject;var cycle=c?["cycle"] as JObject;
                if(c?.Value<bool?>("enabled")!=true||cycle?.Value<bool?>("enabled")!=true)continue;
                Link link=null;
                try{
                    if(!roots.TryGetValue(source.Id,out var root)||root==null||!motions.TryGetValue(source.Id,out var motion))throw new InvalidOperationException("料车与移动反馈尚未加载");
                    var driver=root.GetComponent<DeviceAnimationDriver>();if(driver==null)throw new InvalidOperationException("同源双侧动作包尚未加载");
                    modelMap.TryGetValue(source.ModelType,out var model);LoadingPortPolicy.TryResolve(model?.MetadataObject,source.InstanceConfigObject,c.Value<string>("sourcePort"),out var port,out var why);
                    if(port==null)throw new InvalidOperationException(why);
                    lineMap.TryGetValue(source.LineId??source.InstanceConfigObject.Value<string>("railLineId")??"",out var line);
                    if(!SceneUnitPolicy.TryResolve(source.InstanceConfigObject["movement"] as JObject,line,out var units,out why))throw new InvalidOperationException(why);
                    link=new Link{Id=source.Id,Root=root,Motion=motion,Driver=driver,Config=c,Port=port,Home=V(cycle["cartHome"]),Units=units,
                        Stale=a.Value<double?>("staleMs")??5000,Logs=a.Value<bool?>("diagnosticLogging")==true,
                        Presence=new TransferBooleanObservation(source.Id,"__transfer_presence",c.Value<string>("presenceDataItemId")),Start=Catalog(source.Id,cycle,"start"),Pickup=Catalog(source.Id,cycle,"pickup")};
                    link.Timing=new TransferCycleConfig{ExtendSeconds=TimeValue(cycle,"extendSeconds"),LatchSeconds=TimeValue(cycle,"latchSeconds"),RetractSeconds=TimeValue(cycle,"retractSeconds"),ConveySeconds=TimeValue(cycle,"conveySeconds"),ConfirmTimeoutSeconds=TimeValue(cycle,"confirmTimeoutSeconds")};
                    if(link.Timing.ConveySeconds>link.Timing.LatchSeconds+link.Timing.RetractSeconds)throw new InvalidOperationException("辊道时长超过退链过程");
                    if(!ColorUtility.TryParseHtmlString(c.Value<string>("materialColor"),out var color))throw new InvalidOperationException("物料颜色无效");
                    link.Material=RuntimeShaderLibrary.CreateLitMaterial("双侧进出料物料示意");link.Material.color=color;if(link.Material.HasProperty("_BaseColor"))link.Material.SetColor("_BaseColor",color);
                    var size=(JArray)c["materialSize"];var dimensions=new Vector3(size[0].Value<float>(),size[1].Value<float>(),size[2].Value<float>())*units;
                    if(!float.IsFinite(dimensions.x)||!float.IsFinite(dimensions.y)||!float.IsFinite(dimensions.z)||dimensions.x<=0||dimensions.y<=0||dimensions.z<=0)throw new InvalidOperationException("物料米制尺寸无效");
                    link.Height=dimensions.y;link.Cargo=Cargo(link,"车上物料 "+source.Id,dimensions);
                    var handoff=cycle.Value<string>("handoffMode")??"mechanism";
                    if(handoff!="mechanism"&&handoff!="adaptive")throw new InvalidOperationException("交接显示方式无效");
                    foreach(var station in cycle["stations"].OfType<JObject>()){
                        var id=station.Value<string>("targetDeviceId");if(!deviceMap.TryGetValue(id,out var target)||!roots.TryGetValue(id,out var targetRoot)||targetRoot==null)throw new InvalidOperationException("工位目标尚未加载");
                        if(target.InstanceConfigObject["movement"]?.Value<bool?>("enabled")==true)throw new InvalidOperationException("交接目标不能是移动设备");
                        var point=target.DataPoints?.FirstOrDefault(p=>p.Id.ToString()==station.Value<string>("presencePointId")&&p.DeviceId==id&&string.Equals(p.DataType,"BOOL",StringComparison.OrdinalIgnoreCase)&&string.Equals(p.AccessType??"READ","READ",StringComparison.OrdinalIgnoreCase));
                        if(point==null)throw new InvalidOperationException("目标在位反馈不是该设备的只读 BOOL");
                        var nodes=targetRoot.GetComponentsInChildren<Transform>(true).Where(n=>n.name==station.Value<string>("seatNodeName")).ToArray();if(nodes.Length!=1)throw new InvalidOperationException("目标承料节点缺失或重名");
                        modelMap.TryGetValue(target.ModelType,out var targetModel);LoadingPortPolicy.TryResolve(targetModel?.MetadataObject,target.InstanceConfigObject,c.Value<string>("targetPort"),out var targetPort,out why);if(targetPort==null)throw new InvalidOperationException(why);
                        link.Targets.Add(new Target{Id=id,Value=station.Value<double>("value"),Side=station.Value<string>("side")=="opposite"?-1:1,Root=targetRoot,Seat=nodes[0],SeatLocal=V(station["seatNodeLocal"]),Port=targetPort,
                            Presence=new TransferBooleanObservation(id,point.Id.ToString(),point.Category??"analog",string.IsNullOrWhiteSpace(point.ValueRole)?point.Name:point.ValueRole),Cargo=Cargo(link,"设备内物料 "+id,dimensions)});
                    }
                    _links.Add(link);
                }catch(Exception error){if(link!=null)DisposeLink(link);Debug.LogWarning("[DeviceTransfer] "+source.Id+" 双侧联动未启用："+error.Message);}
            }
        }
        private static GameObject Cargo(Link link,string name,Vector3 dimensions)
        {
            var cargo=GameObject.CreatePrimitive(PrimitiveType.Cube);cargo.name=name;cargo.layer=2;cargo.transform.localScale=dimensions;cargo.GetComponent<Renderer>().sharedMaterial=link.Material;
            var collider=cargo.GetComponent<Collider>();if(Application.isPlaying)UnityEngine.Object.Destroy(collider);else UnityEngine.Object.DestroyImmediate(collider);cargo.SetActive(false);return cargo;
        }
        public void ApplyInputs(string id,JObject frame)
        {
            var now=Time.realtimeSinceStartupAsDouble;var wall=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();var consume=false;
            foreach(var link in _links){
                if(link.Id==id){link.Presence.Receive(frame,now,wall);link.Start.Receive(frame,now,wall);link.Pickup.Receive(frame,now,wall);consume=true;}
                foreach(var t in link.Targets)if(t.Id==id){t.Presence.Receive(frame,now,wall);if(link.ActiveTarget==t&&link.Cycle.Phase=="wait")consume=true;}
            }
            // Consume typed command edges before another queued packet can
            // replace them in the same Unity frame. No display time elapses.
            if(consume)Advance(0,now);
        }
        private static Vector3 PortPoint(Transform root,LoadingPortPose port,int side=1){var p=new Vector3(-(float)port.Position[0],(float)port.Position[1],(float)port.Position[2]);if(side<0){p.x=-p.x;p.z=-p.z;}return root.TransformPoint(p);}
        private static Vector3 PortDirection(Transform root,LoadingPortPose port,int side=1){var p=new Vector3(-(float)port.Direction[0],0,(float)port.Direction[2]);if(side<0){p.x=-p.x;p.z=-p.z;}return root.TransformVector(p).normalized;}
        private static void M(Vector3 v,double units,double[] a){a[0]=v.x/units;a[1]=v.y/units;a[2]=v.z/units;}
        private static Vector3 Seat(Target target)=>target.Seat.TransformPoint(target.SeatLocal);
        private static bool Upright(Transform root){var up=root.TransformVector(Vector3.up);return up.sqrMagnitude>0&&Vector3.Dot(up.normalized,Vector3.up)>.9999f;}
        private static bool Geometry(Link l,Target t,out double mouthFraction,out string reason)
        {
            mouthFraction=0;reason="双侧机构或承料位无效";
            if(!Upright(l.Root)||!Upright(t.Root)||!l.Driver.TryGetPresentationDrive(t.Side,out var node,out _,out var maximum)||node.parent==null)return false;
            var source=PortPoint(l.Root,l.Port,t.Side);var direction=PortDirection(l.Root,l.Port,t.Side);var target=PortPoint(t.Root,t.Port);var normal=PortDirection(t.Root,t.Port);
            M(source,l.Units,l.A);M(direction,1,l.B);M(target,l.Units,l.C);M(normal,1,l.D);M(node.parent.TransformVector(maximum),l.Units,l.E);
            {
                M(l.Root.TransformPoint(l.Home),l.Units,l.HomeBuffer);M(Seat(t),l.Units,l.SeatBuffer);
                var adaptive=l.Cycle.Active?l.CandidatePath:l.Path;
                var usable=adaptive.Build(l.HomeBuffer,l.A,l.B,l.C,l.D,l.SeatBuffer,l.E,l.Config.Value<double>("heightToleranceMeters"),l.Config.Value<double>("lateralToleranceMeters"),l.Config.Value<double>("angleToleranceDegrees"));
                mouthFraction=l.Path.MouthFraction;reason=adaptive.Reason;
                if(usable&&l.Cycle.Active&&!l.Path.SameGeometry(adaptive)){reason="交接途中承料路径已变化，显示冻结";return false;}
                return usable;
            }
        }
        private static void Place(Link l,GameObject cargo,Vector3 floor,bool visible)
        {
            if(cargo==null)return;if(visible){cargo.transform.position=floor+Vector3.up*(l.Height*.5f);cargo.transform.rotation=l.Root.rotation;}
            if(cargo.activeSelf!=visible)cargo.SetActive(visible);
        }
        public void Advance(double delta,double now)
        {
            foreach(var l in _links){
                var sourceGood=l.Presence.Advance(now,l.Stale);var startGood=l.Start.Advance(now,l.Stale);var pickupGood=l.Pickup.Advance(now,l.Stale);
                foreach(var t in l.Targets)t.Presence.Advance(now,l.Stale);
                var docked=l.Motion.HasConfirmedPosition;
                var current=docked?l.Targets.FirstOrDefault(t=>Math.Abs(t.Value-l.Motion.CurrentPositionValue)<.0001):null;
                if(!l.Cycle.Active&&current!=null){if(l.ActiveTarget!=current)l.Cycle=new TransferCycleState{Armed=l.Cycle.Armed,Hook=l.Cycle.Hook};l.ActiveTarget=current;l.Side=current.Side;}
                var active=l.ActiveTarget;var reason="等待独立停靠反馈";var fraction=0d;
                var geometry=l.Root.gameObject.activeInHierarchy&&current!=null&&current.Root.gameObject.activeInHierarchy&&active==current&&Geometry(l,current,out fraction,out reason);
                var valid=sourceGood&&startGood&&pickupGood&&active!=null&&active.Presence.Usable&&active.Presence.HasSample;
                l.Cycle.Advance(new TransferCycleInput{Valid=valid,Docked=docked&&geometry,Start=l.Start.Value,Pickup=l.Pickup.Value,SourcePresent=l.Presence.Value,TargetPresent=active?.Presence.Value??false,MouthFraction=fraction},delta,l.Timing);
                foreach(var t in l.Targets)Place(l,t.Cargo,Seat(t),t.Root.gameObject.activeInHierarchy&&t.Presence.Usable&&t.Presence.HasSample&&t.Presence.Value&&!(l.Cycle.Active&&t==active));
                if(l.Cycle.Active){
                    if(!l.Root.gameObject.activeInHierarchy||!active.Root.gameObject.activeInHierarchy){Place(l,l.Cargo,Vector3.zero,false);}
                    if(!l.Cycle.Paused){
                        if(l.Driver.SetTransferPresentation(l.Side,l.Cycle.Feed,l.Cycle.Hook,out reason)){
                            l.Path.Sample(l.Cycle.Cargo,l.CargoBuffer);var floor=World(l.CargoBuffer,l.Units);
                            Place(l,l.Cargo,floor,true);
                        }
                    }
                }else{
                    l.Driver.SetTransferPresentation(l.Side,0,l.Cycle.Hook,out _);
                    Place(l,l.Cargo,l.Root.TransformPoint(l.Home),sourceGood&&l.Presence.Value&&l.Root.gameObject.activeInHierarchy&&l.Motion.HasFreshPosition);
                }
                var signature=l.Cycle.Phase+":"+l.Cycle.Reason+":"+reason+":"+l.Presence.Value+":"+(active?.Presence.Value??false);
                if(signature!=l.LastRecord||l.Logs&&now>=l.NextLog){
                    l.LastRecord=signature;l.NextLog=now+1;
                    var record=new JObject{["deviceId"]=l.Id,["targetDeviceId"]=active?.Id,["side"]=l.Side<0?"opposite":"primary",["phase"]=l.Cycle.Phase,["reason"]=l.Cycle.Paused?(!geometry?reason:l.Cycle.Reason):l.Cycle.Reason,
                        ["displayEstimated"]=true,["arrivalConfirmed"]=docked,["geometryUsable"]=geometry,["bothPresenceConfirmed"]=l.Cycle.Confirmed,["paused"]=l.Cycle.Paused,
                        ["feed"]=l.Cycle.Feed,["hook"]=l.Cycle.Hook,["cargoFraction"]=l.Cycle.Cargo,["sourceMaterialVisible"]=l.Cargo.activeSelf,["sourcePresent"]=l.Presence.Value,["targetPresent"]=active?.Presence.Value??false};
                    record["handoffMode"]="mechanism";record["bridgeMeters"]=0;
                    l.Driver.TransferDiagnostic=record;if(l.Logs)Debug.Log("[DeviceTransferCycle] "+record.ToString(Newtonsoft.Json.Formatting.None));
                }
            }
        }
        public void Suspend(){foreach(var l in _links){l.Presence.Suspend();l.Start.Suspend();l.Pickup.Suspend();foreach(var t in l.Targets)t.Presence.Suspend();}Advance(0,Time.realtimeSinceStartupAsDouble);}
        private static void Destroy(UnityEngine.Object o){if(o==null)return;if(Application.isPlaying)UnityEngine.Object.Destroy(o);else UnityEngine.Object.DestroyImmediate(o);}
        private static Vector3 World(double[] p,float units)=>new Vector3((float)(p[0]*units),(float)(p[1]*units),(float)(p[2]*units));
        private static void DisposeLink(Link l){Destroy(l.Cargo);foreach(var t in l.Targets)Destroy(t.Cargo);Destroy(l.Material);}
        public void Dispose(){foreach(var l in _links)DisposeLink(l);_links.Clear();}
    }
}
