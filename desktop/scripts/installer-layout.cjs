'use strict';
// Native Win32 dialog resources. Coordinates are dialog units, not fixed pixels:
// Windows scales both the layout and fonts with the display DPI.
const fs = require('node:fs');
const crypto = require('node:crypto');
const C = { BUTTON: 0x80, EDIT: 0x81, STATIC: 0x82 };
const control = (id, cls, x, y, w, h, text = '', style = 0x50020000, ex = 0) => ({ id, cls, x, y, w, h, text, style, ex });
const layout = {
  version: 8,
  font: 'Microsoft YaHei UI', fontSize: 9,
  dialogs: [
    // No DS_MODALFRAME: even a captionless dialog otherwise gets a white rim.
    { id: 105, w: 460, h: 358, style: 0x80080044, ex: 0x00040000, controls: [
      // MUI-required controls and placeholders remain native and keyboard-accessible.
      control(3, C.BUTTON, 0, 0, 0, 0, '', 0x40010000),
      control(1, C.BUTTON, 155, 249, 150, 28, '', 0x50010001),
      control(2, C.BUTTON, 438, 0, 22, 20, '×', 0x50010000),
      control(1018, C.STATIC, 24, 289, 412, 50, '', 0x40020004),
      control(1044, C.STATIC, 24, 249, 412, 88, '', 0x40020004),
      control(1036, C.STATIC, 0, 0, 460, 230, '', 0x5400020e),
      control(1035, C.STATIC, 24, 60, 412, 13, 'HEAT TREATMENT / DIGITAL TWIN', 0x50020001),
      control(1045, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1256, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1028, C.STATIC, 0, 0, 0, 0, '', 0x40020000),
      control(1034, C.STATIC, 260, 345, 176, 10, '连接 · 监控 · 可视化', 0x50020002),
      control(1037, C.STATIC, 24, 80, 412, 25, '', 0x50020001),
      control(1038, C.STATIC, 24, 115, 412, 17, '', 0x50020001),
      control(1039, C.STATIC, 205, 17, 50, 37, 'DT', 0x50020001),
      control(1220, C.STATIC, 24, 345, 210, 10),
    ] },
    { id: 106, w: 412, h: 88, style: 0x40000440, controls: [
      control(1027, C.BUTTON, 0, 72, 68, 14, '查看详情', 0x50010000),
      control(1004, 'msctls_progress32', 0, 20, 412, 5, '', 0x50000001),
      control(1006, C.STATIC, 0, 0, 412, 18, '', 0x50000000),
      control(1016, 'SysListView32', 0, 31, 412, 43, '', 0x40814005),
      control(1230, C.STATIC, 0, 78, 412, 10, '安装日志将保留在临时目录', 0x50004080),
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
