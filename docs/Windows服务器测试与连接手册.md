# Windows Server 连接、测试与结果查看手册

> **2026-10-03 用户明确要求：停止本任务安排的远程任务，以后不要再访问或操作 100.116.121.79。** 下文连接、启动、检查命令仅保留为历史记录，不代表继续执行的授权；除非用户再次明确授权，不得连接、巡检、部署、重启或操作该服务器。

2026-10-03 11:51（香港时间）执行本次停用收尾：计划任务 `Daping-Endurance-20260929` 已禁用，实际返回 `State=Disabled`（枚举值 1）、`Enabled=false`；本轮测试早已结束，未发现相关 Node/MySQL 测试进程，无需杀进程。原测试文件和失败证据保留。本次收尾结果见 `output/server-stop-20261003.json`。后续不再访问该服务器。

本大屏每 15 分钟巡检此前已移除。本次另发现本地自动化 `automation`（“排产服务器仿真长测跟踪”）仍会访问同一服务器；依据用户禁止后续访问的要求，已通过自动化工具将其设为 `PAUSED`，保留原提示和周期，不操作排产项目的远端文件或进程。该自动化也不得在没有用户重新授权访问服务器的情况下恢复。

## 1. 当前服务器与部署状态

| 项目 | 内容 |
| --- | --- |
| Tailscale 地址 | `100.116.121.79` |
| 主机名 / 登录账号 | `WIN-2LSQI4TI1KE` / `Jsjs123` |
| 操作系统 | Windows Server 2022 Standard，版本 `10.0.20348` |
| 资源 | Xeon E3-1225 v6，4 核，约 16 GiB 内存；检查时 C 盘可用约 904 GiB |
| 测试目录 | `C:\DapingTest\run-20260929` |
| 程序安装目录 | `C:\DapingTest\run-20260929\program` |
| 隔离测试工作目录 | `C:\DapingTest\run-20260929\workspace` |
| 当前连接 | 2026-10-03 11:51（香港时间）完成最后停用收尾；用户禁止后续访问和操作 |
| 部署状态 | 测试已结束，相关进程不存在；计划任务已禁用，原始失败报告保留 |

### 2026-10-02 17:10 最终结果（香港时间）

**本轮跑满申请的 72 小时时长，但验收失败，不能称为“72h 通过”。** 正式报告生成于 2026-10-02 16:51:38.309（香港时间；UTC 为 08:51:38.309），`status=failed`、`requestedSeconds=259200`、`actualSeconds=259200.0135084`、`qualifiesAs72Hours=false`。`durationCompleted=true`，但 `continuousObservation=false`、`noErrors=false`。其余报告检查为 true，不抵消这两项失败。

| 最终指标 | 结果 |
| --- | --- |
| 连续性 | 21 次违规，最长间隔 46871ms，允许上限 15000ms；`observedSeconds=258732.2351724` |
| 错误记录 | 20 次 `WebSocket frame gap exceeded limit before stream recovered`；与连续性违规是两类计数 |
| HTTP | 249495 次请求，0 次请求错误；p95 上界 90ms，最长约 5895.365ms |
| 持久化及数据库绑定 | 8324 次保存发布循环，8325 次数据库快照验证；49882 次组件查询检查及新查询 |
| 重连与恢复 | 2089 次客户端重连、129553 帧；1 次计划内后端及私有 MySQL 重启恢复 |
| 后端内存 | 报告峰值 RSS 96.668MiB，预热后单进程最大增长 3.324MiB |
| MySQL 内存限制 | 报告所采父进程峰值 RSS 76.680MiB、最大增长 0；未完整追踪实际服务子进程，不能据此认定子进程长期内存达标 |

`run-exit.json` 记录 16:51:39.054 退出、`exitCode=1`；部署状态为 `failed`，详情为 `Long test ended with exit code 1`。17:04 和 17:10 两次复核确认计划任务 `Daping-Endurance-20260929` 为 Ready、`LastTaskResult=1`，正式 runner、后端及本轮私有 MySQL 进程均已结束。这是完成目标时长后的检查失败，不是仅凭 SSH 超时或任务状态作出的判断。结束前的历次快照保留了 runner PID 29140，以及计划重启后的后端 33136、MySQL 父进程 31304 / 子进程 34388 的实际命令及创建时间。

