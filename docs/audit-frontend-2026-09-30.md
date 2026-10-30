# 前端功能验收记录（2026-09-30）

最终结论：前端全部现有及新增自动化测试 **264/264 通过**（40 个文件，2026-09-30 最后全量运行），生产构建成功。初始自动化轮次之后，已在隔离后端执行设计器、模板 HTTP 映射、项目场景、用户权限及安全设置的真实浏览器流程；发现并修复模板错误反馈、已有账号无法编辑、备份失败误报成功等问题。详细证据和边界见后续补充章节，**不代表所有页面、现场设备和浏览器交互已完成端到端验收**。

## 环境、命令与隔离

- 工作目录：`frontend`；Windows；Node `v22.13.1`；npm `10.9.2`；Vite `8.1.5`。
- 首轮 `npm test`：244 通过，0 失败，0 跳过，约 11.03 秒。
- 新增 `router-access.test.mjs` 6 项、`customer-operations.test.mjs` 8 项。
- 初始补测后 `npm test`：39 个测试文件，258 通过；真实浏览器发现问题后新增模板错误对象 2 项、备份失败对象 2 项、账号编辑 2 项，最后全量 **40 个文件，264 通过，0 失败/取消/跳过，10.77 秒**。
- 最新 `npm run build`：成功，783 个模块转换；包含上述前端修复。保留现有大于 500 kB 分块提示，未为了消除提示改变功能。
- `git diff --check` 对本轮前端修复及新增测试通过。
- 完整本地输出：`docs/audit-frontend-2026-09-30.tap.log`、`docs/audit-frontend-2026-09-30.build.log`。日志受现有 `*.log` 忽略规则管理，未强制加入版本控制。
- 初始自动化轮次的业务 HTTP、账号、投屏、数据库及语音使用内存替身；后续另启独立 Chromium、真实隔离后端/SQLite/HTTP 夹具，见补充章节。未连接现场数据库、PLC、电视或改动生产账号。
- 初始轮次没有真实浏览器；后续已执行 DOM 交互与截图检查。原生 Unity/WebView2 和后端负载由其他验收报告记录。

## 本轮发现并修复的问题

### F-01：初次备份清单晚到，覆盖刚创建的备份

位置：`frontend/src/views/CustomerOperations.vue` 的 `loadBackups` / `createDatabaseBackup` / `createSiteBackup`。

稳定复现：让首次数据库清单请求挂起，执行“创建备份”并成功得到 `new.sql.gz`，再返回旧清单 `old.sql.gz`。修复前真实编译 SFC 的状态变回 `old.sql.gz`，断言输出为 `actual: old.sql.gz / expected: new.sql.gz`。清单中的新备份会暂时消失，误导用户以为创建未生效。

修复：数据库和整站清单分别维护版本；创建成功后使旧读取结果失效；新读取请求也会使旧读取请求失效。两类清单独立，创建整站备份不会阻止数据库清单刷新。页面卸载后忽略未完成请求的状态写入。

验证：数据库和整站两种慢响应、另一类清单仍可更新、重复按钮点击合并、卸载后晚到结果，共有直接行为断言；均通过。

### F-02：读取失败响应先清空有效清单，再报告失败

位置：同上 `loadBackups`。

稳定复现：已有 `saved.sql.gz` 后返回 `{ success: false, error: 'offline' }`。修复前 fulfilled 响应被当作列表使用，`backups || []` 先清空清单，断言为 `actual: undefined / expected: saved.sql.gz`。

修复：只有没有错误、未声明失败且 `backups` 确为数组的响应才能更新清单；失败保留原列表，并继续更新另一份成功清单。

验证：失败提示保持可见、旧数据库清单保留、成功整站清单正常更新；通过。

上述两项在新增测试首次运行中为 **3 通过 / 2 失败**，修复后对应 5 项全部通过；扩展覆盖后该文件 **8/8 通过**。旧的 244 项全绿未发现这些问题，不能据旧套件结果推断未测页面完全可用。

## 证据级别

