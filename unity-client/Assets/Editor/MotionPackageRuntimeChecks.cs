#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using GLTFast;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;
namespace HeatTreatment.DigitalTwin.Editor
{
    public static class MotionPackageRuntimeChecks
    {
        public static async void Run()
        {
            var root = Path.GetFullPath(Path.Combine(Application.dataPath,"../.."));
            var output = Path.Combine(root,"output/motion-native-parity"); Directory.CreateDirectory(output);
            var report = new JObject(); var checks = 0; var actionCount = 0;
            void Check(bool condition,string name) { if(!condition) throw new InvalidOperationException(name); checks++; }
            try
            {
                var registry = JObject.Parse(File.ReadAllText(Path.Combine(root,"shared/motionPackages.json")));
                foreach(var item in ((JObject)registry["models"]).Properties())
                {
                    var package = JObject.Parse(File.ReadAllText(Path.Combine(root,"backend/assets/motions",item.Name+".json")));
                    var binary = File.ReadAllBytes(Path.Combine(root,"backend/assets/motions",item.Name+".glb"));
                    using var importer = new GltfImport(deferAgent:new UninterruptedDeferAgent());
                    Check(await importer.LoadGltfBinary(binary,null,new ImportSettings { NodeNameMethod = NameImportMethod.Original }),"import "+item.Name);
                    var container = new GameObject("motion_check_"+item.Name);
                    var instantiator = new GameObjectInstantiator(importer,container.transform,settings:new InstantiationSettings { SceneObjectCreation=SceneObjectCreation.Never });
                    Check(await importer.InstantiateMainSceneAsync(instantiator),"instantiate "+item.Name);
                    foreach(var clip in package["clips"].OfType<JObject>())
                    {
                        actionCount++;
                        foreach(var progress in new[]{0d,.37d,1d})
                        {
                            var clone = Object.Instantiate(container); var driver = clone.AddComponent<DeviceAnimationDriver>();
                            var binding = new JObject { ["enabled"]=true,["kind"]="clip",["mode"]=clip["mode"].DeepClone(),["clipId"]=clip["id"].DeepClone(),["sourceGroup"]="analog",["sourceKey"]="value",["pointId"]="fixture",["inputMin"]=0,["inputMax"]=1,["speed"]=1,["transitionSeconds"]=0 };
                            var device = new DeviceDto { Id="fixture", InstanceConfig=new JObject { ["animationBindings"]=new JObject { ["staleMs"]=60000,["bindings"]=new JArray(binding) } } };
                            driver.Configure(device,package); Check(driver.ActiveBindings==1,"one mapped clip");
                            var running=clip.Value<string>("mode")=="running";
                            driver.ApplyRealtime(new JObject { ["analog"]=new JObject { ["value"]=running?1:progress },["quality"]=new JObject { ["overall"]="good" } });
                            var seconds=clip.Value<double>("duration")*progress;
                            // Running clips wrap at duration; positions clamp at their endpoint.
                            driver.Advance(running?seconds:0,Time.realtimeSinceStartupAsDouble);
                            if(running&&progress==1)seconds=0;
                            var nodes=clone.GetComponentsInChildren<Transform>(true).GroupBy(n=>n.name).ToDictionary(g=>g.Key,g=>g.First());
                            foreach(var track in clip["tracks"].OfType<JObject>())
                            {
                                var n=nodes[track.Value<string>("node")]; var v=MotionSignalState.Sample(clip,track,seconds);var channel=track.Value<string>("channel");
                                if(channel=="p")Check(Vector3.Distance(n.localPosition,new Vector3(-(float)v[0],(float)v[1],(float)v[2]))<.0001f,"position parity "+item.Name+"/"+clip["id"]+"/"+n.name);
                                else if(channel=="s")Check(Vector3.Distance(n.localScale,new Vector3((float)v[0],(float)v[1],(float)v[2]))<.0001f,"scale parity "+n.name);
                                else if(channel=="q")Check(Quaternion.Angle(n.localRotation,new Quaternion((float)v[0],-(float)v[1],-(float)v[2],(float)v[3]).normalized)<.05f,"rotation parity "+n.name);
                                else if(channel=="v")Check(n.gameObject.activeSelf==(v[0]>.5),"visibility parity "+n.name);
                                else if(channel.StartsWith("c") || channel.StartsWith("e"))
                                {
                                    var slot=int.Parse(channel.Substring(1)); var renderer=n.GetComponent<Renderer>();
                                    Check(renderer!=null && slot<renderer.sharedMaterials.Length,"material renderer "+n.name);
                                    var block=new MaterialPropertyBlock(); renderer.GetPropertyBlock(block,slot);
                                    var emission=channel.StartsWith("e"); var actual=block.GetColor(emission?"emissiveFactor":"baseColorFactor");
                                    var expected=new Color((float)v[0],(float)v[1],(float)v[2],(float)v[3]);
                                    if(emission)expected=new Color(expected.r*expected.a,expected.g*expected.a,expected.b*expected.a);
                                    Check(Vector4.Distance(actual,expected)<.0001f,"material parity "+n.name+"/"+channel);
                                    Check(renderer.sharedMaterials[slot].HasProperty(emission?"emissiveFactor":"baseColorFactor"),"glTFast shader property "+n.name);
                                }
                            }
                            if(progress==.37) Capture(clone,Path.Combine(output,item.Name+"-"+clip.Value<string>("id")+".png"));
                            Object.DestroyImmediate(clone);
                        }
                    }
                    Object.DestroyImmediate(container);
                }
                ModelBindingMotionChecks.Run();
                report["success"]=true;report["checks"]=checks;report["actions"]=actionCount;
                Debug.Log($"[MotionPackageChecks] Passed {checks} native checks for {actionCount} actions");
            }
            catch(Exception exception){report["success"]=false;report["error"]=exception.ToString();Debug.LogError(exception);}
            File.WriteAllText(Path.Combine(output,"result.json"),report.ToString());
            if(Application.isBatchMode)EditorApplication.Exit(report.Value<bool>("success")?0:1);
        }
        private static void Capture(GameObject root,string path)
        {
            var renderers=root.GetComponentsInChildren<Renderer>();if(renderers.Length==0)return;
            var bounds=renderers[0].bounds;foreach(var r in renderers)bounds.Encapsulate(r.bounds);
            var owner=new GameObject("motion_capture_camera");var camera=owner.AddComponent<Camera>();var texture=new RenderTexture(960,640,24);camera.targetTexture=texture;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.14f,.17f,.22f);camera.fieldOfView=38;
            var distance=Mathf.Max(bounds.size.x,bounds.size.y,bounds.size.z)*2;owner.transform.position=bounds.center+new Vector3(1,.7f,1.2f).normalized*distance;owner.transform.LookAt(bounds.center);
            var lightOwner=new GameObject("motion_capture_light");var light=lightOwner.AddComponent<Light>();light.type=LightType.Directional;light.intensity=2;lightOwner.transform.rotation=Quaternion.Euler(45,-30,0);RenderSettings.ambientLight=new Color(.6f,.6f,.6f);
            camera.Render();var previous=RenderTexture.active;RenderTexture.active=texture;var png=new Texture2D(960,640,TextureFormat.RGB24,false);png.ReadPixels(new Rect(0,0,960,640),0,0);png.Apply();File.WriteAllBytes(path,png.EncodeToPNG());RenderTexture.active=previous;camera.targetTexture=null;Object.DestroyImmediate(png);Object.DestroyImmediate(texture);Object.DestroyImmediate(owner);Object.DestroyImmediate(lightOwner);
        }
    }
}
#endif
