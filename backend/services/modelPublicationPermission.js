const { isDeepStrictEqual } = require('util');
const { getAdminAuth } = require('./adminAuth');
const { suppliedAdminSession } = require('../middleware/security');

function publication(metadata) {
    const value = typeof metadata === 'string' ? JSON.parse(metadata || '{}') : metadata || {};
    const release = value.release || {};
    return { deliveryStatus: value.assetSpec?.delivery_status || 'draft', status: release.status || 'draft',
        version: release.version || '', publishedAt: release.published_at || '', history: release.history || [] };
}
function requiresModelPublish(before, after) {
    const previous = publication(before), next = publication(after);
    const published = value => value.deliveryStatus === 'released' || value.status === 'released'
        || Boolean(value.publishedAt) || value.history.length > 0;
    return (published(previous) || published(next)) && !isDeepStrictEqual(previous, next);
}
function assertModelPublishPermission(req, before, after) {
    if (requiresModelPublish(before, after) && !req.managementAutomationAuthorized) {
        getAdminAuth().requireSession(suppliedAdminSession(req), req.get('x-csrf-token'), { permission: 'page:models:publish' });
    }
}
module.exports = { requiresModelPublish, assertModelPublishPermission };
