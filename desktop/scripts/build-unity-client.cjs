const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const unityProjectDir = path.join(projectDir, 'unity-client');
const projectVersionFile = path.join(unityProjectDir, 'ProjectSettings', 'ProjectVersion.txt');
const buildDirectory = process.env.DIGITAL_TWIN_UNITY_BUILD_DIR ? path.resolve(process.env.DIGITAL_TWIN_UNITY_BUILD_DIR) : path.join(unityProjectDir, 'Builds', 'Windows');
const buildExecutable = path.join(buildDirectory, 'HeatTreatmentDigitalTwin.exe');
const logDirectory = path.join(unityProjectDir, 'Logs');
const logFile = path.join(logDirectory, 'desktop-package-build.log');
const cacheFile = process.env.DIGITAL_TWIN_UNITY_BUILD_DIR ? path.join(buildDirectory, '.unity-build-cache.json') : path.join(unityProjectDir, 'Library', 'DigitalTwinBuildCache', 'windows-client.json');
const forceRebuild = process.argv.includes('--force')
    || String(process.env.DESKTOP_FORCE_UNITY_REBUILD || '').toLowerCase() === 'true';
const inputRoots = ['Assets', 'Packages', 'ProjectSettings'].map(name => path.join(unityProjectDir, name));
const requiredOutputs = [
    buildExecutable,
    path.join(buildDirectory, 'UnityPlayer.dll'),
    path.join(buildDirectory, 'HeatTreatmentDigitalTwin_Data'),
    path.join(buildDirectory, 'HeatTreatmentDigitalTwin_Data', 'Managed', 'Assembly-CSharp.dll')
];

function walkFiles(directory, result = []) {
    if (!fs.existsSync(directory)) return result;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walkFiles(fullPath, result);
        else if (entry.isFile()) result.push(fullPath);
    }
    return result;
}

function calculateInputFingerprint(editorVersion) {
    const hash = crypto.createHash('sha256');
    hash.update('digital-twin-unity-windows-v1\0');
    hash.update(editorVersion);
    const files = inputRoots.flatMap(root => walkFiles(root)).sort((left, right) => left.localeCompare(right));
    for (const filename of files) {
        hash.update(path.relative(unityProjectDir, filename).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(filename));
        hash.update('\0');
    }
    return { fingerprint: hash.digest('hex'), fileCount: files.length };
}

function readBuildCache() {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
    catch (error) { return null; }
}

function writeBuildCache(details) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
        ...details,
        builtAt: new Date().toISOString()
    }, null, 2), 'utf8');
}

function readEditorVersion() {
    const text = fs.readFileSync(projectVersionFile, 'utf8');
    const match = text.match(/^m_EditorVersion:\s*(.+)$/m);
    if (!match) throw new Error(`无法从 ${projectVersionFile} 读取 Unity 版本`);
    return match[1].trim();
}

function installedEditorCandidates(version) {
    const candidates = [];
    if (process.env.UNITY_EDITOR_PATH) candidates.push(path.resolve(process.env.UNITY_EDITOR_PATH));
    candidates.push(
        path.join('C:\\Program Files', `Unity ${version}`, 'Editor', 'Unity.exe'),
        path.join('C:\\Program Files', 'Unity Hub', 'Editor', version, 'Editor', 'Unity.exe'),
        path.join('C:\\Program Files', 'Unity', 'Hub', 'Editor', version, 'Editor', 'Unity.exe')
    );

    const programFiles = 'C:\\Program Files';
    if (fs.existsSync(programFiles)) {
        for (const name of fs.readdirSync(programFiles)) {
            if (!name.toLowerCase().startsWith('unity')) continue;
            candidates.push(path.join(programFiles, name, 'Editor', 'Unity.exe'));
        }
    }
    return [...new Set(candidates)];
}

function findEditor(version) {
    const editor = installedEditorCandidates(version).find(candidate => fs.existsSync(candidate));
    if (editor) return editor;
    throw new Error(
        `未找到 Unity ${version}。请安装对应编辑器，或设置 UNITY_EDITOR_PATH 指向 Unity.exe。`
    );
}

const version = readEditorVersion();
const input = calculateInputFingerprint(version);
const cached = readBuildCache();
const outputsReady = requiredOutputs.every(filename => fs.existsSync(filename));
if (!forceRebuild && outputsReady && cached?.fingerprint === input.fingerprint) {
    console.log(`Unity 源码、场景和设置未变化，复用现有 Windows 客户端（已检查 ${input.fileCount} 个文件）。`);
    console.log('如需强制重建，请运行：npm run build:unity:force');
    process.exit(0);
}
if (forceRebuild) console.log('已要求强制重建 Unity Windows 客户端。');
else if (!outputsReady) console.log('Unity 构建产物不完整，将执行完整构建。');
else if (!cached) console.log('尚无 Unity 构建缓存记录，将构建并建立缓存。');
else console.log('检测到 Unity 源码、场景或设置发生变化，将执行增量构建。');
const editor = findEditor(version);
fs.mkdirSync(logDirectory, { recursive: true });

console.log(`使用 Unity 编辑器：${editor}`);
const result = spawnSync(editor, [
    '-batchmode',
    '-nographics',
    '-quit',
    '-accept-apiupdate',
    '-projectPath', unityProjectDir,
    '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.ProjectBootstrap.BuildWindowsClient',
    '-logFile', logFile
], {
    cwd: projectDir,
    windowsHide: true,
    stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) {
    throw new Error(`Unity Windows 构建失败（退出码 ${result.status}），请查看：${logFile}`);
}

for (const required of requiredOutputs) {
    if (!fs.existsSync(required)) throw new Error(`Unity 构建缺少产物：${required}`);
}

writeBuildCache({
    fingerprint: input.fingerprint,
    fileCount: input.fileCount,
    editorVersion: version
});

console.log(`Unity Windows 客户端已生成：${buildExecutable}`);
