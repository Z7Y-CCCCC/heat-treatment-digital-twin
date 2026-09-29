# 功能验证矩阵（2026-09-29）

## 结论与计数口径

**没有完成所有功能的逐项、全界面、全环境验收。** 已有自动化、隔离 API、少量真实浏览器操作和安装包/MySQL 验证；它们覆盖不同层次，不能互相替代。242 个前端测试、36 组后端测试的通过记录，不代表 242 个用户功能或全部按钮均通过，也不代表任意客户设备组合通过。

本表来自实际路由、后台模块及落盘日志盘点；随后按用户要求补跑私有 MySQL 快速灾备（MB），未修改生产代码，未重跑全部测试。下列“已验证”只限列出的断言和运行记录；测试脚本存在但无已读取的执行证据，不计为通过。测试后的代码修改须另行关联回归，不能借用旧日志覆盖新版本。

最新用户决定：取消本机 72 小时测试，改为快速测试，并评估办公室 Windows Server 与 Linux `124.221.0.245` 是否可用。本机 SQLite/MySQL 两条 runner 已 STOP，每小时监测 automation `72` 已暂停；不自动续跑。服务器目前只是评估对象，不表示已连接、部署或通过测试。

## 实际入口

- Vue 路由：`/admin`、`/customer`、`/group`、`/site`、`/hud-preview`、`/overlay`；`/` 是已弃用网页大屏提示。来源：[router/index.js](../frontend/src/router/index.js)。
- 后台主模块：`composer`、`workshops`、`lines`、`devices`、`mobile-devices`、`models`、`factories`、`users`、`platform`、`points`、`point-monitor`、`settings`。来源：[AdminPanel.vue](../frontend/src/views/AdminPanel.vue)。
- 平台子页：大屏设计器、项目与场景、场景与光效；系统子页：后台安全、运行与投屏、数据连接与备份、客户端性能、数据通路、授权与版本。模型子页：模型资产、导入模型、优化与验收、拆解检查、部位绑定。

## 已读取的执行证据索引

| 编号 | 执行记录 | 可证明与不可证明 |
| --- | --- | --- |
| F | [前端日志](../output/platform-closure-final-frontend-tests.log) | TAP 汇总 `tests=242, pass=242, fail=0`；来源为 `frontend/tests/*.test.mjs`，包含纯函数、状态及 Vue SFC 测试。不是 242 次浏览器操作。 |
| B | [后端汇总](../output/quality-suite-20260928T234559649Z-16488-1YGdz0/result.json)、[运行入口日志](../output/platform-next-backend-tests.log) | 36/36 组、各进程退出码 0；汇总的 `log` 字段逐项指向实际日志。`optionalNotRun` 明确包含 MySQL backup、外部 S7/Modbus/OPC UA 模拟器。 |
| U1 | [字段映射浏览器验收记录](../output/playwright/field-next/验收记录.md) | 隔离浏览器实际导入、选字段、预览、确认、保存发布及运行接口取值；`devices.pos_x=-28`，质量 good。不包含 Unity 内实物显示。 |
| U2 | [项目导入后的界面快照](../.playwright-cli/page-2026-09-29T00-03-22-695Z.yml)、[运行预览图](../output/platform-migrated-preview.png) | 提供指定项目迁移/发布界面的历史证据；不是后台所有模块逐页逐控件验收。 |
| H | [HTTP 字段迁移报告](../output/template-http-e2e-20260929T004829638Z-10204-v4DczT/report.json) | `ok=true`；真实 SFC setup 与隔离 HTTP/API：旧端点 404、新字段预览 73.25、发布后读取 73.25、上游变更为 86.5，未误读旧字段 -999。不是浏览器点击测试。脚本：[template-http-e2e.mjs](../frontend/scripts/template-http-e2e.mjs)。 |
| M | [安装包代码真实 MySQL 报告](../output/packaged-project-bundle-mysql-20260929T001924230Z-26844-wF6CNZ/result.json) | MySQL 9.2.0 私有实例；包内模块 SHA256、随机端口与目录均落盘。保存发布、项目迁移、发布引用、再发布、共享图片、真实主键错误回滚 6 项通过。依赖从测试机加载；它是包内业务模块测试，不是每项桌面 UI 点击。脚本：[packaged-project-bundle-mysql-test.cjs](../tools/packaged-project-bundle-mysql-test.cjs)。 |
| P | [安装包首次启动/重启报告](../output/packaged-mysql-smoke-20260929T000643917Z-17480-DBIQBT/smoke-result.json) | 指定 `release-20260929-080530-916` 可执行文件首次启动及重启通过，隔离 MySQL、模板表计数、持久化、上传资源、原生就绪日志、退出均检查。不是所有硬件或安装升级矩阵。 |
| S | [整站恢复日志](../output/project-site-backup-test.log) | 隔离数据库/文件恢复、项目与外观资源、镜像哈希等已执行；范围见日志断言，不代表客户物理断电或远程文件服务器验收。 |
| MB | [私有 MySQL 快速灾备报告](../output/private-mysql-backup-20260929T014201938Z-10832-jh8Y6y/result.json)、[实际 API 子报告](../output/mysql-backup-20260929T014214277Z-25180-4WKIW0/result.json) | 用户取消 72 小时后补测；私有 MySQL 9.2.0、随机端口 65101、独立 datadir 身份核验。实际备份/恢复 12.319 秒，11/11 检查通过：压缩 SQL、数据库设置还原、恢复前回滚备份、整站 manifest/导入、模型和项目/外观资产字节还原。不是 72 小时或物理断电。复跑：`node tools/private-mysql-backup-test.cjs`。 |
| E10 | [600 秒耐久报告](../output/endurance-20260928T233137159Z-6932-90Akyx/report.json) | `status=passed, actualSeconds=600.029, qualifiesAs72Hours=false`；SQLite、模拟采集，20 轮持久化、1 次重启、4 次重连。 |
| EM | [MySQL 60秒报告](../output/endurance-20260929T003959463Z-6288-pDk5df/report.json)、[前一轮61.053秒报告](../output/endurance-20260929T003659363Z-9700-RRcbsz/report.json) | 两轮 `passed`，均不是72小时。60秒这轮记录私有MySQL9.2.0、2轮持久化、1次重启、3次快照校验、109次请求0错误。不能扩展为随后增加负载后的版本也已通过。 |

