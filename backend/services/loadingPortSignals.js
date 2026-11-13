const { normalizeLoadingPortSignals } = require('../../shared/loadingPortSignals.mjs');
async function validateLoadingPortSignalSources(db, device, value) {
    const signals = normalizeLoadingPortSignals(value);
    for (const kind of ['inlet', 'outlet']) {
        const id = signals[kind + 'PointId'];
        if (!id) continue;
        const point = await db.get('SELECT * FROM data_points WHERE id=? AND device_id=?', [id, device.id]);
        if (!point || String(point.access_type || 'READ').toUpperCase() !== 'READ' || String(point.data_type).toUpperCase() !== 'BOOL') {
            throw Object.assign(new Error('进出料信号必须是本设备的只读 BOOL 采集点位'), { statusCode: 400, code: 'LOADING_PORT_SIGNALS_INVALID' });
        }
    }
    return signals;
}
module.exports = { validateLoadingPortSignalSources };
