'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { createRunDirectory, requireTestPath } = require('../../backend/scripts/integration-test-utils.cjs');
const cache = require('./native-build-cache.cjs');

// Execute the production entrypoints and cache with only the compiler boundary
// mocked. All source/output/tool files belong to this disposable output tree;
// no actual dotnet/csc, installed service, machine configuration or UI is used.
function fixture(t) {
  const root = createRunDirectory('native-build-inputs');
  t.after(() => fs.rmSync(requireTestPath(root), { recursive: true, force: true }));
  const state = { root, platform: process.platform, sdk: '8.0.100', centerBuilds: 0, serviceBuilds: 0, invocations: [] };
  state.file = (relative, text = 'owned-fixture') => {
    const target = requireTestPath(path.join(root, relative));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target;
  };
  state.env = { SystemRoot: path.join(root, 'Windows'), PATH: 'owned-sdk-path', USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'profile'), Version: '1.0.0', DefineConstants: 'BASE',
    VIRTUAL_TEST_SECRET: 'fixture-value-must-not-be-persisted' };
  state.framework = path.join(root, 'Windows/Microsoft.NET/Framework64/v4.0.30319');
  const centerText = fs.readFileSync(path.join(__dirname, 'build-collector-center.cjs'), 'utf8');
  for (const name of new Set([...centerText.matchAll(/'([^']+\.dll)'/g)].map(match => match[1]))) {
    state.file(path.relative(root, path.join(state.framework, name)));
  }
  for (const name of ['csc.exe', 'csc.exe.config', 'csc.rsp']) state.file(path.relative(root, path.join(state.framework, name)));
  for (const name of ['Program.cs', 'Operations.cs', 'CenterForm.cs', 'CenterNavigation.cs', 'PointClient.cs', 'PointPanel.cs',
    'SelfTests.cs', 'app.manifest', 'HeatTreatmentCollectorCenter.exe.config']) state.file('collector-center/' + name);
  state.file('collector-service/Program.cs'); state.file('collector-service/HeatTreatmentCollector.csproj');
  state.file('collector-service/worker.cjs'); state.file('shared/DependencyArchive.cs'); state.file('desktop/assets/icon.ico');
  for (const name of ['mysqlRuntime.cjs', 'directoryPublish.cjs', 'logManager.cjs', 'processLifecycle.cjs', 'templateData.cjs']) state.file('desktop/' + name);
  state.value = (environment, name) => environment[state.platform === 'win32' ? name.toUpperCase() : name];
  state.spawnSync = (command, args, options) => {
    assert.equal(Object.isFrozen(options.env), true, 'tools receive the immutable fingerprinted environment');
    assert.equal(state.value(options.env, 'USERPROFILE'), state.env.USERPROFILE, 'normal SDK/home inputs are retained');
    state.invocations.push({ command, args, environment: options.env });
    if (args[0] === '--version') {
      state.onSdk?.(); return { status: 0, stdout: state.sdk + '\n' };
    }
    if (args[0] === 'publish') {
      state.serviceBuilds++;
      fs.writeFileSync(path.join(args[args.indexOf('-o') + 1], 'HeatTreatmentCollector.exe'), 'Version=' + state.value(options.env, 'Version'));
      state.file('collector-service/obj/project.assets.json', '{"mockRestore":"stable"}');
      state.onService?.(); return { status: 0 };
    }
    assert.equal(command, path.join(state.framework, 'csc.exe'));
    assert.ok(args.includes('/noconfig'), 'the compiler cannot consume a machine-local response file');
    assert.ok(args.includes('/nostdlib+'), 'the standard library is explicit, not an implicit lookup');
    const references = args.filter(argument => argument.startsWith('/reference:')).map(argument => argument.slice(11));
    for (const name of ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
      'System.ServiceProcess.dll', 'System.Web.Extensions.dll', 'System.Net.Http.dll']) {
      assert.ok(references.includes(path.join(state.framework, name)), 'fixed reference: ' + name);
    }
    assert.ok(references.every(file => fs.existsSync(file)), 'all references use owned explicit files');
    state.centerBuilds++;
    fs.writeFileSync(args.find(argument => argument.startsWith('/out:')).slice(5), 'explicit-reference-build-' + state.centerBuilds);
    state.onCenter?.(); return { status: 0 };
  };
  state.load = name => {
    const original = path.join(__dirname, name), filename = state.file('desktop/scripts/' + name, fs.readFileSync(original));
    const loader = createRequire(original), module = { exports: {} };
    const mockRequire = dependency => {
      if (dependency === 'node:child_process') return { spawnSync: state.spawnSync };
      if (dependency === './native-build-cache.cjs') return { ...cache,
        snapshotBuildEnvironment: (env = state.env) => cache.snapshotBuildEnvironment(env, state.platform),
        fingerprintBuildEnvironment: (env = state.env) => cache.fingerprintBuildEnvironment(env, state.platform),
        assertBuildEnvironmentUnchanged: snapshot => cache.assertBuildEnvironmentUnchanged(snapshot, state.env, state.platform) };
      return loader(dependency);
    };
    // The CLI guard is evaluated normally: importing the real entrypoint must
    // not launch a build. No source rewriting or assertion substitution.
    mockRequire.main = {};
    vm.runInNewContext('(function(require,module,exports,process,__dirname,__filename){' + fs.readFileSync(filename, 'utf8') + '\n})',
      { console: { log() {}, error() {} } }, { filename })(mockRequire, module, module.exports,
      { env: state.env, platform: state.platform }, path.dirname(filename), filename);
    assert.equal(state.invocations.length, 0, 'entrypoint import performs no compiler invocation');
    return module.exports.main;
  };
  state.output = kind => path.join(root, 'desktop/.cache/collector-' + kind);
  state.receipt = kind => fs.readFileSync(state.output(kind) + '.build.json', 'utf8');
  state.bytes = kind => fs.readFileSync(path.join(state.output(kind), kind === 'center' ? 'HeatTreatmentCollectorCenter.exe' : 'HeatTreatmentCollector.exe'), 'utf8');
  return state;
}

