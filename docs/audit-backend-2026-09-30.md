# 后端功能与真实协议负载验收（2026-09-30）

最终后端全量入口 **44/44 脚本通过**，私有真实 MySQL 备份恢复 **14/14 项通过**；三次完整 20 个独立 S7 TCP 端点、每端点 100 点的后端真实协议负载均通过。**Unity 首轮发现反复重连/重载，修复后最终 90 秒闭环复测已通过：只构建一次场景，0 传输异常，收到全部 2000 点，清理完成且脚本退出码 0。** 旧失败证据和限制保留在下文。新增负载还发现并修复了能够使后端退出的 nodes7 解析崩溃，以及 Windows 临时文件占用引起的配置保存失败。三次后端 180 秒稳态负载均为 2000 点、500 ms 周期、0 读取失败，并通过单 PLC 断线恢复与后端重启。此记录仅证明下述已执行范围，不能等同于所有接口、外部服务、现场 PLC、Unity/GPU 和 72 小时运行已验收。

## 环境与证据

- Windows；Intel Core i5-8300H，8 逻辑核心，15.88 GiB 内存；Node v22.13.1。
- 数据库本体、备份和运行日志在 `output` 下单独目录；清除 `PLC_TEST_SOURCE_DB`、`SITE_BACKUP_TEST_SOURCE_DB` 等现场来源覆盖，未连接现场数据库或物理 PLC。后续只读核验查实 MySQL ASCII 路径别名仍曾写到真实 ProgramData，因此此前不能笼统声称所有文件系统写入全隔离；测试侧现已补齐 ProgramData 隔离，历史足迹与未改动机器身份的证据详见候选报告。
- 协议模拟器来自本机 `../PLC仿真调试器`，使用 Python、Snap7 DLL、asyncua；仅绑定 `127.0.0.1`。
- 全量入口：`node backend/scripts/run-tests.cjs --with-plc-simulators`。Windows 包含系统语音测试；模拟器可选项确实执行。
- 第一轮：`output/quality-suite-20260930T075900869Z-12244-rNHkP9/result.json`，42/43 脚本通过，配置连续保存发生真实 `EPERM`。
- 修复后的第二轮：`output/quality-suite-20260930T081018440Z-15148-ZTsuOt/result.json`，43/43 脚本通过；时间早于后续 S7 高点数修复。
- 最近一次全量回归：`output/quality-suite-20260930T092522398Z-32864-cQXlrC/result.json`，**44/44 脚本通过**。在 S7 适配、测试种子修改及首轮原生联动结束后重新完整执行；包括真实 S7 集成约 73.37 秒和 Modbus/OPC UA 集成约 28.44 秒。每个脚本日志均保留在同目录。后续连接诊断日志与 CSP 修复按修改范围定向复验，未把较早的全量结果说成包含这些后续改动。
- CSP 修复后 HTTP 定向回归：`output/http-integrity-20260930T101548619Z-19240-thUFoK/result.json`，16 项通过；连接日志修改后 `ws-queue-test.cjs` 的真实 TCP、慢消费者、故障/控制事件顺序和清理检查通过。
- 只读账号展示接口权限修复后：`output/admin-auth-integration-20260930T110212344Z-24128-WmYUgF` 的真实 HTTP 角色集成回归通过，另有 `admin-auth-test.cjs` 通过；发生在 44/44 全量之后，使用新 ProgramData 隔离 helper。主输出 `output/native-deployment-audit-20260930/viewer-reads-after-fix.log`。
- 本轮修改文件 `git diff --check` 通过（只有仓库既有 Windows 换行转换提示）；新 S7 adapter、负载/遥测脚本、原子 JSON 写入器的 Node 语法检查通过。
- 私有真实 MySQL：`output/mysql-backup-20260930T081044961Z-2524-utS7OX/result.json`，14 项通过；使用新初始化的独立 MySQL 进程、独立 schema，结束后停止自有进程。
- 真实 20×100 S7：`output/plc-scale-20260930T084627246Z-25440-k7vFic/result.json`，9 项通过。原始逐 5 秒遥测为同目录 `backend-telemetry.jsonl`。
- 第二次完整 20×100 S7（同样包含 180 秒、断线和重启）：`output/plc-scale-20260930T090704113Z-28988-2QL7DR/result.json`，9 项通过，并在重启后的保持窗口提供原生联动数据；成功后全部自有模拟器和后端进程停止。
- 排查原生失败时第三次完整 S7：`output/plc-scale-20260930T094002895Z-22272-2VZBRQ/result.json`，仍为 9 项通过，180.50 秒、3989.65 点/秒、0 读取失败。它只增加后端证据，不能抵消同期 Unity 反复重连的失败。

