// One-time, explicitly selected customer accounts; never widen all saved roles.
const fs = require('node:fs');
const path = require('node:path');
const { normalizePagePermissions } = require('../shared/pagePermissions.mjs');
const { defaultAccountPagePermissions } = require('../shared/accountTemplates.mjs');

function migrateCustomerReadonly(dataDir, usernames) {
    if (!Array.isArray(usernames) || !usernames.length) throw new Error('Select exact usernames');
    const filename = path.join(path.resolve(dataDir), 'admin-security.json');
    const original = fs.readFileSync(filename, 'utf8'), config = JSON.parse(original);
    const selected = new Set(usernames), changed = [];
    const users = config.users.map(user => {
        if (!selected.has(user.username)) return user;
        if (user.role !== 'customer') throw new Error(`Not a customer template: ${user.username}`);
        const grants = normalizePagePermissions(user.pagePermissions);
        // This migration corrects the old empty template, not deliberate custom grants.
        if (Object.values(grants).some(actions => Object.values(actions).some(Boolean))) return user;
        changed.push(user.username);
        return { ...user, pagePermissions: defaultAccountPagePermissions('customer') };
    });
    for (const username of selected) if (!users.some(user => user.username === username)) throw new Error(`Account not found: ${username}`);
    if (!changed.length) return { changed, filename, backup: null };
    const backup = `${filename}.before-customer-readonly-${Date.now()}.bak`;
    fs.writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify({ ...config, users }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filename);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { changed, filename, backup };
}
if (require.main === module) console.log(JSON.stringify(migrateCustomerReadonly(process.argv[2], process.argv.slice(3)), null, 2));
module.exports = { migrateCustomerReadonly };
