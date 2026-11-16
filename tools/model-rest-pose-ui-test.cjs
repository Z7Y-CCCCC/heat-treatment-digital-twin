'use strict';
// Static/animated lift preview acceptance on owned loopback databases only.
// UI_FRONTEND_DIST must point to an isolated frontend build; this is not packaging.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('../backend/node_modules/better-sqlite3');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BACKEND_DIR, requireTestPath, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { getCadEquipmentModels } = require('../backend/services/cadEquipmentModels');
const root = path.resolve(__dirname, '..'), modelId = 'cad_lifting_load_table_111400';
const directory = requireTestPath(path.join(root, 'output/playwright', 'model-rest-pose-' + Date.now()));
fs.mkdirSync(directory, { recursive: true });
const checks = [], errors = [], captures = [], ownedServers = [];
let browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const asset = suffix => path.join(root, 'backend/assets', suffix, modelId + '.glb');
const sourceFile = asset('models'), motionFile = asset('motions');
const fixtureBindingName = '隔离回归液压缸节点';
function readGlbDocument(file) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.readUInt32LE(0), 0x46546c67);
    return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8').trim());
}
function originalNodePath(document, target) {
    const visit = (indices, parent) => {
        for (const [index, id] of indices.entries()) {
            const node = document.nodes[id], segment = String(node.name || 'Object3D').replace(/\//g, '_') + '#' + index;
            const current = parent ? parent + '/' + segment : segment;
            if (node.name === target) return current;
            const found = visit(node.children || [], current); if (found) return found;
        }
        return '';
    };
    return visit(document.scenes[document.scene || 0].nodes, '');
}
const document = readGlbDocument(sourceFile);
const cylinderName = 'cad_lifting_staging_table_v1_hydraulics_teal';
const cylinderPath = originalNodePath(document, cylinderName);
assert.ok(cylinderPath, 'fixture must bind to a real original GLB path');
const beforeHashes = { source: sha(sourceFile), motion: sha(motionFile) };

async function captureRawGlb(context, origin, label, sourcePath) {
    const raw = await context.newPage();
    raw.on('pageerror', error => errors.push(label + ' raw GLB: ' + error.message));
    const threeDirectory = path.resolve(root, 'frontend/node_modules/three');
    await raw.route('**/fixture-three/**', route => {
        const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice('/fixture-three/'.length));
        const file = path.resolve(threeDirectory, relative), contained = path.relative(threeDirectory, file);
        assert.ok(contained && !contained.startsWith('..') && !path.isAbsolute(contained), 'raw viewer modules must stay inside the fixture Three.js directory');
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
    });
    await raw.route('**/fixture-raw-viewer', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/fixture-three/build/three.module.js"}}</script></head><body data-state="loading">
<script type="module">
import * as T from 'three';
import {GLTFLoader} from '/fixture-three/examples/jsm/loaders/GLTFLoader.js';
// Intentionally no CadMotionRig, application code or runtime pose correction.
try {
 const gltf=await new GLTFLoader().loadAsync(${JSON.stringify(sourcePath)}), root=gltf.scene;
 const scene=new T.Scene();scene.background=new T.Color('#f3f4f5');scene.add(root);
 scene.add(new T.HemisphereLight(0xffffff,0x7d8582,1.45));
 for(const [position,color,power] of [[[6,9,7],0xffffff,2.1],[[-7,4,-5],0xfff0d6,.75]]){const light=new T.DirectionalLight(color,power);light.position.fromArray(position);scene.add(light)}
 const grid=new T.GridHelper(10,10,0xb6bec1,0xd5dadc);grid.position.y=-.01;scene.add(grid);
 const bounds=new T.Box3().setFromObject(root), center=bounds.getCenter(new T.Vector3()), size=bounds.getSize(new T.Vector3()), distance=Math.max(size.x,size.y,size.z,1)*1.75;
 const camera=new T.PerspectiveCamera(45,innerWidth/innerHeight,.01,1000);camera.position.set(center.x+distance*.72,center.y+distance*.58,center.z+distance);camera.lookAt(center);
 const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(1);renderer.outputColorSpace=T.SRGBColorSpace;document.body.appendChild(renderer.domElement);renderer.render(scene,camera);
 let nodes=0,triangles=0;root.traverse(node=>{nodes++;if(node.isMesh)triangles+=(node.geometry.index?.count||node.geometry.attributes.position.count)/3});document.body.dataset.nodes=String(nodes);document.body.dataset.triangles=String(triangles);
 document.body.dataset.state='loaded';
}catch(error){document.body.dataset.state='error';document.body.dataset.error=error.message;throw error}
</script></body></html>` }));
    await raw.goto(origin + '/fixture-raw-viewer');
    await raw.waitForFunction(() => document.body.dataset.state !== 'loading');
    assert.equal(await raw.locator('body').getAttribute('data-state'), 'loaded', await raw.locator('body').getAttribute('data-error'));
    assert.equal(Number(await raw.locator('body').getAttribute('data-nodes')), document.nodes.length + 1, 'plain loader must preserve every original GLB node plus its scene');
    const expectedTriangles = document.meshes.reduce((sum, mesh) => sum + mesh.primitives.reduce((count, primitive) => count
        + (document.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3), 0), 0);
    assert.equal(Number(await raw.locator('body').getAttribute('data-triangles')), expectedTriangles, 'plain loader must preserve the original triangle count');
    const file = path.join(directory, label + '-raw-glb-preview.png'); await raw.locator('canvas').screenshot({ path: file });
    assert.ok(fs.statSync(file).size > 5000, 'raw GLB must render without any application pose helper');
    await raw.close();
    pass(label + ' raw GLB renders its initial pose in a plain GLTFLoader viewer without application code');
}

async function captureBuild(frontend, label, exerciseActions) {
    const dist = requireTestPath(frontend);
    assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'isolated frontend build must exist');
    const sandbox = await createSmokeSandbox('model-rest-pose-' + label);
    sandbox.password = 'Preview-' + crypto.randomBytes(20).toString('hex') + '!';
    // This binding is created only in the new fixture DB, never the live library.
    const model = getCadEquipmentModels().find(entry => entry.id === modelId), metadata = JSON.parse(model.metadata);
    metadata.partBindings.push({ id: 'rest_pose_fixture_binding', name: fixtureBindingName, node_path: cylinderPath,
        node_name: cylinderName, source_group: 'analog', source_key: 'fixture_only', action: 'translate', axis: 'y',
        input_min: 0, input_max: 1, output_min: 0, output_max: 0 });
    const db = new Database(requireTestPath(sandbox.filename));
    try {
        db.prepare('INSERT INTO models(id,name,file_path,asset_type,placement_level,factory_id,tags,thumbnail,default_scale,metadata) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata')
            .run(model.id, model.name, model.file_path, model.asset_type, model.placement_level, null, model.tags, null, 1, JSON.stringify(metadata));
    } finally { db.close(); }
    const origin = 'http://127.0.0.1:' + await findFreePort();
    const server = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: dist },
        logFile: path.join(directory, label + '-backend.log') });
    ownedServers.push(server);
    await waitForHttp(origin + '/api/health'); await createSmokeSession(origin, sandbox);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(id => {
        if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
            activeTab: 'models', modelLibraryStep: 'library', modelAssetSection: 'model', selectedPreviewModelId: id, motionWorkspaceMode: 'parts'
        }));
    }, modelId);
    page = await context.newPage(); page.setDefaultTimeout(45000);
    page.on('pageerror', error => errors.push(label + ': ' + error.message));
    const assetRequests = [], configurationWrites = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.endsWith('.glb')) assetRequests.push(url.pathname);
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && /^\/api\/(models|devices|workshops|lines|factories)(\/|$)/.test(url.pathname))
            configurationWrites.push({ method: request.method(), path: url.pathname });
    });
    await page.goto(origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('admin');
    await page.getByRole('textbox', { name: '后台密码', exact: true }).fill(sandbox.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.locator('.model-preview-stage').waitFor();
    const workspace = page.getByTestId('model-asset-workspace'), modern = await workspace.count() > 0;
    if (modern) {
        await workspace.locator('button.asset-model-select[data-model-id="' + modelId + '"]').click();
        await workspace.getByRole('tab', { name: '模型设置', exact: true }).click();
    } else {
        await page.locator('tr[data-model-id="' + modelId + '"]').locator('td').nth(2).click();
    }
    const canvas = page.locator('.model-preview-stage canvas.model-preview-canvas'); await canvas.waitFor();
    await waitUntil(async () => (await page.locator('.model-preview-footer').innerText()).includes('预览：' + model.name), 45000, 'lift GLB parsed and rendered');
    assert.equal(await page.locator('.model-preview-error').count(), 0);
    const metricText = async () => (await page.locator('.asset-model-metrics').count()
        ? await page.locator('.asset-model-metrics').innerText() : await page.locator('.model-preview-footer > div').first().innerText()).replace(/\s+/g, ' ');
    const metrics = await metricText();
    assert.ok(metrics.includes('节点') || metrics.includes('尺寸'), 'parsed model statistics or dimensions must be visible');
    const modelsBefore = await (await page.request.get(origin + '/api/models')).json();
    const selectedBefore = modelsBefore.find(entry => entry.id === modelId); assert.equal(selectedBefore.file_path, model.file_path);
    const devicesBefore = await (await page.request.get(origin + '/api/devices')).json();
    const box = await canvas.boundingBox(); assert.ok(box.width > 200 && box.height > 200);
    // Holding the OrbitControls pointer pauses automatic orbit for a clear static capture.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const staticFile = path.join(directory, label + '-model-preview.png'); await canvas.screenshot({ path: staticFile });
    await page.screenshot({ path: path.join(directory, label + '-model-page.png'), fullPage: true }); await page.mouse.up();
    assert.ok(fs.statSync(staticFile).size > 5000, 'static preview must render visible geometry');
    captures.push({ label, metrics, staticFile, originalPath: selectedBefore.file_path });
    assert.ok(assetRequests.includes(model.file_path), 'model management must request the original model GLB');
    await captureRawGlb(context, origin, label, model.file_path);
    if (exerciseActions) {
        const loaded = page.waitForResponse(response => response.request().method() === 'GET'
            && new URL(response.url()).pathname === model.file_path);
        loaded.catch(() => {}); // Preserve controlled cleanup if a navigation assertion fails first.
        if (modern) await workspace.getByRole('tab', { name: '动作动画', exact: true }).click();
        else {
            const actionNav = page.getByTestId('model-library-nav').getByRole('button', { name: '动作动画', exact: true });
            if (await actionNav.count() && await actionNav.isVisible()) await actionNav.click();
            else {
                // Legacy native-host navigation restores the requested page from this UI preference.
                await page.evaluate(id => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
                    activeTab: 'model-animations', modelLibraryStep: 'bindings', selectedPreviewModelId: id, motionWorkspaceMode: 'parts'
                })), modelId);
                await page.reload();
            }
        }
        await loaded;
        await waitUntil(async () => (await page.locator('.model-preview-footer').innerText()).includes('预览：' + model.name), 45000, 'original mesh node map loaded for action bindings');
        const search = page.getByRole('textbox', { name: '搜索动作节点', exact: true });
        await search.fill(fixtureBindingName);
        await page.getByRole('button', { name: '预览' + fixtureBindingName, exact: true }).click();
        const card = page.locator('.model-preview-node-card'); await card.waitFor();
        assert.ok((await card.innerText()).includes(cylinderPath), 'preview can resolve and select the unchanged original node path');
        await canvas.screenshot({ path: path.join(directory, 'after-selected-cylinder-node.png') });
        await page.getByRole('button', { name: '停止演示', exact: true }).click(); await search.fill('');
        pass('original hydraulic mesh node path remains selectable with an existing binding');
        const preview = page.locator('.cad-motion-preview');
        const setTime = async time => {
            await preview.getByRole('slider', { name: 'CAD 动作进度', exact: true }).evaluate((element, value) => {
                element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true }));
            }, time);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        };
        for (const [id, actionLabel] of [['lift_up', '备料台上升 / 回位'], ['lift_down', '备料台下降 / 回位']]) {
            await page.getByRole('button', { name: '预览' + actionLabel, exact: true }).click();
            await preview.locator('.loading').waitFor({ state: 'hidden', timeout: 60000 });
            const pause = preview.getByRole('button', { name: '暂停', exact: true }); if (await pause.count()) await pause.click();
            await setTime(0); const zero = await preview.locator('canvas').screenshot({ path: path.join(directory, id + '-0-rest.png') });
            // The 8-second loop uses sin^2: 2s = half stroke, 4s = full stroke.
            await setTime(2); await preview.locator('canvas').screenshot({ path: path.join(directory, id + '-05-half-stroke.png') });
            await setTime(4); const full = await preview.locator('canvas').screenshot({ path: path.join(directory, id + '-1-full-stroke.png') });
            assert.equal(zero.equals(full), false, 'stroke must visibly move the existing mechanism');
            await setTime(8); const returned = await preview.locator('canvas').screenshot({ path: path.join(directory, id + '-returned.png') });
            assert.ok(zero.equals(returned), 'lift animation must return exactly to its unchanged zero-frame pose');
        }
        pass('existing lift up/down animations render rest, half, full and deterministic return poses');
        if (modern) await workspace.getByRole('tab', { name: '模型设置', exact: true }).click();
        else {
            const modelNav = page.getByTestId('model-library-nav').getByRole('button', { name: '模型管理', exact: true });
            if (await modelNav.count() && await modelNav.isVisible()) await modelNav.click();
            else {
                await page.evaluate(id => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
                    activeTab: 'models', modelLibraryStep: 'library', selectedPreviewModelId: id
                })), modelId);
                await page.reload();
            }
        }
        await waitUntil(async () => (await page.locator('.model-preview-footer').innerText()).includes('预览：' + model.name), 45000, 'return to static preview');
        assert.equal(await metricText(), metrics, 'animation must not change static model statistics or dimensions');
        pass('returning from animation restores the original static model topology');
    }
    const modelsAfter = await (await page.request.get(origin + '/api/models')).json();
    assert.deepEqual(modelsAfter, modelsBefore, 'preview must not save model, binding, action or inspection changes');
    assert.deepEqual(await (await page.request.get(origin + '/api/devices')).json(), devicesBefore, 'preview must not rewrite device/site configuration');
    assert.deepEqual(configurationWrites, []);
    await context.close(); await stopOwnedSmokeProcess(server);
    pass(label + ' static preview uses the original model file without configuration writes');
}

(async () => {
    if (!process.env.UI_FRONTEND_DIST) throw Error('UI_FRONTEND_DIST must name an isolated frontend build below output/');
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    if (process.env.UI_BEFORE_FRONTEND_DIST) await captureBuild(process.env.UI_BEFORE_FRONTEND_DIST, 'before', false);
    await captureBuild(process.env.UI_FRONTEND_DIST, 'after', true);
    if (captures.length === 2) assert.equal(captures[0].metrics, captures[1].metrics, 'static pose correction must preserve node and triangle counts');
    assert.deepEqual({ source: sha(sourceFile), motion: sha(motionFile) }, beforeHashes, 'model and action assets must remain byte-for-byte unchanged');
    assert.deepEqual(errors, []);
    pass('model/action files remain byte-identical and no browser page errors occur');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, captures, assetHashes: beforeHashes, directory }, null, 2));
    console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => {
    try { await page?.screenshot({ path: path.join(directory, 'failure-page.png'), fullPage: true }); } catch { /* original failure wins */ }
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors }, null, 2));
    console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); for (const server of ownedServers) await stopOwnedSmokeProcess(server); });