## 本轮发现与修复

### B-01 / P1：稀疏高点数 S7 读取触发异步解析越界，后端退出

安装版本 nodes7 0.3.18 的读取分包限制字节数，却未限制 S7 ReadVar 单报文最多 20 个读取项。100 个稀疏混合 BOOL/WORD/REAL 地址会生成超过 20 项的请求；Snap7 返回较少项后，驱动在 socket 回调 `processS7Packet` 中发生 `RangeError [ERR_OUT_OF_RANGE]`。原失败证据位于 `output/plc-scale-20260930T081339433Z-13836-lJwZhu`，错误 offset 为 32.625，进程退出。

`backend/services/s7ReadSafety.js` 在连接级保留驱动原有地址优化与值解码，将请求继续拆为最多 20 项并分配唯一序列号；按 TPKT 头重组 TCP 分片和拆分合并包；在解码前检查响应项数；将驱动解析/超时异常交给既有设备失败与重连流程。`plcReader.js` 对活动任务 generation 做校验，避免失效连接回调污染新任务。未修改 `node_modules`，未安装全局异常吞噬器，未降低 500 ms 采集频率。

`s7-read-safety-test.cjs` 用真实 nodes7 分包器先断言原缺陷可复现，再验证点位不遗漏、20 项上限、序列号、TCP 分片/合并、坏报文及连接内异常隔离，6 项通过。随后真实 TCP 2000 点稳态、动态值、断线与重启均通过。

### B-02 / P2：Windows 短暂共享占用使外部数据源配置保存失败

全量执行中 `data-source-http-regression-test.cjs` 的连续凭据保存遇到 `EPERM`。`backend/utils/atomicJsonFile.js` 使用独立 `wx` 临时文件，在 `EPERM/EACCES/EBUSY` 时有限重试原子 rename（10、20、40 ms）；失败保留已有文件并清理临时文件。该配置 API 原本同步，异常路径最多额外等待 70 ms，正常路径不等待。未先删除目标文件。

HTTP 回归新增短暂占用两次后恢复、持续占用下原值保留和无遗留临时文件的故障注入；共 25 项通过。同步异常重试仍可能产生短暂事件循环停顿，不能宣称配置写入完全无阻塞。

### B-03：测试种子未清除工厂级数据模式覆盖

通用种子只写全局 `data_mode=simulation`，已有 `factory_settings` 可能仍覆盖为 `integrated_plc`，导致隔离原生场景没有模拟数据。种子现在同步更新已有工厂级模式；真实 PLC 测试显式把已有覆盖设回 `integrated_plc`。这是测试隔离修复，不是把真实 S7 负载切换为模拟数据。

### B-04：备份空间、流式校验和恢复点保护

本轮保留并验证此前实现的 SQLite/整站流式备份与恢复，补齐以下边界：数据库默认预算 2 GiB、整站 4 GiB，旧默认预算迁移但保留操作者显式设置；散列与复制在同一数据流中完成，同尺寸源文件并发修改会失败；失败不替换已有目的文件；核算临时副本、WAL、回滚副本的峰值空间；压缩媒体与已有压缩数据库直接 STORE。

清理串行异步执行，所有调用方等待清理完成。删除旧版本前完整校验较新候选，损坏的最新文件不能挤掉最后可用恢复点；MySQL 未完成验证时显示 `valid:null`，不能只凭 gzip 头判定有效。真实私有 MySQL 验证数据库与整站恢复、上传/模型/外观资源、回滚、损坏 gzip 和不重复压缩；14 项通过。

### B-05：本地模型预览 Blob 请求被 CSP 拦截

