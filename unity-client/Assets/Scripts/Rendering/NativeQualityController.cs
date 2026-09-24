using System;
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Core;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public enum NativeQualityProfile
    {
        IntegratedGpu,
        Balanced,
        Showcase
    }

    /// <summary>
    /// Hardware profiles only tune raster cost. They never decimate meshes or replace the imported model.
    /// </summary>
    public sealed class NativeQualityController : MonoBehaviour
    {
        private sealed class ProfileValues
        {
            public int TargetFrameRate;
            public float RenderScale;
            public int Msaa;
            public float ShadowDistance;
            public int MainShadowResolution;
            public int AdditionalShadowResolution;
            public int ShadowCascades;
            public bool AdditionalLightShadows;
            public bool PostProcessing;
            public bool RealtimeReflections;
        }

        private NativeClientSettings _settings;
        private bool _hotkeysEnabled;
        private Camera _shadowCamera;
        private OrbitCameraController _shadowOrbit;
        private float _minimumShadowDistance = 80f;

        public NativeQualityProfile ActiveProfile { get; private set; }
        public string ActiveProfileName => ToConfigName(ActiveProfile);
        public event Action<NativeQualityProfile> ProfileChanged;

        public void Configure(NativeClientSettings settings)
        {
            _settings = settings ?? new NativeClientSettings();
            _hotkeysEnabled = _settings.enableQualityHotkeys;
            var requested = _settings.qualityProfile;
            if (string.Equals(requested, "auto", StringComparison.OrdinalIgnoreCase)) ApplyAuto(false);
            else Apply(Parse(requested), false);
        }

        public void ApplyAuto(bool persist = false)
        {
            Apply(DetectProfile(), persist);
        }

        public void Apply(NativeQualityProfile profile, bool persist = true)
        {
            ActiveProfile = profile;
            var values = Values(profile);
            _minimumShadowDistance = values.ShadowDistance;
            _shadowCamera = Camera.main;
            _shadowOrbit = _shadowCamera != null ? _shadowCamera.GetComponent<OrbitCameraController>() : null;
            Application.targetFrameRate = values.TargetFrameRate;
            QualitySettings.vSyncCount = 0;
            QualitySettings.antiAliasing = values.Msaa;
            QualitySettings.shadows = UnityEngine.ShadowQuality.All;
            QualitySettings.shadowResolution = profile == NativeQualityProfile.Showcase
                ? UnityEngine.ShadowResolution.VeryHigh
                : UnityEngine.ShadowResolution.High;
            QualitySettings.shadowDistance = values.ShadowDistance;
            QualitySettings.shadowCascades = values.ShadowCascades;
            QualitySettings.softParticles = profile != NativeQualityProfile.IntegratedGpu;
            QualitySettings.realtimeReflectionProbes = values.RealtimeReflections;
            QualitySettings.lodBias = profile == NativeQualityProfile.Showcase ? 3f : 2f;
            QualitySettings.maximumLODLevel = 0;
#pragma warning disable CS0618
            QualitySettings.masterTextureLimit = 0;
#pragma warning restore CS0618

            var pipeline = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset
                ?? QualitySettings.renderPipeline as UniversalRenderPipelineAsset;
            if (pipeline != null)
            {
                pipeline.renderScale = values.RenderScale;
                pipeline.msaaSampleCount = values.Msaa;
                pipeline.shadowDistance = values.ShadowDistance;
                pipeline.shadowCascadeCount = values.ShadowCascades;
                pipeline.supportsHDR = true;
                pipeline.supportsCameraDepthTexture = values.PostProcessing;

                // URP 14 exposes these settings as read-only at runtime even though the
                // renderer reads them dynamically. Update the serialized backing fields so
                // the three hardware profiles can still change shadow cost in a player build.
                SetUrpField(pipeline, "m_MainLightShadowmapResolution", values.MainShadowResolution);
                SetUrpField(pipeline, "m_AdditionalLightShadowsSupported", values.AdditionalLightShadows);
                SetUrpField(pipeline, "m_AdditionalLightsShadowmapResolution", values.AdditionalShadowResolution);
                SetUrpField(pipeline, "m_SoftShadowsSupported", true);
            }

            foreach (var cameraData in FindObjectsOfType<UniversalAdditionalCameraData>(true))
            {
                cameraData.renderPostProcessing = values.PostProcessing;
                // MSAA covers geometry edges; FXAA also softens subpixel
                // specular highlights along distant architectural trim.
                cameraData.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
            }
            foreach (var volume in FindObjectsOfType<Volume>(true)) volume.enabled = values.PostProcessing;

            if (persist) PersistProfile(profile);
            ProfileChanged?.Invoke(profile);
            Debug.Log($"[NativeQuality] Applied {ActiveProfileName}; full model geometry retained.");
        }

        public void Apply(string profile, bool persist = true)
        {
            if (string.Equals(profile, "auto", StringComparison.OrdinalIgnoreCase))
            {
                ApplyAuto(persist);
                return;
            }
            Apply(Parse(profile), persist);
        }

        private void Update()
        {
            if (!_hotkeysEnabled) return;
            if (Input.GetKeyDown(KeyCode.F1)) Apply(NativeQualityProfile.IntegratedGpu, false);
            else if (Input.GetKeyDown(KeyCode.F2)) Apply(NativeQualityProfile.Balanced, false);
            else if (Input.GetKeyDown(KeyCode.F3)) Apply(NativeQualityProfile.Showcase, false);
            else if (Input.GetKeyDown(KeyCode.F4)) ApplyAuto(false);
        }

        private void OnEnable() => RenderPipelineManager.beginCameraRendering += FitShadowCoverage;
        private void OnDisable() => RenderPipelineManager.beginCameraRendering -= FitShadowCoverage;

        private void FitShadowCoverage(ScriptableRenderContext context, Camera camera)
        {
            // Run after camera motion, before URP reads shadow settings. Reflection
            // probe/preview cameras must not change the application's shadow range.
            if (camera != _shadowCamera || _shadowOrbit == null) return;
            var distance = SceneShadowCoverage.Distance(_shadowOrbit.FramedBounds,
                camera.transform.position, camera.transform.forward, camera.farClipPlane, _minimumShadowDistance);
            var pipeline = GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;
            if (pipeline != null && !Mathf.Approximately(pipeline.shadowDistance, distance))
                pipeline.shadowDistance = distance;
            QualitySettings.shadowDistance = distance;
        }

        private static NativeQualityProfile DetectProfile()
        {
            var gpu = (SystemInfo.graphicsDeviceName ?? string.Empty).ToLowerInvariant();
            var integrated = gpu.Contains("intel")
                || gpu.Contains("uhd")
                || gpu.Contains("iris")
                || gpu.Contains("vega 3")
                || gpu.Contains("vega 8")
                || SystemInfo.graphicsMemorySize < 2800;
            if (integrated) return NativeQualityProfile.IntegratedGpu;
            return SystemInfo.graphicsMemorySize >= 6000
                ? NativeQualityProfile.Showcase
                : NativeQualityProfile.Balanced;
        }

        private static ProfileValues Values(NativeQualityProfile profile)
        {
            switch (profile)
            {
                case NativeQualityProfile.Showcase:
                    return new ProfileValues
                    {
                        TargetFrameRate = 60,
                        RenderScale = 1.15f,
                        Msaa = 4,
                        ShadowDistance = 120f,
                        MainShadowResolution = 4096,
                        AdditionalShadowResolution = 2048,
                        ShadowCascades = 4,
                        AdditionalLightShadows = true,
                        PostProcessing = true,
                        RealtimeReflections = true
                    };
                case NativeQualityProfile.Balanced:
                    return new ProfileValues
                    {
                        TargetFrameRate = 60,
                        RenderScale = 1f,
                        Msaa = 4,
                        ShadowDistance = 80f,
                        MainShadowResolution = 2048,
                        AdditionalShadowResolution = 1024,
                        ShadowCascades = 2,
                        AdditionalLightShadows = true,
                        PostProcessing = true,
                        RealtimeReflections = false
                    };
                default:
                    return new ProfileValues
                    {
                        TargetFrameRate = 45,
                        RenderScale = 0.84f,
                        Msaa = 2,
                        ShadowDistance = 48f,
                        MainShadowResolution = 2048,
                        AdditionalShadowResolution = 512,
                        ShadowCascades = 2,
                        AdditionalLightShadows = false,
                        PostProcessing = true,
                        RealtimeReflections = false
                    };
            }
        }

        private static NativeQualityProfile Parse(string value)
        {
            switch ((value ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "showcase":
                case "high":
                case "quality":
                    return NativeQualityProfile.Showcase;
                case "balanced":
                case "medium":
                    return NativeQualityProfile.Balanced;
                default:
                    return NativeQualityProfile.IntegratedGpu;
            }
        }

        private static string ToConfigName(NativeQualityProfile profile)
        {
            return profile == NativeQualityProfile.Showcase
                ? "showcase"
                : profile == NativeQualityProfile.Balanced
                    ? "balanced"
                    : "integrated_gpu";
        }

        private static string ProfilePath => Path.Combine(Application.persistentDataPath, "native-quality-profile.txt");

        private static void PersistProfile(NativeQualityProfile profile)
        {
            try { File.WriteAllText(ProfilePath, ToConfigName(profile)); }
            catch (Exception exception) { Debug.LogWarning($"[NativeQuality] Could not persist profile: {exception.Message}"); }
        }

        private static void SetUrpField(UniversalRenderPipelineAsset pipeline, string fieldName, object value)
        {
            var field = typeof(UniversalRenderPipelineAsset).GetField(
                fieldName,
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            if (field == null)
            {
                Debug.LogWarning($"[NativeQuality] URP field '{fieldName}' is unavailable; keeping the project default.");
                return;
            }

            var converted = field.FieldType.IsEnum
                ? Enum.ToObject(field.FieldType, Convert.ToInt32(value))
                : Convert.ChangeType(value, field.FieldType);
            field.SetValue(pipeline, converted);
        }
    }
}
