// Actual startup HTML, injected native script and compiled Vue loading surface.
// Loopback-only fixtures: no operator DB, Unity, collector or desktop lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { parse, compileScript } = require('../frontend/node_modules/@vue/compiler-sfc');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const { normalizeSettingValue } = require('../backend/routes/settings');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('window-experience-ui');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
const native = read('native-admin-host/DashboardLoadingExperience.cs').match(/DocumentCreatedScript = """([\s\S]*?)""";/)[1];
const source = read('frontend/src/components/LoadingExperience.vue');
const { descriptor } = parse(source);
const component = compileScript(descriptor, { id: 'loading-test', inlineTemplate: true }).content
  .replace(/from ['"]vue['"]/g, "from '/vue.js'")
  .replace("'../runtime/loadingExperienceConfig.js'", "'/config.js'")
  .replace("'../../../shared/loadingPhaseProgress.mjs'", "'/phase-progress.js'");
let browser, page, selectedTheme = 'light', delayAppearance = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
  if (url.pathname === '/startup') return send('text/html', read('desktop/assets/startup.html'));
  if (url.pathname === '/vue.js') return send('text/javascript', read('frontend/node_modules/vue/dist/vue.esm-browser.js'));
  if (url.pathname === '/config.js') return send('text/javascript', read('frontend/src/runtime/loadingExperienceConfig.js'));
  if (url.pathname === '/phase-progress.js') return send('text/javascript', read('shared/loadingPhaseProgress.mjs'));
  if (url.pathname === '/component.js') return send('text/javascript', component);
  if (url.pathname === '/vue') return send('text/html', `<style>${descriptor.styles[0].content}</style><div id="app"></div><script type="module">
    import {createApp,ref,h} from '/vue.js'; import Loading from '/component.js';
    const show=ref(true), progress=ref(25); window.setProgress=p=>progress.value=p; window.finish=()=>show.value=false;
    createApp({render:()=>h(Loading,{show:show.value,progress:progress.value,phase:1,step:'正在装配设备模型',config:new URL(location).searchParams.has('theme')?{theme:new URL(location).searchParams.get('theme')}:null})}).mount('#app');
  </script>`);
  if (url.pathname === '/api/settings/loading-experience') { const config=JSON.parse(normalizeSettingValue('loading_experience_config',{theme:selectedTheme})); return setTimeout(()=>send('application/json',JSON.stringify({config})),delayAppearance); }
  if (url.pathname.endsWith('industrial-factory.png') || url.pathname.endsWith('icon.png')) {
    const file = url.pathname.endsWith('icon.png') ? 'desktop/assets/icon.png' : 'frontend/public/loading/industrial-factory.png';
    return send('image/png', fs.readFileSync(path.join(root, file)));
  }
  if (url.pathname === '/overlay') return send('text/html', '<!doctype html><html><body></body></html>');
  res.writeHead(404); res.end();
});
(async () => {
  for (const raw of [{}, { theme: 'light', background: '#28282b', accent: '#a8c3b1' }]) {
    const config = JSON.parse(normalizeSettingValue('loading_experience_config', raw));
    assert.equal(config.background, '#f5f7fb'); assert.equal(config.accent, '#2563eb');
  }
  assert.equal(JSON.parse(normalizeSettingValue('loading_experience_config', { background: '#28282b', accent: '#a8c3b1' })).theme, 'dark');
  assert.throws(() => normalizeSettingValue('loading_experience_config', { theme: 'unknown' }));
  check('API offers exactly two themes, keeps legacy dark selection and lets an explicit light choice override it');
  const host = read('native-admin-host/AdminPanelForm.cs');
  const close = host.slice(host.indexOf('private async void HandleCloseRequest()'), host.indexOf('private void ShowDetachedDashboardChrome()'));
  assert.doesNotMatch(close, /HideOverlay\(/);
  assert.match(host, /if \(_closeChoiceOpen\) return;[\s\S]*?TryResolveParentWindow\(parentAlreadyChecked/);
  check('close dialog preserves the composed dashboard and pauses redundant bounds work without disabling parent-exit detection');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 440, height: 200 } });
  await context.addInitScript(native);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/startup');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 251)');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).webkitAppRegion), 'drag');
  assert.equal(await page.locator('#detail').evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
  await page.screenshot({ path: path.join(directory, '01-startup.png') });
  await page.evaluate(() => window.configureStartup({ theme: 'dark', background: '#28282b', accent: '#a8c3b1', title: 'SYSTEM STARTUP', kicker: 'HEAT TREATMENT / DIGITAL TWIN' }));
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(238, 238, 234)');
  await page.screenshot({ path: path.join(directory, '01-startup-dark.png') });
  await page.evaluate(() => window.configureStartup({ theme: 'light', background: '#f5f7fb', accent: '#2563eb', title: 'SYSTEM STARTUP', kicker: 'HEAT TREATMENT / DIGITAL TWIN' }));
  await page.evaluate(() => window.updateStartup({ status: 'error', title: '程序启动失败', error: '数据服务未能启动，请重试', logPath: 'C:\\logs\\startup.log' }));
  await page.setViewportSize({ width: 620, height: 360 });
  await page.getByRole('button', { name: '重新启动', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(directory, '02-startup-error.png') });
  await page.evaluate(() => { window.updateStartup({ status: 'running', title: '等待激活' }); window.showActivation({ machineId: 'machine-test', publicKeyConfigured: true }); });
  await page.setViewportSize({ width: 640, height: 560 });
  assert.equal(await page.locator('#activationPanel').evaluate(el => getComputedStyle(el).webkitAppRegion), 'no-drag');
  assert.ok(await page.getByRole('button', { name: '激活并继续' }).isEnabled());
  await page.screenshot({ path: path.join(directory, '03-activation.png') });
  check('compact startup, copyable errors and activation stay readable and draggable in blue-white chrome');

  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(origin + '/overlay');
  const surface = page.locator('#digital-twin-loading-root'); await surface.waitFor();
  await page.waitForFunction(() => document.querySelector('#digital-twin-loading-root').style.getPropertyValue('--dtl-background'));
  assert.equal(await surface.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 251)');
  await page.evaluate(() => {
    window.__DIGITAL_TWIN_LOADING_PROGRESS__({ source:'native',loadId:'fixture-load',sequence:1,progress: 35, phase: 1, step: '正在装配 7 / 20 个模型' });
  });
  await page.getByText('35', { exact: true }).waitFor();
  await page.waitForTimeout(650); assert.equal(await page.locator('.dtl-percent span').textContent(), '35');
  await page.evaluate(async () => {
    const node = document.querySelector('.dtl-fill'); window.writes = 0;
    new MutationObserver(m => window.writes += m.length).observe(node, { attributes: true });
    for (let n = 0; n < 100; n++) window.__DIGITAL_TWIN_LOADING_PROGRESS__({ source:'native',loadId:'fixture-load',sequence:2+n,progress: 62, phase: 2, step: '设备模型' });
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  assert.equal(await page.evaluate(() => window.writes), 1);
  assert.equal(await page.locator('.dtl-fill').evaluate(el => getComputedStyle(el).transitionProperty), 'transform');
  const model = page.locator('.dtl-model'), box = await model.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 45, { steps: 15 }); await page.mouse.up();
  await page.waitForTimeout(60);
  assert.notEqual(await model.evaluate(el => el.style.getPropertyValue('--dtl-tilt-y')), '0deg');
  assert.equal(await page.locator('.dtl-model-stage>img').evaluate(el => getComputedStyle(el).filter), 'none');
  await page.screenshot({ path: path.join(directory, '04-native-loading.png') });
  check('native loading uses real milestones, coalesces 100 updates into one frame and keeps model dragging without costly image filters');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await surface.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  await page.evaluate(() => { window.__DIGITAL_TWIN_LOADING_PROGRESS__({source:'native',loadId:'fixture-load',sequence:102,progress:100,phase:3,ready:true,sceneReady:true,webReady:true});window.__DIGITAL_TWIN_FINISH_LOADING__(); window.__DIGITAL_TWIN_FINISH_LOADING__(); window.__DIGITAL_TWIN_LOADING_PROGRESS__({ progress: 2 }); });
  await surface.waitFor({ state: 'detached', timeout: 1500 });
  check('finish is idempotent, clears work/listeners and removes the native cover promptly; reduced-motion is respected');

  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.goto(origin + '/vue');
  await page.locator('.loading-experience').waitFor();
  assert.equal(await page.locator('.loading-experience').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 251)');
  await page.evaluate(() => window.setProgress(72));
  await page.waitForFunction(() => document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '72');
  assert.equal(await page.locator('.loading-progress-track i').evaluate(el => el.style.transform), 'scaleX(0.72)');
  await page.screenshot({ path: path.join(directory, '05-vue-loading.png') });
  await page.evaluate(() => window.finish()); await page.locator('.loading-experience').waitFor({ state: 'detached', timeout: 1500 });
  check('Vue and native surfaces match, use compositor-only progress and exit without the former long scaled fade');
  selectedTheme = 'dark'; await page.goto(origin + '/overlay');
  await page.locator('#digital-twin-loading-root.is-dark').waitFor();
  assert.equal(await page.locator('.dtl-status h1').evaluate(el => getComputedStyle(el).color), 'rgb(238, 238, 234)');
  assert.equal(await page.locator('.dtl-model-stage>img').evaluate(el => getComputedStyle(el).filter), 'none');
  await page.screenshot({ path: path.join(directory, '06-native-dark.png') });
  await page.goto(origin + '/vue?theme=dark'); await page.locator('.loading-experience.dark').waitFor();
  assert.equal(await page.locator('.loading-status-row h1').evaluate(el => getComputedStyle(el).color), 'rgb(238, 238, 234)');
  await page.screenshot({ path: path.join(directory, '07-vue-dark.png') });
  check('the original dark palette coexists on all loading surfaces without restoring expensive filters or fake progress');
  delayAppearance=1200;
  const immediate=await browser.newContext({viewport:{width:1280,height:800}});
  await immediate.addInitScript(({script})=>{
    const seed=new URL(location).searchParams.get('seed') || 'light';
    localStorage.setItem('digital_twin_loading_appearance_v1',JSON.stringify({theme:seed==='dark'?'light':'dark'}));
    window.__DIGITAL_TWIN_WINDOW_THEME__=seed;
    (0,eval)(script);
    window.firstLoadingFrames=[];
    function sample(){const root=document.querySelector('#digital-twin-loading-root');if(root)window.firstLoadingFrames.push({dark:root.classList.contains('is-dark'),background:getComputedStyle(root).backgroundColor});if(window.firstLoadingFrames.length<90)requestAnimationFrame(sample)}
    requestAnimationFrame(sample);
  },{script:native});
  const first=await immediate.newPage();first.on('pageerror',error=>errors.push(error.message));
  selectedTheme='light';await first.goto(origin+'/overlay');await first.waitForTimeout(1350);
  const frames=await first.evaluate(()=>window.firstLoadingFrames);assert.ok(frames.length>10);assert.ok(frames.every(frame=>!frame.dark&&frame.background==='rgb(245, 247, 251)'));
  await first.screenshot({path:path.join(directory,'08-first-frame-light.png')});
  selectedTheme='dark';await first.goto(origin+'/overlay?seed=dark');await first.waitForTimeout(1350);
  const darkFrames=await first.evaluate(()=>window.firstLoadingFrames);assert.ok(darkFrames.length>10);assert.ok(darkFrames.every(frame=>frame.dark&&frame.background==='rgb(40, 40, 43)'));
  await first.screenshot({path:path.join(directory,'09-first-frame-dark.png')});
  await first.goto(origin+'/overlay?seed=light');await first.waitForTimeout(100);
  await first.evaluate(()=>window.dispatchEvent(new CustomEvent('digital-twin-loading-theme',{detail:'light'})));
  await first.waitForTimeout(1350);assert.equal(await first.locator('#digital-twin-loading-root').evaluate(el=>el.classList.contains('is-dark')),false,'late old read cannot undo a new host choice');
  await first.goto(origin+'/vue');await first.locator('.loading-experience').waitFor();assert.equal(await first.locator('.loading-experience').evaluate(el=>el.classList.contains('dark')),false,'Vue initial render follows the same host seed');
  await immediate.close();delayAppearance=0;
  check('first loading frames honor the host theme despite an old dark cache and a delayed settings response; native and Vue agree and late reads cannot undo a newer choice');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2));
  console.log(JSON.stringify({ success: true, directory, checks: checks.length }));
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
