# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).

## 本地验证

使用 Node.js 22 LTS（至少 22.12.0）。在本目录执行 `npm ci`，然后执行：

- `npm test`：认证会话、异步请求、点位编辑/保存、实时数据、场景资源和真实 Vue 组件渲染回归。
- `npm run build`：生产构建。
- `npm audit --registry=https://registry.npmjs.org`：依赖漏洞检查（部分镜像不支持 audit）。

回归测试使用模拟 HTTP、WebSocket、音频和三维渲染资源，不启动后端、不连接现场 PLC、不读写业务数据库。Node 的 module mocks / mock timers 目前会输出实验性 API 提示；测试依然必须全部通过。真实 WebGL 显示、WebView2 叠层、电视投屏和 PLC 现场链路仍需在对应环境验收。
