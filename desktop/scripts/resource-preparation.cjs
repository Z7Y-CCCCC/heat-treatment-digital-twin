const fs = require('fs');
const path = require('path');

async function prepareResourceDirectory(destination, build) {
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    if (target === parent) throw new Error('A filesystem root cannot be a resource output directory');
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.preparing-`));
    const previous = `${staging}.previous`;
    let movedPrevious = false;
    try {
        const result = await build(staging);
        if (fs.existsSync(target)) {
            fs.renameSync(target, previous);
            movedPrevious = true;
        }
        try {
            fs.renameSync(staging, target);
        } catch (error) {
            if (movedPrevious && !fs.existsSync(target)) {
                fs.renameSync(previous, target);
                movedPrevious = false;
            }
            if (movedPrevious) error.message += `; previous resources preserved at ${previous}`;
            throw error;
        }
        // All deleted paths were either created here or are the exact previous
        // generated resource directory renamed above; no source tree is removed.
        if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
        return result;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
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
