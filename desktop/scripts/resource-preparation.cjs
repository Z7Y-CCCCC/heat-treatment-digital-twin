const fs = require('fs');
const path = require('path');
const { publishDirectory, retryFilesystem } = require('../directoryPublish.cjs');

async function prepareResourceDirectory(destination, build) {
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    if (target === parent) throw new Error('A filesystem root cannot be a resource output directory');
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.preparing-`));
    try {
        const result = await build(staging);
        // Antivirus/indexing can briefly lock a complete Windows staging tree.
        // Use the same retry and rollback semantics as runtime publication.
        await publishDirectory(staging, target);
        return result;
    } finally {
        await retryFilesystem(() => fs.promises.rm(staging, { recursive: true, force: true }));
    }
}

async function copySqliteSnapshot(source, destination, Database) {
    const input = new Database(source, { readonly: true, fileMustExist: true });
    try {
        const integrity = input.pragma('quick_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`数据库模板完整性检查失败：${integrity}`);
        // backup includes committed WAL pages without checkpointing or modifying
        // the engineer's explicitly selected source database.
        await input.backup(destination);
    } finally {
        input.close();
    }
    const output = new Database(destination, { fileMustExist: true });
    try { output.pragma('journal_mode = DELETE'); }
    finally { output.close(); }
}

module.exports = { prepareResourceDirectory, copySqliteSnapshot };
