# 井式炉车间 CAD 视觉复原

参考用户标注的 1–17 号侧剖面截图。**没有 CAD 原文件、尺寸标注或平面图：米制尺寸、基坑深度及前后间距均为估算，不可用于施工。**

## 交付布局

- 工厂 `factory_pit_furnaces_v1`，车间 `ws_pit_furnaces_v1`，产线 `line_pit_furnaces_v1`。
- 车间估算 64 × 18 米；地面标高 0，工业硬边基坑，不使用山坡式地形。
- 17 个对象：9 个现有炉型实例，8 个辅助设施实例。原有五台设备 ID、模型、PLC 和点位绑定保留。
- 9 个随设备负标高生成的基坑，另有 1 个料台共用基坑（标高 -4.8 米）。修改炉体高度后，其自动基坑跟随；料台共用基坑由地面面板独立编辑。

| CAD 编号 | 使用模型/设施 | 标高（米，估算） |
| --- | --- | --- |
| 1、2 | 井式炉 1、4：左右地上主机 | 0 |
| 3 | 井式炉 2 | -4.65 |
| 4 | 井式炉 5 | -4.65 |
| 5、6 | 井式炉 3 | -4.35 |
| 7–9 | 井式炉 2 | -4.65 |
| 10–12 | 新建工装料台 A/B/C | -4.4 |
| 13 | 新建底部移载框架 | -4.8 |
| 14、15 | 新建冷却暂存料台 | -4.4 |
| 16 | 新建环件堆料架 | -4.7 |
| 17 | 新建循环罐与泵组 | -4.65 |

5 种新 GLB 资产包含立柱、斜撑、横梁、滚轮/格栅、连接板、螺栓、空心环件、泵及管路；共约 1.2 MB。不为静态设施伪造 PLC 或导轨绑定。生成源保留在 `tools/blender_build_pit_workshop_aux.py`，资产在 `backend/assets/models/pit_workshop_aux_v1/`。

## 实际试用中修复

1. Three 现场预览错误地要求所有辅助设备绑定导轨，导致 8 个静态辅助对象不显示。现在显式放置的静态对象保留独立 XYZ；待放置对象、失效导轨绑定和料车仍按原规则处理。
2. 长产线镜头仅按设备中心估算范围，裁掉端部模型。现在按实际包围盒、负标高、视场角与宽高比计算完整视图。

## 验收（2026-11-02）

- 前端单元测试：469 通过；前端生产构建通过。
- 隔离后端重复应用不增加设备，不重复上传未变化模型，原有配置保留。
- 隔离浏览器：17 对象、10 种 GLB 实际加载；设备负标高和共用基坑编辑、保存、重载通过，无浏览器错误。
- 本机项目 MCP：核对 17 台对象参数、名称同步不改变 PLC/点位、5 个新增资产下载字节与源 GLB 一致。
- 原生预览接口 + WebSocket：切到该车间，`sceneReady=true`，17 对象可见，全部设备投影锚点在镜头内。原生日志确认 `fallback=0`，10 个地面区域。
- Blender 复核图使用相同 GLB、变换及共享地面网格。编号剖视图移除了前侧地面以便对照 CAD，**这是复核视图，不是大屏新增剖切功能**。

测试入口：`tools/pit-cad-layout-test.cjs`、`tools/pit-cad-layout-ui-test.cjs`、`tools/pit-cad-mcp-verify.cjs`。浏览器测试只操作独立验收环境；本机核验通过已授权 MCP/原生接口，不依赖 Computer Use。

## 重建与应用

```powershell
# 在仓库根目录执行；Blender 限制线程，避免挤占正在运行的大屏。
& 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe' --background --factory-startup -t 4 --python-exit-code 1 --python tools/blender_build_pit_workshop_aux.py
node tools/pit-cad-layout-test.cjs

# 管理员授权的后台会话提供 ADMIN_API_TOKEN；勿把值写入命令、仓库或日志。
$env:PIT_CAD_ORIGIN = 'http://127.0.0.1:3001'
node tools/apply-pit-cad-layout.cjs
node tools/pit-cad-mcp-verify.cjs --sync-names --navigate
```

布局源为 `tools/model-profiles/pit-workshop-cad-layout.json`。应用脚本会覆盖目标产线几何布局和目标车间地面；先保存编辑。遇到额外设备或原设备型号不符会停止，不自动删除用户设备。模型按内容哈希复用，设备变换使用窄接口。

每次应用将前后快照写入忽略的 `output/pit-cad-layout-*/`，其中可能包含现场连接信息，不上传。首次应用前、仅有原五台设备的本机备份为 `output/pit-cad-layout-20261102T012242305Z-9308-SETqOc/before.json`。后续快照已包含 CAD 布局，不可当作原始状态。需要回滚时先停止编辑，使用该快照逐项恢复变换/地面，仅删除本次新建且确认未被后续使用的对象；不要整库覆盖或重置 PLC。
