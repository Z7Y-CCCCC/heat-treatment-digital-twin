'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Shared by npm and the parallel release graph. Keep ordering: notices consume
// prepared MySQL/FFmpeg metadata; prerequisites retain Microsoft verification.
for (const name of ['prepare-resources.cjs', 'prepare-ffmpeg.cjs', 'generate-third-party-notices.cjs', 'prepare-prerequisites.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
