# Windows 发布 runner 准备

普通测试使用 GitHub 托管 runner。完整安装包需要 Unity 2022.3.34f1c1 和 MySQL Windows 运行文件，因此发布使用专用 Windows x64 自托管 runner，标签为 `digital-twin-release`。

## 首次准备

在专用构建账户安装 Node.js 22.12+、.NET 8 SDK、Git、GitHub CLI、Unity 项目指定版本及 Windows Build Support，完成 Unity 许可证激活；准备 MySQL 9.2 完整安装目录（不需要运行数据库服务），安装 WebView2 Runtime 和 Visual C++ x64 运行库。账户应处于已登录的 Windows 桌面会话，具有访问网络和构建目录的权限。不要用现场正在运行生产大屏的账户做构建。

先运行仅检查本机依赖的命令，此命令不注册 runner、不修改远端：

```powershell
.\tools\ci\setup-windows-runner.ps1 -CheckOnly
```

非默认安装路径可以传 `-UnityEditorPath 'D:\Unity\Editor\Unity.exe' -MysqlRuntimeSource 'D:\mysql-9.2'`。预检核对编辑器版本和 MySQL 文件存在性；许可证、图形会话、WebView2、MySQL 动态库的完整可用性仍需实际发布构建和 smoke test 验证。

管理员使用 `gh auth login` 登录该仓库的 GitHub 管理账户，再显式执行以下命令注册并启动 runner：

```powershell
.\tools\ci\setup-windows-runner.ps1 -InstallAutoStart
```

脚本通过 GitHub API 获取官方 Windows x64 runner 下载地址和 SHA256，校验后解压；短时注册 token 通过临时进程环境传递，不打印 token。脚本不会自行登录，不会替换同名远端 runner，也不会替用户启用远端 workflow。API 授权需要仓库管理员身份及管理 repository runners 的权限；细粒度 token 需要 Repository administration write，经典 token 私有仓库通常需要 repo scope。

默认目录是 `%USERPROFILE%\actions-runners\digital-twin`，独立于源码目录；默认名称是 `<计算机名>-digital-twin`。可用 `-RunnerDirectory`、`-RunnerName`、`-Repository owner/repo` 覆盖。不要让两个 runner 共用一个目录。

## 重启与故障恢复

重复运行相同命令会验证原配置并检查本目录的 `Runner.Listener.exe`，已有进程不会再次启动。`-InstallAutoStart` 安装当前用户的登录启动快捷方式；后台守护在异常退出后 15 秒重试。它不安装 Windows 服务，以支持 Unity/WebView2 的桌面启动检查。电脑必须开机、联网并已登录桌面；关机或退出账户时 GitHub 只能排队，不能构建。临时停止守护可在 runner 目录创建 `stop.flag`，确认无任务后关闭本 runner；重新启动前自行删除该标记。

`release-environment.json` 只保存 Unity、MySQL 和**公钥**路径；厂商私钥不进入仓库、runner 工作目录或 Actions secrets。发布机通过 `LICENSE_ISSUER_PUBLIC_KEY_FILE` 或当前用户已有的厂商公钥打包。

配置中断后，脚本不会覆盖非空且尚未成功配置的目录：先查看 `_diag` 日志，确认无正在运行的构建，选择新的专用空目录重试；如远端已出现 runner，先核查并按 GitHub Settings → Actions → Runners 的移除流程清理失效记录。不要为重试直接删除工作目录或覆盖远端同名 runner。

在仓库 Settings → Actions → Runners 确认 `Idle` 和 `digital-twin-release` 标签后再触发发布。使用主分支手动发布或受保护版本 tag，禁止把自托管发布任务接到外部 PR 或 `pull_request_target` 的外部代码上。构建采用初始模板，避免把现场数据库或上传文件作为安装包输入。发布环境和受保护分支由仓库管理员设置。

Runner 的进程路径检测只针对本安装目录。停止 runner 前应确保 GitHub 显示 Idle，避免打断正在执行的发布。安装目录 `_diag` 保存 runner 日志；不要上传 `.credentials`、`.credentials_rsaparams` 或整个 runner 目录。

## 发布与下载

在 Actions → Windows installer → Run workflow 选择 `main`；或推送已合入 main 且与 `desktop/package.json` 一致的 `vX.Y.Z` tag。先启用仓库变量 `WINDOWS_RELEASE_RUNNER_ENABLED=true`。流程执行自动回归、初始模板打包、独立 MySQL 首次启动／重启和资源完整性检查、原生界面验证，再上传产物。

只有全部成功才会创建草稿、附加安装包及 SHA256、复核提交与文件哈希，然后**自动发布 Release**。手动 main 发布也使用当前版本 tag。已有 tag 指向其它提交或已发布的同版本不会被覆盖；新版本必须先修改版本号。下载入口是仓库 Releases；私有仓库需要访问权限。失败运行只保留 Actions 日志，不会把旧安装包当作新版本发布。
