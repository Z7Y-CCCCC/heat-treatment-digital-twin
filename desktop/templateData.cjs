const fs = require('node:fs');
const path = require('node:path');

// Portable application settings only: never clone machine identities, database
// credentials, live alarm queues, caches, or recovery/backup working files.
const CONFIGURATION_FILES = [
    'admin-security.json', 'data-sources.json',
    'backup-storage-database.json', 'backup-storage-site.json',
    'site-backup-config.json'
];

async function seedTemplateConfiguration(templateRoot, dataDir) {
    if (fs.existsSync(path.join(dataDir, 'database-config.json'))
        || fs.existsSync(path.join(dataDir, 'factory.db'))) return;
    for (const name of CONFIGURATION_FILES) {
        const source = path.join(templateRoot, 'data', name);
        if (!fs.existsSync(source)) continue;
        await fs.promises.mkdir(dataDir, { recursive: true });
        try { await fs.promises.copyFile(source, path.join(dataDir, name), fs.constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
}

module.exports = { CONFIGURATION_FILES, seedTemplateConfiguration };
