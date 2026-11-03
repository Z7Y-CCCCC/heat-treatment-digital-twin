#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace HeatTreatment.DigitalTwin.Editor
{
    /// <summary>
    /// Imports five independent reference-derived pit-furnace studies, each with its own prefab and review scene.
    /// Does not alter the factory scene, build settings, render pipeline, or older equipment.
    /// Run with -executeMethod HeatTreatment.DigitalTwin.Editor.PitFurnaceReferenceImport.Build.
    /// </summary>
    public static class PitFurnaceReferenceImport
    {
        private const int FurnaceCount = 5;
        private const string OverviewDirectory = "Assets/Equipment/PitFurnaceReferences";
        private const string OverviewScenePath = OverviewDirectory + "/PitFurnacesOverview.unity";
        private const string OverviewReportPath = OverviewDirectory + "/overview-verification.json";
        private const string OverviewPreviewPath = OverviewDirectory + "/overview-preview.png";
        private const string OverviewMaterialsPath = OverviewDirectory + "/OverviewMaterials";
        private const string ImportReadmePath = OverviewDirectory + "/README_Import.txt";
        private const string ImportScriptPath = "Assets/Editor/PitFurnaceReferenceImport.cs";

        private sealed class AssetPaths
        {
            public readonly int Index;
            public readonly string DirectoryPath;
            public readonly string ModelPath;
            public readonly string PalettePath;
            public readonly string PrefabPath;
            public readonly string ScenePath;
            public readonly string ReportPath;
            public readonly string PreviewPath;
            public readonly string RootName;

            public AssetPaths(int index)
            {
                if (index < 1 || index > FurnaceCount) throw new ArgumentOutOfRangeException(nameof(index), "Choose independent furnace 1 through 5.");
                Index = index;
                DirectoryPath = "Assets/Equipment/PitFurnaceReferences/PitFurnace" + index;
                var stem = "pit_furnace_" + index + "_v1";
                ModelPath = DirectoryPath + "/" + stem + ".fbx";
                PalettePath = DirectoryPath + "/palette.json";
                PrefabPath = DirectoryPath + "/" + stem + ".prefab";
                ScenePath = DirectoryPath + "/PitFurnace" + index + "Review.unity";
                ReportPath = DirectoryPath + "/verification.json";
                PreviewPath = DirectoryPath + "/unity-preview.png";
                RootName = stem + "_root";
            }
        }

        [Serializable]
        private sealed class Palette
        {
            public MaterialDefinition[] materials;
        }

        [Serializable]
        private sealed class MaterialDefinition
        {
            public string name;
            public float[] color;
            public float metallic;
            public float roughness;
            public float emission;
        }

        [Serializable]
        private sealed class Verification
        {
            public string status;
            public string generatedUtc;
            public string unityVersion;
            public int furnaceIndex;
            public string displayName;
            public string model;
            public string modelSha256;
            public string prefab;
            public string reviewScene;
            public string dimensionalAccuracy = "Photo-derived proportions; not measured engineering CAD.";
            public string materialSource = "Existing multipurpose furnace V6 palette; linear Blender RGB converted to Unity material sRGB.";
            public Vector3 boundsCenter;
            public Vector3 boundsSize;
            public Vector3 boundsMin;
            public Vector3 boundsMax;
            public int rendererCount;
            public int transformCount;
            public int uniqueMeshCount;
            public long instanceTriangles;
            public long uniqueMeshTriangles;
            public int materialCount;
            public int missingMaterialSlots;
            public int missingMeshes;
            public int meshesWithoutNormals;
            public string[] materialNames;
            public string[] directChildGroups;
            public string[] errors;
            public string graphicsDevice;
            public bool previewRendered;
            public string previewPath;
            public string previewStatus;
        }

        [MenuItem("Digital Twin/Pit Furnace References/Import All Five", priority = 60)]
        public static void Build()
        {
            // Confirm the final five-device input set before starting an all-device import.
            for (var index = 1; index <= FurnaceCount; index++)
            {
                var asset = new AssetPaths(index);
                if (!File.Exists(asset.ModelPath)) throw new FileNotFoundException("Equipment FBX has not been generated.", asset.ModelPath);
                if (!File.Exists(asset.PalettePath)) throw new FileNotFoundException("The furnace-derived material palette is required.", asset.PalettePath);
            }
            for (var index = 1; index <= FurnaceCount; index++)
            {
                BuildOne(index);
                // Do not superimpose different devices in one editor view.
                if (index < FurnaceCount)
                {
                    var completedScene = SceneManager.GetSceneByPath(new AssetPaths(index).ScenePath);
                    if (SceneManager.sceneCount > 1 && completedScene.IsValid() && completedScene.isLoaded && !completedScene.isDirty)
                        EditorSceneManager.CloseScene(completedScene, true);
                }
            }
            BuildOverview();
            ExportPackage();
            Debug.Log("[PitFurnaceReference] SUCCESS | all 5 independent furnace prefabs, review scenes, overview, and import package created");
        }

        [MenuItem("Digital Twin/Pit Furnace References/Import Furnace 1", priority = 61)]
        public static void BuildFurnace1() { BuildOne(1); }

        [MenuItem("Digital Twin/Pit Furnace References/Import Furnace 2", priority = 62)]
        public static void BuildFurnace2() { BuildOne(2); }

        [MenuItem("Digital Twin/Pit Furnace References/Import Furnace 3", priority = 63)]
        public static void BuildFurnace3() { BuildOne(3); }

        [MenuItem("Digital Twin/Pit Furnace References/Import Furnace 4", priority = 64)]
        public static void BuildFurnace4() { BuildOne(4); }

        [MenuItem("Digital Twin/Pit Furnace References/Import Furnace 5", priority = 65)]
        public static void BuildFurnace5() { BuildOne(5); }

        // Refresh evidence from the existing prefabs/scenes. Never regenerate
        // geometry, materials, prefabs, identifiers or factory scene settings.
        public static void VerifyCurrentAndExport()
        {
            for (var index = 1; index <= FurnaceCount; index++)
            {
                var asset = new AssetPaths(index);
                var scene = EditorSceneManager.OpenScene(asset.ScenePath, OpenSceneMode.Single);
                var root = scene.GetRootGameObjects().FirstOrDefault(item => item.name == asset.RootName);
                if (root == null) throw new InvalidDataException("Missing review equipment: " + asset.RootName);
                var camera = scene.GetRootGameObjects().SelectMany(item => item.GetComponentsInChildren<Camera>(true)).FirstOrDefault();
                if (camera == null) throw new InvalidDataException("Missing review camera: " + asset.ScenePath);
                var report = Inspect(asset, root);
                using (var digest = System.Security.Cryptography.SHA256.Create())
                    report.modelSha256 = BitConverter.ToString(digest.ComputeHash(File.ReadAllBytes(asset.ModelPath))).Replace("-", "").ToLowerInvariant();
                CapturePreview(asset, camera, report);
                if (report.errors.Length != 0 || !report.previewRendered) throw new InvalidDataException("Review verification failed: " + asset.ModelPath);
                report.status = "passed";
                WriteReport(asset, report);
            }
            ExportPackage();
            Debug.Log("[PitFurnaceReference] SUCCESS | current prefabs verified/rendered and package exported; geometry unchanged");
        }

        [Serializable]
        private sealed class OverviewPlacement
        {
            public int index;
            public string name;
            public string prefab;
            public Vector3 position;
            public Vector3 boundsMin;
            public Vector3 boundsMax;
        }

        [Serializable]
        private sealed class OverviewVerification
        {
            public string status = "passed";
            public string scene = OverviewScenePath;
            public string units = "meters; source prefab scale and rotations preserved";
            public string ordering = "井式炉1, 井式炉2, 井式炉3, 井式炉4, 井式炉5; left to right";
            public float minimumGap;
            public bool nonOverlapping;
            public Vector3 boundsCenter;
            public Vector3 boundsSize;
            public OverviewPlacement[] furnaces;
            public bool previewRendered;
            public string previewPath;
            public string previewStatus;
        }

        [MenuItem("Digital Twin/Pit Furnace References/Build Five-Furnace Overview", priority = 70)]
        public static void BuildOverview()
        {
            var prefabs = new GameObject[FurnaceCount];
            for (var index = 1; index <= FurnaceCount; index++)
            {
                var asset = new AssetPaths(index);
                prefabs[index - 1] = AssetDatabase.LoadAssetAtPath<GameObject>(asset.PrefabPath);
                if (prefabs[index - 1] == null) throw new FileNotFoundException("Import all five furnace prefabs before building the overview.", asset.PrefabPath);
            }
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null) throw new InvalidOperationException("The overview requires URP Lit.");
            var ownedScenePaths = Enumerable.Range(1, FurnaceCount).Select(index => new AssetPaths(index).ScenePath)
                .Concat(new[] { OverviewScenePath }).ToArray();
            // Never discard a user's unsaved review edits. Factory and unrelated scenes stay untouched.
            foreach (var path in ownedScenePaths)
            {
                var open = SceneManager.GetSceneByPath(path);
                if (open.IsValid() && open.isLoaded && open.isDirty)
                    throw new InvalidOperationException("Save the modified furnace review scene before rebuilding the overview: " + path);
            }
            var previousActive = SceneManager.GetActiveScene();
            var scene = CreateEmptyReviewScene();
            SceneManager.SetActiveScene(scene);
            foreach (var path in ownedScenePaths)
            {
                var open = SceneManager.GetSceneByPath(path);
                if (open.IsValid() && open.isLoaded) EditorSceneManager.CloseScene(open, true);
            }
            try
            {
                var overviewRoot = new GameObject("井式炉1至5_独立设备总览");
                var instances = new GameObject[FurnaceCount];
                var placements = new OverviewPlacement[FurnaceCount];
                const float gap = 1.5f;
                var cursor = 0f;
                for (var index = 1; index <= FurnaceCount; index++)
                {
                    var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefabs[index - 1], scene);
                    instance.name = "井式炉" + index;
                    instance.transform.SetParent(overviewRoot.transform, true);
                    var bounds = EquipmentBounds(instance);
                    // The CAD front is +Z after FBX import. From that camera, screen-right is -X.
                    // Lay out decreasing world X so the visible order remains furnace 1 through 5.
                    instance.transform.position += new Vector3(cursor - bounds.max.x, -bounds.min.y, -bounds.center.z);
                    bounds = EquipmentBounds(instance);
                    cursor = bounds.min.x - gap;
                    instances[index - 1] = instance;
                    placements[index - 1] = new OverviewPlacement
                    {
                        index = index, name = instance.name, prefab = new AssetPaths(index).PrefabPath
                    };
                }
                var totalWidth = -cursor - gap;
                for (var index = 0; index < FurnaceCount; index++)
                {
                    instances[index].transform.position += Vector3.right * totalWidth * .5f;
                    var bounds = EquipmentBounds(instances[index]);
                    placements[index].position = instances[index].transform.position;
                    placements[index].boundsMin = bounds.min;
                    placements[index].boundsMax = bounds.max;
                    PrefabUtility.RecordPrefabInstancePropertyModifications(instances[index].transform);
                    PrefabUtility.RecordPrefabInstancePropertyModifications(instances[index]);
                }
                var nonOverlapping = true;
                var measuredGap = float.PositiveInfinity;
                for (var index = 1; index < FurnaceCount; index++)
                {
                    var separation = placements[index - 1].boundsMin.x - placements[index].boundsMax.x;
                    measuredGap = Mathf.Min(measuredGap, separation);
                    nonOverlapping &= separation >= gap - .001f;
                }
                if (!nonOverlapping) throw new InvalidDataException("Overview placement overlaps; the independent devices were not saved.");
                var combinedBounds = EquipmentBounds(overviewRoot);
                var camera = CreateOverviewStage(combinedBounds, shader);
                if (!EditorSceneManager.SaveScene(scene, OverviewScenePath)) throw new IOException("Unable to save the independent five-furnace overview scene.");
                var report = new OverviewVerification
                {
                    minimumGap = measuredGap,
                    nonOverlapping = nonOverlapping,
                    boundsCenter = combinedBounds.center,
                    boundsSize = combinedBounds.size,
                    furnaces = placements
                };
                // Match the saved wide viewport's 25:9 aspect without letterboxing the delivered PNG.
                var preview = CapturePreview(camera, OverviewPreviewPath, 54, 2800, 1008);
                report.previewRendered = preview.rendered;
                report.previewPath = preview.path;
                report.previewStatus = preview.status;
                File.WriteAllText(OverviewReportPath, JsonUtility.ToJson(report, true));
                File.WriteAllText(ImportReadmePath,
                    "井式炉参考模型 1–5\n\n" +
                    "环境要求：Unity 2022.3 LTS，Universal Render Pipeline (URP) 14.x。导入包不含 URP 包、Factory 场景或项目设置。\n" +
                    "将 unitypackage 导入已配置 URP 的项目，打开 Assets/Equipment/PitFurnaceReferences/PitFurnacesOverview.unity 查看五台独立设备。\n" +
                    "五个 PitFurnace1–5 文件夹各含独立 FBX、Prefab、材质、单台审阅场景和验证报告。所有模型保持米制估算比例，不代表实测工程 CAD。\n" +
                    "井式炉1–4可选中实例或子物体，通过 Digital Twin > Pit Furnace References > Toggle Selected Furnace External Covers 切换外盖。支持撤销，不改源 Prefab。井式炉5为完整厚柜式炉体，保留侧壁、后壁、顶底及正面机构，不作为独立门板。\n" +
                    "总览从左到右为井式炉1–5，设备之间至少间隔1.5米；没有把五台拼成一台。\n" +
                    "批量重建入口：HeatTreatment.DigitalTwin.Editor.PitFurnaceReferenceImport.Build。\n");
                AssetDatabase.SaveAssets();
                AssetDatabase.ImportAsset(OverviewReportPath, ImportAssetOptions.ForceSynchronousImport);
                AssetDatabase.ImportAsset(ImportReadmePath, ImportAssetOptions.ForceSynchronousImport);
                if (preview.rendered) AssetDatabase.ImportAsset(OverviewPreviewPath, ImportAssetOptions.ForceSynchronousImport);
                Selection.activeGameObject = overviewRoot;
                if (SceneView.lastActiveSceneView != null)
                {
                    SceneView.lastActiveSceneView.rotation = camera.transform.rotation;
                    SceneView.lastActiveSceneView.Frame(combinedBounds, true);
                    SceneView.lastActiveSceneView.Repaint();
                }
                Debug.Log("[PitFurnaceReference] SUCCESS | overview=" + OverviewScenePath + " | independent prefabs=5 | minimum gap=" + measuredGap);
            }
            catch
            {
                if (previousActive.IsValid() && previousActive.isLoaded) SceneManager.SetActiveScene(previousActive);
                throw;
            }
        }

        [MenuItem("Digital Twin/Pit Furnace References/Export Import Package", priority = 75)]
        public static void ExportPackage()
        {
            // Explicitly scoped paths and Recurse ONLY. IncludeDependencies would pull in unrelated
            // factory assets and project-level content; the recipient supplies the documented URP package.
            var paths = new List<string>
            {
                "Assets/Equipment/PitFurnaceReferences/PitFurnace1",
                "Assets/Equipment/PitFurnaceReferences/PitFurnace2",
                "Assets/Equipment/PitFurnaceReferences/PitFurnace3",
                "Assets/Equipment/PitFurnaceReferences/PitFurnace4",
                "Assets/Equipment/PitFurnaceReferences/PitFurnace5",
                OverviewScenePath,
                OverviewMaterialsPath,
                OverviewReportPath,
                ImportReadmePath,
                ImportScriptPath
            };
            if (File.Exists(OverviewPreviewPath)) paths.Add(OverviewPreviewPath);
            foreach (var path in paths)
                if (!AssetDatabase.IsValidFolder(path) && !File.Exists(path))
                    throw new FileNotFoundException("Complete the furnace imports and overview before exporting the package.", path);
            var outputDirectory = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "output"));
            Directory.CreateDirectory(outputDirectory);
            var outputPath = Path.Combine(outputDirectory, "pit-furnace-references-v1.unitypackage");
            AssetDatabase.SaveAssets();
            AssetDatabase.ExportPackage(paths.ToArray(), outputPath, ExportPackageOptions.Recurse);
            if (!File.Exists(outputPath) || new FileInfo(outputPath).Length < 100)
                throw new IOException("Unity package export did not produce a usable file.");
            Debug.Log("[PitFurnaceReference] SUCCESS | package=" + outputPath + " | bytes=" + new FileInfo(outputPath).Length);
        }

        private static Bounds EquipmentBounds(GameObject root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0) throw new InvalidDataException("Cannot lay out an empty furnace prefab: " + root.name);
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index++) bounds.Encapsulate(renderers[index].bounds);
            if (!Finite(bounds.center) || !Finite(bounds.size)) throw new InvalidDataException("Non-finite furnace bounds: " + root.name);
            return bounds;
        }

        private static Camera CreateOverviewStage(Bounds bounds, Shader shader)
        {
            var stage = new GameObject("REVIEW_ONLY_overview_stage");
            RenderSettings.skybox = null;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            // Review-scene lighting only: keep pale enamel below SDR clipping without changing its palette.
            RenderSettings.ambientSkyColor = new Color(.36f, .40f, .44f);
            RenderSettings.ambientEquatorColor = new Color(.22f, .26f, .29f);
            RenderSettings.ambientGroundColor = new Color(.10f, .12f, .14f);
            RenderSettings.ambientIntensity = 1f;
            RenderSettings.fog = false;
            Directory.CreateDirectory(OverviewMaterialsPath);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var materialPath = OverviewMaterialsPath + "/OverviewGround.mat";
            var groundMaterial = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
            if (groundMaterial == null)
            {
                groundMaterial = new Material(shader) { name = "OverviewGround" };
                AssetDatabase.CreateAsset(groundMaterial, materialPath);
            }
            groundMaterial.SetColor("_BaseColor", new Color(.27f, .33f, .37f));
            groundMaterial.SetFloat("_Metallic", 0f);
            groundMaterial.SetFloat("_Smoothness", .18f);
            EditorUtility.SetDirty(groundMaterial);
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            floor.name = "OverviewGround";
            floor.transform.SetParent(stage.transform, false);
            floor.transform.position = new Vector3(bounds.center.x, bounds.min.y - .055f, bounds.center.z);
            floor.transform.localScale = new Vector3(bounds.size.x + 20f, .10f, bounds.size.z + 40f);
            Object.DestroyImmediate(floor.GetComponent<Collider>());
            floor.GetComponent<Renderer>().sharedMaterial = groundMaterial;
            var key = CreateLight(stage.transform, "OverviewKey", new Vector3(38f, 152f, 0f), .95f, new Color(1f, .94f, .85f));
            key.shadows = LightShadows.Soft;
            key.shadowStrength = .7f;
            key.shadowBias = .02f;
            key.shadowNormalBias = .12f;
            CreateLight(stage.transform, "OverviewFill", new Vector3(32f, 315f, 0f), .28f, new Color(.73f, .86f, 1f));
            CreateLight(stage.transform, "OverviewRim", new Vector3(58f, 245f, 0f), .32f, new Color(.87f, .92f, 1f));
            RenderSettings.sun = key;
            var cameraObject = new GameObject("FiveFurnaceOverviewCamera_Wide");
            cameraObject.transform.SetParent(stage.transform, false);
            cameraObject.tag = "MainCamera";
            var camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.17f, .22f, .26f);
            camera.orthographic = true;
            camera.nearClipPlane = .1f;
            camera.farClipPlane = bounds.size.magnitude * 8f;
            camera.allowHDR = true;
            camera.allowMSAA = true;
            // A persistent wide viewport inside a normal 16:9 Game view, rather than an ephemeral aspect override.
            camera.rect = new Rect(0f, .18f, 1f, .64f);
            camera.aspect = (16f / 9f) / camera.rect.height;
            var distance = Mathf.Max(bounds.size.x, bounds.size.y) * 1.5f;
            camera.transform.position = bounds.center + new Vector3(-.18f, .24f, 1f) * distance;
            camera.transform.LookAt(bounds.center);
            var halfHeight = 0f;
            var halfWidth = 0f;
            for (var index = 0; index < 8; index++)
            {
                var corner = bounds.center + Vector3.Scale(bounds.extents,
                    new Vector3((index & 1) == 0 ? -1 : 1, (index & 2) == 0 ? -1 : 1, (index & 4) == 0 ? -1 : 1));
                var view = camera.transform.InverseTransformPoint(corner);
                halfHeight = Mathf.Max(halfHeight, Mathf.Abs(view.y));
                halfWidth = Mathf.Max(halfWidth, Mathf.Abs(view.x));
            }
            camera.orthographicSize = Mathf.Max(halfHeight, halfWidth / camera.aspect) * 1.1f;
            var data = cameraObject.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = false;
            data.renderShadows = true;
            return camera;
        }

        [MenuItem("Digital Twin/Pit Furnace References/Toggle Selected Furnace External Covers", priority = 80)]
        public static void ToggleSelectedExternalCovers()
        {
            var root = SelectedFurnaceRoot();
            if (root == null) throw new InvalidOperationException("Select a furnace instance or one of its children in a scene.");
            var groups = ExternalCoverGroups(root);
            if (groups.Length == 0) throw new InvalidOperationException("The selected furnace has no external_cover groups.");
            var show = !groups.Any(group => group.gameObject.activeSelf);
            Undo.RecordObjects(groups.Select(group => (Object)group.gameObject).ToArray(), show ? "Show Furnace External Covers" : "Hide Furnace External Covers");
            foreach (var group in groups)
            {
                group.gameObject.SetActive(show);
                if (PrefabUtility.IsPartOfPrefabInstance(group.gameObject))
                    PrefabUtility.RecordPrefabInstancePropertyModifications(group.gameObject);
            }
            EditorSceneManager.MarkSceneDirty(root.gameObject.scene);
            SceneView.RepaintAll();
            Debug.Log("[PitFurnaceReference] " + (show ? "Shown" : "Hidden") + " " + groups.Length
                + " external-cover groups on " + root.name + ". This is an undoable scene change; the source prefab is unchanged.");
        }

        [MenuItem("Digital Twin/Pit Furnace References/Toggle Selected Furnace External Covers", true)]
        private static bool CanToggleSelectedExternalCovers()
        {
            var root = SelectedFurnaceRoot();
            return root != null && ExternalCoverGroups(root).Length > 0;
        }

        private static Transform SelectedFurnaceRoot()
        {
            var selection = Selection.activeGameObject;
            if (selection == null || EditorUtility.IsPersistent(selection) || !selection.scene.IsValid()) return null;
            for (var current = selection.transform; current != null; current = current.parent)
            {
                if (current.name.StartsWith("pit_furnace_", StringComparison.Ordinal)
                    && current.name.EndsWith("_root", StringComparison.Ordinal)) return current;
                var source = PrefabUtility.GetCorrespondingObjectFromSource(current.gameObject);
                if (source != null && source.name.StartsWith("pit_furnace_", StringComparison.Ordinal)
                    && source.name.EndsWith("_root", StringComparison.Ordinal)) return current;
            }
            return null;
        }

        private static Transform[] ExternalCoverGroups(Transform root)
        {
            return root.GetComponentsInChildren<Transform>(true).Where(candidate =>
            {
                if (candidate == root || candidate.name.IndexOf("external_cover", StringComparison.OrdinalIgnoreCase) < 0) return false;
                // A cover group's mesh children may repeat the token; toggle the highest matching group only.
                for (var parent = candidate.parent; parent != null && parent != root; parent = parent.parent)
                    if (parent.name.IndexOf("external_cover", StringComparison.OrdinalIgnoreCase) >= 0) return false;
                return true;
            }).ToArray();
        }

        private static Scene CreateEmptyReviewScene()
        {
            var untitledScenes = Enumerable.Range(0, SceneManager.sceneCount)
                .Select(SceneManager.GetSceneAt)
                .Where(scene => scene.isLoaded && string.IsNullOrEmpty(scene.path)).ToArray();
            if (untitledScenes.Length == 0)
                return EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);

            // Unity cannot create additive scenes while its initial Untitled scene is open. Only a
            // clean, single batch-process startup scene may be replaced; never save/discard user work.
            var startup = untitledScenes[0];
            if (Application.isBatchMode && SceneManager.sceneCount == 1 && !startup.isDirty
                && startup.GetRootGameObjects().All(IsDefaultStartupObject))
                return EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            throw new InvalidOperationException("Save the existing untitled scene before importing furnace reviews. No user scene was saved or discarded.");
        }

        private static bool IsDefaultStartupObject(GameObject root)
        {
            if (root.transform.childCount != 0) return false;
            if (root.name == "Main Camera" && root.GetComponent<Camera>() != null)
                return root.GetComponents<Component>().All(component => component is Transform || component is Camera
                    || component is AudioListener || component is UniversalAdditionalCameraData);
            if (root.name == "Directional Light" && root.GetComponent<Light>() != null)
                return root.GetComponents<Component>().All(component => component is Transform || component is Light
                    || component is UniversalAdditionalLightData);
            return false;
        }

        public static void BuildOne(int index)
        {
            var asset = new AssetPaths(index);
            if (!File.Exists(asset.ModelPath)) throw new FileNotFoundException("Equipment FBX has not been generated.", asset.ModelPath);
            if (!File.Exists(asset.PalettePath)) throw new FileNotFoundException("The furnace-derived material palette is required.", asset.PalettePath);
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null) throw new InvalidOperationException("URP Lit is required; no shader or project settings were changed.");
            var palette = JsonUtility.FromJson<Palette>(File.ReadAllText(asset.PalettePath));
            if (palette == null || palette.materials == null || palette.materials.Length == 0)
                throw new InvalidDataException("palette.json contains no materials.");

            Directory.CreateDirectory(asset.DirectoryPath + "/Materials");
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var materialMap = CreateMaterials(asset, palette, shader);
            AssetDatabase.ImportAsset(asset.ModelPath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            var importer = AssetImporter.GetAtPath(asset.ModelPath) as ModelImporter;
            if (importer == null) throw new InvalidOperationException("Unity did not recognize the generated FBX.");
            importer.globalScale = 1f;
            importer.useFileScale = true;
            importer.preserveHierarchy = true;
            importer.isReadable = true;
            importer.importCameras = false;
            importer.importLights = false;
            importer.importNormals = ModelImporterNormals.Import;
            importer.importTangents = ModelImporterTangents.CalculateMikk;
            importer.meshCompression = ModelImporterMeshCompression.Off;
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            importer.SaveAndReimport();

            var model = AssetDatabase.LoadAssetAtPath<GameObject>(asset.ModelPath);
            if (model == null) throw new InvalidOperationException("The FBX import produced no model asset.");
            var sourceNames = model.GetComponentsInChildren<Renderer>(true)
                .SelectMany(renderer => renderer.sharedMaterials)
                .Where(material => material != null).Select(material => material.name).Distinct().ToArray();
            foreach (var sourceName in sourceNames)
            {
                Material material;
                if (!materialMap.TryGetValue(sourceName, out material))
                    throw new InvalidDataException("FBX material is absent from the authored palette: " + sourceName);
                importer.AddRemap(new AssetImporter.SourceAssetIdentifier(typeof(Material), sourceName), material);
            }
            importer.SaveAndReimport();

            // An additive review scene preserves whatever scene is currently open or unsaved.
            var previousActive = SceneManager.GetActiveScene();
            var loadedReview = SceneManager.GetSceneByPath(asset.ScenePath);
            if (loadedReview.IsValid() && loadedReview.isLoaded)
            {
                if (loadedReview.isDirty) throw new InvalidOperationException("The existing review scene has unsaved edits. Save it before rebuilding.");
                EditorSceneManager.CloseScene(loadedReview, true);
            }
            var scene = CreateEmptyReviewScene();
            SceneManager.SetActiveScene(scene);
            try
            {
                model = AssetDatabase.LoadAssetAtPath<GameObject>(asset.ModelPath);
                var instance = (GameObject)PrefabUtility.InstantiatePrefab(model, scene);
                PrefabUtility.UnpackPrefabInstance(instance, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
                if (instance.GetComponent<Renderer>() == null && instance.transform.childCount == 1
                    && instance.transform.GetChild(0).name == asset.RootName)
                {
                    var wrapper = instance;
                    instance = wrapper.transform.GetChild(0).gameObject;
                    instance.transform.SetParent(null, true);
                    Object.DestroyImmediate(wrapper);
                }
                instance.name = asset.RootName;
                // Keep the imported geometry and functional groups intact, including their authored pivots.
                foreach (var renderer in instance.GetComponentsInChildren<Renderer>(true))
                {
                    var slots = renderer.sharedMaterials;
                    for (var i = 0; i < slots.Length; i++)
                    {
                        if (slots[i] != null && materialMap.ContainsKey(slots[i].name)) slots[i] = materialMap[slots[i].name];
                    }
                    renderer.sharedMaterials = slots;
                    renderer.shadowCastingMode = ShadowCastingMode.On;
                    renderer.receiveShadows = true;
                }

                var report = Inspect(asset, instance);
                if (report.errors.Length != 0)
                {
                    WriteReport(asset, report);
                    throw new InvalidDataException("Imported equipment failed validation: " + string.Join("; ", report.errors));
                }
                bool saved;
                var prefab = PrefabUtility.SaveAsPrefabAssetAndConnect(instance, asset.PrefabPath, InteractionMode.AutomatedAction, out saved);
                if (!saved || prefab == null) throw new IOException("Unity could not save the equipment prefab.");
                var bounds = new Bounds(report.boundsCenter, report.boundsSize);
                var camera = CreateReviewStage(asset, bounds, shader);
                if (!EditorSceneManager.SaveScene(scene, asset.ScenePath)) throw new IOException("Unity could not save the separate review scene.");
                AssetDatabase.SaveAssets();
                CapturePreview(asset, camera, report);
                report.status = "passed";
                WriteReport(asset, report);
                AssetDatabase.ImportAsset(asset.ReportPath, ImportAssetOptions.ForceSynchronousImport);
                if (report.previewRendered) AssetDatabase.ImportAsset(asset.PreviewPath, ImportAssetOptions.ForceSynchronousImport);
                Selection.activeGameObject = instance;
                if (SceneView.lastActiveSceneView != null)
                {
                    SceneView.lastActiveSceneView.Frame(bounds, true);
                    SceneView.lastActiveSceneView.Repaint();
                }
                Debug.Log("[PitFurnaceReference] SUCCESS | 井式炉" + index + " | prefab=" + asset.PrefabPath + " | renderers=" + report.rendererCount
                    + " | triangles=" + report.instanceTriangles + " | bounds=" + report.boundsSize + " | preview=" + report.previewStatus);
            }
            catch
            {
                if (previousActive.IsValid() && previousActive.isLoaded) SceneManager.SetActiveScene(previousActive);
                throw;
            }
        }

        private static Dictionary<string, Material> CreateMaterials(AssetPaths asset, Palette palette, Shader shader)
        {
            var result = new Dictionary<string, Material>(StringComparer.Ordinal);
            foreach (var entry in palette.materials)
            {
                if (string.IsNullOrWhiteSpace(entry.name) || entry.name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
                    || entry.color == null || entry.color.Length < 3 || result.ContainsKey(entry.name))
                    throw new InvalidDataException("Invalid or duplicate material definition.");
                if (entry.color.Any(value => float.IsNaN(value) || float.IsInfinity(value))
                    || entry.metallic < 0 || entry.metallic > 1 || entry.roughness < 0 || entry.roughness > 1)
                    throw new InvalidDataException("Material contains invalid PBR values: " + entry.name);
                var path = asset.DirectoryPath + "/Materials/" + entry.name + ".mat";
                var material = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (material == null)
                {
                    material = new Material(shader) { name = entry.name };
                    AssetDatabase.CreateAsset(material, path);
                }
                material.shader = shader;
                // Blender stores node colors in linear RGB. URP material color properties are stored as sRGB
                // and converted to linear for lighting; a second missing/extra conversion changes the finish.
                var linear = new Color(entry.color[0], entry.color[1], entry.color[2], entry.color.Length > 3 ? entry.color[3] : 1f);
                var srgb = linear.gamma;
                srgb.a = linear.a;
                material.SetColor("_BaseColor", srgb);
                material.SetColor("_Color", srgb);
                material.SetFloat("_Metallic", entry.metallic);
                material.SetFloat("_Smoothness", 1f - entry.roughness);
                material.SetFloat("_Surface", 0f);
                material.SetFloat("_Cull", 2f);
                material.enableInstancing = true;
                if (entry.emission > 0)
                {
                    material.EnableKeyword("_EMISSION");
                    material.SetColor("_EmissionColor", srgb * entry.emission);
                }
                else
                {
                    material.DisableKeyword("_EMISSION");
                    material.SetColor("_EmissionColor", Color.black);
                }
                EditorUtility.SetDirty(material);
                result.Add(entry.name, material);
            }
            return result;
        }

        private static Verification Inspect(AssetPaths asset, GameObject root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(true);
            var meshes = new HashSet<Mesh>();
            var materials = new HashSet<Material>();
            var errors = new List<string>();
            var report = new Verification
            {
                status = "failed",
                generatedUtc = DateTime.UtcNow.ToString("o"),
                unityVersion = Application.unityVersion,
                furnaceIndex = asset.Index,
                displayName = "井式炉" + asset.Index,
                model = asset.ModelPath,
                prefab = asset.PrefabPath,
                reviewScene = asset.ScenePath,
                rendererCount = renderers.Length,
                transformCount = root.GetComponentsInChildren<Transform>(true).Length,
                graphicsDevice = SystemInfo.graphicsDeviceType + " / " + SystemInfo.graphicsDeviceName,
                previewStatus = "not attempted"
            };
            var bounds = renderers.Length > 0 ? renderers[0].bounds : new Bounds(Vector3.zero, Vector3.zero);
            foreach (var renderer in renderers)
            {
                bounds.Encapsulate(renderer.bounds);
                foreach (var material in renderer.sharedMaterials)
                {
                    if (material == null) report.missingMaterialSlots++;
                    else
                    {
                        materials.Add(material);
                        if (material.shader == null || material.shader.name != "Universal Render Pipeline/Lit")
                            errors.Add("Unexpected material shader on " + renderer.name);
                    }
                }
                var filter = renderer.GetComponent<MeshFilter>();
                var mesh = filter != null ? filter.sharedMesh : (renderer is SkinnedMeshRenderer ? ((SkinnedMeshRenderer)renderer).sharedMesh : null);
                if (mesh == null) { report.missingMeshes++; continue; }
                long triangles = 0;
                for (var index = 0; index < mesh.subMeshCount; index++)
                {
                    if (mesh.GetTopology(index) == MeshTopology.Triangles) triangles += (long)mesh.GetIndexCount(index) / 3;
                    else errors.Add("Non-triangle topology on " + mesh.name);
                }
                report.instanceTriangles += triangles;
                if (meshes.Add(mesh))
                {
                    report.uniqueMeshTriangles += triangles;
                    if (!mesh.HasVertexAttribute(VertexAttribute.Normal)) report.meshesWithoutNormals++;
                }
            }
            report.uniqueMeshCount = meshes.Count;
            report.materialCount = materials.Count;
            report.materialNames = materials.Select(material => material.name).OrderBy(name => name).ToArray();
            report.directChildGroups = Enumerable.Range(0, root.transform.childCount).Select(index => root.transform.GetChild(index).name).ToArray();
            report.boundsCenter = bounds.center;
            report.boundsSize = bounds.size;
            report.boundsMin = bounds.min;
            report.boundsMax = bounds.max;
            if (renderers.Length == 0 || report.instanceTriangles == 0) errors.Add("No visible equipment geometry.");
            if (report.missingMeshes != 0) errors.Add("Missing mesh assets: " + report.missingMeshes);
            if (report.missingMaterialSlots != 0) errors.Add("Missing material slots: " + report.missingMaterialSlots);
            if (report.meshesWithoutNormals != 0) errors.Add("Meshes without normals: " + report.meshesWithoutNormals);
            if (!Finite(bounds.center) || !Finite(bounds.size)) errors.Add("Non-finite imported bounds.");
            if (bounds.size.y < 2f || bounds.size.y > 15f || bounds.size.x < 1f || bounds.size.x > 20f || bounds.size.z < .5f || bounds.size.z > 20f)
                errors.Add("Unexpected meter-scale dimensions; inspect FBX unit/axis conversion.");
            if (asset.Index == 5)
            {
                const string cabinetGroupName = "pf5_f5_insulated_cabinet_shell";
                // Match only the authored direct functional group; material mesh children share its prefix.
                var cabinet = Enumerable.Range(0, root.transform.childCount)
                    .Select(childIndex => root.transform.GetChild(childIndex))
                    .FirstOrDefault(child => child.name == cabinetGroupName
                        || (child.name.StartsWith(cabinetGroupName + ".", StringComparison.Ordinal)
                            && child.name.Length == cabinetGroupName.Length + 4
                            && child.name.Substring(cabinetGroupName.Length + 1).All(character => character >= '0' && character <= '9')));
                if (cabinet == null || !cabinet.gameObject.activeInHierarchy)
                    errors.Add("Furnace 5 requires its visible full-depth cabinet shell, not a freestanding front panel.");
                else
                {
                    var walls = cabinet.GetComponentsInChildren<Renderer>(true);
                    if (walls.Length == 0)
                        errors.Add("Furnace 5 cabinet shell contains no rendered walls.");
                    else
                    {
                        var shellBounds = walls[0].bounds;
                        foreach (var wall in walls) shellBounds.Encapsulate(wall.bounds);
                        if (shellBounds.size.z < 1.5f)
                            errors.Add("Furnace 5 cabinet shell depth is below the cabinet-depth reconstruction threshold.");
                    }
                }
            }
            report.errors = errors.Distinct().ToArray();
            return report;
        }

        private static bool Finite(Vector3 value)
        {
            return !float.IsNaN(value.x) && !float.IsNaN(value.y) && !float.IsNaN(value.z)
                && !float.IsInfinity(value.x) && !float.IsInfinity(value.y) && !float.IsInfinity(value.z);
        }

        private static Camera CreateReviewStage(AssetPaths asset, Bounds bounds, Shader shader)
        {
            RenderSettings.skybox = null;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            // These settings belong to the isolated review scene, never to the existing factory scene.
            RenderSettings.ambientSkyColor = new Color(.36f, .40f, .44f);
            RenderSettings.ambientEquatorColor = new Color(.22f, .26f, .29f);
            RenderSettings.ambientGroundColor = new Color(.10f, .12f, .14f);
            RenderSettings.ambientIntensity = 1f;
            RenderSettings.fog = false;
            var stage = new GameObject("REVIEW_ONLY_stage_not_in_equipment_prefab");
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            floor.name = "StudioGround";
            floor.transform.SetParent(stage.transform, false);
            floor.transform.position = new Vector3(bounds.center.x, bounds.min.y - .055f, bounds.center.z);
            var span = Mathf.Max(bounds.size.x, bounds.size.y, bounds.size.z);
            floor.transform.localScale = new Vector3(span * 16f, .10f, span * 16f);
            Object.DestroyImmediate(floor.GetComponent<Collider>());
            var floorPath = asset.DirectoryPath + "/Materials/ReviewOnlyGround.mat";
            var floorMaterial = AssetDatabase.LoadAssetAtPath<Material>(floorPath);
            if (floorMaterial == null)
            {
                floorMaterial = new Material(shader) { name = "ReviewOnlyGround" };
                AssetDatabase.CreateAsset(floorMaterial, floorPath);
            }
            floorMaterial.SetColor("_BaseColor", new Color(.27f, .33f, .37f));
            floorMaterial.SetFloat("_Metallic", 0f);
            floorMaterial.SetFloat("_Smoothness", .18f);
            EditorUtility.SetDirty(floorMaterial);
            floor.GetComponent<Renderer>().sharedMaterial = floorMaterial;

            var key = CreateLight(stage.transform, "StudioKey", new Vector3(38f, 152f, 0f), .95f, new Color(1f, .94f, .85f));
            key.shadows = LightShadows.Soft;
            key.shadowStrength = .7f;
            key.shadowBias = .02f;
            key.shadowNormalBias = .12f;
            CreateLight(stage.transform, "StudioFill", new Vector3(32f, 315f, 0f), .28f, new Color(.73f, .86f, 1f));
            CreateLight(stage.transform, "StudioRim", new Vector3(58f, 245f, 0f), .32f, new Color(.87f, .92f, 1f));
            RenderSettings.sun = key;

            var cameraObject = new GameObject("ReferenceEquipmentReviewCamera");
            cameraObject.transform.SetParent(stage.transform, false);
            cameraObject.tag = "MainCamera";
            var camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(.17f, .22f, .26f);
            camera.orthographic = true;
            camera.nearClipPlane = .1f;
            camera.farClipPlane = span * 12f;
            camera.allowHDR = true;
            camera.allowMSAA = true;
            camera.aspect = 1600f / 1400f;
            // Authored front is Blender -Y, imported as Unity +Z (not the back of the cabinet).
            // Furnace 5 also needs enough side-wall area to demonstrate the cabinet's true depth.
            var viewDirection = asset.Index == 5 ? new Vector3(-1.70f, .62f, 1.50f) : new Vector3(-1.22f, .73f, 1.70f);
            camera.transform.position = bounds.center + viewDirection * span;
            camera.transform.LookAt(bounds.center + Vector3.up * bounds.size.y * .015f);
            var halfHeight = 0f;
            var halfWidth = 0f;
            for (var index = 0; index < 8; index++)
            {
                var corner = bounds.center + Vector3.Scale(bounds.extents, new Vector3((index & 1) == 0 ? -1 : 1, (index & 2) == 0 ? -1 : 1, (index & 4) == 0 ? -1 : 1));
                var view = camera.transform.InverseTransformPoint(corner);
                halfHeight = Mathf.Max(halfHeight, Mathf.Abs(view.y));
                halfWidth = Mathf.Max(halfWidth, Mathf.Abs(view.x));
            }
            camera.orthographicSize = Mathf.Max(halfHeight, halfWidth / camera.aspect) * 1.12f;
            var cameraData = cameraObject.AddComponent<UniversalAdditionalCameraData>();
            cameraData.renderPostProcessing = false;
            cameraData.renderShadows = true;
            return camera;
        }

        private static Light CreateLight(Transform parent, string name, Vector3 rotation, float intensity, Color color)
        {
            var instance = new GameObject(name);
            instance.transform.SetParent(parent, false);
            instance.transform.rotation = Quaternion.Euler(rotation);
            var light = instance.AddComponent<Light>();
            light.type = LightType.Directional;
            light.color = color;
            light.intensity = intensity;
            light.shadows = LightShadows.None;
            return light;
        }

        private sealed class PreviewCapture
        {
            public bool rendered;
            public string path;
            public string status;
        }

        private static void CapturePreview(AssetPaths asset, Camera camera, Verification report)
        {
            var preview = CapturePreview(camera, asset.PreviewPath, 48 + asset.Index, 1600, 1400);
            report.previewRendered = preview.rendered;
            report.previewPath = preview.path;
            report.previewStatus = preview.status;
        }

        private static PreviewCapture CapturePreview(Camera camera, string path, int sceneMaskBit, int width, int height)
        {
            var result = new PreviewCapture { path = path };
            if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
            {
                result.status = "unavailable: Unity has a null graphics device (-nographics); prefab and geometry checks still ran";
                return result;
            }
            var previousActive = RenderTexture.active;
            var previousTarget = camera.targetTexture;
            var previousViewport = camera.rect;
            var previousAspect = camera.aspect;
            var scene = camera.gameObject.scene;
            var previousSceneMask = EditorSceneManager.GetSceneCullingMask(scene);
            var previousCameraMask = camera.overrideSceneCullingMask;
            RenderTexture target = null;
            Texture2D texture = null;
            try
            {
                // Normal additive scenes share the default mask. A temporary, dedicated editor scene
                // bit excludes all other scenes' geometry AND lights, without changing project layers.
                var isolatedSceneMask = 1UL << sceneMaskBit;
                EditorSceneManager.SetSceneCullingMask(scene, isolatedSceneMask);
                camera.overrideSceneCullingMask = isolatedSceneMask;
                camera.rect = new Rect(0f, 0f, 1f, 1f);
                camera.aspect = (float)width / height;
                target = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB)
                {
                    name = "ReferenceEquipmentVerificationCapture",
                    antiAliasing = 1
                };
                target.Create();
                camera.targetTexture = target;
                var request = new UniversalRenderPipeline.SingleCameraRequest { destination = target };
                if (GraphicsSettings.currentRenderPipeline != null && RenderPipeline.SupportsRenderRequest(camera, request))
                    RenderPipeline.SubmitRenderRequest(camera, request);
                else
                    camera.Render();
                RenderTexture.active = target;
                texture = new Texture2D(target.width, target.height, TextureFormat.RGBA32, false, false);
                texture.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                texture.Apply();
                var pixels = texture.GetPixels32();
                var min = 255;
                var max = 0;
                var magenta = 0;
                var samples = 0;
                for (var index = 0; index < pixels.Length; index += 37)
                {
                    var pixel = pixels[index];
                    var luminance = (pixel.r + pixel.g + pixel.b) / 3;
                    min = Mathf.Min(min, luminance);
                    max = Mathf.Max(max, luminance);
                    if (pixel.r > 200 && pixel.b > 200 && pixel.g < 70) magenta++;
                    samples++;
                }
                if (max - min < 25) throw new InvalidOperationException("Captured frame was uniform/blank; the render pipeline may not be initialized.");
                if (magenta > samples * .08f) throw new InvalidOperationException("Captured frame contains excessive shader-error magenta.");
                File.WriteAllBytes(path, texture.EncodeToPNG());
                result.rendered = true;
                result.status = "rendered and checked for blank/error-shader output; visual review is still required";
            }
            catch (Exception exception)
            {
                result.rendered = false;
                result.status = "unavailable: " + exception.GetType().Name + ": " + exception.Message;
                Debug.LogWarning("[PitFurnaceReference] Preview capture: " + result.status);
            }
            finally
            {
                camera.targetTexture = previousTarget;
                camera.rect = previousViewport;
                camera.aspect = previousAspect;
                camera.overrideSceneCullingMask = previousCameraMask;
                EditorSceneManager.SetSceneCullingMask(scene, previousSceneMask);
                RenderTexture.active = previousActive;
                if (target != null) { target.Release(); Object.DestroyImmediate(target); }
                if (texture != null) Object.DestroyImmediate(texture);
            }
            return result;
        }

        private static void WriteReport(AssetPaths asset, Verification report)
        {
            File.WriteAllText(asset.ReportPath, JsonUtility.ToJson(report, true));
        }
    }
}
#endif
