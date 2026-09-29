const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFileManifest, verifyFileManifest } = require('./runtime-cache.cjs');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');

/**
 * 随 Windows 安装包准备固定版本的 LGPL FFmpeg。
 *
 * 选择 shared 构建有两个原因：
 *   1. 不包含 libx264 / libx265，投屏使用 Windows Media Foundation 的 h264_mf；
 *   2. FFmpeg 以 DLL 动态链接，便于满足 LGPL 对替换、重新链接库文件的要求。
 *
 * 下载地址和 SHA-256 都固定，避免“latest”在无人知情时改变交付内容。
 */

const desktopDir = path.resolve(__dirname, '..');
const cacheDir = path.resolve(process.env.FFMPEG_CACHE_DIR || path.join(desktopDir, '.cache', 'ffmpeg'));
const outputDir = path.join(cacheDir, 'runtime');
const distributionDir = path.join(desktopDir, 'resources', 'ffmpeg');

const build = Object.freeze({
    version: 'n7.1.5-12-g1fdbca85aa-20260805',
    releaseTag: 'autobuild-2026-08-05-15-18',
    archiveName: 'ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip',
    archiveRoot: 'ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1',
    sha256: '185df1abe559a813be7d53c7ec7e1a6135129b0db09e7b0f607317c2f16cf5a6',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/'
        + 'autobuild-2026-08-05-15-18/'
        + 'ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip',
    buildScriptsUrl: 'https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-08-05-15-18',
    ffmpegSourceUrl: 'https://github.com/FFmpeg/FFmpeg/tree/1fdbca85aa'
});

function fileSha256(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function verifyArchive(filename) {
    if (!fs.existsSync(filename)) return false;
    const actual = fileSha256(filename);
    if (actual === build.sha256) return true;
    console.warn(`FFmpeg 缓存校验失败，将重新下载：${actual}`);
    fs.rmSync(filename, { force: true });
    return false;
}

function downloadWithSystemTool(url, destination) {
    const partial = `${destination}.partial`;
    fs.rmSync(partial, { force: true });
    console.log(`正在下载固定版本 FFmpeg LGPL 构建：${url}`);
    try {
        execFileSync('curl.exe', [
            '-L', '--fail', '--retry', '3', '--retry-delay', '2',
            '--output', partial,
            url
        ], { stdio: 'inherit', windowsHide: true });
    } catch (curlError) {
        console.warn('curl 下载失败，改用 PowerShell Invoke-WebRequest。');
        execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            '$ProgressPreference="SilentlyContinue"; '
                + 'Invoke-WebRequest -UseBasicParsing -Uri $args[0] -OutFile $args[1]',
            url,
            partial
        ], { stdio: 'inherit', windowsHide: true });
    }
    fs.renameSync(partial, destination);
}

function ensureArchive() {
    fs.mkdirSync(cacheDir, { recursive: true });
    const explicitArchive = String(process.env.FFMPEG_ARCHIVE_PATH || '').trim();
    if (explicitArchive) {
        const resolved = path.resolve(explicitArchive);
        if (!verifyArchive(resolved)) {
            throw new Error(`FFMPEG_ARCHIVE_PATH 指向的文件不存在或 SHA-256 不匹配：${resolved}`);
        }
        return resolved;
    }

    const archive = path.join(cacheDir, build.archiveName);
    if (!verifyArchive(archive)) downloadWithSystemTool(build.url, archive);
    if (!verifyArchive(archive)) {
        throw new Error(`FFmpeg 下载完成但 SHA-256 不匹配，期望 ${build.sha256}`);
    }
    return archive;
}

function extractArchive(archive, destination) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    try {
        execFileSync('tar.exe', ['-xf', archive, '-C', destination], {
            stdio: 'inherit',
            windowsHide: true
        });
    } catch (tarError) {
        console.warn('tar 解压失败，改用 PowerShell Expand-Archive。');
        execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
            archive,
            destination
        ], { stdio: 'inherit', windowsHide: true });
    }
}

function copyRuntimeFiles(extractedRoot) {
    const binDir = path.join(extractedRoot, 'bin');
    const licensePath = path.join(extractedRoot, 'LICENSE.txt');
    const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(licensePath)) {
        throw new Error(`FFmpeg 压缩包结构不符合预期：${extractedRoot}`);
    }

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const runtimeFiles = fs.readdirSync(binDir)
        .filter(filename => filename === 'ffmpeg.exe' || filename.toLowerCase().endsWith('.dll'))
        .sort();
    for (const filename of runtimeFiles) {
        fs.copyFileSync(path.join(binDir, filename), path.join(outputDir, filename));
    }
    fs.copyFileSync(licensePath, path.join(outputDir, 'LICENSE.txt'));
    return runtimeFiles;
}

