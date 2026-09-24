#if UNITY_EDITOR
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Runtime;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace HeatTreatment.DigitalTwin.Editor
{
    [InitializeOnLoad]
    public static class ProjectBootstrap
    {
        private const string SettingsDirectory = "Assets/Settings";
        private const string ScenesDirectory = "Assets/Scenes";
        private const string ResourcesDirectory = "Assets/Resources";
        private const string RuntimeMaterialsDirectory = ResourcesDirectory + "/RuntimeMaterials";
        private const string RendererPath = SettingsDirectory + "/DigitalTwinRenderer.asset";
        private const string PipelinePath = SettingsDirectory + "/DigitalTwinPipeline.asset";
        private const string ScenePath = ScenesDirectory + "/Factory.unity";
        private const string ApplicationIconPath = "Assets/Branding/AppIcon.png";

        static ProjectBootstrap()
        {
            EditorApplication.delayCall += AutoBootstrap;
        }

        [MenuItem("Digital Twin/Bootstrap Project", priority = 1)]
        public static void BootstrapProject()
        {
            EnsureDirectories();
            ConfigurePipeline();
            ConfigureRuntimeMaterials();
            EnsureFactoryScene();
            ConfigurePlayer();
            ConfigureBuildScenes();
            AssetDatabase.SaveAssets();
            Debug.Log("[Digital Twin] Unity project bootstrap complete.");
        }

        [MenuItem("Digital Twin/Open Factory Scene", priority = 2)]
        public static void OpenFactoryScene()
        {
            if (!File.Exists(ScenePath)) BootstrapProject();
            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        }

        [MenuItem("Digital Twin/Build Windows Client", priority = 20)]
        public static void BuildWindowsClient()
        {
            BootstrapProject();
            ValidateAuthoredHallMaterials();
            ValidateSceneShadowCoverage();
            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Standalone, BuildTarget.StandaloneWindows64);
            var buildDirectory = Path.GetFullPath("Builds/Windows");
            Directory.CreateDirectory(buildDirectory);
            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = Path.Combine(buildDirectory, "HeatTreatmentDigitalTwin.exe"),
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = BuildOptions.None
            };
            var report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new BuildFailedException($"Windows build failed: {report.summary.result}");
            }
            Debug.Log($"[Digital Twin] Windows build created: {options.locationPathName}");
            if (!Application.isBatchMode) EditorUtility.RevealInFinder(buildDirectory);
        }

        [MenuItem("Digital Twin/Validate Authored Hall Materials", priority = 19)]
        public static void ValidateAuthoredHallMaterials()
        {
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null) throw new BuildFailedException("URP Lit is required for the hall material audit.");
            var root = new GameObject("__AuthoredHallMaterialAudit") { hideFlags = HideFlags.HideAndDontSave };
            var material = new Material(shader) { name = "Hall_floor", hideFlags = HideFlags.HideAndDontSave };
            try
            {
                material.SetColor("_BaseColor", new Color(0.13f, 0.31f, 0.72f, 1f));
                material.SetFloat("_Metallic", 0.91f);
                material.SetFloat("_Smoothness", 0.17f);
                material.SetColor("_EmissionColor", new Color(0.01f, 0.03f, 0.05f, 1f));
                var originalColor = material.GetColor("_BaseColor");
                var originalEmission = material.GetColor("_EmissionColor");
                var renderer = root.AddComponent<MeshRenderer>();
                renderer.sharedMaterial = material;
                renderer.receiveShadows = false;
                renderer.shadowCastingMode = ShadowCastingMode.Off;
                var method = typeof(FactoryEnvironmentBuilder).GetMethod("ApplyFactoryHallPresentation", BindingFlags.Static | BindingFlags.NonPublic);
                if (method == null) throw new BuildFailedException("Hall material preparation entry point not found.");
                method.Invoke(null, new object[] { root });
                if (renderer.sharedMaterial != material || material.GetColor("_BaseColor") != originalColor
                    || material.GetColor("_EmissionColor") != originalEmission
                    || !Mathf.Approximately(material.GetFloat("_Metallic"), 0.91f)
                    || !Mathf.Approximately(material.GetFloat("_Smoothness"), 0.17f))
                    throw new BuildFailedException("Hall presentation overwrote or cloned an authored material.");
                if (!renderer.receiveShadows || renderer.shadowCastingMode != ShadowCastingMode.On)
                    throw new BuildFailedException("Authored hall must retain shadow participation.");
                Debug.Log("[Digital Twin] Authored hall material contract validated: no color/PBR/emission override or material clone.");
            }
            finally
            {
                Object.DestroyImmediate(root);
                Object.DestroyImmediate(material);
            }
        }

        public static void ValidateSceneShadowCoverage()
        {
            var hall = new Bounds(Vector3.zero, new Vector3(200f, 10f, 100f));
            var distance = SceneShadowCoverage.Distance(hall, new Vector3(0, 0, -250), Vector3.forward, 600, 80);
            if (distance < 377.5f || distance > 385f)
                throw new BuildFailedException("Factory shadow range must cover distant receivers and fade margin.");
            var detail = SceneShadowCoverage.Distance(new Bounds(Vector3.zero, Vector3.one * 3), new Vector3(0, 0, -8), Vector3.forward, 600, 80);
            if (detail != 80f) throw new BuildFailedException("Device detail must return to the quality profile's smaller shadow range.");
            var clipped = SceneShadowCoverage.Distance(hall, new Vector3(0, 0, -250), Vector3.forward, 200, 80);
            if (clipped != 200f) throw new BuildFailedException("Shadow range exceeded the camera far plane.");
            var behind = SceneShadowCoverage.Distance(hall, new Vector3(0, 0, 250), Vector3.forward, 600, 48);
            if (behind != 50f) throw new BuildFailedException("Off-camera bounds enlarged shadow range.");
            var rotated = SceneShadowCoverage.Distance(hall, new Vector3(-250, 0, 0), Vector3.right, 600, 80);
            if (rotated < 440f || rotated > 445f) throw new BuildFailedException("Shadow range ignored camera orientation.");
            Debug.Log("[Digital Twin] Scene shadow coverage validated: overview, detail, far clip, behind camera, rotation.");
        }

        private static void AutoBootstrap()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) return;
            if (File.Exists(ScenePath) && AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath) != null) return;
            BootstrapProject();
        }

        private static void EnsureDirectories()
        {
            if (!AssetDatabase.IsValidFolder(SettingsDirectory)) AssetDatabase.CreateFolder("Assets", "Settings");
            if (!AssetDatabase.IsValidFolder(ScenesDirectory)) AssetDatabase.CreateFolder("Assets", "Scenes");
            if (!AssetDatabase.IsValidFolder(ResourcesDirectory)) AssetDatabase.CreateFolder("Assets", "Resources");
            if (!AssetDatabase.IsValidFolder(RuntimeMaterialsDirectory))
            {
                AssetDatabase.CreateFolder(ResourcesDirectory, "RuntimeMaterials");
            }
        }

        private static void ConfigureRuntimeMaterials()
        {
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactoryLit.mat",
                "Universal Render Pipeline/Lit"
            );
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactoryUnlit.mat",
                "Universal Render Pipeline/Unlit"
            );
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactorySky.mat",
                "Skybox/Procedural"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfMetallicRoughness.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-pbrMetallicRoughness.shadergraph"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfUnlit.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-unlit.shadergraph"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfSpecularGlossiness.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-pbrSpecularGlossiness.shadergraph"
            );
        }

        private static void CreateOrUpdateMaterial(string assetPath, string shaderName)
        {
            var shader = Shader.Find(shaderName);
            if (shader == null) throw new BuildFailedException($"Required shader not found: {shaderName}");
            var material = AssetDatabase.LoadAssetAtPath<Material>(assetPath);
            if (material == null)
            {
                material = new Material(shader) { name = Path.GetFileNameWithoutExtension(assetPath) };
                AssetDatabase.CreateAsset(material, assetPath);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
            }
            material.enableInstancing = true;
            EditorUtility.SetDirty(material);
        }

        private static void CreateOrUpdatePackageMaterial(string assetPath, string shaderAssetPath)
        {
            var shader = AssetDatabase.LoadAssetAtPath<Shader>(shaderAssetPath);
            if (shader == null) throw new BuildFailedException($"Required shader asset not found: {shaderAssetPath}");
            var material = AssetDatabase.LoadAssetAtPath<Material>(assetPath);
            if (material == null)
            {
                material = new Material(shader) { name = Path.GetFileNameWithoutExtension(assetPath) };
                AssetDatabase.CreateAsset(material, assetPath);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
            }
            material.enableInstancing = true;
            EditorUtility.SetDirty(material);
        }

        private static void ConfigurePipeline()
        {
            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
            if (renderer == null || renderer.postProcessData == null)
            {
                if (renderer != null) AssetDatabase.DeleteAsset(RendererPath);
                renderer = CreateRendererAsset();
            }

            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                pipeline.name = "Digital Twin Pipeline";
                AssetDatabase.CreateAsset(pipeline, PipelinePath);
            }
            else
            {
                var serializedPipeline = new SerializedObject(pipeline);
                var rendererList = serializedPipeline.FindProperty("m_RendererDataList");
                if (rendererList != null && rendererList.arraySize > 0)
                {
                    rendererList.GetArrayElementAtIndex(0).objectReferenceValue = renderer;
                    serializedPipeline.ApplyModifiedPropertiesWithoutUndo();
                }
            }
            pipeline.renderScale = 1f;
            pipeline.msaaSampleCount = 4;
            pipeline.supportsHDR = true;
            pipeline.supportsCameraDepthTexture = true;
            pipeline.supportsCameraOpaqueTexture = false;
            pipeline.shadowDistance = 80f;
            pipeline.shadowCascadeCount = 2;

            var serializedSettings = new SerializedObject(pipeline);
            SetEnum(serializedSettings, "m_MainLightRenderingMode", (int)LightRenderingMode.PerPixel);
            SetEnum(serializedSettings, "m_AdditionalLightsRenderingMode", (int)LightRenderingMode.PerPixel);
            SetBool(serializedSettings, "m_MainLightShadowsSupported", true);
            SetBool(serializedSettings, "m_AdditionalLightShadowsSupported", true);
            SetBool(serializedSettings, "m_SoftShadowsSupported", true);
            SetEnum(serializedSettings, "m_MainLightShadowmapResolution", 2048);
            SetEnum(serializedSettings, "m_AdditionalLightsShadowmapResolution", 1024);
            serializedSettings.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(pipeline);

            GraphicsSettings.defaultRenderPipeline = pipeline;
            QualitySettings.renderPipeline = pipeline;
        }

        private static UniversalRendererData CreateRendererAsset()
        {
            var method = typeof(UniversalRenderPipelineAsset).GetMethod(
                "CreateRendererAsset",
                BindingFlags.Static | BindingFlags.NonPublic
            );
            if (method != null)
            {
                var created = method.Invoke(null, new object[]
                {
                    RendererPath,
                    RendererType.UniversalRenderer,
                    false,
                    "Renderer"
                }) as UniversalRendererData;
                if (created != null)
                {
                    created.name = "Digital Twin Renderer";
                    EditorUtility.SetDirty(created);
                    return created;
                }
            }

            var fallback = ScriptableObject.CreateInstance<UniversalRendererData>();
            fallback.name = "Digital Twin Renderer";
            AssetDatabase.CreateAsset(fallback, RendererPath);
            return fallback;
        }

        private static void EnsureFactoryScene()
        {
            if (File.Exists(ScenePath)) return;
            var previousActive = SceneManager.GetActiveScene();
            var replaceUntitledScene = previousActive.IsValid() && string.IsNullOrEmpty(previousActive.path);
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene,
                replaceUntitledScene ? NewSceneMode.Single : NewSceneMode.Additive
            );
            SceneManager.SetActiveScene(scene);
            var runtime = new GameObject("DigitalTwinRuntime");
            runtime.AddComponent<FactoryRuntime>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            if (!replaceUntitledScene)
            {
                if (previousActive.IsValid()) SceneManager.SetActiveScene(previousActive);
                EditorSceneManager.CloseScene(scene, true);
            }
        }

        private static void ConfigurePlayer()
        {
            PlayerSettings.companyName = "Heat Treatment Digital Twin";
            PlayerSettings.productName = "Heat Treatment Digital Twin";
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.fullScreenMode = FullScreenMode.FullScreenWindow;
            PlayerSettings.defaultScreenWidth = 1920;
            PlayerSettings.defaultScreenHeight = 1080;
            PlayerSettings.defaultIsNativeResolution = true;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.usePlayerLog = true;
            var applicationIcon = AssetDatabase.LoadAssetAtPath<Texture2D>(ApplicationIconPath);
            if (applicationIcon != null)
            {
                var iconSizes = PlayerSettings.GetIconSizesForTargetGroup(BuildTargetGroup.Standalone);
                var applicationIcons = new Texture2D[iconSizes.Length];
                for (var index = 0; index < applicationIcons.Length; index++)
                {
                    applicationIcons[index] = applicationIcon;
                }
                PlayerSettings.SetIconsForTargetGroup(BuildTargetGroup.Standalone, applicationIcons);
            }
            else
            {
                Debug.LogWarning($"[Digital Twin] Application icon not found: {ApplicationIconPath}");
            }
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.StandaloneWindows64, new[] { GraphicsDeviceType.Direct3D11 });
        }

        private static void ConfigureBuildScenes()
        {
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        private static void SetBool(SerializedObject serializedObject, string propertyName, bool value)
        {
            var property = serializedObject.FindProperty(propertyName);
            if (property != null) property.boolValue = value;
        }

        private static void SetEnum(SerializedObject serializedObject, string propertyName, int value)
        {
            var property = serializedObject.FindProperty(propertyName);
            if (property != null) property.intValue = value;
        }
    }
}
#endif
