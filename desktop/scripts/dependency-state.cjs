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

function installedMatchesLock(directory) {
    try {
        const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
        if (!lock.packages) return false;
        for (const [relative, expected] of Object.entries(lock.packages)) {
            if (!relative || expected.link || expected.optional && !fs.existsSync(path.join(directory, relative))) continue;
            const installed = JSON.parse(fs.readFileSync(path.join(directory, relative, 'package.json'), 'utf8'));
            if (expected.version && installed.version !== expected.version) return false;
        }
        return true;
    } catch { return false; }
}

if (require.main === module) {
    const [mode, directory] = process.argv.slice(2);
    if (!directory || !['check', 'record', 'verify'].includes(mode)) throw new Error('Usage: dependency-state.cjs check|verify|record directory');
    if (mode === 'record') recordDependencies(path.resolve(directory));
    else if (mode === 'verify') process.exitCode = installedMatchesLock(path.resolve(directory)) ? 0 : 1;
    else process.exitCode = dependenciesCurrent(path.resolve(directory)) ? 0 : 1;
}

module.exports = { dependenciesCurrent, recordDependencies, installedMatchesLock };
