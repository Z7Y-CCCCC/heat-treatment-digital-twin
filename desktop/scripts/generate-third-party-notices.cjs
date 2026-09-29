const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const projects = [
    { label: 'frontend', directory: path.join(projectDir, 'frontend') },
    { label: 'backend', directory: path.join(projectDir, 'backend') }
];
const packages = new Map();
const ffmpegDirectory = path.join(desktopDir, 'resources', 'ffmpeg');

function normalizeLicense(value) {
    if (Array.isArray(value)) return value.map(normalizeLicense).filter(Boolean).join(' OR ');
    if (value && typeof value === 'object') return normalizeLicense(value.type);
    return typeof value === 'string' ? value.trim() : '';
}

function repositoryUrl(value) {
    if (typeof value === 'string') return value;
    return value?.url || '';
}

function readLicenseFile(packageDirectory, declaredLicense) {
    const filenames = fs.readdirSync(packageDirectory);
    const declaredMatch = declaredLicense.match(/^SEE LICEN[CS]E IN (.+)$/i);
    const candidates = [
        ...(declaredMatch ? [path.basename(declaredMatch[1].trim())] : []),
        ...filenames.filter(filename => /^LICEN[CS]E(?:\..+)?$/i.test(filename))
    ];
    const filename = candidates.find(candidate => fs.existsSync(path.join(packageDirectory, candidate)));
    if (!filename) return { filename: '', text: '' };
    return {
        filename,
        text: fs.readFileSync(path.join(packageDirectory, filename), 'utf8').trim().replace(/[ \t]+$/gm, '')
    };
}

function readPackageMetadata(name, info) {
    if (!info.version || !info.path) return null;
    const packageDirectory = path.resolve(info.path);
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let license = normalizeLicense(manifest.license || info.license);
    const licenseFile = readLicenseFile(packageDirectory, license);
    if (!license && /Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(licenseFile.text)) {
        license = 'MIT';
    }

    if (!license && !licenseFile.text) {
        const readmePath = ['README.md', 'readme.md', 'README', 'Readme.md']
            .map(f => path.join(packageDirectory, f))
            .find(f => fs.existsSync(f));
        if (readmePath) {
            const readmeText = fs.readFileSync(readmePath, 'utf8');
            if (/\bMIT\s+licen[cs]e\b/i.test(readmeText)) license = 'MIT';
            else if (/\bBSD\b/i.test(readmeText) && /licen[cs]e/i.test(readmeText)) license = 'BSD';
            else if (/\bApache\b/i.test(readmeText) && /licen[cs]e/i.test(readmeText)) license = 'Apache-2.0';
            else if (/\bISC\b/i.test(readmeText) && /licen[cs]e/i.test(readmeText)) license = 'ISC';
        }
    }

    return {
        name: manifest.name || name,
        version: manifest.version || info.version,
        license: license || (licenseFile.text ? 'See included license text' : 'UNKNOWN'),
        repository: repositoryUrl(manifest.repository || info.repository),
        licenseFilename: licenseFile.filename,
        licenseText: licenseFile.text
    };
}

function collectDependencies(dependencies = {}) {
    Object.entries(dependencies).forEach(([name, info]) => {
        const metadata = readPackageMetadata(name, info);
        if (metadata) {
            const key = `${metadata.name}@${metadata.version}`;
            if (!packages.has(key)) packages.set(key, metadata);
        }
        collectDependencies(info.dependencies);
    });
}

projects.forEach(({ directory }) => {
    const npmCli = process.env.npm_execpath
        || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const output = execFileSync(process.execPath, [npmCli, 'ls', '--omit=dev', '--all', '--json', '--long'], {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    collectDependencies(JSON.parse(output).dependencies);
});

function readFfmpegNotice() {
    const metadataPath = path.join(ffmpegDirectory, 'FFMPEG_METADATA.json');
    const licensePath = path.join(ffmpegDirectory, 'LICENSE.txt');
    const sourcePath = path.join(ffmpegDirectory, 'SOURCE.txt');
    if (![metadataPath, licensePath, sourcePath].every(filename => fs.existsSync(filename))) {
        throw new Error('缺少 FFmpeg 许可证资源，请先运行 npm run prepare:ffmpeg');
    }
    return {
        metadata: JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
        licenseText: fs.readFileSync(licensePath, 'utf8').trim().replace(/[ \t]+$/gm, ''),
        sourceText: fs.readFileSync(sourcePath, 'utf8').trim().replace(/[ \t]+$/gm, '')
    };
}

const ffmpeg = readFfmpegNotice();
const mysqlDirectory = path.join(desktopDir, 'resources', 'mysql');
const mysqlMetadata = JSON.parse(fs.readFileSync(path.join(mysqlDirectory, 'MYSQL_METADATA.json'), 'utf8'));
const mysqlLicense = fs.readFileSync(path.join(mysqlDirectory, 'LICENSE'), 'utf8').trim();
const mysqlSource = fs.readFileSync(path.join(mysqlDirectory, 'SOURCE.txt'), 'utf8').trim();

const lines = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '============================',
    '',
    'This product includes the following installed production packages. License',
    'metadata and upstream license files are captured from the build environment.',
    'Electron and Chromium notices are distributed in their own license files.',
    '',
    'BUNDLED NATIVE COMPONENT',
    '------------------------',
    '',
    `${mysqlMetadata.name} ${mysqlMetadata.version}`,
    `License: ${mysqlMetadata.license}`,
    `Bundled Microsoft Visual C++ runtime DLLs: ${mysqlMetadata.msvcDependencies.join(', ')}`,
    mysqlSource,
    '',
    '----- BEGIN MYSQL UPSTREAM LICENSE TEXT -----',
    mysqlLicense,
    '----- END MYSQL UPSTREAM LICENSE TEXT -----',
    '',
    `${ffmpeg.metadata.name} ${ffmpeg.metadata.version}`,
    `License: ${ffmpeg.metadata.license}`,
    `Distribution: ${ffmpeg.metadata.distribution}`,
    `Binary release: ${ffmpeg.metadata.downloadUrl}`,
    `Build scripts: ${ffmpeg.metadata.buildScriptsUrl}`,
    `Corresponding source: ${ffmpeg.metadata.ffmpegSourceUrl}`,
    `Archive SHA-256: ${ffmpeg.metadata.archiveSha256}`,
    '',
    ffmpeg.sourceText,
    '',
    '----- BEGIN FFMPEG LGPL LICENSE TEXT -----',
    ffmpeg.licenseText,
    '----- END FFMPEG LGPL LICENSE TEXT -----',
    '',
    'INSTALLED PRODUCTION PACKAGES',
    '-----------------------------',
    '',
    ...Array.from(packages.values())
        .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
        .flatMap(item => [
            `${item.name}@${item.version}`,
            `License: ${item.license}`,
            ...(item.repository ? [`Repository: ${item.repository}`] : []),
            ...(item.licenseText ? [
                `License file: ${item.licenseFilename}`,
                '----- BEGIN UPSTREAM LICENSE TEXT -----',
                item.licenseText,
                '----- END UPSTREAM LICENSE TEXT -----'
            ] : []),
            ''
        ])
];

const unknownPackages = Array.from(packages.values()).filter(item => item.license === 'UNKNOWN');
if (unknownPackages.length > 0) {
    throw new Error(`无法确定以下依赖的许可证：${unknownPackages.map(item => `${item.name}@${item.version}`).join(', ')}`);
}

const outputPath = path.join(desktopDir, 'THIRD_PARTY_NOTICES.txt');
fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`已生成第三方依赖清单：${outputPath} (${packages.size} packages)`);
