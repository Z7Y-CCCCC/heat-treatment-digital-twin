# Windows Server 连接、测试与结果查看手册

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
| 当前连接 | SSH 公钥登录已验证成功 |
| 部署状态 | 服务器计划任务已注册并运行，目前等待安装包完整传输；尚未完成服务器预检和正式长跑 |

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

当前任务已经启动，不要重复启动。仅在任务尚未开始、且没有安装目录和既往运行时，管理员可以使用：

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

本对话已设置每 15 分钟远程检查；正常无变化时不反复通知，正式开始、失败、中断或完成时通知。服务器上的测试独立于本机运行，Codex 关闭会影响自动检查，不会自行停止已启动的服务器计划任务。

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
