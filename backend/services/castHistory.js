const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// UDN survives DHCP changes; IP addresses, names and control URLs are not identities.
function stableCastId(value) {
    const id = String(value || '').trim().toLowerCase();
    return /^uuid:[a-z0-9][a-z0-9._:-]{0,191}$/.test(id) ? id : '';
}
const label = value => String(value || '').trim().slice(0, 200);
function historyEntry(device, lastCastAt) {
    const id = stableCastId(device?.id);
    if (!id || !Number.isFinite(Date.parse(lastCastAt))) return null;
    return { id, name: label(device.name), brand: label(device.brand), manufacturer: label(device.manufacturer),
        modelName: label(device.modelName), lastCastAt: new Date(lastCastAt).toISOString() };
}

class CastHistory {
    constructor({ file = path.join(process.env.APP_DATA_DIR || path.join(__dirname, '../data'), 'cast-history.json') } = {}) {
        this.file = path.resolve(file);
        this.entries = new Map();
        this.error = '';
        try {
            if (!fs.existsSync(this.file)) return;
            if (fs.statSync(this.file).size > 128 * 1024) throw new Error('记录文件过大');
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.devices)) throw new Error('记录格式无效');
            for (const row of saved.devices.slice(0, 32)) {
                const entry = historyEntry(row, row.lastCastAt);
                if (entry) this.entries.set(entry.id, entry);
            }
        } catch (error) { this.error = `读取投屏记录失败：${error.message}`; }
    }
    list() { return [...this.entries.values()].map(row => ({ ...row })).sort((a, b) => b.lastCastAt.localeCompare(a.lastCastAt)); }
    remember(device, at = new Date().toISOString()) {
        const entry = historyEntry(device, at);
        if (!entry) return false; // Never match a receiver by a recycled IP or a duplicate name.
        const next = new Map(this.entries); next.set(entry.id, entry);
        const devices = [...next.values()].sort((a, b) => b.lastCastAt.localeCompare(a.lastCastAt)).slice(0, 32);
        const temp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
            fs.renameSync(temp, this.file);
            this.entries = new Map(devices.map(row => [row.id, row])); this.error = '';
            return true;
        } catch (error) {
            this.error = `保存投屏记录失败：${error.message}`;
            try { fs.unlinkSync(temp); } catch { /* no partial history file */ }
            return false;
        }
    }
}
module.exports = { CastHistory, stableCastId };