function verifyRuntime() {
    const ffmpegPath = path.join(outputDir, 'ffmpeg.exe');
    const versionOutput = execFileSync(ffmpegPath, ['-version'], {
        cwd: outputDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
    });
    const encoderOutput = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], {
        cwd: outputDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
    });
    if (!/^ffmpeg version n7\.1\.5-12-g1fdbca85aa-20260805/m.test(versionOutput)) {
        throw new Error('FFmpeg 版本验证失败，实际输出与固定交付版本不一致');
    }
    if (!/\bh264_mf\b/.test(encoderOutput)) {
        throw new Error('该 FFmpeg 构建不包含 h264_mf，无法在无独显 Windows 电脑上投屏');
    }
    if (/--enable-libx264\b/.test(versionOutput) || !/--disable-libx264\b/.test(versionOutput)) {
        throw new Error('FFmpeg 构建意外启用了 libx264，不符合当前 LGPL 商业交付策略');
    }
    return versionOutput.split(/\r?\n/)[0].trim();
}

function writeMetadata(runtimeFiles, versionLine) {
    const metadata = {
        name: 'FFmpeg',
        version: build.version,
        license: 'LGPL-3.0-or-later',
        distribution: 'BtbN FFmpeg-Builds Windows x64 LGPL shared build',
        releaseTag: build.releaseTag,
        archiveName: build.archiveName,
        archiveSha256: build.sha256,
        downloadUrl: build.url,
        buildScriptsUrl: build.buildScriptsUrl,
        ffmpegSourceUrl: build.ffmpegSourceUrl,
        versionLine,
        dynamicallyLinked: true,
        encoder: 'h264_mf (Windows Media Foundation)',
        runtimeFiles,
        fileManifest: createFileManifest(outputDir, [...runtimeFiles, 'LICENSE.txt'])
    };
    fs.writeFileSync(
        path.join(outputDir, 'FFMPEG_METADATA.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(outputDir, 'SOURCE.txt'),
        [
            'FFmpeg bundled component source and build information',
            '=====================================================',
            '',
            `Binary: ${versionLine}`,
            `License: ${metadata.license} (see LICENSE.txt)`,
            `Binary release: ${build.url}`,
            `Archive SHA-256: ${build.sha256}`,
            `Build scripts and exact build recipe: ${build.buildScriptsUrl}`,
            `Corresponding FFmpeg source revision: ${build.ffmpegSourceUrl}`,
            '',
            'This product uses the dynamically linked LGPL build without libx264/libx265.',
            'Video encoding is performed by the Windows Media Foundation h264_mf encoder.',
            'The FFmpeg DLL files are installed next to ffmpeg.exe and may be replaced by',
            'a compatible build in accordance with the LGPL license terms.',
            ''
        ].join('\n'),
        'utf8'
    );
}

async function main() {
    if (process.platform !== 'win32') {
        throw new Error('当前交付包只支持 Windows，FFmpeg 资源准备脚本必须在 Windows 上运行');
    }
    const archive = ensureArchive();
    let cached;
    try { cached = JSON.parse(fs.readFileSync(path.join(outputDir, 'FFMPEG_METADATA.json'), 'utf8')); } catch { }
    if (cached?.archiveSha256 === build.sha256
        && Array.isArray(cached.fileManifest)
        && Array.isArray(cached.runtimeFiles) && cached.runtimeFiles.includes('ffmpeg.exe')
        && cached.runtimeFiles.every(name => cached.fileManifest?.some(entry => entry.name === name))
        && cached.fileManifest?.some(entry => entry.name === 'LICENSE.txt')
        && verifyFileManifest(outputDir, cached.fileManifest)) {
        const versionLine = verifyRuntime();
        writeMetadata(cached.runtimeFiles, versionLine);
        console.log('FFmpeg 运行时内容校验通过，复用已解压缓存。');
        await publishRuntime();
        return;
    }
    const extractionDir = path.join(cacheDir, `.extract-${process.pid}`);
    try {
        extractArchive(archive, extractionDir);
        const extractedRoot = path.join(extractionDir, build.archiveRoot);
        const runtimeFiles = copyRuntimeFiles(extractedRoot);
        const versionLine = verifyRuntime();
        writeMetadata(runtimeFiles, versionLine);
        console.log(`已准备 FFmpeg 投屏编码器：${path.join(outputDir, 'ffmpeg.exe')}`);
        console.log(`已验证编码器：h264_mf；运行文件：${runtimeFiles.length} 个`);
        await publishRuntime();
    } finally {
        fs.rmSync(extractionDir, { recursive: true, force: true });
    }
}

async function publishRuntime() {
    await prepareResourceDirectory(distributionDir, async staging => {
        fs.cpSync(outputDir, staging, { recursive: true });
    });
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
