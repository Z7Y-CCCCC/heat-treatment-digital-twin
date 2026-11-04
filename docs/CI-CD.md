# 自动测试与 Windows 安装包交付

## 日常使用

1. 推送 main 或创建指向 main 的 PR：GitHub Actions 自动运行前端、后端、模拟器和 Windows/原生回归；失败可下载测试日志。
2. 测试安装包：在 Actions → Windows installer → Run workflow 选择 main。通过全部质量检查后，在专用 Windows 构建机生成安装包，执行首次启动与重启验证，再上传 `windows-installer-运行号`。不需要手工逐条运行构建命令。
3. 发布版本：同步更新 `desktop/package.json` 和 `release-manifest.json` 的版本，并更新 desktop 锁文件；合入 main 后手动运行 main 或推送对应 `vX.Y.Z` 标签。工作流先创建草稿，上传并验证主包、可选采集插件、SHA-256 与构建清单，再自动公开为正式 Release，不会停在草稿状态。

安装包仅包含初始模板，绝不从构建机复制现场数据库或上传资源。产物保留30天，构建日志保留14天，标签构建的 Release 资产长期保留。已有正式 Release 不会被工作流覆盖。

## 一次性启用

构建机需要项目指定版本 Unity 及有效许可、Windows x64 MySQL 运行文件、Node 22、.NET 8 和 MSVC 运行库。使用 [runner 设置说明](CI-CD-runner.md) 中的脚本注册独立 runner。它使用专用标签 `digital-twin-release`；仅主分支及已合入主分支的版本标签会进入本机打包，普通 PR 使用 GitHub 托管机器。

注册后设置仓库 Actions variable：`WINDOWS_RELEASE_RUNNER_ENABLED=true`。未启用时工作流会快速给出提示，不会无限等待不存在的 runner。构建机必须在线，且交互式 Windows 用户会话保持登录，以运行 Unity/WebView2 启动验收。

建议在仓库规则中保护 main 与 v* 标签，限制修改工作流和手工发布权限；公共仓库不要让自托管 runner 执行外部 PR。此配置没有 pull_request_target，也不在本机运行 PR 工作流。

## 实现与验证

- `quality.yml` 可复用：release 必须先通过同一套质量门禁。
- `release.yml` 顺序执行版本检查、质量门禁、Windows 构建、产物哈希验证、上传、草稿复核并公开 Release。
- 干净 checkout 后恢复 Unity Library/Builds 和构建缓存；脚本继续验证缓存失效条件。没有关闭 checkout 清理。
- `collect-release.cjs` 拒绝跳过启动测试、客户配置、损坏安装包、多份旧构建目录；上传前重新计算 SHA-256。
- 本地验证：`node --test tools/ci/collect-release.test.cjs`；`node tools/ci/check-release.cjs`。

2026-11-04 已在专用 Windows runner 跑通完整构建、隔离短测、上传与公开发布。[v2.3.2](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/releases/tag/v2.3.2) 已可下载主包和独立采集插件；[run 41802526546](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/actions/runs/41802526546) 第三次尝试全部成功。构建提交、文件大小/哈希和仍需 Ethan 实机验证的边界见 [交付记录](发布交付-v2.3.2.md)。历史失败保持原状态，不把源码存在当成发布成功。
