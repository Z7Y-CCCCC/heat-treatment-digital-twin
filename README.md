# 热处理数字孪生大屏

**把车间布局、设备三维模型和实时数据放到同一块大屏上。**

面向热处理车间的 Windows 数字孪生与组态系统。从全厂、车间、产线逐级查看设备，可以在三维场景中观察炉门、料车和关键部件的状态，也可以在同一视角查看温度趋势、设备离线和报警。工程师在后台完成车间编排、模型导入、点位绑定和画面发布；现场人员在大屏上查看，不需要进入组态后台。

[功能特性](#功能特性) · [界面图集](#界面图集) · [系统架构](#系统架构) · [快速开始](#快速开始) · [部署与交付](#部署与交付) · [开发与协作](#开发与协作)

## 功能特性

| 模块 | 可以做什么 |
| --- | --- |
| **三维车间与设备巡检** | 从全厂、车间、产线进入设备，切换实体、外壳透视、内部拆解和关键部件详情。可用视角取决于现场导入的模型和配置。 |
| **车间编排与资产复用** | 在三维画布布置设备、调整朝向和料口对接；在模型库分别管理 GLB 模型、动作包和拆解布局，同型号设备可以复用资产。 |
| **设备状态与动作联动** | 将点位绑定到炉门、料车、风扇等模型动作。以料车为例，两个到位开关只确认端点；信号冲突、过期或无效时不会猜测物理位置。 |
| **实时数据与报警** | 采集插件只读接入西门子 S7、Modbus TCP 和 OPC UA；数据中心还可配置外部接口、数据库和文件。画面可展示实时点位、趋势、报警和状态，可按规则配置语音播报。 |
| **画面设计与发布** | 在设计器中配置图表、指标、设备状态等组件，绑定当前设备点位或外部数据集；草稿与运行发布版本分开，编辑不直接替换正在展示的画面。 |
| **现场运维** | 展示和采集可分别部署。采集运行中心查看服务状态、日志和点位；支持本机备份、整站灾备与离线授权。 |

**部署边界：大屏用于看状态、查数据和做组态，不向 PLC 写值，不替代 PLC 控制或安全联锁。**

## 界面图集

共 **49 张实拍截图**。按当前软件菜单分组，每组先展示一页，其余页面可逐组展开；点击图片可查看原尺寸。截图来自当前源码和隔离演示工程，不含现场连接、工厂资料或凭据，不使用旧版大屏截图。

[显示与现场操作](#显示与现场操作) · [Unity 原生大屏](#unity-原生大屏) · [工厂建模与编排](#工厂建模与编排) · [模型资产与动作联动](#模型资产与动作联动) · [数据中心](#数据中心) · [画面组态与视觉](#画面组态与视觉) · [权限与系统维护](#权限与系统维护) · [独立采集运行中心](#独立采集运行中心) · [CAD 设备模型](#cad-设备模型)

### 显示与现场操作

从集团地图查看站点分布；现场操作中心把投屏和整站备份放在一个入口，不必进入组态菜单。

#### 集团地图

查看演示站点分布、接入情况与配置规模。

![集团地图](docs/assets/readme/group-map.webp)

<details>
<summary>展开其余 4 页</summary>

本组其余页面：街道下钻、工厂建筑、现场操作中心、后台登录。

#### 街道下钻

从地图进入演示工厂所在街道，查看站点入口。

![街道下钻](docs/assets/readme/factory-street.webp)

#### 工厂建筑

查看选中工厂的建筑模型与进入全厂视角的入口。

![工厂建筑](docs/assets/readme/factory-building.webp)

#### 现场操作中心

在权限允许范围内配置投屏显示，导出或恢复整站备份。

![现场操作中心](docs/assets/readme/customer-operations.webp)

#### 后台登录

区分只看大屏的账号与可以修改组态的账号。

![后台登录](docs/assets/readme/admin-login.webp)

</details>

### Unity 原生大屏

以下为当前 Unity 客户端在隔离工程里的三维层实拍，采集时未叠加独立的 WebView2 数据层，不使用旧备用界面。

#### Unity · 全厂总览

看全厂运行状态及车间、产线和设备的分布。

![Unity · 全厂总览](docs/assets/readme/factory-overview.webp)

<details>
<summary>展开其余 6 页</summary>

本组其余页面：Unity · 车间视角、Unity · 产线视角、Unity · 设备实体、Unity · 设备外壳透视、Unity · 设备拆解、Unity · 关键部件详情。

#### Unity · 车间视角

进入单个车间，查看其下的产线与设备。

![Unity · 车间视角](docs/assets/readme/workshop-view.webp)

#### Unity · 产线视角

沿产线查看设备布置和工位关系。

![Unity · 产线视角](docs/assets/readme/line-view.webp)

#### Unity · 设备实体

查看一台设备的外观和运行上下文。

![Unity · 设备实体](docs/assets/readme/device-solid.webp)

#### Unity · 设备外壳透视

透过外壳观察内部机构。

![Unity · 设备外壳透视](docs/assets/readme/device-xray.webp)

#### Unity · 设备拆解

查看分离后的部件及相对位置。

![Unity · 设备拆解](docs/assets/readme/device-exploded.webp)

#### Unity · 关键部件详情

聚焦单个部件，检查它的关联信息。

![Unity · 关键部件详情](docs/assets/readme/device-part.webp)

</details>

### 工厂建模与编排

从工厂、车间、产线到设备组织空间；平面定位和三维检查使用同一套布局。

#### 车间编排 · 俯视排布

在俯视画布上组织车间内的产线与设备。

![车间编排 · 俯视排布](docs/assets/readme/workshop-plan.webp)

<details>
<summary>展开其余 6 页</summary>

本组其余页面：工厂与区域、车间管理、设备管理、车间编排 · 产线布局、车间编排 · 三维效果、设备运动配置。

#### 工厂与区域

登记工厂，维护区域和展示范围。

![工厂与区域](docs/assets/readme/factory-regions.webp)

#### 车间管理

维护车间、空间尺寸与边界。

![车间管理](docs/assets/readme/workshops.webp)

#### 设备管理

按车间和产线筛选设备，关联模型与数据连接。

![设备管理](docs/assets/readme/devices.webp)

#### 车间编排 · 产线布局

查看产线内的设备排布、工位与轨道。

![车间编排 · 产线布局](docs/assets/readme/line-plan.webp)

#### 车间编排 · 三维效果

在后台预览空间布局；这不是正式 Unity 大屏。

![车间编排 · 三维效果](docs/assets/readme/workshop-3d.webp)

#### 设备运动配置

配置料车等移动设备的路径、位置与到位反馈。

![设备运动配置](docs/assets/readme/mobile-motion.webp)

</details>

### 模型资产与动作联动

同一模型可以用于多台设备，拆解布局、料口和动作可分别配置。

#### 拆解布局

调整部件排列、拆解播放效果和独立的观察镜头。

![拆解布局](docs/assets/readme/disassembly.webp)

<details>
<summary>展开其余 5 页</summary>

本组其余页面：模型管理 · 模型资产、模型管理 · 进出料口、动作动画 · 部件动作、动作动画 · 实时联动、动作动画 · 设备联动。

#### 模型管理 · 模型资产

管理 GLB / glTF 资源、归属范围及三维预览。

![模型管理 · 模型资产](docs/assets/readme/model-library.webp)

#### 模型管理 · 进出料口

定位设备料口和方向，供对接预览及进出料信号配置使用。

![模型管理 · 进出料口](docs/assets/readme/loading-ports.webp)

#### 动作动画 · 部件动作

定义门、风扇、料车机构等模型部件动作。

![动作动画 · 部件动作](docs/assets/readme/part-motion.webp)

#### 动作动画 · 实时联动

按设备将动作绑定到点位或数据项，配置范围映射、条件或到位反馈。

![动作动画 · 实时联动](docs/assets/readme/live-linkage.webp)

#### 动作动画 · 设备联动

选择参与联动的设备，预览同一产线的模拟工步；不下发控制。

![动作动画 · 设备联动](docs/assets/readme/device-linkage.webp)

</details>

### 数据中心

数据源负责接入，数据表负责整理，点位映射与监视负责配置、核查设备读数。

#### 点位监视

核对当前值、单位、读取质量和更新时间。

![点位监视](docs/assets/readme/point-monitor.webp)

<details>
<summary>展开其余 4 页</summary>

本组其余页面：数据表、数据源、数据源类型目录、点位映射与报警。

#### 数据表

按工厂和设备查找数据表、字段及关联配置。

![数据表](docs/assets/readme/data-tables.webp)

#### 数据源

维护只读连接并检查状态。

![数据源](docs/assets/readme/data-sources.webp)

#### 数据源类型目录

查看可配置的数据源与接入方式；目录条目不等于现场已有连接。

![数据源类型目录](docs/assets/readme/data-source-catalog.webp)

#### 点位映射与报警

配置地址、采样和用途；报警触发条件在点位所在行维护。

![点位映射与报警](docs/assets/readme/point-mapping.webp)

</details>

### 画面组态与视觉

大屏组件和视觉设置在同一入口，草稿与运行发布版本分开。

#### 大屏设计器

按视角编排组件、绑定数据，预览、保存草稿或发布。

![大屏设计器](docs/assets/readme/dashboard-designer.png)

<details>
<summary>展开其余 3 页</summary>

本组其余页面：地图底图与主题、加载画面、场景与光效。

#### 地图底图与主题

配置地图底图、品牌默认值与配色。

![地图底图与主题](docs/assets/readme/map-theme.webp)

#### 加载画面

预览和调整启动图、配色及加载文案。

![加载画面](docs/assets/readme/loading-screen.webp)

#### 场景与光效

配置 Unity 灯光、后处理、厂房和空间环境。

![场景与光效](docs/assets/readme/scene-lighting.webp)

</details>

### 权限与系统维护

账号、安全、投屏、数据库和备份分别有独立入口；下方展开逐页查看。

#### 运行与投屏

配置展示端运行和投屏选项。

![运行与投屏](docs/assets/readme/runtime-casting.webp)

<details>
<summary>展开其余 10 页</summary>

本组其余页面：用户与权限、后台安全、数据库与备份 · 主库连接、数据库与备份 · 自动备份、数据库与备份 · 备份记录与保留、数据库与备份 · 整站灾备、项目迁移、客户端性能、采集状态、授权与版本。

#### 用户与权限

维护账户及对页面的查看、修改、删除和发布权限。

![用户与权限](docs/assets/readme/users-roles.webp)

#### 后台安全

设置密码策略和无操作自动锁定，或主动锁定后台。

![后台安全](docs/assets/readme/backend-security.webp)

#### 数据库与备份 · 主库连接

查看数据库类型和连接配置，部署前先测试连接。

![数据库与备份 · 主库连接](docs/assets/readme/database.webp)

#### 数据库与备份 · 自动备份

选择备份对象、执行时机和周期。

![数据库与备份 · 自动备份](docs/assets/readme/automatic-backup.webp)

#### 数据库与备份 · 备份记录与保留

查看备份记录，并配置保存周期与清理策略。

![数据库与备份 · 备份记录与保留](docs/assets/readme/backup-history.webp)

#### 数据库与备份 · 整站灾备

导出或恢复包含业务数据和现场资产的整站备份。

![数据库与备份 · 整站灾备](docs/assets/readme/site-backup.webp)

#### 项目迁移

用项目包迁移配置和引用资产，与恢复整站备份区分。

![项目迁移](docs/assets/readme/project-migration.webp)

#### 客户端性能

调整 Unity 渲染档位与配置。

![客户端性能](docs/assets/readme/performance.webp)

#### 采集状态

查看采集进程、设备健康、数据来源与读数更新。

![采集状态](docs/assets/readme/collection-status.webp)

#### 授权与版本

查看版本、离线授权状态和激活记录，截图隐藏了本机授权指纹。

![授权与版本](docs/assets/readme/license-release.webp)

</details>

### 独立采集运行中心

以下为当前 WinForms 程序的演示界面。关闭中心窗口不会停止后台采集服务。

#### 运行中心 · 设备采集状态

查看正常、异常与停用设备，以及采集进程状态。

![运行中心 · 设备采集状态](docs/assets/readme/collector-status.webp)

<details>
<summary>展开其余 3 页</summary>

本组其余页面：运行中心 · API / 数据库、运行中心 · 日志、运行中心 · 实时点位。

#### 运行中心 · API / 数据库

查看共用后台的 API、数据库和显示连接状态。

![运行中心 · API / 数据库](docs/assets/readme/collector-api.webp)

#### 运行中心 · 日志

按级别筛选和搜索日志，便于定位异常和导出脱敏诊断。

![运行中心 · 日志](docs/assets/readme/collector-logs.webp)

#### 运行中心 · 实时点位

从采集端查看点位值、质量和更新时间。

![运行中心 · 实时点位](docs/assets/readme/collector-points.webp)

</details>

### CAD 设备模型

下图是仓库中的 CAD 模型预览，**不计入界面截图，也不是大屏运行界面**。回火炉、料车、备料台、风冷台、清洗机和水冷槽可按项目单独导入，模型不随安装包预装。

![热处理产线 CAD 设备模型预览](backend/assets/models/cad_general_20261103_v1/七套设备总览.png)

相关说明：[模型资产生成与交付规范](docs/model-asset-delivery-spec.md)（模型、动作、拆解、默认进出料口） · [车间编排](docs/车间编排画布直接操作-20261115.md) · [设备透视](docs/设备外壳透视.md) · [模型与动作包](docs/动作包与模型复用.md)

## 系统架构

```mermaid
flowchart TB
    PLC["现场 PLC · S7 / Modbus TCP / OPC UA"] -->|只读轮询| Worker["可选采集插件 · 独立采集进程"]
    Worker -->|私有 IPC · 点位值、质量与时间| API["Node.js 管理 API 与实时服务"]
    External["业务接口 · 外部数据库 · 文件"] -->|只读获取| API
    API <-->|配置、发布记录与历史| DB[("持久化数据库")]
    API -->|运行配置与实时数据| Runtime["Unity 三维场景 + WebView2 画面叠加层"]
    API <-->|读取配置 / 受权限保护的编辑与发布| Admin["Vue 组态后台"]
```

- **展示端**：Electron 管理桌面程序的启动和退出；Unity 负责工厂内的三维场景、视角和动作，WebView2 承载画面组件与后台。Three.js 用于后台三维预览和编辑，不是正式大屏渲染器。
- **数据端**：Express 提供配置与管理 API，WebSocket 推送实时数据。安装采集插件后，采集进程与管理 API 隔离，前台或采集运行中心关闭不等于采集服务停止。
- **存储端**：Windows 新安装版采用受程序管理的私有 MySQL；源码开发可以显式使用隔离 SQLite。项目资产、连接参数和备份属于现场数据，不来自仓库快照。

技术入口：[Unity 客户端](unity-client/README.md) · [采集进程隔离](docs/采集进程隔离.md) · [外部数据源工作台](docs/外部数据源工作台.md) · [组件与数据集绑定](docs/可复用数据集与组件绑定.md)

## 快速开始

### 只体验软件：使用 Windows 安装包

从 [GitHub Releases](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/releases) 选择已验收、符合现场要求的版本，查看对应发布说明；不要把旧版附件当成当前源码的构建结果。适用 Windows 10 1809+ 或 Windows 11，Intel / AMD x64。

没有 PLC 时选择仅展示，配置自己的只读业务数据源，或显式切到模拟演示。首次启动按提示完成[离线激活](docs/离线激活与厂商签发.md)和本机账户设置；系统没有通用后台密码。

### 从源码查看后台：使用隔离 SQLite

准备 Git 与 Node.js 22 LTS（至少 22.12.0），在新的 PowerShell 会话执行：

```powershell
git clone https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin.git
cd heat-treatment-digital-twin
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix frontend run build

$devRoot = Join-Path (Get-Location) 'output/readme-dev'
$env:DB_TYPE = 'sqlite'
$env:APP_DATA_DIR = Join-Path $devRoot 'data'
$env:SQLITE_FILE = Join-Path $env:APP_DATA_DIR 'factory.db'
$env:UPLOADS_DIR = Join-Path $devRoot 'uploads'
$env:APP_EMPTY_INSTALL = '1'
$env:HOST = '127.0.0.1'
$env:PORT = '3101'
npm --prefix backend start
```

打开 [组态后台](http://127.0.0.1:3101/admin)，创建本地测试账户和演示工厂；[健康检查](http://127.0.0.1:3101/api/health)可确认后端已响应。不填现场 PLC 地址，不复制现场数据库或凭据。直接访问后端根路径只会看到旧网页入口停用提示；要运行完整的三维大屏，请按[开发交接指南](docs/开发交接与仓库约定.md)准备 Unity、.NET、WebView2 和桌面运行资源，再用 [工作区启动入口](启动说明.md)。克隆仓库不会得到可直接运行的 EXE。

## 部署与交付

| 方式 | 适用场景 | 数据从哪里来 |
| --- | --- | --- |
| **仅展示** | 展厅屏、看板机，或已有上游数据接口 | 只读接口或数据库；也可显式开启模拟演示，不注册本机 PLC 服务。 |
| **展示＋本机采集** | 同一台 Windows 电脑既要读 PLC 又要显示 | 选装独立采集插件，由 Windows 服务采集；现有采集服务须按交付说明同步升级。 |
| **独立采集** | 专用工控机采集，展示端与服务分开 | 独立插件，不安装 Unity / Electron；展示端显式配置服务连接。 |

**新装不带现场工程。** 安装包只随附不含现场绑定的七视角静态布局，用于初始化明确新建的工厂。不预置工厂、设备、点位、模型、动作、现场账户、历史或上传文件。厂房、设备模型和动作包需单独导入；升级不会把已有工程还原为模板或清空现场数据。

现场上线步骤：**激活并设置后台账户 → 新建工厂或导入项目 → 导入模型与动作 → 配置数据源和点位 → 绑定组件、预览并发布 → 建立备份并做现场验收。**

[Windows 客户部署说明](desktop/README-交付说明.md) · [采集插件说明](desktop/collector-plugin/README.md) · [模型导入验收](docs/空系统安装包与模型导入验收-20261104.md) · [出厂内容与打包门禁](打包必看.md)

## 开发与协作

| 路径 | 职责 |
| --- | --- |
| [`unity-client/`](unity-client/) | Unity 2022.3 LTS / URP 原生大屏：场景、相机、模型和设备动作 |
| [`native-admin-host/`](native-admin-host/) | .NET / WebView2 宿主：后台窗口与画面叠加层 |
| [`frontend/`](frontend/) | Vue 3 / Vite 后台、组态设计器、Three.js 资产预览与 ECharts 图表 |
| [`backend/`](backend/) | Node.js / Express 管理 API、实时数据、业务配置与持久化 |
| [`desktop/`](desktop/) | Electron 桌面宿主、启动协调和 Windows 交付工具 |
| [`collector-service/`](collector-service/) · [`collector-center/`](collector-center/) | Windows 采集服务及原生采集运行中心 |
| [`shared/`](shared/) · [`docs/`](docs/) | 跨端数据契约、工程说明与验收记录 |

从 [开发交接与仓库约定](docs/开发交接与仓库约定.md)了解依赖、构建及隔离测试。改动运行逻辑时运行相关回归；[质量工作流](.github/workflows/quality.yml)验证源码，不能替代真实 PLC、设备动作与断电恢复的现场验收。

工程工具可通过受鉴权保护的 [MCP 接口](backend/routes/mcp.js)操作组态；不要向前端提交管理凭据。

涉及发行、安装包或出厂模板，先读 [AGENTS.md](AGENTS.md) 和 [打包必看](打包必看.md)。提交不包含现场数据库、凭据、安装包、编译产物或测试输出。历史需求和验收状态见 [历史需求验收台账](docs/历史需求验收台账.md)。
