using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Union silhouette, then an outside-only ring: transparent CAD never needs to write depth.
    public static class InspectionOutlineRenderer
    {
        private struct Draw { public Mesh Mesh; public Matrix4x4 Matrix; public int Submesh; }
        private sealed class OutlinePass : ScriptableRenderPass
        {
            public readonly List<Draw> Draws = new List<Draw>();
            public Material Material;
            public Color Color;
            public float Width;
            public int Frame;
            private RTHandle _mask;
            private readonly MaterialPropertyBlock _properties = new MaterialPropertyBlock();
            private static readonly int MaskId = Shader.PropertyToID("_HoverMask");
            private static readonly int TexelId = Shader.PropertyToID("_HoverMaskTexelSize");
            private static readonly int ColorId = Shader.PropertyToID("_OutlineColor");
            private static readonly int WidthId = Shader.PropertyToID("_OutlineWidthPixels");
            public OutlinePass() { renderPassEvent = RenderPassEvent.AfterRenderingTransparents; ConfigureInput(ScriptableRenderPassInput.Depth); }
            public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData data)
            {
                var descriptor = data.cameraData.cameraTargetDescriptor;
                descriptor.depthBufferBits = 0; descriptor.msaaSamples = 1; descriptor.bindMS = false;
                descriptor.colorFormat = SystemInfo.SupportsRenderTextureFormat(RenderTextureFormat.R8) ? RenderTextureFormat.R8 : RenderTextureFormat.ARGB32;
                descriptor.sRGB = false;
                RenderingUtils.ReAllocateIfNeeded(ref _mask, descriptor, FilterMode.Bilinear, TextureWrapMode.Clamp, name: "Hover silhouette mask");
                ConfigureTarget(data.cameraData.renderer.cameraColorTargetHandle);
                ConfigureClear(ClearFlag.None, UnityEngine.Color.clear);
            }
            public override void Execute(ScriptableRenderContext context, ref RenderingData data)
            {
                if (Material == null || Draws.Count == 0 || Frame != Time.frameCount) return;
                var cmd = CommandBufferPool.Get("Outside-only hover outline");
                try
                {
                    CoreUtils.SetRenderTarget(cmd, _mask, ClearFlag.Color, UnityEngine.Color.clear);
                    foreach (var draw in Draws)
                        if (draw.Mesh != null) cmd.DrawMesh(draw.Mesh, draw.Matrix, Material, draw.Submesh, 0);
                    CoreUtils.SetRenderTarget(cmd, data.cameraData.renderer.cameraColorTargetHandle);
                    cmd.SetGlobalTexture(MaskId, _mask.nameID);
                    var size = data.cameraData.cameraTargetDescriptor;
                    _properties.SetVector(TexelId, new Vector4(1f / size.width, 1f / size.height, size.width, size.height));
                    _properties.SetColor(ColorId, Color); _properties.SetFloat(WidthId, Mathf.Clamp(Width, 1f, 3f));
                    cmd.DrawProcedural(Matrix4x4.identity, Material, 1, MeshTopology.Triangles, 3, 1, _properties);
                    context.ExecuteCommandBuffer(cmd);
                }
                finally { CommandBufferPool.Release(cmd); }
            }
            public void Release() { _mask?.Release(); _mask = null; Draws.Clear(); }
        }
        private static readonly Dictionary<Camera, OutlinePass> Passes = new Dictionary<Camera, OutlinePass>();
        private static bool _subscribed;
        public static void Begin(Camera camera)
        {
            if (camera != null && Passes.TryGetValue(camera, out var pass)) { pass.Draws.Clear(); pass.Frame = Time.frameCount; }
        }
        public static void Submit(Mesh mesh, Matrix4x4 matrix, int layer, Camera camera, Material material, Color color, float width)
        {
            if (camera == null || mesh == null || material == null || (camera.cullingMask & (1 << layer)) == 0) return;
            if (!Passes.TryGetValue(camera, out var pass)) { pass = new OutlinePass(); Passes.Add(camera, pass); }
            if (!_subscribed) { RenderPipelineManager.beginCameraRendering += Enqueue; _subscribed = true; }
            if (pass.Frame != Time.frameCount) pass.Draws.Clear();
            pass.Frame = Time.frameCount; pass.Material = material; pass.Color = color; pass.Width = width;
            for (var i = 0; i < mesh.subMeshCount; i++) pass.Draws.Add(new Draw { Mesh = mesh, Matrix = matrix, Submesh = i });
        }
        private static void Enqueue(ScriptableRenderContext context, Camera camera)
        {
            if (camera != null && Passes.TryGetValue(camera, out var pass) && pass.Frame == Time.frameCount && pass.Draws.Count > 0)
                camera.GetUniversalAdditionalCameraData().scriptableRenderer.EnqueuePass(pass);
        }
        public static void Release(Camera camera)
        {
            // Unity's overloaded null also matches destroyed cameras; their GPU mask still needs disposal.
            if (!ReferenceEquals(camera, null) && Passes.TryGetValue(camera, out var pass)) { pass.Release(); Passes.Remove(camera); }
            if (Passes.Count == 0 && _subscribed) { RenderPipelineManager.beginCameraRendering -= Enqueue; _subscribed = false; }
        }
    }
}
