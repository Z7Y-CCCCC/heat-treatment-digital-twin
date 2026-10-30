// Hover is ephemeral presentation state, not a full dashboard/navigation update.
function normalizeInspectionHover(source, context) {
    if (!source || !context || context.viewMode !== 'device' || !context.inspectionEnabled || context.sceneReady === false) return null;
    for (const key of ['factoryId', 'deviceId', 'viewId', 'inspectionStage']) {
        if (String(source[key] || '') !== String(context[key] || '')) return null;
    }
    const id = String(source.inspectionHoveredPartId || '');
    if (id && !context.inspectionParts?.some(part => part.id === id)) return null;
    const pointer = source.inspectionHoverPointer;
    const visible = !!id && pointer?.visible === true && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
        && pointer.x >= 0 && pointer.x <= 1 && pointer.y >= 0 && pointer.y <= 1;
    return { factoryId: context.factoryId || '', deviceId: context.deviceId, viewId: context.viewId,
        inspectionStage: context.inspectionStage, inspectionHoveredPartId: visible ? id : '',
        inspectionHoverPointer: { x: visible ? pointer.x : 0, y: visible ? pointer.y : 0, visible } };
}

module.exports = { normalizeInspectionHover };
