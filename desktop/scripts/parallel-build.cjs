'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');

// Unity must finish generating serialized inputs before this group starts.
// Native outputs have separate obj directories. Resource staging needs the
// admin host, but can overlap Vite. All smoke/integrity checks stay downstream.
function buildTasks(project) {
  const tasks = ['frontend', 'admin-host', 'collector-service', 'collector-center'].map(name => ({
    name: `build:${name}`, command: process.execPath,
    args: [path.join(project, 'desktop/scripts', `build-${name}.cjs`)], cwd: project
  }));
  tasks.splice(2, 0, { name: 'prepare:resources', dependsOn: ['build:admin-host'], command: process.execPath,
    args: [path.join(project, 'desktop/scripts/prepare-all-resources.cjs')], cwd: project });
  return tasks;
}

async function runBuildTasks(tasks, { directory, concurrency = 2, env = process.env,
  createLogStream = file => fs.createWriteStream(file), spawnProcess = spawn, logger = console } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('Build concurrency must be 1-4');
  fs.mkdirSync(directory, { recursive: true });
  const stages = [], started = performance.now();
  let failed = false;
  const names = new Set(tasks.map(task => task.name));
  if (names.size !== tasks.length || tasks.some(task => (task.dependsOn || []).some(name => !names.has(name)))) throw Error('Invalid component dependency graph');
  async function run(task, index) {
    const logFile = path.join(directory, `${index}-${task.name.replace(/[^a-z0-9-]/gi, '-')}.log`);
    logger.log(`开始 ${task.name}；日志：${logFile}`);
    const start = performance.now();
    return new Promise(resolve => {
      let log, child, launchError, logError, finishing = false;
      function finish(code, signal) {
        if (finishing) return;
        finishing = true;
        const record = error => {
          if (error) logError ||= error.message;
          const result = { name: task.name, seconds: +((performance.now()-start)/1000).toFixed(3),
            exitCode: launchError || logError ? -1 : code ?? -1, signal, error: launchError || logError, logFile };
          stages[index] = result;
          if (result.exitCode !== 0) failed = true;
          logger.log(`结束 ${task.name}：${result.seconds} 秒，退出码 ${result.exitCode}`);
          if (result.exitCode !== 0) logger.error(launchError || logError || `构建失败，详见 ${logFile}`);
          resolve(result);
        };
        // end/finish does not wait for the file descriptor's asynchronous
        // close. A later close error must still fail this stage before the
        // scheduler can start dependants or return its report.
        if (!log || log.closed) { record(); return; }
        log.once('close', () => record());
        if (!log.destroyed) log.end(error => {
          if (error) { logError ||= error.message; failed = true; }
        });
      }
      try { log = createLogStream(logFile); }
      catch (error) { logError = error.message; failed = true; finish(-1); return; }
      log.on('error', error => {
        logError ||= error.message;
        failed = true; // Stop queued stages immediately, not only on child close.
        if (!child) { finish(-1); return; }
        // A failed pipe otherwise pauses verbose compilers forever. Keep both
        // pipes drained so already-running stages can exit and be recorded.
        for (const stream of [child.stdout, child.stderr]) stream.unpipe(log);
        queueMicrotask(() => {
          for (const stream of [child.stdout, child.stderr]) stream.resume();
        });
      });
      // Do not launch a build if its evidence file cannot even be opened.
      log.once('open', () => {
        if (finishing) return;
        try {
          child = spawnProcess(task.command, task.args, { cwd: task.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) { launchError = error.message; failed = true; finish(-1); return; }
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        child.once('error', error => { launchError = error.message; failed = true; });
        child.once('close', finish);
      });
    });
  }
  const active = new Map(), launched = new Set();
  while (true) {
    while (!failed && active.size < concurrency) {
      const index = tasks.findIndex((task, i) => !launched.has(i) && (task.dependsOn || [])
        .every(name => stages.some(stage => stage?.name === name && stage.exitCode === 0)));
      if (index < 0) break;
      launched.add(index);
      active.set(index, run(tasks[index], index).finally(() => active.delete(index)));
    }
    if (!active.size) break;
    await Promise.race(active.values());
  }
  const completed = stages.filter(Boolean);
  return { success: !failed && completed.length === tasks.length,
    totalSeconds: +((performance.now()-started)/1000).toFixed(3), concurrency, stages: completed };
}

if (require.main === module) {
  const reportFile = process.argv[2];
  if (!reportFile) throw Error('Expected a build report path');
  runBuildTasks(buildTasks(path.resolve(__dirname, '../..')), { directory: path.join(path.dirname(reportFile), 'component-build-logs') })
    .then(report => { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); if (!report.success) process.exitCode = 1; })
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { buildTasks, runBuildTasks };
