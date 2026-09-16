# 设备实拍建模审查与多用炉 V6 样板

日期：2026-09-05。审查依据为工作区现场照片、既有 V4/V5 预览及 GLB/元数据检查。

后续进展（2026-09-06）：小车、回火炉、清洗机也已完成独立 V6 重建与回读验证，详见 `docs/model-photo-review-three-equipment-v6.md`。以下保留第一轮多用炉样板的范围与记录。

## 范围与准确性

- 本轮只制作**多用炉 V6 独立样板**；回火炉、清洗机、小车仅审查，模型未改。
- 保留原 V4/V5 文件，不替换生产模型配置、不切换线上资产；V6 处于评审阶段。
- 照片没有标尺，且存在透视、遮挡及不可见内部。本次是照片参考的外观重建，不声称尺寸、遮挡面或内部达到 CAD/制造准确度。内部与运动示意须同实测结构区分。
- 优先修正轮廓、体量和结构关系，再处理材质与小零件；不以增加螺丝数量代替相似度修正。

## 照片证据与高优先级差距

以下路径均相对工作区根目录。

### 多用炉

照片：`多用炉/mmexport1783325195041.jpg`、`多用炉/mmexport1783325193551.jpg`。对比 `backend/assets/models/photo_multipurpose_furnace_v5_preview.png`。

1. 实拍前端为连续封闭的斜罩外壳；V5 顶部存在突出的开放斜板和重复标牌，罩体轮廓失真。应重建完整斜罩、统一标牌，并保留罩底合理开口。
2. 实拍炉口有门框、密封边和可读的内部深度；V5 门区重叠框线使结构含混。应明确一套可动前门、固定门框和真正通向前室的开口。
3. 实拍黄色检修平台沿炉体侧面展开，带踢脚板、连续护栏和多根斜撑；V5 平台过短。侧面的多层仪表管路、驱动和宽控制柜也应按照片分区，而非均匀重复摆放。

### 回火炉（本轮未改）

照片：`回火炉/mmexport1783325206255.jpg`、`回火炉/mmexport1783325201991.jpg`。对比 `backend/assets/models/photo_tempering_furnace_v4_preview.png`。

1. 顶罩应有明显倾斜正面、外挑下缘及短烟口；V4 的直角大箱体和高直筒首先需要纠正。
2. 炉门应是宽大的单片深色圆角门板，配左右升降导向、底部两只 U 形支架和浅托盘；V4 密集横档/铆钉框架过于抢眼。
3. 侧壳应使用同色凸起加强筋和宽面板；平台增加踢脚板、斜撑，后端爬梯补照片可见的弧形护笼。

### 清洗机（本轮未改）

照片：`清洗机/mmexport1783325199288.jpg`、`清洗机/mmexport1783325196484.jpg`。对比 `backend/assets/models/photo_washing_machine_v4_preview.png`。

1. 先恢复下部水箱、上部高腔体及前端黑色斜罩的上下两级体量；V4 矮箱体加顶平台与实拍轮廓差异显著。
2. 侧面为宽大的双门控制柜，带屏幕、百叶与门缝；不是窄立柜。柜外侧可见高大的绿色倒 U 形立管。
3. 底部蓝色泵组大小与布局应有所区别，连接绿色弯管和法兰；应核对 V4 等尺寸重复模块及显眼白筒的照片依据，避免虚构外露设备。

### 小车（本轮未改）

照片：`小车/mmexport1783325210390.jpg`、`小车/mmexport1783325207583.jpg`。对比 `backend/assets/models/photo_transfer_cart_v4_preview.png`。

1. 高立板正面有长环形分段链路/导向机构，背面有大型立式减速电机；V4 黑平板加横向圆块遗漏了主要识别特征。
2. 恢复中层矩形开框、银色手轮、黑色卷盘及下部驱动，使骨架空透关系清楚；减少厚实底板造成的实心感，并核对滚筒输送结构。
3. 控制柜采用斜顶、多排按钮和门锁，黄栏杆补圆弯头及回转端；走台花纹优先用轻量材质表达。

## V5 技术问题

- 全 GLB 实际为 **53 nodes、51 meshes、38 materials、33,136 triangles**，包含额外的 `Cube`。旧 `_report.json` 的 50 个 mesh、37 个材质、33,124 三角形并非完整导出文件统计，不能直接用作交付验收。
- 元数据声明 `Y-up / Z-forward`，但两只风扇和四根搅拌轴这 **6 个竖直旋转部位**的 `rotate_speed` 仍写作 `axis: "z"`；按导出后的 Y-up 坐标应绑定 `axis: "y"`，并检查节点局部变换。
- 需要按功能保留可动部件及固定外壳边界，避免仅按材质合并后影响开门、旋转、透视或拆解。

