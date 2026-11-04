'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createSmokeSandbox, createSmokeSession } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, waitForHttp, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
(async () => {
    process.env.APP_EMPTY_INSTALL = '1';
    const sandbox = await createSmokeSandbox('empty-install-ui'); sandbox.password = 'EmptyInstall-Isolated-20261104!';
    const port = await findFreePort(), origin = 'http://127.0.0.1:' + port;
    Object.assign(process.env, sandbox.env, { PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.resolve(__dirname, '../desktop/.cache/frontend-dist') });
    require('../backend/server.js'); await waitForHttp(origin + '/api/health'); const session = await createSmokeSession(origin, sandbox);
    fs.writeFileSync(requireTestPath(process.env.EMPTY_INSTALL_UI_INFO_FILE), JSON.stringify({ origin, directory: sandbox.directory, username: 'admin', password: sandbox.password, session, env: sandbox.env }));
})().catch(error => { console.error(error); process.exitCode = 1; });
