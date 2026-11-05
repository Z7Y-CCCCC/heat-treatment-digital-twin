Shader "HeatTreatment/InspectionOutline"
{
    Properties
    {
        _OutlineColor("Outline color", Color) = (1,1,1,1)
        _OutlineWidthPixels("Outline width in pixels", Float) = 2
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" }
        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"
        CBUFFER_START(UnityPerMaterial)
            half4 _OutlineColor;
            float _OutlineWidthPixels;
            float4 _HoverMaskTexelSize;
        CBUFFER_END
        ENDHLSL
        Pass
        {
            Name "HoveredUnionMask"
            Cull Off ZWrite Off ZTest Always Blend Off
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; };
            Varyings Vert(Attributes input)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                return output;
            }
            half4 Frag(Varyings input) : SV_Target
            {
                float depth = SampleSceneDepth(input.positionCS.xy / _ScaledScreenParams.xy);
                #if UNITY_REVERSED_Z
                    clip(input.positionCS.z - depth + .00001);
                #else
                    clip(depth - input.positionCS.z + .00001);
                #endif
                return 1;
            }
            ENDHLSL
        }
        Pass
        {
            Name "OutsideOnlyEdge"
            Cull Off ZWrite Off ZTest Always Blend SrcAlpha OneMinusSrcAlpha
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            TEXTURE2D(_HoverMask); SAMPLER(sampler_HoverMask);
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; };
            Varyings Vert(uint id : SV_VertexID) { Varyings output; output.positionCS = GetFullScreenTriangleVertexPosition(id); output.uv = GetFullScreenTriangleTexCoord(id); return output; }
            half4 Frag(Varyings input) : SV_Target
            {
                float center = SAMPLE_TEXTURE2D(_HoverMask, sampler_HoverMask, input.uv).r;
                // Exclude the entire selected surface, even if its material writes no depth.
                clip(.5 - center);
                float2 step = _HoverMaskTexelSize.xy * _OutlineWidthPixels;
                float ring = 0;
                [unroll] for (int y = -1; y <= 1; y++)
                    [unroll] for (int x = -1; x <= 1; x++)
                        ring = max(ring, SAMPLE_TEXTURE2D(_HoverMask, sampler_HoverMask, input.uv + float2(x,y) * step).r);
                clip(ring - .01);
                return half4(_OutlineColor.rgb, _OutlineColor.a * saturate(ring - center));
            }
            ENDHLSL
        }
    }
    FallBack Off
}
