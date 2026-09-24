const { configuredDeviceWorkshopId, safeObject } = require('../utils/spatialLayout');

function numericCount(row) {
    const value = Number(row?.total ?? row?.count ?? 0);
    return Number.isFinite(value) ? value : 0;
}

async function countDataPoints(client, deviceIds) {
    if (!deviceIds.length) return 0;
    const placeholders = deviceIds.map(() => '?').join(',');
    return numericCount(await client.get(
        `SELECT COUNT(*) AS total FROM data_points WHERE device_id IN (${placeholders})`,
        deviceIds
    ));
}

function makeImpact(type, record, associations, internal = {}) {
    return {
        type,
        id: String(record.id),
        name: String(record.name),
        associationCount: associations.reduce((sum, item) => sum + item.count, 0),
        associations,
        ...internal
    };
}

async function getWorkshopDeletionImpact(client, workshopId, factoryId = 'factory_default') {
    const workshop = await client.get('SELECT id, name FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) return null;

    const lineRows = await client.all('SELECT id FROM `lines` WHERE workshop_id = ?', [workshopId]);
    const lineIds = lineRows.map(line => String(line.id));
    const lineIdSet = new Set(lineIds);
    const allDevices = await client.all('SELECT id, line_id, instance_config FROM devices');
    const deviceIds = allDevices
        .filter(device => (
            lineIdSet.has(String(device.line_id || ''))
            || configuredDeviceWorkshopId(device) === String(workshopId)
        ))
        .map(device => String(device.id));
    const dataPointCount = await countDataPoints(client, deviceIds);

    const environmentRow = await client.get('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?', [factoryId, 'native_environment_config']);
    const environment = safeObject(environmentRow?.value);
    const wallCount = (Array.isArray(environment.walls) ? environment.walls : []).filter(wall => (
        String(wall?.workshopId || wall?.workshop_id || '') === String(workshopId)
    )).length;

    return makeImpact('workshop', workshop, [
        { key: 'lines', label: '产线', count: lineIds.length },
        { key: 'devices', label: '设备', count: deviceIds.length },
        { key: 'dataPoints', label: '数据点位', count: dataPointCount },
        { key: 'walls', label: '围墙配置', count: wallCount }
    ], { lineIds, deviceIds });
}

async function getLineDeletionImpact(client, lineId) {
    const line = await client.get('SELECT id, name FROM `lines` WHERE id = ?', [lineId]);
    if (!line) return null;
    const deviceRows = await client.all('SELECT id FROM devices WHERE line_id = ?', [lineId]);
    const deviceIds = deviceRows.map(device => String(device.id));
    const dataPointCount = await countDataPoints(client, deviceIds);
    return makeImpact('line', line, [
        { key: 'devices', label: '设备', count: deviceIds.length },
        { key: 'dataPoints', label: '数据点位', count: dataPointCount }
    ], { deviceIds });
}

async function getDeviceDeletionImpact(client, deviceId) {
    const device = await client.get('SELECT id, name FROM devices WHERE id = ?', [deviceId]);
    if (!device) return null;
    const dataPointCount = numericCount(await client.get(
        'SELECT COUNT(*) AS total FROM data_points WHERE device_id = ?',
        [deviceId]
    ));
    return makeImpact('device', device, [
        { key: 'dataPoints', label: '数据点位', count: dataPointCount }
    ]);
}

function publicDeletionImpact(impact) {
    if (!impact) return null;
    const { lineIds, deviceIds, ...result } = impact;
    return result;
}

function assertDeletionConfirmation(body, expectedName) {
    const suppliedName = typeof body?.confirmationName === 'string' ? body.confirmationName : '';
    if (suppliedName !== String(expectedName || '')) {
        const error = new Error('名称确认不一致，已取消删除');
        error.statusCode = 409;
        throw error;
    }
}

module.exports = {
    getWorkshopDeletionImpact,
    getLineDeletionImpact,
    getDeviceDeletionImpact,
    publicDeletionImpact,
    assertDeletionConfirmation
};
