# 后台顶部服务连接区建议

2026-11-14。对应 Ethan 在「检查并继续未完成任务」对话中的“给点意见”。Ethan 随后确认按此方案实施，并要求操作优先用图标。本文保留原建议供对照；实现与验收入口见下节。**确认实施不等于允许无确认地重启现场服务，也不是打安装包的指令。**

## 已实施的接口与交互

- 顶栏四个 32px 胶囊按 Ethan 后续反馈显示**名称＋连接插头**：Unity、设备采集、数据服务、登录状态；保留原圆角与色系。下拉面板操作仍用 SVG 图标，面板与悬停连接区以当前选中服务的胶囊为锚点，按视口边界避让，不从整组胶囊左缘展开。进入面板或点击操作时固定该服务，异步忙态、移焦点与路过其他胶囊不抢走菜单；明确点击其他胶囊或 ArrowDown 才切换选中的菜单。ESC、外点、键盘和窄屏完整名称换行／滚动均支持。
- `GET /api/system/connections/status` 返回当前工厂的脱敏四项观察；无权限不显示设备明细，模拟不绿，数据库失败、场景未就绪、会话失效与通信过期分别呈现。检测不写配置，不读取其他工厂的读数填空。
- Unity 重连由本机宿主取 HttpOnly 当前会话与 CSRF，申请单次 native-ticket 并交给当前父 Unity 的命名管道。`POST /api/admin-auth/native-confirm` 精确核验该票据所建**新子会话**的 Unity 通道，不借其他 Unity 的心跳报成功。此动作保留当前场景；握手成功不等于场景就绪。
- 数据通道重连只重建已启用的 DataStore；后台窗口通过宿主请求透明数据层重连，并等待新 welcome。没有活跃通道明确失败，不创建第二套采集订阅，不 reload 页面、不丢草稿。
- 大屏重启检查已知未保存草稿、进行页面确认及原生确认，宿主重新读取服务器权限后才交给本机私有桌面白名单。202 只显示“已受理”；新进程、宿主数据层与场景就绪后才确认恢复。重启不影响采集服务。
- 采集进程重启沿现有 `/api/engine/restart` 权限与 CSRF；成功需新有效读数，PLC 异常不能被“已受理”刷绿。后台 / Windows 服务管理只打开已有独立运行中心，由中心执行管理员确认。登录状态无“重启登录服务”。
- 设备采集的“打开设备采集管理（状态 / 点位）”使用 `collector_center_data` → `/service/collector-center/data` → `points`，沿用 `settings.data` 采集配置权限；数据服务的“打开数据服务管理（API / 数据库）”使用 `collector_center_runtime` → `/service/collector-center/runtime` → `overview`，沿用 `settings.runtime` 运行配置权限。两个胶囊进入独立的管理工作区，而不只是给同一套页面换标题：设备工作区仅有「采集状态 / 采集点位」，数据服务工作区仅有「API / 数据库 / 后台日志」。前者保留设备计数、采样和采集进程；后者显示 API、数据库、大屏数据通道，不显示设备卡片，也不拿 PLC 失败作为 API / 数据库故障。仍共用同一个真实 `HeatTreatmentCollector` Windows 服务，**不是两个 Windows 服务**。整个后台的安装、启动、停止、重启仅放在数据服务工作区，确认框明确会同时影响采集、API、数据库访问和数据通道。桌面仅接受固定 `--open-view points|overview`，通过当前用户单实例 IPC 定位；原无参数通用入口保留。网页只有在回执同时满足 `success === true`、`opened === true`、`view` 与所选页面一致时才提示已打开，且只作信息提示，不表示 PLC、API 或数据库已恢复。
- 登录状态的“重新解锁后台”先检查未保存草稿、编辑表单及进行中的操作；存在这些内容时拒绝跳转，保留当前认证与修改，不自动保存、丢弃或锁定。无草稿时调用现有 `lockAdmin()`，真实锁定后台并进入 `AdminAccess.vue` 密码页，再由用户重新认证；服务器锁定尚待确认时沿用 `lockPending` 提示。仅入口回调明确返回 `true` 才确认已进入解锁页，缺入口或返回 `false` 不报成功。**进入密码页不等于重新登录成功，关闭或取消密码输入也不会恢复旧认证**。不停止 Unity、采集进程或 Windows 服务，不自动注销全部账户。
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
| 设备采集 | 重新检测；查看设备错误；打开设备采集管理（状态 / 点位）（`points`） | 重启采集进程：影响采集，确认后调用现有权限接口；重启 Windows 服务：从数据服务工作区进入共用后台启停，并经过管理员确认 |
| 数据服务 | 重新检测；重新连接当前页面通道；打开后台概览（API / 数据库，`overview`） | 仅在此工作区提供整个 `HeatTreatmentCollector` 后台服务启停；明确提示同时影响设备采集，不提供第二个冒名服务 |
| 登录状态 | 重新检测；重新解锁后台（先拒绝未保存内容，再真实锁定并进入密码页） | 无“重启登录服务”；不自动注销所有账户，重新解锁必须完成现有密码认证，不恢复旧认证绕过校验 |

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

## 管理范围分离回归（2026-11-14）

`node tools/collector-center-navigation-ui-test.cjs` 在独立进程 / 私有 IPC 夹具中点击真实导航按钮，验证两组页面与启停按钮不会串用；PLC 异常不污染 API / 数据库状态，数据库故障与 API 不可达分别呈现。保留固定 `points|overview` 协议及原权限边界，回执仍严格匹配工作区。前端面板显示各自管理范围，打开提示不再用“同一个后台”混淆职责，也不宣称故障已恢复。测试仅编译隔离原生界面，不安装服务、不触碰现场数据、不生成安装包。

### Ethan 日常入口：启动大屏.cmd

`启动大屏.cmd` 启动前同时检查前端与本工作区管理界面，并传入固定 `--workspace-ui` 标记。仅未打包的桌面宿主在此模式下使用 `ensure-workspace-collector-center.cjs` 编译／校验过的 UI；不再因已安装插件的界面较旧而要求覆盖 Program Files。管理界面按源码摘要分目录，IPC 同时隔离工作区版本与已安装旧窗口，避免新入口仍激活旧界面。编译或摘要检查失败会停止，不回退到旧界面。关闭当前大屏后再双击原启动脚本即可加载新宿主代码。

这只更换管理界面，不构建或安装第二套采集服务、不修改服务地址／数据库／现场设置；实际采集仍沿用本机服务配置。正式安装版的服务定位及主包不附带采集插件的边界保持不变。自动回归见 `desktop/scripts/workspace-collector-center-test.cjs`（已接入 `test:deployment`）。
