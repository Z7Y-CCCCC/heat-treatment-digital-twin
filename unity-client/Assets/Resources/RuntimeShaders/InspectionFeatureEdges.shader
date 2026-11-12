Shader "HeatTreatment/InspectionFeatureEdges"
{
    Properties
    {
        _EdgeColor("Structural edge color", Color) = (.48,.62,.68,.65)
        _Opacity("Edge visibility", Range(0,1)) = 1
        _LineWidthPixels("Line width in pixels", Float) = 1.25
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "Queue"="Transparent+1" "RenderType"="Transparent" }
        Pass
        {
            Tags { "LightMode"="SRPDefaultUnlit" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off ZTest LEqual Cull Off
            Offset -1, -1
            HLSLPROGRAM
            #pragma target 4.0
            #pragma vertex Vert
            #pragma geometry Geo
            #pragma fragment Frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            CBUFFER_START(UnityPerMaterial)
                half4 _EdgeColor;
                half _Opacity;
                float _LineWidthPixels;
            CBUFFER_END
            struct Varyings { float4 positionCS : SV_POSITION; };
            Varyings Vert(float4 positionOS : POSITION)
            {
                Varyings output; output.positionCS = TransformObjectToHClip(positionOS.xyz); return output;
            }
            [maxvertexcount(4)]
            void Geo(line Varyings input[2], inout TriangleStream<Varyings> stream)
            {
                if (input[0].positionCS.w <= 0 || input[1].positionCS.w <= 0) return;
                float2 delta = (input[1].positionCS.xy / input[1].positionCS.w - input[0].positionCS.xy / input[0].positionCS.w) * _ScreenParams.xy;
                float2 normal = float2(-delta.y, delta.x) / max(length(delta), .00001);
                float2 offset = normal * _LineWidthPixels / _ScreenParams.xy;
                Varyings v = input[0]; v.positionCS.xy += offset * v.positionCS.w; stream.Append(v);
                v = input[0]; v.positionCS.xy -= offset * v.positionCS.w; stream.Append(v);
                v = input[1]; v.positionCS.xy += offset * v.positionCS.w; stream.Append(v);
                v = input[1]; v.positionCS.xy -= offset * v.positionCS.w; stream.Append(v);
                stream.RestartStrip();
            }
            half4 Frag(Varyings input) : SV_Target { return half4(_EdgeColor.rgb, _EdgeColor.a * _Opacity); }
            ENDHLSL
        }
    }
    FallBack Off
}
