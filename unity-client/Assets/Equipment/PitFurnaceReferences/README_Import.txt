井式炉参考模型 1–5

环境要求：Unity 2022.3 LTS，Universal Render Pipeline (URP) 14.x。导入包不含 URP 包、Factory 场景或项目设置。
将 unitypackage 导入已配置 URP 的项目，打开 Assets/Equipment/PitFurnaceReferences/PitFurnacesOverview.unity 查看五台独立设备。
五个 PitFurnace1–5 文件夹各含独立 FBX、Prefab、材质、单台审阅场景和验证报告。所有模型保持米制估算比例，不代表实测工程 CAD。
井式炉1–4可选中实例或子物体，通过 Digital Twin > Pit Furnace References > Toggle Selected Furnace External Covers 切换外盖。支持撤销，不改源 Prefab。井式炉5为完整厚柜式炉体，保留侧壁、后壁、顶底及正面机构，不作为独立门板。
总览从左到右为井式炉1–5，设备之间至少间隔1.5米；没有把五台拼成一台。
批量重建入口：HeatTreatment.DigitalTwin.Editor.PitFurnaceReferenceImport.Build。
