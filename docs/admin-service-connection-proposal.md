# 后台顶部服务连接区建议

2026-11-14。对应 Ethan 在「检查并继续未完成任务」对话中的“给点意见”。Ethan 随后确认按此方案实施，并要求操作优先用图标。本文保留原建议供对照；实现与验收入口见下节。**确认实施不等于允许无确认地重启现场服务，也不是打安装包的指令。**

## 已实施的接口与交互

- 顶栏四个 32px 图标胶囊：Unity、设备采集、数据服务、登录状态；保留插头、原圆角与色系。鼠标悬停和无障碍名称说明对象；点击显示状态小面板，面板操作也用 SVG 图标。ESC、外点、键盘和窄屏滚动均支持。
- `GET /api/system/connections/status` 返回当前工厂的脱敏四项观察；无权限不显示设备明细，模拟不绿，数据库失败、场景未就绪、会话失效与通信过期分别呈现。检测不写配置，不读取其他工厂的读数填空。
- Unity 重连由本机宿主取 HttpOnly 当前会话与 CSRF，申请单次 native-ticket 并交给当前父 Unity 的命名管道。`POST /api/admin-auth/native-confirm` 精确核验该票据所建**新子会话**的 Unity 通道，不借其他 Unity 的心跳报成功。此动作保留当前场景；握手成功不等于场景就绪。
- 数据通道重连只重建已启用的 DataStore；后台窗口通过宿主请求透明数据层重连，并等待新 welcome。没有活跃通道明确失败，不创建第二套采集订阅，不 reload 页面、不丢草稿。
- 大屏重启检查已知未保存草稿、进行页面确认及原生确认，宿主重新读取服务器权限后才交给本机私有桌面白名单。202 只显示“已受理”；新进程、宿主数据层与场景就绪后才确认恢复。重启不影响采集服务。
- 采集进程重启沿现有 `/api/engine/restart` 权限与 CSRF；成功需新有效读数，PLC 异常不能被“已受理”刷绿。后台 / Windows 服务管理只打开已有独立运行中心，由中心执行管理员确认。登录状态无“重启登录服务”。
- 新服务操作仅接受同源 `/admin` 页面、有限 requestId、固定动作；桌面 token 留在宿主，不返回网页，不接受 shell、任意端点或远程服务目标。特权 WebView 的外域文档与 iframe 同时由导航和资源层阻断，避免外域预取；正常资源和系统浏览器链接沿用原行为。

验收源码：`frontend/tests/service-connection-control.test.mjs`、`frontend/tests/root-service-channel.test.mjs`、`backend/scripts/admin-connection-status-test.cjs`、`backend/scripts/native-connection-confirm-test.cjs`、`desktop/scripts/service-control-test.cjs`、`desktop/scripts/service-connection-policy-test.cjs`。浏览器入口为 `tools/service-connections-ui-test.cjs`（组件故障态）及 `tools/admin-connection-status-ui-test.cjs`（隔离模拟器与完整后台），均不连接现场库。安装服务和 `启动大屏.cmd` 的实际同步结果另记本轮交付记录，不把隔离测试说成现场验收。

## 建议的显示方式

保留现在的胶囊样式、插头图标、32px 高度、圆角、颜色及紧凑间距。顶部显示四项：

**Unity　设备采集　数据服务　登录状态**

点击胶囊展开同风格的小面板，不把“重启”放成易误触的直接动作。面板只显示：当前状态、最近成功通信时间、必要的故障短句、可用操作。长解释留在帮助页。

- **Unity**：实时通道在线、场景就绪、同步中、离线分别显示；进程存在不等于连接成功。
- **设备采集**：保留各设备在线明细；“服务运行”“采集进程运行”“PLC 在线”“最近读数有效”分层判断。模拟模式明确标“模拟”，不能刷绿冒充真实 PLC。
- **数据服务**：后台 API 可达与数据库连接分别显示；后台活着但数据库异常时显示黄色/红色，不笼统显示正常。
- **登录状态**：显示当前会话有效、已锁定、需登录、检测失败。登录校验和业务 API 在同一个后台进程，**不是独立可重启的“登录服务”**。
- 窄屏允许整组换行或折叠为“服务连接”，弹层限高可滚动、外部点击/ESC 关闭，键盘可打开和操作。

## 操作边界

| 对象 | 首选操作 | 影响较大的操作 |
|---|---|---|
| Unity | 重新检测；重新连接实时通道（需补安全宿主桥接） | 重启大屏：确认未保存内容后由桌面宿主执行，不重启采集服务 |
| 设备采集 | 重新检测；查看设备错误 | 重启采集进程：影响采集，确认后调用现有权限接口；重启 Windows 服务：进入独立采集运行中心并经过管理员确认 |
| 数据服务 | 重新检测；重新连接当前页面通道 | 后台/Windows 服务重启沿同一个受控服务入口，不提供第二个冒名按钮 |
| 登录状态 | 重新检测；返回现有登录/解锁界面 | 无“重启登录服务”，不自动注销所有账户、不清会话绕过登录校验 |