既有诊断支持测试器同步操作阻塞的可能性，但尚未完整定位根因，也未证明所有 WebSocket 帧均已发送；不能直接归因于网络、后端或整机。没有为本轮放宽门槛、清零错误或重启补时。本次归档保留原始失败结果，后续修复应另开测试轮次，不覆盖本轮。

本轮仍限于 **9 月 29 日旧包的模拟后端与隔离 MySQL**，不覆盖新候选包、20×100 S7、Unity 画面、电视投屏或真实 PLC 现场验收。业务数据库和 PLC 采集范围未改，本机旧 72 小时任务保持停止。Linux 临时中转文件和专用限制公钥此前已在 Windows 安装包 SHA-256 校验通过后清理，无需再次清理。

最终证据：

- 本机归档目录：`output/server-final-evidence-20261002T0903Z/`；含最终 ZIP、解压的正式/60 秒预检报告、事件与内存日志、后端/MySQL 日志、启动/退出记录、测试脚本、程序摘要、计划任务 XML、结束状态及 SHA-256 校验记录。ZIP 下载后摘要与服务器一致，29 个原始文件的大小与 SHA-256 逐一匹配；校验结果见目录内 `verification.json`。
- 服务器保留：`C:\DapingTest\run-20260929\evidence-final-20261002T0903Z.zip`，原报告与日志亦保留；ZIP 为 1846971 字节，SHA-256 为 `0d32f8fbbc87e9e56ad2688d2e130112c4de57cb3ebfc0d450b517449e418737`。
- 结束快照：`output/server-monitor-20261002T0903Z.json`；归档元数据：`output/server-final-archive-20261002T0903Z.json`。133 份巡检快照及既有异常诊断已复制并校验到本机证据目录的 `monitor-history/`，便于核对进程身份、创建时间和报告进展。

证据归档完成后，已移除自动监测 72（“Windows Server 长时间测试”），后续不再每 15 分钟触发。本次仅结束监测，服务器计划任务及原始测试目录保留，未启动新的测试轮次。


### 2026-10-01 08:31 独立复查（香港时间）

实际登录服务器后两次采样，最终报告更新于 08:30:52，`status=running`、`actualSeconds=142765.8706491`（39 小时 39 分 25 秒），HTTP 请求 137869 次、错误 0，p95 上界 80ms、最长请求约 4958ms。两份报告相隔约 620 秒，新增 600 次请求、310 帧、20 次保存发布循环、20 个数据库快照验证和 120 次数据库组件新查询，证明工作负载仍在推进。runner 29140、后端 33136、MySQL 父进程 31304 / 实际服务子进程 34388 的身份与创建时间均未变。

连续性违规已从昨晚的 2 次增至 13 次，最长间隔 32317ms；WS 接收间隔错误累计 13 次，最后一次为香港时间 10 月 1 日 07:55:43.723。本次两份报告之间没有新增错误。`continuousObservation=false`、`noErrors=false`、`qualifiesAs72Hours=false`；即使达到目标时长，也不能将本轮改判通过。

新增诊断证据更支持测试器自身阻塞：完整 28537 条后端独立内存采样没有同 PID 超过 10 秒的间隔；13 个错误窗口共 182 条样本仍约每 5 秒产生，最大间隔 5184ms。远端四个测试脚本 SHA-256 与本机相同；测试器每分钟同步读取并解析整个内存日志、同步启动 PowerShell 采 MySQL 内存。昨晚一次报告阶段约耗时 15.5 秒，随后立即出现 WS 间隔错误；最近五次 WS 错误也紧邻 MySQL 采样完成。该证据不支持直接宣称后端或整机停顿了 15–32 秒，但仍不能证明每个 WS 帧都成功发送，也没有定位具体哪个同步操作慢。应在单独测试中验证并修复测试器，保留本轮失败证据。

