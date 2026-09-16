Shader "HeatTreatment/InspectionShell"
{
    Properties
    {
        _BaseMap("Base map", 2D) = "white" {}
        _BaseColor("Base color", Color) = (1,1,1,1)
        _Metallic("Metallic", Range(0,1)) = 0
        _Smoothness("Smoothness", Range(0,1)) = 0.45
        _EmissionColor("Emission", Color) = (0,0,0,0)
        _Opacity("Inspection opacity", Range(0,1)) = 1
        _Wireframe("Wireframe", Float) = 0
        _ZWrite("Depth write", Float) = 1
        _ClipAxis("Model-local clip axis", Vector) = (0,1,0,0)
        _ClipRange("Min, max, direction, progress", Vector) = (0,1,1,0)
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Transparent" "Queue"="Transparent" }
        Pass
        {
            Name "InspectionShellForward"
            Tags { "LightMode"="UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite [_ZWrite]
            Cull Off
            HLSLPROGRAM
            #pragma target 4.0
            #pragma vertex Vert
            #pragma geometry Geo
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
                half4 _EmissionColor;
                half _Metallic;
                half _Smoothness;
                half _Opacity;
                half _Wireframe;
                float4 _ClipAxis;
                float4 _ClipRange;
                float4x4 _InspectionWorldToModel;
            CBUFFER_END
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float2 uv : TEXCOORD2;
                float3 bary : TEXCOORD3;
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
            [maxvertexcount(3)]
            void Geo(triangle Varyings input[3], inout TriangleStream<Varyings> stream)
            {
                Varyings v = input[0]; v.bary = float3(1,0,0); stream.Append(v);
                v = input[1]; v.bary = float3(0,1,0); stream.Append(v);
                v = input[2]; v.bary = float3(0,0,1); stream.Append(v);
                stream.RestartStrip();
            }
            half4 Frag(Varyings input, FRONT_FACE_TYPE face : FRONT_FACE_SEMANTIC) : SV_Target
            {
                float3 model = mul(_InspectionWorldToModel, float4(input.positionWS, 1)).xyz;
                float coordinate = saturate((dot(model, _ClipAxis.xyz) - _ClipRange.x) / max(.00001, _ClipRange.y - _ClipRange.x));
                coordinate = _ClipRange.z < 0 ? 1 - coordinate : coordinate;
                if (_ClipRange.w > .000001) clip(coordinate - _ClipRange.w);
                half4 base = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv) * _BaseColor;
                SurfaceData surface = (SurfaceData)0;
                surface.albedo = base.rgb;
                surface.metallic = _Metallic;
                surface.smoothness = _Smoothness;
                surface.normalTS = half3(0,0,1);
                surface.occlusion = 1;
                surface.emission = _EmissionColor.rgb;
                surface.alpha = base.a * _Opacity;
                // A thin moving cut edge makes the shell's direction legible without
                // assigning emissive/neon materials to the actual equipment.
                float edge = _ClipRange.w > 0 && _ClipRange.w < 1 ? 1 - smoothstep(0, .008, coordinate - _ClipRange.w) : 0;
                surface.emission += edge * half3(.55,.72,.85);
                if (_Wireframe > .5)
                {
                    float3 width = max(fwidth(input.bary) * 1.2, .00001);
                    float3 edgeFactor = smoothstep(0, width, input.bary);
                    surface.alpha *= 1 - min(edgeFactor.x, min(edgeFactor.y, edgeFactor.z));
                }
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