## 按真实功能域的验证矩阵

表中 B 的测试名对应 `backend/scripts/`，其同名 `.log` 位于 B 的报告目录。F 的测试名对应 `frontend/tests/`，实际通过记录在 F。所有“UI 尚缺”表示未找到覆盖该域完整操作流程的现有证据，不是声称实现不可用。

| 功能域与入口 | 现有执行证据及已验证范围 | 尚未覆盖／不能扩大到的结论 | 当前电脑可补的高价值项 |
| --- | --- | --- | --- |
| 登录、账户槽位、权限与锁定（`/admin`、`users`、`security`） | B：`admin-auth-test.cjs`、`admin-auth-integration-test.cjs`；F：`admin-session.test.mjs`、`native-admin-navigation.test.mjs`。会话/权限相关逻辑及接口回归已执行。 | 未逐个角色用真实浏览器走创建用户、切换、锁定、改密码、权限撤销后所有页面；桌面与浏览器双会话边界未完整验收。 | 隔离管理员/工程师/操作员逐角色 UI 矩阵，含失败提示及登出后回退。 |
| 工厂管理、地理位置（`factories`、集团分布） | B：`factory-isolation-test.cjs`、`factory-geocoder-test.cjs`；F：`factory-directory-editor.test.mjs`、`factory-distribution-preview.test.mjs`。工厂 API/编辑状态及地理相关回归。 | 测试 fixture 不等于每个国家/行政区真实在线地理服务结果；新增、停用、改位置等 UI 尚无完整逐项记录。 | 两工厂从表单创建至地图出现、停用及恢复；断网查询错误交互。 |
| 车间和产线空间（`workshops`、`lines`） | B：`spatial-hierarchy-test.cjs`、`deletion-safety-test.cjs`；F：`factory-scene-config.test.mjs`、`admin-management-placement.test.mjs`。空间结构、删除影响/级联和围墙清理等断言通过。 | 2D 规划器全部拖拽/缩放/坐标输入、撤销与真实 Unity 位置逐项对照未完成。 | 建车间→建线→移动→保存→重载，比较数据库与画面坐标；删除确认取消也应验证。 |
| 设备配置（`devices`） | B：工厂隔离、点位同步、删除安全；M：导入设备 PLC 禁用且源设备不变。F：后台 composables/placement 测试。 | 每种设备类型、全部参数组合、数据丢失边界及模型替换 UI 未逐项覆盖。 | 完整新增/修改/复制/删除 UI 路径、错误字段拒绝、跨工厂切换后草稿归属。 |
| 移动设备／小车（`mobile-devices`、`MobileDeviceMotion.vue`） | F 中场景、检查器、投影相关测试有邻近逻辑覆盖；不能据此算该模块全流程通过。 | 未找到独立移动设备完整 UI 和原生轨道运动端到端报告。 | 高优先：在隔离配置创建小车、轨道/方向/速度、启停与重载；原生画面检查。 |
| 模型上传、资产库、优化验收（`models/library/import/optimization`） | B：`inspection-platform-test.cjs`、`http-integrity-test.cjs`；项目包测试包含 GLTF 依赖、资源字节一致、内置模型复制。F：`gltf-node-identity.test.mjs`。 | 不能据上传/节点解析推断所有 GLB/GLTF 材质正常；超大模型、损坏贴图、压缩材质与各 GPU 实渲尚缺。 | 标准模型上传→预览→保存→设备引用→删除保护，含一份损坏文件及一份带外部依赖 GLTF。 |
| 拆解检查、部件点位绑定（`models/inspection/bindings`） | B：`inspection-platform-test.cjs` 日志列出四个内置设备节点、元数据往返、256 个 PLC 链接、预览不落库、9 类检查命令及广播；F：`inspection-editor-sfc.test.mjs`、`inspection-editor-runtime.test.mjs`、`inspection-hover.test.mjs`。 | WebSocket 命令转发不代表 Unity 动画、碰撞、遮挡、手工镜头和客户模型都正确。 | 四个内置设备逐个实体→透视→拆解→部件→返回；节点运动与模拟点位实际画面对照。 |
| 大屏画布／组件编辑（`composer`、`platform/designer`） | F：`app-dialog-switch.test.mjs`、`widget-renderer.test.mjs`、HUD/场景测试；保存并发期间保留新编辑、冲突保稿、模板撤销等实际 TAP 断言通过。 | 没有全部组件 × 所有属性 × 分辨率 × 事件组合的浏览器覆盖；纯渲染断言不能替代拖拽手感和排版验收。 | 组件类型清单逐个添加、移动、缩放、复制、组合、撤销、保存重开，记录每项结果。 |
| 项目/场景、草稿、发布、恢复（`platform/scene`） | B：`dashboard-designer-test.cjs`、`backend-concurrency-test.cjs`，包含并发修订拒绝、不同自动版本、旧稿发布拒绝等；U1、U2 真实发布；M 真实 MySQL 发布引用和再次发布。 | 多浏览器编辑的所有交互提示、历史发布恢复的全 UI 流程未逐项记录。 | 双会话同场景冲突、历史版本激活后运行读取与 UI 一致。 |
| 模板 JSON、实体重绑定和撤销 | F：`app-dialog-switch.test.mjs`、模板相关 TAP；B：设计器测试；U1、H 提供实际迁移链路。 | 任意模板规模、所有事件/视角交叉引用组合不等于全部测试；无自动语义正确性的保证。 | 一份同时带点击事件、当前设备上下文、多视角、PLC 和外部数据的模板综合往返。 |
| 数据库/API 字段映射（`TemplateFieldMapper.vue`） | F：`template-field-mapping.test.mjs`；U1 SQLite 实际字段 `pos_x`；H 更换 HTTP 端点与嵌套字段、确认后发布运行刷新。 | 没有真实 PostgreSQL、SQL Server 及客户 ERP/MES 全链路证据；候选匹配不是业务语义自动验收。 | 私有 MySQL 字段别名/日期/单位不同的完整 UI；空数据、坏字段、预览后修改使确认失效。 |
| 工厂项目 ZIP（`ProjectBundleTransfer.vue`） | B：`project-bundle-test.cjs`；U2；M。拓扑/点位/模型/草稿/发布/独立设置/资产、ID重映射、坏包拒绝、事务回滚及可选全局外观通过。 | 512 MiB 上限附近压力、磁盘满/杀进程中断所有阶段、任意第三方模型依赖未穷尽；外链资源不离线搬运。 | UI 导入错误包和取消操作；较大资源包压力；选择共享外观前后的本机其它工厂对照。 |
| 集团地图/Logo/加载画面（设计器相关子面板） | B：`group-portal-settings-test.cjs`、`appearance-assets-test.cjs`、`map-surface-schema-test.cjs`；F：地图几何、外观、加载配置；M：共享图片迁移与回滚。 | 设置 schema 和文件字节正确不代表所有层级排版、Logo透明边缘、加载流程实机画面通过。 | 地图各层级外观覆盖、图片上传、刷新/重启、无效图片和慢加载真实 UI。 |
| 街道厂区、围墙、光照画质（`environment`） | B：空间/原生 dashboard config；F：`site-scene-config.test.mjs`、`map-preview-geometry.test.mjs`、`live-scene-projection.test.mjs`。 | Unity 光影、后处理、显卡差异、围墙碰撞/视觉效果和各画质性能未完整实测。 | 本机三个画质档、开关围墙/环境，截图、帧率、保存后重启；其它 GPU 仍需另机。 |
| 数据源连接、认证、表/字段发现（`settings/database`） | B：`data-source-test.cjs`、`data-source-http-regression-test.cjs`、`data-source-designer-test.cjs`；F：数据源相关；HTTP OAuth/响应解析等 fixture 回归已执行。 | mock/本地 HTTP fixture 不等于所有真实认证服务器；基线总套件未运行的 MySQL backup 已由独立 MB 快速实测补齐；PostgreSQL/SQL Server 仍无本轮真实实例证据。 | 隔离各数据库驱动逐个测试连接、发现字段、查询、超时、账号权限不足；不能接生产库试错。 |
| PLC 连接和数据通路（`settings/data`、设备 PLC） | B：`plc-protocol-test.cjs`、`plc-value-precision-test.cjs`；S7/Modbus TCP/OPC UA 的协议适配、超时/重连与精度等测试通过。 | B 明确未跑外部协议模拟器套件；也未连接客户真实 PLC，不能声称现场接通。 | 可启动本机外部协议模拟器补真实 TCP 流程；设备型号、地址表、工业网络断线恢复仍需现场。 |
| 点位配置、同步与监视（`points`、`point-monitor`） | B：`data-point-sync-test.cjs`、PLC 精度；F：`admin-composables.test.mjs`、`data-store.test.mjs`；M 数字点位ID迁移并重新发布通过。 | 监视页筛选/批量编辑全部 UI、几千点吞吐、真实数据单位/比例口径未逐项验收。 | 模拟设备下批量导入→监视→编辑→重启一致性及超量点位测试。 |
| 告警、历史和语音 | B：`voice-feature-test.cjs` 有实际生成 WAV 文件及归档记录，`business-data-test.cjs`；F：`voice-announcer.test.mjs`、数据存储测试。 | 生成声音不等于实际扬声器播放、音量可闻、告警现场业务正确；同时大量告警的人工可用性尚缺。 | 告警上升/下降沿、冷却、确认、音频试听、重启重复播报 UI；扬声器听感需人耳。 |
| 运行界面和导航（`/group`、`/site`、`/hud-preview`、`/overlay`） | B：`runtime-display-test.cjs`、`native-dashboard-config-test.cjs`；F：导航、runtime、overlay、HUD；P 原生启动日志；U1 运行数据值一致。 | API 就绪不等于所有叠层正确。Unity/WebView2 焦点、透明度、全屏、分辨率、多屏多DPI与全部返回路径尚缺完整实机矩阵。 | 本机原生多级钻取/返回和后台往返，叠层截图、输入焦点、窗口缩放。 |
| 投屏与操作中心（`/customer`、`settings/runtime`） | B：`cast-discovery-test.cjs` 13 项包含 SOAP 错误、多网卡选址、缺 ffmpeg 明确失败、token 路径；`runtime-display-test.cjs`。 | mock/本机流服务不代表每种电视 DLNA、Wi-Fi、分辨率/音视频同步通过；未提供实际电视长播证据。 | 本机接收端/流断开恢复可补；真正电视发现、播放、切换、掉线仍需设备。 |
| 数据库/整站备份、恢复和异常重启 | B：`database-retention-test.cjs`、`site-backup-test.cjs`、`power-recovery-test.cjs`、恢复边界测试；S 项目/外观文件恢复；M MySQL 事务失败；P 重启持久化；MB 新补私有 MySQL 真实 API 备份→改设置/资产→恢复，11 项检查通过。 | 应用强制重启不等于物理断电；MB 不覆盖全部灾备故障和 UI 路径。目标磁盘满、坏盘、网络镜像掉线未穷尽。 | 在已有真实 MySQL API 成功路径上补恢复失败/中断和 UI 提示；物理断电另验。 |
| 授权、版本、验收报告（`settings/license`） | B：`license-test.cjs`、`release-package-test.cjs`、`production-readiness-test.cjs`；报告契约与健康检查不伪称原生就绪等断言通过。 | 当前机器合法/失效许可的全部 UI、机器迁移、离线时钟/签名异常场景未逐项实机验收。 | 隔离测试签名许可证有效/过期/机器不匹配；客户正式许可证不用于破坏测试。 |
| MCP 工具入口（`/api/mcp`） | B：`mcp-platform-integration-test.cjs`、鉴权/接口完整性相关。 | 不是所有 MCP 工具参数组合或外部客户端兼容都已验收。 | 从实际 MCP 客户端跑只读清单和隔离项目保存发布一次，检查工具错误提示。 |
| 安装、退出、自启动、CI/CD、长期运行 | P 初次启动/重启；M 包内MySQL代码；E10 600秒隔离耐久。构建配置存在不计远端CI执行通过。 | 未逐项验收升级覆盖/卸载/自启动/所有Windows权限与路径组合；本机72小时已取消，两个最终报告均未完成；没有本轮GitHub远端CI成功run链接。 | 优先本机快速回归及隔离安装测试；评估其它主机可用性。远端CI须独立查run证据，不恢复本机长跑。 |

