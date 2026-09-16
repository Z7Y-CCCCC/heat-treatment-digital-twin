# 小车、回火炉、清洗机 V6 建模交付

日期：2026-09-06。三类设备已按工作区实拍照片完成独立 V6 外观重建、GLB 导出与 Blender 回读检查。与先前多用炉 V6 保持同一工业材质风格。

后续纠正：用户指出清洗机 V6 漏了后半部低箱，已另做 V7。清洗机最新轮廓修正见 `docs/model-washing-machine-v7-rear-correction.md`；本文件与 V6 总览保留为历史交付记录。

## 范围与限制

- 不覆盖 V4/V5，也不覆盖先前的多用炉 V6 独立文件。新完整工程为 `backend/assets/models/photo_equipment_models_v6_complete.blend`。
- 没有修改生产模型配置、数据库、PLC 映射或发布版本。元数据的 `runtime.enableGenericBindings` 保持 `false`；动作节点可独立操作，但信号字段、单位、正负方向及行程需要现场确认后再启用。
- 尺寸来自透视照片估算，不是测绘/CAD 数据。不可见炉内、泵内轴、局部传动及管线端接为外观示意；不能用于设备制造或指导接管。
- 本次优化以轮廓和机械结构为主，不声称还原全部现场污渍、铭牌文字或遮挡细节。

## 主要改进

### 取料小车

依据 `小车/` 下三张现场照片，恢复黑色开放焊接框架与窄走台，保留机座中部的空透关系；不再使用整床均布滚筒的通用输送台外形。

- 加入高背板的双层长环形链/导向、背面立式减速机、下层行走驱动与电缆卷盘。
- 两只银色三辐手轮、斜顶多排按钮柜、圆弯头黄栏杆、底脚及低面数走台花纹。
- 承料区由双纵导轨和送料端三只局部滚筒组成；遮挡区与滚筒数量仍需实测确认。
- 轨道是独立静态组；整体横移父组下保留送料、轮轴、滚筒、卷盘的嵌套动作节点。链节目前是静态外观，没有模拟真实链条闭环或传动比。

### 回火炉

依据 `回火炉/` 下六张照片，重建有明显倾斜正面的集气罩、短空心烟口、厚浅灰壳体和同色突出加强筋。

- 炉门改为单片真实圆角黑色门板，保留双 U 形下附件、升降导向和浅托盘。
- 炉口为真实凹入空腔；可动门及附件为同一独立组，没有第二张静态门板挡住开口。
- 加入带踢脚板和斜撑的长侧平台、护笼爬梯、驱动电机、完整控制柜及服务管线。
- 修正检查中发现的上限位座位于门行程中间的问题，将它移至导轨端部；全开门不穿出集气罩。

### 清洗机

依据 `清洗机/` 下三张照片，恢复下部大水箱、上部高竖腔、前端黑色斜罩的两级体量，不沿用 V4 的矮柜加顶部平台造型。

- 侧面为宽双门电柜，带双屏、百叶、门锁、底部线槽及叠层信号灯。
- 泵组为一大三小蓝色泵，配绿色倒 U 主管、法兰、弯头、支管和高侧黄色传动护罩。
- 提升门仅保留一套；门侧腔壁和底部承料导轨切分出实际门槽，解决门边和门底与固定件相交的问题。
- 罩上铭牌贴合斜面，补齐原来悬空的高位阀管端接。四个泵仅转动独立轴，不带动泵壳。
- 将空间不足的泵入口双急弯改为短轴向吸水接管，扩大主管入壳弯的可用长度，高阀支管采用与返回管匹配的管径与弯路；消除短弯内侧回折，不用法线重算掩盖几何问题。

## 导出统计与验收

全部以最终 GLB 文件统计，不只统计 Blender 源对象。

| 设备 | 三角面 | 节点 | 网格 | 材质 | 文件字节 | 动作节点 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 取料小车 | 55,392 | 84 | 67 | 18 | 2,600,764 | 8 |
| 回火炉 | 68,495 | 81 | 65 | 19 | 2,898,412 | 3 |
| 清洗机 | 56,622 | 86 | 70 | 18 | 2,557,948 | 5 |

