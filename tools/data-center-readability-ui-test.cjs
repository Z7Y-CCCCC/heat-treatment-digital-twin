// Readability acceptance uses only an owned, collector-free SQLite fixture.
// Never connects to commissioned PLCs, launches Unity, or changes a real database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `data-center-readability-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const audits = [], failures = [], errors = [], screenshots = [];
let server, browser, info, page, seeded = false;

async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, {
    method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function switchSection(name) {
  await page.locator('#data-center-submenu').getByRole('button', { name, exact: true }).click();
}
async function login(context) {
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.locator('.catalog-layout[aria-busy="false"]').waitFor();
  await page.locator('.table-card').first().waitFor();
}
async function seedOwnHealthData() {
  const connection = await api('/data-sources/connections', 'POST', {
    name: '本机验收API', sourceType: 'http_api', connector: 'http', baseUrl: info.origin,
    healthPath: '/api/health', authType: 'none', enabled: true
  });
  assert.ok(connection.connection?.id, 'owned health connection created');
  const dataset = await api('/data-sources/datasets', 'POST', {
    name: '服务状态（隔离验收）', connectionId: connection.connection.id, source: 'http', enabled: true,
    refreshMs: 5000, request: { method: 'GET', path: '/api/health', parameters: [] }, rootPath: '',
    columns: [{ name: 'status', label: '返回状态', path: 'status', type: 'string', unit: '' }]
  });
  assert.ok(dataset.dataset?.id || dataset.definition?.id || dataset.success, 'owned dataset created');
  seeded = true;
  await page.reload();
  await page.locator('.catalog-layout[aria-busy="false"]').waitFor();
}

// Includes real computed CSS, ancestor transparency and opacity. White is the
// browser canvas backdrop; backgrounds are alpha-composited bottom-to-top.
async function auditState(name, textSize, width, focusSelector) {
  // Disabled -> enabled and pointer hover transitions must finish before
  // sampling computed colors. A mid-transition frame is not the resting UI.
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.getAnimations().some(animation =>
    animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)), undefined, { timeout: 5000 });
  const audit = await page.evaluate(({ name, textSize, width }) => {
    const result = { name, textSize, width, checks: [], violations: [], samples: [], internalScrollers: [] };
    const check = (label, ok, detail) => {
      result.checks.push({ label, ok, ...(detail ? { detail } : {}) });
      if (!ok) result.violations.push({ label, detail });
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const actualScale = Number(rootStyle.getPropertyValue('--admin-font-scale'));
    check('real persisted admin font scale', Math.abs(actualScale - textSize / 100) < .001, { actualScale });
    check('browser zoom unchanged', Math.abs((visualViewport?.scale || 1) - 1) < .001);
    check('page has no horizontal overflow', document.documentElement.scrollWidth <= innerWidth + 2,
      { scrollWidth: document.documentElement.scrollWidth, innerWidth });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
    };
    const over = (top, bottom) => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      return [0, 1, 2].map(i => a ? (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a : 0).concat(a);
    };
    const lum = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    const visible = el => {
      if (!el.getClientRects().length || el.closest('svg, option, [aria-hidden="true"]')) return false;
      for (let p = el; p; p = p.parentElement) {
        const css = getComputedStyle(p);
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false;
      }
      return true;
    };
    const describe = el => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''}`;
    const surfaces = el => {
      let chain = [], opacity = 1;
      for (let p = el; p; p = p.parentElement) { chain.unshift(p); opacity *= Number(getComputedStyle(p).opacity); }
      let background = [255, 255, 255, 1];
      for (const p of chain) {
        const css = getComputedStyle(p), color = rgba(css.backgroundColor);
        // Local surfaces use solid backgrounds; avoid treating box-shadow as a fill.
        background = over(color, background);
      }
      return { background, opacity };
    };
    const roots = [...document.querySelectorAll('.data-center, .source-picker')].filter(visible);
    const candidates = new Set(roots.flatMap(el => [...el.querySelectorAll('*')]));
    for (const el of candidates) {
      if (!visible(el) || el.matches('style,script,svg,path,img,input[type="checkbox"],input[type="password"]')) continue;
      if (el.closest('button:disabled,fieldset:disabled,[aria-disabled="true"]')) continue;
      let text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ').trim();
      let placeholder = false;
      if (el.matches('input,textarea')) { text = el.value || el.getAttribute('placeholder') || ''; placeholder = !el.value; }
      if (el.matches('select')) text = el.selectedOptions[0]?.text || '';
      if (!text) continue;
      const css = getComputedStyle(el, placeholder ? '::placeholder' : undefined);
      const baseCss = getComputedStyle(el), surface = surfaces(el);
      const foreground = rgba(css.color); foreground[3] *= surface.opacity * (placeholder ? Number(css.opacity || 1) : 1);
      const effectiveForeground = over(foreground, surface.background);
      const contrast = ratio(effectiveForeground, surface.background), fontSize = parseFloat(css.fontSize);
      const sample = { selector: describe(el), text: text.replace(/\s+/g, ' ').slice(0, 100), fontSize,
        lineHeight: css.lineHeight, weight: css.fontWeight, foreground: css.color,
        computedBackground: baseCss.backgroundColor, effectiveBackground: surface.background.map(v => +v.toFixed(3)),
        opacity: surface.opacity, contrast: +contrast.toFixed(3), placeholder };
      result.samples.push(sample);
      if (contrast + .005 < 4.5) result.violations.push({ label: 'text contrast below 4.5:1', detail: sample });
      const minimumSize = el.matches('.type-card-caption em') ? 12.5 : 13;
      if (fontSize + .1 < minimumSize * actualScale) result.violations.push({ label: 'text below its scaled readability minimum', detail: sample });
    }
    check('computed text samples collected', result.samples.length >= 15, { samples: result.samples.length });
    for (const selector of ['.data-center', '.source-picker']) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        check(selector + ' contained in viewport width', rect.left >= -2 && rect.right <= innerWidth + 2,
          { left: rect.left, right: rect.right });
      }
    }
    for (const el of candidates) {
      if (!visible(el) || el.scrollWidth <= el.clientWidth + 2) continue;
      const css = getComputedStyle(el);
      if (/auto|scroll/.test(css.overflowX)) result.internalScrollers.push({ selector: describe(el), width: el.clientWidth, scrollWidth: el.scrollWidth });
    }
    const controls = [...new Set(roots.flatMap(el => [...el.querySelectorAll('button')]))].filter(visible);
    for (const el of controls) {
      if (el.disabled) continue;
      const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      const name = (el.getAttribute('aria-label') || labelledBy || el.textContent || [...el.querySelectorAll('img')].map(img => img.alt).join(' ')).trim();
      check('button has accessible name', !!name, { selector: describe(el), name });
    }
    result.minContrast = Math.min(...result.samples.map(s => s.contrast));
    return result;
  }, { name, textSize, width });
  if (focusSelector) {
    const control = page.locator(focusSelector).first();
    await control.scrollIntoViewIfNeeded(); await control.focus();
    const focused = await control.evaluate(el => document.activeElement === el);
    audit.checks.push({ label: 'key action keyboard focusable', ok: focused });
    if (!focused) audit.violations.push({ label: 'key action not keyboard focusable', detail: focusSelector });
  }
  // Reset page/explicit scroll regions for consistent overview screenshots.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('.admin-content,.admin-main,.source-detail-body,.dataset-body,.dataset-detail-body,.source-catalog')) el.scrollTop = 0;
    document.activeElement?.blur?.();
  });
  const screenshot = path.join(directory, `${textSize}-${width}-${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  screenshots.push(screenshot); audits.push(audit);
  if (textSize === 115 && name === '01-catalog') {
    const detailScreenshot = path.join(directory, `${textSize}-${width}-${name}-workspace.png`);
    await page.locator('[data-testid="data-center-workspace"]').screenshot({ path: detailScreenshot });
    screenshots.push(detailScreenshot);
  }
  failures.push(...audit.violations.map(v => ({ state: `${textSize}-${width}-${name}`, ...v })));
  console.log(`${audit.violations.length ? 'FAIL' : 'PASS'} ${textSize}% ${width}px ${name}: ${audit.samples.length} text samples, min contrast ${audit.minContrast}`);
  fs.writeFileSync(path.join(directory, 'audit.json'), JSON.stringify({ audits, failures, errors, screenshots }, null, 2));
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: root, env: { ...process.env, MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') },
    logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned collector-free readability fixture');
  info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  assert.equal(new URL(info.origin).hostname, '127.0.0.1'); requireTestPath(info.database);
  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  // Finish with the user-facing default 115% screenshots, not the stress setup.
  for (const textSize of [100, 200, 115]) {
    for (const width of [1680, 1024]) {
      const context = await browser.newContext({ viewport: { width, height: width === 1680 ? 1100 : 900 }, deviceScaleFactor: 1 });
      try {
        await context.addInitScript(({ textSize }) => {
          if (textSize !== 115) localStorage.setItem('digital_twin_admin_reading_v1', JSON.stringify({ textSize }));
          if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'tables' }));
        }, { textSize });
        await login(context); if (!seeded) await seedOwnHealthData();
        await page.locator('.category-choice').filter({ hasText: '设备资料' }).click();
        await auditState('01-catalog', textSize, width, '.catalog-actions .center-button.primary');
        await switchSection('数据源'); await page.locator('.source-row').filter({ hasText: '本机验收API' }).waitFor();
        await auditState('02-source-list', textSize, width, '.source-row');
        await page.locator('.source-row').filter({ hasText: '本机验收API' }).click();
        await page.locator('.source-form').waitFor();
        await page.getByRole('tab', { name: '连接配置', exact: true }).press('ArrowRight');
        assert.equal(await page.getByRole('tab', { name: '认证', exact: true }).getAttribute('aria-selected'), 'true');
        await page.getByRole('tab', { name: '认证', exact: true }).press('Home');
        await auditState('03-source-edit', textSize, width, '.source-actions .btn-primary');
        // Only the fixture health endpoint is tested/read. Never sends a PLC command.
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        await page.locator('.source-health.healthy').waitFor();
        await page.getByRole('tab', { name: '数据预览', exact: true }).click();
        await page.getByLabel('接口路径', { exact: true }).fill('/api/health');
        await page.getByRole('button', { name: '读取接口字段', exact: true }).click();
        await page.getByLabel('字段路径', { exact: true }).selectOption('status');
        await page.getByRole('button', { name: '读取样例', exact: true }).click();
        await page.locator('.preview-result').waitFor();
        await auditState('04-source-preview', textSize, width, '.preview-result-tabs button');
        await page.getByRole('button', { name: '＋ 新建数据源', exact: true }).click();
        await page.getByRole('dialog', { name: '新建数据源', exact: true }).waitFor();
        await auditState('05-source-types', textSize, width, '.source-picker .close-editor');
        await page.getByLabel('关闭数据源类型选择', { exact: true }).click();
        await switchSection('数据表'); await page.locator('.catalog-layout[aria-busy="false"]').waitFor();
        await page.getByRole('button', { name: '＋ 新建 / 管理外部数据表', exact: true }).click();
        await page.getByLabel('数据表名称', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('数据表名称', { exact: true }).inputValue(), '服务状态（隔离验收）');
        await page.getByRole('tab', { name: '读取配置', exact: true }).press('ArrowRight');
        assert.equal(await page.getByRole('tab', { name: '参数与匹配', exact: true }).getAttribute('aria-selected'), 'true');
        await page.getByRole('tab', { name: '参数与匹配', exact: true }).press('Home');
        await auditState('06-dataset-config', textSize, width, '.dataset-workspace .footer-actions .btn-primary');
        await page.getByRole('tab', { name: '字段映射', exact: true }).click();
        await page.getByLabel('字段名称 1', { exact: true }).waitFor();
        await auditState('07-dataset-fields', textSize, width, '.dataset-workspace .footer-actions .btn-primary');
        await page.getByRole('button', { name: '读取预览', exact: true }).click();
        await page.locator('.result-state').filter({ hasText: '读取成功' }).waitFor();
        assert.equal(await page.locator('.result-table tbody tr td').last().innerText(), 'ok');
        await auditState('08-dataset-preview', textSize, width, '.dataset-workspace .footer-actions .btn-primary');
      } finally { await context.close(); }
    }
  }
  const success = !failures.length && !errors.length;
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success, directory, states: audits.length, screenshots,
    textSamples: audits.reduce((sum, audit) => sum + audit.samples.length, 0), failures, errors,
    fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, serverPid: server.pid,
    scope: 'owned health-only collector-free fixture; no Unity; no commissioned database' }, null, 2));
  console.log(JSON.stringify({ success, states: audits.length, failures: failures.length, errors, directory }));
  if (!success) process.exitCode = 1;
})().catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, directory, states: audits.length, failures, errors, error: String(error), screenshots }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  // Targets only this test's exact server PID/tree, never other Node/Unity apps.
  await stopOwnedSmokeProcess(server);
});
