// Isolated browser QA server. No customer DB, settings, uploads or password are
// changed. Stop this process after verification; artifacts stay under output/.
const path = require('path');
const { createRunDirectory, findFreePort, createTestDatabase } = require('./integration-test-utils.cjs');

(async () => {
    const directory = createRunDirectory('admin-auth-ui');
    process.env.APP_DATA_DIR = path.join(directory, 'data');
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_FILE = path.join(process.env.APP_DATA_DIR, 'factory.db');
    process.env.UPLOADS_DIR = path.join(directory, 'uploads');
    process.env.FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');
    process.env.PORT = String(await findFreePort(3811));
    process.env.HOST = '127.0.0.1';
    process.env.LICENSE_ENFORCE = 'false';
    process.env.DB_BACKUP_DIR = path.join(process.env.APP_DATA_DIR, 'backups');
    process.env.DB_RECOVERY_DIR = path.join(process.env.APP_DATA_DIR, 'recovery');
    process.env.SITE_BACKUP_DIR = path.join(process.env.APP_DATA_DIR, 'site-backups');
    process.env.SITE_IMPORT_DIR = path.join(process.env.APP_DATA_DIR, 'site-imports');
    process.env.SITE_BACKUP_MIRROR_DIR = '';
    process.env.DATA_SOURCE_BACKUP_DIR = path.join(process.env.APP_DATA_DIR, 'data-source-backups');
    delete process.env.SQLITE_TEMPLATE_FILE;
    delete process.env.SQLITE_RECOVERY_TEMPLATE;
    delete process.env.SQLITE_UPGRADE_TEMPLATE;
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.MCP_API_TOKEN;
    await createTestDatabase(process.env.SQLITE_FILE);
    console.log(`Admin access QA: http://127.0.0.1:${process.env.PORT}/admin`);
    require('../server');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
