# Windows 部署与原生客户端验收 — 2026-09-30

本报告对应下述验收时点的工作区源码及重新编译的 Windows Unity、AdminHost、Collector 产物。**本次原生验收结束时尚未重新打包，旧安装包不能代表本次修复；后续候选包正在生成，准确状态、散列及打包 smoke 见[候选包报告](release-candidate-2026-09-30.md)。** 本次没有安装、注册、启动或修改系统 SCM 服务，未修改注册表、电源配置或自动登录。PLC 协议联动仅使用自有 loopback S7 测试端点；Collector 生命周期测试则使用模拟引擎。数据库和账号均为 `output/` 下独立夹具。

## 构建与测试证据

主日志目录：`output/native-deployment-audit-20260930/`。

| 验收项目 | 结果 | 证据 / 范围 |
| --- | --- | --- |
| Unity Windows 客户端 | 强制重建成功，最终包含隔离目录及实时收包线程修复 | `unity-build-receive-fix.log`；实际 EXE 与 Managed Assembly 已更新 |
| 原生 WebView2 AdminHost | Release、自包含 win-x64 publish 成功 | `admin-host-build.log` |
| Collector 服务宿主 | Release、自包含 win-x64 publish 成功 | `collector-build.log`；仅 console 实际执行 |
| 桌面进程、恢复、部署配置、资源/依赖缓存 | 34 项通过 | 分文件 TAP 日志；包含新加 Windows 暂时文件锁回归 |
| 桌面日志 | 16 项通过 | `log-manager.log`：异步 gzip、顺序、背压、容量、部分写入与销毁竞态 |
| Native runtime C# | 12 项通过 | `native-runtime-tests-receive-fix.log`：真实 WebSocket 分片、溢出重连、消息快照、会话隔离、取消、来源校验及渲染线程暂停时继续收包 |
| Native inspection C# 合约 | 30 项通过 | `native-inspection-tests.log`：坐标、动画时间线、暂停/反转、归一化与 PLC 配置保留 |
| Native logger C# | 6 项通过 | `native-log-tests.log`：双 writer 共享目录、轮转、容量、磁盘故障恢复、UTF-8、退出排空 |
| Native overlay C# | 42 项通过 | `native-overlay-tests.log`：实际 Windows DirectComposition 根创建/释放，以及 DPI/交互区域、权限与重试策略 |
| Unity Editor 实际运行 | 拾取/拆解 46 项、移动日志 9 项通过 | `InspectionRuntimeChecks.log`、`MotionLoggingRuntimeChecks.log`；不是仅编译 |
| Electron 后端崩溃恢复 | 5 项通过 | `backend-supervisor.log`；本次自行启动的隐藏 Electron、独立 SQLite 后端 |
| WebView2 宿主父进程退出 | 3 项通过 | `admin-host-parent.log` |
| WebView2 页面重试与恢复 | 5 项通过 | `admin-host-retry.log`；真实拒绝连接 → HTTP 503 → admin/overlay 执行成功 → 随父进程退出 |
| 私有 MySQL runtime | 5 项通过 | `mysql-runtime.log`；独立初始化、导入、实际备份、重启持久化、父 IPC 断开清理、既有配置保持 |
| Collector console 进程生命周期 | 四阶段通过 | `collector-console-smoke.log`：真实宿主/MySQL 下首次启动、正常重启、强杀宿主、强杀后重启；模拟引擎持续产帧（simulation、PLC 禁用），Unity 客户端数为 0；MySQL 随自有宿主清理，不是 S7 协议验收 |
| 本轮 Unity 普通客户端 | 20 台真实多用炉 GLB，0 fallback、未见所检查的运行异常 | `native-client-smoke-authorized.log`；隔离目录修复后、最终收包修复前的构建，配置热更新及画质档切换/恢复通过，变更只作用于测试 DB |
| 本轮 Unity 拆解命令与上下文链路 | 四种真实模型共 41 部件通过 | `native-inspection-smoke-authorized.log`；同为最终收包修复前构建，多用炉 15、回火炉 9、清洗机 9、小车 8；HTTP 命令驱动真实 Unity，验证投影标签 visible、点位键关联、隔离、进度暂停、反装配的 237 个上下文回执，未执行鼠标拖动或像素视觉验收 |
| 最新 Unity 真实 20×100 S7 闭环 | 90 秒通过，1 次构建、0 断线、2000 点覆盖，退出清理成功 | `native-load-final.log`；`native-connected-load-20260930T095723309Z-20344-iDuDhZ/result.json` 的 success / stabilityPassed / cleanupComplete 均为 true |

普通客户端详细目录：`output/native-client-smoke-20260930T084824690Z-17628-C1tnmW/`。
拆解详细目录：`output/native-inspection-20260930T084841028Z-22380-ZMVaKk/`，包含 `result.json`、`contexts.json` 与真实 Unity 日志。
Collector console 详细目录：`output/collector-service-smoke-20260930T081641203Z-3568-7qG6eo/`。

## 本轮验收发现并修复