## 长稳状态必须单独判断

- 已完成且通过：E10 的 600.029 秒 SQLite/模拟后端测试，不能改称 72 小时或真实 PLC 现场。
- 已完成且通过：EM 的两轮私有 MySQL 短测试分别为 61.053 秒和 60 秒；后续另有 60.002 秒、33.168 秒短测通过（见耐久验收文档），都不能改称 MySQL 72 小时。
- [SQLite最终报告](../output/endurance-20260929T000354815Z-24156-vIXMaP/report.json)：原 runner PID 24156，实际 4813.322 秒，`incomplete`、`STOP file`、请求错误 0、`qualifiesAs72Hours=false`。
- [MySQL最终报告](../output/endurance-20260929T012017015Z-1508-DOmvds/report.json)：原 runner PID 1508，实际 217.114 秒，`incomplete`、`STOP file`、请求错误 0、`qualifiesAs72Hours=false`。
- 两条长跑均因用户取消而停止，不是通过，也不应写为崩溃；零请求错误不改变未完成判定，时长不能合并。每小时监测 automation `72` 已暂停，不在本机继续。
- [更早MySQL短跑尝试](../output/endurance-20260929T004545505Z-24488-UwFxtc/report.json) 记录 `incomplete`、`setup or fatal error`、实际 0 秒，不应算通过。它与上述 STOP 取消是不同原因、不同运行，历史记录保留。
- 真实 MySQL 项目迁移 M 已通过，但不因此推出 MySQL 长稳通过；快速测试和服务器可用性评估也不能替代真实 Unity、PLC、电视及现场网络验收。

