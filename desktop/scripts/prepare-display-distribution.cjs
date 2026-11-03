'use strict';
const fs = require('node:fs');
const path = require('node:path');
const COLLECTOR_FILES = ['collectorProcess.js', 'collectorWorker.cjs', 'plcReader.js', 'plcProtocolDrivers.js', 's7ReadSafety.js'];
function prepareDisplayDistribution(resources) {
    const backend = path.join(resources, 'backend');
    fs.writeFileSync(path.join(backend, 'distribution.json'), JSON.stringify({ product: 'display', collector: false }));
    for (const file of COLLECTOR_FILES) if (fs.existsSync(path.join(backend, 'services', file))) throw new Error(`Display must not contain collector implementation: ${file}`);
    for (const file of ['collector-center', 'collector-service']) if (fs.existsSync(path.join(resources, file))) throw new Error(`Display must not bundle ${file}`);
    // Only the distributable starter snapshot is changed, never live settings.
    const template = path.join(resources, 'templates', 'factory-template.db');
    const Database = require('../../backend/node_modules/better-sqlite3');
    const db = new Database(template);
    try {
        db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
        db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    } finally { db.close(); }
}
if (require.main === module) prepareDisplayDistribution(path.resolve(process.argv[2]));
module.exports = { COLLECTOR_FILES, prepareDisplayDistribution };
