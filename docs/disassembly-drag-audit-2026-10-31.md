# 拆解自由拖拽复查 · 2026-10-31

## 修复

- 直接拖动和三轴/平面手柄统一管理指针；Esc、指针取消、捕获丢失、窗口失焦或页面隐藏均回滚整次操作，不留下卡死状态或半条撤销记录。
- 第二指针不能接管拖动、改变选中部件；非法坐标或零缩放基底不会污染草稿。
- 拖动未结束时禁止保存和切换设备；键盘修改也检查编辑权限，只读用户仍可搜索部件。
- 页面恢复不再覆盖未保存草稿；编辑中固定原模型上下文，防止外部替换模型或删除设备导致草稿静默消失。
- 合并重复的页面初始化读取；未变化的设备/模型对象不重载 GPU 和模型资源，已变化的配置仍会重新读取。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| 前端全部测试 | 358/358 |
| 拆解编辑/页面/原生坐标契约（包含在上述总数中） | 45/45 |
| 后端真实 HTTP/WS 布局回归 | 11/11 |
| C# 原生拆解契约 | 39/39 |
| Chromium 真实 GLB 交互 | 19/19，浏览器异常为 0 |
| 前端生产构建 | 通过，仅现有分包体积警告 |
| 真实 Windows Unity 播放器 | 保存后自动同步；同型号另一设备不变 |

浏览器覆盖：直接自由拖动，X/Y/Z、XY/XZ/YZ 约束，撤销/重做，Esc/取消/捕获丢失/失焦回滚，第二指针，数值编辑，装配预览，保存与完整刷新，跨设备隔离，409 保留草稿，继续编辑/放弃/保存后切换，以及取消后的相机旋转。

Unity 使用同一个运行中播放器、两个旋转/缩放不同的真实井式炉实例。修改 A 的 `pf2_hood` 后，其投影锚点从 `(0.532156, 0.305436)` 变为 `(0.598728, 0.301560)`；B 仅有约 `0.000042` 的镜头收敛差异，后端配置逐字不变。无播放器运行异常。

## 复现

```powershell
cd frontend
node --experimental-test-module-mocks --test --test-concurrency=2 tests/*.test.mjs
npm run build
cd ..
npm --prefix backend run test:inspection-layout
dotnet run --project tools/native-inspection-tests/NativeInspectionTests.csproj --configuration Release --artifacts-path output/native-inspection-tests
node tools/manual-disassembly-drag-ui-test.cjs
node tools/native-manual-disassembly-smoke-test.cjs
```

浏览器工具需要本机 Playwright；可通过 `PLAYWRIGHT_MODULE` 和 `BROWSER_EXECUTABLE` 指定安装位置。Unity 工具需要已构建的 `unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe`。

两项端到端工具各自创建隔离数据库及进程，自动清理自己启动的进程，不操作现场数据库、PLC 或 Windows 采集服务。截图、日志和 JSON 证据保存在忽略提交的 `output/` 下：

- `disassembly-drag-audit-20261031/`
- `manual-disassembly-drag-ui-20261031T001148029Z-22364-VBQTDE/`
- `native-manual-disassembly-20261031T000055497Z-24628-VDi0di/`

本次只提交拆解功能修复、测试工具及此验收记录，不包含采集运行中心或安装器的在途改动。