## 建议优先补测顺序

1. **本机后台完整 UI 主流程**：按真实主模块逐页列控件，至少一次成功、一次失败/取消、一次保存重开；优先移动设备、模型导入与拆解、点位监视、历史发布恢复、共享外观覆盖。保存浏览器快照和请求结果，而不仅是截图。
2. **安装包原生运行闭环**：加载→登录→地图→厂区→车间→产线→设备→拆解→返回→后台→发布更新，检查真实叠层、输入焦点和画面变化。
3. **私有 MySQL 灾备故障边界及真实驱动扩展**：用户要求的快速成功路径已由 MB 补齐，继续补故障/中断边界；办公室 Windows Server 与 Linux `124.221.0.245` 的可用性、可运行组件及测试成本先评估。不自动在本机或其它主机重新启动 72 小时测试。
4. **资源与规模边界**：大项目包、带依赖模型、较多设备/点位/组件、磁盘空间不足等，在隔离目录执行；不能借“普通小样通过”推断所有规模。
5. **现场验证清单**：客户 PLC 型号/地址/单位、客户 ERP/MES 鉴权/数据口径、电视型号、多显卡/DPI、断网/物理断电、72小时连续运行。这些不能只靠当前电脑完成。

本矩阵不计算一个未经定义的“功能覆盖率百分比”，也不宣称“全功能测试通过”或“所有 bug 清零”。
