// File-only recovery of this application's autosaved draft. Does not open a
// browser, inspect cookies, send input, or change the live WebView profile.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop', 'webview2', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
const args = process.argv.slice(2), outputIndex = args.indexOf('--out');
const destination = outputIndex < 0 ? path.join(root, 'output', 'binding-workflow-redesign-20261109', 'resume', 'local-draft-backup') : path.resolve(args[outputIndex + 1]);
const relativeOutput = path.relative(path.join(root, 'output'), destination);
assert.ok(relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput), 'Recovery evidence must remain in workspace output');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const state = JSON.parse(fs.readFileSync(path.join(root, 'output/binding-workflow-redesign-20261109/resume/before-resume-live-state.json'), 'utf8'));
const records = new Map();

function uint(bytes, cursor) {
  let value = 0, factor = 1;
  for (let n = 0; n < 10; n++) {
    assert.ok(cursor.pos < bytes.length, 'Truncated varint');
    const byte = bytes[cursor.pos++]; value += (byte & 127) * factor;
    assert.ok(Number.isSafeInteger(value), 'Oversized varint');
    if (!(byte & 128)) return value;
    factor *= 128;
  }
  throw Error('Invalid varint');
}
function snappy(bytes) {
  const cursor = { pos: 0 }, size = uint(bytes, cursor);
  assert.ok(size <= 64 * 1024 * 1024, 'Oversized data block');
  const output = Buffer.alloc(size); let position = 0;
  while (cursor.pos < bytes.length) {
    const tag = bytes[cursor.pos++], kind = tag & 3; let length, offset;
    if (!kind) {
      length = tag >>> 2;
      if (length < 60) length++;
      else { const count = length - 59; assert.ok(count <= 4 && cursor.pos + count <= bytes.length); length = 1; for (let n = 0; n < count; n++) length += bytes[cursor.pos++] * 2 ** (8 * n); }
      assert.ok(position + length <= size && cursor.pos + length <= bytes.length);
      bytes.copy(output, position, cursor.pos, cursor.pos + length); cursor.pos += length; position += length;
    } else {
      if (kind === 1) { assert.ok(cursor.pos < bytes.length); length = 4 + ((tag >>> 2) & 7); offset = ((tag & 224) << 3) | bytes[cursor.pos++]; }
      else if (kind === 2) { assert.ok(cursor.pos + 2 <= bytes.length); length = 1 + (tag >>> 2); offset = bytes.readUInt16LE(cursor.pos); cursor.pos += 2; }
      else { assert.ok(cursor.pos + 4 <= bytes.length); length = 1 + (tag >>> 2); offset = bytes.readUInt32LE(cursor.pos); cursor.pos += 4; }
      assert.ok(offset > 0 && offset <= position && position + length <= size);
      for (let n = 0; n < length; n++) output[position + n] = output[position + n - offset];
      position += length;
    }
  }
  assert.equal(position, size); return output;
}
function block(file, offset, size) {
  assert.ok(offset >= 0 && size >= 0 && offset + size + 5 <= file.length);
  const value = file.subarray(offset, offset + size), compression = file[offset + size];
  if (compression === 0) return value;
  assert.equal(compression, 1, 'Unsupported LevelDB compression'); return snappy(value);
}
function entries(bytes) {
  assert.ok(bytes.length >= 4); const restarts = bytes.readUInt32LE(bytes.length - 4), end = bytes.length - 4 - restarts * 4;
  assert.ok(restarts >= 1 && end >= 0); const cursor = { pos: 0 }, values = []; let previous = Buffer.alloc(0);
  while (cursor.pos < end) {
    const shared = uint(bytes, cursor), unshared = uint(bytes, cursor), length = uint(bytes, cursor);
    assert.ok(shared <= previous.length && cursor.pos + unshared + length <= end);
    const key = Buffer.concat([previous.subarray(0, shared), bytes.subarray(cursor.pos, cursor.pos + unshared)]); cursor.pos += unshared;
    const value = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length; previous = key; values.push({ key, value });
  }
  assert.equal(cursor.pos, end); return values;
}
function remember(key, value, sequence, type) {
  // Only the named application's loopback origin and the designer draft key.
  if (!key.includes(Buffer.from('_http://127.0.0.1:3001\0')) || !key.includes(Buffer.from('dashboard-designer-draft:'))) return;
  const name = key.toString('base64'), old = records.get(name);
  if (!old || old.sequence < sequence) records.set(name, { key: key.toString('utf8'), value, sequence, type });
}
function table(file) {
  assert.ok(file.length >= 48); assert.equal(file.readBigUInt64LE(file.length - 8), 0xdb4775248b80fb57n, 'Invalid table footer');
  const footer = { pos: file.length - 48 }; uint(file, footer); uint(file, footer);
  const offset = uint(file, footer), size = uint(file, footer);
  for (const index of entries(block(file, offset, size))) {
    const handle = { pos: 0 }, dataOffset = uint(index.value, handle), dataSize = uint(index.value, handle);
    for (const entry of entries(block(file, dataOffset, dataSize))) {
      assert.ok(entry.key.length >= 8); const packed = entry.key.readBigUInt64LE(entry.key.length - 8);
      remember(entry.key.subarray(0, -8), entry.value, packed >> 8n, Number(packed & 255n));
    }
  }
}
function batch(bytes) {
  assert.ok(bytes.length >= 12); const sequence = bytes.readBigUInt64LE(0), count = bytes.readUInt32LE(8), cursor = { pos: 12 };
  for (let n = 0; n < count; n++) {
    const type = bytes[cursor.pos++]; assert.ok(type === 0 || type === 1);
    const keyLength = uint(bytes, cursor); assert.ok(cursor.pos + keyLength <= bytes.length);
    const key = bytes.subarray(cursor.pos, cursor.pos + keyLength); cursor.pos += keyLength;
    let value = Buffer.alloc(0);
    if (type === 1) { const length = uint(bytes, cursor); assert.ok(cursor.pos + length <= bytes.length); value = bytes.subarray(cursor.pos, cursor.pos + length); cursor.pos += length; }
    remember(key, value, sequence + BigInt(n), type);
  }
  assert.equal(cursor.pos, bytes.length);
}
function log(bytes) {
  let position = 0, fragments = [];
  while (position < bytes.length) {
    const remaining = 32768 - position % 32768;
    if (remaining < 7) { position += remaining; continue; }
    assert.ok(position + 7 <= bytes.length, 'Incomplete autosave log header');
    const length = bytes.readUInt16LE(position + 4), type = bytes[position + 6];
    if (!length && !type) { position += remaining; continue; }
    assert.ok(position + 7 + length <= bytes.length && length + 7 <= remaining, 'Incomplete autosave log record');
    const value = bytes.subarray(position + 7, position + 7 + length); position += 7 + length;
    if (type === 1) batch(value);
    else if (type === 2) fragments = [value];
    else if (type === 3) fragments.push(value);
    else if (type === 4) { fragments.push(value); batch(Buffer.concat(fragments)); fragments = []; }
    else throw Error('Invalid autosave log fragment');
  }
  assert.equal(fragments.length, 0, 'Incomplete autosave log batch');
}
function main() {
  const real = fs.realpathSync(source), appRoot = fs.realpathSync(path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop'));
  assert.ok(!path.relative(appRoot, real).startsWith('..'), 'Draft store must remain inside this application profile');
  fs.mkdirSync(destination, { recursive: true });
  const names = fs.readdirSync(source).filter(name => name !== 'LOCK').sort(), proof = [];
  for (const name of names) {
    const input = path.join(source, name); if (!fs.statSync(input).isFile()) continue;
    const bytes = fs.readFileSync(input); fs.writeFileSync(path.join(destination, name), bytes); proof.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const item of proof) assert.equal(hash(fs.readFileSync(path.join(source, item.name))), item.sha256, 'Local autosave changed during backup; retry before restart');
  for (const item of proof) { const bytes = fs.readFileSync(path.join(destination, item.name)); if (/\.ldb$/.test(item.name)) table(bytes); else if (/^\d+\.log$/.test(item.name) && bytes.length) log(bytes); }
  const drafts = [];
  for (const item of records.values()) {
    if (item.type !== 1) continue;
    const value = item.value, text = value[0] === 0 ? value.subarray(1).toString('utf16le') : value[0] === 1 ? value.subarray(1).toString('latin1') : value.toString('utf8');
    const record = JSON.parse(text);
    if (record.document?.sceneId === state.document.sceneId && record.factoryId === state.document.metadata?.factoryId) drafts.push(record);
    else if (record.document?.sceneId === state.document.sceneId && record.factoryId === 'factory_default') drafts.push(record);
  }
  assert.ok(drafts.length, 'No exact scene autosave found; preserve the copied store and do not restart yet');
  fs.writeFileSync(path.join(destination, 'files.json'), JSON.stringify({ source, stableCopyVerified: true, proof }, null, 2));
  fs.writeFileSync(path.join(destination, 'local-editor-draft.json'), JSON.stringify(drafts[0], null, 2));
  fs.writeFileSync(path.join(destination, 'local-editor-document.json'), JSON.stringify(drafts[0].document, null, 2));
  const summary = { success: true, backupDirectory: destination, stableCopyVerified: true, untouchedLiveProfile: true, cookiesExcluded: true,
    sceneId: drafts[0].document.sceneId, widgets: drafts[0].document.widgets.length, baselineWidgets: drafts[0].baselineDocument?.widgets.length,
    serverRevision: drafts[0].serverRevision, savedAt: drafts[0].savedAt, export: path.join(destination, 'local-editor-document.json') };
  fs.writeFileSync(path.join(destination, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
module.exports = { snappy, entries };