- **逻辑执行**：直接运行生产 JS、Vue 组合函数、Three.js 场景/数学代码；外部服务与时间可被替代。能验证数据流和边界，不能证明真实浏览器绘制、硬件或后端保存。
- **SFC setup 执行**：编译真实 `.vue` 脚本，在 Vue 自定义内存 renderer 中挂载，模板另做编译检查或 render 置空。能执行生命周期、watch、保存/导入流程，不能视为点击了完整页面。
- **SFC 模板执行**：实际编译模板生成 VNode，并在内存节点中触发部分事件；或 SSR 渲染生产模板片段。比源码匹配强，但无浏览器布局、真实文件选择器或可视命中测试。
- **真实回环传输**：真实 HTTP/WebSocket socket、消息与连接生命周期；该用例不包括 Unity 或浏览器进程。
- **源码断言**：读取源码做 regex/字符串断言，仅证明代码接线存在。测试名称中的“render”“mounted”等字样不改变此限制。
- **构建**：Vite 完整编译、模块解析与产物生成；不执行所有运行时分支。

## 路由与入口验收

新增路由用例使用**真实 Vue Router 内存 history、生产路由表和守卫**；页组件替换为空组件，账号状态和 native bridge 替代。不是浏览器地址栏导航或页面渲染。

| 路径 | 页面/用途 | 已执行 | 未验证 |
| --- | --- | --- | --- |
| `/admin` | 登录与后台编辑 | 匿名入口；编辑权限保留后台；只读账号转向允许页面；session 请求初次完成后导航 | 登录表单完整输入/首次初始化/验证码式限时反馈、真实账号服务与所有 AdminPanel 页签 |
| `/group` | 集团/世界/国家/省市工厂地图 | 匿名重定向及返回目标；标题；层级、拓扑、坐标、地图数据处理 | 真实 WebGL 地图渲染、选点、缩放、标签遮挡、各层往返实际点击 |
| `/site` | 工厂街景和下钻 | 访问守卫；场景配置和进入条件逻辑 | 街景图片加载、建筑点击、真实页面下钻与返回 |
| `/hud-preview` | 工厂 HUD 配置预览 | 守卫；场景变换和实时投影数学；订阅传输 | 真实 GPU、模型资产加载全链、图文与模型对齐 |
| `/overlay` | 原生透明数据层 | 守卫；只有带真实模拟 bridge 的标记 overlay 可在未登录时保留空透明入口；控件与图表部分 VNode | 真实 WebView2 透明、窗口层级、鼠标穿透、Unity/浏览器边缘对齐 |
| `/customer` | 现场投屏/备份 | 权限分流；native overlay 请求不透明 host 展示；新增实际页面 setup 行为 | 真实投屏设备及握手、落盘备份与下载、实体按钮布局/点击 |
| `/` | 明确弃用的旧网页大屏入口 | 匿名登录返回统一转到 `/group`；路由和弃用组件构建 | 未将此入口当作新的三维运行页验收 |

## 功能覆盖与缺口

