'use strict';
// A reachable collector is not necessarily a compatible collector. This is a
// read-only protocol check, never an automatic service upgrade or login.
function assertDisplayStartupSupported(health) {
    const display = health?.capabilities?.displayStartup;
    if (display?.version !== 1 || display.passwordRequired !== false || display.readOnly !== true) {
        throw Object.assign(new Error('当前连接的数据服务版本不支持免密码展示。请更新该采集服务后重新启动大屏；只更新网页或大屏程序不会更新独立采集服务。后台管理仍需密码。未修改现场数据或自动重启采集服务。'),
            { code: 'DISPLAY_STARTUP_UPDATE_REQUIRED' });
    }
}
module.exports = { assertDisplayStartupSupported };
