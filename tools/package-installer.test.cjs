'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { compressionOptions } = require('./package-installer.cjs');
const archiver = require('../desktop/node_modules/7zip-bin').path7za;
const { compute7zCompressArgs } = require('../desktop/node_modules/app-builder-lib/out/targets/archive.js');
const compressionVariable = 'ELECTRON_BUILDER_COMPRESSION_LEVEL';
const compressionKeys = env => Object.keys(env).filter(key => key.toUpperCase() === compressionVariable);
const archiveModule = require.resolve('../desktop/node_modules/app-builder-lib/out/targets/archive.js');
const optionsModule = require.resolve('./package-installer.cjs');

function inheritedEnvironment(overrides) {
  const env = { ...process.env };
  for (const key of compressionKeys(env)) delete env[key];
  return { ...env, ...overrides };
}

function archiveProbe(compression) {
  return `const { compute7zCompressArgs } = require(${JSON.stringify(archiveModule)});
    console.log(JSON.stringify({
      keys: Object.keys(process.env).filter(key => key.toUpperCase() === ${JSON.stringify(compressionVariable)}),
      level: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? null,
      args: compute7zCompressArgs('zip', { compression: ${JSON.stringify(compression)} })
    }));`;
}

function archiveArgumentsChild(profile) {
  return JSON.parse(execFileSync(process.execPath, ['-e', archiveProbe(profile.compression)],
    { env: profile.env, windowsHide: true, encoding: 'utf8' }));
}

function assertArchiveProfile(actual, level) {
  assert.deepEqual(actual.keys, level === '0' ? [] : [compressionVariable]);
  assert.equal(actual.level, level === '0' ? null : level);
  assert.ok(actual.args.includes(`-mx=${level}`));
  assert.ok(actual.args.includes(level === '0' ? '-mm=Copy' : '-mm=Deflate'));
}

test('compression profiles remove every inherited casing without mutating caller objects', () => {
  const variants = [
    {},
    { ELECTRON_BUILDER_COMPRESSION_LEVEL: '9' },
    { electron_builder_compression_level: '9' },
    { Electron_Builder_Compression_Level: '9' },
    { ELECTRON_BUILDER_COMPRESSION_LEVEL: '8', electron_builder_compression_level: '9', Electron_Builder_Compression_Level: '7' },
  ];
  for (const inherited of variants) {
    const env = Object.freeze({ unrelated: 'preserved', ELECTRON_BUILDER_COMPRESSION_LEVEL_EXTRA: 'untouched', ...inherited });
    const before = { ...env };
    for (const level of ['0', '1', '3', '9']) {
      const profile = compressionOptions(level, env);
      assert.notEqual(profile.env, env);
      assert.equal(profile.compression, level === '0' ? 'store' : 'normal');
      assert.deepEqual(compressionKeys(profile.env), level === '0' ? [] : [compressionVariable]);
      assert.equal(profile.env[compressionVariable], level === '0' ? undefined : level);
      assert.equal(profile.env.unrelated, 'preserved');
      assert.equal(profile.env.ELECTRON_BUILDER_COMPRESSION_LEVEL_EXTRA, 'untouched');
      assert.deepEqual(env, before);
    }
  }
});

test('real Windows children honor store and nonzero compression despite inherited casing conflicts',
  { skip: process.platform !== 'win32' }, () => {
    for (const overrides of [
      { ELECTRON_BUILDER_COMPRESSION_LEVEL: '9' },
      { electron_builder_compression_level: '9' },
      { Electron_Builder_Compression_Level: '9' },
      { ELECTRON_BUILDER_COMPRESSION_LEVEL: '8', electron_builder_compression_level: '9', Electron_Builder_Compression_Level: '7' },
    ]) {
      const inherited = inheritedEnvironment(overrides);
      const before = { ...inherited };
      for (const level of ['0', '3']) assertArchiveProfile(archiveArgumentsChild(compressionOptions(level, inherited)), level);
      assert.deepEqual(inherited, before);
    }
  });

