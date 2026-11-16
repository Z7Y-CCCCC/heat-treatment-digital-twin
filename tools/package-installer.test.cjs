'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { compressionOptions } = require('./package-installer.cjs');
const archiver = require('../desktop/node_modules/7zip-bin').path7za;
const { compute7zCompressArgs } = require('../desktop/node_modules/app-builder-lib/out/targets/archive.js');

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
