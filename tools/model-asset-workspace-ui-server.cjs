'use strict';
// Dedicated loopback backend with newly-created database/profile/uploads only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createSmokeSandbox, createSmokeSession } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, waitForHttp, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { createAssets } = require('./model-asset-workspace-fixtures.cjs');
(async () => {
    process.env.APP_EMPTY_INSTALL = '1';
    const sandbox = await createSmokeSandbox('model-asset-workspace-ui'); sandbox.password = 'Workspace-' + crypto.randomBytes(18).toString('hex') + '!';
    const fixtures = await createAssets(path.join(sandbox.directory, 'fixtures'));
    const origin = 'http://127.0.0.1:' + await findFreePort();
    Object.assign(process.env, sandbox.env, { PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: process.env.UI_FRONTEND_DIST || path.resolve(__dirname, '../frontend/dist') });
    require('../backend/server.js'); await waitForHttp(origin + '/api/health');
    const session = await createSmokeSession(origin, sandbox);
    const response = await fetch(origin + '/api/factories', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ name: '模型资产隔离验收', location: { country: 'CHN' } }) });
    if (response.status !== 201) throw Error('Synthetic factory creation failed: ' + await response.text());
    const factory = await response.json();
    const info = { origin, directory: sandbox.directory, database: sandbox.filename, username: 'admin', password: sandbox.password, session, fixtures, factory, backendPid: process.pid };
    fs.writeFileSync(requireTestPath(process.env.MODEL_ASSET_WORKSPACE_INFO_FILE), JSON.stringify(info, null, 2));
    console.log(JSON.stringify({ origin, directory: sandbox.directory }));
})().catch(error => { console.error(error); process.exit(1); });
