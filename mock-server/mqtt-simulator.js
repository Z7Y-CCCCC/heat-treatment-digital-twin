const DEFAULT_BROKER_URL = 'mqtt://localhost:1883';
const DEFAULT_TOPIC = 'factory/Line1/realtime';

function readConfig(options = {}, environment = process.env) {
    const brokerUrl = String(options.brokerUrl ?? environment.MQTT_BROKER_URL ?? DEFAULT_BROKER_URL).trim();
    let broker;
    try { broker = new URL(brokerUrl); }
    catch (_) { throw new Error('MQTT_BROKER_URL 必须是完整的 MQTT 或 WebSocket 地址'); }
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(broker.protocol) || !broker.hostname || broker.hash) {
        throw new Error('MQTT_BROKER_URL 仅支持 mqtt://、mqtts://、ws:// 或 wss://');
    }
    const topic = String(options.topic ?? environment.MQTT_TOPIC ?? DEFAULT_TOPIC).trim();
    if (!topic || /[+#\x00-\x1f\x7f]/.test(topic) || Buffer.byteLength(topic, 'utf8') > 65535) {
        throw new Error('MQTT_TOPIC 必须是非空发布主题，不能包含通配符或控制字符');
    }
    const intervalMs = Number(options.intervalMs ?? environment.MQTT_INTERVAL_MS ?? 2000);
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) {
        throw new Error('MQTT_INTERVAL_MS 必须是 100-60000 毫秒之间的整数');
    }
    return { brokerUrl, topic, intervalMs, displayBroker: `${broker.protocol}//${broker.host}${broker.pathname}` };
}

function createFurnaces(random = Math.random) {
    return Array.from({ length: 20 }, (_, index) => ({
        id: `Furnace_${String(index + 1).padStart(2, '0')}`,
        name: `${index + 1}#多用炉`,
        baseTemp: 840 + random() * 20,
        baseCarbon: 0.8 + random() * 0.1
    }));
}

function createPayload(furnace, now = Date.now(), random = Math.random) {
    return {
        timestamp: now,
        furnace_id: furnace.id,
        furnace_name: furnace.name,
        analog: {
            actual_temp: (furnace.baseTemp - 10 + random() * 20).toFixed(1),
            setpoint_temp: furnace.baseTemp,
            actual_carbon: (furnace.baseCarbon - 0.05 + random() * 0.1).toFixed(2),
            setpoint_carbon: furnace.baseCarbon
        },
        motors: { stir_motor: random() > 0.1, fan_motor: random() > 0.1, oil_pump: random() > 0.5 },
        mechanisms: {
            push_chain_forward: Math.floor(now / 10000) % 2 === 0,
            push_chain_backward: Math.floor(now / 10000) % 2 !== 0
        },
        doors: {
            front_door_closed: Math.floor(now / 15000) % 2 === 0,
            front_door_open: Math.floor(now / 15000) % 2 !== 0,
            middle_door_closed: true,
            middle_door_open: false
        },
        status: { running: true, alarm: random() > 0.85, alarm_code: 0, alarm_msg: '' }
    };
}

function startSimulator(options = {}, dependencies = {}) {
    const config = readConfig(options, dependencies.environment ?? process.env);
    const mqtt = dependencies.mqtt || require('mqtt');
    const clock = dependencies.clock || { setTimeout, clearTimeout, now: Date.now };
    const signals = dependencies.signals || process;
    const logger = dependencies.logger || console;
    const random = dependencies.random || Math.random;
    const furnaces = options.furnaces || createFurnaces(random);
    if (!Array.isArray(furnaces) || furnaces.length === 0) throw new Error('模拟设备列表不能为空');

    const client = mqtt.connect(config.brokerUrl, {
        clean: true,
        queueQoSZero: false,
        reconnectPeriod: 1000,
        connectTimeout: 10000
    });
    let timer = null;
    let generation = 0;
    let cursor = 0;
    let connectedSession = false;
    let stopping = false;
    let closed = false;
    let stopPromise = null;
    const spacingMs = Math.max(1, Math.floor(config.intervalMs / furnaces.length));

    function cancelSchedule() {
        generation += 1;
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
    }

    function canPublish(version) {
        return !stopping && connectedSession && client.connected && version === generation;
    }

    function publishNext(version) {
        if (!canPublish(version)) return;
        const furnace = furnaces[cursor];
        cursor = (cursor + 1) % furnaces.length;
        try {
            const payload = createPayload(furnace, clock.now(), random);
            client.publish(config.topic, JSON.stringify(payload), { qos: 0, retain: false }, error => {
                if (error && canPublish(version)) logger.error(`MQTT 发布失败: ${error.message}`);
            });
        } catch (error) {
            if (!stopping) logger.error(`MQTT 发布失败: ${error.message}`);
        }
        if (!canPublish(version)) return;
        timer = clock.setTimeout(() => {
            if (version !== generation) return;
            timer = null;
            if (!canPublish(version)) { onDisconnect(); return; }
            publishNext(version);
        }, spacingMs);
    }

    function onConnect() {
        if (stopping || connectedSession) return;
        cancelSchedule();
        connectedSession = true;
        cursor = 0;
        logger.log(`MQTT 已连接 ${config.displayBroker}，主题 ${config.topic}`);
        publishNext(generation);
    }

    function onDisconnect() {
        connectedSession = false;
        cancelSchedule();
    }

    function onError(error) {
        if (!stopping) logger.error(`MQTT 连接错误: ${error.message}`);
    }

    function stop() {
        if (stopPromise) return stopPromise;
        stopping = true;
        onDisconnect();
        let finishStop;
        stopPromise = new Promise(resolve => { finishStop = resolve; });
        let closeTimer = null;
        const destroyStream = () => {
            try { client.stream?.destroy(); }
            catch (error) { logger.error(`MQTT 连接清理失败: ${error.message}`); }
        };
        const finish = () => {
            if (closed) return;
            closed = true;
            if (closeTimer !== null) clock.clearTimeout(closeTimer);
            client.removeListener('connect', onConnect);
            for (const event of ['offline', 'close', 'disconnect', 'reconnect']) client.removeListener(event, onDisconnect);
            client.removeListener('error', onError);
            signals.removeListener('SIGINT', onSignal);
            signals.removeListener('SIGTERM', onSignal);
            finishStop();
        };
        closeTimer = clock.setTimeout(() => {
            destroyStream();
            finish();
        }, 2000);
        closeTimer.unref?.();
        try { client.end(true, finish); }
        catch (error) {
            logger.error(`MQTT 关闭失败: ${error.message}`);
            destroyStream();
            finish();
        }
        return stopPromise;
    }

    function onSignal() { stop().catch(error => logger.error(`MQTT 关闭失败: ${error.message}`)); }

    client.on('connect', onConnect);
    for (const event of ['offline', 'close', 'disconnect', 'reconnect']) client.on(event, onDisconnect);
    client.on('error', onError);
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    logger.log(`正在连接本地/指定 MQTT 服务器 ${config.displayBroker}...`);
    if (client.connected) onConnect();

    return {
        stop,
        getStatus: () => ({ connected: !stopping && connectedSession && !!client.connected, scheduled: timer !== null, stopping, closed })
    };
}

if (require.main === module) {
    try { startSimulator(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { readConfig, createFurnaces, createPayload, startSimulator };
