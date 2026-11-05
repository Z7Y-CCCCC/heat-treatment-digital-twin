// Compact native loading context. Progress is completed model instances, not a time estimate.
function normalizeSceneLoading(value, sceneReady = false) {
    if (sceneReady !== false || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = (input, limit) => typeof input === 'string' ? input.trim().slice(0, limit) : '';
    const loadId = text(value.loadId, 80);
    if (!loadId || !['config', 'environment', 'models', 'scene', 'retry'].includes(value.stage)) return null;
    const total = Number.isInteger(value.total) && value.total >= 0 && value.total <= 100000 ? value.total : 0;
    const completed = Number.isInteger(value.completed) && value.completed >= 0 ? Math.min(total, value.completed) : 0;
    return { loadId, stage: value.stage, total, completed, modelName: text(value.modelName, 180),
        progress: value.stage === 'models' && total > 0 ? completed / total : null };
}
module.exports = { normalizeSceneLoading };
