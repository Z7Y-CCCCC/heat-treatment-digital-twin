// Invalidate displays only after a successful committed management write.
// Reads, failed validation and unsaved previews must not rebuild a scene.
function configurationMutation(resource, server = () => global.wsServer) {
    return (req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
        res.once('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            server()?.broadcast?.('configuration_changed', {
                factoryId: req.factoryId, resource, reloadRequired: true, timestamp: Date.now()
            });
        });
        next();
    };
}

module.exports = { configurationMutation };
