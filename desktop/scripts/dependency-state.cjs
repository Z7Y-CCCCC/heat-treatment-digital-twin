const fs = require('fs');
const path = require('path');
const { sha256 } = require('./runtime-cache.cjs');

function dependencyState(directory) {
    const state = { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch };
    for (const name of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json']) {
        const filename = path.join(directory, name);
        state[name] = fs.existsSync(filename) ? sha256(filename) : null;
    }
    return state;
}

function stateFile(directory) { return path.join(directory, 'node_modules', '.codex-dependency-state.json'); }
function dependenciesCurrent(directory) {
    try {
        const current = dependencyState(directory);
        return current['package.json'] !== null
            && JSON.stringify(JSON.parse(fs.readFileSync(stateFile(directory), 'utf8'))) === JSON.stringify(current);
    } catch { return false; }
}
function recordDependencies(directory) {
    if (!fs.existsSync(path.join(directory, 'node_modules'))) throw new Error('依赖目录不存在，不能记录成功安装状态');
    fs.writeFileSync(stateFile(directory), JSON.stringify(dependencyState(directory)));
}

if (require.main === module) {
    const [mode, directory] = process.argv.slice(2);
    if (!directory || !['check', 'record'].includes(mode)) throw new Error('Usage: dependency-state.cjs check|record directory');
    if (mode === 'record') recordDependencies(path.resolve(directory));
    else process.exitCode = dependenciesCurrent(path.resolve(directory)) ? 0 : 1;
}

module.exports = { dependenciesCurrent, recordDependencies };
