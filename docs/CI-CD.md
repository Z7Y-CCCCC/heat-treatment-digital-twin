# 自动测试与 Windows 安装包交付

## 日常使用

1. 推送 main 或创建指向 main 的 PR：GitHub Actions 自动运行前端、后端、模拟器和 Windows/原生回归；失败可下载测试日志。
2. 测试安装包：在 Actions → Windows installer → Run workflow 选择 main。通过全部质量检查后，在专用 Windows 构建机生成安装包，执行首次启动与重启验证，再上传 `windows-installer-运行号`。不需要手工逐条运行构建命令。
3. 发布版本：同步更新 `desktop/package.json` 和 `release-manifest.json` 的版本，并更新 desktop 锁文件；合入 main 后推送对应 `vX.Y.Z` 标签。工作流生成带安装包和 SHA-256 的 **Draft Release**，检查后再发布给客户。

安装包仅包含初始模板，绝不从构建机复制现场数据库或上传资源。产物保留30天，构建日志保留14天，标签构建的 Release 资产长期保留。已有正式 Release 不会被工作流覆盖。

## 一次性启用

构建机需要项目指定版本 Unity 及有效许可、Windows x64 MySQL 运行文件、Node 22、.NET 8 和 MSVC 运行库。使用 [runner 设置说明](CI-CD-runner.md) 中的脚本注册独立 runner。它使用专用标签 `digital-twin-release`；仅主分支及已合入主分支的版本标签会进入本机打包，普通 PR 使用 GitHub 托管机器。

注册后设置仓库 Actions variable：`WINDOWS_RELEASE_RUNNER_ENABLED=true`。未启用时工作流会快速给出提示，不会无限等待不存在的 runner。构建机必须在线，且交互式 Windows 用户会话保持登录，以运行 Unity/WebView2 启动验收。

建议在仓库规则中保护 main 与 v* 标签，限制修改工作流和手工发布权限；公共仓库不要让自托管 runner 执行外部 PR。此配置没有 pull_request_target，也不在本机运行 PR 工作流。

## 实现与验证

- `quality.yml` 可复用：release 必须先通过同一套质量门禁。
- `release.yml` 顺序执行版本检查、质量门禁、Windows 构建、产物哈希验证、上传、草稿 Release。
- 干净 checkout 后恢复 Unity Library/Builds 和构建缓存；脚本继续验证缓存失效条件。没有关闭 checkout 清理。
- `collect-release.cjs` 拒绝跳过启动测试、客户配置、损坏安装包、多份旧构建目录；上传前重新计算 SHA-256。
- 本地验证：`node --test tools/ci/collect-release.test.cjs`；`node tools/ci/check-release.cjs`。

当前工作区包括上一轮修复及新增模块；首次启用时应一并提交完整依赖文件，不能只上传 YAML。本地文件存在不表示 GitHub Actions 已启用或远端构建已通过，应以仓库实际运行结果为准。

本轮已通过 actionlint 1.7.12 工作流检查、产物收集与拒绝异常产物回归、本机 Windows PowerShell 5.1 构建环境预检。尚未推送工作流或注册 runner，远端首轮执行待公开上传源码及启用构建机的授权后进行。
