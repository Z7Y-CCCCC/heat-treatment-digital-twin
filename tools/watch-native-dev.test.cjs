const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const watcherScript = path.join(__dirname, 'watch-native-dev.ps1');
const fakeBackendCode = `
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/internal/shutdown' || request.headers['x-shutdown-token'] !== 'test-token') {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(202).end();
    response.once('finish', () => server.close(() => process.exit(0)));
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`;

function waitForFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      stream.off('data', onData);
      resolve(buffer.split('\n')[0].trim());
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

function startTicksFor(children) {
  const ids = children.map(child => child.pid);
  const command = `$ids = @(${ids.join(',')}); foreach ($targetPid in $ids) { (Get-Process -Id $targetPid).StartTime.ToUniversalTime().Ticks }`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const ticks = result.stdout.trim().split(/\s+/);
  assert.equal(ticks.length, children.length);
  return ticks;
}

async function waitForChild(child, milliseconds = 12000) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PID ${child.pid} did not exit`)), milliseconds);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('standalone Unity exit stops owned Vite and requests a backed-up backend shutdown',
  { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const backend = spawn(process.execPath, ['-e', fakeBackendCode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const frontend = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    const unity = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { windowsHide: true, stdio: 'ignore' });
    let watcher;
    try {
      const port = Number(await waitForFirstLine(backend.stdout));
      assert.ok(port > 0);
      const [unityTicks, backendTicks, frontendTicks] = startTicksFor([unity, backend, frontend]);
      watcher = spawn('pwsh', [
        '-NoProfile', '-File', watcherScript,
        '-UnityPid', String(unity.pid), '-UnityStartTicks', unityTicks,
        '-BackendPid', String(backend.pid), '-BackendStartTicks', backendTicks,
        '-FrontendPid', String(frontend.pid), '-FrontendStartTicks', frontendTicks,
        '-BackendUrl', `http://127.0.0.1:${port}`
      ], { windowsHide: true, env: { ...process.env, DIGITAL_TWIN_DEV_SHUTDOWN_TOKEN: 'test-token' } });
      let output = '';
      let errors = '';
      watcher.stdout.on('data', chunk => { output += chunk.toString(); });
      watcher.stderr.on('data', chunk => { errors += chunk.toString(); });
      await waitForChild(watcher);
      assert.equal(watcher.exitCode, 0, errors);
      await Promise.all([waitForChild(frontend), waitForChild(backend)]);
      assert.match(output, /后端已安全退出/);
    } finally {
      for (const child of [watcher, unity, frontend, backend]) {
        if (child && child.exitCode == null && child.signalCode == null) child.kill();
      }
    }
  });

test('failed backup-safe shutdown leaves the backend alive for diagnosis',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const backend = spawn(process.execPath, ['-e', fakeBackendCode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const unity = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], { windowsHide: true, stdio: 'ignore' });
    let watcher;
    try {
      const port = Number(await waitForFirstLine(backend.stdout));
      const [unityTicks, backendTicks] = startTicksFor([unity, backend]);
      watcher = spawn('pwsh', [
        '-NoProfile', '-File', watcherScript,
        '-UnityPid', String(unity.pid), '-UnityStartTicks', unityTicks,
        '-BackendPid', String(backend.pid), '-BackendStartTicks', backendTicks,
        '-BackendUrl', `http://127.0.0.1:${port}`
      ], { windowsHide: true, env: { ...process.env, DIGITAL_TWIN_DEV_SHUTDOWN_TOKEN: 'wrong-token' } });
      await waitForChild(watcher);
      assert.equal(watcher.exitCode, 1);
      assert.equal(backend.exitCode, null);
      assert.equal(backend.signalCode, null);
    } finally {
      for (const child of [watcher, unity, backend]) {
        if (child && child.exitCode == null && child.signalCode == null) child.kill();
      }
    }
  });
