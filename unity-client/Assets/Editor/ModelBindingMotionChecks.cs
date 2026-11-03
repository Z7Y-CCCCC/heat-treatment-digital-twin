#if UNITY_EDITOR
using System;
using System.IO;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class ModelBindingMotionChecks
    {
        public static void Run()
        {
            var scene = EditorSceneManager.NewPreviewScene();
            var checks = 0;
            void Near(float actual, float expected, string name)
            {
                if (Mathf.Abs(actual - expected) > .001f) throw new Exception($"{name}: {actual} != {expected}");
                checks++;
            }
            (ModelBindingDriver, Transform) Create(PartBindingDto binding)
            {
                var root = new GameObject("MotionChecks"); SceneManager.MoveGameObjectToScene(root, scene);
                var part = new GameObject("part"); part.transform.SetParent(root.transform, false);
                part.transform.localPosition = new Vector3(1, 2, 3);
                binding.NodeName = "part"; binding.SourceKey = "value"; binding.SourceGroup = "doors";
                var driver = root.AddComponent<ModelBindingDriver>(); driver.Configure(new[] { binding });
                return (driver, part.transform);
            }
            JObject Frame(JToken value, string quality = "good") => new JObject {
                ["doors"] = new JObject { ["value"] = value },
                ["quality"] = new JObject { ["doors"] = new JObject { ["value"] = quality } }
            };
            try
            {
                var (door, part) = Create(new PartBindingDto { Action = "translate", InputMax = 1, OutputMax = 2, TransitionDuration = 2 });
                door.ApplyRealtime(Frame(false)); Near(part.localPosition.y, 2, "initial closed pose");
                door.ApplyRealtime(Frame(true)); door.AdvanceMotion(.5f); Near(part.localPosition.y, 2.5f, "opening halfway through first second");
                door.ApplyRealtime(Frame(true)); door.AdvanceMotion(.5f); Near(part.localPosition.y, 3, "duplicate sample does not restart");
                door.ApplyRealtime(Frame(false)); door.AdvanceMotion(.25f); Near(part.localPosition.y, 2.75f, "reverse from current pose");
                door.ApplyRealtime(Frame(true, "bad")); door.AdvanceMotion(5); Near(part.localPosition.y, 2.75f, "bad quality freezes pose");
                door.ApplyRealtime(Frame("not-a-number")); door.AdvanceMotion(5); Near(part.localPosition.y, 2.75f, "invalid number freezes pose");
                door.ApplyRealtime(Frame(true)); door.AdvanceMotion(10); Near(part.localPosition.y, 4, "recover and clamp at open endpoint");
                door.ApplyRealtime(Frame(false, "stale")); door.AdvanceMotion(10); Near(part.localPosition.y, 4, "stale quality freezes pose");
                var offline = Frame(false); offline["status"] = new JObject { ["online"] = false };
                door.ApplyRealtime(offline); door.AdvanceMotion(10); Near(part.localPosition.y, 4, "offline freezes pose");
                var unrelated = Frame(false); unrelated["quality"]["analog"] = new JObject { ["temperature"] = "bad" };
                door.ApplyRealtime(unrelated); door.AdvanceMotion(10); Near(part.localPosition.y, 2, "unrelated bad point does not block door");
                var (initialOpen, openPart) = Create(new PartBindingDto { Action = "translate", InputMax = 1, OutputMax = 2, TransitionDuration = 2 });
                initialOpen.ApplyRealtime(Frame(true)); Near(openPart.localPosition.y, 4, "initial open observation snaps without fictitious motion");
                var (continuous, measured) = Create(new PartBindingDto { Action = "translate", InputMax = 100, OutputMax = 2 });
                continuous.ApplyRealtime(Frame(25)); Near(measured.localPosition.y, 2.5f, "continuous quarter travel");
                continuous.ApplyRealtime(Frame(75)); Near(measured.localPosition.y, 3.5f, "continuous feedback follows immediately");
                var (valve, spindle) = Create(new PartBindingDto { Action = "rotate_angle", InputMax = 1, OutputMax = 90, TransitionDuration = 1 });
                valve.ApplyRealtime(Frame(false)); valve.ApplyRealtime(Frame(true)); valve.AdvanceMotion(.5f);
                Near(Quaternion.Angle(Quaternion.identity, spindle.localRotation), 45, "valve halfway angle");
                var (material, tray) = Create(new PartBindingDto { Action = "visibility" });
                material.ApplyRealtime(Frame(false)); Near(tray.gameObject.activeSelf ? 1 : 0, 0, "no load hidden");
                material.ApplyRealtime(Frame(true)); Near(tray.gameObject.activeSelf ? 1 : 0, 1, "load visible");
                var (fan, rotor) = Create(new PartBindingDto { Action = "rotate_speed" });
                fan.ApplyRealtime(Frame(60)); fan.AdvanceMotion(.1f);
                var rotation = rotor.localRotation;
                if (Quaternion.Angle(Quaternion.identity, rotation) < 1) throw new Exception("fan must rotate");
                fan.ApplyRealtime(Frame(60, "bad")); fan.AdvanceMotion(1);
                Near(Quaternion.Angle(rotation, rotor.localRotation), 0, "bad speed quality stops fan");
                var (webTranslate, webPart) = Create(new PartBindingDto { Action="translate",Axis="x",InputMax=1,OutputMax=2,AuthoringSpace=true,PointId="42" });
                webTranslate.ApplyRealtime(Frame(1)); Near(webPart.localPosition.x,-1,"glTF authored X translation is mirrored exactly once");
                var wrongPoint=Frame(0); wrongPoint["pointMeta"]=new JObject { ["doors.value"]=new JObject { ["id"]="other" } };
                webTranslate.ApplyRealtime(wrongPoint);Near(webPart.localPosition.x,-1,"explicit point identity mismatch freezes pose");
                webTranslate.ApplyRealtime(new JObject { ["analog"]=new JObject { ["value"]=0 } });Near(webPart.localPosition.x,-1,"explicit assignment never falls through to another source group");
                var (webRotation, webSpindle) = Create(new PartBindingDto { Action="rotate_angle",Axis="y",InputMax=1,OutputMax=90,AuthoringSpace=true });
                webRotation.ApplyRealtime(Frame(1));Near(Quaternion.Angle(webSpindle.localRotation,Quaternion.AngleAxis(-90,Vector3.up)),0,"glTF authored Y rotation is mirrored");
                var (webVisibility, webVisiblePart) = Create(new PartBindingDto { Action="visibility",InputMax=100,AuthoringSpace=true });
                webVisibility.ApplyRealtime(Frame(25));Near(webVisiblePart.gameObject.activeSelf?1:0,0,"visibility respects configured input range");
                webVisibility.ApplyRealtime(Frame(75));Near(webVisiblePart.gameObject.activeSelf?1:0,1,"visibility crosses configured midpoint");
                var (webColor, webColorPart) = Create(new PartBindingDto { Action="color",InputMax=100,AuthoringSpace=true,OnColor="#ffffff",OffColor="#808080" });
                var mesh=GameObject.CreatePrimitive(PrimitiveType.Cube);mesh.transform.SetParent(webColorPart,false);
                webColor.ApplyRealtime(Frame(25));var colorBlock=new MaterialPropertyBlock();mesh.GetComponent<Renderer>().GetPropertyBlock(colorBlock);
                var expectedGray=QualitySettings.activeColorSpace==ColorSpace.Linear?new Color(128f/255,128f/255,128f/255).linear.r:128f/255;
                Near(colorBlock.GetColor("baseColorFactor").r,expectedGray,"color input mapping and Three linear color parity");
                webColor.ApplyRealtime(Frame(75));mesh.GetComponent<Renderer>().GetPropertyBlock(colorBlock);Near(colorBlock.GetColor("baseColorFactor").r,1,"color activates above midpoint");
                var output = Path.GetFullPath(Path.Combine(Application.dataPath, "../../output"));
                Directory.CreateDirectory(output);
                File.WriteAllText(Path.Combine(output, "model-binding-motion-checks.json"), new JObject { ["status"] = "passed", ["checks"] = checks }.ToString());
                Debug.Log($"[ModelBindingMotionChecks] Passed {checks} transform checks");
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
        }
    }
}
#endif
