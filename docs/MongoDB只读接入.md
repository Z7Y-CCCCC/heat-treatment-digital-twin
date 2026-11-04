# MongoDB 只读接入

## 使用

1. 系统设置 → 数据连接与备份 → 外部数据源 → 新建 → MongoDB。
2. 填主机、端口（默认 27017）、业务数据库。认证页填只读账号、密码和认证数据库；留空认证数据库则使用业务库。
3. 新连接默认打开 TLS，校验证书，**不提供忽略证书**。仅明确为内网明文服务时关闭 TLS。主机不包含协议、账号或 URI 参数。
4. 测试并保存；数据预览 → 读取集合 → 选集合和字段 → 读取样例。
5. 数据集 → 新建 → 选此连接 → 填集合 → 参数与匹配选“当前设备”，标识字段例如 `deviceId` → 字段映射选 `telemetry.temperature` 等 → 保存。
6. 设计器数据来源选“外部数据集”，选上述数据集与输出列。总览可用已有多设备轮播；设备视角使用当前设备，按组件刷新周期读取。

数据库只授予需要的集合/业务库读取权限，不使用管理员账号作为大屏连接。用户账号/页面权限仍走既有后台授权；数据库凭据只在后台连接配置中，不放设计稿或发布组件里。

## 实际能力

- 原生 `mongodb` Node.js 驱动，不是同名卡片或 HTTP mock。
- 列出当前库授权集合/视图，屏蔽 `system.*`；不能通过 Schema 跨到其他数据库。
- 字段发现取前 50 条，最多 100 个字段、深度 5；稀疏字段/空集合可在数据集中手填路径。嵌套路径如 `telemetry.temperature`、`["工艺"]["温度"]`。
- 数据集在服务端做当前设备/部件/产线/全局参数的单字段等值匹配，**不是只下载前 100 条再筛选目标设备**。匹配取最多 2 条以检测重复，未匹配不伪造 0。
- 不匹配对象时最多读 100 条；可选排序。已有数据库直绑预览支持 list、count、sum、avg、min、max；聚合使用固定只读流水线，不能提交任意 MongoDB 脚本。
- 查询用投影只读所需字段；父子路径一起选不会产生投影冲突。零、false 保留，日期输出 ISO 字符串；超出安全范围的 Long 和 Decimal 按字符串保留精度。
- 整个读取过程有 AbortSignal 截止时间，同时配置连接/服务选择/socket 超时与服务端 maxTimeMS。结果最多 256 KB，游标 batchSize 为 1，结束/异常均关闭游标及客户端。不是常驻全库订阅或历史采集。
- 账号密码用原有掩码保留规则，切换数据库驱动不转发旧驱动的凭据。失败不输出原始服务器异常/密码。
- 不发设备控制/写库命令。MongoDB 不参加现有 SQL dump/自动数据库备份；整站备份保存连接配置，不表示备份了外部 MongoDB 的业务数据。

## 未包含

- SRV 发现、粘贴完整 URI、多地址手动列表、X.509/客户端证书、Kerberos；本批使用主机/端口、SCRAM 账号和可选 TLS。
- 任意 SQL/MQL/JavaScript、`$where`、自定义 aggregate、写操作或存储过程。
- JSON 路径中的数组下标、MongoDB 字面键名含点/美元符；复杂数组/二进制建议在上游只读视图展开/转换。
- 真实客户库的索引、读延迟/负载、集群切换、私有 CA 与全 Windows 版本验收。TLS 不降级已经负测，不将它写成所有证书环境均已实测。

## 本轮证据

- 本机真实 MongoDB **8.0.34**，启用认证，实际 `read` 角色与拒绝写入。
- `backend/scripts/mongo-data-source-integration-test.cjs`：测试/保存/掩码、集合与字段、超过前 100 条的设备匹配、零/布尔/日期/Long/Decimal、投影、全局参数、重复/缺失、聚合与隔离、操作符拒绝、错密码、TLS 不降级、黑洞握手与数据库退出/重开。
- 查询本机自有 MongoDB profiler，确认适配器没有 insert/update/delete/drop/createUser 或 `$out/$merge`。
- `tools/mongo-data-source-ui-test.cjs`：真正工作台建立连接和数据集，通过正常保存/发布进入实际 Vue overlay，设备切换及数据库 888.5 → 999.5 后刷新。宿主消息桥为夹具，测试背景为纯色；没有声称这是 Unity 三维画面的实机验收。
- GitHub 后端质量任务使用官方 `mongo:8.0.34`、固定镜像摘要与独立数据库/只读用户重复验收，结束即销毁容器。不部署到现场。

本机官方 ZIP 完整 SHA-256：`6b021a0864494e4decf278b36477a29eb36072432773e4e62c2f42c302630db0`；`mongod.exe` SHA-256：`4c9e9764cbac5be8eb92733e23ce7f70b52f8ae84b6879b4d5cc010c90ec6082`。ZIP 中的程序没有 Authenticode 签名，因此校验了完整官方归档，而不是把未签名说成签名有效。测试服务器/数据库/截图只在忽略的 `output/`，不进入 Git 或客户安装包。

### 重跑

```powershell
# 已核对来源的官方 mongod，独立输出目录；不安装系统服务。
$env:MONGOD_TEST_EXECUTABLE = 'VERIFIED_MONGOD_PATH'
node backend/scripts/mongo-data-source-integration-test.cjs
# UI 测试还需 Playwright、Chromium 及已构建的 frontend/dist。
node tools/mongo-data-source-ui-test.cjs
```

也可使用明确标为可丢弃的回环 CI 数据库；需 `MONGODB_TEST_URI`、`MONGODB_TEST_DISPOSABLE=true` 及对应管理账号环境变量。只创建和清理随机命名的 `dt_fixture_*` 测试库，不接受远程生产地址。

依据：[MongoDB Node.js 连接选项](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/)、[官方 Windows ZIP](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-windows-zip/)、[GitHub service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers)。以已锁定驱动源码和实际测试为准；本版本不使用已废弃无效的 timeoutMS，而使用 AbortSignal 和实际有效的超时选项。