1. **资源发布会因 Windows 暂时锁文件失败。** 第一次依赖缓存测试实际发生 `EPERM`，旧资源发布路径直接 `renameSync`。现在资源准备复用具有异步重试与回滚能力的 `publishDirectory`，并用注入的一次 `EPERM` 验证完整构建不丢失。34 项桌面测试分文件执行全部通过。曾另遇本机 Node 22.13.1 的 `node --test` 子进程 IPC 反序列化错误；相同测试直接逐文件执行正常，保留两次失败日志，没有将其算为通过。
2. **旧 Unity smoke 缺少当前版本的真实登录握手。** 首次运行卡在“等待后台账户授权”。测试现在为独立后端创建测试账号，正常请求一次性 native-ticket，再使用当前用户的 Unity 命名管道交付。Unity 仍执行真实票据交换及 HTTP/WS 会话认证，没有增加生产授权绕过。拆解测试的观察 WebSocket 同样携带真实会话 cookie。
3. **Unity 自行启动 AdminHost 时没有沿用隔离用户目录。** 现在 Unity 遵守 `APP_USER_DATA_DIR`，与 Electron 壳保持一致；未设置时保留既有默认目录。修复后强制重建并重新运行实际客户端。首次失败 smoke 曾启动默认 AppData WebView 目录；后端始终是独立端口/数据库，未访问实际现场 PLC。此事实保留在报告中。
4. **通用 seed 只设置全局 simulation，但工厂设置可覆盖它。** 后端测试代理已同时修正 `factory_settings.data_mode`；S7 压力夹具再显式启用自有 loopback 集成采集。修复前 smoke 为 integrated_plc / 0 启用设备，不能算作模拟采集通过；修复后日志确认 20 台 simulation。
5. **Collector console 默认申请进程电源保持。** 增加仅与 `--console` 同用时生效的 `--no-power-request`，供隔离验收避免影响电源；SCM 生产启动仍保留原有电源请求行为。此轮未验证 Windows 电源保持效果。
6. WebView2 重试测试输出由 `tmp/` 改为经 `createRunDirectory` 校验的 `output/`。测试中需要临时文件的 C#/Node 小套件也将 TEMP/TMP 指向独立 `output/` 子目录。

## 20 设备 × 100 点端到端负载

普通客户端 smoke 已确认 20 个真实模型实例，但其默认模拟器输出固定信号集合，**不能因此证明 2000 个实际点位的吞吐**。已增加 `tools/native-connected-load-smoke-test.cjs`，要求接入已经运行的独立 20×100 S7 夹具，断言配置与实际观察 WebSocket 都有全部 2000 点，采集最新 Unity 的加载/稳定 CPU 与内存。点位值/quality 的逐点正确性由同一个 S7 后端夹具独立核对；观察 WebSocket 的覆盖率不冒称 Unity 内部逐点值断言。

### 首次失败、根因与回归

- 原 `output/native-connected-load-20260930T091316484Z-31636-oGewt0/` 的 90 秒日志有 7 次整厂 ready，说明多次自动重载。旧脚本遗漏稳定连接断言，写出的 `success:true` **无效，不能作为稳定性或内存基线**；原产物保留。
- 加连接级异常日志后，`output/native-connected-load-20260930T094441905Z-28716-TIA3AL/` 在 30 秒内再次发生 4 次 ready / 3 次传输异常，入站队列为 0。新断言正确写出 `success:false` 并非零退出，完整日志为 `native-load-reconnect-diagnostic.log`。
- 根因中已验证的阻塞是 `ReceiveAsync` 捕获 Unity `SynchronizationContext`：网络收取、JSON 解析与入队必须等渲染帧回调。新增实际 loopback WebSocket 回归，在暂停渲染上下文时旧代码必然失败（`native-render-context-regression-before.log`）。现在只对接收等待使用 `ConfigureAwait(false)`，I/O 线程继续收取并写入原有容量受限队列，`Update` 仍是唯一把消息交给场景的入口；连接建立/重连生命周期仍留在原上下文。未提高队列限额、未取消断线权威重同步，未改变采集周期、FPS、画质、模型或动画。
- 修复后 12 项原生 C# 检查全部通过，包括原有溢出重连、可靠控制/坏质量顺序、会话隔离、取消/重启竞态与新增渲染上下文回归。服务端补充单次关闭 code/reason/queue failure 日志；旧日志没有这些字段，因此不虚构首次关闭的具体限额种类。
- 稳定性断言现在要求只开始并完成 1 次整厂构建，传输异常数必须为 0；同时保留 20 个真实模型、0 fallback、0 运行异常、全部 2000 点覆盖和持续数据帧断言。

修复后的第一段 180 秒运行（`output/native-connected-load-20260930T095136440Z-28960-ZHMTgy/`）已实测 1 次整厂构建、0 传输异常、7555 帧、全部 2000 点；Unity private bytes 为 413077504 → 415121408，增长约 1.95 MiB。但随后自有 Unity 退出观察超过旧脚本 5 秒上限，命令退出非零；该段仅作为**稳态运行证据，不作为完整脚本通过**。当前 PID 已确认退出，后端 09:54:52Z 的 Unity 关闭发生在测试 09:54:46Z 主动结束观察 WebSocket 之后。旧 `result.json` 的 success 字段未纳入清理，仍保留原状并在这里纠正。测试已改为清理全部结束后才落盘最终 success，失败记入 `cleanupErrors`；此负载测试退出观察预算为 20 秒，生产监督默认值不变。

