#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using GLTFast;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering.Universal;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class InspectionOutlineChecks
    {
        public static async void RunCad()
        {
            var directory = Path.GetFullPath(Path.Combine(Application.dataPath, "../../output/inspection-outline-render"));
            GltfImport importer = null; GameObject root = null, cameraObject = null; Camera camera = null; Material material = null;
            var surfaces = new System.Collections.Generic.List<InspectionMeshSurface>();
            try
            {
                Run();
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                importer = new GltfImport(deferAgent: new UninterruptedDeferAgent());
                root = new GameObject("Actual multipurpose CAD");
                var asset = Path.GetFullPath(Path.Combine(Application.dataPath,"../../backend/assets/models/photo_multipurpose_furnace_v6_pipefix.glb"));
                if (!await importer.Load(new Uri(asset).AbsoluteUri)) throw new Exception("Actual CAD GLB load failed");
                if (!await importer.InstantiateMainSceneAsync(root.transform)) throw new Exception("Actual CAD instantiation failed");
                var renderers = root.GetComponentsInChildren<Renderer>();
                var selected = renderers.Where(r => r.GetComponentsInParent<Transform>().Any(t => System.Text.RegularExpressions.Regex.IsMatch(t.name,"motor|fan|pump|drive",System.Text.RegularExpressions.RegexOptions.IgnoreCase))).ToArray();
                if (selected.Length < 3) throw new Exception("Actual CAD drive group not found");
                var bounds = renderers[0].bounds; foreach(var renderer in renderers)bounds.Encapsulate(renderer.bounds);
                cameraObject = new GameObject("actual CAD camera"); camera = cameraObject.AddComponent<Camera>();
                camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.08f,.09f,.11f);camera.nearClipPlane=.01f;camera.farClipPlane=1000;
                camera.orthographic=true;camera.orthographicSize=bounds.size.magnitude*.42f;
                camera.transform.position=bounds.center+new Vector3(1,.5f,-1).normalized*bounds.size.magnitude*1.8f;camera.transform.LookAt(bounds.center);
                var lightObject=new GameObject("CAD light");var light=lightObject.AddComponent<Light>();light.type=LightType.Directional;light.intensity=1.4f;lightObject.transform.rotation=Quaternion.Euler(45,-30,0);
                RenderSettings.ambientLight=Color.gray;camera.GetUniversalAdditionalCameraData().renderPostProcessing=false;
                Color32[] Save(string name){var target=RenderTexture.GetTemporary(1000,760,24);var previous=RenderTexture.active;var image=new Texture2D(1000,760,TextureFormat.RGB24,false);try{camera.targetTexture=target;camera.Render();RenderTexture.active=target;image.ReadPixels(new Rect(0,0,1000,760),0,0);image.Apply();File.WriteAllBytes(Path.Combine(directory,name+".png"),image.EncodeToPNG());return image.GetPixels32();}finally{camera.targetTexture=null;RenderTexture.active=previous;RenderTexture.ReleaseTemporary(target);Object.DestroyImmediate(image);}}
                var baseline=Save("06-actual-cad-baseline");
                material=new Material(Resources.Load<Shader>("RuntimeShaders/InspectionOutline"));InspectionOutlineRenderer.Begin(camera);
                foreach(var renderer in selected){var surface=new InspectionMeshSurface(renderer);surfaces.Add(surface);surface.DrawOutline(material,camera,new Color(.72f,.78f,1,.95f),2);}
                var highlighted=Save("07-actual-cad-part-edges");var changed=0;
                for(var i=0;i<highlighted.Length;i++)if(Math.Abs(highlighted[i].r-baseline[i].r)+Math.Abs(highlighted[i].g-baseline[i].g)+Math.Abs(highlighted[i].b-baseline[i].b)>20)changed++;
                if(changed<50||changed>highlighted.Length/20)throw new Exception("Actual CAD outline missing or fills too much of the image: "+changed);
                File.WriteAllText(Path.Combine(directory,"cad-result.json"),"{\"success\":true,\"selectedMeshes\":"+selected.Length+",\"changedPixels\":"+changed+"}");
                Debug.Log("[OutlineChecks] PASS actual CAD multi-mesh drive group has narrow combined edges: "+changed+" pixels");
                EditorApplication.Exit(0);
            }
            catch(Exception error){Debug.LogException(error);EditorApplication.Exit(1);}
            finally{InspectionOutlineRenderer.Release(camera);foreach(var surface in surfaces)surface.Dispose();if(root!=null)Object.DestroyImmediate(root);if(cameraObject!=null)Object.DestroyImmediate(cameraObject);if(material!=null)Object.DestroyImmediate(material);importer?.Dispose();}
        }
        public static void Run()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var directory = Path.GetFullPath(Path.Combine(Application.dataPath, "../../output/inspection-outline-render"));
            Directory.CreateDirectory(directory);
            var cameraObject = new GameObject("outline camera"); var camera = cameraObject.AddComponent<Camera>();
            camera.orthographic = true; camera.orthographicSize = 2; camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.08f,.09f,.11f); camera.transform.position = new Vector3(0, 0, -5);
            camera.GetUniversalAdditionalCameraData().renderPostProcessing = false;
            var target = GameObject.CreatePrimitive(PrimitiveType.Cube); target.name = "transparent CAD shell";
            var shell = new Material(Resources.Load<Shader>("RuntimeShaders/InspectionShell"));
            shell.SetFloat("_Opacity", .2f); shell.SetFloat("_ZWrite", 0); shell.SetColor("_BaseColor", Color.gray);
            shell.renderQueue = 3000; target.GetComponent<Renderer>().sharedMaterial = shell;
            var material = new Material(Resources.Load<Shader>("RuntimeShaders/InspectionOutline"));
            var surface = new InspectionMeshSurface(target.GetComponent<Renderer>());
            var checks = 0;
            void Check(bool passed, string label) { if (!passed) throw new Exception(label); checks++; Debug.Log("[OutlineChecks] PASS " + label); }
            Color32[] Save(string name)
            {
                var rt = RenderTexture.GetTemporary(640, 480, 24); var previous = RenderTexture.active;
                var image = new Texture2D(640,480,TextureFormat.RGB24,false);
                try { camera.targetTexture = rt; camera.Render(); RenderTexture.active = rt; image.ReadPixels(new Rect(0,0,640,480),0,0); image.Apply(); File.WriteAllBytes(Path.Combine(directory,name+".png"),image.EncodeToPNG()); return image.GetPixels32(); }
                finally { camera.targetTexture = null; RenderTexture.active = previous; RenderTexture.ReleaseTemporary(rt); Object.DestroyImmediate(image); }
            }
            int Difference(Color32 a, Color32 b) => Math.Abs(a.r-b.r)+Math.Abs(a.g-b.g)+Math.Abs(a.b-b.b);
            try
            {
                Check(material.shader.isSupported && material.passCount == 2, "mask and outside-only shader passes supported by native graphics device");
                var baseline = Save("01-transparent-baseline");
                InspectionOutlineRenderer.Begin(camera); surface.DrawOutline(material,camera,Color.cyan,2);
                var hover = Save("02-transparent-outline");
                var interiorChanges = 0; var ringPixels = 0;
                for (var y=0;y<480;y++) for(var x=0;x<640;x++) {
                    if(Difference(hover[y*640+x],baseline[y*640+x])<=15)continue;
                    ringPixels++;
                    if(x>270&&x<370&&y>190&&y<290)interiorChanges++;
                }
                Check(ringPixels>150 && ringPixels<2500,"transparent shell has a narrow visible edge, not a filled surface");
                Check(interiorChanges==0,"transparent CAD surface interior is unchanged by hover");
                Check(target.GetComponent<Renderer>().sharedMaterial==shell && shell.GetFloat("_ZWrite")==0,"original alpha and PLC material remain untouched");
                InspectionOutlineRenderer.Begin(camera);
                var cleared = Save("03-hover-cleared"); var changed=0;
                for(var i=0;i<cleared.Length;i++)if(Difference(cleared[i],baseline[i])>15)changed++;
                Check(changed==0,"pointer leave clears every outline pixel");
                var blocker=GameObject.CreatePrimitive(PrimitiveType.Cube); blocker.transform.position=new Vector3(0,0,-1); blocker.transform.localScale=new Vector3(2,2,.2f);
                var opaque=new Material(Shader.Find("Universal Render Pipeline/Unlit")); opaque.SetColor("_BaseColor",Color.gray); blocker.GetComponent<Renderer>().sharedMaterial=opaque;
                var blocked=Save("04-opaque-blocker");
                InspectionOutlineRenderer.Begin(camera);surface.DrawOutline(material,camera,Color.cyan,2);
                var hidden=Save("05-no-outline-through-solid");changed=0;
                for(var i=0;i<hidden.Length;i++)if(Difference(hidden[i],blocked[i])>15)changed++;
                Check(changed==0,"unrelated solid foreground does not receive a see-through outline");
                Object.DestroyImmediate(blocker);Object.DestroyImmediate(opaque);
                File.WriteAllText(Path.Combine(directory,"result.json"),"{\"success\":true,\"checks\":"+checks+",\"ringPixels\":"+ringPixels+",\"interiorChanges\":"+interiorChanges+"}");
            }
            finally { InspectionOutlineRenderer.Release(camera);surface.Dispose();Object.DestroyImmediate(target);Object.DestroyImmediate(shell);Object.DestroyImmediate(material);Object.DestroyImmediate(cameraObject); }
        }
    }
}
#endif
