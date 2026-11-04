'use strict';
const fs = require('node:fs');
const path = require('node:path');
// This is a release policy, not a command to erase an operator's database.
function emptyInstallation() {
    if (process.env.APP_EMPTY_INSTALL === '1') return true;
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../distribution.json'), 'utf8')).contentPolicy === 'empty-v1'; }
    catch { return false; }
}
module.exports = { emptyInstallation };