“重新检测”不得写配置、换数据库、切模拟模式、重载场景或开始/停止采集。“重连”不能只是重新检测后提示成功；必须真正重建对应连接，并等待新握手/有效数据。按钮应准确命名。

重启必须有明确影响范围、确认与权限校验；执行中互斥禁用，超时/拒绝/失败都保留真实状态，成功必须重新探测。API 返回已受理不等于恢复成功。远程展示电脑不能直接杀掉另一台电脑的服务。

## 当前可复用的能力

| 能力 | 现有实现 | 可复用范围 |
|---|---|---|
| 顶部胶囊和设备弹层 | `frontend/src/views/admin/components/AdminConnectionStatus.vue` | 原样扩展视觉、颜色、外部点击和键盘关闭逻辑 |
| 当前顶部状态轮询 | `frontend/src/views/AdminPanel.vue` 的 `refreshAdminConnectionStatus` | 目前每 3 秒读取 Unity 连接数及引擎状态，不代表完整服务状态已接入 |
| Unity 连接 | `GET /api/native-preview/status`，`backend/routes/nativePreview.js` | 当前客户端数；完整通信年龄与场景就绪还应取健康聚合字段 |
| 后台、数据库、采集、Unity 健康 | `GET /api/health`，`backend/server.js` | `runtime` 身份，`db.connected`，`collectorHealth`，`components.displayConnection`，`readiness`；前端只使用脱敏摘要，不能复制完整原始响应 |
| 当前工厂采集状态 | `GET /api/collector/status`，`backend/routes/collector.js` | 有 `factoryId` 和当前工厂状态；不可拿其他工厂读数填充 |
| 引擎状态及重启 | `GET /api/engine/status`、`POST /api/engine/restart`，`backend/server.js` | 重启是采集引擎/子进程重启，**不是 Windows 服务或整套后台重启**；已有后台会话、CSRF 和 `settings.data` 编辑/管理员权限边界 |
| 登录状态 | `refreshAdminSession`，`frontend/src/runtime/adminSession.js`；`GET /api/admin-auth/session` | 沿用会话机制，检测失败与未登录分开，不虚构第二套登录状态 |
| 网页实时通道 | `frontend/src/runtime/DataStore.js` | 已有断线 5 秒自动重连、恢复后重新同步；`connect()` 对仍存活的连接幂等，不能当“强制重连”用 |
| 部署连接探测 | `desktop/connectionHealth.cjs`、`deployment:probe` | 限时只读、服务身份校验、脱敏摘要；现有 IPC 仅允许部署窗口，不能直接从普通后台调用 |
| Unity 受控重启 | `desktop/main.cjs` 的 `restartNativeClient()` | 宿主内部已有流程，但没有通用后台按钮安全入口，需新增受限桥接后才能宣称功能完成 |
| Windows 服务操作 | `collector-center/CenterForm.cs`、`collector-center/Operations.cs` | 现有确认、动作白名单、管理员授权、结果管道；首期建议打开运行中心复用，不在网页重新实现任意命令执行 |

`/api/system/runtime` 当前管理开机启动及投屏，不是进程重启接口；不能仅因名字相似而接成“服务重启”。数据库测试/保存接口也不是只读“重连”接口，不能为了连一下覆盖连接配置。

## 实施前缺口（保留原盘点）

1. 顶部数据服务/登录状态胶囊及四项统一交互；当前两项只是状态，不含完整重连重启菜单。
2. 最小脱敏健康摘要及权限过滤。无权限显示“无权限查看”，不要伪装离线；隐藏控制入口不替代服务端鉴权。
3. 真正“重连网页/Unity 实时通道”的受控动作、握手确认及故障反馈；不得重置现场配置。
4. 桌面宿主向后台暴露安全且白名单化的大屏重启/打开运行中心入口；不能向网页泄露桌面控制令牌或允许运行任意 shell。
5. 独立故障测试：API 可达但 PLC 离线、数据库失败、登录过期、Unity 在线但场景未就绪、模拟模式、无权限、重启拒绝/失败/恢复、连续点击、窄屏滚动。

## 原推荐实施顺序

先补齐四项准确状态和“重新检测”；采集服务重启先复用已有运行中心。再做明确权限与握手验证的重连/大屏重启。既简单，也避免把一个故障扩成整套系统重启。

实施和验收不得清库、覆盖布局/模板/绑定、切数据源或自动打包。源码完成还要同步到 `启动大屏.cmd` 实际使用的前端/宿主/服务对应层并验证；建议文档本身不需要部署或打包。
