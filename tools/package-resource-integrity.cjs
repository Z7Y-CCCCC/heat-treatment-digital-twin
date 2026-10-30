'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function hashFile(filename) {
    const before = await fs.promises.stat(filename);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    const after = await fs.promises.stat(filename);
    assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino,
        `Installation resource changed while hashing: ${filename}`);
    return { size: after.size, sha256: hash.digest('hex') };
}

async function snapshotTree(directory) {
    const root = await fs.promises.realpath(path.resolve(directory));
    const entries = [];
    async function visit(current, prefix = '') {
        const children = (await fs.promises.readdir(current, { withFileTypes: true }))
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
            const filename = path.join(current, child.name);
            const name = prefix ? `${prefix}/${child.name}` : child.name;
            assert.ok(!child.isSymbolicLink(), `Installation resource must not contain links: ${filename}`);
            if (child.isDirectory()) {
                entries.push({ path: name, type: 'directory' });
                await visit(filename, name);
            } else {
                assert.ok(child.isFile(), `Unsupported installation resource: ${filename}`);
                entries.push({ path: name, type: 'file', ...await hashFile(filename) });
            }
        }
    }
    await visit(root);
    const digest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return { version: 1, root, entries, sha256: digest };
}

async function verifyTree(directory, before) {
    assert.equal(before.version, 1, 'Unsupported installation resource baseline');
    const after = await snapshotTree(directory);
    assert.equal(after.root.toLowerCase(), before.root.toLowerCase(), 'Installation baseline belongs to another directory');
    if (after.sha256 !== before.sha256) {
        const old = new Map(before.entries.map(entry => [entry.path, entry]));
        const current = new Map(after.entries.map(entry => [entry.path, entry]));
        const changed = [];
        for (const [name, entry] of current) {
            if (!old.has(name)) changed.push(`added ${name}`);
            else if (JSON.stringify(old.get(name)) !== JSON.stringify(entry)) changed.push(`changed ${name}`);
        }
        for (const name of old.keys()) if (!current.has(name)) changed.push(`removed ${name}`);
        const error = new Error(`Installation resources were modified by runtime validation: ${changed.slice(0, 30).join('; ')}`);
        error.code = 'PACKAGE_RESOURCE_MUTATED'; error.changes = changed;
        throw error;
    }
    return { success: true, root: after.root, entriesVerified: after.entries.length,
        filesVerified: after.entries.filter(entry => entry.type === 'file').length,
        beforeSha256: before.sha256, afterSha256: after.sha256 };
}

async function cli() {
    const [mode, directory, filename, resultFile] = process.argv.slice(2);
    if (!['--snapshot', '--verify'].includes(mode) || !directory || !filename)
        throw new Error('Usage: node package-resource-integrity.cjs --snapshot|--verify <installation-directory> <baseline.json> [result.json]');
    if (mode === '--snapshot') {
        const snapshot = await snapshotTree(directory);
        await fs.promises.writeFile(filename, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
        console.log(JSON.stringify({ success: true, root: snapshot.root, entries: snapshot.entries.length, sha256: snapshot.sha256, baselineFile: path.resolve(filename) }));
    } else {
        const baseline = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
        let result;
        try { result = await verifyTree(directory, baseline); }
        catch (error) {
            result = { success: false, root: baseline.root, beforeSha256: baseline.sha256,
                error: error.message, code: error.code, changes: error.changes };
            if (resultFile) await fs.promises.writeFile(resultFile, JSON.stringify(result, null, 2), { flag: 'wx' });
            throw error;
        }
        if (resultFile) await fs.promises.writeFile(resultFile, JSON.stringify(result, null, 2), { flag: 'wx' });
        console.log(JSON.stringify(result));
    }
}
if (require.main === module) cli().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { snapshotTree, verifyTree };
