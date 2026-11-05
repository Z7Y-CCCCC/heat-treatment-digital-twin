# PLC 无点位连接状态

- 设备管理、点位监视统一将 `offline` 显示为“离线”；已知状态均有中文名称，未知代码不直接露出英文。
- 无可读取点位不再跳过连接判断。连接失败显示“离线”；连接正常但没有可读点位才显示“无点位”。未启用和未填写 IP 的设备保持原来的状态，不额外连接。
- 同端点有正常采集任务时复用其连接状态；否则每 10 秒检查一次协议连接，检查完成立即释放额外会话。失败沿用有界超时与退避重连。
- 不添加虚拟点位，不读取任意 PLC 地址，不执行写操作，不制造采样值、空数据帧或“最近读取”时间。连通无点位仍为 stale，不冒充采集正常。
- 新增/删除点位时切换普通采集任务和连接检查任务；停止后清理定时器和连接。一个端点挂起不阻塞其他端点。

验证：

```powershell
node backend/scripts/plc-empty-connectivity-test.cjs
node tools/plc-empty-s7-smoke-test.cjs
node tools/plc-status-label-ui-test.cjs
npm --prefix frontend test
node backend/scripts/run-tests.cjs
```

连接检查测试覆盖连接失败、超时、恢复、共享连接、点位增删及停机清理。S7 短测使用本机独立 Snap7 仿真进程，真实 nodes7 握手成功后断开仿真端验证离线，确认没有 PLC 内存读取。未连接现场 PLC。

前端 692 项、后端完整套件 82 项通过；页面短测验证中文“离线”与“无点位”的区别。没有安装包安装或长时间采集测试。
