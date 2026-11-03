const fs = require('node:fs');
const path = require('node:path');

function resolveNativeClientPath(directory, { io = fs, platform = process.platform } = {}) {
    const absolute = path.resolve(directory);
    if (platform !== 'win32' || !io.existsSync(absolute) || typeof io.realpathSync !== 'function') return absolute;
    // Installer smoke views and redirected installations can add a long
    // junction spelling. Unity's native DLL loader is not long-path-aware,
    // even though Electron's filesystem APIs can read the same file normally.
    return (io.realpathSync.native || io.realpathSync)(absolute);
}

function validateNativeClientFiles(directory, { io = fs } = {}) {
    for (const name of ['HeatTreatmentDigitalTwin.exe', 'UnityPlayer.dll',
        'MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll', 'HeatTreatmentDigitalTwin_Data/Managed/Assembly-CSharp.dll']) {
        if (!io.existsSync(path.join(directory, name))) throw new Error(`原生大屏运行库不完整，缺少：${name}。请重新安装完整程序。`);
    }
}

module.exports = { resolveNativeClientPath, validateNativeClientFiles };