| 功能 | 本轮执行的证据 | 结果与边界 |
| --- | --- | --- |
| 登录、多个账号、锁定、会话过期 | `admin-session` 11；`router-access` 6；原生入口辅助函数 13 | Cookie/CSRF 范围、晚到 401、锁定并发、账号切换、守卫分流通过；身份服务与真实浏览器 Cookie 策略未测 |
| 用户与权限管理页 | 权限条件源码检查；守卫及账号逻辑 | 未执行真实用户新增/编辑/禁用、权限保存、管理员恢复流程；不能称该表单已完整验收 |
| 工厂与区域 | 工厂目录 SFC setup 4；工厂分布逻辑 2；拓扑/层级逻辑 | 创建/编辑请求及独立层级数量、无虚构坐标通过；真实持久化、区域下拉交互与浏览器地图尚需端到端 |
| 跨工厂切换及未保存草稿 | 草稿缓存逻辑 2；三选项对话逻辑 1；后台页面接线源码断言 | 草稿隔离、保存失败停留、取消/丢弃/保存语义通过；AdminPanel 全页面组合保存、刷新后恢复未在真实 UI 全跑 |
| 现场编排器 | 场景布局/坐标数学、源码接线、生产构建 | 未操作完整画布拖拽、吸附、镜像、键盘快捷键及撤销的实际 DOM；不具备全面编排器 UI 通过证据 |
| 车间/产线/设备 CRUD | 配置计划、去重、未放置状态、父子变换；部分共享数据流程 | 未逐个执行三个完整管理表单的新增/保存/删除及后端约束 |
| 设备运动配置 | 本轮仅构建及关联配置源码阅读 | 未跑移动设备配置完整 Vue 表单、距离/工位输入与现场运行；Unity 侧由其他验收负责 |
| 点位映射、复制、监视 | `admin-composables` 中生产组合函数：失败切换、空地址、复制归属、保存并发、晚到监视结果 | 相关逻辑通过；S7/Modbus/OPC UA 真设备、实际点位读写界面与采集链未测 |
| 外部数据库、HTTP 数据源 | `data-sources` 25，实际组合函数/API 层配替代响应 | 类型切换、端口、凭据遮罩、测试签名token、并发保存、失败反馈通过；没有连接真实 ERP/MES/DB |
| 大屏设计器、模板、发布 | `data-source-designer` 14、`template-field-mapping` 5、schema/迁移测试 | SFC setup 的修订冲突、保留新编辑、模板校验、重绑定、保存再发布、撤销数据通过；完整拖拽和发布到后端/Unity回执链未测 |
| 地图 01–07 画布与内置组件 | `map-surface-designer` 前4项运行 schema，后2项源码断言；后台管理布局4项纯源码断言 | 画布元数据/导航环处理通过；“所有页签使用同一设计器/渲染已发布组件”当前主要是接线断言，不等于实际点击7个页签 |
| Logo、地图外观、加载画面 | 外观4、加载配置2、站点设置2及构建 | 配置归一化和各层继承通过；图片/Logo上传、加载动画视觉、后台实时预览未全测 |
| 模型库、glTF节点 | glTF节点身份1、场景配置7、拆解数学19 | 节点身份、镜像/父变换、缓存/释放等执行通过；所有现场模型导入、上传、压缩/纹理/异常资产及真实GPU未测 |
| 拆解编辑器、部件标签 | `inspection-editor-sfc` 8：递归编译真实组件和模板，在内存节点触发部分按钮；runtime19、hover2 | 真正执行表单/按钮的一部分及拆解几何；并非 Unity 画面或浏览器精确拾取视觉验收 |
| HUD控件、报警、图表 | `widget-renderer` 18（真实模板/VNode、ECharts替身、部分CSS断言）；HUD逻辑/迁移测试 | 空/零/失效值、报警等级、事件发出、图表重建/尺寸、字体alpha配置通过；实际ECharts canvas绘制、所有组件类型组合和屏幕适配未测 |
| 实时数据、趋势、重连 | `data-store` 10（假socket/时间/HTTP）；`live-scene-projection` 4（真实Three对象） | 状态更新、丢弃晚到请求、质量无效值、重连配置同步通知通过；持续真实采集、长时间稳定性和网络设备故障未测 |
| 投影传输 | `scene-projection-transport` 第1项真实回环socket，第2项socket替身 | 订阅到Unity角色、仅指定web角色收到投影、校验/断开清理通过；不包含真实Unity进程 |
| 发布/视角导航 | `native-view-navigation` 4：运行导航器并模拟HTTP与上下文回执 | 必须匹配自身工厂层级/视角、超时/离线不宣称成功；真实host/Unity/浏览器联合导航未测 |
| 语音播报 | `voice-announcer` 2，Audio和speechSynthesis替身 | 静音/卸载停止播放并结束promise通过；发音质量、音量/设备、音频权限、自启动限制、TTS声音可用性未测 |
| 数据库备份/整站包 | 备份有效性生产模板SSR 1；项目包SFC setup7；新增CustomerOperations8 | 三态按钮、导入预检SHA/文件切换/重复点击/失败反馈、两项列表回退修复通过；未执行真实数据库恢复或灾备 |
| 投屏操作 | 组合函数错误反馈、CustomerOperations能力范围/重复操作/失败反馈 | 模拟HTTP失败不报成功；未发现/连接任何电视、未验证实际投屏流 |
| 系统设置、自启、运行能力 | admin组合函数及数据源测试；构建 | 轮询不覆盖草稿、保存竞态等通过；操作系统启动项、服务注册、画质更改、许可证实际导入与到期未在本轮执行 |

## 测试文件清单与证据类型

