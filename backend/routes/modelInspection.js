const router = require('express').Router();
const { getDb, getDbStatus } = require('../db/database');
const { publicInspection } = require('../services/deviceInspection');
const { loadModelInspection, patchModelInspectionLayout, saveModelInspectionLayout } = require('../services/modelInspection');
const { configurationMutation } = require('../services/configurationSync');
const { getBuiltinModels } = require('../services/builtinModels');
const { normalizeModelMetadata } = require('../services/modelAssetMetadata');
const { canonicalJson } = require('../services/deviceInspection');

// Motion authors may change bindings, but cannot rename, publish or rewrite
// inspection layouts. Merge into the latest metadata and retain the CAS guard.
router.put('/:id/bindings', configurationMutation('models'), async (req, res) => {
    try {
        const body = req.body;
        if (!body || Object.keys(body).some(key => !['partBindings', 'expectedBindings'].includes(key))
            || !Array.isArray(body.partBindings) || !Array.isArray(body.expectedBindings) || body.partBindings.length > 2000) {
            throw new Error('仅可提交动作绑定及原绑定版本');
        }
        for (const binding of body.partBindings) {
            if (!binding || typeof binding !== 'object' || Array.isArray(binding)
                || !(binding.node_path || binding.node_name) || !String(binding.source_key || '').trim()
                || !['rotate_speed', 'rotate_angle', 'translate', 'visibility', 'color'].includes(binding.action)
                || !['x', 'y', 'z'].includes(binding.axis)
                || ['input_min', 'input_max', 'output_min', 'output_max', 'speed_factor', 'transition_duration']
                    .some(key => binding[key] !== undefined && (typeof binding[key] !== 'number' || !Number.isFinite(binding[key])))) {
                throw new Error('动作绑定的节点、信号或运动参数无效');
            }
        }
        const partBindings = normalizeModelMetadata({ partBindings: body.partBindings }).partBindings;
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const loaded = await loadModelInspection(tx, req.params.id, req.factoryId);
            if (canonicalJson({ bindings: loaded.metadata.partBindings || [] }) !== canonicalJson({ bindings: body.expectedBindings })) {
                throw Object.assign(new Error('动作绑定已更新，请重新读取模型后保存'), { statusCode: 409 });
            }
            const metadata = { ...loaded.metadata, partBindings,
                runtime: { ...loaded.metadata.runtime, enableGenericBindings: partBindings.length > 0 } };
            return saveModelInspectionLayout(tx, loaded, metadata, req.factoryId, getDbStatus().type);
        });
        global.wsServer?.broadcastToRole?.('model_metadata_changed', { modelId: req.params.id, timestamp: Date.now() }, 'unity');
        res.json({ success: true, model: saved.model });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});

// Renaming must not normalize or rewrite inspection, bindings or release state.
router.put('/:id/name', configurationMutation('models'), async (req, res) => {
    try {
        const body = req.body;
        if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'name') || typeof body.name !== 'string') throw new Error('仅可修改模型名称');
        const name = body.name.trim();
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('模型名称需为 1–120 个字符，且不能包含控制字符');
        const db = await getDb();
        await db.transaction(async tx => {
            const find = () => tx.get('SELECT * FROM models WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)', [req.params.id, req.factoryId]);
            let model = await find();
            if (!model) {
                const builtin = getBuiltinModels().find(row => row.id === req.params.id);
                if (builtin?.file_path) {
                    await tx.insertIgnore('models', { id: builtin.id, name: builtin.name, file_path: builtin.file_path,
                        factory_id: null, placement_level: builtin.placement_level || 'device', asset_type: builtin.asset_type || 'model',
                        tags: builtin.tags || '[]', thumbnail: builtin.thumbnail || null, default_scale: Number(builtin.default_scale || 1),
                        metadata: builtin.metadata || '{}' }, 'id');
                    model = await find();
                }
            }
            if (!model) throw Object.assign(new Error('模型不存在或不属于当前工厂'), { statusCode: 404 });
            await tx.run('UPDATE models SET name = ? WHERE id = ? AND (factory_id IS NULL OR factory_id = ?)', [name, req.params.id, req.factoryId]);
        });
        global.wsServer?.broadcastToRole?.('model_metadata_changed', { modelId: req.params.id, timestamp: Date.now() }, 'unity');
        res.json({ success: true, model: { id: req.params.id, name } });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});

router.get('/:id/inspection', async (req, res) => {
    try {
        const loaded = await loadModelInspection(await getDb(), req.params.id, req.factoryId);
        res.setHeader('Cache-Control', 'no-store'); res.json(publicInspection(loaded));
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message, code: error.code }); }
});

router.put('/:id/inspection', configurationMutation('models'), async (req, res) => {
    try {
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const loaded = await loadModelInspection(tx, req.params.id, req.factoryId);
            const next = patchModelInspectionLayout(loaded, req.body);
            return saveModelInspectionLayout(tx, loaded, next, req.factoryId, getDbStatus().type);
        });
        global.wsServer?.broadcastToRole?.('model_metadata_changed', { modelId: req.params.id, timestamp: Date.now() }, 'unity');
        res.json({ success: true, ...publicInspection(saved), model: saved.model });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});
module.exports = router;