服务器检查时 CPU 约 8%，空闲物理内存约 9.1GiB；本次查询的相关系统事件没有发现休眠、恢复或重启记录。应用事件有 Edge 安装器错误，未发现 Node/MySQL 崩溃记录，不能把 Edge 错误直接认定为本轮异常原因。后端日志尾部未见异常栈，MySQL 日志最后更新仍为 9 月 29 日计划重启成功时。另发现原 MySQL 长测内存指标仅跟踪父进程，不能代表实际服务子进程的长期峰值；本次子进程工作集约 34.1MiB、私有内存约 741.7MiB，仅为当前快照。

本次没有重启测试或替换远端代码。仍是 9 月 29 日旧包的模拟后端与私有 MySQL 测试，未覆盖 9 月 30 日新候选包、20×100 S7、Unity 图形与现场硬件。SSH 诊断期间有一次超时，随后重新连接成功；这不等于测试停止。

本次原始证据：

- `output/server-live-check-20261001T002049Z.json`
- `output/server-live-check-20261001T003108Z.json`
- `output/server-log-diagnostics-20261001T002949Z.json`
- `output/server-resource-check-20261001T003039Z.json`（中文事件消息存在编码损失，事件时间、ID、provider 和英文故障标识可核对）

### 2026-09-30 22:39 异常记录（香港时间）

正式报告更新至 14:39:23 UTC，实际时长 107260.587 秒（约 29 小时 47 分钟），状态仍为 running。连续性记录两次采样间隔约 21.185 秒、19.681 秒，超过 15 秒门槛，`continuousObservation=false`、`noErrors=false`。报告记录两次 WebSocket 帧间隔超限；随后读取的 events.jsonl 已出现第三次同类事件，文件读取并非原子快照，因此事件计数可能领先报告。

HTTP 请求 103829 次仍为零错误，时延与内存检查正常；runner 29140、后端 33136、私有 MySQL 31304 的进程身份和创建时间未变。当前证据只能确认观测及帧间隔超限，尚不能归因于应用、机器负载或系统暂停。没有重启或清零本轮，继续保留诊断证据；即便运行达到 72 小时，也不能忽略这些失败而宣称通过。

本次证据：`output/server-monitor-20260930T1437Z.json`、`output/server-anomaly-20260930T1437Z.log`。本次仍为模拟后端与隔离 MySQL 测试，不代表真实 PLC、Unity 或电视现场验收。

### 2026-09-30 20:05 独立复查（香港时间）

收到用户再次要求后，使用已有专用 SSH 密钥和严格主机校验实际登录 `WIN-2LSQI4TI1KE`，账户 `jsjs123`。没有重启、停止或修改服务器上的测试。正式 runner 仍为 PID 29140（创建时间 9 月 29 日 16:50:40），命令行含 `--database-type mysql --duration-seconds 259200`；后端 PID 33136、MySQL 父进程 PID 31304 与原运行匹配。

两次独立读取的报告分别更新于 20:00:51 和 20:04:59。第二份正式报告 `status=running`，`actualSeconds=98012.9500554`，约 **27 小时 13 分钟**；请求 **94949 次、错误 0**。两份报告之间实际观察时长增加约 248 秒、请求增加 240、WS 帧增加 124、保存/发布循环增加 8、数据库组件新查询增加 48；runner/后端 PID 未变。这些进展证明持续有工作负载，并非仅任务计划显示 Running。

除目标时长未满外，连续性、HTTP 时延、内存、模拟帧、重启恢复、客户端重连、持久化和已发布数据库绑定检查均为 true；连续性违规 0，最大采样间隔 1328ms，HTTP p95 上界 70ms。`qualifiesAs72Hours=false`，目前**不是 72 小时通过**。原始只读快照保存在 `output/server-live-check-first.json` 与 `output/server-live-check-second.json`。

**版本与范围必须分开：**服务器仍使用 9 月 29 日部署的旧版模拟后端＋私有 MySQL。现场 PLC 禁用，这轮没有运行 Unity 图形客户端，也不是 20×100 S7 负载。当前服务器 workspace 的 `services/s7ReadSafety.js` 不存在，`server.js` 和 `dashboardDocuments.js` 的 SHA-256 也不同于本机今天的新候选包；因此即使这一轮最终通过，也不能替今天修复后的候选版本签发 72 小时通过结论。新候选信息见[候选包报告](release-candidate-2026-09-30.md)。本次保留既有长跑连续性，没有替换远端代码。

