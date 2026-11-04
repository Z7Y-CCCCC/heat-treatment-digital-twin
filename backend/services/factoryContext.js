const { getDb } = require('../db/database');
const { withFactoryScope } = require('./dataSources');

async function resolveFactoryId(db, requestedId = '') {
    const requested = String(requestedId || '').trim();
    if (requested) {
        const row = await db.get('SELECT id FROM factories WHERE id = ?', [requested]);
        if (!row) {
            const error = new Error('所选工厂不存在');
            error.statusCode = 404;
            error.code = 'FACTORY_CONTEXT_NOT_FOUND';
            throw error;
        }
        return String(row.id);
    }
    const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
    if (active?.value) {
        const row = await db.get('SELECT id FROM factories WHERE id = ?', [active.value]);
        if (row) return String(row.id);
    }
    const first = await db.get('SELECT id FROM factories ORDER BY sort_order ASC, created_at ASC LIMIT 1');
    if (first) return String(first.id);
    const error = new Error('数据库中尚未配置可用工厂');
    error.statusCode = 503;
    error.code = 'FACTORY_CONTEXT_MISSING';
    throw error;
}

async function factoryContext(req, res, next) {
    try {
        const db = await getDb();
        req.factoryId = await resolveFactoryId(db, req.get('x-factory-id') || req.query.factory_id || '');
        withFactoryScope(req.factoryId, next);
    } catch (error) {
        // Empty installations must be able to render onboarding/read empty
        // lists. Writes still require an explicitly created factory.
        if (error.code === 'FACTORY_CONTEXT_MISSING' && ['GET', 'HEAD'].includes(req.method)) {
            req.factoryId = '';
            return withFactoryScope('', next);
        }
        res.status(error.statusCode || 500).json({ success: false, code: error.code || 'FACTORY_CONTEXT_ERROR', error: error.message });
    }
}

module.exports = { factoryContext, resolveFactoryId };
