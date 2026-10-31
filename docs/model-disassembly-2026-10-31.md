# 拆解布局改为模型型号级

- 入口仍为“模型库 → 拆解布局”。下拉框只列模型库中的设备模型，包括尚未安装到现场的型号；不再列车间、产线和具体设备。
- 保存写入模型的 `metadata.inspection`，接口为 `GET/PUT /api/models/:id/inspection`。只修改部件位移，保留模型其他元数据、旋转、时序和 PLC 关联。
- 使用该型号默认布局的现场实例统一同步。已有明确的单机覆盖配置保留，不自动清除；设备表、安装位置及采集配置不因模型布局保存而改写。
- 模型选择和草稿独立保存到界面状态，保留拖动取消、撤销/重做、并发冲突、导出和未保存切换确认。
- 删除“此页面为只读权限……”整句显示。按钮和后台 API 的权限、CSRF 检查不变。

验证：前端 379 项通过；模型 HTTP/WS 回归检查通过（多实例继承、单机覆盖保护、其他型号不变、并发、跨厂权限）；真实 MySQL 连续保存与重读一致；真实 Unity 两个旋转/缩放不同的同型号实例均更新，所有设备记录保持不变。浏览器覆盖真实模型拖动、型号切换、保存/刷新和冲突恢复。

复现入口：

```powershell
node backend/scripts/model-inspection-layout-test.cjs
node tools/manual-disassembly-mysql-test.cjs
node tools/manual-disassembly-drag-ui-test.cjs
node tools/native-model-disassembly-smoke-test.cjs
```

端到端工具仅操作各自 `output/` 隔离数据库与进程。证据汇总于 `output/model-disassembly-20261031/`，不操作当前现场数据。
