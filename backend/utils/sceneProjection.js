const MAX_DEVICES = 500;
function numbers(value, length, limit = 1e7) {
    return Array.isArray(value) && value.length === length && value.every(item => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= limit)
        ? value.slice() : null;
}
function text(value, size = 128) { return typeof value === 'string' ? value.slice(0, size) : ''; }

function normalizeSceneProjection(source, receivedAt = Date.now()) {
    if (!source || source.version !== 1 || !text(source.streamId) || !Number.isSafeInteger(source.seq) || source.seq < 0) return null;
    const camera = source.camera || {};
    const position = numbers(camera.position, 3), forward = numbers(camera.forward, 3, 2), up = numbers(camera.up, 3, 2), target = numbers(camera.target, 3);
    if (!position || !forward || !up || !target || Math.hypot(...forward) < .5 || Math.hypot(...up) < .5) return null;
    if (![camera.fov,camera.aspect,camera.near,camera.far].every(Number.isFinite)
        || camera.fov <= 0 || camera.fov >= 179 || camera.aspect < .1 || camera.aspect > 10 || camera.near <= 0 || camera.far <= camera.near || camera.far > 1e8) return null;
    if (!Array.isArray(source.devices) || source.devices.length > MAX_DEVICES) return null;
    const ids = new Set();
    const devices = source.devices.flatMap(row => {
        const id = text(row?.id), matrix = numbers(row?.matrix, 16), anchor = numbers(row?.anchor, 3);
        if (!id || ids.has(id) || !matrix || !anchor || Math.abs(matrix[15]-1)>1e-5 || [3,7,11].some(index=>Math.abs(matrix[index])>1e-5)) return [];
        ids.add(id);
        return [{ id, matrix, anchor, visible: row.visible !== false }];
    });
    return { version:1, available:source.sceneReady===true, streamId:text(source.streamId), seq:source.seq,
        sceneId:text(source.sceneId), viewId:text(source.viewId), inspectionStage:text(source.inspectionStage,32),
        timestamp:Number.isFinite(source.timestamp) ? source.timestamp : receivedAt, receivedAt,
        camera:{position,forward,up,target,fov:camera.fov,aspect:camera.aspect,near:camera.near,far:camera.far},devices };
}
module.exports = { normalizeSceneProjection };
