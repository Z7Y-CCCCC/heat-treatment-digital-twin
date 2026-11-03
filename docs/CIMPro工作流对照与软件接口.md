# CIMPro 工作流对照：参数联动与软件接口

## 本次参考了什么

核对的是官网公开交互和接口文档，重新实现适合本项目的功能，不引入其商业程序、私有源码或商标素材。

| 官方公开流程 | 在本项目的落点 |
| --- | --- |
| [UI API](https://cloud-docs.picimos.com/piutils)：读取/更新全局参数、页面导航、组件显隐 | 设计器“接口与参数”，类型化参数、筛选控件、页面交互动作 |
| [SDK 开发指南](https://cloud-docs.picimos.com/sdk)：等待就绪、发送指令、监听和解绑回调 | `window.DigitalTwin`；就绪等待、当前工厂目标校验、视角/设备/参数回调与卸载清理 |
| 同一份参数被多个组件使用 | 数据集请求 Query/Path/Body/Header、记录匹配，以及文本/图表/数值组件共同取数 |

此次没有把官网的全部 API、视频协议或第三方数据库驱动宣称为已实现。此前的数据连接、字段解析、可复用数据集继续复用，不另造一套连接配置。

## 操作路径

1. **组件配置 → 大屏设计器 → 接口与参数 → 全局参数**：添加 `batch`，类型“文本”，默认 `A`；应用到草稿。
2. **系统设置 → 数据连接与备份 → 外部数据源 → 数据集**：选择已有连接，配置输出字段；在“参数与匹配”中把请求参数的来源选为“全局参数”，标识填写 `batch`。数据库也可按全局参数精确匹配记录，使用参数化 WHERE，不拼接 SQL。
3. 回到设计器，添加 **参数筛选**，关联 `batch`，配置 A/B 等选项；支持下拉、文本、数值、日期和勾选。
4. 数值、文本或图表仍选择 **数据来源 → 数据集 → 字段**，不用逐个重复配置接口。
5. 保存草稿并发布；实际地图画面和 Unity 的 WebView 叠加组件都会使用发布的参数定义。运行时筛选只更新本次画面的值，不改发布默认值、不重新构建 Unity 场景。

文本中可用 `{parameters.batch}`；运行时数据路径也支持 `parameters.batch`。这些是取值，不是脚本执行。

## 软件接口

在大屏当前页面的同一窗口中调用；后台设计器不占用这个全局对象。“软件接口”标签中的运行按钮调用设计器自身的真实预览实例，不控制正在使用的现场大屏。

```javascript
const twin = window.DigitalTwin;
if (!twin) throw new Error('当前不是大屏运行页面');
await twin.ready();

await twin.setParameters({ batch: 'B', minimum: 0 });
const values = await twin.getParameters();
const context = await twin.getContext();

const unsubscribe = twin.on('deviceSelected', ({ deviceId }) => {
  console.log('当前设备', deviceId);
});
// 集成页面卸载时调用
unsubscribe();
```

| 方法 | 作用 |
| --- | --- |
| `ready()` | 等待当前画面就绪，最长 10 秒；未就绪/无权访问/实例卸载时拒绝。Unity 叠加页还等待原生场景就绪，而非只检查网页存在 |
| `getContext()` | 返回工厂、场景、视角、车间、产线、设备、部件 ID，不返回认证信息 |
| `getParameters()` / `setParameters(patch)` / `resetParameters()` | 读取、原子更新、恢复发布默认值；拒绝未定义或无效的值 |
| `refreshData()` | 重新读取当前组件外部数据 |
| `switchView(id)` / `focusDevice(id)` | 复用现有视角导航；设备必须属于当前工厂，隐藏/不存在视角拒绝。Unity 导航等待原生确认，失败不是假成功 |
| `setVisible(widgetId, boolean)` | 当前组件显隐，不修改服务端发布文档 |
| `on(name, callback)` / `off(name, callback)` | 注册/解绑事件；`on` 也返回取消函数 |

事件：`ready`、`contextChanged`、`viewChanged`、`deviceSelected`、`parametersChanged`、`widgetAction`。移动鼠标/悬停位置不会重复触发视角和设备选择事件。完整类型在 `frontend/src/runtime/digitalTwin.d.ts`。

地图页只支持已有地图层级导航；需要设备定位时先进入工厂场景。本次不提供跨域 iframe 通用 RPC、任意脚本执行、PLC 写入或绕过登录的控制口。其他系统的业务读取仍走已配置且经权限校验的后台连接；不向浏览器下发数据库密码。

## 保存、隔离与边界

- 每个文档最多 32 个参数，标识最长 40，选项最多 100，类型为文本/数值/布尔/日期；保留 `0`、`false`，无效日期/数值不转成正常读数。
- 单个文本最多 1000 字符，运行参数整体 URL 编码后不超过 8192 字符。认证信息放数据连接，不放大屏参数。
- 参数定义随草稿、发布快照和模板保存。切换工厂、场景、发布版本或账户会恢复该范围的默认值，不把上一工厂的筛选带到新工厂。
- 请求包含参数上下文并延续序号/中止保护；慢响应不能覆盖新筛选的数据；复用现有缓存、并发限制和错误质量标记。
- 软件接口访问同样受当前账户和画面就绪状态约束；未知组件、外厂设备、未定义参数拒绝；实例卸载释放监听，并且不把已经卸载的旧接口恢复到窗口。
- 没有新增常驻服务、第三方 SDK 依赖或桌面壳。

## 验收

`tools/cimpro-integration-ui-test.cjs` 启动独立后台、临时数据库、本地 ERP 读取接口和浏览器，检查：

- 在真实设计器中添加参数并保存；发布后运行页读取同一份定义。
- A/B 参数分别得到 0/850；下拉、软件调用和回调同步。
- SLOW/FAST 快速切换后保留最新 900，不被晚到的 100 覆盖；不导航/重载大屏。
- 软件接口面板实际刷新设计器内的数据集组件，非固定示例结果。
- 格式错误、未声明参数和外厂目标拒绝；刷新恢复发布默认值。

自动化另覆盖模板、类型校验、同值不重复刷新、工厂/账户隔离、无权调用、API 卸载和事件取消。界面以浅色标签切换和紧凑列表实现，关闭仅通过明确的 × 或 Esc，不点击遮罩关闭。

本次只验证源码、隔离运行时和页面，不验证安装包、不重启操作员大屏、不连接现场 PLC。


复现入口：

```powershell
npm --prefix frontend test
npm --prefix frontend run build
node backend/scripts/data-set-test.cjs
# 需本机 Playwright 和 Chromium（通过 PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE 指定）
node tools/cimpro-integration-ui-test.cjs
node tools/data-set-workflow-ui-test.cjs
```

复查中也修正了数据集列表异步加载时下拉框短暂空白的问题：读取期间保留既有数据集/字段，旧列表响应不能覆盖新列表；不改动用户保存的绑定。

2026-11-03 复验：前端 544/544、相关后台 11 组、新工作流 UI 6 项、既有数据集 UI 4 项通过；前端构建与仓库卫生检查通过。
