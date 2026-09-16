# Web HUD 透明承载与排版修复

本次修改已编译并更新到本地 Unity 客户端使用的前端及 AdminHost。按用户要求，不再使用 Computer Use 进行逐项视觉验收；最终外观与实际点击交互由用户检查。

## 修改范围

- `native-admin-host/DashboardOverlayForm.cs`：用 WebView2 CompositionController 和 DirectComposition 替换普通 WinForms WebView2 背景承载，保留网页 Alpha；不再绘制实心宿主底板。补齐鼠标点击、双击、滚轮、光标和 Escape 传递。
- `native-admin-host/OverlayCompositionSurface.cs`：无重定向位图的 GPU 合成窗口与 COM 资源生命周期。未新增第三方运行时依赖。
- `native-admin-host/OverlayInteractionGeometry.cs`：组件区域只负责鼠标命中，边缘向外取整保留细边框；中心区域继续交给 Unity。
- `frontend/src/runtime/hudWidgets.css`、`WidgetRenderer.vue`：修正把品牌/KPI 类判断写在外层容器上的选择器错误；标题与副标题分行，KPI 数值和单位分开排版，统一组件标题、细边线和蓝紫色调。
- `frontend/src/runtime/hudPresentation.js`、`DashboardOverlay.vue`：参考总览按设计器的原始画布等比缩放，让字体、图表与组件尺寸同步缩放。自定义文档和设备详情不强套参考总览缩放。
- 设计器和后台预览仍共用 WidgetRenderer/HUD 样式。未修改 Unity 模型、设备数据绑定、数据库配置或后端逻辑。

## 验证结果

- 组件、布局、KPI 与缩放回归：14/14 通过。
- 原生合成、100/125/150/200% DPI 区域、无效坐标、中心鼠标穿透边界及资源释放检查：14/14 通过。合成 API 检查使用不可见测试窗口，不操作用户窗口。
- 前端完整测试：105/106 通过。失败项是未在本次修改的 `frontend/tests/admin-composables.test.mjs:41`，该用例读取未定义的 `settings.runtimeStatus.clients`；本次没有扩展修改后台设置逻辑。
- Vite 生产构建及 .NET Release publish 通过；Vite 仍报告已有的大 chunk 警告。
- 已确认安装目录的宿主 DLL 与本次 publish 产物 SHA256 一致，3001 返回的 HTML 与本地 dist 一致。
- 当前 Unity 未重新构建或重启，仅重载 Web 宿主。最终透明观感、参考图接近程度与实际交互尚待用户验收。

## 重跑验证

在项目根目录运行：

```powershell
dotnet run --project tools/native-overlay-tests/NativeOverlayTests.csproj --configuration Release
```

在 `frontend` 目录运行：

```powershell
node --experimental-test-module-mocks --test tests/widget-renderer.test.mjs tests/reference-hud-layout.test.mjs tests/hud-presentation.test.mjs
npm run build
```

`OverlayPresentationDiagnostics` 默认关闭。只有显式提供 `DIGITAL_TWIN_OVERLAY_DIAGNOSTICS_DIR` 时，才保存一次启动时的计算样式与网页 Alpha PNG，用于区分网页绘制问题和宿主合成问题；不会持续截图。

原始宿主二进制备份保留在 `tmp/overlay-host-before-750d598237464a41ad866151e0571d4c`。没有执行 Git 回退、覆盖其他工作区修改或删除用户文件。