test('Windows PowerShell 5.1 FastPack assignment keeps lowercase keys but child sanitization selects Copy',
  { skip: process.platform !== 'win32' }, () => {
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const inherited = inheritedEnvironment({ electron_builder_compression_level: '9' });
    const before = { ...inherited };
    const childCode = `const { execFileSync } = require('node:child_process');
      const { compressionOptions } = require(${JSON.stringify(optionsModule)});
      const inheritedKeys = Object.keys(process.env).filter(key => key.toUpperCase() === ${JSON.stringify(compressionVariable)});
      const profile = compressionOptions('0');
      const child = JSON.parse(execFileSync(process.execPath, ['-e', ${JSON.stringify(archiveProbe('store'))}],
        { env: profile.env, windowsHide: true, encoding: 'utf8' }));
      console.log(JSON.stringify({ inheritedKeys, inheritedLevel: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL,
        leftoverKeys: Object.keys(profile.env).filter(key => key.toUpperCase() === ${JSON.stringify(compressionVariable)}), child }));`;
    const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
    // Legacy PowerShell native-argument parsing strips embedded double quotes.
    const bootstrap = `eval(Buffer.from('${Buffer.from(childCode, 'utf8').toString('base64')}','base64').toString('utf8'))`;
    // Execute only the entry point's environment assignment, never the release script.
    const script = `$ErrorActionPreference = 'Stop';
      $ProgressPreference = 'SilentlyContinue';
      Write-Output ($PSVersionTable.PSVersion.ToString());
      $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '0';
      & ${psQuote(process.execPath)} -e ${psQuote(bootstrap)};
      exit $LASTEXITCODE`;
    const output = execFileSync(powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: inherited, windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.match(output[0], /^5\.1\./);
    const actual = JSON.parse(output.slice(1).join('\n'));
    assert.deepEqual(actual.inheritedKeys, ['electron_builder_compression_level']);
    assert.equal(actual.inheritedLevel, '0');
    assert.deepEqual(actual.leftoverKeys, []);
    assertArchiveProfile(actual.child, '0');
    assert.deepEqual(inherited, before);
  });

test('case-normalized child arguments really store or deflate a synthetic ZIP and preserve original bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-casing-test-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('pack-casing-test-') || relative.includes(path.sep)) throw Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = Buffer.from('synthetic compression fixture\n'.repeat(3000));
  fs.writeFileSync(path.join(root, 'input.txt'), input);
  const inherited = inheritedEnvironment({ ELECTRON_BUILDER_COMPRESSION_LEVEL: '8', electron_builder_compression_level: '9' });
  const before = { ...inherited };
  for (const level of ['0', '3']) {
    const profile = compressionOptions(level, inherited);
    const actual = archiveArgumentsChild(profile);
    assertArchiveProfile(actual, level);
    const archive = path.join(root, `level-${level}.zip`);
    execFileSync(archiver, [...actual.args, archive, 'input.txt'],
      { cwd: root, env: profile.env, windowsHide: true, stdio: 'pipe' });
    const listing = execFileSync(archiver, ['l', '-slt', archive], { windowsHide: true, encoding: 'utf8' });
    assert.match(listing, level === '0' ? /^Method = Store\r?$/m : /^Method = Deflate\r?$/m);
    assert.deepEqual(execFileSync(archiver, ['x', '-so', archive, 'input.txt'],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }), input);
  }
  assert.deepEqual(inherited, before);
});

test('fast packaging really stores ZIP entries, preserves bytes and leaves caller environment intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-compression-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: '9' };
  const before = process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
  const input = Buffer.from('热处理数字孪生'.repeat(10000)); fs.writeFileSync(path.join(root, 'input.txt'), input);
  try {
    for (const level of ['0', '1']) {
      const profile = compressionOptions(level, inherited);
      if (profile.env.ELECTRON_BUILDER_COMPRESSION_LEVEL === undefined) delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
      else process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = profile.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
      const archive = path.join(root, `level-${level}.zip`);
      execFileSync(archiver, [...compute7zCompressArgs('zip', { compression: profile.compression }), archive, 'input.txt'], { cwd: root, windowsHide: true, stdio: 'pipe' });
      const listing = execFileSync(archiver, ['l', '-slt', archive], { windowsHide: true, encoding: 'utf8' });
      assert.match(listing, level === '0' ? /^Method = Store\r?$/m : /^Method = Deflate\r?$/m);
      assert.deepEqual(execFileSync(archiver, ['x', '-so', archive, 'input.txt'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }), input);
    }
    assert.equal(inherited.ELECTRON_BUILDER_COMPRESSION_LEVEL, '9');
    assert.throws(() => compressionOptions('10'), /0-9/);
  } finally {
    if (before === undefined) delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
    else process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = before;
  }
});