数字为 Node test 用例数，不是功能覆盖百分比。一个文件可能混合多类证据，不能将全部数量计作端到端 UI 测试。

| 文件（均位于 `frontend/tests`） | 项数 | 主要证据 |
| --- | ---: | --- |
| admin-composables.test.mjs | 16 | 组合函数执行、API替身；含2项备份失败对象回归 |
| admin-management-placement.test.mjs | 4 | **纯源码regex/字符串接线** |
| admin-session.test.mjs | 11 | 会话模块执行、HTTP/存储/广播替身 |
| app-dialog-switch.test.mjs | 1 | 对话组合函数执行 |
| backup-validity.test.mjs | 1 | 生产Vue备份行SSR模板执行 |
| customer-operations.test.mjs | 8 | **新增**；真实SFC setup/生命周期、API替身；模板编译，render置空 |
| data-source-designer.test.mjs | 14 | SFC setup + 纯模板数据函数；render置空 |
| data-sources.test.mjs | 25 | 组合函数/API逻辑执行，HTTP替身 |
| data-store.test.mjs | 10 | 数据存储模块，假socket/时间/HTTP |
| factory-directory-editor.test.mjs | 4 | SFC setup，render置空 |
| factory-distribution-preview.test.mjs | 2 | 分布计算逻辑 |
| factory-draft-cache.test.mjs | 2 | 草稿逻辑与替代保存 |
| factory-hud-modules.test.mjs | 4 | schema迁移逻辑 |
| factory-navigation-readiness.test.mjs | 3 | 2项逻辑，**1项源码接线** |
| factory-scene-config.test.mjs | 7 | 配置/Three场景和坐标执行；模型loader替代 |
| gltf-node-identity.test.mjs | 1 | Three节点身份逻辑 |
| group-hierarchy-path.test.mjs | 10 | 层级路径、导航面包屑逻辑 |
| group-portal-appearance.test.mjs | 4 | 外观配置归一化 |
| group-topology.test.mjs | 18 | 拓扑计算和仓库GeoJSON/目录数据；替代地图请求 |
| hud-modules-schema.test.mjs | 2 | 控件schema与模板 |
| hud-presentation.test.mjs | 3 | 尺寸/数值单位计算 |
| inspection-editor-runtime.test.mjs | 19 | Three拆解场景/时间轴/坐标执行，无WebGL |
| inspection-editor-sfc.test.mjs | 8 | 编译真实SFC模板/子组件、内存事件/VNode |
| inspection-hover.test.mjs | 2 | hover展示内容纯逻辑 |
| live-scene-projection.test.mjs | 4 | Three矩阵/相机/接收器逻辑 |
| loading-experience-config.test.mjs | 2 | 加载画面配置归一化 |
| map-preview-geometry.test.mjs | 2 | 地图几何/URL逻辑 |
| map-surface-designer.test.mjs | 6 | 4项schema逻辑，**2项源码接线** |
| native-admin-navigation.test.mjs | 13 | 导航辅助函数；host/router替身 |
| native-view-navigation.test.mjs | 4 | 生产导航器；传输/回执/计时替身 |
| project-bundle-transfer.test.mjs | 7 | SFC setup，模板编译，文件/HTTP替身；render置空 |
| reference-hud-layout.test.mjs | 2 | 展示布局迁移逻辑 |
| router-access.test.mjs | 6 | **新增**；真实Vue Router内存跳转/生产守卫；session、页面、bridge替代 |
| scene-projection-transport.test.mjs | 2 | **1项真实回环HTTP/WS**，1项socket替身 |
| scene-runtime.test.mjs | 4 | SceneRuntime生命周期；SceneManager/模型/批处理替身 |
| site-scene-config.test.mjs | 2 | 街景和建筑配置逻辑 |
| template-field-mapping.test.mjs | 7 | SFC setup、模板编译和字段绑定纯逻辑；含2项错误对象回归 |
| platform-users-settings.test.mjs | 2 | 真实SFC setup、模板编译、账号API替身；编辑仅提交可分配权限、失败保留草稿 |
| voice-announcer.test.mjs | 2 | 播放管理逻辑；Audio/TTS替身 |
| widget-renderer.test.mjs | 18 | 编译模板/VNode、ECharts替身、CSS AST/源码断言混合 |

