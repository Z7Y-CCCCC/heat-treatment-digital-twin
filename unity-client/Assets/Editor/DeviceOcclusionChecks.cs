#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    [InitializeOnLoad]
    public static class DeviceOcclusionChecks
    {
        private const string Pending = "DeviceOcclusionChecks.Pending";
        static DeviceOcclusionChecks()
        {
            EditorApplication.playModeStateChanged += state =>
            {
                if (state != PlayModeStateChange.EnteredPlayMode || !SessionState.GetBool(Pending, false)) return;
                SessionState.SetBool(Pending, false); RunPlaying();
            };
        }
        public static void Run()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            SessionState.SetBool(Pending, true); EditorApplication.EnterPlaymode();
        }
        private static async void RunPlaying()
        {
            var directory = Environment.GetEnvironmentVariable("OCCLUSION_CHECK_DIRECTORY");
            Directory.CreateDirectory(directory); var checks = new JArray(); var report = new JObject { ["success"] = false, ["checks"] = checks };
            void Check(bool pass, string label) { if (!pass) throw new InvalidOperationException(label); checks.Add(label); }
            try
            {
                var automatic = Object.FindObjectOfType<FactoryRuntime>(); if (automatic != null) Object.DestroyImmediate(automatic.gameObject);
                var host = new GameObject("Occlusion fixture");
                var camera = new GameObject("Fixture camera").AddComponent<Camera>(); camera.aspect = 16f/9; camera.nearClipPlane = .01f; camera.farClipPlane = 200; camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.09f,.12f,.16f); camera.fieldOfView = 42;
                var light = new GameObject("Fixture light").AddComponent<Light>(); light.type = LightType.Directional; light.intensity=2; light.transform.rotation=Quaternion.Euler(45,-40,0); RenderSettings.ambientLight=Color.gray;
                var material = RuntimeShaderLibrary.CreateLitMaterial("Original shared PBR"); material.SetColor("_BaseColor", new Color(.15f,.25f,.38f,1)); material.SetFloat("_Metallic",.7f);
                Renderer Cube(string name, Vector3 position, Vector3 scale, Material source=null)
                { var cube=GameObject.CreatePrimitive(PrimitiveType.Cube);cube.name=name;cube.transform.SetParent(host.transform);cube.transform.position=position;cube.transform.localScale=scale;var renderer=cube.GetComponent<Renderer>();renderer.sharedMaterial=source??material;Object.DestroyImmediate(cube.GetComponent<Collider>());return renderer; }
                var targetMaterial = RuntimeShaderLibrary.CreateLitMaterial("Equipment PBR"); targetMaterial.SetColor("_BaseColor",Color.cyan);
                var target = Cube("selected equipment",Vector3.zero,Vector3.one*2,targetMaterial);
                var wall = Cube("wall without collider",new Vector3(0,0,-3),new Vector3(5,5,.3f));
                var side = Cube("unrelated side equipment",new Vector3(7,0,0),Vector3.one);
                var behind = Cube("behind target",new Vector3(0,0,4),new Vector3(3,3,.2f));
                var property = new MaterialPropertyBlock();property.SetColor("_EmissionColor",Color.red);wall.SetPropertyBlock(property);
                var fader = new DeviceOcclusionFader();
                camera.transform.position=new Vector3(0,.2f,-9);camera.transform.LookAt(Vector3.zero);
                Save(camera,Path.Combine(directory,"01-wall-before.png"));
                fader.SetFocus(camera,target.transform,host.transform);fader.Tick(0,1);
                Check(fader.FadedCount==1,"only the actual wall between camera and equipment fades; side and rear objects remain opaque");
                Check(wall.sharedMaterial!=material && wall.sharedMaterial.GetFloat("_Opacity")<=.026f,"obstruction uses readable faint transparency, not an opaque depth-writing floor");
                Check(target.sharedMaterial==targetMaterial && side.sharedMaterial==material && behind.sharedMaterial==material,"selected equipment and unrelated geometry retain exact source materials");
                Check(wall.shadowCastingMode==ShadowCastingMode.Off,"transparent blockers no longer cast opaque shadows onto equipment");
                Save(camera,Path.Combine(directory,"02-wall-visible.png"));
                var count=fader.OwnedMaterialCount;for(var i=1;i<=20;i++)fader.Tick(i*.04,.04f);Check(fader.OwnedMaterialCount==count,"stationary focus reuses its presentation materials");
                camera.transform.position=new Vector3(8,0,-1);camera.transform.LookAt(Vector3.zero);fader.Tick(2,1);
                Check(wall.sharedMaterial==material && fader.FadedCount==0,"camera orbit restores a wall once it is no longer in the sight line");
                wall.GetPropertyBlock(property);Check(property.GetColor("_EmissionColor")==Color.red,"PLC/material property blocks survive fading and restoration");
                camera.transform.position=new Vector3(0,0,-3);camera.transform.LookAt(Vector3.zero);fader.Tick(3,1);Check(fader.FadedCount==1,"a camera inside a wall still detects the exit surface without colliders");
                fader.SetFocus(camera,wall.transform,host.transform);Check(wall.sharedMaterial==material && fader.OwnedMaterialCount==0,"switching focus to a previously faded object restores it immediately");
                fader.Clear();Check(wall.sharedMaterial==material && fader.OwnedMaterialCount==0 && wall.shadowCastingMode==ShadowCastingMode.On,"leaving near view restores materials/shadows and releases all owned clones");
                camera.transform.position=new Vector3(0,.2f,-9);camera.transform.LookAt(Vector3.zero);var opaqueMesh=Object.Instantiate(wall.GetComponent<MeshFilter>().sharedMesh);opaqueMesh.UploadMeshData(true);wall.GetComponent<MeshFilter>().sharedMesh=opaqueMesh;
                fader.SetFocus(camera,target.transform,host.transform);fader.Tick(3.5,1);Check(fader.FadedCount==1,"non-readable imported obstructions use a conservative fade, not a hard failure");fader.Clear();
                wall.gameObject.SetActive(false);side.gameObject.SetActive(false);behind.gameObject.SetActive(false);
                // A single combined ground mesh has empty space in its AABB.
                // Exact triangles must distinguish its open pit from its wall.
                var plan=new IndustrialGroundPlan { Width=14,Depth=12,Elevation=0,Custom=true };
                plan.Areas.Add(new IndustrialGroundPlan.Area { X=0,Z=0,Width=4,Depth=4,Y=-4 });plan.Build();
                var mesh=new Mesh {name="Real industrial pit"};mesh.vertices=Enumerable.Range(0,plan.Positions.Count/3).Select(i=>new Vector3(plan.Positions[i*3],plan.Positions[i*3+1],plan.Positions[i*3+2])).ToArray();mesh.SetTriangles(plan.Indices,0);mesh.RecalculateBounds();mesh.RecalculateNormals();
                var ground=new GameObject("Industrial ground including pit walls");ground.transform.SetParent(host.transform);ground.AddComponent<MeshFilter>().sharedMesh=mesh;var floor=ground.AddComponent<MeshRenderer>();floor.sharedMaterial=material;
                target.transform.position=new Vector3(0,-2,0);target.transform.localScale=new Vector3(1.5f,2.4f,1.5f);
                camera.transform.position=new Vector3(0,7,0);camera.transform.LookAt(target.bounds.center);fader.SetFocus(camera,target.transform,host.transform);fader.Tick(4,1);
                Check(fader.FadedCount==0 && floor.sharedMaterial==material,"view through a genuine pit opening does not fade an empty bounding box");
                camera.transform.position=new Vector3(0,.5f,-7);camera.transform.LookAt(target.bounds.center);Save(camera,Path.Combine(directory,"03-pit-before.png"));fader.Tick(5,1);
                Check(fader.FadedCount==1 && floor.sharedMaterial!=material,"lower underground equipment samples identify the obstructing pit walls and floor");Save(camera,Path.Combine(directory,"04-pit-visible.png"));
                fader.Clear();
                target.transform.position=new Vector3(0,1,0);target.transform.localScale=new Vector3(1.5f,6,1.5f);camera.transform.position=new Vector3(0,3,-7);camera.transform.LookAt(target.bounds.center);
                using(var surface=new InspectionMeshSurface(floor)) { var direction=target.bounds.center-camera.transform.position;Check(!surface.Raycast(new Ray(camera.transform.position,direction.normalized),out _,null,direction.magnitude),"tall device centre is already clear above the floor"); }
                fader.SetFocus(camera,target.transform,host.transform);fader.Tick(5.5,1);Check(fader.FadedCount==1,"lower device remains visible even when a single centre ray would miss its obstruction");fader.Clear();
                // Use the actual library CAD, not only a cube surrogate.
                var fixture=JObject.Parse(File.ReadAllText(Path.Combine(directory,"fixture.json")));
                var model=fixture["model"].ToObject<ModelAssetDto>();
                var library=host.AddComponent<RuntimeModelLibrary>();library.Configure("http://127.0.0.1:1",new System.Collections.Generic.List<ModelAssetDto>{model},60);
                var device=new DeviceDto{Id="underground_cad",Name="井式炉地下近景",ModelType=model.Id,InstanceConfig=new JObject{["inspection"]=new JObject{["enabled"]=false}}};
                var loaded=await library.InstantiateAsync(device,host.transform,CancellationToken.None);Check(!loaded.IsFallback,"production CAD loaded for underground near-view render");
                target.gameObject.SetActive(false);
                Bounds BoundsOf(GameObject root){var renderers=root.GetComponentsInChildren<Renderer>();var result=renderers[0].bounds;foreach(var r in renderers)result.Encapsulate(r.bounds);return result;}
                var originalBounds=BoundsOf(loaded.Root);loaded.Root.transform.position+=new Vector3(-originalBounds.center.x,-3.7f-originalBounds.min.y,-originalBounds.center.z);
                var bounds=BoundsOf(loaded.Root);camera.transform.position=bounds.center+new Vector3(7,3.5f,-8);camera.transform.LookAt(bounds.center);
                var before=Save(camera,Path.Combine(directory,"05-cad-before.png"));
                var originals=loaded.Root.GetComponentsInChildren<Renderer>().ToDictionary(r=>r,r=>r.sharedMaterials.ToArray());
                fader.SetFocus(camera,loaded.Root.transform,host.transform);fader.Tick(6,1);
                Check(fader.FadedCount>0,"production pit mesh automatically fades in the actual CAD close-up");
                var pixels=Save(camera,Path.Combine(directory,"06-cad-visible.png"));
                var changed=pixels.Where((p,i)=>Math.Abs(p.r-before[i].r)+Math.Abs(p.g-before[i].g)+Math.Abs(p.b-before[i].b)>30).Count();Check(changed>1000,"actual native close-up pixels change substantially when the obstruction is removed");report["revealedPixels"]=changed;
                Check(originals.All(pair=>pair.Value.SequenceEqual(pair.Key.sharedMaterials)),"actual CAD PBR surfaces remain unchanged and opaque");
                // Verify the real dashboard's selected-device mode invokes this
                // same policy; overview and teardown restore the ground.
                fader.Clear();var dashboard=host.AddComponent<FactoryDashboardController>();dashboard.Initialize(camera,null,null);dashboard.RegisterDevice(device,loaded.Root,new DeviceInspectionConfigDto{Enabled=false});dashboard.FocusPreviewDevice(device.Id);
                camera.transform.position=bounds.center+new Vector3(7,3.5f,-8);camera.transform.LookAt(bounds.center);
                var late=typeof(FactoryDashboardController).GetMethod("LateUpdate",BindingFlags.Instance|BindingFlags.NonPublic);late.Invoke(dashboard,null);
                var actual=typeof(FactoryDashboardController).GetField("_occlusionFader",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(dashboard) as DeviceOcclusionFader;
                actual.Tick(20,1);Check(actual.FadedCount>0,"real dashboard device-detail mode drives the camera obstruction policy automatically");
                dashboard.ClearFactory();Check(actual.FadedCount==0 && actual.OwnedMaterialCount==0 && floor.sharedMaterial==material,"factory/selection teardown restores the exact ground material with no retained clones");
                report["success"]=true;report["cadTriangles"]=loaded.OptimizationReport?.SourceTriangles??0;
            }
            catch(Exception error){report["error"]=error.ToString();Debug.LogException(error);}
            finally{File.WriteAllText(Path.Combine(directory,"result.json"),report.ToString());EditorApplication.Exit(report.Value<bool>("success")?0:1);}
        }
        private static Color32[] Save(Camera camera,string file)
        {
            var target=RenderTexture.GetTemporary(1280,720,24);var image=new Texture2D(1280,720,TextureFormat.RGB24,false);var previous=RenderTexture.active;
            try{camera.targetTexture=target;camera.Render();RenderTexture.active=target;image.ReadPixels(new Rect(0,0,1280,720),0,0);image.Apply();File.WriteAllBytes(file,image.EncodeToPNG());return image.GetPixels32();}
            finally{camera.targetTexture=null;RenderTexture.active=previous;RenderTexture.ReleaseTemporary(target);Object.DestroyImmediate(image);}
        }
    }
}
#endif
