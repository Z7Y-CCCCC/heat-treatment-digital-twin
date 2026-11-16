# 统一模型资产导入工具

保留模型管理、拆解布局、动作动画三个独立页面、原导航及各页权限。只将资产导入、导出、补充和历史工具集中到模型管理顶部；三个页面读取同一份模型资产，不复制数据，不在启动时迁移或改写资产。

## 入口

- 导入：完整模型资产 ZIP（兼容原动作包及合集），或单独 GLB/GLTF。裸模型不生成拆解或动作。
- 导出：完整资产、选定动作或拆解配置；导出已保存内容。
- 补充：明确现有目标模型和更新模块，检查差异后确认。模型文件默认不替换。
- 历史：检查资产版本并显式回退；回退前再次核对最新版本。

四个入口使用带 `title` 和 `aria-label` 的 SVG 图标。三个原页面及其编辑功能保持独立，必要的确认/冲突信息保留短文字。

## 更新边界

- 动作按稳定 ID 新增或更新；同 ID 替换必须确认，未选择的旧动作保留。
- 拆解部件按稳定 ID 合并；未提供的部件、字段和其他模块保留。
- 替换模型文件必须显式选择，并检查节点、动作和现有拆解引用兼容性。
- 版本快照保存资产模块，不保存现场设备、PLC 点位或账户；完整导出不携带内部版本路径。
- 设备实例、专属拆解覆盖、PLC 点位、料口及现场联动不随补充或回退重置。
- 预检与确认之间目标发生变化必须重新检查；失败保留原数据。
- 原模型层拆解编辑、实时设备绑定和设备联动编辑继续使用原来的窄范围保存接口。

## 接口

`POST /api/models/asset-inspect`、`asset-import` 的 multipart `updateOptions` 指定 `targetId`、`modules`、可选 `actionIds`、`replaceActionIds`；补充导入另提交服务器预检返回的 `updatePlan` 与文件 SHA-256。

`POST /api/models/asset-export` 支持 `modelIds`、可选 `modules`、`actionIds`。旧完整包 API 保持兼容；补充包禁止按新模型误导入。

`GET /api/models/:id/asset-history` 返回资产版本及当前修订；`POST /api/models/:id/asset-history/:versionId/restore` 必须提交当前 `revision`。

验收：`node tools/model-asset-workspace-ui-test.cjs`，使用 `UI_FRONTEND_DIST` 指向新建隔离前端产物，仅创建隔离测试工厂、数据库及上传目录。此操作不是发行打包，也不更新只读出厂画面模板。