## 多用炉 V6 样板改进

本轮改进内容以最终导出与下节验收结果为准：

- 按固定外壳、前门、旋转部件、平台及仪表等功能组织节点；动画目标保持独立，外壳透视和拆解不依赖整机按材质混合。
- 建立单套前门及真实炉口/前室深度；开门后不应仍被另一张实心门板封住。
- 重建连续封闭的斜罩外壳，清理重复或漂浮板件、重复标牌与无关 `Cube`。
- 将黄色平台延展为侧面长平台，补连续护栏、踢脚板与斜撑，改善设备大轮廓。
- 校正 6 个竖直旋转绑定的 Y-up 轴向，并将元数据节点引用与实际 GLB 一一核对。

## 独立输出

- Blender：`backend/assets/models/photo_equipment_models_v6_study.blend`
- GLB：`backend/assets/models/photo_multipurpose_furnace_v6.glb`
- 预览：`backend/assets/models/photo_multipurpose_furnace_v6_preview.png`
- 仪表侧预览：`backend/assets/models/photo_multipurpose_furnace_v6_instrument_side.png`
- GLB 回读、全开门试渲染：`backend/assets/models/photo_multipurpose_furnace_v6_runtime_check.png`
- 元数据：`backend/assets/models/photo_multipurpose_furnace_v6_metadata.json`
- 验收报告：`backend/assets/models/photo_multipurpose_furnace_v6_report.json`

## 验收记录

- V6 全 GLB：**104 nodes / 82 meshes / 18 materials / 121,211 triangles / 4,971,248 bytes**。低于项目 200,000 三角面、800 节点预算。新增真实穿孔、完整机械轮廓后，面数高于 V5；不是减面版。
- 输出已生成；GLB 重新导入 Blender 后仍为 104 个对象、121,211 三角形，包围盒最大偏差为 0。`.blend` 保留可编辑场景 `V6_PHOTO_STUDY` 和独立导出场景 `V6_RUNTIME_EXPORT`；原 V4/V5 参考资产在各自旧文件中保留。
- GLB 只有一个设备场景/根节点，无 Cube、相机、灯光和外部资源 URI。8 个元数据绑定均唯一且可解析；壳体、柜体、仪表、固定电机壳与运动组分开。966 个可编辑部件已按功能与材质整合为 82 个导出网格。
- 前门全开时射线由命中前门转为命中内侧中门，未残留重复静态门板。调整内置门位置、顶部导槽及罩体下部开口后，两扇门各取 11 个行程样本，均低于斜罩内顶；最小计算间隙约 55.6 mm / 361.5 mm（仅为估算模型内部数值，不是实测）。
- 两只风扇和四根搅拌轴均使用 GLB 局部 Y 轴；回读 Blender 后绕 Z 轴旋转 90°，轴的高度范围不变，固定电机壳未移动。实际大屏/Unity/PLC 联调尚未进行。
- 已复核操作侧、仪表侧及 GLB 全开门渲染：封闭斜面罩板、空心烟口、带斜撑的长平台、完整电柜、差异化电机、真实穿孔护罩与分层仪表管路已落地。剩余差距是缺少实测尺寸、部分遮挡部位按示意处理、尚未表现现场使用痕迹；不能作为工程制造依据。
- 原 V4/V5 与生产配置未替换；V4 `.blend` / GLB 的 SHA-256 与既有清单一致。工作区原有 `desktop/THIRD_PARTY_NOTICES.txt` 改动保持未动。

验收通过仅表示本轮样板导出与上述检查成立，不等同于已经完成生产系统集成、全部设备升级或实测 CAD 校准。

## 重建与复核

在工作区执行，要求 Blender MCP 正在本机 9876 监听：

```powershell
python tools/blender_mcp_client.py --timeout 240 --script tools/blender_build_multipurpose_furnace_v6.py
python tools/blender_mcp_client.py --timeout 240 --script tools/blender_verify_multipurpose_furnace_v6.py
python tools/validate_equipment_glb.py backend/assets/models/photo_multipurpose_furnace_v6.glb --metadata backend/assets/models/photo_multipurpose_furnace_v6_metadata.json
```

第一条重建本脚本自己的 V6 场景、GLB、元数据和双侧预览；第二条执行隔离回读、开门与旋转验证并生成全开门图；第三条只读复核导出结构和预算。不要把评审资产直接替换到已发布版本。
