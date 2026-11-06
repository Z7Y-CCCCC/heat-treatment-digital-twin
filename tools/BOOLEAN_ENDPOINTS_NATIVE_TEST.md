# 两个到位开关量：Unity 实际播放器验收

此验收只使用已有的“推料到位”“退回到位”，不启动采集器、不连接 PLC，也不改正在使用的数据库或安装版播放器。

## 运行方式

先将当前源码构建到本项目 `output` 下的独立播放器目录，不能使用安装目录回退：

```powershell
$env:MOTION_TEST_UNITY_EXE = 'C:\Users\27323\OneDrive\Desktop\大屏\output\隔离构建目录\client\HeatTreatmentDigitalTwin.exe'
node 'C:\Users\27323\OneDrive\Desktop\大屏\tools\boolean-endpoints-native-test.cjs'
```

需要实际窗口截图时使用 `--hold`。它先完成自动断言并核实非零 `MainWindowHandle`，再打印 `HELD_READY` 与 `held-session.json` 路径，保留本次创建的可见播放器及后台，供操作同一个窗口和只读测试信号。在该测试输出目录创建 `finish.request` 文件，或发送 `finish` 加换行到此脚本 stdin 后退出；20 分钟无人结束也会自动清理本次创建的进程。绝不关闭其它 Unity 或后台。

```powershell
node 'C:\Users\27323\OneDrive\Desktop\大屏\tools\boolean-endpoints-native-test.cjs' --hold
```

`boolean-endpoints-native-server.cjs` 专用于原生验收，`BOOLEAN_ENDPOINTS_INFO_FILE` 指向隔离配置文件；前端浏览器 fixture 使用单独的 `boolean-endpoints-browser-server.cjs`，二者不共享字段或进程。

## 演示与真实反馈边界

| 推料到位 | 退回到位 | 展示行为 |
| --- | --- | --- |
| false | true | 确认退回端点 0% |
| true | false | 确认推料端点 100% |
| false | false | 等待到位反馈，保留最后显示姿态，不猜方向或实际中间位置 |
| true | true | 到位反馈冲突，冻结，不当成两个完成阶段 |

健康反馈确认新的端点后可做配置的平滑**显示过渡**，不能把该过渡当成实测行程。初次读取、坏质量／超时后的恢复直接对齐当前唯一确认端点，不续播断线前的显示计时器。

只有这两个反馈不能确认物料是否真正交接、目标炉是否正确、门是否打开或设备是否实际正在前进。本次不自动转移物料，不输出 PLC 命令，不新增现场点位要求。

## 自动验证内容

- 主模型为真实 `cad_transfer_cart_101300` 的 `feed` 动作，不是替代方块或清洗机。包含推料架、齿轮、回链与工作链的实际 Transform。
- 用实际数据中心保存 API 选择两个不同的只读 BOOL，完整原生通道与同一编译动作包逐采样比对。
- 初始退回、等待、推料显示过渡、推料端点、冲突、坏质量、读取超时和当前反馈恢复。
- 相同设备／模型／动作／数据身份在配置重建和逐型号热更新时保留冻结姿态，避免等待状态误回 GLB 零位；未改动 clip 的显示时钟与条件、未改动持续旋转部件的实际姿态也保留。
- 通过当前“部件动作”使用的 `/api/models/:id/bindings` API 新增钩偏转动作，明确绑定已有数据，再从 30° 修改到 60°；实际本机同一播放器进程自动更新，未使用已移除的“工艺动作”编辑入口。
- 删除该动作后原生驱动确实移除，再明确添加和绑定；快速连续修改按最终权威配置合并。若最后修改回已应用值，则合法 no-op，不替换模型。
- 模型／动作的数据配置事件合并 180 ms 后读取权威 `/api/config`，只替换受影响设备实例，不重建厂房、工厂层级或重置镜头。新模型／驱动准备好前保留旧模型；失败不提交旧模型已被替换的假状态。
- 以真实日志记录并断言工厂 root、环境 root、无关炉子 root、镜头位置／旋转、当前视角与 loading id 均未变，整个验收只出现一次初始 factory ready。
- 只有确实保留全部节点的动作 rig 或可检查模型，才允许在修改部件动作时复用既有几何模板；非全节点保护模型仍根据部件保护配置失效重新导入。每个实例使用最新动作定义，不复用旧 `Template.Asset` 的 bindings。
- 记录源读取 → 首次实际变换、控制值修改 → 首次变换、Unity 接收 → 首次变换；配置新增／绑定／修改所需时间另列。
- 测试前后播放器 exe、`Assembly-CSharp.dll`、原 CAD GLB、动作 rig GLB 和 JSON 的 SHA-256 均不变。

## 2026-11-06 优化前验收记录（保留对照）

- .NET 隔离原生运行时回归：21/21 组通过，其中包含两源独立 TTL、严格 BOOL、错误身份、旧包、冻结与姿态恢复。
- Unity Editor 实际 Transform／缓存／重建姿态确定性检查：154 项通过。
- 第一轮播放器实际运行：9 组通过；同一 Unity PID 为 5608。但该轮没有可见窗口，不能作为截图验收；该自建进程已停止，未影响原现场播放器。
- 原生证据：`C:\Users\27323\OneDrive\Desktop\大屏\output\boolean-endpoints-native-player-20261106T122950940Z-8496-4QpLzX\result.json`。
- 新构建：`C:\Users\27323\OneDrive\Desktop\大屏\output\hall-visibility-20261106T122612440Z-20544-ulP5ce\client`。

16 个实际原生样本：

