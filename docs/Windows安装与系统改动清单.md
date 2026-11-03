# Windows 安装、依赖、数据与系统改动清单

适用：2.3.2 开发候选，“大屏＋后台管理”主程序。**GitHub 已发布的 2.3.1 是旧版，仍内置采集服务；不能用本清单的拆分结论描述旧包。**

## 0. 这台电脑当前的真实位置（只读核对）

2026-11-03 查询结果：

- 根目录 `启动大屏.cmd` 启动的是本仓库开发版，不是安装包验收。
- HKLM/HKCU 的应用卸载目录中未查到本产品安装记录，也未查到名为 `HeatTreatmentCollector` 的 Windows 服务；这不等于清理了历史缓存，本次没有执行清理。
- 当前数据库配置：`C:\Users\27323\AppData\Roaming\heat-treatment-digital-twin-desktop\data\database-config.json`。
- 该配置连接 `127.0.0.1:3307`，数据库 **`dongtai_daping`**，不是 `managedBy: desktop-mysql` 的随包托管实例。
- 用只读 SQL 查询核对到实际版本 **MySQL 5.7.44-log**；服务端数据目录为 **`C:\ProgramData\MySQL\MySQL Server 5.7\Data\`**。不能把数据目录中的 `dongtai_daping` 子目录单独复制就当作完整 InnoDB 备份，应使用逻辑备份或整站备份。
- 本轮没有更换、升级、停止或初始化这个现有数据库。新安装候选测试使用隔离数据目录和自带 MySQL 9.2.0，不混用这份现场库。

下文的“默认独立 MySQL”描述的是**没有既有数据库配置的新安装**。已有外部数据库连接会保留，不会强行替换为随包实例。后台“安全服务”是本地后台进程提供的登录/权限接口，不是给 Windows 新装了一个同名系统服务；它与独立可选的 Windows 采集服务是两件事。

## 1. 支持范围与验收边界

- 主包仅构建 **Intel/AMD x64**，安装器最低检查 **Windows 10 1809 / build 17763**；推荐 Windows 10 22H2 或正常更新的 Windows 11。
- 不支持 32 位 Windows，不把 Windows ARM64 的 x64 仿真、Windows S 模式、精简/修改过的系统算入保证范围。S 模式可能由 Windows 直接禁止运行 EXE，程序无法绕过该限制。
- Unity 项目实际使用 **2022.3.34f1c1**，不是 Unity 6。整个产品还受 .NET 8 Windows 宿主、WebView2、Electron/Node 和显卡驱动约束；不能仅凭 Unity 的兼容表承诺“所有 Win10/11”。
- 当前实机测试环境是 **Windows 11 专业版 x64，build 26200**。没有可用的干净 Windows 10 / 11 虚拟机快照；旧系统判断、缺依赖、取消和失败分支的自动化测试，不等于对应系统已实机安装通过。
- 显卡需要支持产品使用的 Direct3D，并安装厂商正式驱动。远程桌面、虚拟显卡、显存容量和模型规模会影响效果及性能，本轮不作长稳/性能承诺。

## 2. 新电脑要装什么

| 项目 | 交付方式 / 行为 |
|---|---|
| Unity Player、Mono | 主包自带完整运行文件，用户不需要装 Unity 编辑器或 Hub。启动前检查关键 Player/Mono 文件，缺失不再直接弹含糊的 “Failed to load mono”。 |
| Node.js、后台生产依赖 | 自带专用运行时与依赖，解压到本程序的数据目录；不安装全局 Node/npm，不修改 PATH。 |
| MySQL | 自带专用运行文件；没有已有数据库配置时，在本程序用户数据目录初始化独立实例。只监听本机，自动选端口。不覆盖电脑已有的 MySQL，不注册主程序 MySQL 系统服务。 |
| .NET 8 | 原生 WebView 宿主按 self-contained 发布；不要求客户自行安装 .NET SDK 或全局 .NET 8 运行时。 |
| Microsoft Visual C++ x64 | 检查已安装版本，应用基线 14.40；缺失/过旧时使用随包 Microsoft 官方离线安装程序，验证 SHA-256 与 Authenticode 签名后执行。不降级已就绪的运行库。 |
| Microsoft Edge WebView2 Runtime | 应用基线 120；检测机器级和用户级注册信息，已有可用版本则跳过。缺失/过旧时用随包 Evergreen x64 离线安装器；不是要求用户装浏览器开发版。 |
| 采集插件 | **不是主包依赖，不安装也能登录、配置工程、接外部接口和展示。** 本轮不测试采集功能。 |

安装器明确显示“检查并准备运行环境”；新装电脑离线也有运行库文件。首次打开会再次检查，避免用户删掉/损坏共享运行库后只能看到空白页。修复需要用户确认，拒绝时不继续初始化数据库或启动 Unity，并提供 Microsoft 官方下载入口。遇到返回码 3010 提示重启 Windows，**不会自行重启电脑**。

这两个 Microsoft 运行库是共享组件，可能由 Windows/Microsoft 后续更新。安装它们会产生 Microsoft 自己的文件、注册表、卸载项，WebView2/Edge Update 还可能维护更新服务或计划任务；本程序不伪造这些项目的完整固定清单，也不会在卸载大屏时删除共享运行库，以免损坏其他软件。

## 3. 安装时创建的程序文件

默认主程序目录：`%ProgramFiles%\热处理数字孪生大屏\`，允许在安装界面选择其他位置。

- 主程序 EXE、卸载 EXE、图标、`resources\app.asar`。
- `resources\native-client`：Unity、Mono 和 self-contained 原生后台宿主。
- `resources\frontend`、`backend`、`shared`：后台页面、本机接口和共享契约。
- `resources\runtime`、`mysql`、`backend-dependencies.tar`：专用 Node、MySQL 与后端依赖归档。
- `resources\templates`：首次初始化的模板，不是现场运行数据库；仅带公开授权校验公钥，不带厂商私钥。
- `resources\prerequisites`：Microsoft 离线安装器、来源/哈希/签名清单及环境检查脚本。
- `部署与连接.cmd`、`现场部署选项.ps1`、交付说明与第三方声明。

主包不含本程序的 PLC reader、采集 worker、Windows 采集服务 EXE 和采集运行中心。不会自动注册 `HeatTreatmentCollector`。已有旧采集服务仍引用此安装目录时，安装器阻止覆盖并提示先迁移独立插件，不强杀服务或数据库。

快捷方式：公共桌面和公共开始菜单中的“热处理数字孪生大屏”。**这些快捷方式不是采集服务开机启动。**

## 4. 数据到底存在哪里

### 纯展示 / 本机后台

根目录：`%APPDATA%\heat-treatment-digital-twin-desktop\`。以当前用户 Ethan 的环境为例，对应 `C:\Users\27323\AppData\Roaming\heat-treatment-digital-twin-desktop\`；测试使用独立目录，不写进该现场目录。

| 路径（相对上述根目录） | 内容与注意事项 |
|---|---|
| `data\database-config.json` | 当前实际数据库类型、地址、端口、账号及密码。属于敏感配置，不要截图/公开上传。 |
| `mysql\data\` | **默认正式运行的 MySQL 数据文件**。不要一边运行一边直接复制此目录当备份。 |
| `mysql\runtime.json`、`host-config.json` | 专用实例状态、连接凭据和启动配置。不是可以随意删除的缓存。 |
| `data\factory.db` | 初始/应急 SQLite 快照；看到此文件不代表当前正式数据仍写在 SQLite。以 `database-config.json` 为准。 |
| `data\admin-security.json` | 用户、角色和权限，密码使用带盐哈希，不保存用户明文登录密码。 |
| `data\admin-sessions.json` | 可恢复会话的哈希、元数据及完整性签名；账号禁用、改密、退出仍须失效，不能把“记住账号”当作永久免验证。 |
| `data\data-sources.json`、`data-source-files\` | 外部接口/数据库连接和导入文件，可能含连接秘密，按敏感数据保管。文件接入资源实际位于 `data\data-source-files\`。 |
| `data\license.json` | 当前授权与激活历史等授权状态；不含厂商签发私钥。 |
| `machine-identity.json`、`.bak`、`.hardware` | 安装锚点与硬件指纹缓存。旧版本已有机器级锚点时兼容读取 `%ProgramData%\HeatTreatmentDigitalTwin\machine-identity.json`，不随意重建导致旧授权失效。 |
| `uploads\models`、`uploads\audio` 等 | 用户上传的模型、音频和界面图片。模型业务 ID/绑定关系不能仅靠拷贝一个 GLB 恢复。 |
| `backend-dependencies\` | 从归档解出的专用依赖和校验标记，不是现场业务库。 |
| `webview2\` | 内嵌网页缓存、Cookie、LocalStorage 等；Cookie 与 Windows 用户保护相关，不能承诺复制到另一台电脑就保留登录。 |
| `logs\` | 主程序、后台、Unity、WebView、MySQL、启动错误和最近依赖检查记录。日志文件有轮转/保留上限，不默认上传云端。 |
| `deployment.json`、`startup-appearance.json` | 明确选择的数据服务地址和启动外观缓存；服务故障不会自动改成另一个数据库。 |

另外，本项目的 Unity 公司名与产品名均为 `Heat Treatment Digital Twin`，Unity/Windows 可能在 `%USERPROFILE%\AppData\LocalLow\Heat Treatment Digital Twin\Heat Treatment Digital Twin\` 写入 Player 偏好、日志或崩溃信息；Electron/WebView2 也有自己的崩溃缓存。它们不等同于现场业务库。

### 中文路径的 MySQL 兼容目录

主程序安装器准备 `%ProgramData%\HeatTreatmentDigitalTwinDisplayLinks\`。里面是按真实数据路径和运行库路径生成的哈希子目录，以及 `runtime` / `storage` 的 Windows junction。**这些是指向真实目录的链接，不是第二份数据库。**

该容器允许普通用户创建自己的子目录，但不允许修改别人的链接；子目录由创建者拥有。它与独立采集服务的管理员目录分开，避免“安装过采集插件后，普通用户的新展示工程无法建库”。卸载后保留链接，不在卸载时沿链接递归删除真实数据库。

容器权限仅由提升权限的安装器准备；普通用户的首次启动运行库修复不会尝试重写机器级目录 ACL。如果该容器被管理员删除，应运行安装器修复，不要给整片 ProgramData 开放修改权限。

### 已安装独立采集插件时（仅位置说明，本轮不测采集）

程序：`%ProgramFiles%\HeatTreatmentCollectorPlugin`；机器数据：`%ProgramData%\HeatTreatmentDigitalTwin\collector`；发现配置：`%ProgramData%\HeatTreatmentDigitalTwin\collector-service.json`。服务使用 LocalService 和专用服务 SID，Unity 连接同一数据服务，不再启动第二份本机数据库。旧服务的 MySQL junction 位于同一机器目录的 `mysql-links` 中。

## 5. 备份与恢复位置

| 项目 | 默认位置 / 策略 |
|---|---|
| 数据库自动备份 | `data\backups\`；启动、正常退出和定时备份（默认 6 小时）。MySQL 为 `.sql.gz`，SQLite 为 `.db`。当前默认按 **30 天**保留，同时受总容量预算限制，兼容旧份数设置；不能继续沿用旧说明“固定 10 份”的说法。 |
| 数据库恢复工作区 | `data\recovery\`，用于恢复前验证/回滚。不要在恢复过程中清理。 |
| 整站备份 | `data\site-backups\`，包含配置数据库、上传模型/音频等；默认本机保留 5 个整站包并受 4 GiB 预算约束。自动整站备份必须在后台配置启用；不是安装后必然已有外部灾备。 |
| 整站导入与故障证据 | `data\site-imports\`、`data\site-recovery-evidence\` 及恢复意图文件。异常时保留证据，不能删除后强行继续写库。 |
| 外部数据库备份 | `data\data-source-backups\`，由对应连接和备份计划控制。 |
| U 盘 / NAS | 只有在后台配置镜像目录且服务/用户有权限时才同步。UNC 路径与登录用户映射盘不是一回事。 |

装在同一硬盘里的自动备份不能防硬盘损坏、整机丢失。建议把整站备份另存到外部介质，并做一次备用电脑恢复演练。压缩/哈希校验不等于加密备份，包内可能含敏感配置。

## 6. 本程序自身写入的注册表

NSIS 的产品安装 GUID：`f4a3faa5-b683-504e-843e-d10bf0fbdc33`（由 `com.digitaltwin.heattreatment` 固定派生）。

1. `HKLM\Software\f4a3faa5-b683-504e-843e-d10bf0fbdc33`：`InstallLocation`、`KeepShortcuts`、`ShortcutName` 等安装元数据。
2. `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\f4a3faa5-b683-504e-843e-d10bf0fbdc33`：显示名称、版本、图标、卸载命令、静默卸载命令、估计大小等“应用和功能”信息；默认全用户安装，具体 32/64 位注册表视图由安装器处理。
3. **启用登录后自启时**，Electron 在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 管理主程序启动项，命令带 `--autostart`。这是 Windows 登录后开大屏，不是无人登录的 PLC 采集。关闭该选项会移除相应自启项。
4. Unity/Chromium/Windows 可能保存产品偏好、崩溃或兼容性痕迹；共享 WebView2/VC++ 的注册表与更新项由 Microsoft 安装器管理，不计成“本程序偷偷注册采集服务”。

Unity PlayerPrefs 的本产品用户键为 `HKCU\Software\Heat Treatment Digital Twin\Heat Treatment Digital Twin`；这里是显示/交互偏好，不是本程序的业务数据库。Windows 的 UserAssist、兼容性记录、最近使用等系统痕迹也可能随 EXE 运行更新，卸载器不清除其他软件或整个系统的这些记录。

普通运行不需要管理员权限；全用户安装、运行库修复和独立采集服务安装可能需要 UAC。使用 `-ExecutionPolicy Bypass` 仅作用于该 PowerShell 子进程，**没有永久修改 PowerShell 执行策略**。

## 7. 默认不会改什么

不修改系统 PATH、hosts、DNS、代理、防火墙规则；不关闭 Defender/UAC；不改 Windows Update、BIOS、显卡驱动；不设置 Windows 自动登录；不在主包注册采集服务或接管已有 MySQL 服务。不把客户账号、PLC 凭据、数据库或厂商私钥上传 GitHub。

运行时会申请临时防休眠/保持显示请求，进程正常结束即释放，不等于改电源计划。`现场部署选项.ps1` 默认只检查；只有工程师**显式执行**电源策略应用参数才创建/修改电源计划，并提供恢复入口。安装器不会默认执行该更改。

## 8. 卸载、重装与安全清理

正常卸载移除主程序目录、快捷方式和本产品的安装注册项，**默认保留用户数据与业务库**；不会卸载共享 Microsoft 运行库，也不会停止独立目录中的采集插件。重装不会自动覆盖已有工程。

本机登录后自启项应先在系统设置关闭；卸载后的无效自启项由 Windows/工程师检查，不要把“保留数据”理解成绝对无残留。彻底清理前先导出整站备份、退出所有本产品进程，核对数据库位置；删除 junction 只能删链接本身，禁止跟随链接递归删库。不要直接照抄其他电脑的用户路径或注册表导出文件。

## 官方参考

- [Unity 2022.3 系统要求](https://docs.unity3d.com/2022.3/Documentation/Manual/system-requirements.html)
- [Microsoft WebView2 的检测、在线和离线分发](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)
- [Microsoft Edge/WebView2 的 Windows 支持说明](https://learn.microsoft.com/deployedge/microsoft-edge-supported-operating-systems)
- [Microsoft Visual C++ 运行库](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)
- [NSIS 安装器官方说明](https://nsis.sourceforge.io/Docs/)
