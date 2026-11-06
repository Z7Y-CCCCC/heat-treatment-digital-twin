// Invalidate displays only after a successful committed management write.
// Reads, failed validation and unsaved previews must not rebuild a scene.
function configurationMutation(resource, server = () => global.wsServer) {
    return (req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
        res.once('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            // Narrow committed routes can identify their actual resource. This
            // is trusted server state, never an option accepted from the body.
            // Action-input edits must not also invalidate the whole device tree.
            const committedResource = res.locals.configurationResource || resource;
            const deviceId = res.locals.configurationDeviceId;
            server()?.broadcast?.('configuration_changed', {
                factoryId: req.factoryId, resource: committedResource,
                ...(deviceId ? { deviceId } : {}), reloadRequired: true, timestamp: Date.now()
            });
        });
        next();
    };
}

module.exports = { configurationMutation };
