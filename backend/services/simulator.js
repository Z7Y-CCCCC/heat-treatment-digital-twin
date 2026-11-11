/**
 * simulator.js - 模拟数据生成器
 * 
 * 在没有真实 PLC 的情况下，按照和 PLC 读取完全一样的数据格式
 * 生成随机的模拟数据，供离线演示和功能调试使用。
 */

const { getDb } = require('../db/database');
const { readable, signature, pointPath, manualValue, automaticValue } = require('./simulationPoints');

const GAS_VALVE_KEYS = [
    'valve_1',
    'valve_2',
    'valve_3',
    'valve_4',
    'valve_5',
    'valve_6',
    'valve_7',
    'valve_8',
    'valve_9',
    'valve_10'
];

class Simulator {
    constructor(options = {}) {
        this.options = options;
        this.pollTimer = null;
        this.pollIntervalMs = 2000;
        this.onData = null;
        this.onStatusChange = null;
        this.devices = [];
        this.pointsByDevice = new Map();
        this.runVersion = 0;
        this.stopped = true;
        // 每台设备的持久状态（模拟真实运行时的渐变效果）
        this.deviceStates = Object.create(null);
        this.manualValues = new Map();
        this.tickCount = 0;
    }

    async start(onData, onStatusChange, { preserveState = false } = {}) {
        const runVersion = ++this.runVersion;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.stopped = false;
        this.onData = onData;
        this.onStatusChange = onStatusChange;

        // 从数据库加载设备列表
        const db = await getDb();
        if (this.stopped || runVersion !== this.runVersion) return;
        const factoryId = String(this.options.factoryId || 'factory_default');
        const workshops = await db.all('SELECT id FROM workshops WHERE factory_id = ?', [factoryId]);
        const workshopIds = new Set(workshops.map(row => String(row.id)));
        const lines = await db.all(`SELECT l.id FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id WHERE w.factory_id = ?`, [factoryId]);
        const lineIds = new Set(lines.map(row => String(row.id)));
        const devices = (await db.all('SELECT * FROM devices')).filter(device => {
            if (lineIds.has(String(device.line_id || ''))) return true;
            if (device.line_id) return false;
            let config = {};
            try { config = typeof device.instance_config === 'object' ? device.instance_config : JSON.parse(device.instance_config || '{}'); } catch { /* invalid legacy configuration */ }
            return workshopIds.has(String(config.workshop_id || config.workshopId || ''));
        });
        if (this.stopped || runVersion !== this.runVersion) return;
        const settingsRows = await db.all('SELECT * FROM settings');
        if (this.stopped || runVersion !== this.runVersion) return;
        this.devices = devices;
        const ownedIds = new Set(devices.map(device => String(device.id)));
        const points = (await db.all('SELECT * FROM data_points')).filter(point => ownedIds.has(String(point.device_id)) && readable(point));
        if (this.stopped || runVersion !== this.runVersion) return;
        this.pointsByDevice = new Map();
        for (const point of points) {
            const id = String(point.device_id), list = this.pointsByDevice.get(id) || [];
            list.push(point); this.pointsByDevice.set(id, list);
        }
        const factorySettings = await db.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', [factoryId]);
        if (this.stopped || runVersion !== this.runVersion) return;
        const previousStates = preserveState ? this.deviceStates : Object.create(null);
        this.deviceStates = Object.create(null);
        if (!preserveState) { this.manualValues.clear(); this.tickCount = 0; }
        const definitions = new Map(points.map(point => [String(point.id), signature(point)]));
        for (const [id, override] of this.manualValues) if (definitions.get(id) !== override.signature) this.manualValues.delete(id);

        // 为每台设备初始化模拟状态
        this.devices.forEach(device => {
            this.deviceStates[device.id] = previousStates[device.id] || {
                actual_temp: 820 + Math.random() * 60,       // 820-880°C
                setpoint_temp: 860,
                actual_carbon: 0.75 + Math.random() * 0.2,   // 0.75-0.95%
                setpoint_carbon: 0.85,
                fan_motor: true,
                rear_fan: true,
                front_fan: true,
                rear_fan_speed: 960 + Math.random() * 120,
                front_fan_speed: 720 + Math.random() * 100,
                stir_motor: true,
                oil_stir_1: true,
                oil_stir_2: true,
                oil_stir_3: true,
                oil_stir_4: true,
                oil_stir_1_speed: 520 + Math.random() * 80,
                oil_stir_2_speed: 520 + Math.random() * 80,
                oil_stir_3_speed: 520 + Math.random() * 80,
                oil_stir_4_speed: 520 + Math.random() * 80,
                oil_pump: Math.random() > 0.5,
                gas: this._createGasState(),
                front_door_open: false,
                middle_door_open: false,
                push_chain_forward: false,
                running: true,
                alarm: false,
                // 控制门/链的动画计数器
                doorCycle: Math.floor(Math.random() * 100),
                chainCycle: Math.floor(Math.random() * 100)
            };
        });

        console.log(`[Simulator] 已初始化 ${this.devices.length} 台设备的模拟数据`);
        if (this.onStatusChange) {
            this.onStatusChange({ status: 'simulating', message: `模拟运行中 (${this.devices.length} 台设备)`, timestamp: Date.now() });
        }

        // 读取轮询间隔
        const settings = {};
        settingsRows.forEach(r => { settings[r.key] = r.value; });
        factorySettings.forEach(r => { settings[r.key] = r.value; });
        const configuredInterval = Number(settings.simulation_interval_ms);
        const interval = Number.isFinite(configuredInterval) && configuredInterval >= 100 && configuredInterval <= 60000
            ? Math.round(configuredInterval)
            : 2000;
        this.pollIntervalMs = interval;

        // 开始模拟
        if (this.stopped || runVersion !== this.runVersion) return;
        this._tick();
        if (this.stopped || runVersion !== this.runVersion) return;
        this.pollTimer = setInterval(() => {
            if (!this.stopped && runVersion === this.runVersion) this._tick();
        }, interval);
    }