后续浏览器验收发现上传前的 GLB Blob 预览受 CSP `connect-src` 限制。`backend/middleware/security.js` 仅给该指令补充 `blob:`，没有加入任意 HTTP/HTTPS 来源。`http-integrity-test.cjs` 新增真实 `/admin` 与 `/api/health` 响应头回归，旧代码失败、修复后通过。该修复晚于上述 44/44 全量入口，按修改范围另做 HTTP 定向回归与浏览器复验，候选包必须包含修复后的中间件。

### B-06：只读账号读取展示依赖接口被误判为管理操作

后续只读账号浏览器验收出现 403，原因是 `platform/data-sources` 路由整体按管理权限拦截。安全中间件为三个确切的运行展示读接口增加仅 GET/HEAD 的 `view` 权限例外；管理读取与写入仍保留管理权限。`admin-auth-integration-test.cjs` 增加真实 HTTP 角色回归，旧代码失败、修复后通过，基础账号测试也通过。此修改同样晚于 44/44 全量入口，候选静态核对覆盖最新 `security.js`，浏览器复验结果由总验收记录给出。

## 功能覆盖范围

以下是测试实际涉及的领域映射，不是逐路由覆盖率统计。扫描可见约 138 处路由声明；本轮没有证明每个方法、状态组合与并发顺序均被覆盖。

| 领域 | 本轮执行的证据与边界 |
| --- | --- |
| 管理员、账号、原生票据、授权 | `admin-auth-test`、`admin-auth-integration-test`、`license-test`、`production-readiness-test`；包含真实本机 HTTP 身份与原生票据约定，未替代正式授权服务上线验收 |
| 数据库生命周期与并发 | `database-readiness-test`、`backend-concurrency-test`、`backend-recovery-edge-test`、`backend-service-failure-test`、`power-recovery-test`；隔离 SQLite 读写、等待、切换失败与恢复 |
| 工厂、车间、产线、设备、点位 | `factory-isolation-test`、`spatial-hierarchy-test`、`data-point-sync-test`、`deletion-safety-test`、`group-portal-settings-test`、`factory-geocoder-test`；CRUD、隔离、同步与删除约束 |
| 外部只读数据 | `business-data-test`、`data-source-test`、`data-source-http-regression-test`、`data-source-designer-test`、`math-expression-test`；SQL 防写、凭据、HTTP JSON/XML/CSV 与 OAuth 约定；未新建真实 PostgreSQL/MSSQL 或外部 OAuth 服务 |
| 资产、外观、地图、空间 | `appearance-assets-test`、`map-surface-schema-test`、删除与恢复测试；模型资源校验与目录管理；实际渲染另见原生联动报告 |
| 看板、巡检、MCP、工程包 | `native-dashboard-config-test`、`dashboard-designer-test`、`inspection-platform-test`、`mcp-platform-integration-test`、`project-bundle-test`；文档发布、部件、接口与工程迁移 |
| 历史、告警时间与保留 | `history-retention-test`、`database-retention-test`、相关数据流/UTC 断言；不等于所有现场报警语义或长周期趋势均验收 |
| 备份、恢复、空间异常 | `backup-storage-test`、`site-backup-test`、`database-retention-test`、`power-recovery-test`，另加真实私有 MySQL 14 项 |
| S7、Modbus TCP、OPC UA | `plc-protocol-test`、`plc-value-precision-test`、`s7-read-safety-test`、`plc-integration-test`、`plc-simulator-protocol-integration-test`；真实回环协议、值精度、断线、坏质量、协议隔离、挂起看门狗；OPC UA 所有证书/安全部署组合未覆盖 |
| 实时队列、日志、系统运行 | `ws-queue-test`、`bounded-process-log-test`、`runtime-display-test`、`http-integrity-test`、`release-package-test`、`cast-discovery-test`、Windows `voice-feature-test`；UI/GPU、实体电视与多终端真实网络另需验收 |

另外重新执行 `endurance-continuity.test.cjs`，4 项连续性断言通过；这是连续性逻辑验证，没有执行 72 小时长跑。

## 20 台 S7 × 100 点实测

`backend/scripts/plc-scale-test.cjs` 启动 20 个独立 Snap7 服务器进程与 20 条实际 nodes7 TCP 连接，各 100 点：34 BOOL、33 WORD、33 REAL，地址步长 8 字节；每个点有按设备区分的精确期望值，REAL 含 `.125`。数据库独立，所有点采样配置均为 500 ms。预载遥测只统计实际读取结果，不生成或替换值。