test('environment snapshots normalize Windows keys, retain POSIX case, preserve home/tool inputs and never mutate the caller', () => {
  const env = Object.freeze({ Path: 'ignored-duplicate', PATH: 'selected-path', SystemRoot: 'owned-windows', Version: 2,
    USERPROFILE: 'owned-home', OPTIONAL: undefined });
  const snapshot = cache.snapshotBuildEnvironment(env, 'win32');
  assert.equal(snapshot.PATH, 'selected-path'); assert.equal(snapshot.SYSTEMROOT, 'owned-windows');
  assert.equal(snapshot.VERSION, '2'); assert.equal(snapshot.USERPROFILE, env.USERPROFILE); assert.equal(snapshot.OPTIONAL, undefined);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(env.Path, 'ignored-duplicate');
  assert.equal(cache.fingerprintBuildEnvironment(snapshot, 'win32'), cache.fingerprintBuildEnvironment({ userprofile: 'owned-home', version: '2', systemroot: 'owned-windows', path: 'selected-path' }, 'win32'));
  const posix = cache.snapshotBuildEnvironment({ Path: 'one', PATH: 'two' }, 'linux');
  assert.equal(posix.Path, 'one'); assert.equal(posix.PATH, 'two');
  assert.notEqual(cache.fingerprintBuildEnvironment(posix, 'linux'), cache.fingerprintBuildEnvironment({ PATH: 'two' }, 'linux'));
  assert.throws(() => cache.assertBuildEnvironmentUnchanged(snapshot, { ...snapshot, VERSION: '3' }, 'win32'), /environment changed/);
});

test('real CSC entrypoint disables implicit response files and invalidates every explicit compiler/reference/source input', async t => {
  const f = fixture(t), run = f.load('build-collector-center.cjs');
  assert.equal((await run()).reused, false); assert.equal((await run()).reused, true);
  f.file(path.relative(f.root, path.join(f.framework, 'csc.rsp')), '/define:IGNORED_MACHINE_FLAG');
  assert.equal((await run()).reused, true, 'disabled response files are not actual build inputs');
  for (const input of ['mscorlib.dll', 'csc.exe', 'csc.exe.config', 'cscomp.dll', 'cscompui.dll', 'System.Windows.Forms.dll']) {
    f.file(path.relative(f.root, path.join(f.framework, input)), 'changed-' + input);
    assert.equal((await run()).reused, false, input); assert.equal((await run()).reused, true, input);
  }
  for (const input of ['Program.cs', 'app.manifest', 'HeatTreatmentCollectorCenter.exe.config']) {
    f.file('collector-center/' + input, 'changed-' + input);
    assert.equal((await run()).reused, false, input); assert.equal((await run()).reused, true, input);
  }
  f.env.ARBITRARY_BUILD_PROPERTY = 'changed'; assert.equal((await run()).reused, false);
  assert.equal(f.receipt('center').includes(f.env.VIRTUAL_TEST_SECRET), false, 'environment values are not written to receipts');
});

