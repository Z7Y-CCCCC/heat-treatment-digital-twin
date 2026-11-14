// Component-only loopback acceptance: no backend, database, credentials, PLC,
// installed service or desktop control is touched. Runtime actions remain the
// responsibility of AdminPanel; this fixture verifies the UI emission contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { parse, compileScript, compileStyle } = require('../frontend/node_modules/@vue/compiler-sfc');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');

const root = path.resolve(__dirname, '..');
const artifactRoot = requireTestPath(path.join(root, 'output', 'playwright', 'service-connections'));
fs.mkdirSync(artifactRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifactRoot, new Date().toISOString().replace(/[-:.]/g, '') + '-'));
const checks = [], errors = [], assets = new Map();
const componentBase = path.join(root, 'frontend', 'src', 'views', 'admin', 'components');
for (const name of ['ConnectionPlugIcon', 'ServiceConnectionIcon', 'AdminConnectionStatus']) {
  const descriptor = parse(fs.readFileSync(path.join(componentBase, name + '.vue'), 'utf8')).descriptor;
  const id = 'data-v-service-test-' + name.toLowerCase();
  const script = compileScript(descriptor, { id, inlineTemplate: true }).content
    .replace(/from (['"])vue\1/g, "from '/vue.js'")
    .replace(/from (['"])\.\/(ConnectionPlugIcon|ServiceConnectionIcon)\.vue\1/g, (_, quote, icon) => "from '/" + icon + ".js'")
    .replace('export default', 'const component =');
  const style = compileStyle({ source: descriptor.styles[0].content, id, scoped: true });
  assert.deepEqual(style.errors, [], 'component styles compile');
  assets.set('/' + name + '.js', { type: 'text/javascript', content: script + "\ncomponent.__scopeId=" + JSON.stringify(id) + "; export default component;" });
  assets.set('/' + name + '.css', { type: 'text/css', content: style.code });
}
assets.set('/vue.js', { type: 'text/javascript', content: fs.readFileSync(path.join(root, 'frontend/node_modules/vue/dist/vue.runtime.esm-browser.js'), 'utf8') });
assets.set('/', { type: 'text/html', content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务连接组件隔离验收</title>
<link rel="stylesheet" href="/ConnectionPlugIcon.css"><link rel="stylesheet" href="/ServiceConnectionIcon.css"><link rel="stylesheet" href="/AdminConnectionStatus.css">
<style>*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#344054;font-family:"Microsoft YaHei",sans-serif}.admin-header{display:flex;justify-content:space-between;align-items:center;gap:18px;min-height:64px;padding:16px 32px;background:rgba(255,255,255,.78);border-bottom:1px solid #dfe3e8}.admin-header h1{font-size:17px;margin:0}.admin-connection-strip{display:flex;align-items:center}.fixture-note{margin:24px;color:#667085;font-size:12px}@media(max-width:480px){.admin-header{padding:12px 16px;flex-wrap:wrap;gap:8px}.admin-header h1{flex-basis:100%}}</style>
<div id="app"></div><script type="module">
import {createApp,h,reactive,nextTick} from '/vue.js';import Status from '/AdminConnectionStatus.js';
const names={unity:'Unity',devices:'设备采集',data:'数据服务',session:'登录状态'};
const services=Object.keys(names).map(key=>({key,name:names[key],label:key==='unity'?'场景就绪':key==='devices'?'PLC 在线':key==='data'?'后台与数据库在线':'会话有效',detail:key==='devices'?'真实 PLC 最近读数有效':'当前连接已确认',tone:'is-online',connected:true,lastSuccessAt:Date.now(),online:2,total:2,rows:key==='devices'?[{id:'a',name:'隔离设备 A',connected:true,tone:'is-online'},{id:'b',name:'隔离设备 B',connected:true,tone:'is-online'}]:[]}));
const props=reactive({services,actions:{unity:[{id:'check',label:'重新检测'},{id:'reconnect',label:'重连实时通道'},{id:'restart',label:'重启大屏',dangerous:true}],devices:[{id:'check',label:'重新检测'},{id:'restart',label:'重启采集进程',dangerous:true},{id:'center',label:'打开采集运行中心'}],data:[{id:'check',label:'重新检测'},{id:'reconnect',label:'重连当前页面通道'},{id:'center',label:'打开采集运行中心'}],session:[{id:'check',label:'重新检测'},{id:'unlock',label:'返回登录或解锁'}]},busy:{},feedback:{}});
const fixture={props,emitted:[],accepted:[],confirmationRequests:0,update:async patch=>{Object.assign(props,patch);await nextTick()},patch:async(kind,patch)=>{props.services=props.services.map(service=>service.key===kind?{...service,...patch}:service);await nextTick()},clear:async()=>{fixture.emitted=[];fixture.accepted=[];props.busy={};props.feedback={};await nextTick()}};
const onAction=event=>{fixture.emitted.push(event);if(event.action==='restart'){fixture.confirmationRequests++;if(!window.confirm('隔离父组件确认：会短暂停止对应运行进程，是否继续？')){props.feedback[event.kind]={type:'error',message:'已取消，不执行任何重启'};return}}fixture.accepted.push(event);props.busy[event.kind]=true};
window.fixture=fixture;createApp({render:()=>h('div',[h('header',{class:'admin-header'},[h('h1','后台管理'),h('div',{class:'admin-connection-strip'},[h(Status,{...props,onAction})])]),h('p',{class:'fixture-note'},'隔离组件验收 · 不连接现场系统')])}).mount('#app');
</script></html>` });

let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const badge = kind => page.locator('[data-connection-kind="' + kind + '"]');
const dialog = () => page.getByRole('dialog');
const action = id => dialog().locator('[data-connection-action="' + id + '"]');
const plugState = target => target.locator('svg[data-plug-state]').getAttribute('data-plug-state');
const patch = (kind, value) => page.evaluate(([k, v]) => fixture.patch(k, v), [kind, value]);
const screenshot = name => page.screenshot({ path: path.join(directory, name) });
async function close() {
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  await page.locator('.fixture-note').click();
}
async function bounds() {
  const box = await dialog().boundingBox(), viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, 'panel is horizontally bounded');
  assert.ok(box.y >= 0 && box.y + box.height <= viewport.height + 1, 'panel is vertically bounded');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page horizontal overflow');
}
(async () => {
  server = http.createServer((request, response) => {
    const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
    response.writeHead(asset ? 200 : 404, { 'Content-Type': asset?.type || 'text/plain', 'Cache-Control': 'no-store' });
    response.end(asset?.content || 'Not found');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:' + server.address().port);
  await badge('unity').waitFor();
  assert.equal(await page.locator('[data-connection-kind]').count(), 4);
  for (const kind of ['unity', 'devices', 'data', 'session']) {
    assert.equal((await badge(kind).innerText()).trim(), '', 'pill is icon-only');
    assert.ok((await badge(kind).getAttribute('aria-label')).length > 4);
    assert.equal(await plugState(badge(kind)), 'connected');
    assert.equal((await badge(kind).boundingBox()).height, 32);
  }
  await screenshot('01-four-connected-pills.png');
  pass('four icon-only 32px pills reuse the plug silhouette, capsule styling and service-specific accessible labels');

  await badge('devices').hover(); await dialog().waitFor();
  const tipBox = await dialog().boundingBox(), badgeBox = await badge('devices').boundingBox();
  assert.ok(tipBox.y >= badgeBox.y + badgeBox.height);
  await page.mouse.move(tipBox.x + 50, tipBox.y + 50, { steps: 15 });
  await dialog().waitFor({ state: 'visible' });
  for (const id of ['a', 'b']) {
    const row = dialog().locator('[data-device-id="' + id + '"]');
    assert.equal((await row.innerText()).trim(), id === 'a' ? '隔离设备 A' : '隔离设备 B');
    assert.equal(await plugState(row), 'connected');
  }
  await bounds(); await screenshot('02-device-details.png'); await close();
  pass('hover crosses the below-trigger gap, device rows show only names and individual plugs in a non-modal dialog');

  await patch('unity', { connected: false, label: '场景同步中', detail: '实时通道在线，场景尚未就绪', tone: 'is-partial' });
  await badge('unity').click(); await dialog().waitFor();
  assert.match(await dialog().innerText(), /场景尚未就绪/); assert.equal(await plugState(badge('unity')), 'disconnected');
  await screenshot('03-unity-scene-pending.png'); await close();
  await patch('devices', { mode: 'simulation', label: '模拟运行', detail: '模拟读数，不代表真实 PLC 在线', tone: 'is-online', connected: true });
  assert.equal(await plugState(badge('devices')), 'disconnected');
  assert.ok(!(await badge('devices').getAttribute('class')).split(' ').includes('is-online'));
  await badge('devices').click(); assert.match(await dialog().innerText(), /模拟读数/); await screenshot('04-simulation-not-false-green.png'); await close();
  await patch('data', { tone: 'is-partial', connected: false, label: '数据库连接异常', detail: '后台 API 可达，数据库连接未确认' });
  await badge('data').click(); assert.match(await dialog().innerText(), /API 可达/); assert.equal(await plugState(badge('data')), 'disconnected');
  await screenshot('05-api-up-database-down.png'); await close();
  await patch('session', { tone: 'is-offline', connected: false, label: '需要登录', detail: '当前会话已过期' });
  await badge('session').click(); assert.match(await dialog().innerText(), /会话已过期/); assert.equal(await action('restart').count(), 0);
  assert.equal(await action('unlock').count(), 1); await screenshot('06-session-expired.png'); await close();
  await patch('devices', { restricted: true, label: '无权限查看', detail: '当前账户无设备数据查看权限', tone: 'is-unknown' });
  await badge('devices').click(); assert.equal(await dialog().locator('[data-device-id]').count(), 0);
  assert.doesNotMatch(await dialog().innerText(), /隔离设备 A/); await screenshot('07-restricted.png'); await close();
  pass('scene not ready, simulation, API-up/database-down, expired session and restricted detail retain honest non-green states');

  await page.evaluate(() => fixture.clear());
  await badge('data').focus(); await page.keyboard.press('ArrowDown'); await dialog().waitFor();
  assert.equal(await action('check').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => fixture.emitted), [{ kind: 'data', action: 'check' }]);
  assert.equal(await action('check').isDisabled(), true);
  await action('check').dispatchEvent('click'); await action('reconnect').dispatchEvent('click');
  assert.equal(await page.evaluate(() => fixture.emitted.length), 1, 'busy emits no duplicates even when clicked programmatically');
  await page.evaluate(() => fixture.update({ feedback: { data: { type: 'error', message: '握手超时，连接尚未恢复' } } }));
  assert.equal(await dialog().getByRole('alert').innerText(), '握手超时，连接尚未恢复');
  await screenshot('08-busy-error-feedback.png');
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  assert.equal(await badge('data').evaluate(element => element === document.activeElement), true);
  await page.locator('.fixture-note').click(); await page.evaluate(() => fixture.clear());
  await badge('session').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(() => fixture.emitted), [{ kind: 'session', action: 'check' }]); await close();
  pass('ArrowDown focuses an icon action, native Enter/Space emit once, busy suppresses repeats and ESC restores trigger focus');

  await page.evaluate(() => fixture.clear());
  page.once('dialog', async event => { assert.equal(event.type(), 'confirm'); await event.dismiss(); });
  await badge('unity').click(); await action('restart').click();
  assert.deepEqual(await page.evaluate(() => fixture.emitted), [{ kind: 'unity', action: 'restart' }]);
  assert.equal(await page.evaluate(() => fixture.confirmationRequests), 1);
  assert.deepEqual(await page.evaluate(() => fixture.accepted), []);
  assert.match(await dialog().getByRole('alert').innerText(), /已取消/);
  await close();
  pass('dangerous restart stays inside the panel and emits intent only; the isolated parent confirms and rejection executes nothing');

  await page.evaluate(() => fixture.clear());
  await patch('devices', { restricted: false, mode: 'integrated_plc', label: '部分设备离线', detail: '当前工厂 32 台设备读数有效，16 台设备离线', tone: 'is-partial', connected: false,
    total: 48, online: 32, rows: Array.from({ length: 48 }, (_, index) => ({ id: 'long-' + index, name: '滚动验收设备 ' + (index + 1), connected: index % 3 !== 0, tone: index % 3 !== 0 ? 'is-online' : 'is-offline' })) });
  for (const viewport of [{ width: 360, height: 640 }, { width: 360, height: 320 }]) {
    await page.setViewportSize(viewport); await badge('devices').click(); await dialog().waitFor(); await bounds();
    assert.equal(await dialog().locator('[data-device-id]').count(), 48);
    const scroll = await dialog().evaluate(element => [element, ...element.querySelectorAll('*')].some(item => item.scrollHeight > item.clientHeight + 5 && ['auto', 'scroll'].includes(getComputedStyle(item).overflowY)));
    assert.equal(scroll, true);
    await screenshot(viewport.height === 640 ? '09-narrow-long-list.png' : '10-short-viewport.png');
    await dialog().evaluate(element => { for (const item of [element, ...element.querySelectorAll('*')]) if (item.scrollHeight > item.clientHeight + 5) item.scrollTop = item.scrollHeight; });
    await screenshot(viewport.height === 640 ? '11-narrow-list-end.png' : '12-short-list-end.png');
    await close();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await badge('data').click(); await page.locator('.fixture-note').click(); await dialog().waitFor({ state: 'hidden' });
  assert.equal(await badge('data').getAttribute('aria-expanded'), 'false');
  pass('48-device lists scroll at 360px narrow and 320px short viewports without overflow; outside click closes the panel');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, scope: 'isolated component and emission contract only; no runtime restart or deployment claimed', checks, errors, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, errors, failure: error.stack, screenshotDirectory: directory }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
