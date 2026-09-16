# 指定 PLC 仿真调试器加测报告

日期：2026-09-11（Asia/Hong_Kong）。

使用工具：`C:\Users\27323\OneDrive\Desktop\PLC仿真调试器` 中的 `snap7_engine.py`、`modbus_engine.py`、`opcua_engine.py`。

测试链路是实际协议服务 → 大屏后端 PLC 采集器 → WebSocket 数据帧，不是仅检查仿真器自己能读写。所有协议只绑定 `127.0.0.1`，使用新建 `output` SQLite 和独立端口；没有启动默认 GUI 工程、修改网卡别名、读取现场业务库或连接真实 PLC。仿真器的源码和工程文件未编辑，子进程已清理，测试端口已释放。

## 新发现并修复：浮点数被过早舍入

三个协议均真实复现：仿真器保存 `REAL = 0.125`，大屏 WebSocket 却返回 `0.13`，同时质量仍为 `good`。

根因在 `backend/services/plcReader.js` 的 `_convertValue`：REAL/LREAL 在量程转换前执行 `toFixed(2)`。这既损失第三位小数，也会把需要后续放大的小信号提前变为零。

修复仅移除这个提前舍入步骤；保留已有量程、偏移和表达式阶段的三位小数输出策略，没有放宽测试容差。新增禁网单元回归验证 REAL/LREAL 原始精度，以及 `0.00125 × 1000 + 1 = 2.25` 的转换顺序。LREAL 是转换函数单元验证，不是本轮仿真器的协议点位类型。

## 修复后结果

| 协议 | 已验证点位类型 | 边界数据 | 更新延迟 P95 | 故障与恢复 |
| --- | --- | --- | --- | --- |
| S7 | BOOL / BYTE / WORD / INT / DWORD / DINT / REAL | 25/25 | 170 ms（40 次采样） | 171 ms 标坏，4182 ms 判离线，重启后 991 ms 收到首个正确帧；全部 7 点恢复通过 |
| Modbus TCP | 同上 7 种 | 18/18 | 207 ms（8 次采样） | 2803 ms 判离线，重启后全部点位恢复用时 4264 ms |
| OPC UA | 同上 7 种 | 18/18 | 234 ms（8 次采样） | 3000 ms 判离线，重启后全部节点恢复用时 3744 ms |

合计 **61 组边界数据、33 项端到端验收检查全部通过**。包括 BOOL false/true、零值、负数、WORD 65535、DWORD 4294967295、DINT -2147483648 和 REAL 0.125 等。

S7 连续采集 **120 秒**，收到 **839 帧**，最大帧间隔 **277 ms**；断线后所有点位质量转为 bad，重启后全部点位恢复，恢复后的 8 次新值采集也通过。

Modbus 与 OPC UA 同时工作时，分别停止其中一条协议：故障侧所有点位保持 bad；另一侧连续 3 个新值仍按新帧到达且为 good。双向隔离均通过，不再只依据 connected 文案判定“正常”。重启时初始化并检查全部点位，包含之前遗漏的 OPC UA Running 节点。

相关回归也通过：PLC 协议测试、25 项后端并发/生命周期测试、数学表达式测试、REAL/LREAL 精度单元测试（网络尝试次数 0）。新的精度回归已加入 `npm --prefix backend test`。

## 证据

以下路径相对大屏仓库根目录：

- 修复前 S7：`output/plc-integration-20260911T001527074Z-5752-d0AB09/result.json`
- 修复前 Modbus/OPC UA：`output/plc-simulator-protocols-20260911T001938384Z-21780-jcPjUn/result.json`，同时保存仿真器值 0.125 与收到的错误值 0.13。
- 修复后 S7：`output/plc-integration-20260911T002432094Z-1672-Uo8mCa/result.json`
- 修复后 Modbus/OPC UA：`output/plc-simulator-protocols-20260911T002650193Z-26172-GQvdUx/result.json`

## 重复执行

在仓库根目录的 PowerShell 中执行：

```powershell
$env:PLC_SIMULATOR_DIR = 'C:\Users\27323\OneDrive\Desktop\PLC仿真调试器'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PLC_STABILITY_MS = '120000'
$env:PLC_LATENCY_SAMPLES = '40'
$env:MODBUS_TEST_PORT = '15020'
$env:OPCUA_TEST_PORT = '14850'
Remove-Item Env:PLC_TEST_SOURCE_DB -ErrorAction SilentlyContinue
node backend/scripts/plc-integration-test.cjs
node backend/scripts/plc-simulator-protocol-integration-test.cjs
npm --prefix backend run test:plc-precision
```

需要 Node 22.12+、该工具所需 Python 依赖和 `runtime/snap7.dll`。端口被占用时测试会寻找空闲端口，不终止别人的进程。

## 边界

本轮验证了七种基础类型、精度转换、持续采集、进程故障和恢复；没有验证真实 PLC 安全联锁、物理断电、网络半开/丢包/带宽限制、OPC UA 证书安全策略或数天长稳。120 秒测试不能等同于长期稳定性认证。未重新打包或覆盖原安装包。
