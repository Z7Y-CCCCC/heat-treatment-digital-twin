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
function normalizeStartupLoading(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const loadId = typeof value.loadId === 'string' ? value.loadId.trim().slice(0, 80) : '';
    if (!loadId || !Number.isFinite(value.progress) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
    const text = (v, limit) => typeof v === 'string' ? v.trim().slice(0, limit) : '';
    return { loadId, sequence: value.sequence, progress: Math.max(0, Math.min(100, value.progress)),
        step: text(value.step, 240), detail: text(value.detail, 240) };
}
module.exports = { normalizeSceneLoading, normalizeStartupLoading };