### 2026-09-30 15:53 巡检更新（香港时间）

连接恢复后确认：正式运行于 **2026-09-29 16:50:40（香港时间）**启动，报告目录为 `C:\DapingTest\run-20260929\workspace\output\endurance-20260929T085040550Z-29140-JNMk5B`。15:53:12 的报告显示 `status=running`、`requestedSeconds=259200`、`actualSeconds=82905.288`（约 23 小时 2 分钟）、请求 80309 次且错误 0；连续性无违规，除尚未达到目标时长外其他检查均为 true。`qualifiesAs72Hours=false`，尚不能称 72 小时通过。

实际 runner PID 29140，命令行包含 `--duration-seconds 259200`，创建时间与报告启动时间吻合；后端 PID 33136，隔离 MySQL 父进程 PID 31304，其命令行使用临时私有数据目录及端口 61968。启动后一次计划重启已记录；当前未重启任务。60 秒预检报告位于 `endurance-20260929T084504037Z-30920-z2VCQA`，状态 passed、实际 60.000329 秒。

此前“停在 installing”是连接失败期间沿用的旧状态，现已由上述证据更正。本次确认模拟后端与私有 MySQL 正在测试，不代表 Unity、电视或真实 PLC 现场验收。若后续正常，预计香港时间 10 月 2 日约 16:52 达到目标时长，最终仍以完整报告为准。

### 2026-09-30 15:28 巡检记录（香港时间）

本次两次 SSH 只读探测均返回 `kex_exchange_identification: read: Connection reset`。本机 Tailscale 服务显示 Running，但 CLI 的 ping/status 返回 `unexpected state: NoState`，健康检查另显示 `Access is denied` 和正在启动。这是当前远程检查的阻碍，不能据此判定服务器测试已经停止，也没有重启服务器任务或本机旧长跑。

最后成功检查时，安装进程未退出，程序目录缺少中文名称的主程序和交付 README；安装器解压问题仍待远端核实。任务计划显示 Running 不能证明测试开始。本次无法核对报告更新时间、进程创建时间及正式测试时长，因此不能宣称已开始或通过 72 小时测试。连接恢复后应先重新读取部署状态、实际进程和报告，再处理安装阻塞。

此前 Linux 临时中转安装包、专用限制公钥及两端临时传输私钥已在 Windows 安装包校验通过后清理，其他服务和密钥保留。

用户最新要求是在这台服务器运行长时间测试，本次计划 72 小时。本机此前取消的两条长跑不会续算，也不会与服务器时长合并。Tailscale 当前经过中继，大文件上传较慢，部署改用用户提供的 Linux 服务器进行临时 SSH/SFTP 加密转传；不提供公开下载地址，传输完成并校验后清理临时文件与访问密钥。

上传的是初始模板安装包，不含现场客户数据库：`热处理数字孪生大屏-安装包-2.3.0-x64.exe`，上传后名称为 `DapingSetup.exe`。文件大小 `579827413` 字节，SHA-256：

```text
3e1e57de5b1ffdcb8765189f65f5dea0e7bc5085a3ae60fc8553f23eef65ade1
```

## 2. 如何从本机连接

