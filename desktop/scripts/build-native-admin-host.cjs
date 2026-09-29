const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTreeManifest, verifyFileManifest } = require('./runtime-cache.cjs');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const hostProject = path.join(projectDir, 'native-admin-host', 'HeatTreatmentAdminHost.csproj');
const outputDirectory = path.join(projectDir, 'unity-client', 'Builds', 'Windows', 'AdminHost');
const executable = path.join(outputDirectory, 'HeatTreatmentAdminHost.exe');
const cacheFile = path.join(desktopDir, '.cache', 'admin-host-build.json');

function inputFingerprint() {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(__filename));
    const sdk = spawnSync('dotnet', ['--version'], { cwd: projectDir, encoding: 'utf8', windowsHide: true });
    if (sdk.error) throw sdk.error;
    if (sdk.status !== 0) throw new Error('无法读取 .NET SDK 版本');
    hash.update(sdk.stdout.trim());
    function visit(filename) {
        if (!fs.existsSync(filename)) { hash.update(`missing:${filename}`); return; }
        if (fs.statSync(filename).isDirectory()) {
            for (const name of fs.readdirSync(filename).sort()) {
                if (['bin', 'obj', '.git'].includes(name)) continue;
                visit(path.join(filename, name));
            }
        } else {
            hash.update(filename); hash.update('\0'); hash.update(fs.readFileSync(filename)); hash.update('\0');
        }
    }
    visit(path.dirname(hostProject));
    visit(path.join(desktopDir, 'assets', 'icon.ico'));
    visit(path.join(projectDir, 'frontend', 'public', 'loading', 'industrial-factory.png'));
    visit(path.join(path.dirname(hostProject), 'obj', 'project.assets.json'));
    for (let directory = projectDir; ; directory = path.dirname(directory)) {
        for (const name of ['global.json', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'NuGet.Config']) visit(path.join(directory, name));
        if (directory === path.dirname(directory)) break;
    }
    return hash.digest('hex');
}

if (!fs.existsSync(hostProject)) throw new Error(`内嵌后台宿主项目不存在：${hostProject}`);
fs.mkdirSync(outputDirectory, { recursive: true });
const fingerprint = inputFingerprint();
let cached;
try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { }
if (process.env.DESKTOP_FORCE_ADMIN_REBUILD !== 'true' && cached?.fingerprint === fingerprint
    && verifyFileManifest(outputDirectory, cached.files)) {
    console.log('后台宿主源码、SDK 和构建产物校验通过，复用已有客户端。');
    process.exit(0);
}

const result = spawnSync('dotnet', [
    'publish', hostProject,
    '--configuration', 'Release',
    '--runtime', 'win-x64',
    '--self-contained', 'true',
    '--output', outputDirectory
], {
    cwd: projectDir,
    windowsHide: true,
    stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) {
    throw new Error(`内嵌后台宿主构建失败（退出码 ${result.status}）`);
}

for (const required of [
    executable,
    path.join(outputDirectory, 'Microsoft.Web.WebView2.Core.dll'),
    path.join(outputDirectory, 'Microsoft.Web.WebView2.WinForms.dll'),
    path.join(outputDirectory, 'WebView2Loader.dll')
]) {
    if (!fs.existsSync(required)) throw new Error(`内嵌后台宿主缺少产物：${required}`);
}

console.log(`Unity 内嵌后台宿主已生成：${executable}`);
// Include restored NuGet state in the fingerprint written after publish.
fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify({
    fingerprint: inputFingerprint(),
    files: createTreeManifest(outputDirectory)
}, null, 2));
