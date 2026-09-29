# 隔离耐久测试与现场 72 小时验收

## 当前决定：本机长跑已取消

用户已明确取消当前电脑的 72 小时测试，改为快速测试，并评估办公室 Windows Server 与 Linux 主机 `124.221.0.245` 是否适合作为后续测试环境。本机两条 runner 均已通过 STOP 文件停止，每小时监测 automation `72` 已暂停；不自动续跑或重新启动。服务器可用性仍在评估，本文不表示已连接、已部署或已启动服务器测试。

## 可重复运行的隔离测试

在仓库根目录使用项目要求的 Node.js 和已安装的 backend 依赖：

```powershell
node backend/scripts/endurance-test.cjs --duration-seconds 600
node backend/scripts/endurance-test.cjs --database-type mysql --duration-seconds 60
```

两条分别申请 SQLite 10 分钟和私有 MySQL 60 秒快速测试；这是可复用操作说明，不表示现在已启动。测试没有快进时间。程序为每次运行创建独立的 `output/endurance-*` 目录，初始化新的数据库，强制工厂采集模式为 simulation、关闭所有 PLC 设备采集并绑定随机回环端口。它不接受外部服务地址或现场数据库路径，不会复用运行中的现场后端。

MySQL 模式默认使用 `desktop/resources/mysql` 中随包运行文件，可用 `--mysql-runtime-dir "C:\path\to\resources\mysql"` 指定含 `bin/mysqld.exe` 的运行目录。此参数只指定程序文件，不复用该程序已有数据。工具创建全新私有 datadir、随机回环端口和随机密码，通过 `@@datadir` / `@@port` 验证归属，以隔离种子初始化数据库。配置文件含本次测试密码，仅保存在本次目录，不写入报告或命令行。

MySQL 模式的故障演练会先结束被测后端，再关闭并重启本次私有 mysqld，然后重启后端核对恢复；默认只演练一次。每轮保存/发布和恢复后，除 HTTP 核对外还直接查询该私有 MySQL 的场景修订、草稿内容和当前发布 ID，避免误把 SQLite 写入当成 MySQL 测试。JSON 的 `databaseEngine` 记录类型、MySQL 版本/端口/datadir、进程代和直接核对次数。内存指标当前只采样 Node 后端，不代表已经测量 MySQL 服务内存泄漏。

启动输出包含 runner PID、backend PID、回环 URL 和 STOP 文件路径。每分钟输出进度并刷新 `report.json` / `report.md`。

可调阈值：

```powershell
node backend/scripts/endurance-test.cjs --duration-seconds 600 --interval-seconds 5 --max-p95-ms 2000 --max-ws-silence-seconds 15 --max-rss-mb 1024 --max-rss-growth-mb 256
```

应在测试前约定阈值，不能因实测失败临时放宽后宣称原门槛通过。HTTP 延迟包含 JSON 读取，p95 使用 10 ms 桶的上界值；内存来自被测后端进程本身，不是测试脚本进程。内存增长按每次重启后的独立进程代计算，优先使用启动 60 秒后的样本作为基线；短到没有预热样本时报告会明确标记。

## 实际覆盖

- 持续 HTTP 健康、实时点位及数据源列表请求。
- 每 30 秒真实服务端草稿保存、修订号读取、发布和运行版本核对；删除本工具上一轮历史版本，避免把无限发布记录增长误判为泄漏。
- 持续接收含设备数据的 WebSocket 实时帧，并检测超过阈值的静默。
- 每 2 分钟主动断开并建立新 WebSocket，等待新的实时帧后记为重连成功。
- 默认只在第 5 分钟强制终止隔离后端一次，此后持续运行，避免反复重启掩盖长期内存增长。少于 10 分钟的短测试在计划时长一半执行这一次重启。重新启动同一隔离数据库，核对草稿修订号、内容、当前发布版本及新实时帧。
- 仅重复故障演练才显式设置 `--restart-interval-seconds 3600`，在首次重启后按指定秒数继续重复；报告 `restartPolicy` 记录 once/repeated、首次时间和重复间隔。长期内存观察应保留默认 once 策略。
- 每 5 秒采样后端 RSS、heapUsed、heapTotal、external 和 arrayBuffers；报告进程代、峰值和增长。
- 请求错误、内容断言失败、实时数据停滞均保留证据；有错误不能判为通过。

