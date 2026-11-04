'use strict';
// Build-time only: update the resource-only NSIS UI using the Windows API.
// No new installer plugin, browser, compiler or customer runtime is required.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { layout, dialogResource, resourceManifest } = require('./installer-layout.cjs');
if (process.platform !== 'win32') throw new Error('Generate native installer resources on Windows');
const root = path.resolve(__dirname, '..');
const seed = process.env.NSIS_UI_SEED || path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/Contrib/UIs/modern.exe');
const target = path.join(root, 'assets/installer-ui.bin');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'display-installer-ui-'));
try {
  const candidate = path.join(scratch, 'installer-ui.exe'); fs.copyFileSync(seed, candidate);
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const ps = `$ErrorActionPreference='Stop'; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class InstallerResource {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr BeginUpdateResource(string path,bool delete);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool UpdateResource(IntPtr h,IntPtr type,IntPtr name,ushort language,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool EndUpdateResource(IntPtr h,bool discard);
}
'@;
$h=[InstallerResource]::BeginUpdateResource(${quote(candidate)},$false); if($h -eq [IntPtr]::Zero){throw 'BeginUpdateResource failed'};
try { ${layout.dialogs.map(d => `$b=[Convert]::FromBase64String('${dialogResource(d).toString('base64')}'); if(-not [InstallerResource]::UpdateResource($h,[IntPtr]5,[IntPtr]${d.id},1033,$b,$b.Length)){throw 'UpdateResource ${d.id} failed'};`).join('\n')}
 if(-not [InstallerResource]::EndUpdateResource($h,$false)){throw 'EndUpdateResource failed'}; $h=[IntPtr]::Zero;
} finally { if($h -ne [IntPtr]::Zero){[InstallerResource]::EndUpdateResource($h,$true)|Out-Null} }`;
  const script = path.join(scratch, 'resources.ps1'); fs.writeFileSync(script, '\ufeff' + ps);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: 'inherit' });
  // Keep only data-loading semantics: this is a UI resource DLL container, not
  // a redistributable executable or an additional installation engine.
  const binary = fs.readFileSync(candidate), pe = binary.readUInt32LE(0x3c);
  if (binary.readUInt16LE(pe + 24) !== 0x10b) throw new Error('Unexpected NSIS resource format');
  binary.writeUInt16LE(binary.readUInt16LE(pe + 22) | 0x2000, pe + 22);
  binary.writeUInt32LE(0, pe + 24 + 16);
  binary.fill(0, pe + 24 + 104, pe + 24 + 112); // no import directory
  fs.writeFileSync(target, binary);
  fs.writeFileSync(path.join(root, 'assets/installer-ui.json'), JSON.stringify(resourceManifest(target), null, 2) + '\n');
  console.log(`Native installer UI: ${fs.statSync(target).size} bytes`);
} finally {
  const relative = path.relative(os.tmpdir(), scratch);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(scratch).startsWith('display-installer-ui-')) throw new Error('Refusing unsafe temporary cleanup');
  fs.rmSync(scratch, { recursive: true, force: true });
}
