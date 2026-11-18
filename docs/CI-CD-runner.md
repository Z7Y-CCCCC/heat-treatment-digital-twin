# GitHub 云端自动发行：合并 main 后生成新安装包

## 使用方式与费用

本仓库是公开仓库。发行和质量检查使用 GitHub **标准托管** Windows runner（windows-2022），标准 runner 的公开仓库构建免费；没有选用收费的 larger runner，不更改账户计费设置。

以后正常交付只需：本机修改源码 → 提交 PR → 检查通过并合并 main。Windows installer 在 main push 上自动规划新版本、测试、云端打包、校验并发布 Release。提交后本机可关机；无需保持原自托管 runner 在线、手动点 Run workflow、创建 tag 或手动上传 EXE。

只有全部门禁成功才会发布。失败结果不能算“新安装包已交付”。质量检查、云端依赖、Unity 授权、空业务数据、模板、首次启动/重启、原生叠加界面、安装界面、主包和插件完整性检查均保留。

## 一次性配置 Unity 授权

云端编译需要项目指定的 Unity **2022.3.34f1c1 / 1e17368ca73f**。GitHub 免费构建不等于 Unity 可以不授权；须使用符合现有 Unity 条款的有效授权，本流程不会开通付费套餐或绕过许可证。

将有权用于 CI 的现有 Unity .ulf 文件内容设置为仓库 Settings → Secrets and variables → Actions 中的 **UNITY_LICENSE**。不要将许可证、密码、厂商私钥写入源码、PR、聊天或普通仓库变量。是否复制本机许可证必须由 Ethan 单独确认，配置脚本不会自动读取本机 C:/ProgramData/Unity 或上传任何凭据。

若许可证尚未配置，发行预检在大文件下载前明确失败；不会占用本机 runner，也不会发布半成品。若 Unity 在云端拒绝该许可证，应修复 CI 的合法授权，不能跳过编译门禁或用旧二进制冒充当前源码。

许可证仅注入需要它的两个步骤，不写入 GITHUB_ENV、不进入 cache、发布资源或日志附件。激活使用 runner 临时私有目录，临时 .ulf 用完删除，激活日志不上传。许可证适用性由实际云端激活和构建验证；不能把本机存在许可证当作云端已经可用。

## 自动版本与重试

源码中的 desktop/package.json、desktop/package-lock.json 与 release-manifest.json 仍须相互一致，作为产品主/次版本基线。普通修改无需手工提升补丁版本。

main 发行版本根据已合并的语义版本 tag 和提交距离自动计算，例如源版本仍为 2.3.6，新的 main 提交会得到高于上一发行的版本；多个分支提交可导致补丁号跳号。显式修改一致的主/次版本会被尊重，不能降低已经发行的版本。

版本号只注入 GitHub 的干净、一次性构建 checkout，不自动回写 main、不改本机源码或现场数据。安装包、内置采集插件、独立插件及下载文件名使用相同版本；上传前再次核对版本、源提交、run、文件大小与 SHA-256。

同一源提交已有 tag 时，重试使用同一版本。已发布的版本不移动 tag、不替换现有资产。只有同源的保留 tag / draft 可以恢复。GitHub API 权限、限流或服务错误必须失败，只有真实 404 代表版本不存在。

发行 workflow 使用串行 concurrency，避免并发 main 发布争用版本。workflow_dispatch 的 verified_run_id 可重试已通过所有强制门禁的 main 构建；产品源码已变化时必须重新构建。中间 Actions artifact 保留 7 天，正式 Release 安装包不随它到期。

只允许已合并 main 的源码或其版本 tag 发布，不运行外部 PR 代码的发布任务，不使用 pull_request_target。PR 仅运行标准云端质量检查。

## 仅修改流水线时的显式不打包

Ethan 仅要求修改规则或流水线时，合并提交标题须含 **[skip release]**。这只抑制本次 main push 的安装包构建/发行，独立 main 质量检查仍正常执行。它不是 [skip ci]，不跳过测试，不关闭发布规则，不修改断言。以后正常 main 合并不含该标记，自动编号和发行照常执行。

本次云端迁移使用该标记，不重打或覆盖已发布的 v2.3.6，也不以配置变更擅自触发新的安装包发布。

## 云端依赖与信任来源

- Node 22.13.1 与 .NET 8：官方 setup actions。
- Unity：官方中国下载站的指定版本/修订，严格核对下载长度、完整 Authenticode 签名及固定发布者证书指纹，安装后检查编辑器版本；不自动改用别的编辑器。
- MySQL 9.2.0：Oracle 官方归档 ZIP，固定字节大小及 SHA-256。只提取运行文件，不启动预置现场数据库服务。
- 厂商授权身份：tools/ci/trust/license-public-key.pub 是已有签发身份的公开验证密钥。SPKI SHA-256 固定在 cloud-runtime.json；必须为 Ed25519，拒绝私钥和身份变化。仅公钥进入交付包，不生成替代身份。
- 官方大文件下载采用 HTTP Range 断点续传、连接/传输时限及最多 6 次重试；连接重置时保留已下载字节，不重复整份下载。不接受忽略 Range、超出固定长度或未通过完整签名/摘要的文件。
- 云端临时文件的删除、移动和安装均限定于经校验的 RUNNER_TEMP；脚本拒绝在本机或 self-hosted 环境执行。
- 依赖缓存仅含依赖下载、Unity 导入/编译缓存及经既有完整性检查的构建缓存，不含许可证或现场数据。

独立下载后的安装包仍必须符合根目录《打包必看.md》：仅保留固定 7 视角、35 静态组件；主包和独立采集插件的全部现场业务、模型、动作、PLC、账户及历史数据为空。不会从本机库或旧安装包重建/替换静态模板。

## 本地与云端验证

以下命令只验证源码/隔离夹具，不构建发行安装包：

    node --test tools/ci/auto-release-version.test.cjs tools/ci/set-build-version.test.cjs tools/ci/cloud-runtime.test.cjs tools/ci/cloud-download.test.cjs tools/ci/cloud-readiness.test.cjs tools/ci/release-trigger.test.cjs tools/ci/collect-release.test.cjs tools/ci/workspace-idle.test.cjs tools/ci/release-environment.test.cjs
    node tools/ci/check-release.cjs
    node tools/ci/cloud-runtime.cjs
    node tools/repository-hygiene.cjs

还须执行原有 desktop 资源回归及 main/PR 全部质量检查。原生 overlay 在 GitHub-hosted Windows 上执行实际测试，不只编译；失败不能跳过以放行。

原 setup-windows-runner.ps1 / start-windows-runner.ps1 与 windows-cache-check.yml 仅保留作已存在自托管机的手动维护/诊断工具，**不再是 main 发行的依赖**。不擅自停止或删除 Ethan 电脑上的服务、采集器和现有配置。

## 云端只验收、不打包

Cloud Windows readiness 是仅可在可信 main 上手动触发的隔离验收：下载并核验官方编辑器/运行库、使用获准 Secret 激活 Unity、执行新建空 Unity 夹具、检查 MySQL 版本。它不运行应用打包脚本、不生成或发布安装包，仅上传不含凭据的 readiness.json；不能把此验收冒充完整安装包发行成功。
