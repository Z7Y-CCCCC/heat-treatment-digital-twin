Shader "HeatTreatment/InspectionFrosted"
{
    Properties
    {
        _BaseMap("Base map", 2D) = "white" {}
        _BaseColor("Base color", Color) = (1,1,1,1)
        _Tint("Frost tint", Color) = (0.54,0.66,0.75,1)
        _FrostAmount("Frost amount", Range(0,1)) = 0.9
        _Desaturation("Desaturation", Range(0,1)) = 0.78
        _Opacity("Frost opacity", Range(0,1)) = 0.38
        _NoiseScale("Noise scale", Float) = 2.4
        _NoiseStrength("Noise strength", Range(0,0.3)) = 0.08
        _Smoothness("Smoothness", Range(0,1)) = 0.08
        _EmissionColor("Emission", Color) = (0,0,0,0)
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Transparent" "Queue"="Transparent+10" }
        Pass
        {
            Name "InspectionFrostedForward"
            Tags { "LightMode"="UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Back
            HLSLPROGRAM
            #pragma target 3.0
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile _ _ADDITIONAL_LIGHTS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4 _BaseColor;
                half4 _Tint;
                half4 _EmissionColor;
                half _FrostAmount;
                half _Desaturation;
                half _Opacity;
                half _NoiseScale;
                half _NoiseStrength;
                half _Smoothness;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float2 uv : TEXCOORD2;
            };

            Varyings Vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                output.positionWS = TransformObjectToWorld(input.positionOS.xyz);
                output.positionCS = TransformWorldToHClip(output.positionWS);
                output.normalWS = TransformObjectToWorldNormal(input.normalOS);
                output.uv = TRANSFORM_TEX(input.uv, _BaseMap);
                return output;
            }

            half FrostNoise(float2 pixel)
            {
                float2 seed = pixel * max(.1, _NoiseScale);
                return frac(sin(dot(seed, float2(12.9898, 78.233))) * 43758.5453) - .5;
            }

            half4 Frag(Varyings input, FRONT_FACE_TYPE face : FRONT_FACE_SEMANTIC) : SV_Target
            {
                half4 base = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv) * _BaseColor;
                half luminance = dot(base.rgb, half3(.299, .587, .114));
                half3 muted = lerp(base.rgb, luminance.xxx, _Desaturation);
                half3 frosted = lerp(muted, _Tint.rgb, _FrostAmount * .42);
                half noise = FrostNoise(input.positionCS.xy / max(1, _ScreenParams.xy));
                frosted = saturate(frosted + noise * _NoiseStrength);

                SurfaceData surface = (SurfaceData)0;
                surface.albedo = frosted;
                surface.metallic = 0;
                surface.smoothness = _Smoothness;
                surface.normalTS = half3(0,0,1);
                surface.occlusion = 1;
                surface.emission = lerp(_EmissionColor.rgb, frosted * .06, _FrostAmount);
                surface.alpha = base.a * _Opacity;

                InputData lighting = (InputData)0;
                lighting.positionWS = input.positionWS;
                lighting.normalWS = NormalizeNormalPerPixel(input.normalWS) * IS_FRONT_VFACE(face, 1, -1);
                lighting.viewDirectionWS = GetWorldSpaceNormalizeViewDir(input.positionWS);
                lighting.shadowCoord = TransformWorldToShadowCoord(input.positionWS);
                lighting.bakedGI = SampleSH(lighting.normalWS);
                lighting.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(input.positionCS);
                lighting.shadowMask = half4(1,1,1,1);
                half4 color = UniversalFragmentPBR(lighting, surface);
                color.a = surface.alpha;
                return color;
            }
            ENDHLSL
        }
    }
    FallBack Off
}