## 仍需现场/浏览器端到端验收

1. 实际浏览器登录与权限切换，从每个入口进入完整页面；确认后退/刷新/锁定/重登录行为和真实Cookie。
2. 逐个后台表单提交并重新读取：工厂、车间、产线、设备、运动、点位、模型、用户、系统安全、许可证；使用隔离实例和可回滚数据。
3. 设计器逐个组件拖放、编辑、撤销/重做、视图切换、模板导入、版本发布；确认前端刷新和运行端加载的确是同一版本。
4. 世界→国家→省→市→工厂→车间→产线→设备及返回的实际点击、模型/Logo/街景加载和缩放适配；检查真实屏幕宽高与DPI。
5. Unity与WebView2共窗透明层、键鼠穿透、native导航回执、实际投影/标签与拆解跟随；由主验收与原生验收汇总。
6. 实际PLC协议、真实数据库/ERP接口、报警到声音/音频、长时间断线重连及资源变化；本轮只验证替代输入下的前端语义。
7. 真投屏设备、数据库备份下载/校验/恢复、整站迁移、Windows自启和服务生命周期；本轮不会用生产系统执行这些写操作。

本轮没有未处理的自动化失败；上述未执行项保留为验收缺口，不以测试通过或构建通过代替。

## 补充：设计器与模板真实浏览器验收

2026-09-30 使用独立 Chromium 会话 `designer-audit`（1600×1000）、隔离后端 `127.0.0.1:4063` 和独立 SQLite 示例工厂；HTTP 夹具 `127.0.0.1:61055` 返回真实响应。没有使用生产数据库、PLC 或 Unity 实例。此节更新上文对应的“未执行”项，其余缺口继续保留。

| 实际 UI 操作 | 结果与证据 |
| --- | --- |
| 首次密码设置、进入后台 | 通过真实登录表单初始化隔离实例；Cookie 会话在刷新后保留。未执行多角色账号切换。 |
| 地图设计器拖入文本、修改标题/内容/X=720、保存并刷新 | 草稿修订 1→2，刷新后标题“浏览器验收标题”和内容“隔离环境组件保存重开验收”及 X=720 保留；`output/playwright/designer-audit/01-component-reopened.png`。 |
| 保存并发布 | 后端发布 1.0.1，页面提示运行端连接后加载；没有把未连接的 Unity 计为已确认加载。 |
| UI 导出 JSON，再从文件选择器导入含旧 HTTP 连接/路径的模板 | 实际进入“模板引用重绑定”和“模板字段映射”；选择 `source_api`→`designer_target_api`，原布局在确认前保留。另一次错误格式文件被拒绝且已保存布局未被覆盖。 |
| 旧路径 `/old/metrics`，改为 `/v2/metrics`，从实际响应选择嵌套字段 | 旧路径真实 HTTP 404；修复后弹窗可见“接口返回 HTTP 404”。改路径后实际字段含旧同名 `old.temperature=-999` 和候选 `payload.measurements[0].actual_temperature=73.25`，手动选择后预览为 73.25 / good。 |
| 预览确认、载入草稿、保存、发布、运行 API 回读 | 未勾核对时确认按钮禁用；勾选后载入、保存修订 3、发布 1.0.2（`release_1790760460267_kyxa3j`）。保存响应保留新接口/字段路径，真实 `runtime-values` 返回 73.25 / good；旧字段 -999 没有被采用。 |
| 项目与场景改名并刷新 | UI 将场景命名为“浏览器验收场景”，刷新重开后保留，后端设计器修订 4；已发布运行值仍为 73.25。`06-scene-name-reopened.png`。 |

浏览器实际暴露并修复一项此前替身测试遗漏：API 层对非 2xx 返回 `{error}`，模板映射器的字段检查却只捕获 throw，导致旧接口失败仅有控制台 400 而界面无原因。现在 HTTP 字段、数据库表/列检查和数据预览均传播错误对象；表读取失败也保留原表绑定。新增 2 项回归，字段映射文件 **7/7** 通过；本次生产构建 783 模块通过。已有 `template-http-e2e.mjs` 使用真实后端/HTTP，但通过 SFC setup 驱动且其传输 helper 会 throw，不能代替此次 DOM 交互证据。

