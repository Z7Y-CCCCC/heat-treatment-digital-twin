function normalizeDeviceHover(source, context) {
    if (!source || !context || !['factory', 'workshop', 'line'].includes(context.viewMode) || context.sceneReady === false) return null;
    for (const key of ['factoryId', 'viewId']) if (String(source[key] || '') !== String(context[key] || '')) return null;
    const id = typeof source.hoveredDeviceId === 'string' ? source.hoveredDeviceId : '';
    if (id.length > 128) return null;
    const pointer = source.deviceHoverPointer;
    const visible = !!id && pointer?.visible === true && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
        && pointer.x >= 0 && pointer.x <= 1 && pointer.y >= 0 && pointer.y <= 1;
    return { factoryId: context.factoryId || '', viewId: context.viewId,
        hoveredDeviceId: visible ? id : '',
        deviceHoverPointer: { x: visible ? pointer.x : 0, y: visible ? pointer.y : 0, visible } };
}
module.exports = { normalizeDeviceHover };
