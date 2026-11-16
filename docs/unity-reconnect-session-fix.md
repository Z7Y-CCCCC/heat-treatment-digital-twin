# Unity 重连握手身份修复

## 复现与原因

2026-11-14，隔离后台、真实 Windows Unity 客户端及桌面网关复现：

- `native-exchange` 已成功，`native-confirm` 返回 `exchanged: true, connected: false`，最终握手超时。
- Unity 连接已发送 `client_hello`，但后台记录的连接没有子会话身份；其他在线 Unity 或既有场景不能作为本次握手的证明。
- 实际升级请求仅携带 API 会话名称 `dt_admin_session_<scope>`。后台升级认证读取的是 `dt_admin_session_<scope>_ws`。
- `BackendApiClient.ScopeSessionForWebSocket` 原先只改 Cookie 路径，没有映射名称，因此即使场景就绪，精确会话确认也无法成功。

## 修复边界

从当前 API 主会话明确生成同值的 `_ws` Cookie，限定 `/ws`、HttpOnly，WSS 保持 Secure；每次票据交换后覆盖旧实时身份。不镜像账号选择器或其他账户槽位。清除会话时同时清除实际实时地址的 Cookie。

未放宽后台握手判定，不借用已有连接报成功，不改会话权限、现场配置、PLC 含义、模型或固定出厂模板。当前运行中的大屏不自动重启；旧进程需在另行确认后更新运行端才会使用修复。

## 回归入口

```powershell
dotnet run --project tools/native-runtime-tests/NativeRuntimeTests.csproj --configuration Debug
node --test backend/scripts/native-connection-confirm-test.cjs
node --experimental-test-module-mocks --test --test-concurrency=2 frontend/tests/*.test.mjs
node tools/native-reconnect-smoke-test.cjs --build-test-player
```

最后一项仅在忽略的 `output` 中生成 Development 测试客户端，连接新建的隔离数据库及后台，经过真实桌面网关验证连续三次新子会话握手，并要求场景只构建一次。不会运行安装包／发行构建，不覆盖 `Builds/Windows`，只结束测试自己创建的进程。不把隔离通过说成当前现场进程已经恢复。

## 本轮结果

- 修复前：真实旧客户端重现 `exchanged: true, connected: false`，24 秒内不能确认新握手；新增 Cookie 单测也在原实现上失败。
- 修复后：Development 客户端经过真实桌面网关，三次新子会话握手全部确认；两次场景就绪后的重连分别为 85ms、77ms，场景仅构建一次，登录遮罩未重开。首次初始化包含场景准备，耗时约 3.6 秒；这不是现场网络延迟承诺。
- 原生运行时回归 56/56；握手接口 3/3；前端全量 2091/2091（并发限制为 2）；固定模板回归 6/6，一致性门禁通过。
- 首次隔离 Development 客户端启动时曾超过测试的 15 秒管道等待。测试现先等待客户端初始化，再申请短时票据；**新握手的 24 秒判定与后台精确会话匹配没有放宽**。复用本轮隔离编译的客户端重跑通过。
- 首轮 Ethan 选择暂不重启，故首轮仅完成源码和隔离验证，没有替换运行端。

## 已应用到工作区启动入口

Ethan 随后明确要求应用到 `启动大屏.cmd`。已重新编译该入口经 `desktop/main.cjs` 实际选择的 `unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe` 运行端，不修改启动入口的连接地址、不生成安装包、不启动或重启现场大屏。

- 更新前已在忽略的 `output` 目录保留旧 Unity 运行文件，未复制或改动现场数据库。
- 使用更新后的 **实际启动路径客户端** 连接隔离后台及桌面网关，连续三次新会话握手全部通过，场景只构建一次。两次场景就绪后的重连分别为 102ms、82ms。
- `Assembly-CSharp.dll` SHA-256 为 `ED8BFD82A810DE11BD0BDBD9327EE0AFAFC3B9E466972BE3B38D24C0E95C3C61`，与更新前不同；已有后台宿主文件摘要未变。源码缓存检查确认运行端与当前 484 个 Unity 输入文件匹配。
- 固定出厂模板一致性再次通过。下次正常运行 `启动大屏.cmd` 即使用此次修复，无需更换入口或安装新包。隔离测试通过不等于已启动现场大屏并点击过现场重连按钮。
