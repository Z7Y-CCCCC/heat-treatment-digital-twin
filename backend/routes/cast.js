/**
 * 局域网电视发现与一键投屏接口。
 *
 * 与 runtime.js 一样只对本机开放：投屏会把整块屏幕推出去，控制权必须留在
 * 现场这台电脑上，不能让局域网里任何人调用。
 */

const express = require('express');

function isLoopbackRequest(req) {
    const address = String(req.socket?.remoteAddress || '');
    return address === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(address);
}

module.exports = function createCastRouter(controller = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!isLoopbackRequest(req)) {
            res.status(403).json({ success: false, error: '投屏控制接口仅允许本机访问' });
            return;
        }
        if (!controller.discovery || !controller.screenCast) {
            res.status(503).json({ success: false, error: '投屏服务尚未就绪，请稍候重试' });
            return;
        }
        next();
    });

    function payload(extra = {}) {
        return {
            success: true,
            ...controller.discovery.status(),
            cast: controller.screenCast.status(),
            ...extra
        };
    }

    router.get('/devices', async (req, res) => {
        try {
            // 首次打开后台时先等编码器探测结束，避免把“尚未检测”误报成“没有安装”。
            await controller.screenCast.resolveFfmpeg();
            res.json(payload());
        } catch (error) {
            res.status(500).json({ success: false, error: `检查投屏服务失败：${error.message}` });
        }
    });

    router.post('/refresh', async (req, res) => {
        try {
            const timeoutMs = Math.min(8000, Math.max(1500, Number(req.body?.timeoutMs) || 3500));
            await Promise.all([
                controller.discovery.scan({ timeoutMs }),
                controller.screenCast.resolveFfmpeg()
            ]);
            res.json(payload());
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/start', async (req, res) => {
        const deviceId = String(req.body?.deviceId || '');
        if (!deviceId) {
            res.status(400).json({ success: false, error: '请先选择一台电视' });
            return;
        }
        try {
            const device = await controller.discovery.resolve(deviceId);
            if (!device) {
                res.status(404).json({ ...payload(), success: false, error: '暂未找到这台电视；请确认已开机并连接同一局域网，再重新连接' });
                return;
            }
            await controller.screenCast.start(device);
            res.json(payload());
        } catch (error) {
            res.status(400).json({ ...payload(), success: false, error: error.message });
        }
    });

    router.post('/stop', async (req, res) => {
        try {
            await controller.screenCast.stop();
            res.json(payload());
        } catch (error) {
            res.status(400).json({ ...payload(), success: false, error: error.message });
        }
    });

    return router;
};
