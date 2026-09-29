const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(filename) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let length;
        while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    } finally { fs.closeSync(descriptor); }
    return hash.digest('hex');
}

function createFileManifest(directory, filenames) {
    return filenames.map(name => ({ name, sha256: sha256(path.join(directory, name)) }));
}

function verifyFileManifest(directory, manifest) {
    if (!Array.isArray(manifest) || manifest.length === 0) return false;
    try {
        const root = path.resolve(directory) + path.sep;
        return manifest.every(entry => entry && typeof entry.name === 'string'
            && !path.isAbsolute(entry.name) && !entry.name.split(/[\\/]/).includes('..')
            && path.resolve(directory, entry.name).startsWith(root)
            && typeof entry.sha256 === 'string'
            && sha256(path.join(directory, entry.name)) === entry.sha256);
    } catch { return false; }
}

function createTreeManifest(directory) {
    const names = [];
    function walk(relative) {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = path.join(relative, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Cache cannot contain symlinks: ${name}`);
            if (entry.isDirectory()) walk(name);
            else names.push(name);
        }
    }
    walk('');
    return createFileManifest(directory, names.sort());
}

module.exports = { createFileManifest, createTreeManifest, verifyFileManifest, sha256 };
