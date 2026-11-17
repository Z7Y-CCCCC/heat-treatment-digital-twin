# 安装窗口、错误详情与 Release 核查（2026-11-17）

> 后续更新：Ethan 已再次明确要求合并、生成安装包并上传 Release；以下“只修复核查”的边界和 GitHub 状态是此前阶段的历史记录，不代表后续交付状态。后续默认优化与原生解压门禁见 `installer-optimization-v2-20261117.md`，实际发布结果以远端状态与 Release 证据为准。

## 本轮边界

Ethan 明确选择“先修复、核查，不打包发布”。没有运行发行构建、重压正式安装包、上传附件、合并 PR 或更新标签。仅编译无安装能力的原生 UI fixture 与编译期测试，不写现场数据库、不安装运行库、不修改采集服务。

## 已确认的缺陷与修改

- 原 `DisplayInstallingShow` 主动隐藏 NSIS Cancel；没有最小化实现。现在使用独立的原生最小化/关闭按钮，安装期间不会被 NSIS 隐藏。关闭请求立即显示，随后在当前步骤结束的检查点取消；不强杀运行库安装、采集进程或服务，不宣称自动回滚已经复制的程序文件。
- electron-builder 的安装 section 在 SHOW 回调后执行 `SetDetailsPrint none`，覆盖页面设置。现在在真正的 worker 钩子重新启用输出，详情默认展开，明确显示采集插件、升级检查、程序复制、运行库与最终核对阶段。
- `ExecToStack` 会等到子进程退出才显示有限长度的输出。运行库/采集插件改用 `ExecToLog`；安装专用输出采用 UTF-16LE/BOM，让 NSIS 正确识别中文，再由原生详情监听写成 UTF-8 文件。正常应用调用的 JSON/UTF-8 接口保持不变。
- 错误保留在安装页，不靠瞬时提示框；日志使用独占新建的 `%TEMP%\HeatTreatmentDigitalTwin-install-进程ID-时钟值.log`，持续刷新并在退出后保留。显示已用秒数，不用虚假百分比假装外部安装器有进展。
- 无标题窗口仍带 `DS_MODALFRAME`，产生白色非客户区边缘；已去掉该标志，保留插画、圆角和 DPI 处理。
- 取消、失败、需要重启均不启动大屏。取消发生得很晚、文件步骤已经结束时，也不执行完成页的启动动作。

原截图的一闪而过错误没有留下原始日志，当前也没有原安装进程，**不能据此断言原安装卡住的实际原因已查明**。本轮修复的是已确认的窗口/详情/诊断缺陷，并补足下一次定位所需的可见步骤和持久日志。未执行真实 SCM 提权安装、升级回滚或全机型认证。

## GitHub 只读核查

- PR [#50](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/pull/50) 仍为 OPEN，来源提交 `cf93fd2d1dafd746f1bc45d0a2646cef9ca84fc0`；分支质量与模型资产检查成功，不等于 main 已更新。
- main 为 `90429fb574f18ec0f0107f3e3e5fc6cc8f808c68`。截至核查，Releases 没有 v2.3.4。
- [v2.3.3](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/releases/tag/v2.3.3) 仍有旧安装器与“请勿继续使用此安装器”的缺陷声明。安装附件大小 888,556,604 字节，服务端 SHA-256 为 `4cf2fb152fb2d836c7319ef9ca4a91e0d984bc88906e529f36354c12e914c457`；不是本机后来的界面修正版。
- [44028051196](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/actions/runs/44028051196) 在 Unity 构建失败；[44031307452](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/actions/runs/44031307452) 调用了不存在的 `build-admin-host.cjs`。当前源码已改为实际存在的 `build-native-admin-host.cjs`，但不把历史红灯改称成功。
- 后续 [44036261098](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/actions/runs/44036261098)、[44058348812](https://github.com/Z7Y-CCCCC/heat-treatment-digital-twin/actions/runs/44058348812) 为 cancelled，没有成功的 package/publish-release 结果。

## 验证方法

`installer-preview.cjs` 共用生产界面和取消/失败处理，模拟 builder 在 section 开头关闭详情输出。失败场景通过真正的 `nsExec::ExecToLog` 执行只向 stdout 输出中文并返回 1603 的无副作用 fixture。`progress-cancel` 场景保留一个等待步骤，便于验收安装中的最小化与安全取消。

`tools/installer-preview-ui.ps1` 增加真实的采集选择页、非空详情、最小化状态、安装中关闭、中文错误日志和错误持续可见断言。源码测试另编译生产安装和卸载钩子，但从不执行这些 section。所有证据和预览 EXE 留在忽略的 `output` 或临时目录，不提交。

## 本轮结果

- 39 项默认模板、安装 UI、采集插件集成及运行库回归全部通过；另 2 项安装启动/上传门禁契约通过。含原生 C 编译、DPI/命中几何、生产安装与卸载钩子编译、PowerShell 解析、运行库只读检查及无签名文件拦截。
- 前端 2,200 项测试全部通过；固定模板门禁通过，SHA-256 仍为 `061cb3f233b4a9798f2bf10d31775f042497f74fa3c29a5ec15c2a0de1f28edc`。
- 使用 Windows Computer Use 实际操作无安装 fixture：去白边、安装中最小化/恢复、关闭后立即显示取消请求、到下一检查点安全停止、失败页持续保留、真实 nsExec 中文 stdout 及返回码 1603 完整保留在页面与 UTF-8 日志。未执行真实安装。
- `git diff --check` 通过。没有删除既有断言、跳过空包门禁或修改固定模板期望值放行。
- 本轮修改留在本地，未提交、推送、合并或发布。GitHub 上 PR #50 的五个检查成功只对应它原来的 `cf93fd2…` 提交，不冒充本轮未推送修改的远端结果。
