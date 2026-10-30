# 本地验收候选包与发布门槛（2026-09-30）

当前状态：新的本地验收候选 `安装包/release-20260930-191247-366` 已构建成功；10 项构建/验证阶段全部退出码 0，三项随包 smoke 全通过，1193 个当前源码/构建文件及桌面 asar 内容核对通过。安装器可交付受控验收，但未签名；本轮未执行安装器、注册 SCM 服务、升级真实环境或外网发布。

## 实际测试电脑

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | Microsoft Windows 11 专业版，10.0.26200，Build 26200，64 位 |
| CPU | Intel Core i5-8300H @ 2.30GHz，4 物理核心、8 逻辑处理器 |
| 内存 | 实装 16 GiB（2×8 GiB，CIM 配置频率 2667 MHz）；系统可见 17048064000 字节，即约 15.88 GiB |
| 本次 Unity 实际 GPU | NVIDIA GeForce GTX 1050 Ti；Unity 日志报告 VRAM 4004 MB |
| 图形 API / 驱动 | Direct3D 11.0、feature level 11.1；驱动 32.0.15.8228 |
| Unity | 2022.3.34f1c1；1600×900 batch player；既有 balanced 设置、完整模型几何 |
| 其他显示适配器 | Intel UHD Graphics 630（未作为本次 renderer）及远程/虚拟显示适配器 |

CPU、内存、OS、GPU 信息通过 Windows CIM 与实际 `unity.log` 交叉读取。WMI 的 `AdapterRAM` 不是本轮显存占用测量；未把独显测试解释为无独显电脑保证。

## 现成包只读核验

本轮重建前最新实际存在的安装 EXE 位于 `安装包/release-20260930-143432-906/热处理数字孪生大屏-安装包-2.3.0-x64.exe`，612927228 字节，最后写入时间为 **2026-09-30 14:48:29 +08:00**；清单原生成于 14:40:40，记录 14:48:53 重封装。重新读取整个 EXE 计算出的 SHA-256 与清单一致：

```text
ee008d5b3caf68623e2032b12887ebadbd06078aa22885f319b79a48187880cb
```

旧清单的 `smokeTest=passed` 只对应当时内容。本轮 `s7ReadSafety.js` 于 16:26 更新，Unity WebSocket 修复于 17:49 更新，因此该 EXE 不含这些修复。同目录 `win-unpacked/resources/backend/services/s7ReadSafety.js` 不存在，也支持它是旧内容。

资源准备目录当时同样落后：只读核验时 `desktop/resources/native-client/.../Assembly-CSharp.dll` 仍为 2026-09-28 16:11 的 286208 字节文件，SHA-256 `2c72c1d2cc9840727794ff9839e4b8edc637d21a785ebcf021534d5c66d02b1c`；已经实测的 `unity-client/Builds/Windows/.../Assembly-CSharp.dll` 为 2026-09-30 17:50 的 297472 字节文件，SHA-256 `0b45c870cfb1850fc9df7cfaaf030a2b0efcfbf5585833dfb6212820e1b6a6533`。本次统一构建已经重新执行资源准备，并校验新候选使用后者。

`desktop/.cache/frontend-dist/index.html` 当时仍为 14:34 构建，而 `AdminPanel.vue`、`CustomerOperations.vue` 等修复晚于该时间；本次已经重建打包入口使用的 `.cache/frontend-dist` 并逐文件核对候选内容。`安装包/最新安装包.txt` 仍指向 9 月 29 日的旧 EXE；本轮未修改该指针，也未删除、覆盖或运行旧安装包。受控验收请使用下文明确的新候选路径。

## 构建与验收步骤

构建前独立复核发现此前“隔离测试”的文件系统边界不完整：MySQL 的 ASCII 兼容路径曾创建在真实 `C:\ProgramData\HeatTreatmentDigitalTwin\mysql-links`。只读核验确认，2026-09-30 16:10:29 +08:00 创建的 `0d7156cd1af7d87d2c6859a0dc9b1f91/storage` junction 指向本轮 `output/isolated-mysql-backup-host-20260930T081029168Z-4684-u1B5qj/mysql`。这证明本轮确实留下了机器级路径别名，不能把此前描述扩大为所有文件系统写入都隔离。数据库本体仍在测试目录，未因此变为现场数据库。

真实 `machine-identity.json` 和 `.bak` 的创建/最后写入时间仍为 2026-09-12；本轮检查未见它们的写入时间改变，未读取或修改身份内容。没有清理、改动现有身份文件、路径别名或真实数据。构建前元数据快照为 `output/programdata-footprint-before-candidate.json`。

已修复测试侧 `createSmokeProgramData()` 及三项包 smoke：同时设置 `ProgramData`、`PROGRAMDATA` 和 `LICENSE_MACHINE_STATE_FILE`，使用专属 ASCII 临时目录，实际数据仍在 `output`；每次把临时根记入 `program-data-isolation.json`，保留作证据。中文 workspace 不能直接用作 MySQL ASCII 别名根。定向测试 `output/smoke-program-data-20260930T105536887Z-30616-qJVF5f/result.json` 的 4 项通过，包含真实子进程环境大小写别名、实际机器身份写入私有根，以及原目录哨兵不变。不是修改生产路径规则，也未执行安装/升级。

在源码修复、前端最终 ready 和 Unity 最终验证结束后，已执行仓库统一入口 `生成安装包.ps1 -StarterTemplate -NoPause`。`-StarterTemplate` 明确使用新建初始配置，不导出开发机现场 MySQL、不采集现场数据；未使用 `-SkipSmokeTest`。所有候选产物进入新的 `安装包/release-20260930-191247-366` 目录，旧包保留。

