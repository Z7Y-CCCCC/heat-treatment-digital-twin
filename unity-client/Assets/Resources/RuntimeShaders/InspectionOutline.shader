Shader "HeatTreatment/InspectionOutline"
{
    Properties
    {
        _OutlineColor("Outline color", Color) = (1,1,1,1)
        _OutlineWidthPixels("Outline width in pixels", Float) = 2.4
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Transparent" "Queue"="Transparent+20" }
        Pass
        {
            Name "InspectionSilhouette"
            Tags { "LightMode"="SRPDefaultUnlit" }
            Cull Front
            ZWrite Off
            ZTest LEqual
            Blend SrcAlpha OneMinusSrcAlpha
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            CBUFFER_START(UnityPerMaterial)
                half4 _OutlineColor;
                float _OutlineWidthPixels;
            CBUFFER_END
            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
            struct Varyings { float4 positionCS : SV_POSITION; };
            Varyings Vert(Attributes input)
            {
                Varyings output;
                float3 world = TransformObjectToWorld(input.positionOS.xyz);
                output.positionCS = TransformWorldToHClip(world);
                float3 normalWS = TransformObjectToWorldNormal(input.normalOS);
                float3 normalVS = mul((float3x3)UNITY_MATRIX_V, normalWS);
                float2 normalCS = mul((float2x2)UNITY_MATRIX_P, normalVS.xy);
                normalCS /= max(length(normalCS), .0001);
                output.positionCS.xy += normalCS * (2 * _OutlineWidthPixels / _ScreenParams.xy) * output.positionCS.w;
                return output;
            }
            half4 Frag(Varyings input) : SV_Target { return _OutlineColor; }
            ENDHLSL
        }
    }
    FallBack Off
}
