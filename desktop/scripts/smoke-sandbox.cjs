const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createRunDirectory, createTestDatabase } = require('../../backend/scripts/integration-test-utils.cjs');
const { hasProcessExited, terminateProcess } = require('../processLifecycle.cjs');

async function createSmokeSandbox(prefix) {
    const directory = createRunDirectory(prefix);
    const dataDir = path.join(directory, 'data');
    const uploadsDir = path.join(directory, 'uploads');
    const filename = await createTestDatabase(path.join(dataDir, 'factory.db'));
    fs.mkdirSync(uploadsDir, { recursive: true });
    const env = {
        ...process.env,
        APP_USER_DATA_DIR: directory,
        APP_DATA_DIR: dataDir,
        UPLOADS_DIR: uploadsDir,
        DB_TYPE: 'sqlite',
        SQLITE_FILE: filename,
        SQLITE_TEMPLATE_FILE: '',
        SQLITE_RECOVERY_TEMPLATE: '',
        SQLITE_UPGRADE_TEMPLATE: '',
        DB_BACKUP_DIR: path.join(dataDir, 'backups'),
        DB_RECOVERY_DIR: path.join(dataDir, 'recovery'),
        SITE_BACKUP_DIR: path.join(dataDir, 'site-backups'),
        LICENSE_FILE: path.join(dataDir, 'license.json'),
        LICENSE_ENFORCE: 'false',
        ADMIN_API_TOKEN: crypto.randomBytes(32).toString('hex'),
        DESKTOP_SMOKE_ISOLATED: 'true',
        DISABLE_AUTO_START: 'true'
    };
    for (const key of Object.keys(env)) {
        if (/^(MYSQL_|DESKTOP_MYSQL_|DB_(HOST|PORT|USER|PASSWORD|NAME)$)/i.test(key)) delete env[key];
    }
    return { directory, dataDir, uploadsDir, filename, env };
}

async function stopOwnedSmokeProcess(child) {
    if (hasProcessExited(child)) return;
    // Only the exact child created by this test is targeted. A timeout must not
    // leave Unity, WebView2 or the backend orphaned after killing their supervisor.
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        await new Promise(resolve => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 10000
            }, () => resolve());
        });
    }
    await terminateProcess(child);
}

module.exports = { createSmokeSandbox, stopOwnedSmokeProcess };