| 指标 | 实测结果 |
| --- | ---: |
| 稳态持续时间 | 180.85 秒 |
| 稳态抽查 / 异常抽查 | 171 / 0 |
| 遥测稳态读取批次 / 失败 | 6676 / 0 |
| 实测读取点数 | 3912.12 点/秒（配置理论值 4000） |
| 动态哨兵变化 | 340 次，20 台全部收到变化 p95 1159 ms |
| WS 部分更新帧 | 7075 帧；按设备合并后断言 2000 点，不能把一帧解释成全量 2000 点 |
| 帧间隔 p95 / 最大 | 190 / 644 ms |
| 后端 RSS 峰值 | 238.66 MiB |
| 后端平均 CPU | 整机 1.25%；折算单核心 9.98% |
| 5 秒窗口中最差事件循环 p99 / 最大 | 410.26 / 521.40 ms |
| 显式终止一台模拟器到其 100 点坏质量 | 32 ms |
| 重启该模拟器到 2000 点全部恢复 | 2040 ms |
| 后端重启到 2000 点全部恢复 | 5439 ms |

显式关闭本机服务器产生立即 socket 断开，32 ms **不能**解释为现场断网或黑洞超时检测时间。单台断开时其余 1900 点保持精确有效；后端重启后配置标记和值都通过。事件循环出现半秒级峰值，因此本轮不构成硬实时保证。

原始 WS 是设备部分更新。早期负载脚本曾错误地要求单帧含 20 台设备，导致一次测试工具失败；当时后端已有超过 10 万点读取且无失败。脚本改为按设备合并最新快照后重新完整运行，以上数字来自完整成功运行，不包含该失败统计。

第二次完整运行同样通过全部 9 项：180.47 秒，172 次抽查无异常，6783 批读取、0 失败，3989.65 点/秒；340 次动态哨兵变化，20 台全部收到 p95 527 ms；7203 个部分 WS 更新帧，间隔 p95 110 ms、最大 367 ms。后端 RSS 峰值 279.86 MiB，平均 CPU 整机 0.877%；事件循环最差 5 秒窗口 p99 17.12 ms、最大 361.50 ms。断线识别 338 ms、模拟器重启恢复 2014 ms、后端重启恢复 2822 ms。重复运行有明显时延和内存差异，所以保留两次原始结果及第一轮更差的延迟，不能只引用较好的数字。

## 原生联动与尚未覆盖的条件

为 Unity 联动重新运行相同 20×100 fixture：`output/plc-scale-20260930T090704113Z-28988-2QL7DR`。独立原生脚本在 `output/native-connected-load-20260930T091316484Z-31636-oGewt0/result.json` 写出了 `success:true`，但后续核对同目录 `unity.log` 发现 **90 秒内整厂 ready 重复 7 次，存在隐藏重连/重载故障，该次原生稳定性验收判定失败**。ready 日志位于 82、139、196、253、310、367、424 行，每次又从场景初始化开始；同一 fixture 的 `backend.log` 43–58 行反复出现连接数 3→2→3，另两条观测连接持续存在，支持 Unity 连接确实反复断开重建。原脚本只检查出现 ready、模型存在和部分异常类型，漏掉了反复整厂重载，原 `success:true` 不能作为链路稳定的证据。原文件和日志保留，不覆写故障证据；修复后的新结果如下。

这次失败运行中实际观测到：Windows D3D11、GTX 1050 Ti、1600×900 batch player，20 个 `photo_multipurpose_furnace_v6` 真实 GLB 首次约 5232 ms 完成场景加载；无替代几何、无原脚本检查类别的 Unity 运行时异常；90 秒观察到 4033 帧，独立 WebSocket 客户端收到 20 台设备每台 100 个点位的元数据。运行沿用既有 balanced 画质，日志明确保留完整几何；未为测试降低采集周期或修改画质。这些结果只证明初次加载和数据到达，不能证明 Unity 连续稳定运行。