三个模型均低于项目单设备 200,000 三角面、800 节点的默认预算。共 16 个独立动作节点，不等同于已完成生产信号接入。

已完成：

- 每个 GLB 为单场景、单设备根，所有节点均位于设备根下；不含默认 Cube、相机、灯光或外部资源 URI。
- 静态件按功能组和材质合并，嵌套动作组保留；仅外壳组参与外壳透视，不将电柜、固定泵壳一并混入。
- 针对旧几何辅助函数的面绕序问题，在新公共流程中为封闭流形几何重新统一朝外法线；没有修改旧模型文件。
- 三个 GLB 均重新导入隔离 Blender 场景，节点和三角面数与报告一致，包围盒最大偏差为 0。
- 三个最终 GLB 的二进制几何审计通过：非有限坐标/法线、非单位法线、退化三角面、面绕序与平均顶点法线反向均为 0。阈值与逐网格结果保存在各 `_report.json` 的 `geometry_audit` 中。
- 对每个绑定进行平移或 90° 旋转，非目标组几何保持静止；小车整体横移不带动轨道。
- 回火炉与清洗机分别在门行程的 0%～100% 取 11 个位置，用三角网格 BVH 检查门与固定几何的表面相交，均为 0；中央射线确认闭门遮挡、开门后可通向内部。该离散几何检查不替代连续机构仿真或现场安全验收。
- 已检查正面、背面/控制侧，以及 GLB 回读后的全开门图；没有替换或启动生产大屏联调。

## 文件与场景

完整工程：`backend/assets/models/photo_equipment_models_v6_complete.blend`。

| 内容 | Blender 场景 |
| --- | --- |
| 小车可编辑 / 导出 | `V6_CART_EDIT` / `V6_CART_RUNTIME` |
| 回火炉可编辑 / 导出 | `V6_TEMPER_EDIT` / `V6_TEMPER_RUNTIME` |
| 清洗机可编辑 / 导出 | `V6_WASH_EDIT` / `V6_WASH_RUNTIME` |
| 三台总览（只作展示） | `V6_THREE_EQUIPMENT_OVERVIEW` |
| 先前多用炉 | `V6_PHOTO_STUDY` / `V6_RUNTIME_EXPORT` |

编辑建模请进入各 `*_EDIT` 场景。总览使用导出网格的独立展示副本，不作为重新导出的建模源。

三个文件前缀分别为：

- `backend/assets/models/photo_transfer_cart_v6`
- `backend/assets/models/photo_tempering_furnace_v6`
- `backend/assets/models/photo_washing_machine_v6`

每个前缀都有 `.glb`、`_metadata.json`、`_report.json`、`_preview.png`、`_rear.png` 和 `_runtime_check.png`。小车另有 `_chain_side.png`，回火炉另有 `_controls.png`。总览为 `backend/assets/models/photo_equipment_models_v6_three_overview.png`。

## 重建与复核

Blender MCP 在本机 9876 监听时，从工作区运行：

```powershell
python tools/blender_mcp_client.py --timeout 240 --script tools/blender_equipment_v6_common.py
```

该入口依次重建三台设备、导出、渲染、回读验证并保存新完整工程。它不会自动加载旧多用炉文件；如需完整工程同时保留先前多用炉，请先在 Blender 打开已交付的 V6 工程再执行。

纯只读导出检查示例：

```powershell
python tools/validate_equipment_glb.py backend/assets/models/photo_transfer_cart_v6.glb --metadata backend/assets/models/photo_transfer_cart_v6_metadata.json
python tools/validate_equipment_glb.py backend/assets/models/photo_tempering_furnace_v6.glb --metadata backend/assets/models/photo_tempering_furnace_v6_metadata.json
python tools/validate_equipment_glb.py backend/assets/models/photo_washing_machine_v6.glb --metadata backend/assets/models/photo_washing_machine_v6_metadata.json
python tools/audit_equipment_glb_geometry.py backend/assets/models/photo_washing_machine_v6.glb
```

每次重建会替换脚本自己标记的 V6 场景。手工修改这些场景前请另存分支版本，避免后续重建覆盖手工调整。