仓库入口依次执行：

1. `build:frontend`，生成 `.cache/frontend-dist`；`build:unity`，按源码指纹验证或重新构建 Windows player；`build:admin-host`，发布原生 WebView2 宿主；`build:collector-service`，发布 Windows 采集宿主。
2. `prepare:resources`，重新复制 Unity/原生宿主、打包后端依赖、Node、MySQL、FFmpeg 和新的初始模板。
3. 生成 Windows x64 程序目录。构建结束后对候选目录核对关键后端源码、完整前端和 Unity/AdminHost/Collector 文件树及散列；从 `app.asar` 读取桌面 CJS/资产并与源码比较。AdminHost 不是单文件发布，实际业务 DLL 也纳入检查，不能只看 EXE 一样。
4. 执行仓库已有 `collector-service-smoke-test.cjs`、`packaged-mysql-smoke-test.cjs`、`packaged-project-bundle-mysql-test.cjs`。采集宿主使用 `--console --no-power-request`，不注册 Windows 服务；数据库/应用数据使用独立输出目录和自有本机进程。服务 smoke 显式将隔离模板改为 `data_mode=simulation`、`plc_enabled=0`，它验证真实进程和私有 MySQL 生命周期，不是 S7 协议负载证明；真实 S7 证据另见后端报告。程序目录 smoke 会启动并关闭候选应用，未执行安装器。
5. 仅压缩通过验证的程序目录生成 NSIS EXE；核对 manifest、全部必需构建/smoke 阶段退出码、模板无启用 PLC/无历史数据/无外来上传、文件长度和 SHA-256，再运行仓库发布收集校验。收集器自身只核对元数据成功标志与安装器长度/SHA，不把它说成检查了全部 smoke 或安装器内部 payload。完整本次构建日志提供程序目录与安装器生成关系的证据；安装器未执行或解包验内部。源版本静态检查 `node tools/ci/check-release.cjs` 已通过，版本 2.3.0。

## 最终候选与证据

- 安装器：`安装包/release-20260930-191247-366/热处理数字孪生大屏-安装包-2.3.0-x64.exe`。
- 版本：2.3.0；大小：**610256077 字节**（约 581.99 MiB）；生成时间：2026-09-30 19:16:56 +08:00。
- SHA-256：`312ff1b70fe662001fad5525a85f951dafa09b30a928feece67de7d0ab03229e`；同目录 `.sha256.txt` 和 `release-manifest.json` 一致。
- 构建耗时：249.548 秒，10 个阶段全部退出码 0，`build-timings.json` 为 `success:true`。完整日志为同目录 `构建日志-20260930-191247.txt`。
- 当前文件审计：`output/release-candidate-verification-20260930T112014457Z-22004-VoxNeN/result.json` 为 `success:true`，共核对 1193 个文件；涵盖最新 S7、备份、WebSocket、CSP/view 权限后端源码，完整前端、Unity/AdminHost/Collector 树，以及桌面 asar 的 CJS/资产。模板 SQLite `quick_check=ok`，无启用 PLC、事件/指标历史和上传文件。仓库发布收集器的本地副本位于该审计目录下 `output/ci-release`。
- 签名状态：Windows `Get-AuthenticodeSignature` 为 **NotSigned**，没有签名证书；证据为同审计目录 `authenticode.json`。构建器输出“signing with signtool.exe”不构成已签名证明。

| 随包验证 | 结果与边界 | 证据 |
| --- | --- | --- |
| 独立采集宿主 | 56.308 秒通过；首启/重启均无 Unity 客户端、生成数据、优雅停库；候选展示应用启动/退出通过；数据源为 simulation | `output/collector-service-smoke-20260930T111340936Z-12596-Mhg1op/result.json` |
| 随包 MySQL 首启/重启 | 88.731 秒通过；MySQL 9.2.0；两轮配置计数一致并安全停库；初始模板 1 工厂、20 设备、0 点位、0 上传 | `output/packaged-mysql-smoke-20260930T111437276Z-30996-5aDRb6/smoke-result.json` |
| 随包项目迁移/回滚 | 19.384 秒通过；7 项检查覆盖私有 MySQL 所属、指标保留不影响事件、保存/发布、引用隔离、重新发布、共享外观/资产和事务/资产回滚 | `output/packaged-project-bundle-mysql-20260930T111606182Z-24900-cUtgZY/result.json` |

三项 smoke 分别记录独立的 ASCII 临时 ProgramData 根 `dt-smoke-programdata-DOe1xf`、`dt-smoke-programdata-pKUy29`、`dt-smoke-programdata-Dy3B7p`。构建前后真实 ProgramData 元数据核对结果为 **25 个既有别名数量/名称/时间不变，机器身份文件长度及创建/写入时间不变**；只证明元数据未见变化，未读取身份内容。最终比较见 `output/programdata-footprint-candidate-comparison-normalized.json`，原始前后快照及早期比较记录保留。初次 PowerShell 对比存在 DateTime/string 类型差异，随后精确字符串比较存在小数秒末尾零的表示差异；最终按完整 7 位小数秒统一表示，未舍弃时间精度，得到相同。

## 发布门槛

候选已可用于受控验收；仍不能据此宣称完成真实安装、SCM 注册/无人登录采集、现场升级、实际许可证部署、物理 PLC/电视/HDMI 恢复或 72 小时运行。另须遵守当前部署说明中 DLNA 桌面捕获与 Session 0 采集服务的边界。总体结论见 `docs/全面功能验收-2026-09-30.md`；新版来源、原生短时联动及剩余条件另见 `docs/audit-backend-2026-09-30.md` 和原生审计报告。