    stop() {
        this.stopped = true;
        this.runVersion += 1;
        this.manualValues.clear();
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        console.log('[Simulator] 已停止');
        if (this.onStatusChange) {
            this.onStatusChange({ status: 'stopped', message: '已停止', timestamp: Date.now() });
        }
    }

    async restart(onData, onStatusChange) {
        this.stop();
        await this.start(onData || this.onData, onStatusChange || this.onStatusChange);
    }

    async reloadConfiguration() {
        await this.start(this.onData, this.onStatusChange, { preserveState: true });
    }

    setPointValue(point, value, reset = false) {
        if (this.stopped) throw new Error('模拟运行已停止');
        const known = (this.pointsByDevice.get(String(point.device_id)) || []).find(row => String(row.id) === String(point.id));
        if (!known || signature(known) !== signature(point)) throw new Error('点位配置正在刷新，请稍后重试');
        pointPath(known);
        if (reset) this.manualValues.delete(String(point.id));
        else this.manualValues.set(String(point.id), { value: manualValue(known, value), signature: signature(known), updatedAt: Date.now() });
        this._tick();
        return { success: true, pointId: String(point.id), manual: !reset };
    }

    _tick() {
        if (this.stopped) return;
        this.tickCount++;
        const deviceDataArray = [];

        this.devices.forEach(device => {
            const state = this.deviceStates[device.id];
            if (!state) return;

            // 温度缓慢波动（在设定值附近 ±5°C 范围内做布朗运动）
            state.actual_temp += (Math.random() - 0.5) * 2;
            state.actual_temp = Math.max(state.setpoint_temp - 15, Math.min(state.setpoint_temp + 15, state.actual_temp));

            // 碳势缓慢波动
            state.actual_carbon += (Math.random() - 0.5) * 0.01;
            state.actual_carbon = Math.max(state.setpoint_carbon - 0.1, Math.min(state.setpoint_carbon + 0.1, state.actual_carbon));

            state.rear_fan_speed = this._wander(state.rear_fan_speed, 900, 1120, 10);
            state.front_fan_speed = this._wander(state.front_fan_speed, 650, 860, 8);
            for (let i = 1; i <= 4; i++) {
                state[`oil_stir_${i}_speed`] = this._wander(state[`oil_stir_${i}_speed`], 460, 640, 8);
            }

            // 门和链的周期性动作（模拟生产节拍）
            state.doorCycle++;
            state.chainCycle++;
            if (state.doorCycle % 30 === 0) {
                state.front_door_open = !state.front_door_open;
            }
            if (state.doorCycle % 45 === 0) {
                state.middle_door_open = !state.middle_door_open;
            }
            if (state.chainCycle % 60 === 0) {
                state.push_chain_forward = !state.push_chain_forward;
            }

            this._updateGasState(state);

            // 偶尔随机报警（每次 tick 有 0.5% 概率触发报警，持续约 10 秒）
            if (state.alarm && Date.now() >= (state.alarmUntil || 0)) state.alarm = false;
            if (Math.random() < 0.005) {
                state.alarm = true;
                state.alarmUntil = Date.now() + 10000;
            }

            deviceDataArray.push({
                furnace_id: device.id,
                sourceMode: 'simulation',
                furnace_name: device.name,
                timestamp: Date.now(),
                analog: {
                    actual_temp: parseFloat(state.actual_temp.toFixed(1)),
                    setpoint_temp: state.setpoint_temp,
                    actual_carbon: parseFloat(state.actual_carbon.toFixed(3)),
                    setpoint_carbon: state.setpoint_carbon
                },
                status: {
                    running: state.running,
                    alarm: state.alarm
                },
                motors: {
                    fan_motor: state.fan_motor,
                    rear_fan: state.rear_fan,
                    front_fan: state.front_fan,
                    rear_fan_speed: Math.round(state.rear_fan_speed),
                    front_fan_speed: Math.round(state.front_fan_speed),
                    stir_motor: state.stir_motor,
                    oil_stir_1: state.oil_stir_1,
                    oil_stir_2: state.oil_stir_2,
                    oil_stir_3: state.oil_stir_3,
                    oil_stir_4: state.oil_stir_4,
                    oil_stir_1_speed: Math.round(state.oil_stir_1_speed),
                    oil_stir_2_speed: Math.round(state.oil_stir_2_speed),
                    oil_stir_3_speed: Math.round(state.oil_stir_3_speed),
                    oil_stir_4_speed: Math.round(state.oil_stir_4_speed),
                    oil_pump: state.oil_pump
                },
                doors: {
                    front_door_open: state.front_door_open,
                    middle_door_open: state.middle_door_open
                },
                mechanisms: {
                    push_chain_forward: state.push_chain_forward
                },
                gas: this._gasPayload(state.gas),
                quality: {
                    analog: {
                        actual_temp: 'good',
                        setpoint_temp: 'good',
                        actual_carbon: 'good',
                        setpoint_carbon: 'good'
                    },
                    status: {
                        running: 'good',
                        alarm: 'good'
                    },
                    motors: {
                        fan_motor: 'good',
                        rear_fan: 'good',
                        front_fan: 'good',
                        rear_fan_speed: 'good',
                        front_fan_speed: 'good',
                        stir_motor: 'good',
                        oil_stir_1: 'good',
                        oil_stir_2: 'good',
                        oil_stir_3: 'good',
                        oil_stir_4: 'good',
                        oil_stir_1_speed: 'good',
                        oil_stir_2_speed: 'good',
                        oil_stir_3_speed: 'good',
                        oil_stir_4_speed: 'good',
                        oil_pump: 'good'
                    },
                    doors: {
                        front_door_open: 'good',
                        middle_door_open: 'good'
                    },
                    mechanisms: {
                        push_chain_forward: 'good'
                    },
                    gas: this._gasQualityPayload()
                },
                pointMeta: {
                    'analog.actual_temp': { label: '实际温度', unit: '°C', display_format: '0.0' },
                    'analog.setpoint_temp': { label: '设定温度', unit: '°C', display_format: '0' },
                    'analog.actual_carbon': { label: '实际碳势', unit: '%', display_format: '0.000' },
                    'analog.setpoint_carbon': { label: '设定碳势', unit: '%', display_format: '0.000' },
                    'status.running': { label: '运行状态', unit: '', display_format: '' },
                    'status.alarm': { label: '报警状态', unit: '', display_format: '' },
                    'motors.rear_fan_speed': { label: '后室风扇转速', unit: 'rpm', display_format: '0' },
                    'motors.front_fan_speed': { label: '前室风扇转速', unit: 'rpm', display_format: '0' },
                    'motors.oil_stir_1_speed': { label: '油搅拌1转速', unit: 'rpm', display_format: '0' },
                    'motors.oil_stir_2_speed': { label: '油搅拌2转速', unit: 'rpm', display_format: '0' },
                    'motors.oil_stir_3_speed': { label: '油搅拌3转速', unit: 'rpm', display_format: '0' },
                    'motors.oil_stir_4_speed': { label: '油搅拌4转速', unit: 'rpm', display_format: '0' }
                }
            });
            const frame = deviceDataArray[deviceDataArray.length - 1];
            frame.simulationPoints = Object.create(null);
            const builtinValues = new Map(Object.keys(frame.quality).flatMap(group => Object.entries(frame[group] || {}).map(([field, value]) => [`${group}.${field}`, value])));
            for (const point of this.pointsByDevice.get(String(device.id)) || []) {
                let path;
                try { path = pointPath(point); } catch { continue; }
                const { group, field } = path;
                const override = this.manualValues.get(String(point.id));
                const value = override ? override.value : automaticValue(point, builtinValues.get(`${group}.${field}`), this.tickCount, frame.timestamp);
                frame[group] ||= Object.create(null);
                frame.quality[group] ||= Object.create(null);
                frame[group][field] = value;
                frame.quality[group][field] = value === null ? 'bad' : 'good';
                frame.simulationPoints[String(point.id)] = { value, quality: value === null ? 'bad' : 'good', timestamp: frame.timestamp,
                    manual: !!override, overriddenAt: override?.updatedAt || null };
                const key = `${group}.${field}`;
                frame.pointMeta[key] = { ...frame.pointMeta[key], id:String(point.id), timestamp:frame.timestamp,
                    name:point.name, label:point.label || point.name, unit:point.unit || '', display_format:point.display_format || '',
                    category:group, field_name:field, plc_address:point.plc_tag || '', voice_config:point.voice_config || '',
                    sample_interval_ms:point.sample_interval_ms || this.pollIntervalMs, sourceMode:'simulation', simulationManual:!!override };
            }
        });

        if (this.onData && deviceDataArray.length > 0) {
            this.onData(deviceDataArray);
        }
    }

