const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const {
    defaultPortForProtocol,
    getProtocolDefinition,
    normalizePlcOptions,
    normalizeProtocol,
    sanitizePlcOptions
} = require('../services/plcProtocolConfig');
const {
    assertDeletionConfirmation,
    getDeviceDeletionImpact,
    publicDeletionImpact
} = require('../services/deletionImpact');

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

function boolWithDefault(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const text = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(text) ? 1 : 0;
}

function stringifyJson(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value || {});
}

function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return {};
    }
}

function normalizeProtocolValue(value) {
    const protocol = normalizeProtocol(value || 'S7');
    if (!getProtocolDefinition(protocol)) throw new Error(`不支持的 PLC 协议：${protocol}`);
    return protocol;
}

function normalizePlcOptionsValue(protocol, value, existingValue = {}) {
    return JSON.stringify(normalizePlcOptions(protocol, value, existingValue));
}

function publicDevice(device) {
    if (!device) return device;
    const protocol = normalizeProtocol(device.plc_protocol || 'S7');
    return {
        ...device,
        plc_protocol: protocol,
        plc_options: sanitizePlcOptions(protocol, device.plc_options)
    };
}

function isAuxiliaryDevice(modelType, instanceConfig) {
    const config = parseJson(instanceConfig);
    return modelType === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

function restartDataEngineSoon(reason) {
    if (!global.dataEngine?.restart) return;
    setTimeout(() => {
        global.dataEngine.restart().catch(e => {
            console.warn(`[Devices] 数据引擎重启失败(${reason}):`, e.message);
        });
    }, 80);
}

// 设备实例配置（尤其是移动设备的路径配置）保存后，直接推送给 Unity。
// 这样不需要等待下一次配置轮询，也不需要重建整套场景。
function broadcastDeviceConfigurationChanged(deviceId, instanceConfig) {
    if (!global.wsServer?.broadcast || !deviceId) return;
    global.wsServer.broadcast('device_configuration_changed', {
        deviceId: String(deviceId),
        instanceConfig: parseJson(instanceConfig),
        timestamp: Date.now()
    });
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const { line_id } = req.query;
        const devices = line_id
            ? await db.all('SELECT * FROM devices WHERE line_id = ? ORDER BY sort_order ASC', [line_id])
            : await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        res.json(devices.map(publicDevice));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/deletion-impact', async (req, res) => {
    try {
        const impact = await getDeviceDeletionImpact(await getDb(), req.params.id);
        if (!impact) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });
        res.json(publicDeletionImpact(impact));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!device) return res.status(404).json({ error: '设备不存在' });

        const dataPoints = await db.all('SELECT * FROM data_points WHERE device_id = ?', [req.params.id]);
        res.json({ ...publicDevice(device), dataPoints });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const {
        id, name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries, plc_options
    } = req.body;
    const nextModelType = model_type || 'builtin_furnace';
    if (!id || !name) {
        return res.status(400).json({ error: '设备ID和名称不能为空' });
    }
    if (!isAuxiliaryDevice(nextModelType, instance_config) && !line_id) {
        return res.status(400).json({ error: '普通设备必须选择所属产线' });
    }
    try {
        const db = await getDb();
        const protocol = normalizeProtocolValue(plc_protocol || 'S7');
        const normalizedOptions = normalizePlcOptionsValue(protocol, plc_options);
        await db.run(`INSERT INTO devices (
            id, name, line_id, model_type, model_file, template_id, instance_config,
            pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
            plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
            plc_timeout, plc_retry_interval, plc_max_retries, plc_options
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
        )`, [
            id,
            name,
            line_id || null,
            nextModelType,
            model_file || null,
            template_id || '',
            stringifyJson(instance_config),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            ['line_local', 'workshop_local'].includes(coordinate_space)
                ? coordinate_space
                : (line_id ? 'line_local' : 'workshop_local'),
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            protocol,
            plc_ip || '',
            numberWithDefault(plc_port, defaultPortForProtocol(protocol)),
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0),
            normalizedOptions
        ]);
        restartDataEngineSoon('create device');
        broadcastDeviceConfigurationChanged(id, instance_config);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const {
        name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries, plc_options
    } = req.body;
    if (!name) return res.status(400).json({ error: '设备名称不能为空' });
    try {
        const db = await getDb();
        const existing = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });
        const nextLineId = line_id === undefined ? existing.line_id : (line_id || null);
        const nextModelType = model_type ?? existing.model_type;
        const nextInstanceConfig = instance_config ?? existing.instance_config;
        const nextProtocol = normalizeProtocolValue(plc_protocol ?? existing.plc_protocol ?? 'S7');
        const nextPlcOptions = normalizePlcOptionsValue(
            nextProtocol,
            plc_options === undefined ? existing.plc_options : plc_options,
            existing.plc_options
        );
        if (!isAuxiliaryDevice(nextModelType, nextInstanceConfig) && !nextLineId) {
            return res.status(400).json({ error: '普通设备必须选择所属产线' });
        }
        const nextCoordinateSpace = ['line_local', 'workshop_local'].includes(coordinate_space)
            ? coordinate_space
            : (nextLineId ? 'line_local' : 'workshop_local');

        await db.run(`UPDATE devices SET name=?, line_id=?, model_type=?, model_file=?,
            template_id=?, instance_config=?, pos_x=?, pos_y=?, pos_z=?,
            rotation_y=?, scale=?, coordinate_space=?, sort_order=?, plc_enabled=?, plc_protocol=?, plc_ip=?,
            plc_port=?, plc_options=?, plc_rack=?, plc_slot=?, plc_timeout=?, plc_retry_interval=?,
            plc_max_retries=? WHERE id=?`, [
            name,
            nextLineId,
            nextModelType,
            model_file,
            template_id || '',
            stringifyJson(nextInstanceConfig),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            nextCoordinateSpace,
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            nextProtocol,
            plc_ip ?? existing.plc_ip ?? '',
            numberWithDefault(plc_port, defaultPortForProtocol(nextProtocol)),
            nextPlcOptions,
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0),
            req.params.id
        ]);
        restartDataEngineSoon('update device');
        broadcastDeviceConfigurationChanged(req.params.id, nextInstanceConfig);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletedImpact = await db.transaction(async (tx) => {
            const impact = await getDeviceDeletionImpact(tx, req.params.id);
            if (!impact) {
                const error = new Error('设备不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            await tx.run('DELETE FROM data_points WHERE device_id = ?', [req.params.id]);
            const result = await tx.run('DELETE FROM devices WHERE id = ?', [req.params.id]);
            if (!result?.affectedRows && !result?.changes) throw new Error('设备删除失败：没有删除到任何记录');
            return impact;
        });
        restartDataEngineSoon('delete device');
        res.json({ success: true, impact: publicDeletionImpact(deletedImpact) });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
