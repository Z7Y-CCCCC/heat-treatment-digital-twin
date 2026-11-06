# 数据中心动作：原生播放器验收

此脚本验证**新构建的 Windows 播放器实际执行**，不是仅检查源码。它不启动 Unity Editor，不使用已安装播放器，也不连接 PLC。

## 运行

先把当前 Unity 源码构建到本仓库 `output` 下的独立目录，然后在 PowerShell 指定该 exe：

```powershell
$env:MOTION_TEST_UNITY_EXE = 'C:\Users\27323\OneDrive\Desktop\大屏\output\新构建目录\HeatTreatmentDigitalTwin.exe'
node 'C:\Users\27323\OneDrive\Desktop\大屏\tools\motion-data-native-test.cjs'
```

将「新构建目录」替换为实际目录。变量缺失、路径位于 `output` 外或链接到外部文件，脚本直接失败，不回退到旧版／安装目录。

## 验证内容

- 在隔离后台通过 API 新建行程动作与连续转动动作。
- 从真实数据中心目录选择数字字段，以 `dataItemId` 保存绑定。
- 条件 `值 ≥ 0.5`，迟滞 `0.1`：`0 → 0.51 → 0.45 → 0.39`，验证进入、保持和解除。
- 将 `DeviceAnimation` 诊断中的实际节点位置／旋转与编译动作包逐通道比较。
- 验证坏质量冻结、恢复不重置运行相位、停止真实观测后超时；目录后台刷新不得伪造点位更新。
- 验证测试前后 exe 与 `Assembly-CSharp.dll` 的 SHA-256 不变。

每次运行在 `output\motion-data-native-player-*` 新建后台日志、Unity 日志及 `result.json`；失败也保存证据，最后仅终止本次创建的子进程。

确定性 JS／Unity 信号对照另见 `frontend\tests\fixtures\motion-signals.json` 与 Editor 执行入口 `HeatTreatment.DigitalTwin.Editor.MotionSignalRuntimeChecks.Run`。此集成脚本不会调用该 Editor 入口。
