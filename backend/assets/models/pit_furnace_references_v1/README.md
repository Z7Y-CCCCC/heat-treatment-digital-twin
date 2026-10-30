# 井式炉 1～5｜参考图建模

## 当前版本

- 五个编号对应最初提供的五张 CAD 截图，各自独立，不合并成一台设备。
- **井式炉5已按最新要求纠正为有柜体进深的炉子，不是独立门板**：完整的左右保温侧壁、后壁、顶板、底板及纵向承重底座；正面保留彩色参考图的实体前板、中央板件、三道横梁、两侧立柱和顶部弹簧/滑轨。炉体深度暂按 **1.65 m** 估算，不把正视图当成扁平设备，也不只是拉厚门板。
- 井式炉1～4保留各自的炉体、底架/管路/传送机构；前盖按功能分组，可切换查看内部。
- 材质复用既有多用炉 V6 的参数，不照搬 CAD 蓝色、品红、青色等区分色。
- 未提供标注尺寸或俯视图；宽高按图比例，绝对尺寸、深度和不可见细节为估算，不作为制造图。

## 文件

每个 `PitFurnace1`～`PitFurnace5` 文件夹包含：

- `pit_furnace_N_v1.glb`：可直接加载的运行时模型。
- `pit_furnace_N_v1.fbx`：Unity / DCC 交换模型。
- `pit_furnace_N_v1.blend`：对应的可编辑场景与运行时场景。
- `preview.png`：常规外观渲染。
- `cutaway.png`：1～4号为去盖查看；**5号沿用文件名但内容为后侧视图，展示完整柜体的侧壁、后壁和顶板，不拆除主体**。
- `reference.png`：最初的 CAD 截图。5号额外保存 `reference_correction.jpg` 作为优先依据。
- `metadata.json`、`palette.json`、`geometry-validation.json`：估算尺寸、分组、材质和几何验证记录。

`pit_furnaces_1_to_5_editable.blend` 合并五台的最新 EDIT / RUNTIME，共十个场景。通过 Blender 场景下拉框切换；不要同时叠加导入五个原点相同的运行时场景。
其他 `_working.blend` 是分批构建的本地中间文件，不作为五台总包，也不提交 Git。自动 `.blend1` 备份和验证报告同样留在本机；需要验收时重新执行下面的生成/导入步骤。

## Unity

工作区项目 `unity-client` 的 `Assets/Equipment/PitFurnaceReferences` 保存五个独立 Prefab、材质、单台审阅场景及 `PitFurnacesOverview.unity` 五台并排总览。

导出包：工作区 `output/pit-furnace-references-v1.unitypackage`。
目标环境：Unity 2022.3 + URP 14；不包含原 Factory 场景、项目渲染管线设置或运行时业务功能。

在 Unity 中打开总览场景即可查看全部设备。需要重新导入源 FBX 时，使用菜单 `Digital Twin / Pit Furnace References / Import All Five`。1～4号可通过此菜单的外盖显隐功能查看内部；5号没有整块主体的移除开关，其独立审阅场景采用斜侧视图展示柜体进深。

## 重建和验证

**验收范围说明：** 自动验证通过仅表示导出几何、文件同步、Unity 导入和打包完整性正常，**不代表已按 CAD 逐件复核全部部件**。现阶段仍是截图重建稿；原始 CAD 中无法从截图确认的小件、遮挡结构、尺寸及连接方式不得标为已完成。逐件核对结果见工作区 `output/pit-furnace-cad-audit-*.md`。

- 建模：工作区 `tools/blender_build_pit_furnace_references.py`（Blender 5.1，`--background --factory-startup`）。`PIT_MODELS` 选择编号，`PIT_RENDER=1` 输出渲染。
- 合包：工作区 `tools/blender_pack_pit_furnaces.py`，只从每台独立文件加载对应的 EDIT / RUNTIME；旧包备份至 `output/pit-furnace-recovery-backups`。
- 验证：工作区 `tools/verify_pit_furnace_delivery.py`；输出 `output/pit-furnace-delivery-verification.json`。
- Unity 最新柜体版验证日志：`output/pit-furnace-unity-import-cabinet.log`；每台及总览另有 `verification.json` / `overview-verification.json`。

原 Factory 场景、GraphicsSettings 与既有多用炉模型应保持原 SHA-256；基准记录为工作区 `output/pit-furnace-original-hashes.json`。
