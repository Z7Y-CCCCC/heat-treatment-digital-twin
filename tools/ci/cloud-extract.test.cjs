'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, 'cloud-extract.ps1');
const shell = fs.existsSync('C:/Program Files/PowerShell/7/pwsh.exe')
    ? 'C:/Program Files/PowerShell/7/pwsh.exe'
    : path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const winTest = (name, fn) => test(name, { skip: process.platform !== 'win32', timeout: 60000 }, fn);
function temporary(t) {
    const parent = fs.realpathSync.native(os.tmpdir());
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'cloud-extract-test-')));
    assert.ok(root.startsWith(parent + path.sep));
    t.after(() => {
        const resolved = fs.realpathSync.native(root);
        assert.equal(resolved, root);
        assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('cloud-extract-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return root;
}
function powershell(root, source, { env = {}, pathPrefix = '' } = {}) {
    const script = path.join(root, 'probe-' + crypto.randomUUID() + '.ps1');
    fs.writeFileSync(script, '\uFEFF' + source, 'utf8');
    const childEnv = { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: root, ...env };
    if (pathPrefix) {
        const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path');
        const original = pathKey ? childEnv[pathKey] : '';
        for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
        childEnv.Path = pathPrefix + path.delimiter + original;
    }
    return spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
}
function fixture(root) {
    const source = path.join(root, 'source runtime'), archive = path.join(root, 'mysql fixture 运行库.zip');
    const directory = path.join(source, 'mysql-fixture', 'bin');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'version.txt'), 'isolated archive fixture\n');
    fs.writeFileSync(path.join(source, 'mysql-fixture', 'LICENSE'), 'test fixture only\n');
    const result = powershell(root, [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '[IO.Compression.ZipFile]::CreateFromDirectory(' + quote(source) + ',' + quote(archive) + ')',
    ].join('\n'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const bytes = fs.readFileSync(archive);
    return { archive, destination: path.join(root, 'extracted runtime 运行库'), size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function extract(root, input, options = {}) {
    return powershell(root, [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
        '. ' + quote(helper),
        "Write-Host ('PATH_TAR=' + (Get-Command tar.exe -CommandType Application | Select-Object -First 1).Source)",
        'Expand-VerifiedCloudArchive -Archive ' + quote(input.archive) + ' -Destination ' + quote(input.destination)
            + ' -ExpectedSize ' + input.size + ' -ExpectedSha256 ' + quote(input.sha256),
    ].join('\n'), options);
}
test('cloud setup uses the tested native extractor and keeps the original pinned archive checks', () => {
    const setup = fs.readFileSync(path.join(__dirname, 'setup-cloud-runner.ps1'), 'utf8');
    const code = fs.readFileSync(helper, 'utf8');
    assert.match(setup, /\. \(Join-Path \$workspace 'tools\/ci\/cloud-extract\.ps1'\)/);
    assert.match(setup, /Expand-VerifiedCloudArchive -Archive \$archive -Destination \$mysqlDirectory -ExpectedSize \$config\.mysql\.size -ExpectedSha256 \$config\.mysql\.sha256/);
    assert.doesNotMatch(setup, /& tar\.exe/);
    assert.match(code, /Join-Path \(\[Environment\]::SystemDirectory\) 'tar\.exe'/);
    assert.match(code, /Get-FileHash -LiteralPath \$archivePath -Algorithm SHA256/);
    assert.match(code, /\$process\.WaitForExit\(\)/);
    assert.match(code, /\$process\.ExitCode -ne 0/);
    assert.match(code, /Start-Process -FilePath \$tar[^\n]+-WindowStyle Hidden[^\n]+-Wait -PassThru/);
    assert.doesNotMatch(code, /Expand-Archive|Remove-Item|Move-Item|Stop-Process|taskkill/);
});
winTest('actual native tar extracts a Windows absolute ZIP path even when Git GNU tar shadows PATH', t => {
    const root = temporary(t), input = fixture(root), gitTar = 'C:/Program Files/Git/usr/bin/tar.exe';
    assert.ok(fs.existsSync(gitTar), 'The Windows regression requires the Git tar that caused the hosted-runner failure');
    const legacy = spawnSync(gitTar, ['-tf', input.archive], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(legacy.status, 0, 'GNU tar must reproduce the Windows drive-letter failure');
    assert.match(legacy.stderr, /Cannot connect to [A-Z]:.*resolve failed/i);
    const result = extract(root, input, { pathPrefix: path.dirname(gitTar) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout.replace(/\\/g, '/'), /PATH_TAR=C:\/Program Files\/Git\/usr\/bin\/tar\.exe/i);
    assert.equal(fs.readFileSync(path.join(input.destination, 'mysql-fixture/bin/version.txt'), 'utf8'), 'isolated archive fixture\n');
});
winTest('size and SHA-256 mismatches fail before creating an extraction directory', t => {
    const root = temporary(t), input = fixture(root), original = fs.readFileSync(input.archive);
    for (const patch of [{ size: input.size + 1 }, { sha256: '0'.repeat(64) }]) {
        const result = extract(root, { ...input, ...patch });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /pinned byte size and SHA-256/);
        assert.equal(fs.existsSync(input.destination), false);
        assert.deepEqual(fs.readFileSync(input.archive), original);
    }
});
winTest('outside paths, filesystem roots and non-hosted environments fail without file mutation', t => {
    const root = temporary(t), input = fixture(root), outside = root + '-outside';
    assert.equal(fs.existsSync(outside), false);
    for (const [patch, env, pattern] of [
        [{ destination: outside }, {}, /inside RUNNER_TEMP/],
        [{ archive: outside + '.zip' }, {}, /inside RUNNER_TEMP/],
        [{}, { RUNNER_ENVIRONMENT: 'self-hosted' }, /isolated hosted runner/],
        [{}, { GITHUB_ACTIONS: 'false' }, /isolated hosted runner/],
        [{}, { RUNNER_TEMP: path.parse(root).root }, /Unsafe runner temporary directory/],
    ]) {
        const result = extract(root, { ...input, ...patch }, { env });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, pattern);
        assert.equal(fs.existsSync(input.destination), false);
        assert.equal(fs.existsSync(outside), false);
    }
});
winTest('pre-existing destination files remain byte-identical and are never overwritten', t => {
    const root = temporary(t), input = fixture(root), sentinel = path.join(input.destination, 'existing-setting.txt');
    fs.mkdirSync(input.destination);
    fs.writeFileSync(sentinel, 'isolated existing setting\n');
    const original = fs.readFileSync(sentinel), result = extract(root, input);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /existing files are never overwritten/);
    assert.deepEqual(fs.readFileSync(sentinel), original);
    assert.deepEqual(fs.readdirSync(input.destination), ['existing-setting.txt']);
});
winTest('a corrupt ZIP with matching test-fixture bytes still fails the real native extraction', t => {
    const root = temporary(t), archive = path.join(root, 'invalid.zip'), bytes = Buffer.from('not a ZIP archive');
    fs.writeFileSync(archive, bytes);
    const result = extract(root, { archive, destination: path.join(root, 'invalid-destination'), size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Verified cloud archive extraction failed/);
    assert.deepEqual(fs.readFileSync(archive), bytes);
});
