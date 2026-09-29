const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');

const defaultSource = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MySQL', 'MySQL Server 9.2');
const requiredExecutables = ['mysqld.exe', 'mysql.exe', 'mysqladmin.exe', 'mysqldump.exe'];
const msvcPattern = /^(?:vcruntime|msvcp|concrt)\d+[^\\/]*\.dll$/i;

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`MySQL runtime cannot contain symbolic links: ${filename}`);
        return entry.isDirectory() ? walk(filename) : [filename];
    });
}

// Read the PE import directory to include exactly the MSVC dependencies used by
// the shipped binaries. Windows OS DLLs remain provided by Windows 10/11.
function importedDlls(filename) {
    const data = fs.readFileSync(filename);
    if (data.readUInt16LE(0) !== 0x5a4d) throw new Error(`Invalid PE executable: ${filename}`);
    const pe = data.readUInt32LE(0x3c);
    if (data.readUInt32LE(pe) !== 0x4550) throw new Error(`Invalid PE header: ${filename}`);
    if (data.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`MySQL runtime must be x64: ${filename}`);
    const sectionCount = data.readUInt16LE(pe + 6);
    const optional = pe + 24;
    const sectionStart = optional + data.readUInt16LE(pe + 20);
    const directory = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
    const sections = Array.from({ length: sectionCount }, (_, index) => {
        const offset = sectionStart + index * 40;
        return { rva: data.readUInt32LE(offset + 12), size: Math.max(data.readUInt32LE(offset + 8), data.readUInt32LE(offset + 16)), file: data.readUInt32LE(offset + 20) };
    });
    const fileOffset = rva => {
        const section = sections.find(item => rva >= item.rva && rva < item.rva + item.size);
        if (!section) throw new Error(`Unmapped PE import in ${filename}`);
        return section.file + rva - section.rva;
    };
    const strings = new Set();
    const readName = rva => {
        const start = fileOffset(rva);
        const end = data.indexOf(0, start);
        if (end < start) throw new Error(`Invalid PE import name: ${filename}`);
        strings.add(data.toString('ascii', start, end));
    };
    const importRva = data.readUInt32LE(directory + 8);
    if (importRva) {
        for (let offset = fileOffset(importRva); data.readUInt32LE(offset + 12); offset += 20) readName(data.readUInt32LE(offset + 12));
    }
    const delayRva = data.readUInt32LE(directory + 13 * 8);
    if (delayRva) {
        for (let offset = fileOffset(delayRva); data.readUInt32LE(offset + 4); offset += 32) {
            if (data.readUInt32LE(offset) & 1) readName(data.readUInt32LE(offset + 4));
        }
    }
    return [...strings];
}

