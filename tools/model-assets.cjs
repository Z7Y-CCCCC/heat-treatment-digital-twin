// Shared model inventory and safe, explicit synchronization. No runtime DB access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOTS = ['backend/assets/models', 'backend/assets/motions', 'unity-client/Assets/Equipment', 'unity-client/Assets/StreamingAssets', 'frontend/public/assets/models'];
const CATALOG = 'model-assets.manifest.json';
const CONFIG = 'model-assets.aliases.json';
const EXTENSIONS = /\.(glb|gltf|blend|fbx|obj|mtl)$/i;
const POINTER = 'version https://git-lfs.github.com/spec/v1';
const git = (root, args) => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function safe(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe model path');
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escaped workspace');
  return result;
}
function collect(root) {
  const names = [...new Set(git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', ...ROOTS]).split('\0').filter(n => EXTENSIONS.test(n)))];
  const dependencies = new Set(names);
  for (const name of names.filter(n => /\.gltf$/i.test(n))) {
    const bytes = fs.readFileSync(safe(root, name));
    if (bytes.subarray(0, POINTER.length).toString() === POINTER) throw new Error(`${name}: Git LFS 文件未下载，请运行 git lfs pull`);
    const doc = JSON.parse(bytes.toString('utf8'));
    for (const resource of [...(doc.buffers || []), ...(doc.images || [])]) {
      if (!resource.uri || resource.uri.startsWith('data:')) continue;
      if (/^[a-z]+:/i.test(resource.uri)) throw new Error(`${name}: 外部资源不能离线共享`);
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(resource.uri)));
      safe(root, relative); dependencies.add(relative);
    }
  }
  return [...dependencies].sort();
}
function describe(root, name) {
  const file = safe(root, name); if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${name}: model symlinks are not portable`);
  const data = fs.readFileSync(file);
  if (data.subarray(0, POINTER.length).toString() === POINTER) throw new Error(`${name}: Git LFS 文件未下载，请运行 git lfs pull`);
  if (/\.glb$/i.test(name) && (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(8) !== data.length)) throw new Error(`${name}: 无效或不完整 GLB`);
  return { path: name, bytes: data.length, sha256: hash(data) };
}
function config(root) { return JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')); }
function inspect(root, manifest) {
  const expected = new Map(manifest.files.map(f => [f.path, f])); const names = collect(root); const actual = new Set(names); const errors = [];
  for (const name of names) {
    if (!expected.has(name)) { errors.push(`${name}: 尚未纳入清单`); continue; }
    try { const got = describe(root, name); const want = expected.get(name); if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) errors.push(`${name}: 内容已变，请核对后更新清单`); }
    catch (error) { errors.push(error.message); }
  }
  for (const name of expected.keys()) if (!actual.has(name)) errors.push(`${name}: 缺失或被 Git 忽略`);
  for (const mirror of config(root).mirrors || []) {
    const values = mirror.map(n => describe(root, n).sha256);
    if (new Set(values).size !== 1) errors.push(`模型源与 Unity 镜像不同步: ${mirror.join(' / ')}`);
  }
  return { valid: errors.length === 0, files: names.length, errors };
}
function restoreUploads(root, manifest) {
  const records = new Map(manifest.files.map(f => [f.path, f])); const planned = [];
  for (const alias of config(root).uploads || []) {
    if (!/^backend\/uploads\/models\/[^/]+\.(glb|gltf)$/i.test(alias.target)) throw new Error('Unsafe upload target');
    const record = records.get(alias.source); if (!record) throw new Error(`未登记源文件: ${alias.source}`);
    const source = safe(root, alias.source); const target = safe(root, alias.target);
    if (hash(fs.readFileSync(source)) !== record.sha256) throw new Error(`源模型已变: ${alias.source}`);
    if (fs.existsSync(target)) {
      if (hash(fs.readFileSync(target)) !== record.sha256) throw new Error(`保留本机不同版本，未覆盖: ${alias.target}`);
    } else planned.push({ source, target });
  }
  // Preflight every conflict before writing anything; EXCL also protects races.
  for (const { source, target } of planned) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
  return planned.length;
}
function main(root, args) {
  const command = args[0] || '--check';
  if (!['--check', '--update', '--restore-uploads', '--sync'].includes(command)) throw new Error('使用 --check / --update / --restore-uploads / --sync');
  if (command === '--sync') {
    if (git(root, ['branch', '--show-current']).trim() !== 'main') throw new Error('当前不是 main。请先保存并合并开发分支，再在 main 同步；不会自动切分支或覆盖改动。');
    if (git(root, ['status', '--porcelain']).trim()) throw new Error('有未提交改动，请先提交或自行备份；同步已停止。');
    git(root, ['lfs', 'version']); git(root, ['pull', '--ff-only', 'origin', 'main']); git(root, ['lfs', 'pull', 'origin']);
  }
  if (command === '--update') {
    const manifest = { version: 1, roots: ROOTS, files: collect(root).map(n => describe(root, n)) };
    const result = inspect(root, manifest); if (!result.valid) throw new Error(result.errors.join('\n'));
    fs.writeFileSync(path.join(root, CATALOG), JSON.stringify(manifest, null, 2) + '\n');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, CATALOG), 'utf8')); const result = inspect(root, manifest);
  if (!result.valid) throw new Error(result.errors.join('\n'));
  if (['--restore-uploads', '--sync'].includes(command)) result.restoredUploads = restoreUploads(root, manifest);
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (require.main === module) { try { main(path.resolve(__dirname, '..'), process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { safe, collect, describe, inspect, restoreUploads, main };
