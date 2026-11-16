'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fingerprintInputs, buildCachedNative } = require('./native-build-cache.cjs');
const { buildTasks, runBuildTasks } = require('./parallel-build.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('native cache invalidates changed sources, SDK, restored dependencies, corrupt, missing and extra outputs', async t => {
  const root = fixture(t), input = path.join(root, 'source.cs'), output = path.join(root, 'cache');
  fs.writeFileSync(input, 'v1');
  let sdk = 'sdk-1', state = 'restore-1', builds = 0;
  const options = { output, required: ['app.exe'], fingerprint: () => fingerprintInputs([input], sdk), restoredState: () => state,
    build: staging => { fs.writeFileSync(path.join(staging, 'app.exe'), 'app-' + ++builds); } };
  const run = overrides => buildCachedNative({ ...options, ...overrides });
  assert.equal((await run()).reused, false); assert.equal((await run()).reused, true);
  for (const change of [() => fs.writeFileSync(input, 'v2'), () => { sdk = 'sdk-2'; }, () => { state = 'restore-2'; },
    () => fs.writeFileSync(path.join(output, 'app.exe'), 'corrupt'), () => fs.unlinkSync(path.join(output, 'app.exe')),
    () => fs.writeFileSync(path.join(output, 'stale.dll'), 'stale')]) {
    change(); assert.equal((await run()).reused, false); assert.equal((await run()).reused, true);
  }
  assert.equal(fs.existsSync(path.join(output, 'stale.dll')), false);
  assert.equal((await run({ force: true })).reused, false);
  assert.equal(builds, 8);
});

test('failed or concurrently edited native builds preserve the previous complete output and cache proof', async t => {
  const root = fixture(t), input = path.join(root, 'source.cs'), output = path.join(root, 'cache');
  fs.writeFileSync(input, 'v1');
  const options = { output, required: ['app.exe'], fingerprint: () => fingerprintInputs([input]),
    build: staging => fs.writeFileSync(path.join(staging, 'app.exe'), 'complete') };
  await buildCachedNative(options);
  const proof = fs.readFileSync(output + '.build.json', 'utf8');
  await assert.rejects(buildCachedNative({ ...options, force: true, build: () => { throw Error('compiler failed'); } }), /compiler failed/);
  await assert.rejects(buildCachedNative({ ...options, force: true, build: staging => {
    fs.writeFileSync(path.join(staging, 'app.exe'), 'partial'); fs.writeFileSync(input, 'changed during compilation');
  } }), /inputs changed/);
  assert.equal(fs.readFileSync(path.join(output, 'app.exe'), 'utf8'), 'complete');
  assert.equal(fs.readFileSync(output + '.build.json', 'utf8'), proof);
});

test('parallel component builds overlap, retain per-stage logs and forward environment', async t => {
  const root = fixture(t), events = path.join(root, 'events'); fs.mkdirSync(events);
  const task = n => ({ name: `task-${n}`, command: process.execPath, cwd: root, args: ['-e', `
    const fs=require('node:fs'),path=require('node:path');
    if(process.env.PACK_BUILD_TEST !== 'forwarded')process.exit(9);
    const dir=process.argv[1], n=process.argv[2];
    fs.writeFileSync(path.join(dir,n+'.started'),'');
    const deadline=Date.now()+5000;
    const timer=setInterval(()=>{
      if(['1','2'].every(id=>fs.existsSync(path.join(dir,id+'.started')))) {
        clearInterval(timer); fs.writeFileSync(path.join(dir,n+'.done'),''); console.log('完成 '+n);
      } else if(Date.now()>deadline){clearInterval(timer);process.exitCode=4;}
    },10);`, events, String(n)] });
  const result = await runBuildTasks([task(1), task(2), task(3)], { directory: path.join(root, 'logs'), concurrency: 2, env: { ...process.env, PACK_BUILD_TEST: 'forwarded' } });
  assert.equal(result.success, true); assert.equal(result.stages.length, 3);
  for (const stage of result.stages) { assert.equal(stage.exitCode, 0); assert.match(fs.readFileSync(stage.logFile, 'utf8'), /完成/); }
  const plan = buildTasks(root);
  assert.deepEqual(plan.map(task => task.name), ['build:frontend', 'build:admin-host', 'prepare:resources', 'build:collector-service', 'build:collector-center']);
  assert.deepEqual(plan.find(task => task.name === 'prepare:resources').dependsOn, ['build:admin-host']);
});

test('failed parallel build stops queued tasks, waits for running tasks and records failures', async t => {
  const root = fixture(t), completed = path.join(root, 'completed');
  const tasks = [
    { name: 'failure', command: process.execPath, args: ['-e', 'process.exit(7)'] },
    { name: 'running', command: process.execPath, args: ['-e', `setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),200)`, completed] },
    { name: 'queued', command: process.execPath, args: ['-e', 'process.exit(0)'] }
  ];
  const result = await runBuildTasks(tasks, { directory: path.join(root, 'logs'), concurrency: 2 });
  assert.equal(result.success, false); assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].exitCode, 7); assert.equal(fs.readFileSync(completed, 'utf8'), 'done');
  const missing = await runBuildTasks([{ name: 'missing', command: path.join(root, 'missing.exe'), args: [] }], { directory: path.join(root, 'missing-logs') });
  assert.equal(missing.success, false); assert.equal(missing.stages[0].exitCode, -1);
});

test('resource-like dependent tasks wait for their producer and never run after a failed producer', async t => {
  const root = fixture(t), ready = path.join(root, 'ready');
  const producer = { name: 'host', command: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1],'ready')", ready] };
  const consumer = { name: 'resources', dependsOn: ['host'], command: process.execPath, args: ['-e', "if(!require('node:fs').existsSync(process.argv[1]))process.exit(8)", ready] };
  const result = await runBuildTasks([consumer, producer], { directory: path.join(root, 'ordered'), concurrency: 2 });
  assert.equal(result.success, true);
  const failed = await runBuildTasks([consumer, { ...producer, args: ['-e', 'process.exit(7)'] }], { directory: path.join(root, 'failed'), concurrency: 2 });
  assert.equal(failed.success, false); assert.deepEqual(failed.stages.map(stage => stage.name), ['host']);
});
