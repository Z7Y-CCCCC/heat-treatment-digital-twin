# 实时展示启动与后台登录分离

## Ethan 确认的边界（2026-11-16）

启动直接进入只读实时大屏，不应因后台未登录、已锁定或尚未设置后台密码而停在 0%。后台管理仍按原账号、密码和页面权限解锁；免登录展示不等于免登录修改配置。许可证激活、现场数据读取权限和管理操作校验不能关闭。

本次现场观察：8:49 启动后仍等待后台会话交接，8:51 授权后继续加载 9 台设备，场景最终就绪。用户指出这个等待不应依赖输入用户名密码。不能把“等待后台解锁”伪装成正在读取现场配置，也不能靠计时器把百分比推到 100%。

## 实现

- 新增本机同源 `POST /api/admin-auth/display-bootstrap`，仅在许可允许时签发独立的 HttpOnly/SameSite 只读展示 Cookie。不会创建管理员或现场账户，不设置默认密码，不修改账户配置。
- 展示身份只授予 `view` / `launch`，始终 `authenticated: false`，无编辑、用户管理、备份、投屏或后台页面权限；不写入持久化的工程师会话记录。
- `POST /native-display-ticket` 通过单次票据把只读身份交给 Unity，保留 CSRF、30 秒有效期、精确父子会话绑定与容量限制。传统管理员重连票据的鉴权规则不变。
- Native API 客户端明确识别 `displayAuthenticated + displayOnly`，不要求把只读展示身份错误标成管理员已登录。
- RootApp 在原生后台窗口初始化展示会话，并报告 `display_access_ready`。宿主等待真实展示授权准备完成，再决定显示大屏；慢服务超时后若迟到的有效确认到达，仍自动回到大屏，无需密码。用户明确切入后台时，不抢走其操作界面。
- 新界面连接尚未更新的旧服务时，保留旧票据与登录入口，不在未获批更新服务时把混合版本困在 0% 遮罩后。该兼容入口不冒充新功能已经启用。
- 后台登录继续使用原账号 Cookie。显示身份不混入用户名历史；后台退出不会把独立展示身份升级成管理员。

## 验证

- 独立新数据库、新浏览器配置目录、真实 Unity Development 客户端、真实 WebView2 与网关：不调用 setup/login，不预植 Cookie，不输入密码，20 台隔离模拟设备场景自动就绪，加载遮罩正常结束。
- 点击后台管理后，设置／输入后台密码的入口仍可见；只读展示身份提交配置写入得到 401。
- 增加浏览器会话响应延迟的实机回归，确实经过宿主 12 秒等待超时，再收到迟到的有效确认后自动进入展示。不是修改超时断言或绕过场景就绪门禁。
- 校验管理员锁定、退出、服务重启、展示过期后仍无管理权限；校验 CSRF、同源限制、一次性票据和未知身份拒绝。
- 原生运行时 56/56、前端全量 2116/2116、原有账号和页面权限回归、固定出厂模板一致性及 6 项回归均通过。最终慢启动实机验收通过且测试自建进程均已结束。

隔离验收入口：

```powershell
node --test backend/scripts/display-bootstrap-test.cjs backend/scripts/native-connection-confirm-test.cjs
node --experimental-test-module-mocks --test --test-concurrency=2 frontend/tests/*.test.mjs
node tools/native-display-autostart-test.cjs --stage STAGE_DIRECTORY
node tools/native-display-autostart-test.cjs --stage STAGE_DIRECTORY --slow-startup
```

`STAGE_DIRECTORY` 必须位于忽略的工作区 `output` 中，包含当前源码的前端、Unity 测试客户端和 Debug 后台宿主。验收使用新建隔离库和模拟数据，只结束自己创建的进程，不连接现场 PLC、不读取现场账户、不生成安装包。

## 当前交付状态

Ethan 明确选择 **先完成修复与验证，暂不重启数据服务**。因此本轮未更新或重启本机正在运行的数据服务，也未替换正在使用的大屏、前端资源或后台宿主。新功能仍待后续按统一版本更新服务、界面、Unity 和宿主后启用。

不得把隔离验收通过描述成现场已经启用免登录展示；不得只更新界面就宣称整个启动流程已交付。此次没有授权打包或修改固定出厂画面基线。
