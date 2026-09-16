# MQTT 模拟辅助脚本

此目录是独立测试工具，不会随主后端自动启动，也不会向真实 PLC 写入。
需要 Node.js 22.12.0 或更新版本，以及自行准备的 MQTT broker。

```powershell
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm start
```

默认只连接 `mqtt://localhost:1883`，发布主题为 `factory/Line1/realtime`。
不会自动连接公共测试服务器。连接不存在时仅尝试重连，不生成离线消息积压。
如需连接已获授权的局域网测试 broker，可显式配置：

```powershell
$env:MQTT_BROKER_URL = 'mqtt://192.168.1.100:1883'
$env:MQTT_TOPIC = 'test/factory/Line1/realtime'
$env:MQTT_INTERVAL_MS = '2000'
npm start
```

`MQTT_INTERVAL_MS` 是一轮 20 台模拟设备的周期，支持 100-60000 毫秒。
采用单一定时器均匀发送 QoS 0、非 retained 消息；断线取消发送，重连后只启动一份调度器。
按 Ctrl+C 或发送 SIGTERM 会取消定时器并关闭 MQTT 连接。

`npm test` 使用假 MQTT 客户端与假时钟，同时禁止 TCP 连接，不需要 broker、不会联网。
测试结果保存在仓库 `output/mqtt-simulator-*` 独立目录。