本地证据均在 `output/playwright/designer-audit/`：`03-old-http-error-fixed.png`、`04-mapped-http-preview.png`、`05-template-published.png`、`06-scene-name-reopened.png`、`fixture-requests.json`、`console.log`、`browser.trace`、`browser.network`。原 trace 与资源位于 `.playwright-cli/traces/trace-1790756969608.*` / `.playwright-cli/traces/resources/`。截图已实际查看；字段错误和预览弹窗布局清晰。控制台 3 次 400 均对应故意请求旧接口，另有密码表单用户名可访问性建议；未观察到此次流程的非预期 JS 异常。

剩余设计器缺口：全部组件类型/七地图层逐项交互、撤销重做与所有快捷键、真实 Unity 加载回执、跨 DPI 与多种屏幕尺寸。此轮仅上述实际执行路径通过，不宣称全设计器功能无缺陷。

## 补充：用户权限、安全设置与备份失败闭环

使用独立后端 `127.0.0.1:4065`、独立 SQLite 和 `users-audit` / `users-viewer` 浏览器会话。所有账号仅属于 `output/users-ui-audit-20260930T095453047Z-20516-RurMgP`，未修改生产账号。真实 UI 创建仅查看的 viewer，以及仅查看+备份权限的 customer（作为现场备份操作员）。主要结果：

- 已有 viewer 改显示名称、重设密码后保存和刷新保留；使用新密码真实登录成功；访问 `/admin` 转回 `/group`。管理员禁用该账号后原会话刷新回登录，登录被拒绝；重新启用后可再次登录。customer 经两次明确 UI 确认后删除成功。
- customer 登录进入 `/customer`，DOM 仅出现备份与下载区，没有投屏或启动操作；真实点击“立即备份”生成 `factory-20260930T110414833Z-manual.db`，列表出现新文件并显示“数据库备份已创建”。证据 `output/playwright/users-audit/customer-backup-created.yml`。带有效 CSRF 的用户管理接口仍为 403“当前账户没有执行此操作的权限”。
- 管理员立即锁定→原密码解锁通过；自动锁定设为 15 分钟，刷新后仍为 15；修改管理员密码后当前窗按产品约定保持解锁，主动锁定后用新密码重新登录成功。未等待完整 15 分钟计时，不将其计为自动锁定时间流逝的端到端测试。
- 最初 viewer 的地图数据 3 个读接口被误拦 403。并行后端修复仅开放具备 view 权限的精确 GET/HEAD 路径；重启隔离后端后的真实浏览器自动请求 `/api/platform/metrics/latest`、`/api/platform/events`、`/api/data-sources/map-values` 全为 200，用户管理请求依然 403。截图 `09-viewer-runtime-fixed.png`。该后端修复及权限矩阵集成回归由后端验收负责。

账号编辑根因：后端返回的 permissions 包含派生 `edit` / `manageUsers`，原 UI 原样回传触发“用户功能权限格式无效”。`PlatformUsersSettings.vue` 现在只提交 `view` / `launch` / `cast` / `backup` 四个布尔值，保留显式 false；没有放宽后端管理员权限。真实浏览器复验和新增 2 项 SFC 回归通过。

`useSystemSettings.js` 的备份读取/创建/恢复原来也把 `{error}` 当成功：恢复 500 会显示“已恢复”并清空列表。已验证成功标志与列表结构，失败保留已知列表、显示失败且不执行恢复后的配置刷新。新增 2 项组合函数回归通过；主验收真实浏览器注入恢复 500 后确认列表 **10→10**，没有成功提示。证据 `output/playwright/functional-audit/restore-failure-before.*` 与 `restore-failure-fixed.*`。

用户验收证据目录 `output/playwright/users-audit/`，含账号创建编辑、锁定、自动锁定设置、禁用、拒绝登录、删除及只读地图截图，以及客户备份 DOM 快照和浏览器 trace/network。已查看关键截图；`07-login-transition.png` 只是路由过渡帧，不作为操作中心布局证据。控制台中的已知失败来自修复前权限错误、一次并行登录限流、禁用账号和重启隔离服务。最终有权限的地图读取已明确复验为 200。独立浏览器和隔离后端验收后关闭。
