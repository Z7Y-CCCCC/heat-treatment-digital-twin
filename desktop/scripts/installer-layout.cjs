'use strict';
// Native Win32 dialog resources. Coordinates are dialog units, not fixed pixels:
// Windows scales both the layout and fonts with the display DPI.
const fs = require('node:fs');
const crypto = require('node:crypto');
const C = { BUTTON: 0x80, EDIT: 0x81, STATIC: 0x82 };
const control = (id, cls, x, y, w, h, text = '', style = 0x50020000, ex = 0) => ({ id, cls, x, y, w, h, text, style, ex });
const layout = {
  version: 2,
  font: 'Microsoft YaHei UI', fontSize: 9,
  dialogs: [
    { id: 105, w: 410, h: 214, style: 0x80c800c4, ex: 0x00000100, controls: [
      // MUI-required controls and placeholders remain native and keyboard-accessible.
      control(3, C.BUTTON, 0, 0, 0, 0, '', 0x40010000),
      control(1, C.BUTTON, 278, 175, 102, 24, '', 0x50010001),
      control(2, C.BUTTON, 278, 175, 102, 24, '', 0x50010000),
      control(1018, C.STATIC, 30, 83, 350, 81, '', 0x40020004),
      control(1044, C.STATIC, 30, 83, 350, 81, '', 0x40020004),
      control(1035, C.STATIC, 0, 0, 0, 0, '', 0x40020010),
      control(1036, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1045, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1256, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1028, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1034, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1037, C.STATIC, 74, 26, 306, 24),
      control(1038, C.STATIC, 74, 54, 306, 15),
      control(1039, C.STATIC, 30, 28, 28, 28, '', 0x50000203),
      control(1220, C.STATIC, 30, 181, 170, 12),
    ] },
    { id: 106, w: 350, h: 81, style: 0x40000440, controls: [
      control(1027, C.BUTTON, 0, 61, 68, 18, '查看详情', 0x50010000),
      control(1004, 'msctls_progress32', 0, 30, 350, 5, '', 0x50000001),
      control(1006, C.STATIC, 0, 2, 350, 20, '', 0x50004080),
      control(1016, 'SysListView32', 0, 43, 350, 38, '', 0x40814005),
      control(1230, C.STATIC, 0, 43, 350, 14, '运行环境随安装包自动配置'),
    ] },
  ],
};
function wide(value) { return Buffer.from(value + '\0', 'utf16le'); }
function field(value) {
  if (typeof value === 'number') { const b = Buffer.alloc(4); b.writeUInt16LE(0xffff); b.writeUInt16LE(value, 2); return b; }
  return wide(value || '');
}
function dialogResource(dialog) {
  const chunks = []; let length = 0;
  const add = b => { chunks.push(b); length += b.length; };
  const align = () => { if (length % 4) add(Buffer.alloc(4 - length % 4)); };
  const h = Buffer.alloc(26);
  h.writeUInt16LE(1); h.writeUInt16LE(0xffff, 2);
  h.writeUInt32LE(dialog.ex || 0, 8); h.writeUInt32LE(dialog.style, 12);
  h.writeUInt16LE(dialog.controls.length, 16); h.writeInt16LE(dialog.w, 22); h.writeInt16LE(dialog.h, 24);
  add(h); add(field('')); add(field('')); add(field(''));
  const font = Buffer.alloc(6); font.writeUInt16LE(layout.fontSize); font.writeUInt16LE(400, 2); font[5] = 1;
  add(font); add(wide(layout.font));
  for (const c of dialog.controls) {
    align(); const b = Buffer.alloc(24);
    b.writeUInt32LE(c.ex || 0, 4); b.writeUInt32LE(c.style, 8);
    [c.x, c.y, c.w, c.h].forEach((n, i) => b.writeInt16LE(n, 12 + i * 2)); b.writeUInt32LE(c.id, 20);
    add(b); add(field(c.cls)); add(field(c.text)); add(Buffer.alloc(2));
  }
  return Buffer.concat(chunks);
}
function resourceManifest(file) {
  return { ...layout, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
module.exports = { layout, dialogResource, resourceManifest };
