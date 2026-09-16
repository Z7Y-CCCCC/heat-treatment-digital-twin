# 动态大屏 / 热处理数字孪生控制中心

这是一个面向热处理车间的 3D 数字孪生大屏与后台组态系统。项目包含前端大屏、管理后台、Node.js 后端、MySQL 配置库、PLC 采集链路、模拟数据链路、3D 模型资产管理、组件配置和报警/指标展示。

仓库地址：[https://github.com/Z7Y-CCCCC/dongtaidaping](https://github.com/Z7Y-CCCCC/dongtaidaping)

## 功能概览

- **3D 大屏**：基于 Vue 3 + Three.js 展示工厂、车间、产线、设备层级。
- **设备模型动画**：支持将 PLC 点位绑定到炉门、风扇、油搅拌等模型动作。
- **PLC 数据采集**：后端内置 nodes7 S7 采集器，通过 WebSocket 推送实时数据。
- **离线演示/模拟数据**：后台可切换到模拟模式，不接 PLC 也能演示。
- **设备离线判定**：PLC 连接或重连超过阈值后进入 `offline/bad`，前端自动置灰。
- **后台组态**：车间、产线、设备、点位、模型资产、组件布局、设备浮标、诊断面板等可配置。
- **点位语音播报**：点位可配置变化、上升沿、下降沿、等于阈值、越上限、越下限等触发规则，支持系统文字转语音、生成 WAV 和上传固定音频。
- **报警跑马灯**：报警履历支持配置显示条数与时间范围。
- **数据库可切换**：默认 MySQL/MariaDB；代码保留 SQLite、PostgreSQL、SQL Server 适配入口。
- **离线授权**：支持 Ed25519 签名许可证、有效期/客户/功能校验；不联网也能完成现场授权。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 前端 | Vue 3、Vite、Three.js、GSAP、ECharts |
| 后端 | Node.js、Express、WebSocket(ws)、nodes7 |
| 开发默认数据库 | MySQL/MariaDB |
| Windows 安装版数据库 | 本地 SQLite（WAL + 全同步写入） |
| 可选数据库 | PostgreSQL、SQL Server |
| 工具 | Blender Python 建模脚本、PLC 模拟脚本 |

## 目录结构

```text
backend/                    后端服务
  assets/models/            3D 模型资产、预览图
  db/database.js            数据库连接、建表、种子数据
  db/init-mysql.sql         可选的 MySQL 空库创建脚本
  routes/                   后台管理 API
  services/                 数据引擎、PLC 采集器、模拟器、WebSocket
  server.js                 后端入口
frontend/                   Vue 3 大屏与管理后台
  src/App.vue               大屏入口
  src/views/AdminPanel.vue  管理后台
  src/runtime/              实时数据、组件渲染、运行时配置
  src/three/                3D 场景和模型渲染
mock-server/                辅助模拟服务
tools/                      Blender 与动画验证工具
docs/                       项目文档
多用炉/ 回火炉/ 清洗机/ 小车/  现场设备参考图
```

## 环境要求

- Node.js：使用 **22 LTS（至少 22.12.0）或更新的兼容 LTS**。当前 Vite 与 SQLite 原生依赖不支持旧文档所写的 Node 16/18。
- MySQL 或 MariaDB：默认连接参数如下：
  - Host：`127.0.0.1`
  - Port：`3307`
  - User：`root`
  - Password：`root`
  - Database：`dongtai_daping`
- 可选：Blender 3.x+，只在重新生成模型资产时需要。

> 注意：本项目默认要求安装 MySQL/MariaDB。SQLite 只是代码保留的可选适配，不是默认运行方式。

## 数据库初始化说明

项目**不依赖完整 SQL dump 文件**。

后端启动时会自动完成这些动作：

1. 读取数据库配置。
2. 自动创建 `dongtai_daping` 数据库（账号需要有 `CREATE DATABASE` 权限）。
3. 自动创建所有表。
4. 自动插入默认项目、场景、组件、设备、点位模板等种子数据。

对应逻辑在：

```text
backend/db/database.js
```

如果你的数据库账号没有建库权限，可以先手动执行这个可选 SQL：

```bash
mysql -uroot -proot -P3307 < backend/db/init-mysql.sql
```

这个 SQL 只负责创建空库；表结构和默认数据仍由后端启动时自动生成，避免 SQL 文件和代码里的结构不同步。

## 快速启动

### 1. 克隆项目

```bash
git clone https://github.com/Z7Y-CCCCC/dongtaidaping.git
cd dongtaidaping
```

### 2. 准备 MySQL/MariaDB

确保本机 MySQL/MariaDB 已启动，并监听 `3307` 端口。

如果你用的是本机 MySQL 默认 `3306`，可以二选一：

1. 把 MySQL 端口改到 `3307`；或
2. 用环境变量覆盖端口：

```powershell
$env:MYSQL_PORT="3306"
```

也可以手动创建空库：

```sql
CREATE DATABASE IF NOT EXISTS dongtai_daping CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 启动后端

```bash
cd backend
npm install
npm start
```

后端默认地址：

- API：`http://localhost:3001/api`
- 健康检查：`http://localhost:3001/api/health`
- WebSocket：`ws://localhost:3001/ws`

### 4. 启动前端

另开一个终端：

```bash
cd frontend
npm install
npm run dev
```

打开：

- 大屏：`http://localhost:5173/`
- 后台：`http://localhost:5173/admin`

## 后台密码与工程师解锁

后台默认受密码保护，实时大屏、设备数据采集和普通视角导航不需要解锁。

1. **首次交付**：由工程师在现场电脑打开“后台管理”，设置 8–128 个字符的后台密码。系统没有通用默认密码；请完成设置后再交给普通用户。
2. **日常配置**：输入密码后进入后台。有效会话内切回大屏、重新进入或刷新后台，都不用重复输入密码。
3. **自动锁定**：进入“系统设置 → 后台安全”，设置“自动锁定时间（分钟）”，支持 **1–480 分钟**，默认 **30 分钟**，点击“保存自动锁定设置”后生效并持久保存。只有后台里的人工操作会续期，数据刷新、动画和轮询不会让后台一直保持解锁。
4. **离开现场**：先保存编辑内容，再点击后台顶部或“后台安全”页的 **立即锁定**。桌面版顶部页签栏也提供相同按钮，切到实时大屏后仍可使用。此操作立即撤销所有工程师会话，关闭后台编辑界面，大屏继续展示；再次进入需要密码。
5. **修改密码**：在同一页面输入原密码、新密码和确认密码。修改成功后当前窗口继续工作，其他工程师会话失效。

单次解锁最长 8 小时；重启后端或软件会使全部会话失效，需要重新输入密码。锁定会关闭未保存的编辑界面，请先保存。若锁定时服务无法连接，页面会明确提示“服务器尚未确认”，应恢复连接并重试锁定，确认成功后再离开。

密码只在后端以随机盐 + scrypt 散列保存，不写入前端代码或浏览器存储；会话使用 HttpOnly / SameSite=Strict Cookie，并对修改请求校验 CSRF。直接调用修改接口、直接打开 `/admin`、刷新或后退，都不能绕过后台权限校验。数据库连接信息、数据库备份和整站灾备的读取/下载也要求解锁。

密码散列和自动锁定设置保存在应用数据目录的 `admin-security.json`（开发环境为 `backend/data/admin-security.json`，安装版为 `%APPDATA%\heat-treatment-digital-twin-desktop\data\admin-security.json`，或由 `APP_DATA_DIR` 指定）。它独立于业务数据库，切换数据库不会解除密码保护。损坏的安全配置会阻止后台解锁，不会自动重置为首次设置状态；大屏只读展示仍可运行。请限制现场 Windows 账号的文件修改权限；后台密码不能阻止拥有本机文件控制权的人改动程序。

自动化接口可通过后端环境变量 `ADMIN_API_TOKEN` 配置管理凭据；MCP 工具可使用 `MCP_API_TOKEN`。这些凭据仅供可信工程工具使用，不能放到前端。即使从本机请求，也不能再匿名修改配置。

验证后台访问保护：

```bash
cd backend
npm run test:admin-auth
npm run test:admin-integration
```

测试使用 `output/` 下的隔离数据，不会更改现场密码、自动锁定设置或业务数据。

## 大屏渲染性能档位

后台“系统设置 → 大屏渲染性能”可以按部署电脑配置选择：

| 档位 | 目标帧率 | 渲染分辨率 | 适用场景 |
| --- | ---: | ---: | --- |
| 低配兼容 | 30 FPS | 75% | 无独显、4K 大屏或较老电脑 |
| 均衡 | 45 FPS | 100% | 普通核显，兼顾清晰度和流畅度 |
| 流畅 | 60 FPS | 100% | 性能较好的核显或普通独显 |
| 高画质 | 60 FPS | 125% | 有独显的展示电脑 |
| 自定义 | 15-144 FPS | 50%-150% | 工程师按现场实测调整 |

自定义档还可以控制 WebGL 抗锯齿和 3D 浮标刷新率。保存后刷新大屏页面生效。

## 数据库配置

默认配置在 `backend/db/database.js`：

```js
{
  type: 'mysql',
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'root',
  database: 'dongtai_daping'
}
```

支持通过环境变量覆盖：

| 环境变量 | 说明 |
| --- | --- |
| `DB_TYPE` | `mysql` / `mariadb` / `sqlite` / `postgres` / `sqlserver` |
| `DB_HOST` 或 `MYSQL_HOST` | 数据库地址 |
| `DB_PORT` 或 `MYSQL_PORT` | 数据库端口 |
| `DB_USER` 或 `MYSQL_USER` | 用户名 |
| `DB_PASSWORD` 或 `MYSQL_PASSWORD` | 密码 |
| `DB_NAME` 或 `MYSQL_DATABASE` | 数据库名 |
| `SQLITE_FILE` | SQLite 数据库文件 |

## 离线授权与许可证

许可证是离线 JSON 文件，由交付方使用 Ed25519 私钥签名，现场只保存许可证和公钥，不保存私钥，也不会因断网失效。后端提供只读状态接口 `GET /api/license` 和契约接口 `GET /api/license/contract`；安装新许可证使用本机管理接口 `PUT /api/license`。后台“授权与版本”页面会显示本机授权指纹，签发方可把许可证绑定到指定电脑。

独立运行后端或自定义部署可以通过环境变量指定许可证文件：

```text
LICENSE_PUBLIC_KEY_FILE=C:\ProgramData\HeatTreatment\license-public-key.pem
LICENSE_FILE=%APPDATA%\heat-treatment-digital-twin-desktop\data\license.json
LICENSE_ENFORCE=true
```

桌面正式安装包默认开启 `LICENSE_ENFORCE=true`；没有有效许可证时，普通业务 API 会返回 `402 LICENSE_REQUIRED`，因此只复制程序文件不能直接运行。许可证状态、安装替换许可证、健康检查、发布校验和安全退出接口仍保持可用，避免现场无法补授权。源码开发/演示模式默认不强制授权，所以当前开发电脑没有许可证也能打开，这是有意保留的开发体验。

签发方可运行 `node tools/license-generator/license-generator.cjs` 打开本地 GUI。工具会在 `tools/license-generator` 下生成密钥并把签发文件保存到 `issued`：私钥只留在签发方，客户机只部署公钥。建议交付流程为“客户复制机器指纹 → 签发方填写指纹和有效期 → 生成签名 JSON → 客户粘贴安装”。离线授权能可靠防止普通复制和误用，但无法承诺抵抗对客户电脑拥有管理员权限、可以修改程序本身的攻击者；高价值部署还应配合安装包签名、系统权限和现场网络隔离。许可证的 `features` 用于后续按客户开通只读业务数据、设备数量或高级视角能力。

## 离线升级与回滚

升级包使用 `heat-treatment-digital-twin-release` 清单，由交付方签名并记录安装包 SHA-256。后端 `GET /api/release` 暴露当前版本和校验策略，`POST /api/release/verify` 可在本机安装前验证清单；验证失败、签名不匹配、哈希不一致或降级包都会被拒绝。生产环境不自动联网下载升级包，交付人员应按“导出整站灾备 → 校验升级包 → 安装 → 自动验收”的顺序操作；需要回滚时先恢复整站灾备，再安装上一版签名包。

## SQLite 断电恢复与备份

Windows 安装版默认使用 SQLite，并启用以下保护：

- `WAL` 日志模式与 `synchronous=FULL`，降低突然断电造成已提交数据丢失或主库损坏的风险。
- 每次启动、每 6 小时、正常退出时自动创建一致性备份，默认保留最近 10 份。
- 启动时执行 `quick_check`；主库损坏时隔离原数据库及 WAL/SHM 文件，并从最新有效备份恢复。
- 后台“数据库连接 → 本机自动备份”支持立即备份、下载和手工恢复；恢复前会自动生成回滚备份。
- 本机自动备份仍与现场电脑存放在一起，只防断电和数据库损坏，不防电脑丢失或硬盘损坏。

安装版数据默认位于：

```text
%APPDATA%\heat-treatment-digital-twin-desktop\data\factory.db
%APPDATA%\heat-treatment-digital-twin-desktop\data\backups\
%APPDATA%\heat-treatment-digital-twin-desktop\data\recovery\
```

## 运行日志与错误日志

Windows 安装版会把日志保存在当前用户的应用数据目录：

```text
%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\backend-error.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\desktop-error.log
%APPDATA%\heat-treatment-digital-twin-desktop\logs\*.log.gz
```

`backend.log` 是后端正常运行日志，`backend-error.log` 是后端标准错误日志，`desktop-error.log` 是桌面壳和后端进程异常日志。单个活动日志默认达到 10 MB 自动切卷并 gzip；压缩日志默认保留 30 天、最多 60 个，软件运行期间每 6 小时自动清理。可通过 `LOG_MAX_BYTES`、`LOG_RETENTION_DAYS`、`LOG_MAX_ARCHIVES` 环境变量调整，单位分别是字节、天和文件数。

工程师做隔离诊断时可设置 `APP_USER_DATA_DIR` 指定应用数据目录；未设置时仍使用 Windows 当前用户的默认应用数据目录。

### 整站灾备（电脑丢失后在新电脑恢复）

后台“数据库连接 → 整站灾备（防电脑丢失）”可导出 ZIP，内容包括一致性 SQLite 数据库、数据库中的全部现场配置、全部现场上传模型、点位语音文件，以及逐文件 SHA-256 清单。安装版导出时会弹出“另存为”，应选择 U 盘、移动硬盘或 NAS，不能只保存在现场电脑上。

新电脑恢复流程：

1. 安装同版本或更新版本的软件并启动。
2. 打开后台“数据库连接 → 整站灾备”。
3. 点击“从整站备份恢复”并选择 ZIP。
4. 恢复完成后核对设备、PLC 点位和模型，并重新进行现场连通验收。

导入前会创建数据库回滚备份，失败时会恢复原上传模型和语音文件；灾备包不会把旧电脑的绝对数据库路径写入新电脑。内置模型随安装包交付，不在 ZIP 内重复保存。

## 点位语音播报

后台路径：`/admin` → **设备与点位配置** → 点位表中的 **语音播报**。

每个点位最多可设置 12 条规则，支持数值变化、BOOL 上升沿/下降沿、等于阈值、向上跨越阈值和向下跨越阈值。可配置冷却时间、音量、语速、系统声音和“启动时播报”，避免 PLC 抖动导致连续重复播报。

播放方式有三种：

- `系统文字转语音`：运行时由 Windows 朗读，支持 `{设备}`、`{点位}`、`{值}`、`{单位}` 动态变量，适合播报实时温度或压力。
- `固定音频文件`：播放生成或上传的 WAV、MP3、OGG、M4A，声音稳定，适合固定报警话术。
- `自动`：已配置音频时优先播放文件，否则使用系统文字转语音。

“生成 WAV”使用现场 Windows 已安装的系统声音，不依赖云端接口。生成文件保存在 `uploads/audio`，并随整站灾备一起导出和恢复。生成后的 WAV 是固定内容；需要每次朗读实时数值时，应选择系统文字转语音。

安装版会注册 Windows 登录后自动启动。若要求停电来电后无人值守恢复展示，还必须在现场电脑 BIOS 中开启来电自动开机，并为专用展示账号配置 Windows 自动登录。

后台也有“数据库连接”配置入口。保存后后端会重连数据库并重启数据引擎。

## 数据模式

后台路径：`/admin` → **连接设置**。

- **内置低延迟采集**：`integrated_plc`，默认模式，后端直接连接 S7 PLC。
- **模拟数据**：`simulation`，离线演示用，不依赖 PLC。

默认是 `integrated_plc`。如果本地没有 PLC，设备会在超过离线阈值后变灰，这是正常表现。要做离线演示，请切到模拟数据。

## PLC 离线阈值

PLC 状态分两段：

1. 刚启动或短时间断线：`connecting` / `retrying`，质量为 `stale`。
2. 超过阈值仍无有效连接或读数：`offline`，质量为 `bad`，前端设备置灰。

默认阈值：15 秒。

可通过环境变量调整：

```powershell
$env:PLC_OFFLINE_AFTER_MS="30000"
```

## 报警跑马灯时间范围

后台路径：`/admin` → **组件配置** → `widget_marquee`。

默认配置：

```json
{
  "speed": 30,
  "limit": 20,
  "eventWindowHours": 24
}
```

含义：

- `speed`：滚动动画时长，单位秒。
- `limit`：最多显示多少条报警/事件。
- `eventWindowHours`：只显示最近多少小时的报警记录；设为 `0` 表示不限制时间。

后端接口示例：

```text
GET /api/platform/events?limit=20&window_hours=24
```

## 常用后台入口

- 车间 / 产线 / 设备配置
- PLC 点位映射
- 模型资产上传与节点绑定
- 模型动画绑定
- 组件配置与布局
- 设备浮标配置
- 诊断面板配置
- 数据库连接设置

## Agent / MCP 自动化接口

后端提供一个受控的 JSON-RPC MCP 接口，供本机 agent 直接读取和操作现场配置：

```text
http://127.0.0.1:3001/api/mcp
```

接口支持 `initialize`、`tools/list` 和 `tools/call`，内置工具包括：

- `get_project_state`：读取完整项目、空间、设备、点位和设计稿状态
- `get_model_inspection`：读取一个或全部模型的拆解、镜头、外壳、部件和点位绑定
- `get_model_inspection_presets`：读取软件内置的模型拆解模板
- `apply_model_inspection_preset`：把指定内置模板应用到模型并通知 Unity 热加载
- `validate_model_inspection`：校验拆解节点、部件重复/重叠和配置结构
- `save_model_inspection`：完整保存一个模型的拆解配置并通知 Unity 热加载
- `update_model_inspection`：增量修改拆解参数、部件、顺序，或添加/删除部件
- `apply_model_inspection_layout`：按比例缩放现有拆解布局，或重新生成网格布局
- `update_model_part_bindings`：整组替换或增量维护模型部件与 PLC/数据库点位绑定
- `update_model_metadata`：增量修改模型交付规范、优化、拆解、绑定和运行元数据
- `configure_demo_site`：幂等创建南区热处理示范车间并发布运行版本
- `upsert_workshop` / `upsert_line` / `upsert_device` / `sync_device_points`：受控写入现场配置
- `save_dashboard_draft` / `publish_dashboard`：保存或发布低代码大屏
- `configure_readonly_business_source`：测试并保存排产/生产数据库只读连接，可自动绑定业务摘要组件（支持 `sd_produce_batch` 与 `signal_history + rc_signal` 结构）
- `set_data_mode`：切换模拟数据或现场 PLC
- `run_acceptance_checks`：执行数据库、引擎、模型、视角和部件面板验收

例如，后续需要把某个模型的拆解整体放大 20%，可直接调用 `tools/call`：

```json
{
  "name": "apply_model_inspection_layout",
  "arguments": {
    "modelId": "photo_tempering_furnace_v6",
    "strategy": "scale",
    "spacing": 1.2,
    "preserveGround": true
  }
}
```

保存类模型工具会复用后台的模型保存接口，自动保留其它元数据并向 Unity 广播 `model_metadata_changed`，因此不需要再打开设计器逐个点击。

接口不再允许本机匿名修改。可信 agent 需设置后端 `MCP_API_TOKEN`，并通过 `Authorization: Bearer <token>` 或 `X-MCP-Token` 访问；也可使用 `ADMIN_API_TOKEN`。已经解锁的浏览器调用时须携带会话 Cookie 和 CSRF 头。示例验收（测试进程同样需设置对应令牌环境变量）：

```bash
cd backend
npm run test:mcp
```

## 常见问题

### 1. 后端启动失败，提示数据库连接失败

检查 MySQL/MariaDB 是否启动，以及端口、账号密码是否和默认配置一致。默认是：

```text
127.0.0.1:3307
root/root
dongtai_daping
```

如果你的 MySQL 是 `3306`：

```powershell
$env:MYSQL_PORT="3306"
cd backend
npm start
```

### 2. 没有 PLC，设备为什么变灰？

这是正确状态。默认 `integrated_plc` 模式会尝试连接 PLC；超过离线阈值后设备进入 `offline/bad`，大屏置灰。要做离线演示，请在后台切换到“模拟数据”。

### 3. 跑马灯没有报警记录

默认只显示最近 24 小时的事件。可以在后台 `widget_marquee` 里修改 `eventWindowHours`，或者临时请求：

```text
http://localhost:3001/api/platform/events?limit=50&window_hours=0
```

### 4. 前端能打开但没有数据

检查：

- 后端是否启动：`http://localhost:3001/api/health`
- WebSocket 是否可连：`ws://localhost:3001/ws`
- 后台数据模式是否为模拟，或 PLC 是否在线

## 构建

前端生产构建：

```bash
cd frontend
npm run build
```

后端语法检查示例：

```bash
node --check backend/server.js
node --check backend/services/plcReader.js
```

PLC 与断电恢复集成测试：

```bash
cd backend
npm run test:plc
npm run test:recovery
npm run test:site-backup
```

PLC 测试从相邻的 `PLC仿真调试器`（也兼容 `排产/PLC仿真调试器`）启动本机模拟服务。默认测试数据库由代码生成，不读取 `backend/data` 或现场数据库；所有数据库与日志写入项目的 `output/` 隔离目录。

完整的常规隔离回归：

```bash
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix desktop run test:logs
npm --prefix desktop run test:processes
npm --prefix desktop run test:resources
```

如已安装相邻的 PLC 仿真调试器及其 Python 运行依赖，可额外执行 `node backend/scripts/run-tests.cjs --with-plc-simulators`。测试仅连接本机模拟端口；它不能代替现场 PLC、GPU、多屏和真实断电验收。MySQL 灾备测试不再自动读取本机配置，必须显式指定 `ALLOW_MYSQL_TEST=true` 和专用测试服务的 `TEST_MYSQL_HOST/PORT/USER/PASSWORD`。

故障回归包括数据库事务隔离、配置失败回滚、恢复源保护、设计器并发保存、模型文件异常恢复、采集器启停、后台会话、进程监督及资源准备。详情见 [2026-09-11 软件排查报告](docs/software-audit-2026-09-11.md)。CI 运行常规隔离回归；不会连接真实 PLC 或现场数据库。

依赖审计请使用支持 audit API 的源，例如 `npm audit --registry=https://registry.npmjs.org`。部分镜像返回“不支持 audit”并不代表没有漏洞。后端对 `qs` 使用兼容的安全版本 override，避免 Express 的固定间接依赖重新引入已知漏洞。

Windows 客户安装包：

```bash
cd desktop
npm install
npm run dist
```

安装包输出到项目根目录的 `安装包/`。安装后无需另行安装 Node.js、数据库或浏览器；客户数据默认保存在 Windows 用户应用数据目录，卸载时不会自动删除。

## 提交说明

仓库提交源码、模型资产、后台配置逻辑和工具脚本。

不会提交：

- `node_modules`
- 运行日志
- 本地数据库配置 `backend/data/database-config.json`
- 本地 SQLite 文件
- 前端构建产物 `frontend/dist`