### 最终完整闭环

`output/native-connected-load-20260930T095723309Z-20344-iDuDhZ/` 使用最终重建的 Unity 与 `output/plc-native-fixture-20260930T094905563Z-2176-OfaD8u/` 的 20 个真实 loopback S7 TCP 端点，每台 100 个 BOOL/WORD/REAL 混合点，原 500 ms 周期。夹具约 774 秒内完成 773 次逐秒全 2000 值/quality 核对，badSamples=0、后端重启=0，最终 result.success=true 且清理后 exit 0。未再重复或冒称新的三分钟后端性能验收。

| 指标 | 最终实测 |
| --- | --- |
| 运行/清理 | 90 秒稳态；命令 exit 0；success、stabilityPassed、cleanupComplete 全为 true，cleanupErrors 为空 |
| 场景/传输 | 开始构建 1 次、完成 1 次、传输异常 0；测试自有 Unity/AdminHost 进程已退出 |
| 模型/数据 | 20 台真实多用炉完整几何，0 fallback / 0 运行异常；观察 WS 4007 帧、20×100=2000 个 pointMeta |
| 加载 | 4796 ms 到整厂 ready |
| Unity private memory | 稳态开始 414056448 bytes、结束 413986816 bytes（约 394.88 → 394.81 MiB）；峰值 414126080 bytes |
| Unity resident memory | 稳态 RSS 峰值 272773120 bytes（约 260.14 MiB） |
| Unity CPU | 单核归一化 27.28%，8 逻辑核整机口径 3.41%；不包括后端/PLC 模拟器 |
| 渲染 | GTX 1050 Ti，D3D11，1600×900 batch player，原 balanced 画质及完整模型；没有降低原目标 FPS 或采集周期 |

这只是本机短时实际链路验证；不代表 72 小时耐久、现场网络、最终大屏分辨率 FPS 或尚未采购电脑的性能认证。测试结束后通知自有 S7 夹具退出，未触及现场 PLC、生产数据库或 SCM。

本机：Intel Core i5-8300H（4 核 / 8 线程）、约 16 GB RAM；实际 Unity D3D11 日志选择 NVIDIA GTX 1050 Ti（4004 MB VRAM，驱动 32.0.15.8228），另有 UHD 630。详细硬件只读记录为 `machine-cpu.json`、`machine-memory.json`、`machine-gpu.json`。这台开发机的数据不代表尚未采购的现场电脑，不构成 72 小时耐久验收。

## 最新产物与复测方式

- Unity：`unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe`
- 宿主：`unity-client/Builds/Windows/AdminHost/HeatTreatmentAdminHost.exe`
- 服务 console：`desktop/.cache/collector-service/HeatTreatmentCollector.exe`
- S7 → Unity 联动：`node tools/native-connected-load-smoke-test.cjs http://127.0.0.1:<隔离端口> output/<已存在的S7夹具>`。它不会启动或终止调用方的后端/S7，仅清理自身 Unity、观察 WebSocket 和采样进程。
- 普通客户端：`node tools/native-client-smoke-test.cjs`；自动建立新独立数据库、测试登录、Unity 并清理自有进程。
- 拆解客户端：`node tools/native-inspection-smoke-test.cjs`；使用独立数据库和实际四种模型。
- 服务 console：`node tools/collector-service-smoke-test.cjs desktop/resources --with-host-crash`；使用本次 `.cache/collector-service` 发布产物，独立 MySQL 和测试模板副本。

供真实 GUI 操作时，启动 Unity 前将 `APP_USER_DATA_DIR` 指向独立 `output/` 目录，并设置 `DIGITAL_TWIN_BACKEND_HTTP_URL=http://127.0.0.1:<隔离端口>`、`DIGITAL_TWIN_BACKEND_WEBSOCKET_URL=ws://127.0.0.1:<隔离端口>/ws`。使用该隔离后端账号在原生后台登录；不要向生产环境注入测试票据。

## 明确未覆盖

- 本次原生验收结束时未重打 NSIS 安装包，未用旧 `win-unpacked` 代表当前版本；后续[候选包报告](release-candidate-2026-09-30.md)正在生成，打包成功也不等于已执行安装器或 SCM 验收。
- 未在 SCM 注册/安装服务，未验证管理员提权、安装/升级/卸载、系统启动后无人登录、SCM 恢复策略、开机自启、自动登录或断电重启。
- console 的 Job Object 强杀清理已真实验证；它不等价于 SCM/断电验收。
- 未修改或验证现场电源策略；本轮 console 显式不申请电源保持。
- 未访问现场 PLC、真实业务数据库；尚未采购的现场设备性能、网络抖动以及长时间稳定性需在确定硬件后另验。
- 普通客户端 smoke 使用 960×540；拆解及联动负载使用 1600×900。它们不是现场大屏最终分辨率的 FPS 认证。