test('CSC source and environment changes during compilation preserve the previous complete cache and receipt', async t => {
  const f = fixture(t), run = f.load('build-collector-center.cjs'); await run();
  const oldOutput = f.bytes('center'), oldReceipt = f.receipt('center');
  f.env.DefineConstants = 'NEW_STARTING_VALUE'; f.onCenter = () => { f.env.Version = 'changed-during-build'; };
  await assert.rejects(run(), /environment changed/);
  assert.equal(f.bytes('center'), oldOutput); assert.equal(f.receipt('center'), oldReceipt);
  f.onCenter = () => f.file('collector-center/Program.cs', 'changed-during-build');
  await assert.rejects(run(), /inputs changed/);
  assert.equal(f.bytes('center'), oldOutput); assert.equal(f.receipt('center'), oldReceipt);
});

test('workspace CSC entrypoint retains its owner lock while using the same explicit compiler inputs', async t => {
  const f = fixture(t), output = path.join(f.root, 'workspace-output');
  f.env.DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR = output;
  const lock = f.file('workspace-output/build.lock', 'owner-lock'), run = f.load('build-collector-center.cjs');
  const handle = fs.openSync(lock, 'r'); t.after(() => fs.closeSync(handle));
  assert.equal((await run()).reused, false); assert.equal(fs.readFileSync(lock, 'utf8'), 'owner-lock');
  assert.equal(fs.existsSync(output + '.build.json'), false, 'the workspace owner still owns its separate proof');
});

test('real MSBuild entrypoint fingerprints all inherited environment properties, SDK and configuration using the compiler snapshot', async t => {
  const f = fixture(t), run = f.load('build-collector-service.cjs'); await run(); await run();
  assert.equal(f.serviceBuilds, 1);
  for (const property of ['Version', 'DefineConstants', 'RuntimeFrameworkVersion', 'MSBuildSDKsPath', 'NUGET_PACKAGES', 'DOTNET_ROOT', 'PATH', 'ARBITRARY_MSBUILD_PROPERTY']) {
    const before = f.serviceBuilds; f.env[property] = 'changed-' + property; await run(); await run();
    assert.equal(f.serviceBuilds, before + 1, property);
  }
  assert.equal(f.bytes('service'), 'Version=changed-Version');
  const beforeSdk = f.serviceBuilds; f.sdk = '8.0.101'; await run(); assert.equal(f.serviceBuilds, beforeSdk + 1);
  const beforeConfig = f.serviceBuilds; f.file('Directory.Build.props', '<Project />'); await run(); assert.equal(f.serviceBuilds, beforeConfig + 1);
  assert.equal(f.receipt('service').includes(f.env.VIRTUAL_TEST_SECRET), false, 'no plaintext environment properties enter cache receipts');
});

test('MSBuild source, SDK and environment mutations fail atomically, including mutation during SDK discovery', async t => {
  const f = fixture(t), run = f.load('build-collector-service.cjs'); await run();
  const output = f.bytes('service'), receipt = f.receipt('service');
  f.env.DefineConstants = 'NEW_STARTING_VALUE';
  f.onService = () => { f.env.Version = 'changed-in-compiler'; };
  await assert.rejects(run(), /environment changed/);
  assert.equal(f.bytes('service'), output); assert.equal(f.receipt('service'), receipt);
  f.onService = () => f.file('collector-service/Program.cs', 'changed-in-compiler');
  await assert.rejects(run(), /inputs changed/);
  assert.equal(f.bytes('service'), output); assert.equal(f.receipt('service'), receipt);
  f.onService = () => { f.sdk = '8.0.102'; };
  await assert.rejects(run(), /inputs changed/);
  assert.equal(f.bytes('service'), output); assert.equal(f.receipt('service'), receipt);
  f.onService = undefined; f.onSdk = () => { f.env.RuntimeFrameworkVersion = 'changed-in-sdk-probe'; };
  const builds = f.serviceBuilds; await assert.rejects(run(), /environment changed/);
  assert.equal(f.serviceBuilds, builds, 'changed SDK-discovery environment stops before publish');
  assert.equal(f.bytes('service'), output); assert.equal(f.receipt('service'), receipt);
});