## 停止和判定

可按 Ctrl+C，或者在启动输出给出的当前运行目录中创建名为 `STOP` 的文件。程序会在当前请求/循环完成后停止，关闭 WebSocket、结束自己启动的后端并写最终报告。常规请求超时为 10 秒，启动等待为 30 秒；停止不会终止机器上其他后端。

- `running`：正在运行，不能用作验收结论。
- `passed`：申请的实际时长已完成，全部检查和阈值通过。
- `failed`：实际时长完成，但有错误或阈值不满足。
- `incomplete`：提前停止、启动失败或未完成申请时长；即使暂时没有错误也不能判为通过。

退出码分别为通过 `0`、失败 `1`、未完成 `2`。被系统强制结束整个测试脚本时可能没有机会写最终结果；遗留 `running` 报告也视为未完成，不得当作通过。`qualifiesAs72Hours` 只有实际工作负载满 259200 秒且全部通过才为 true。10 分钟通过只证明本次短时隔离实测通过。

证据保留在本次运行目录：`report.json`、`report.md`、`events.jsonl`、`memory.jsonl`、`backend.log` 和隔离数据库。报告不包含管理 token。

## 后台启动和观察（Windows）

在仓库根目录执行以下命令，启动隐藏窗口的后台进程；本段为操作说明，不会由工具自动调度或重启：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path (Get-Location) "output/endurance-launch-$stamp.stdout.log"
$stderr = Join-Path (Get-Location) "output/endurance-launch-$stamp.stderr.log"
$runner = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('backend/scripts/endurance-test.cjs', '--duration-seconds', '600') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$runner.Id
```

启动已授权的 MySQL 短测时，将上述 `-ArgumentList` 改为 `@('backend/scripts/endurance-test.cjs', '--database-type', 'mysql', '--duration-seconds', '60')`。SQLite 与 MySQL 各自创建独立目录、随机端口和进程，可分别观察；不能把两次运行的时长累加成一个通过结果。

启动后第一行标准输出是 JSON，包含本次独立目录和停止文件。等待第一行出现后可读取：

```powershell
$launch = Get-Content -LiteralPath $stdout -TotalCount 1 | ConvertFrom-Json
$reportPath = Join-Path $launch.directory 'report.json'
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$report | Select-Object status, reportedAt, actualSeconds, cycles, restarts, reconnects, frames, restartPolicy
Get-Process -Id $launch.runnerPid -ErrorAction SilentlyContinue
```

报告每分钟更新；观察时应同时检查 `reportedAt` 是否持续更新以及 runner PID 是否仍存在。文件恰好写入时读取失败，可隔数秒重读。进程已退出但报告仍为 `running`，或进程存在但报告长时间未更新，均不可视为通过，需要检查 stdout/stderr 和 backend.log。不要为继续累计时长而自动启动新的运行来拼接旧结果。需停止时在 `$launch.stopFile` 创建 STOP 文件，等待报告变为 `incomplete` 和进程退出。

## 现场 72 小时仍需完成的验收

隔离工具不会启动 Unity、WebView2、浏览器渲染、电视投屏或客户真实 PLC，也不会验证客户数据库驱动和网络设备。因此需要在交付机器另行记录：

1. 设备型号、系统版本、显卡与驱动、显示器/电视分辨率、程序版本、安装包哈希、配置/发布版本和测试起止时间。
2. 真实只读 PLC 点表逐项核对，记录坏质量、断线、恢复、数据延迟及累计错误；不能以模拟帧代替。
3. 使用真实外部数据库和最小权限账号核对业务字段、超时、断连恢复及数据更新时间。
4. 在实际 Unity/WebView2 和电视运行路径下持续记录 FPS、内存、句柄、CPU、GPU、首次加载和点击响应；检查数据层与三维视角是否同步。
5. 按预定计划执行网络断连、客户端重连、程序重启和设备上下电恢复；由现场人员确认断开操作的范围和安全条件。每次故障都需记录触发时间、恢复时间和数据核对结果。
6. 先建立外部介质备份并验证恢复，再开展现场断电/损坏恢复演练，保留恢复前后版本和数据证据。
7. 满足连续 72 小时、预先约定阈值、无未解决错误后签收；中断或发生无法解释的缺帧、崩溃、数据丢失要标记未完成/失败并修复后重测。

本轮短时结果及任何隔离测试不能自动替现场人员签署 72 小时交付验收。

## 2026-09-29 本轮真实执行结果

- 主隔离测试申请 600 秒，实际工作负载 600.029 秒，结果 `passed`，`qualifiesAs72Hours: false`。
- 完成 20 轮草稿保存/发布/运行版本和草稿读取核对、1 次强制后端重启恢复、4 次 WebSocket 主动重连、299 个含设备数据的实时帧。
- HTTP 489 次、错误 0，p95 上界 50 ms，最大 199.1 ms。
- 被测后端 RSS 峰值 89.42 MB；按各进程代预热后基线计算，最大增长 5.98 MB。
- 主报告：`output/endurance-20260928T233137159Z-6932-90Akyx/report.json` 和同目录 `report.md`。
- 提前停止验证：实际 15.25 秒，生成 `incomplete` 且 72 小时标记为 false；目录 `output/endurance-20260928T233238034Z-20644-GxDwCs`。
- 判定失败验证：独立 30 秒测试故意将 RSS 门槛设为 1 MB，实际 30.018 秒后正确生成 `failed`；目录 `output/endurance-20260928T233619984Z-27552-dN7o1r`。这是测试判定器的预期失败，没有改变主测试门槛。
- 启动自检前两次因引擎尚未就绪及工厂级设置覆盖全局 simulation 而中止，均保留 `incomplete` 报告；工具随后补充就绪等待，并在新建隔离库内设置工厂级 simulation。全部设备 PLC 采集始终禁用。
- 测试结束后对应 runner 和被测后端进程已退出。72 小时现场运行尚未执行。

## 已按用户要求停止的两次长跑

| 引擎 | 原 runner PID | 实际秒数 | 最终状态 | 停止原因 | 请求错误 | 报告 |
| --- | --- | --- | --- | --- | --- | --- |
| SQLite | 24156 | 4813.322 | `incomplete` | `STOP file` | 0 | [SQLite 报告](../output/endurance-20260929T000354815Z-24156-vIXMaP/report.json) |
| 私有 MySQL 9.2.0 | 1508 | 217.114 | `incomplete` | `STOP file` | 0 | [MySQL 报告](../output/endurance-20260929T012017015Z-1508-DOmvds/report.json) |

两者均未完成申请的 72 小时，**不是通过**。零请求错误只描述已运行片段，不改变 `incomplete`。停止源自用户取消，不应写为崩溃或测试门槛失败；时长也不能合并。

MySQL 这次运行采用独立目录、随机端口与凭据，记录真实数据库查询和后端/MySQL 分开的内存指标。217.114 秒早于计划的第 5 分钟故障恢复，因此不能声称这次长跑已完成该恢复检查。其前序 60.002 秒短测和加入 MySQL 内存门槛后的 33.168 秒短测已各自通过；后者报告为 [33.168 秒短测](../output/endurance-20260929T011013063Z-16264-CXqZGu/report.json)。更早新增测试表导致种子校验拒绝的 0 秒 `incomplete` 记录继续保留，不计为有效通过。

当前执行方向为快速测试，以及办公室 Windows Server 与 Linux `124.221.0.245` 的可用性评估。后续是否在其它主机运行、运行何种组件与时长，须依据评估结果和用户后续指示；不继续本机 72 小时。每小时监测 automation `72` 已暂停。
