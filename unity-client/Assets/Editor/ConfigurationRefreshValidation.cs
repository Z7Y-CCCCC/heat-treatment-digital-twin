#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class ConfigurationRefreshValidation
    {
        public static void Run() { EditorApplication.delayCall += RunAsync; }
        private static FieldInfo Field(Type type, string name) => type.GetField(name, BindingFlags.Instance|BindingFlags.NonPublic) ?? throw new Exception("Missing field "+name);
        private static T Get<T>(FactoryRuntime runtime,string name)=>(T)Field(typeof(FactoryRuntime),name).GetValue(runtime);
        private static void Set(FactoryRuntime runtime,string name,object value)=>Field(typeof(FactoryRuntime),name).SetValue(runtime,value);
        private static FactoryConfigDto Copy(FactoryConfigDto value)=>JsonConvert.DeserializeObject<FactoryConfigDto>(JsonConvert.SerializeObject(value));
        private static void Queue(FactoryRuntime runtime)=>typeof(FactoryRuntime).GetMethod("QueueConfigurationReload",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(runtime,new object[]{0});
        private static async Task Wait(Func<bool> condition,string description)
        { var end=DateTime.UtcNow.AddSeconds(30);while(!condition()){if(DateTime.UtcNow>end)throw new Exception("Timeout: "+description);await Task.Delay(25);} }
        private static async Task WaitAsync(Func<Task<bool>> condition,string description)
        { var end=DateTime.UtcNow.AddSeconds(30);while(!await condition()){if(DateTime.UtcNow>end)throw new Exception("Timeout: "+description);await Task.Delay(25);} }
        private static async void RunAsync()
        {
            var report=new JObject{["success"]=false,["liveConfigurationWrites"]=0};var checks=new JArray();var errors=new List<string>();
            var scene=EditorSceneManager.NewPreviewScene();GameObject runtimeRoot=null,factoryRoot=null;string directory=null;
            var previousDiagnostics=Environment.GetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS");
            var editorDeferAgent=new GLTFast.UninterruptedDeferAgent();
            void Log(string message,string stack,LogType type){if(type==LogType.Error||type==LogType.Exception||type==LogType.Assert)errors.Add(message);}
            Application.logMessageReceived+=Log;
            void Check(bool value,string name){if(!value)throw new Exception(name);checks.Add(name);}
            GameObject Create(string name){var go=new GameObject(name);SceneManager.MoveGameObjectToScene(go,scene);return go;}
            try
            {
                var file=Environment.GetEnvironmentVariable("CONFIGURATION_REFRESH_FIXTURE_INFO");
                var workspace=Directory.GetParent(Application.dataPath).Parent.FullName;
                if(string.IsNullOrEmpty(file)||!Path.GetFullPath(file).StartsWith(Path.Combine(workspace,"output")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Owned fixture info under output is required");
                var info=JObject.Parse(File.ReadAllText(file));directory=info.Value<string>("directory");var origin=new Uri(info.Value<string>("origin"));
                if(!origin.IsLoopback||origin.Scheme!="http")throw new Exception("Only the isolated loopback fixture is allowed");
                using var http=new HttpClient(new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false});
                async Task<JObject> ReadStats()=>JObject.Parse(await http.GetStringAsync(new Uri(origin,"/fixture/stats")));
                async Task Post(string path,object body){using var response=await http.PostAsync(new Uri(origin,path),new StringContent(JsonConvert.SerializeObject(body),Encoding.UTF8,"application/json"));response.EnsureSuccessStatusCode();}
                var initial=info["config"].ToObject<FactoryConfigDto>();
                await Post("/fixture/config",initial);await Post("/fixture/behavior",new{delay=0,failures=0});
                GLTFast.GltfImport.SetDefaultDeferAgent(editorDeferAgent);
                runtimeRoot=Create("isolated-runtime");runtimeRoot.SetActive(false);
                var runtime=runtimeRoot.AddComponent<FactoryRuntime>();var library=runtimeRoot.AddComponent<RuntimeModelLibrary>();
                var diagnostics=runtimeRoot.AddComponent(Field(typeof(FactoryRuntime),"_diagnostics").FieldType);
                var settingsType=Field(typeof(FactoryRuntime),"_settings").FieldType;
                var settings=typeof(ScriptableObject).IsAssignableFrom(settingsType)?ScriptableObject.CreateInstance(settingsType):Activator.CreateInstance(settingsType);
                settingsType.GetField("backendHttpUrl").SetValue(settings,origin.ToString().TrimEnd('/'));
                settingsType.GetField("modelLoadTimeoutSeconds").SetValue(settings,30f);
                factoryRoot=Create("isolated-factory");var cameraRoot=Create("isolated-camera");var camera=cameraRoot.AddComponent<Camera>();
                var orbit=cameraRoot.AddComponent<OrbitCameraController>();orbit.enabled=false;
                camera.transform.position=new Vector3(23,12,31);camera.transform.rotation=Quaternion.Euler(20,-35,0);
                var dashboardRoot=Create("isolated-dashboard");dashboardRoot.SetActive(false);var dashboard=dashboardRoot.AddComponent<FactoryDashboardController>();
                dashboard.Initialize(camera,orbit,null);dashboard.BeginFactory(initial);
                Set(runtime,"_config",initial);Set(runtime,"_factoryRoot",factoryRoot.transform);Set(runtime,"_modelLibrary",library);Set(runtime,"_camera",camera);
                Set(runtime,"_dashboard",dashboard);Set(runtime,"_diagnostics",diagnostics);Set(runtime,"_settings",settings);Set(runtime,"_lifetime",new CancellationTokenSource());
                Set(runtime,"_api",new BackendApiClient(origin.ToString()));Set(runtime,"_authenticated",true);Set(runtime,"_sceneReady",true);Set(runtime,"_sceneLoadId","unchanged-fixture-load");
                library.Configure(origin.ToString(),initial.Models,30);
                var roots=Get<Dictionary<string,Transform>>(runtime,"_deviceRoots");
                foreach(var device in ModelHotRefreshPolicy.Devices(initial)){
                    var instance=await library.InstantiateAsync(device,factoryRoot.transform,CancellationToken.None);Check(!instance.IsFallback,"Actual glTF loaded: "+device.Id);
                    roots[device.Id]=instance.Root.transform;Get<Dictionary<string,ModelBindingDriver>>(runtime,"_drivers")[device.Id]=instance.Root.GetComponent<ModelBindingDriver>();
                    Get<Dictionary<string,string>>(runtime,"_deviceModelTypes")[device.Id]=device.ModelType;Get<Dictionary<string,string>>(runtime,"_deviceLineIds")[device.Id]="line";
                    dashboard.RegisterDevice(device,instance.Root,instance.Inspection);
                }
                var baseline=roots.ToDictionary(row=>row.Key,row=>row.Value.GetInstanceID());var templates=library.TemplateLoadCount;var instances=library.InstanceCreationCount;
                Check(templates==2&&instances==3,"Two real CAD templates serve three devices");
                var selected=((IDictionary)Field(typeof(FactoryDashboardController),"_devices").GetValue(dashboard))["a"];
                var motion=roots["a"].gameObject.AddComponent<MobileDeviceMotion>();
                Get<Dictionary<string,MobileDeviceMotion>>(runtime,"_motions")["a"]=motion;
                Field(typeof(MobileDeviceMotion),"_motionSpeed").SetValue(motion,1.5f);
                Field(typeof(FactoryDashboardController),"_selected").SetValue(dashboard,selected);
                var inspection=selected.GetType().GetField("Inspection").GetValue(selected);var cameraPosition=camera.transform.position;var cameraRotation=camera.transform.rotation;
                Environment.SetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS","1");
                var reads=(await ReadStats()).Value<int>("configReads");for(var i=0;i<6;i++)Queue(runtime);
                await Wait(()=>Get<int>(runtime,"_configurationReloadVersion")>0,"queued read");await Task.Delay(800);
                Check((await ReadStats()).Value<int>("configReads")==reads+1,"Six duplicate notifications coalesce to one authoritative read");
                roots["a"].localPosition=new Vector3(99,0,0);var latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));var a=ModelHotRefreshPolicy.Devices(latest).First(row=>row.Id=="a");
                a.Name="Renamed without loading";a.DataPoints.Add(new DataPointDto{Id=101,DeviceId="a",Name="new reading",Category="analog",ValueRole="reading",DataType="REAL",AccessType="READ"});
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>ModelHotRefreshPolicy.Devices(Get<FactoryConfigDto>(runtime,"_config")).First().Name==a.Name,"name and point update");
                Check(roots["a"].localPosition.x==99,"Unrelated save retains the unsaved preview transform");
                Check((float)Field(typeof(MobileDeviceMotion),"_motionSpeed").GetValue(motion)==1.5f,"Point/name changes do not restart ongoing device movement");
                Check(ReferenceEquals(inspection,selected.GetType().GetField("Inspection").GetValue(selected)),"Point/name update retains inspection state");
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));ModelHotRefreshPolicy.Devices(latest).First(row=>row.Id=="a").PositionX=7;
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>roots["a"].localPosition.x==7,"in-place saved transform");
                Check(baseline.All(row=>roots[row.Key].GetInstanceID()==row.Value)&&templates==library.TemplateLoadCount&&instances==library.InstanceCreationCount,"Names, points and saved positions instantiate/import zero models");
                Check(camera.transform.position==cameraPosition&&camera.transform.rotation==cameraRotation&&Get<string>(runtime,"_sceneLoadId")=="unchanged-fixture-load","Camera and scene-loading identity are retained");
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));latest.Settings["factory_name"]="Updated factory label";latest.Settings["fixture_setting"]="temporary";
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>Get<FactoryConfigDto>(runtime,"_config").Settings.ContainsKey("fixture_setting"),"ordinary settings update");
                Check(Field(typeof(FactoryDashboardController),"_factoryName").GetValue(dashboard).ToString()=="Updated factory label","Factory settings update without scene reconstruction");
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));latest.Settings.Remove("fixture_setting");latest.Platform["document"]["version"]=2;
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>!Get<FactoryConfigDto>(runtime,"_config").Settings.ContainsKey("fixture_setting"),"removed setting and published definitions");
                Check(baseline.All(row=>roots[row.Key].GetInstanceID()==row.Value)&&templates==library.TemplateLoadCount&&instances==library.InstanceCreationCount,"Settings removal and published document changes import/instantiate zero models");
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));latest.Models[0].MetadataObject["note"]="Non-rendering metadata";
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>Get<FactoryConfigDto>(runtime,"_config").Models[0].MetadataObject.Value<string>("note")=="Non-rendering metadata","metadata synchronization");
                Check(library.TemplateLoadCount==templates&&library.InstanceCreationCount==instances,"Model annotation changes instantiate/import zero models");
                await Post("/fixture/behavior",new{delay=650});latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));ModelHotRefreshPolicy.Devices(latest).First().Name="Obsolete";
                await Post("/fixture/config",latest);reads=(await ReadStats()).Value<int>("configReads");Queue(runtime);
                await WaitAsync(async()=> (await ReadStats()).Value<int>("configReads")>reads,"delayed request started");
                await Post("/fixture/behavior",new{delay=0});ModelHotRefreshPolicy.Devices(latest).First().Name="Newest";await Post("/fixture/config",latest);Queue(runtime);
                await Wait(()=>ModelHotRefreshPolicy.Devices(Get<FactoryConfigDto>(runtime,"_config")).First().Name=="Newest","newest response");await Task.Delay(750);
                Check(ModelHotRefreshPolicy.Devices(Get<FactoryConfigDto>(runtime,"_config")).First().Name=="Newest","Cancelled old response cannot restore obsolete configuration");
                await Post("/fixture/behavior",new{failures=1});ModelHotRefreshPolicy.Devices(latest).First().Name="Recovered";await Post("/fixture/config",latest);Queue(runtime);
                await Wait(()=>ModelHotRefreshPolicy.Devices(Get<FactoryConfigDto>(runtime,"_config")).First().Name=="Recovered","bounded retry after transient HTTP failure");
                Check(library.TemplateLoadCount==templates&&library.InstanceCreationCount==instances,"Retry/reordering never destroys the existing scene");
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));var configured=ModelHotRefreshPolicy.Devices(latest).First(row=>row.Id=="a");
                configured.InstanceConfig=JObject.Parse("{animationBindings:{version:1,staleMs:5000,bindings:[{actionId:'clip:door',clipId:'door',kind:'clip',mode:'position',enabled:true,sourceGroup:'doors',sourceKey:'door',pointId:'101',inputMin:0,inputMax:1,transitionSeconds:1}]}}");
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>roots["a"].GetInstanceID()!=baseline["a"],"first rig enable");
                Check(roots["a2"].GetInstanceID()==baseline["a2"]&&roots["b"].GetInstanceID()==baseline["b"],"Only the changed device switches to its animated rig");
                var rigLoads=library.TemplateLoadCount;var staticA=roots["a2"].GetInstanceID();var animatedA=roots["a"].GetInstanceID();var oldReads=library.MotionPackageReadCount;
                latest=Copy(Get<FactoryConfigDto>(runtime,"_config"));latest.Models[0].MotionPackage["clipPath"]=info["changedClip"]["path"];latest.Models[0].MotionPackage["clipSha256"]=info["changedClip"]["sha256"];
                await Post("/fixture/config",latest);Queue(runtime);await Wait(()=>roots["a"].GetInstanceID()!=animatedA,"changed track data applied");
                Check(library.TemplateLoadCount==rigLoads&&library.MotionPackageReadCount==oldReads+1,"Track-only update reads JSON once and imports no geometry");
                Check(roots["a2"].GetInstanceID()==staticA&&roots["b"].GetInstanceID()==baseline["b"],"Unused tracks do not replace static copies or unrelated models");
                Check(errors.Count==0,"No Unity runtime errors");
                report["success"]=true;report["stats"]=await ReadStats();report["templateLoads"]=library.TemplateLoadCount;report["instanceCreations"]=library.InstanceCreationCount;
                report["graphicsDevice"]=SystemInfo.graphicsDeviceName;report["graphicsAPI"]=SystemInfo.graphicsDeviceType.ToString();
            }
            catch(Exception error){report["error"]=error.ToString();Debug.LogException(error);}
            finally
            {
                Environment.SetEnvironmentVariable("DEVICE_ANIMATION_DIAGNOSTICS",previousDiagnostics);
                if(factoryRoot!=null)Object.DestroyImmediate(factoryRoot);if(runtimeRoot!=null)Object.DestroyImmediate(runtimeRoot);
                EditorSceneManager.ClosePreviewScene(scene);Application.logMessageReceived-=Log;report["checks"]=checks;report["errors"]=JArray.FromObject(errors);
                GLTFast.GltfImport.UnsetDefaultDeferAgent(editorDeferAgent);
                if(directory!=null)File.WriteAllText(Path.Combine(directory,"unity-configuration-refresh-result.json"),report.ToString());
                EditorApplication.Exit(report.Value<bool>("success")?0:1);
            }
        }
    }
}
#endif
