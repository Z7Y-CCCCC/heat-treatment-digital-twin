const { spawnSync } = require('child_process');
const path = require('path');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');

const frontend = path.resolve(__dirname, '../../frontend');
const destination = path.resolve(__dirname, '../.cache/frontend-dist');

// Development deliberately retains old chunks for existing WebView sessions.
// Distribution must instead contain exactly one build, without deleting the
// development output or leaving a partially generated release after failure.
prepareResourceDirectory(destination, async staging => {
    const result = spawnSync(process.execPath, [
        path.join(frontend, 'node_modules/vite/bin/vite.js'),
        'build', '--outDir', staging, '--emptyOutDir'
    ], { cwd: frontend, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`发行版前端构建失败（退出码 ${result.status}）`);
}).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
