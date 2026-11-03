// Owned Vite + headless browser + repository CAD asset. No live service/data.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const directory = createRunDirectory('ground-cutaway-visual'), root = path.resolve(__dirname, '..');
let vite, browser;
(async () => {
    const { createServer } = await import(pathToFileURL(path.join(root, 'frontend/node_modules/vite/dist/node/index.js')).href);
    vite = await createServer({ root: path.join(root, 'frontend'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, plugins: [{ name: 'owned-ground-fixture', configureServer(server) {
        server.middlewares.use('/__ground-cutaway.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><style>body{margin:0}</style></head><body><script type="module" src="/tests/fixtures/ground-cutaway-scene.mjs"></script></body></html>'); });
    } }] });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const model = '/@fs/' + path.join(root, 'backend/assets/models/pit_furnace_references_v1/PitFurnace2/pit_furnace_2_v1.glb').replaceAll('\\', '/');
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 700 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/__ground-cutaway.html?model=' + encodeURIComponent(model));
    await page.waitForFunction(() => window.cutawayTest, { timeout: 60000 });
    await page.screenshot({ path: path.join(directory, '01-before-front.png') });
    await page.evaluate(() => window.cutawayTest.toggle(true));
    await page.screenshot({ path: path.join(directory, '02-cutaway-front.png') });
    for (const side of ['back', 'diagonal', 'top']) {
        await page.evaluate(side => window.cutawayTest.setCamera(side), side);
        await page.screenshot({ path: path.join(directory, `03-cutaway-${side}.png`) });
    }
    const before = await page.evaluate(() => window.cutawayTest.state());
    const after = await page.evaluate(() => window.cutawayTest.orbit(36));
    assert.equal(after.unchanged, true); assert.equal(after.geometries, before.geometries, 'camera changes must not accumulate GPU geometries');
    assert.deepEqual(errors, []);
    const result = { success: true, directory, before, after, browserErrors: errors };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await vite?.close(); });