async function prepareMysqlRuntime(destination, explicitSource) {
    const source = path.resolve(explicitSource || process.env.DESKTOP_MYSQL_RUNTIME_SOURCE || defaultSource);
    const target = path.resolve(destination);
    if (target === source || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
        throw new Error('MySQL source and generated runtime directories must be separate');
    }
    for (const filename of [...requiredExecutables.map(name => path.join('bin', name)), 'LICENSE', 'README', 'lib', 'share']) {
        if (!fs.existsSync(path.join(source, filename))) throw new Error(`缺少 MySQL 运行文件：${path.join(source, filename)}；可设置 DESKTOP_MYSQL_RUNTIME_SOURCE`);
    }
    return prepareResourceDirectory(target, async staging => {
        const bin = path.join(staging, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        for (const name of requiredExecutables) fs.copyFileSync(path.join(source, 'bin', name), path.join(bin, name));
        for (const name of fs.readdirSync(path.join(source, 'bin'))) {
            if (/\.dll$/i.test(name) && !/debug|mysqlrouter|mysqlharness/i.test(name)) {
                fs.copyFileSync(path.join(source, 'bin', name), path.join(bin, name));
            }
        }
        for (const name of ['lib', 'share']) {
            fs.cpSync(path.join(source, name), path.join(staging, name), {
                recursive: true,
                filter: filename => !/\.(?:lib|pdb)$/i.test(filename) && !/debug/i.test(path.basename(filename))
            });
        }
        for (const name of ['LICENSE', 'README']) fs.copyFileSync(path.join(source, name), path.join(staging, name));
        const systemDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        const msvc = new Set();
        const queue = walk(staging).filter(filename => /\.(exe|dll)$/i.test(filename));
        const checked = new Set();
        const osImports = new Set();
        while (queue.length) {
            const binary = queue.pop();
            if (checked.has(binary)) continue;
            checked.add(binary);
            for (const dependency of importedDlls(binary)) {
                if (msvcPattern.test(dependency)) {
                    const bundled = path.join(bin, dependency);
                    if (!fs.existsSync(bundled)) {
                        const original = [path.join(source, 'bin', dependency), path.join(systemDir, dependency)].find(filename => fs.existsSync(filename));
                        if (!original) throw new Error(`Missing redistributable dependency: ${dependency}`);
                        fs.copyFileSync(original, bundled);
                        queue.push(bundled);
                    }
                    msvc.add(dependency.toLowerCase());
                } else if (!fs.existsSync(path.join(bin, dependency)) && !fs.existsSync(path.join(path.dirname(binary), dependency))) {
                    if (/^(?:api-ms-|ext-ms-)/i.test(dependency) || fs.existsSync(path.join(systemDir, dependency))) osImports.add(dependency.toLowerCase());
                    else {
                        const original = [path.join(source, 'bin', dependency), path.join(source, 'lib', dependency)].find(filename => fs.existsSync(filename));
                        if (!original) throw new Error(`Unresolved MySQL runtime dependency: ${dependency}`);
                        const bundled = path.join(bin, dependency);
                        fs.copyFileSync(original, bundled);
                        queue.push(bundled);
                    }
                }
            }
        }
        const versionText = execFileSync(path.join(bin, 'mysqld.exe'), ['--no-defaults', '--version'], {
            windowsHide: true, encoding: 'utf8', env: { ...process.env, PATH: `${bin};${systemDir}` }, timeout: 15000
        }).trim();
        const version = versionText.match(/\bVer\s+(\d+\.\d+\.\d+)/)?.[1];
        if (!version) throw new Error(`Cannot determine bundled MySQL version: ${versionText}`);
        const sourceText = [
            `MySQL Community Server ${version}, unmodified Oracle Windows x64 binaries.`,
            'License: GPL-2.0; see the complete upstream LICENSE shipped beside this file.',
            'Official downloads and corresponding source: https://downloads.mysql.com/archives/community/',
            `Source archive: https://downloads.mysql.com/archives/get/p/23/file/mysql-${version}.tar.gz`,
            'Microsoft Visual C++ runtime DLLs are included app-local; their distribution rights are governed by Microsoft terms.',
            'No development data directory, service configuration, credentials or backups are bundled.', ''
        ].join('\n');
        fs.writeFileSync(path.join(staging, 'SOURCE.txt'), sourceText);
        const files = walk(staging).map(filename => ({
            path: path.relative(staging, filename).replace(/\\/g, '/'),
            size: fs.statSync(filename).size,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
        }));
        const metadata = {
            name: 'MySQL Community Server', version, architecture: 'x64', license: 'GPL-2.0',
            builtAt: new Date().toISOString(), msvcDependencies: [...msvc].sort(),
            windowsDependencies: [...osImports].sort(), files,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0)
        };
        fs.writeFileSync(path.join(staging, 'MYSQL_METADATA.json'), JSON.stringify(metadata, null, 2));
        console.log(`已准备 MySQL ${version} x64：${target}（${files.length} 文件，${(metadata.totalBytes / 1048576).toFixed(1)} MB；MSVC: ${metadata.msvcDependencies.join(', ')}）`);
        return metadata;
    });
}

if (require.main === module) {
    prepareMysqlRuntime(path.resolve(__dirname, '../resources/mysql')).catch(error => {
        console.error(error.message); process.exitCode = 1;
    });
}

module.exports = { prepareMysqlRuntime, importedDlls };
