'use strict';
const path = require('node:path');
const { requireTestPath } = require('./integration-test-utils.cjs');

// Test-only process inputs. Production identity defaults are unchanged; every
// suite child instead owns a fresh machine anchor and Windows ProgramData root.
function createSuiteTestEnvironment(directory, script, inherited = process.env) {
    if (!/^[a-z0-9][a-z0-9_.-]*\.cjs$/i.test(script)) throw new Error('Invalid suite test script name');
    const root = requireTestPath(path.join(directory, 'isolated-environments', script.slice(0, -4)));
    const env = { ...inherited };
    const exact = new Set(['test_base_url', 'admin_api_token', 'mcp_api_token', 'app_data_dir', 'app_user_data_dir',
        'uploads_dir', 'site_backup_dir', 'site_import_dir', 'site_backup_mirror_dir', 'data_source_backup_dir', 'programdata']);
    for (const key of Object.keys(env)) {
        if (exact.has(key.toLowerCase()) || /^(MYSQL_|DB_|SQLITE_|LICENSE_|APP_RUNTIME_)/i.test(key)) delete env[key];
    }
    env.LICENSE_MACHINE_STATE_FILE = path.join(root, 'machine-identity.json');
    env.ProgramData = path.join(root, 'ProgramData');
    return env;
}

module.exports = { createSuiteTestEnvironment };
