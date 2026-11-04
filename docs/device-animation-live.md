# 设备动画实时联动

## 使用

后台 → 模型库 → 动作动画 → **实时联动**。

1. 选现场设备，再选动作。
2. 启用，选择**本设备的采集点位**。BOOL 通常使用 0–1；行程、液位等填写实际量程。
3. “本页试动作”检查模型；“跟随采集”检查实际反馈。点击 **保存并同步** 应用到 Unity。

每台设备分别保存，同型号设备不会共用另一台设备的 PLC 点位。已有模型部件绑定在唯一、精确匹配本设备点位时自动带入，不按名称猜测地址。

- 位置动作：量程线性映射到行程（25% 反馈对应 25% 位移，不套用演示往返的缓动曲线）；首次采样直接呈现观察到的位置，后续变化可设置过渡时间。
- 运行类动作：输入超过量程中点时运行，可调整速度和反向。
- 断线、坏质量、点位缺失或超时：冻结机械位置，停止运行特效；新鲜有效数据恢复后继续。
- 本页试动作仅改变预览，不下发 PLC 指令，也不远程启动设备。

## 范围

已将原 Three.js 的 **9 个型号、42 个 CAD/清洗工艺动作**导出为跨引擎动作包：

| 型号 | 动作数 |
|---|---:|
| 回火炉 09.13.00 | 4 |
| 600 多用炉 08.20.00 | 9 |
| 料车 10.13.00 | 4 |
| 升降备料台 11.14.00 | 3 |
| 固定备料台 11.22.00 | 1 |
| 风冷台 11.58.00HT | 3 |
| 清洗机 17.07.00 | 6 |
| 水冷槽 47.10.00 | 6 |
| 超声波清洗机 CAD | 6 |

另复用模型已有的 **连续转动、角度、位移、显隐、颜色**五类部件绑定。整车沿现场轨道/工位的位移仍使用“设备运动配置”；不要同时用料车 CAD 局部行走和整车轨道位移表达同一次行走。

“设备联动”中的自动工步/物料传送是原有的离线预演，不会被当作现场设备的真实状态。实际多设备协同由各设备采集反馈分别驱动；本次没有生成或下发 PLC 控制程序。现场量程、反馈点和实机行程仍需现场调试。

## 实现与维护

- 动作定义仍由现有 `CadMotionRig` / `CleanerProcessEffects` 维护，**不是再写一套 C# 动画**。
- 编译器导出节点局部位置/四元数/缩放、可见性、颜色和发光轨迹。Web 预览与 Unity 读取同一份采样轨迹；Unity 导入时仅转换 glTF 坐标手性。
- 原始 CAD GLB 不改动。动作 GLB/JSON 在 `backend/assets/motions`，注册表在 `shared/motionPackages.json`，GLB 使用 Git LFS。
- 仅为启用 CAD 动作的设备加载动作模型；同型号共享导入模板，逐台独立信号与播放相位。其他设备保持原模型加载路径。
- 注册表绑定原模型 SHA-256。替换模型文件后不会误用旧动作包；Unity 校验动作 GLB 和 JSON 哈希。
- `GET/PUT /api/devices/:id/animations` 为窄接口：工厂权限、设备点位归属、只读访问、量程、冲突通道、CAS 版本检查。只合并 `instance_config.animationBindings`，不覆盖 PLC、布局或拆解配置。
- 保存通过现有 `configuration_changed` 通道通知 Unity 重新读取配置；不是两个引擎之间逐帧转发画面。

修改动作源后，在**项目根目录**执行：

```powershell
node frontend/scripts/build-motion-packages.mjs
node tools/model-assets.cjs --update
npm --prefix frontend test
node backend/scripts/device-animations-test.cjs
dotnet run --project tools/native-runtime-tests
```

仅重建一个型号可追加 `--model=cad_cleaner_170700`。新动作包、注册表和清单应一起提交。

## 已执行验收（2026-11-03）

- 前端 598 个测试通过；生产构建通过。
- Unity/glTFast 导入全部 8 个动作模型，37 个动作在 0%、37%、100% 的变换、显隐及材质通道通过 **9,091 项**一致性检查。
- 既有/新部件绑定通过 25 项 Unity 原生检查；.NET 运行时测试通过。
- 页面操作验收：逐台绑定、保存、试动作、同型号隔离、未保存切页保护。
- **真实回环 Modbus TCP → 独立采集进程 → WebSocket → Windows Unity 播放器**：门开合终点与动作包一致，泵轴旋转，断线冻结，恢复后反向关闭。
- 测试全部使用隔离数据库和本机协议端点；这不是现场 PLC 已完成调试的声明。没有验证/安装新安装包，没有重启操作员正在使用的大屏。

复现页面验收：设置 `PLAYWRIGHT_MODULE`（Playwright 模块绝对路径）及可选 `BROWSER_EXECUTABLE` 后执行 `node tools/device-animation-ui-test.cjs`。

原生全部动作检查：Unity batchmode 执行 `HeatTreatment.DigitalTwin.Editor.MotionPackageRuntimeChecks.Run`。Windows 播放器构建后执行 `node tools/device-animation-native-test.cjs`；只读诊断仅由该隔离脚本显式启用。

## 参考

参考 CIMPro 的“孪生体动作组件绑定 IoT 数据”组织方式与动作进度控制，并非复制其素材或实现：
[官方孪生体教程](https://cimpro.cn/VideoDetails/EduV1031109097451294720.html)、[官方 Objects API](https://cloud-docs.picimos.com/client-api/Objects)。