上述失败运行中，Unity 进程平均 CPU 占整机 2.74%（单核口径 21.89%）；观察期 private bytes 从约 427.33 MiB 到 462.86 MiB，RSS 峰值约 272.11 MiB。重复重载会影响这些测量，不能当作正常稳定场景的性能基线；90 秒内 private bytes 仍有增长，也不能证明长时内存无增长。CPU 数字仅为 Unity 进程，不包含后端。

后端负载脚本证明实际 TCP 值及 quality 精确匹配，联动脚本证明同一后端输出了 2000 点元数据、Unity 实际模型曾加载完成；它没有证明原生连接和场景持续稳定。这两类证据必须区分：没有在 Unity 内对所有 2000 点逐点核对绑定结果，也没有做全部画面像素/交互验收。首次 3 分钟负载自身只覆盖后端数据链路。修复后的联动结果必须写到新的目录，并包含重连次数和整厂重载次数断言。

继续诊断时给 `wsServer.js` 的既有断开日志增加 UTC 时间、关闭 code、限长 reason、客户端角色及释放前的队列 failure/stats，不调整队列限额或发送时序。该日志改动发生在上述 44/44 全量回归之后，另做 Node 语法检查、已有 WS 队列回归及真实夹具复现核对。新 `--native-fixture-only` 模式使用同样 20 个真实 TCP 端点和 500 ms 周期，每秒检查 2000 点值/质量；允许通过隔离目录内 `RESTART-BACKEND` 标记优雅重启自有后端以加载诊断修复。此模式只用于原生排障，不把它当作又一次完整 3 分钟负载验收。旧故障目录和结果均保留。

最终修复在 Unity WebSocket `ReceiveAsync` 上使用 `ConfigureAwait(false)`，使持续收包不等待渲染线程继续执行；未改变画质、模型几何、PLC 周期或队列限额。独立 C# 回归覆盖停滞渲染上下文下的真实 WebSocket 接收，旧代码必失败。180 秒中间观察已只有一次 ready、零传输异常，但退出观察过短使测试清理超时，因此未把它作为完整脚本成功结果。修正清理观察后重新跑完整 90 秒。

最终闭环证据：`output/native-connected-load-20260930T095723309Z-20344-iDuDhZ/result.json`，`success`、`stabilityPassed`、`cleanupComplete` 均为 true，脚本退出码 0；首次就绪 4796 ms，90 秒内 `sceneBuildStartedCount=1`、`sceneBuildCount=1`、`transportFaults=[]`，观测 4007 帧和 2000 点元数据。Unity 平均 CPU 为整机 3.41%（单核 27.28%），private bytes 从 414056448 到 413986816 字节，峰值 414126080 字节；RSS 峰值 272773120 字节。此段未见 private bytes 增长，但仍不是长时间内存结论。

同一后端诊断夹具 `output/plc-native-fixture-20260930T094905563Z-2176-OfaD8u/result.json` 完整退出成功：20 个独立真实 S7 TCP 端点、500 ms 周期，保持 774.154 秒，773 次逐秒检查中每次全部 2000 点值和质量正确，0 异常、0 后端重启；每台设备快照新鲜度同时检查。结束后自有后端与全部模拟器停止。夹具期间的主动关闭/清理日志应与观察阶段区分，不能把观察结束后终止 Unity 产生的断连当作稳态失败。

源码验证与现成安装包是否包含修复是不同问题。新的本地候选 `安装包/release-20260930-191247-366` 已构建成功，10 阶段退出码均为 0，三项随包 smoke 和 1193 个文件/asar 比对通过；新包包含上述 S7、Unity 及后续 CSP/view 权限修复。安装器未签名。路径、SHA-256、ProgramData 前后元数据复核及完整证据见 `docs/release-candidate-2026-09-30.md`；构建候选不等于执行安装、SCM 服务注册或现场升级验收。

本轮没有使用物理 PLC、工厂网络、现场生产数据库或实体电视；没有验证真实 PLC 扫描周期竞争、网络抖动/丢包/电磁环境、所有 OPC UA 证书配置、多年历史库增长、全体外部数据库版本、长时间 GPU 显存增长和 72 小时连续运行。已有测试通过可作为功能与回归依据，不能据此写“所有功能毫无遗漏”或“已经现场生产验收”。