先确保本机与服务器的 Tailscale 在线。在本机 PowerShell 执行：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' ping --c 1 100.116.121.79
ssh -i "$env:USERPROFILE\.ssh\codex-daping-server-100-116-121-79" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$env:USERPROFILE\.ssh\daping-test-known-hosts" Jsjs123@100.116.121.79
```

登录后执行 `whoami`，应显示 `win-2lsqi4ti1ke\jsjs123`。如进入的是命令提示符，输入 `powershell -NoProfile` 再执行本手册后续 PowerShell 命令。

本机私钥位于 `C:\Users\27323\.ssh\codex-daping-server-100-116-121-79`，不放进项目、不上传服务器。服务器管理员组公钥文件是 `C:\ProgramData\ssh\administrators_authorized_keys`。公钥已配置，正常情况下无需再次添加。

`Connection timed out` 通常需要检查 Tailscale、sshd 和端口；`Permission denied` 是认证失败。服务器主机密钥变化时应核对原因，不直接删除已记录的主机密钥。

## 3. 测试到底测什么

测试使用安装包中的后端生产代码、随包 Node 和 MySQL；测试脚本另外复制到隔离工作目录。数据库是新建的私有 MySQL，使用随机端口、随机凭据，先核对实际数据目录与端口归属。所有 PLC 采集关闭，使用模拟数据，不连接现场 PLC 或生产数据库。

持续检查：

- 健康接口、实时点位和 WebSocket 模拟帧是否持续可用。
- 保存草稿、发布版本、运行版本及草稿读回是否一致。
- MySQL 中实际保存的修订号、草稿和发布 ID 是否与接口结果一致。
- 发布后的数据库组件是否真正查询目标字段并返回预期值 `42.25`，查询时间是否持续更新。
- 客户端重连、一次后端与私有 MySQL 重启后的数据恢复。
- 后端进程与 MySQL 各自的内存、HTTP 延迟和错误。
- 单调时钟与连续采样是否正常，休眠、较大时钟跳变及观察中断不能变成通过时长。

默认每 5 秒请求，每 30 秒保存发布，每 2 分钟客户端重连；正式长跑第 5 分钟进行一次重启恢复，之后持续观察，避免反复重启掩盖内存增长。

这不是 Unity 图形客户端、电视投屏或真实 PLC 的全功能验收。服务器目前主要是基础/远程显示驱动，不能用其图形性能代表最终部署电脑。全功能已测与未测范围见 [功能验证矩阵](functional-test-matrix-2026-09-29.md)。

## 4. 如何启动测试

首次部署由 `remote-endurance-bootstrap.ps1` 从已安装的 `program\resources` 准备 `workspace`，解开随包依赖，并检查复制后的生产模块摘要。已有工作目录时会拒绝覆盖，避免破坏正在运行的测试。

先运行短预检，通过后才开始 72 小时。正式任务计划名称为 `Daping-Endurance-20260929`，使用 Windows 任务计划程序运行，避免 SSH 断开就终止测试。任务总时限应高于 72 小时，不能使用默认三天限制卡掉最终报告。

本轮任务已于 2026-10-02 结束且验收失败，不要再次启动同一部署任务。以下命令仅用于首次部署、任务尚未开始且没有安装目录和既往运行的情况：

```powershell
Start-ScheduledTask -TaskName 'Daping-Endurance-20260929'
Get-ScheduledTask -TaskName 'Daping-Endurance-20260929' | Select-Object TaskName, State
```

该任务串联等待上传、哈希校验、安装、准备工作目录、60 秒短预检和 72 小时测试。已有安装目录时部署脚本会拒绝覆盖；重新部署应创建新目录和任务，不直接重跑整个部署任务。每轮数据、报告放在新目录中；历史失败报告保留，不用重跑结果覆盖。

服务器必须持续开机。任务运行期间会临时请求系统保持唤醒，结束时释放，不永久修改电源计划；人工关机、重启、断电仍会中断测试。本机关闭或 SSH 断开不应停止服务器任务；远程检查需要本机重新联网，服务器本身会继续写报告。

## 5. 如何查看测试结果

### 5.1 检查任务是否还在运行

在服务器 PowerShell 执行：

```powershell
Get-ScheduledTask -TaskName 'Daping-Endurance-20260929' | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName 'Daping-Endurance-20260929' | Select-Object LastRunTime, LastTaskResult
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*endurance-test.cjs*' } | Select-Object ProcessId, CreationDate, CommandLine
Get-Content 'C:\DapingTest\run-20260929\deployment-status.json' -Raw
```

仅看到 `running` 文本不够；要确认进程仍存在且报告时间在更新。任务计划的运行中返回码也不代表已经通过。

`deployment-status.json.stage` 表示部署阶段：`waiting-for-upload` 等待上传、`checking-installer` 校验、`installing` 安装、`preparing-workspace` 准备依赖、`short-preflight` 短预检、`long-test-running` 长跑、`completed` 完成、`failed` 异常。只有长跑阶段且找到 `requestedSeconds=259200` 的有效运行报告，才表示正式长时间测试已开始。

本轮此前每 15 分钟远程检查，正常无变化时不反复通知；2026-10-02 最终结果归档后已移除自动监测 72，不再触发。服务器上的测试独立于本机运行，Codex 关闭会影响自动检查，不会自行停止已启动的服务器计划任务。后续测试应使用新目录与任务，并为新轮次另行设置监测。

### 5.2 列出每轮报告

```powershell
$root = 'C:\DapingTest\run-20260929'
Get-ChildItem "$root\workspace\output" -Directory -Filter 'endurance-*' | ForEach-Object { $f=Join-Path $_.FullName 'report.json'; if(Test-Path $f){ $r=Get-Content $f -Raw | ConvertFrom-Json; [pscustomobject]@{Directory=$_.FullName;Status=$r.status;PlannedSeconds=$r.requestedSeconds;ActualSeconds=$r.actualSeconds;ReportedAt=$r.reportedAt;Errors=$r.requests.errors;Passed72Hours=$r.qualifiesAs72Hours} } } | Format-Table -AutoSize
```

短预检和正式 72 小时报告分开。正式运行的 `PlannedSeconds` 应为 `259200`。

### 5.3 查看指定报告及日志

把下面路径改为上一步显示的实际运行目录：

```powershell
$run = 'C:\DapingTest\run-20260929\workspace\output\endurance-实际运行目录'
$report = Get-Content "$run\report.json" -Raw | ConvertFrom-Json
$report | Select-Object status, requestedSeconds, actualSeconds, reportedAt, qualifiesAs72Hours, stopReason
$report.checks
$report.requests
$report.memory
$report.databaseEngine.memory
$report.continuity
$report.errors | Format-List
Get-Content "$run\backend.log" -Tail 60
Get-Content "$run\mysqld.log" -Tail 40
```

目录还包含 `report.md`（便于阅读）、`events.jsonl`（事件）、`memory.jsonl`（后端内存）、`mysql-memory.jsonl`（MySQL 内存）。测试根目录有 `endurance.stdout.log`、`endurance.stderr.log`、`run-launch.json`，退出后生成 `run-exit.json`。

## 6. 什么才算通过

- `running`：尚未结束，不算通过。
- `passed`：这一次申请时长及检查通过；若只申请 60 秒，仅能称 60 秒通过。
- `failed`：存在未满足的检查，需要查看 errors、checks 和日志。
- `incomplete`：人为停止、初始化失败等导致未完整执行；不能算通过。

72 小时通过必须同时满足 `status=passed`、`requestedSeconds=259200`、`actualSeconds>=259200`、`qualifiesAs72Hours=true`，并核对连续性、真实进程和完整日志。不能只看零请求错误或把多次运行时间相加。

默认门槛：HTTP p95 不超过 2000 ms；WebSocket 静默不超过 15 秒；后端 RSS 不超过 1024 MiB、预热后单进程增长不超过 256 MiB；MySQL RSS 不超过 2048 MiB、预热后增长不超过 512 MiB。最终采用的门槛以该轮 `report.json.thresholds` 为准。

## 7. 如何安全停止

若还在 `waiting-for-upload` 阶段，可创建 `C:\DapingTest\run-20260929\CANCEL-DEPLOYMENT` 文件取消等待；这时尚无测试运行目录。已进入正式测试后使用下面的 STOP 方式。

先按第 5 节选定正在运行的目录，再创建该轮 STOP 文件：

```powershell
Set-Content -LiteralPath "$run\STOP" -Value 'Stopped by operator'
```

脚本会退出循环、关闭自身启动的后端和私有 MySQL，并生成最终报告。等待报告更新、进程退出后再关机。不要直接删除工作目录或使用按名称批量杀死所有 MySQL/Node 进程的命令。

## 8. 交付与操作边界

服务器只承载独立测试实例；没有接入现场生产数据。安装包、测试工具和证据各自留存。测试通过后仍需在最终 Windows 部署电脑上验证 Unity/WebView2、真实 PLC、显卡和电视显示。公钥、Tailscale 登录和本机私钥不需要写入测试报告。
