'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { extractArchive } = require('./prepare-ffmpeg.cjs');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function fixture(t) {
    const parent = fs.realpathSync.native(os.tmpdir());
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'ffmpeg-zip-test-')));
    t.after(() => {
        const actual = fs.realpathSync.native(root);
        assert.equal(actual, root);
        assert.ok(actual.startsWith(parent + path.sep) && path.basename(actual).startsWith('ffmpeg-zip-test-'));
        fs.rmSync(actual, { recursive: true, force: false });
    });
    return root;
}
function createZip(root) {
    const source = path.join(root, 'source 中文 with spaces'), archive = path.join(root, 'archive 中文.zip');
    fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'sub 目录'));
    fs.writeFileSync(path.join(source, 'sub 目录', 'component 中文.txt'), '固定版本 ZIP 中文内容\n', 'utf8');
    const script = "$ErrorActionPreference='Stop';$env:PSModulePath=(Join-Path $PSHOME 'Modules');Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($env:ZIP_TEST_SOURCE,$env:ZIP_TEST_ARCHIVE)";
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: 'pipe', timeout: 30000, env: { ...process.env, ZIP_TEST_SOURCE: source, ZIP_TEST_ARCHIVE: archive } });
    assert.ok(fs.statSync(archive).size > 0); return archive;
}
test('real Windows ZIP extraction ignores a foreign Archive module and preserves Unicode paths/content with Git tar first', t => {
    assert.equal(process.platform, 'win32', 'This regression must run on Windows, not skip real extraction');
    const root = fixture(t), archive = createZip(root), destination = path.join(root, 'decoded 中文 with spaces');
    const modules = path.join(root, 'foreign-modules'), module = path.join(modules, 'Microsoft.PowerShell.Archive');
    fs.mkdirSync(module, { recursive: true });
    fs.writeFileSync(path.join(module, 'Microsoft.PowerShell.Archive.psd1'), "@{RootModule='Microsoft.PowerShell.Archive.psm1';ModuleVersion='99.0.0';FunctionsToExport=@('Expand-Archive')}");
    fs.writeFileSync(path.join(module, 'Microsoft.PowerShell.Archive.psm1'), "function Expand-Archive { throw 'FOREIGN_ARCHIVE_MODULE_MUST_NOT_BE_LOADED' }");
    const previousModules = process.env.PSModulePath, previousPath = process.env.PATH;
    t.after(() => { if (previousModules === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previousModules; process.env.PATH = previousPath; });
    process.env.PSModulePath = modules; process.env.PATH = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin') + ';' + previousPath;
    assert.ok(path.resolve(destination).startsWith(root + path.sep));
    let realPowerShellCalls = 0;
    const execute = (file, args, options) => {
        if (path.basename(file).toLowerCase() === 'tar.exe') throw Error('Fixture: Git tar cannot connect to drive letter');
        assert.equal(path.basename(file).toLowerCase(), 'powershell.exe'); realPowerShellCalls++;
        const next = [...args], plain = next.indexOf('-Command'), encoded = next.indexOf('-EncodedCommand');
        const load = "Import-Module -Name $env:ZIP_TEST_FOREIGN_MODULE -Force;";
        if (plain >= 0) next[plain + 1] = load + next[plain + 1];
        else { assert.ok(encoded >= 0); next[encoded + 1] = Buffer.from(load + Buffer.from(next[encoded + 1], 'base64').toString('utf16le'), 'utf16le').toString('base64'); }
        return execFileSync(file, next, { ...options, env: { ...options.env, ZIP_TEST_FOREIGN_MODULE: path.join(module, 'Microsoft.PowerShell.Archive.psd1') } });
    };
    extractArchive(archive, destination, execute);
    assert.equal(realPowerShellCalls, 1, 'The ZIP regression must execute a real Windows PowerShell process');
    assert.equal(fs.readFileSync(path.join(destination, 'sub 目录', 'component 中文.txt'), 'utf8'), '固定版本 ZIP 中文内容\n');
});
test('invalid ZIP fails closed rather than returning success after a nonterminating PowerShell error', t => {
    const root = fixture(t), archive = path.join(root, 'invalid.zip'), destination = path.join(root, 'invalid-output');
    fs.writeFileSync(archive, 'not a ZIP archive');
    assert.ok(path.resolve(destination).startsWith(root + path.sep));
    assert.throws(() => extractArchive(archive, destination));
});
test('existing extraction content is never recursively removed or overwritten', t => {
    const root = fixture(t), archive = createZip(root), destination = path.join(root, 'existing-output');
    fs.mkdirSync(destination); const marker = path.join(destination, 'existing.txt'); fs.writeFileSync(marker, 'KEEP_EXISTING_FIXTURE');
    assert.ok(path.resolve(destination).startsWith(root + path.sep));
    assert.throws(() => extractArchive(archive, destination), /empty|existing|fresh/i);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'KEEP_EXISTING_FIXTURE');
});

test('a missing SystemRoot still selects an absolute Windows PowerShell executable and performs real extraction', t => {
    const root = fixture(t), archive = createZip(root), destination = path.join(root, 'fallback-output');
    const previous = process.env.SystemRoot;
    try {
        delete process.env.SystemRoot;
        extractArchive(archive, destination, (file, args, options) => {
            assert.ok(path.isAbsolute(file));
            assert.equal(file.toLowerCase(), path.join('C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
            return execFileSync(file, args, { ...options, env: { ...options.env, SystemRoot: previous || 'C:/Windows' } });
        });
        assert.ok(fs.statSync(path.join(destination, 'sub 目录', 'component 中文.txt')).size > 0);
    } finally { if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; }
});