    _createGasState() {
        const gas = {};
        GAS_VALVE_KEYS.forEach((key, index) => {
            const on = index < 3 || Math.random() > 0.72;
            gas[`${key}_on`] = on;
            gas[`${key}_flow`] = on ? 8 + Math.random() * 38 : 0;
        });
        return gas;
    }

    _updateGasState(state) {
        GAS_VALVE_KEYS.forEach((key, index) => {
            if (state.doorCycle % (26 + index * 3) === 0 && index > 1) {
                state.gas[`${key}_on`] = !state.gas[`${key}_on`];
            }
            const target = state.gas[`${key}_on`] ? 8 + (index % 5) * 5 + Math.random() * 4 : 0;
            state.gas[`${key}_flow`] = this._approach(state.gas[`${key}_flow`], target, 1.5);
        });
    }

    _gasPayload(gas) {
        const payload = {};
        GAS_VALVE_KEYS.forEach((key) => {
            payload[`${key}_on`] = !!gas[`${key}_on`];
            payload[`${key}_flow`] = parseFloat(Number(gas[`${key}_flow`] || 0).toFixed(1));
        });
        return payload;
    }

    _gasQualityPayload() {
        const quality = {};
        GAS_VALVE_KEYS.forEach((key) => {
            quality[`${key}_on`] = 'good';
            quality[`${key}_flow`] = 'good';
        });
        return quality;
    }

    _wander(value, min, max, step) {
        const next = Number(value || min) + (Math.random() - 0.5) * step;
        return Math.max(min, Math.min(max, next));
    }

    _approach(value, target, step) {
        const current = Number(value || 0);
        if (Math.abs(current - target) <= step) return target;
        return current + Math.sign(target - current) * step;
    }
}

module.exports = Simulator;