| 链路 | P50 | P95 | 最大 |
| --- | ---: | ---: | ---: |
| 本次真实源读取时间 → 首次原生 Transform | 11 ms | 23 ms | 23 ms |
| 测试控制修改 → 首次原生 Transform（含 100 ms 采样周期） | 69 ms | 245 ms | 245 ms |
| Unity 接收 → 首次原生 Transform | 2 ms | 6 ms | 6 ms |

本轮链路是隔离只读帧注入，不含真实 PLC 或采集器，不能与 11 月 4 日 PLC 全链路 P95 106 ms 直接进行倍数比较。显示过渡的 2 秒不是网络或处理延迟。

这一优化前版本的动作配置热同步走全场重建：新增约 9204 ms、数据绑定约 923 ms、修改动作约 9276 ms。新增与修改期间厂房也重新导入，不能宣传“瞬时添加”。常规点位更新不走此重建路径。

第一次逐型号验证（`output/boolean-endpoints-native-player-20261106T125059545Z-15848-3kmhsv`）没有通过最终验收，日志与失败结果保留：实际发现动画保存的外层 `configuration_changed resource=devices` 重复触发整厂刷新，且仅更新部件动作仍重新导入同一动作 rig。另快速编辑回原已应用值会合法无变化，验收不应强制要求产生设备替换。后续修复必须以新播放器重新验证，不用删除旧日志掩盖失败。

下一轮（`output/boolean-endpoints-native-player-20261106T125609833Z-13112-xyuAXj`）11 个功能组与非零可见窗口检查通过，factory ready 确实仅一次；源读取 → 首次 Transform 的 P50/P95 为 13/26 ms，控制修改 → 首次 Transform 为 73/109 ms，Unity 接收 → 首次 Transform 为 2/10 ms。纯修改动作已降到约 1357 ms，绑定约 1493 ms，但首次新增仍 9862 ms：后端保存第一／最后一个部件动作会切换 `runtime.enableGenericBindings`，这只是驱动开关却使几何 cache 失效。该轮仍作为未完成性能收敛的中间对照保留，不替代最终结果；该轮自建 PID 392 已通过 `finish.request` 正常结束。

## 2026-11-06 最终逐型号热同步与可见窗口验收

- .NET 原生回归 **22/22**，包括双源独立 TTL、摘要质量、旧包、无关布局不导入、跨厂拒绝、模型尺度比例以及不变动作显示时钟恢复。日志：`C:\Users\27323\OneDrive\Desktop\大屏\output\boolean-endpoints-dotnet.log`。
- Unity Editor 实际 Transform／缓存／冻结姿态检查 **154 项**通过，证据：`C:\Users\27323\OneDrive\Desktop\大屏\output\motion-signal-native-20261106T125153646\result.json`；其后最终几何 cache 源码也经新播放器构建和实际原生运行验证。
- 最终新构建：`C:\Users\27323\OneDrive\Desktop\大屏\output\hall-visibility-20261106T125816129Z-27764-tXYdCf\client\HeatTreatmentDigitalTwin.exe`。
- 实际新播放器 **12/12 组**通过；同一 Unity PID **6408**，`MainWindowHandle = 29625228`，是可见窗口。原现场 PID 23356 保持不变。
- 原生诊断、资产／exe／程序集哈希、前后 root／镜头状态和每个实际通道的证据：`C:\Users\27323\OneDrive\Desktop\大屏\output\boolean-endpoints-native-player-20261106T130135489Z-12344-zTCasw\result.json`。
- 截图用会话：`C:\Users\27323\OneDrive\Desktop\大屏\output\boolean-endpoints-native-player-20261106T130135489Z-12344-zTCasw\held-session.json`。自动验收结束时处于退回端点 0%，显示过渡为 2 秒；新增钩部件动作最大 60°，明确绑定推料到位数据。
- 整轮新增、绑定、修改、删除、重新添加及连续编辑只发生 **1 次初始 factory ready、1 次 CAD rig import**。实际 CAD 推料架／齿轮／链条通道与后台同一动作包逐采样吻合；无关炉子、工厂／环境 root、当前视角及镜头未重置。
- 首次／最后动作保存切换的 `runtime.enableGenericBindings` 已从全节点保护模型的几何 key 中排除，空 driver-only runtime 也归一；其他优化与材质项仍参与 key，非全节点保护模型不忽略部件保护配置。

最终 16 个真实原生样本在后台全量验证结束后、没有并行 Unity Editor 构建时采集：

| 链路 | P50 | P95 | 最大 |
| --- | ---: | ---: | ---: |
| 源读取时间 → 首次原生 Transform | 11 ms | 26 ms | 26 ms |
| 控制修改 → 首次原生 Transform（含 100 ms 采样周期） | 60 ms | 116 ms | 116 ms |
| Unity 接收 → 首次原生 Transform | 2 ms | 4 ms | 4 ms |

动作配置同步实测：**新增 1439 ms、绑定 1951 ms、修改 1330 ms**。这是约 1–2 秒的实际配置刷新，不是“零延迟新增”；配置时间采集时还有隔离后端验证工作，不能将它当成严格性能上限。与旧版约 9 秒新增／修改相比，本次已避免整厂重建和同一 rig 重导入，普通点位更新仍走低延迟实时路径。

这些延迟来自 **100 ms 隔离只读注入 → 后台 motionInputs → 真实 Unity Transform**，不包含真实 PLC／现场网络／采集器，不能宣称是现场 PLC 全链路 26 ms。显示用的 2 秒过渡不计入网络或首次变换延迟，也不代表现场实际中途位置；所有断线／未知反馈规则保持前述边界。
